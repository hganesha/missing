import { randomUUID } from "node:crypto";
import {
  PLATFORM_SETTING_DEFAULTS,
  PLATFORM_SETTING_FIELDS,
  withSettingValueAt,
  modelProfileDocumentSchema,
  platformSettingSectionSchema,
  platformSettingsSchema,
  providerRecordSchema,
  stableDigest,
  type AdminChangeAction,
  type AdminChangeRecord,
  type ModelProfileDocument,
  type PlatformSettingSection,
  type PlatformSettings,
  type ProviderRecord,
} from "@ehf/contracts";
import type { Database } from "./index.js";

export type AdminActor = { subjectId: string; roles: readonly string[] };

export type ProviderRegistryRecord = {
  provider: ProviderRecord;
  digest: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
};

export type ModelProfileRevisionRecord = {
  profile: ModelProfileDocument;
  revision: number;
  digest: string;
  status: "active" | "superseded" | "disabled";
  note: string | null;
  createdAt: string;
  createdBy: string;
};

export class AdminConfigError extends Error {
  constructor(message: string, readonly httpStatus = 400) {
    super(message);
  }
}

async function recordChange(db: Database, input: {
  tenantId: string;
  actor: AdminActor;
  resourceKind: AdminChangeRecord["resourceKind"];
  resourceId: string;
  action: AdminChangeAction;
  before: unknown;
  after: unknown;
  beforeDigest: string | null;
  afterDigest: string | null;
  reason: string | null;
}): Promise<void> {
  await db.query(`
    insert into harness_admin.change_log(
      change_id, tenant_id, actor_id, actor_roles, resource_kind, resource_id, action,
      before, after, before_digest, after_digest, reason)
    values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)
  `, [
    randomUUID(), input.tenantId, input.actor.subjectId, [...input.actor.roles],
    input.resourceKind, input.resourceId, input.action,
    input.before === null || input.before === undefined ? null : JSON.stringify(input.before),
    input.after === null || input.after === undefined ? null : JSON.stringify(input.after),
    input.beforeDigest, input.afterDigest, input.reason,
  ]);
}

export async function listProviders(db: Database, tenantId: string): Promise<ProviderRegistryRecord[]> {
  const result = await db.query<{
    definition: unknown; definition_digest: string; created_at: Date; updated_at: Date; updated_by: string;
  }>(`
    select definition, definition_digest, created_at, updated_at, updated_by
    from harness_admin.providers where tenant_id=$1 order by provider_id
  `, [tenantId]);
  return result.rows.map((row) => ({
    provider: providerRecordSchema.parse(row.definition),
    digest: row.definition_digest,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
  }));
}

export async function getProvider(db: Database, tenantId: string, providerId: string): Promise<ProviderRecord | null> {
  const result = await db.query<{ definition: unknown }>(
    "select definition from harness_admin.providers where tenant_id=$1 and provider_id=$2", [tenantId, providerId],
  );
  const row = result.rows[0];
  return row ? providerRecordSchema.parse(row.definition) : null;
}

/**
 * Create or replace a provider binding.
 *
 * A provider is not part of any plan digest, so this is a genuine in-place update: the
 * next invocation reaches the new endpoint without recompiling anything.
 */
export async function upsertProvider(db: Database, input: {
  tenantId: string;
  actor: AdminActor;
  provider: unknown;
  reason?: string | null;
}): Promise<{ created: boolean } & ProviderRegistryRecord> {
  const provider = providerRecordSchema.parse(input.provider);
  const digest = stableDigest(provider);
  const before = await getProvider(db, input.tenantId, provider.id);
  const result = await db.query<{ created_at: Date; updated_at: Date }>(`
    insert into harness_admin.providers(tenant_id, provider_id, kind, definition, definition_digest, status, updated_by)
    values ($1,$2,$3,$4::jsonb,$5,$6,$7)
    on conflict (tenant_id, provider_id) do update set kind=excluded.kind, definition=excluded.definition,
      definition_digest=excluded.definition_digest, status=excluded.status,
      updated_at=now(), updated_by=excluded.updated_by
    returning created_at, updated_at
  `, [input.tenantId, provider.id, provider.kind, JSON.stringify(provider), digest, provider.status, input.actor.subjectId]);
  const row = result.rows[0];
  if (!row) throw new AdminConfigError("admin.provider_write_failed", 500);
  await recordChange(db, {
    tenantId: input.tenantId,
    actor: input.actor,
    resourceKind: "provider",
    resourceId: provider.id,
    action: before ? "update" : "create",
    before,
    after: provider,
    beforeDigest: before ? stableDigest(before) : null,
    afterDigest: digest,
    reason: input.reason ?? null,
  });
  return {
    created: before === null,
    provider,
    digest,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    updatedBy: input.actor.subjectId,
  };
}

export async function listModelProfileRevisions(
  db: Database, tenantId: string, profileId?: string,
): Promise<ModelProfileRevisionRecord[]> {
  const result = await db.query<{
    definition: unknown; definition_digest: string; revision: number;
    status: ModelProfileRevisionRecord["status"]; note: string | null; created_at: Date; created_by: string;
  }>(`
    select definition, definition_digest, revision, status, note, created_at, created_by
    from harness_admin.model_profile_revisions
    where tenant_id=$1 and ($2::text is null or profile_id=$2)
    order by profile_id, revision desc
  `, [tenantId, profileId ?? null]);
  return result.rows.map((row) => ({
    profile: modelProfileDocumentSchema.parse(row.definition),
    revision: Number(row.revision),
    digest: row.definition_digest,
    status: row.status,
    note: row.note,
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
  }));
}

/** The revisions a new compilation resolves to. */
export async function listActiveModelProfiles(db: Database, tenantId: string): Promise<ModelProfileRevisionRecord[]> {
  const revisions = await listModelProfileRevisions(db, tenantId);
  return revisions.filter((revision) => revision.status === "active");
}

/**
 * Resolve the profile an invocation should actually use.
 *
 * A plan records the digest of the profile revision it was compiled against. Resolving
 * that digest first means an edit made after compilation cannot silently change what a
 * run in flight invokes -- and it is also the first time that recorded digest is
 * verified rather than merely carried. Resolution falls back to the active revision only
 * when the plan's digest is unknown to the store, which is the case for plans compiled
 * before the profiles were persisted.
 */
export async function resolveModelProfile(db: Database, input: {
  tenantId: string;
  profileId: string;
  expectedDigest?: string | null;
}): Promise<{ profile: ModelProfileDocument; digest: string; revision: number; pinned: boolean } | null> {
  if (input.expectedDigest) {
    const pinned = await db.query<{ definition: unknown; definition_digest: string; revision: number }>(`
      select definition, definition_digest, revision from harness_admin.model_profile_revisions
      where tenant_id=$1 and profile_id=$2 and definition_digest=$3 and status <> 'disabled'
    `, [input.tenantId, input.profileId, input.expectedDigest]);
    const row = pinned.rows[0];
    if (row) {
      return {
        profile: modelProfileDocumentSchema.parse(row.definition),
        digest: row.definition_digest,
        revision: Number(row.revision),
        pinned: true,
      };
    }
  }
  const current = await db.query<{ definition: unknown; definition_digest: string; revision: number }>(`
    select definition, definition_digest, revision from harness_admin.model_profile_revisions
    where tenant_id=$1 and profile_id=$2 and status='active'
  `, [input.tenantId, input.profileId]);
  const row = current.rows[0];
  if (!row) return null;
  return {
    profile: modelProfileDocumentSchema.parse(row.definition),
    digest: row.definition_digest,
    revision: Number(row.revision),
    pinned: false,
  };
}

/**
 * Save a model profile as a new revision.
 *
 * There is no in-place update by design. The previous revision is marked superseded and
 * kept, because a plan that pinned its digest still has to resolve it.
 */
export async function saveModelProfileRevision(db: Database, input: {
  tenantId: string;
  actor: AdminActor;
  profile: unknown;
  note?: string | null;
  reason?: string | null;
}): Promise<{ created: boolean } & ModelProfileRevisionRecord> {
  const profile = modelProfileDocumentSchema.parse(input.profile);
  const digest = stableDigest(profile);
  const provider = await getProvider(db, input.tenantId, profile.provider);
  if (!provider) throw new AdminConfigError(`admin.provider_unknown:${profile.provider}`);
  if (provider.status !== "active") throw new AdminConfigError(`admin.provider_disabled:${profile.provider}`);

  const client = await db.connect();
  try {
    await client.query("begin");
    const existingActive = await client.query<{ definition: unknown; definition_digest: string; revision: number }>(`
      select definition, definition_digest, revision from harness_admin.model_profile_revisions
      where tenant_id=$1 and profile_id=$2 and status='active' for update
    `, [input.tenantId, profile.id]);
    const active = existingActive.rows[0];
    if (active && active.definition_digest === digest) {
      await client.query("rollback");
      return {
        created: false,
        profile,
        revision: Number(active.revision),
        digest,
        status: "active",
        note: input.note ?? null,
        createdAt: new Date().toISOString(),
        createdBy: input.actor.subjectId,
      };
    }
    const maxRevision = await client.query<{ next: number }>(`
      select coalesce(max(revision), 0) + 1 as next from harness_admin.model_profile_revisions
      where tenant_id=$1 and profile_id=$2
    `, [input.tenantId, profile.id]);
    const revision = Number(maxRevision.rows[0]?.next ?? 1);
    if (active) {
      await client.query(`
        update harness_admin.model_profile_revisions set status='superseded'
        where tenant_id=$1 and profile_id=$2 and revision=$3
      `, [input.tenantId, profile.id, active.revision]);
    }
    const inserted = await client.query<{ created_at: Date }>(`
      insert into harness_admin.model_profile_revisions(
        tenant_id, profile_id, revision, definition, definition_digest, provider_id, status, note, created_by)
      values ($1,$2,$3,$4::jsonb,$5,$6,'active',$7,$8)
      returning created_at
    `, [input.tenantId, profile.id, revision, JSON.stringify(profile), digest, profile.provider, input.note ?? null, input.actor.subjectId]);
    await client.query("commit");
    const createdAt = inserted.rows[0]?.created_at.toISOString() ?? new Date().toISOString();
    await recordChange(db, {
      tenantId: input.tenantId,
      actor: input.actor,
      resourceKind: "model-profile",
      resourceId: profile.id,
      action: active ? "update" : "create",
      before: active ? modelProfileDocumentSchema.parse(active.definition) : null,
      after: profile,
      beforeDigest: active?.definition_digest ?? null,
      afterDigest: digest,
      reason: input.reason ?? null,
    });
    return {
      created: !active,
      profile,
      revision,
      digest,
      status: "active",
      note: input.note ?? null,
      createdAt,
      createdBy: input.actor.subjectId,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Promote an existing revision back to active, which is how a change is rolled back. */
export async function activateModelProfileRevision(db: Database, input: {
  tenantId: string;
  actor: AdminActor;
  profileId: string;
  revision: number;
  reason?: string | null;
}): Promise<ModelProfileRevisionRecord> {
  const client = await db.connect();
  try {
    await client.query("begin");
    const target = await client.query<{ definition: unknown; definition_digest: string; note: string | null; created_at: Date; created_by: string }>(`
      select definition, definition_digest, note, created_at, created_by
      from harness_admin.model_profile_revisions
      where tenant_id=$1 and profile_id=$2 and revision=$3 for update
    `, [input.tenantId, input.profileId, input.revision]);
    const row = target.rows[0];
    if (!row) throw new AdminConfigError("admin.model_profile_revision_not_found", 404);
    const previous = await client.query<{ definition: unknown; definition_digest: string }>(`
      select definition, definition_digest from harness_admin.model_profile_revisions
      where tenant_id=$1 and profile_id=$2 and status='active' for update
    `, [input.tenantId, input.profileId]);
    await client.query(`
      update harness_admin.model_profile_revisions set status='superseded'
      where tenant_id=$1 and profile_id=$2 and status='active'
    `, [input.tenantId, input.profileId]);
    await client.query(`
      update harness_admin.model_profile_revisions set status='active'
      where tenant_id=$1 and profile_id=$2 and revision=$3
    `, [input.tenantId, input.profileId, input.revision]);
    await client.query("commit");
    await recordChange(db, {
      tenantId: input.tenantId,
      actor: input.actor,
      resourceKind: "model-profile",
      resourceId: input.profileId,
      action: "activate",
      before: previous.rows[0] ? modelProfileDocumentSchema.parse(previous.rows[0].definition) : null,
      after: modelProfileDocumentSchema.parse(row.definition),
      beforeDigest: previous.rows[0]?.definition_digest ?? null,
      afterDigest: row.definition_digest,
      reason: input.reason ?? null,
    });
    return {
      profile: modelProfileDocumentSchema.parse(row.definition),
      revision: input.revision,
      digest: row.definition_digest,
      status: "active",
      note: row.note,
      createdAt: row.created_at.toISOString(),
      createdBy: row.created_by,
    };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type StoredSettingSections = Partial<Record<PlatformSettingSection, { value: unknown; updatedAt: string; updatedBy: string }>>;

export async function listStoredSettings(db: Database, tenantId: string): Promise<StoredSettingSections> {
  const result = await db.query<{ section: PlatformSettingSection; value: unknown; updated_at: Date; updated_by: string }>(
    "select section, value, updated_at, updated_by from harness_admin.platform_settings where tenant_id=$1", [tenantId],
  );
  const stored: StoredSettingSections = {};
  for (const row of result.rows) {
    stored[row.section] = { value: row.value, updatedAt: row.updated_at.toISOString(), updatedBy: row.updated_by };
  }
  return stored;
}

export async function saveSettingSection(db: Database, input: {
  tenantId: string;
  actor: AdminActor;
  section: string;
  value: unknown;
  reason?: string | null;
}): Promise<{ section: PlatformSettingSection; value: unknown; updatedAt: string }> {
  const section = platformSettingSectionSchema.parse(input.section);
  const value = platformSettingsSchema.shape[section].parse(input.value);
  const existing = await db.query<{ value: unknown }>(
    "select value from harness_admin.platform_settings where tenant_id=$1 and section=$2", [input.tenantId, section],
  );
  const result = await db.query<{ updated_at: Date }>(`
    insert into harness_admin.platform_settings(tenant_id, section, value, updated_by)
    values ($1,$2,$3::jsonb,$4)
    on conflict (tenant_id, section) do update set value=excluded.value, updated_at=now(), updated_by=excluded.updated_by
    returning updated_at
  `, [input.tenantId, section, JSON.stringify(value), input.actor.subjectId]);
  const before = existing.rows[0]?.value ?? null;
  await recordChange(db, {
    tenantId: input.tenantId,
    actor: input.actor,
    resourceKind: "platform-setting",
    resourceId: section,
    action: before ? "update" : "create",
    before,
    after: value,
    beforeDigest: before ? stableDigest(before) : null,
    afterDigest: stableDigest(value),
    reason: input.reason ?? null,
  });
  return { section, value, updatedAt: result.rows[0]?.updated_at.toISOString() ?? new Date().toISOString() };
}

export type ResolvedSettingSection<K extends PlatformSettingSection = PlatformSettingSection> = {
  section: K;
  value: PlatformSettings[K];
  source: "store" | "environment" | "default";
  updatedAt: string | null;
  updatedBy: string | null;
};

/**
 * Build a section's value from the environment this process was started with.
 *
 * Driven by the field descriptors rather than a hand-written switch, so a field added to
 * the catalogue gets its environment fallback for free instead of silently resolving to
 * the built-in default until someone remembers to extend a second list.
 *
 * Returns null when the environment says nothing about this section, and also when what
 * it says does not satisfy the schema: a malformed variable is not a reason to start a
 * service on a value nothing validated.
 */
function sectionFromEnv(section: PlatformSettingSection, env: NodeJS.ProcessEnv): unknown | null {
  let value: unknown = PLATFORM_SETTING_DEFAULTS[section];
  let sawAny = false;
  for (const field of PLATFORM_SETTING_FIELDS[section]) {
    if (!field.envName) continue;
    const raw = env[field.envName];
    if (raw === undefined || raw.trim() === "") continue;
    let parsed: unknown;
    if (field.kind === "number") {
      const numeric = Number(raw);
      if (!Number.isFinite(numeric)) continue;
      parsed = numeric;
    } else if (field.kind === "boolean") {
      parsed = raw === "true";
    } else if (field.kind === "json") {
      try { parsed = JSON.parse(raw); } catch { continue; }
    } else {
      parsed = raw;
    }
    value = withSettingValueAt(value, field.path, parsed);
    sawAny = true;
  }
  if (!sawAny) return null;
  const result = platformSettingsSchema.shape[section].safeParse(value);
  return result.success ? result.data : null;
}

/**
 * Resolve every section, newest authority first: a stored value, else the environment
 * this process was started with, else the built-in default.
 *
 * The source travels with the value so the control surface can say which authority a
 * running service is actually obeying, rather than showing a stored value that an
 * environment variable is quietly overriding or a restart has yet to pick up.
 */
export async function resolvePlatformSettings(
  db: Database, tenantId: string, env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedSettingSection[]> {
  const stored = await listStoredSettings(db, tenantId);
  return platformSettingSectionSchema.options.map((section) => {
    const row = stored[section];
    if (row) {
      const parsed = platformSettingsSchema.shape[section].safeParse(row.value);
      if (parsed.success) {
        return { section, value: parsed.data, source: "store", updatedAt: row.updatedAt, updatedBy: row.updatedBy } as ResolvedSettingSection;
      }
    }
    const fromEnv = sectionFromEnv(section, env);
    if (fromEnv) {
      return { section, value: fromEnv, source: "environment", updatedAt: null, updatedBy: null } as ResolvedSettingSection;
    }
    return { section, value: PLATFORM_SETTING_DEFAULTS[section], source: "default", updatedAt: null, updatedBy: null } as ResolvedSettingSection;
  });
}

export async function resolveSettingSection<K extends PlatformSettingSection>(
  db: Database, tenantId: string, section: K, env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedSettingSection<K>> {
  const sections = await resolvePlatformSettings(db, tenantId, env);
  const found = sections.find((item) => item.section === section);
  if (!found) throw new AdminConfigError(`admin.setting_section_unknown:${section}`);
  return found as ResolvedSettingSection<K>;
}

export async function listAdminChanges(
  db: Database, tenantId: string, limit = 100,
): Promise<AdminChangeRecord[]> {
  const bounded = Math.min(Math.max(Math.trunc(limit), 1), 500);
  const result = await db.query<{
    change_id: string; occurred_at: Date; actor_id: string; actor_roles: string[];
    resource_kind: AdminChangeRecord["resourceKind"]; resource_id: string; action: AdminChangeAction;
    before: unknown; after: unknown; before_digest: string | null; after_digest: string | null; reason: string | null;
  }>(`
    select change_id, occurred_at, actor_id, actor_roles, resource_kind, resource_id, action,
           before, after, before_digest, after_digest, reason
    from harness_admin.change_log where tenant_id=$1 order by occurred_at desc limit $2
  `, [tenantId, bounded]);
  return result.rows.map((row) => ({
    changeId: row.change_id,
    occurredAt: row.occurred_at.toISOString(),
    actorId: row.actor_id,
    actorRoles: row.actor_roles ?? [],
    resourceKind: row.resource_kind,
    resourceId: row.resource_id,
    action: row.action,
    before: row.before ?? null,
    after: row.after ?? null,
    beforeDigest: row.before_digest,
    afterDigest: row.after_digest,
    reason: row.reason,
  }));
}

/**
 * Seed the admin store from the JSON registry the profiles used to live in.
 *
 * Idempotent and additive: it writes only profiles and providers the tenant does not
 * already have, so running migrations again never reverts an administered change.
 */
export async function seedAdminConfig(db: Database, input: {
  tenantId: string;
  profiles: ModelProfileDocument[];
  actor?: AdminActor;
}): Promise<{ providersCreated: string[]; profilesCreated: string[] }> {
  const actor = input.actor ?? { subjectId: "system:migration", roles: ["Platform.Admin"] };
  const providersCreated: string[] = [];
  const profilesCreated: string[] = [];
  for (const providerId of new Set(input.profiles.map((profile) => profile.provider))) {
    if (await getProvider(db, input.tenantId, providerId)) continue;
    const provider = providerRecordSchema.parse({
      id: providerId,
      kind: providerId === "openrouter" || providerId === "anthropic" ? providerId : "openai_compatible",
      displayName: providerId === "openrouter" ? "OpenRouter" : providerId === "anthropic" ? "Anthropic" : providerId,
      baseUrl: null,
      credentialRef: providerId === "openrouter" ? "OPENROUTER_API_KEY" : providerId === "anthropic" ? "ANTHROPIC_API_KEY" : null,
      siteUrl: null,
      appName: null,
      status: "active",
    });
    await upsertProvider(db, { tenantId: input.tenantId, actor, provider, reason: "seeded from config/model-profiles.json" });
    providersCreated.push(providerId);
  }
  for (const profile of input.profiles) {
    const existing = await resolveModelProfile(db, { tenantId: input.tenantId, profileId: profile.id });
    if (existing) continue;
    await saveModelProfileRevision(db, {
      tenantId: input.tenantId, actor, profile,
      note: "seeded from config/model-profiles.json",
      reason: "initial seed",
    });
    profilesCreated.push(profile.id);
  }
  return { providersCreated, profilesCreated };
}
