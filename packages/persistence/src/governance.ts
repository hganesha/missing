import { randomUUID } from "node:crypto";
import {
  computeReleaseManifestDigest,
  policyBundleSchema,
  releaseManifestSchema,
  stableDigest,
  verifyReleaseManifestDigest,
  type HarnessPlanV2,
  type PolicyBundle,
  type ReleaseManifest,
  type ReleaseRecord,
  type ReleaseStatus,
} from "@ehf/contracts";
import type { Database } from "./index.js";
import { isProductionProfile } from "@ehf/identity";
import { approveArtifact, registerApprovedArtifact, registerArtifact, requireApprovedArtifact, revokeArtifact } from "./artifact-registry.js";

type QueryClient = {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
  release?: () => void;
};

async function tenantTransaction<T>(db: Database, tenantId: string, action: (client: QueryClient) => Promise<T>): Promise<T> {
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await action(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release?.();
  }
}

export type PolicyRevisionStatus = "DRAFT" | "COMPILED" | "APPROVED" | "PUBLISHED" | "SUPERSEDED";

export type PolicyRevisionRecord = {
  tenantId: string;
  workspaceId: string;
  revision: number;
  status: PolicyRevisionStatus;
  files: Record<string, string>;
  sourceDigest: string;
  compiledBundle: PolicyBundle | null;
  bundleDigest: string | null;
  releaseBlockers: unknown[];
  authoredBy: string;
  approvedBy: string | null;
  publishedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

type PolicyRevisionRow = {
  tenant_id: string; workspace_id: string; revision: number; status: PolicyRevisionStatus;
  files: Record<string, string>; source_digest: string; compiled_bundle: unknown | null;
  bundle_digest: string | null; release_blockers: unknown[]; authored_by: string;
  approved_by: string | null; published_by: string | null; created_at: Date; updated_at: Date;
};

const policyRevisionColumns = `tenant_id, workspace_id, revision, status, files, source_digest,
  compiled_bundle, bundle_digest, release_blockers, authored_by, approved_by, published_by,
  created_at, updated_at`;

function mapPolicyRevision(row: PolicyRevisionRow): PolicyRevisionRecord {
  return {
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    revision: row.revision,
    status: row.status,
    files: row.files,
    sourceDigest: row.source_digest,
    compiledBundle: row.compiled_bundle ? policyBundleSchema.parse(row.compiled_bundle) : null,
    bundleDigest: row.bundle_digest,
    releaseBlockers: row.release_blockers,
    authoredBy: row.authored_by,
    approvedBy: row.approved_by,
    publishedBy: row.published_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function validatePolicyFiles(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("policy.files_invalid");
  const files = raw as Record<string, unknown>;
  const entries = Object.entries(files);
  if (entries.length === 0 || entries.length > 64) throw new Error("policy.files_count_invalid");
  let total = 0;
  const normalized: Record<string, string> = {};
  for (const [path, value] of entries.sort(([left], [right]) => left.localeCompare(right))) {
    if (!/^(?:policy\.yaml|catalog\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\.yaml|fixtures\/corpus\/[a-z0-9][a-z0-9.-]*\.jsonl)$/i.test(path)) {
      throw new Error(`policy.file_path_invalid:${path}`);
    }
    if (typeof value !== "string") throw new Error(`policy.file_source_invalid:${path}`);
    total += Buffer.byteLength(value, "utf8");
    if (total > 10_485_760) throw new Error("policy.files_too_large");
    normalized[path] = value;
  }
  return normalized;
}

export async function createPolicyRevision(db: Database, input: {
  tenantId: string; workspaceId: string; files: unknown; actor: string;
}): Promise<PolicyRevisionRecord> {
  const files = validatePolicyFiles(input.files);
  const sourceDigest = stableDigest(files);
  return tenantTransaction(db, input.tenantId, async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`policy:${input.tenantId}:${input.workspaceId}`]);
    const existing = await client.query<PolicyRevisionRow>(`
      select ${policyRevisionColumns} from harness_control.policy_revisions
      where tenant_id=$1 and workspace_id=$2 and source_digest=$3
    `, [input.tenantId, input.workspaceId, sourceDigest]);
    if (existing.rows[0]) return mapPolicyRevision(existing.rows[0]);
    const next = await client.query<{ revision: number }>(`
      select coalesce(max(revision), 0)::int + 1 as revision
      from harness_control.policy_revisions where tenant_id=$1 and workspace_id=$2
    `, [input.tenantId, input.workspaceId]);
    const revision = next.rows[0]?.revision ?? 1;
    const inserted = await client.query<PolicyRevisionRow>(`
      insert into harness_control.policy_revisions(
        tenant_id, workspace_id, revision, status, files, source_digest, authored_by
      ) values ($1,$2,$3,'DRAFT',$4::jsonb,$5,$6)
      returning ${policyRevisionColumns}
    `, [input.tenantId, input.workspaceId, revision, JSON.stringify(files), sourceDigest, input.actor]);
    await client.query(`
      insert into harness_control.policy_revision_events(
        event_id, tenant_id, workspace_id, revision, event_type, actor, details
      ) values ($1,$2,$3,$4,'policy.revision.created',$5,$6::jsonb)
    `, [`pevt_${randomUUID()}`, input.tenantId, input.workspaceId, revision, input.actor, JSON.stringify({ sourceDigest })]);
    return mapPolicyRevision(inserted.rows[0]!);
  });
}

export async function setPolicyRevisionCompiled(db: Database, input: {
  tenantId: string; workspaceId: string; revision: number; actor: string;
  bundle: unknown; releaseBlockers?: unknown[];
}): Promise<PolicyRevisionRecord> {
  const bundle = policyBundleSchema.parse(input.bundle);
  return tenantTransaction(db, input.tenantId, async (client) => {
    const result = await client.query<PolicyRevisionRow>(`
      update harness_control.policy_revisions
      set status='COMPILED', compiled_bundle=$5::jsonb, bundle_digest=$6,
          release_blockers=$7::jsonb, updated_at=transaction_timestamp()
      where tenant_id=$1 and workspace_id=$2 and revision=$3 and status in ('DRAFT','COMPILED')
        and authored_by=$4
      returning ${policyRevisionColumns}
    `, [input.tenantId, input.workspaceId, input.revision, input.actor, JSON.stringify(bundle),
      bundle.bundleDigest.replace(/^sha256:/, ""), JSON.stringify(input.releaseBlockers ?? [])]);
    if (!result.rows[0]) throw new Error("policy.revision_compile_conflict");
    await registerArtifact(client, {
      tenantId: input.tenantId, kind: "policy-bundle", digest: bundle.bundleDigest,
      reference: `policy:${input.workspaceId}/${input.revision}`, actor: input.actor,
    });
    await client.query(`insert into harness_control.policy_revision_events(
      event_id, tenant_id, workspace_id, revision, event_type, actor, details
    ) values ($1,$2,$3,$4,'policy.revision.compiled',$5,$6::jsonb)`, [
      `pevt_${randomUUID()}`, input.tenantId, input.workspaceId, input.revision, input.actor,
      JSON.stringify({ bundleDigest: bundle.bundleDigest, releaseBlockerCount: input.releaseBlockers?.length ?? 0 }),
    ]);
    return mapPolicyRevision(result.rows[0]);
  });
}

/**
 * Approval is the registry transition: the compiled bundle is unchanged, and the
 * approver (who must differ from the author) moves its registry entry to approved.
 * Nothing is signed; the approved registry entry is what runtimes check.
 */
export async function approvePolicyRevision(db: Database, input: {
  tenantId: string; workspaceId: string; revision: number; actor: string;
}): Promise<PolicyRevisionRecord> {
  return tenantTransaction(db, input.tenantId, async (client) => {
    const current = await client.query<PolicyRevisionRow>(`
      select ${policyRevisionColumns} from harness_control.policy_revisions
      where tenant_id=$1 and workspace_id=$2 and revision=$3 for update
    `, [input.tenantId, input.workspaceId, input.revision]);
    const row = current.rows[0];
    if (!row || row.status !== "COMPILED" || row.authored_by === input.actor || !row.compiled_bundle || !row.bundle_digest) {
      throw new Error("policy.separation_or_lifecycle_conflict");
    }
    const bundle = policyBundleSchema.parse(row.compiled_bundle);
    if (bundle.decisionContract === "business-v2" && row.release_blockers.length) throw new Error("policy.installation_content_unresolved");
    if (bundle.bundleDigest.replace(/^sha256:/, "") !== row.bundle_digest) throw new Error("policy.bundle_digest_mismatch");
    await registerArtifact(client, {
      tenantId: input.tenantId, kind: "policy-bundle", digest: row.bundle_digest,
      reference: `policy:${input.workspaceId}/${input.revision}`, actor: row.authored_by,
    });
    const entry = await approveArtifact(client, {
      tenantId: input.tenantId, kind: "policy-bundle", digest: row.bundle_digest, actor: input.actor,
    });
    const result = await client.query<PolicyRevisionRow>(`
      update harness_control.policy_revisions
      set status='APPROVED', approved_by=$4, updated_at=transaction_timestamp()
      where tenant_id=$1 and workspace_id=$2 and revision=$3
      returning ${policyRevisionColumns}
    `, [input.tenantId, input.workspaceId, input.revision, input.actor]);
    await client.query(`insert into harness_control.policy_revision_events(
      event_id, tenant_id, workspace_id, revision, event_type, actor, details
    ) values ($1,$2,$3,$4,'policy.revision.approved',$5,$6::jsonb)`, [
      `pevt_${randomUUID()}`, input.tenantId, input.workspaceId, input.revision, input.actor,
      JSON.stringify({ bundleDigest: row.bundle_digest, registryStatus: entry.status }),
    ]);
    return mapPolicyRevision(result.rows[0]!);
  });
}

/**
 * Publish an approved revision. It takes effect at `effectiveFrom` (now when omitted); a future date
 * schedules it, and until then the business-policy authority does not accept its bundle. Either way
 * an activation is appended to the workspace's history.
 */
export async function publishPolicyRevision(db: Database, input: {
  tenantId: string; workspaceId: string; revision: number; actor: string; effectiveFrom?: string | undefined; reason?: string | undefined;
}): Promise<PolicyRevisionRecord> {
  return transitionPolicyRevision(db, { ...input, from: "APPROVED", to: "PUBLISHED" });
}

async function transitionPolicyRevision(db: Database, input: {
  tenantId: string; workspaceId: string; revision: number; actor: string;
  from: "APPROVED"; to: "PUBLISHED"; effectiveFrom?: string | undefined; reason?: string | undefined;
}): Promise<PolicyRevisionRecord> {
  const requested = input.effectiveFrom === undefined ? null : Date.parse(input.effectiveFrom);
  if (requested !== null && !Number.isFinite(requested)) throw new Error("policy.effective_from_invalid");
  if (requested !== null && requested < Date.now() - 60_000) throw new Error("policy.effective_from_past");
  return tenantTransaction(db, input.tenantId, async (client) => {
    const pending = await client.query<{ bundle_digest: string | null }>(`
      select bundle_digest from harness_control.policy_revisions
      where tenant_id=$1 and workspace_id=$2 and revision=$3 for update
    `, [input.tenantId, input.workspaceId, input.revision]);
    if (!pending.rows[0]?.bundle_digest) throw new Error("policy.separation_or_lifecycle_conflict");
    await requireApprovedArtifact(client, input.tenantId, "policy-bundle", pending.rows[0].bundle_digest);
    const result = await client.query<PolicyRevisionRow>(`
      update harness_control.policy_revisions set status=$4, published_by=$5, updated_at=transaction_timestamp()
      where tenant_id=$1 and workspace_id=$2 and revision=$3 and status=$6 and authored_by<>$5
      returning ${policyRevisionColumns}
    `, [input.tenantId, input.workspaceId, input.revision, input.to, input.actor, input.from]);
    if (!result.rows[0]) throw new Error(input.actor ? "policy.separation_or_lifecycle_conflict" : "policy.actor_required");
    const now = (await client.query<{ now: Date }>("select transaction_timestamp() as now")).rows[0]!.now;
    const effectiveFrom = requested !== null && requested > now.getTime() ? new Date(requested) : now;
    const kind = effectiveFrom > now ? "SCHEDULE" : "PUBLISH";
    await client.query(`insert into harness_control.policy_activations(tenant_id, workspace_id, activation_id, revision, kind, effective_from, actor, reason)
      values ($1,$2,$3,$4,$5,$6,$7,$8)`, [input.tenantId, input.workspaceId, `pact_${randomUUID()}`, input.revision, kind, effectiveFrom, input.actor, input.reason ?? ""]);
    await client.query(`insert into harness_control.policy_revision_events(
      event_id, tenant_id, workspace_id, revision, event_type, actor, details
    ) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [
      `pevt_${randomUUID()}`, input.tenantId, input.workspaceId, input.revision,
      `policy.revision.${input.to.toLowerCase()}`, input.actor, JSON.stringify({ effectiveFrom: effectiveFrom.toISOString(), kind }),
    ]);
    return mapPolicyRevision(result.rows[0]);
  });
}

export type PolicyActivation = {
  activationId: string; revision: number; kind: "PUBLISH" | "SCHEDULE" | "ROLLBACK"; effectiveFrom: string; actor: string; reason: string; createdAt: string;
};
type ActivationRow = { activation_id: string; revision: number; kind: PolicyActivation["kind"]; effective_from: Date; actor: string; reason: string; created_at: Date };
const mapActivation = (row: ActivationRow): PolicyActivation => ({ activationId: row.activation_id, revision: row.revision, kind: row.kind,
  effectiveFrom: row.effective_from.toISOString(), actor: row.actor, reason: row.reason, createdAt: row.created_at.toISOString() });

/** The workspace's activation history, newest first. */
export async function listPolicyActivations(db: Database, tenantId: string, workspaceId: string): Promise<PolicyActivation[]> {
  return tenantTransaction(db, tenantId, async (client) => (await client.query<ActivationRow>(`
    select activation_id, revision, kind, effective_from, actor, reason, created_at from harness_control.policy_activations
    where tenant_id=$1 and workspace_id=$2 order by effective_from desc, created_at desc limit 500
  `, [tenantId, workspaceId])).rows.map(mapActivation));
}

/** Whether a revision is in effect now, by the same check the business-policy authority applies. */
export async function policyRevisionInEffect(db: Database, tenantId: string, workspaceId: string, revision: number): Promise<boolean> {
  return tenantTransaction(db, tenantId, async (client) => (await client.query<{ in_effect: boolean }>(
    "select harness_control.policy_revision_in_effect($1,$2,$3) as in_effect", [tenantId, workspaceId, revision])).rows[0]!.in_effect);
}

/**
 * Which revision is in effect at `at` (now by default), and which are scheduled after it: the most
 * recent activation that has started, among revisions still PUBLISHED.
 */
export function activationState(activations: readonly PolicyActivation[], revisions: readonly Pick<PolicyRevisionRecord, "revision" | "status">[], at = new Date().toISOString()) {
  const published = new Set(revisions.filter((entry) => entry.status === "PUBLISHED").map((entry) => entry.revision));
  const live = activations.filter((entry) => published.has(entry.revision))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.createdAt.localeCompare(a.createdAt));
  return {
    active: live.find((entry) => entry.effectiveFrom <= at) ?? null,
    scheduled: live.filter((entry) => entry.effectiveFrom > at).reverse(),
  };
}

/**
 * Roll back to an earlier published revision: it takes effect again now, with exactly the files and
 * bundle it was approved with, and every later published or scheduled revision is superseded, so
 * the business-policy authority stops accepting their bundles. The history keeps every step.
 */
export async function rollbackPolicyRevision(db: Database, input: {
  tenantId: string; workspaceId: string; revision: number; actor: string; reason: string;
}): Promise<PolicyRevisionRecord> {
  if (input.reason.trim().length < 3) throw new Error("policy.rollback_reason_required");
  return tenantTransaction(db, input.tenantId, async (client) => {
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`policy:${input.tenantId}:${input.workspaceId}`]);
    const target = (await client.query<PolicyRevisionRow>(`select ${policyRevisionColumns} from harness_control.policy_revisions
      where tenant_id=$1 and workspace_id=$2 and revision=$3 for update`, [input.tenantId, input.workspaceId, input.revision])).rows[0];
    if (!target || target.status !== "PUBLISHED" || !target.bundle_digest) throw new Error("policy.rollback_target_not_published");
    await requireApprovedArtifact(client, input.tenantId, "policy-bundle", target.bundle_digest);
    const later = (await client.query<{ revision: number }>(`update harness_control.policy_revisions set status='SUPERSEDED', updated_at=transaction_timestamp()
      where tenant_id=$1 and workspace_id=$2 and revision>$3 and status='PUBLISHED' returning revision`, [input.tenantId, input.workspaceId, input.revision])).rows;
    if (!later.length) throw new Error("policy.rollback_nothing_to_undo");
    await client.query(`insert into harness_control.policy_activations(tenant_id, workspace_id, activation_id, revision, kind, effective_from, actor, reason)
      values ($1,$2,$3,$4,'ROLLBACK',transaction_timestamp(),$5,$6)`, [input.tenantId, input.workspaceId, `pact_${randomUUID()}`, input.revision, input.actor, input.reason.trim()]);
    const details = JSON.stringify({ reason: input.reason.trim(), restoredRevision: input.revision, superseded: later.map((row) => row.revision).sort((a, b) => a - b) });
    for (const event of [...later.map((row) => ({ revision: row.revision, type: "policy.revision.superseded" })), { revision: input.revision, type: "policy.revision.rolled_back" }]) {
      await client.query(`insert into harness_control.policy_revision_events(event_id, tenant_id, workspace_id, revision, event_type, actor, details)
        values ($1,$2,$3,$4,$5,$6,$7::jsonb)`, [`pevt_${randomUUID()}`, input.tenantId, input.workspaceId, event.revision, event.type, input.actor, details]);
    }
    return mapPolicyRevision(target);
  });
}

export async function listPolicyRevisions(db: Database, tenantId: string, workspaceId: string): Promise<PolicyRevisionRecord[]> {
  return tenantTransaction(db, tenantId, async (client) => {
    const result = await client.query<PolicyRevisionRow>(`
      select ${policyRevisionColumns} from harness_control.policy_revisions
      where tenant_id=$1 and workspace_id=$2 order by revision desc limit 200
    `, [tenantId, workspaceId]);
    return result.rows.map(mapPolicyRevision);
  });
}

export async function getPolicyRevision(
  db: Database,
  tenantId: string,
  workspaceId: string,
  revision: number,
): Promise<PolicyRevisionRecord | null> {
  return tenantTransaction(db, tenantId, async (client) => {
    const result = await client.query<PolicyRevisionRow>(`
      select ${policyRevisionColumns} from harness_control.policy_revisions
      where tenant_id=$1 and workspace_id=$2 and revision=$3
    `, [tenantId, workspaceId, revision]);
    return result.rows[0] ? mapPolicyRevision(result.rows[0]) : null;
  });
}

type ReleaseRow = {
  tenant_id: string; release_id: string; manifest_digest: string; plan_digest: string;
  manifest: unknown; status: ReleaseStatus; revision: number; reason_code: string | null;
  created_by: string; approved_by: string | null; activated_at: Date | null;
  deprecated_at: Date | null; revoked_at: Date | null; updated_at: Date;
};

function mapRelease(row: ReleaseRow): { manifest: ReleaseManifest; record: ReleaseRecord; createdBy: string; approvedBy: string | null } {
  return {
    manifest: releaseManifestSchema.parse(row.manifest),
    record: {
      releaseId: row.release_id,
      manifestDigest: row.manifest_digest,
      status: row.status,
      revision: row.revision,
      activatedAt: row.activated_at?.toISOString() ?? null,
      deprecatedAt: row.deprecated_at?.toISOString() ?? null,
      revokedAt: row.revoked_at?.toISOString() ?? null,
      reasonCode: row.reason_code,
      updatedAt: row.updated_at.toISOString(),
    },
    createdBy: row.created_by,
    approvedBy: row.approved_by,
  };
}

const releaseColumns = `tenant_id, release_id, manifest_digest, plan_digest, manifest, status,
  revision, reason_code, created_by, approved_by, activated_at, deprecated_at, revoked_at, updated_at`;

export async function registerReleaseManifest(db: Database, input: {
  tenantId: string; actor: string; manifest: unknown;
}): Promise<ReturnType<typeof mapRelease>> {
  const manifest = releaseManifestSchema.parse(input.manifest);
  if (!verifyReleaseManifestDigest(manifest)) throw new Error("release.manifest_digest_invalid");
  if (!manifest.scope.tenants.includes(input.tenantId)) throw new Error("release.tenant_scope_missing");
  return tenantTransaction(db, input.tenantId, async (client) => {
    const result = await client.query<ReleaseRow>(`
      insert into harness_control.release_manifests(
        tenant_id, release_id, manifest_digest, plan_digest, manifest, status, created_by
      ) values ($1,$2,$3,$4,$5::jsonb,'candidate',$6)
      on conflict (tenant_id, release_id) do nothing
      returning ${releaseColumns}
    `, [input.tenantId, manifest.releaseId, manifest.manifestDigest.replace(/^sha256:/, ""),
      manifest.planDigest.replace(/^sha256:/, ""), JSON.stringify(manifest), input.actor]);
    if (!result.rows[0]) {
      const existing = await client.query<ReleaseRow>(`
        select ${releaseColumns} from harness_control.release_manifests where tenant_id=$1 and release_id=$2
      `, [input.tenantId, manifest.releaseId]);
      if (!existing.rows[0] || existing.rows[0].manifest_digest !== manifest.manifestDigest.replace(/^sha256:/, "")) {
        throw new Error("release.idempotency_conflict");
      }
      return mapRelease(existing.rows[0]);
    }
    await registerArtifact(client, {
      tenantId: input.tenantId, kind: "release-manifest", digest: manifest.manifestDigest,
      reference: `release:${manifest.releaseId}`, actor: input.actor,
    });
    await client.query(`insert into harness_control.release_events(
      event_id, tenant_id, release_id, revision, from_status, to_status, actor, details
    ) values ($1,$2,$3,0,null,'candidate',$4,$5::jsonb)`, [
      `revt_${randomUUID()}`, input.tenantId, manifest.releaseId, input.actor,
      JSON.stringify({ manifestDigest: manifest.manifestDigest }),
    ]);
    return mapRelease(result.rows[0]);
  });
}

const releaseTransitions: Record<ReleaseStatus, readonly ReleaseStatus[]> = {
  candidate: ["approved", "revoked"],
  approved: ["active", "revoked"],
  active: ["deprecated", "revoked"],
  deprecated: ["active", "revoked"],
  revoked: [],
};

export function releaseTransitionAllowed(from: ReleaseStatus, to: ReleaseStatus): boolean {
  return releaseTransitions[from].includes(to);
}

/** The process a release belongs to (its plan's name) and its environment: a release line. */
async function releaseLine(client: Parameters<typeof registerArtifact>[0], tenantId: string, row: ReleaseRow) {
  const plan = await client.query<{ name: string }>("select name from harness_control.plans where tenant_id=$1 and plan_digest=$2", [tenantId, row.plan_digest]);
  return { environment: String((row.manifest as { scope?: { environment?: string } }).scope?.environment ?? ""), line: plan.rows[0]?.name ?? row.plan_digest };
}

const MAX_SCHEDULE_MS = 5 * 365 * 86_400_000;
/** When an activation takes effect: now, or a future date no more than five years ahead. */
function effectiveDate(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) throw new Error("release.effective_from_invalid");
  if (at.getTime() < Date.now() - 60_000 || at.getTime() > Date.now() + MAX_SCHEDULE_MS) throw new Error("release.effective_from_out_of_range");
  return at;
}

export async function transitionRelease(db: Database, input: {
  tenantId: string; releaseId: string; actor: string; expectedRevision: number;
  to: ReleaseStatus; reasonCode: string;
  /** For `active`: when it takes effect (a future date schedules it; omitted means now). */
  effectiveFrom?: string;
}): Promise<ReturnType<typeof mapRelease>> {
  const scheduled = effectiveDate(input.effectiveFrom);
  if (scheduled && input.to !== "active") throw new Error("release.effective_from_unexpected");
  return tenantTransaction(db, input.tenantId, async (client) => {
    const locked = await client.query<ReleaseRow>(`
      select ${releaseColumns} from harness_control.release_manifests
      where tenant_id=$1 and release_id=$2 for update
    `, [input.tenantId, input.releaseId]);
    const current = locked.rows[0];
    if (!current || current.revision !== input.expectedRevision) throw new Error("release.revision_conflict");
    if (!releaseTransitionAllowed(current.status, input.to)) throw new Error("release.transition_invalid");
    if (input.to === "approved" && current.created_by === input.actor) throw new Error("release.separation_of_duties");
    if (input.to === "approved") {
      await registerArtifact(client, {
        tenantId: input.tenantId, kind: "release-manifest", digest: current.manifest_digest,
        reference: `release:${current.release_id}`, actor: current.created_by,
      });
      await approveArtifact(client, { tenantId: input.tenantId, kind: "release-manifest", digest: current.manifest_digest, actor: input.actor });
    }
    if (input.to === "active") {
      await requireApprovedArtifact(client, input.tenantId, "release-manifest", current.manifest_digest);
    }
    if (input.to === "revoked") {
      await registerArtifact(client, {
        tenantId: input.tenantId, kind: "release-manifest", digest: current.manifest_digest,
        reference: `release:${current.release_id}`, actor: current.created_by,
      });
      await revokeArtifact(client, {
        tenantId: input.tenantId, kind: "release-manifest", digest: current.manifest_digest,
        actor: input.actor, reasonCode: input.reasonCode,
      });
    }
    if (input.to === "active") {
      const manifest = releaseManifestSchema.parse(current.manifest);
      for (const digest of manifest.policyBundleDigests) {
        const published = await client.query<{ release_blockers: unknown[] }>(`
          select release_blockers from harness_control.policy_revisions
          where tenant_id=$1 and bundle_digest=$2 and status='PUBLISHED' and workspace_id not like '${SANDBOX_POLICY_WORKSPACE_PREFIX}%'
          order by updated_at desc limit 1
        `, [input.tenantId, digest.replace(/^sha256:/, "")]);
        if (!published.rows[0]) throw new Error("release.policy_not_published");
        await requireApprovedArtifact(client, input.tenantId, "policy-bundle", digest);
        if (manifest.scope.environment === "production" && published.rows[0].release_blockers.length) {
          throw new Error("release.policy_production_blocked");
        }
      }
      const plan = await client.query<{ plan: { policyBundles?: { bundleDigest: string }[] } }>(`select plan from harness_control.plans where tenant_id=$1 and plan_digest=$2`, [input.tenantId, current.plan_digest]);
      if (!plan.rows.length) throw new Error("release.plan_not_admitted");
      const declared = (plan.rows[0]!.plan.policyBundles ?? []).map((item) => item.bundleDigest.replace(/^sha256:/, "")).sort();
      const released = manifest.policyBundleDigests.map((item) => item.replace(/^sha256:/, "")).sort();
      if (stableDigest(declared) !== stableDigest(released)) throw new Error("release.policy_closure_mismatch");
    }
    const result = await client.query<ReleaseRow>(`
      update harness_control.release_manifests
      set status=$3, revision=revision+1, reason_code=$4,
          approved_by=case when $3='approved' then $5 else approved_by end,
          activated_at=case when $3='active' then transaction_timestamp() else null end,
          deprecated_at=case when $3='deprecated' then transaction_timestamp() else deprecated_at end,
          revoked_at=case when $3='revoked' then transaction_timestamp() else null end,
          updated_at=transaction_timestamp()
      where tenant_id=$1 and release_id=$2
      returning ${releaseColumns}
    `, [input.tenantId, input.releaseId, input.to, input.reasonCode, input.actor]);
    const row = result.rows[0]!;
    if (input.to === "active") {
      // Activation history: a release takes effect now or on its date; reactivating a deprecated
      // release puts it back in effect now.
      if (current.status === "deprecated" && scheduled) throw new Error("release.effective_from_unexpected");
      const { environment, line } = await releaseLine(client, input.tenantId, current);
      const future = scheduled !== null && scheduled.getTime() > Date.now();
      await client.query(`insert into harness_control.release_activations(tenant_id, activation_id, release_id, environment, line, kind, effective_from, actor, reason)
        values ($1,$2,$3,$4,$5,$6,coalesce($7::timestamptz, transaction_timestamp()),$8,$9)`,
      [input.tenantId, `ract_${randomUUID()}`, input.releaseId, environment, line, current.status === "deprecated" ? "ROLLBACK" : future ? "SCHEDULE" : "ACTIVATE",
        scheduled?.toISOString() ?? null, input.actor, input.reasonCode]);
    }
    await client.query(`insert into harness_control.release_events(
      event_id, tenant_id, release_id, revision, from_status, to_status, actor, reason_code, details
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,'{}'::jsonb)`, [
      `revt_${randomUUID()}`, input.tenantId, input.releaseId, row.revision,
      current.status, input.to, input.actor, input.reasonCode,
    ]);
    return mapRelease(row);
  });
}

/**
 * Sandbox releases: a development-only way to run a draft's plan before its release is governed.
 * A sandbox release is an ordinary manifest whose `scope.cohort` is this value. It is approved by a
 * system identity, has its own release line, is never offered to a new case, and may decide under a
 * policy bundle that still has unresolved release blockers. It is refused under the production
 * profile and can never be scoped to production (migration 063).
 */
export const SANDBOX_RELEASE_COHORT = "sandbox";
export const SANDBOX_APPROVAL_ACTOR = "system:sandbox-auto-approval";
/** Policy revisions a sandbox release publishes live in workspaces with this prefix; governed checks never read them. */
export const SANDBOX_POLICY_WORKSPACE_PREFIX = "sandbox:";
export function isSandboxRelease(manifest: Pick<ReleaseManifest, "scope">): boolean {
  return manifest.scope.cohort === SANDBOX_RELEASE_COHORT;
}
export function sandboxReleasesAllowed(environment: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return environment !== "production" && env.RELEASE_ENVIRONMENT !== "production" && !isProductionProfile(env);
}

/**
 * The sandbox release manifest of a plan. Deterministic, so preparing the same plan again finds the
 * same release. It carries no evaluation attestation: that digest names the sandbox itself.
 */
export function sandboxReleaseManifest(plan: HarnessPlanV2, scope: { tenantId: string; environment: string }): ReleaseManifest {
  const digest = (value: string) => value.replace(/^sha256:/, "");
  const manifest: ReleaseManifest = {
    apiVersion: "harness.factory/release-manifest-v1", kind: "ReleaseManifest",
    releaseId: `sandbox-${digest(plan.planDigest).slice(0, 16)}`, manifestDigest: "0".repeat(64),
    planDigest: digest(plan.planDigest), packageDigest: digest(plan.packageDigest),
    policyBundleDigests: plan.policyBundles.map((bundle) => digest(bundle.bundleDigest)),
    schemaSetDigest: digest(plan.schemas.schemaSetDigest), agentDigests: [],
    skillDigests: (plan.skillBindings ?? []).map((binding) => digest(binding.manifestDigest)),
    capabilityDigests: plan.capabilities.map((capability) => stableDigest(capability)),
    modelProfileDigests: plan.modelProfiles.map((profile) => digest(profile.digest)),
    executionProfileDigest: stableDigest(plan.execution), compilerDigest: digest(plan.compiler.digest),
    runtimeDigest: stableDigest({ sandbox: "runtime-not-attested" }),
    dependencyManifestDigest: digest(plan.dependencyManifestDigest),
    evaluationAttestationDigest: stableDigest({ sandbox: "no-evaluation-attestation", planDigest: digest(plan.planDigest) }),
    provenanceDigest: digest(plan.buildProvenanceDigest),
    scope: { environment: scope.environment, tenants: [scope.tenantId], regions: plan.releaseConstraints?.regions?.length ? plan.releaseConstraints.regions : ["US"], cohort: SANDBOX_RELEASE_COHORT },
    createdAt: plan.createdAt,
  };
  manifest.manifestDigest = computeReleaseManifestDigest(manifest);
  return manifest;
}

/**
 * Put a draft's admitted plan and its compiled policy in effect as a sandbox release, in one
 * transaction. The author registers; `SANDBOX_APPROVAL_ACTOR` approves, so the history shows the
 * approval was automatic rather than a person's review. Policy blockers are stored as compiled.
 * Idempotent on the release id.
 */
export async function activateSandboxRelease(db: Database, input: {
  tenantId: string; actor: string; manifest: unknown;
  policies: Array<{ workspaceId: string; files: Record<string, string>; bundle: unknown; releaseBlockers: unknown[] }>;
}, env: NodeJS.ProcessEnv = process.env): Promise<ReturnType<typeof mapRelease>> {
  const manifest = releaseManifestSchema.parse(input.manifest);
  if (!isSandboxRelease(manifest)) throw new Error("release.sandbox_cohort_required");
  if (!sandboxReleasesAllowed(manifest.scope.environment, env)) throw new Error("release.sandbox_not_allowed");
  if (!verifyReleaseManifestDigest(manifest)) throw new Error("release.manifest_digest_invalid");
  if (!manifest.scope.tenants.includes(input.tenantId)) throw new Error("release.tenant_scope_missing");
  if (!input.actor || input.actor === SANDBOX_APPROVAL_ACTOR) throw new Error("release.separation_of_duties");
  const bundles = input.policies.map((policy) => ({ ...policy, bundle: policyBundleSchema.parse(policy.bundle) }));
  const digestOf = (value: string) => value.replace(/^sha256:/, "");
  const declared = manifest.policyBundleDigests.map(digestOf).sort();
  if (stableDigest(declared) !== stableDigest(bundles.map((policy) => digestOf(policy.bundle.bundleDigest)).sort())) throw new Error("release.policy_closure_mismatch");
  return tenantTransaction(db, input.tenantId, async (client) => {
    const plan = await client.query<{ name: string; plan: { policyBundles?: { bundleDigest: string }[] } }>(
      "select name, plan from harness_control.plans where tenant_id=$1 and plan_digest=$2", [input.tenantId, digestOf(manifest.planDigest)]);
    if (!plan.rows[0]) throw new Error("release.plan_not_admitted");
    if (stableDigest((plan.rows[0].plan.policyBundles ?? []).map((item) => digestOf(item.bundleDigest)).sort()) !== stableDigest(declared)) throw new Error("release.policy_closure_mismatch");

    for (const policy of bundles) {
      const bundleDigest = digestOf(policy.bundle.bundleDigest);
      if (!policy.workspaceId.startsWith(SANDBOX_POLICY_WORKSPACE_PREFIX)) throw new Error("release.sandbox_policy_workspace_required");
      // Sandbox policy authority lives in sandbox workspaces only. The shared artifact registry is
      // not touched, so this neither stands in for, nor collides with, a governed policy approval.
      const published = await client.query(`select 1 from harness_control.policy_revisions
        where tenant_id=$1 and bundle_digest=$2 and status='PUBLISHED' and workspace_id like '${SANDBOX_POLICY_WORKSPACE_PREFIX}%' limit 1`, [input.tenantId, bundleDigest]);
      if (!published.rows[0]) {
        await client.query("select pg_advisory_xact_lock(hashtext($1))", [`policy:${input.tenantId}:${policy.workspaceId}`]);
        const next = await client.query<{ revision: number }>(`select coalesce(max(revision), 0)::int + 1 as revision
          from harness_control.policy_revisions where tenant_id=$1 and workspace_id=$2`, [input.tenantId, policy.workspaceId]);
        const revision = next.rows[0]?.revision ?? 1;
        await client.query(`insert into harness_control.policy_revisions(
            tenant_id, workspace_id, revision, status, files, source_digest, compiled_bundle, bundle_digest, release_blockers,
            authored_by, approved_by, published_by
          ) values ($1,$2,$3,'PUBLISHED',$4::jsonb,$5,$6::jsonb,$7,$8::jsonb,$9,$10,$10)`,
        [input.tenantId, policy.workspaceId, revision, JSON.stringify(policy.files), stableDigest(policy.files),
          JSON.stringify(policy.bundle), bundleDigest, JSON.stringify(policy.releaseBlockers), input.actor, SANDBOX_APPROVAL_ACTOR]);
        await client.query(`insert into harness_control.policy_activations(tenant_id, workspace_id, activation_id, revision, kind, effective_from, actor, reason)
          values ($1,$2,$3,$4,'PUBLISH',transaction_timestamp(),$5,$6)`,
        [input.tenantId, policy.workspaceId, `pact_${randomUUID()}`, revision, SANDBOX_APPROVAL_ACTOR, "sandbox.draft_rehearsal"]);
        await client.query(`insert into harness_control.policy_revision_events(event_id, tenant_id, workspace_id, revision, event_type, actor, details)
          values ($1,$2,$3,$4,'policy.revision.sandbox_published',$5,$6::jsonb)`,
        [`pevt_${randomUUID()}`, input.tenantId, policy.workspaceId, revision, SANDBOX_APPROVAL_ACTOR,
          JSON.stringify({ bundleDigest, releaseBlockerCount: policy.releaseBlockers.length, releaseId: manifest.releaseId })]);
      }
    }

    const manifestDigest = digestOf(manifest.manifestDigest);
    const inserted = await client.query<ReleaseRow>(`
      insert into harness_control.release_manifests(
        tenant_id, release_id, manifest_digest, plan_digest, manifest, status, revision, reason_code, created_by, approved_by, activated_at
      ) values ($1,$2,$3,$4,$5::jsonb,'active',2,'sandbox.draft_rehearsal',$6,$7,transaction_timestamp())
      on conflict (tenant_id, release_id) do nothing
      returning ${releaseColumns}
    `, [input.tenantId, manifest.releaseId, manifestDigest, digestOf(manifest.planDigest), JSON.stringify(manifest), input.actor, SANDBOX_APPROVAL_ACTOR]);
    if (!inserted.rows[0]) {
      const existing = await client.query<ReleaseRow>(`select ${releaseColumns} from harness_control.release_manifests
        where tenant_id=$1 and release_id=$2`, [input.tenantId, manifest.releaseId]);
      if (!existing.rows[0] || existing.rows[0].manifest_digest !== manifestDigest) throw new Error("release.idempotency_conflict");
      return mapRelease(existing.rows[0]);
    }
    await registerApprovedArtifact(client, {
      tenantId: input.tenantId, kind: "release-manifest", digest: manifestDigest,
      reference: `release:${manifest.releaseId}`, registeredBy: input.actor, approvedBy: SANDBOX_APPROVAL_ACTOR,
    });
    // Its own line: a sandbox release never supersedes, or is superseded by, a governed release of the process.
    await client.query(`insert into harness_control.release_activations(tenant_id, activation_id, release_id, environment, line, kind, effective_from, actor, reason)
      values ($1,$2,$3,$4,$5,'ACTIVATE',transaction_timestamp(),$6,'sandbox.draft_rehearsal')`,
    [input.tenantId, `ract_${randomUUID()}`, manifest.releaseId, manifest.scope.environment, `sandbox:${manifest.releaseId}`, SANDBOX_APPROVAL_ACTOR]);
    for (const [revision, from, to, actor] of [[0, null, "candidate", input.actor], [1, "candidate", "approved", SANDBOX_APPROVAL_ACTOR], [2, "approved", "active", SANDBOX_APPROVAL_ACTOR]] as const) {
      await client.query(`insert into harness_control.release_events(event_id, tenant_id, release_id, revision, from_status, to_status, actor, reason_code, details)
        values ($1,$2,$3,$4,$5,$6,$7,'sandbox.draft_rehearsal',$8::jsonb)`,
      [`revt_${randomUUID()}`, input.tenantId, manifest.releaseId, revision, from, to, actor, JSON.stringify({ manifestDigest, sandbox: true })]);
    }
    return mapRelease(inserted.rows[0]);
  });
}

/** A fresh database read at every authority boundary; revocation is never cached. */
export async function requireExecutableRelease(db: Database, tenantId: string, planDigest: string, environment: string) {
  return tenantTransaction(db, tenantId, async (client) => {
    const result = await client.query<ReleaseRow>(`
      select ${releaseColumns} from harness_control.release_manifests
      where tenant_id=$1 and plan_digest=$2 and status='active'
        and manifest->'scope'->>'environment'=$3 and harness_control.release_in_effect(tenant_id, release_id)
      -- A governed release of the plan outranks a sandbox one.
      order by (manifest->'scope'->>'cohort' = '${SANDBOX_RELEASE_COHORT}'), activated_at desc, release_id limit 1
    `, [tenantId, planDigest.replace(/^sha256:/, ""), environment]);
    if (!result.rows[0]) throw new Error("release.executable_authority_missing");
    const release = mapRelease(result.rows[0]);
    const sandbox = isSandboxRelease(release.manifest);
    if (sandbox && !sandboxReleasesAllowed(environment)) throw new Error("release.sandbox_not_allowed");
    if (!verifyReleaseManifestDigest(release.manifest)) throw new Error("release.manifest_digest_invalid");
    await requireApprovedArtifact(client, tenantId, "release-manifest", release.manifest.manifestDigest);
    for (const digest of release.manifest.policyBundleDigests) {
      // A sandbox release reads the revision it published in a sandbox workspace; a governed release never reads one.
      const policy = await client.query<{ compiled_bundle: PolicyBundle | null; release_blockers: unknown[] }>(`select compiled_bundle, release_blockers from harness_control.policy_revisions
        where tenant_id=$1 and bundle_digest=$2 and status='PUBLISHED' and (workspace_id like '${SANDBOX_POLICY_WORKSPACE_PREFIX}%') = $3
        order by updated_at desc limit 1`, [tenantId, digest.replace(/^sha256:/, ""), sandbox]);
      if (!policy.rows[0]?.compiled_bundle) throw new Error("release.policy_not_published");
      // A sandbox release rehearses a draft whose installation policy may still be unfinished, and
      // its policy has no registry approval of its own: the approved sandbox manifest carries it.
      if (sandbox) continue;
      if(policy.rows[0].compiled_bundle.decisionContract==="business-v2" && policy.rows[0].release_blockers.length) throw new Error("policy.installation_content_unresolved");
      await requireApprovedArtifact(client, tenantId, "policy-bundle", digest);
    }
    return release;
  });
}

export async function getPublishedPolicy(db: Database, tenantId: string, bundleDigest: string): Promise<PolicyRevisionRecord | null> {
  return tenantTransaction(db, tenantId, async (client) => {
    const result = await client.query<PolicyRevisionRow>(`
      select ${policyRevisionColumns} from harness_control.policy_revisions
      where tenant_id=$1 and bundle_digest=$2 and status='PUBLISHED'
      -- A governed revision of the bundle outranks a sandbox one; callers have already checked the release.
      order by (workspace_id like '${SANDBOX_POLICY_WORKSPACE_PREFIX}%'), updated_at desc limit 1
    `, [tenantId, bundleDigest.replace(/^sha256:/, "")]);
    return result.rows[0] ? mapPolicyRevision(result.rows[0]) : null;
  });
}

export type ReleaseActivation = {
  activationId: string; releaseId: string; environment: string; line: string; kind: "ACTIVATE" | "SCHEDULE" | "ROLLBACK";
  effectiveFrom: string; actor: string; reason: string; createdAt: string;
};

/**
 * The release activation history, newest first, with the releases in effect now and the activations
 * still to come. In effect: active, started, and the most recent start among its line's active releases.
 */
export async function listReleaseActivations(db: Database, tenantId: string) {
  return tenantTransaction(db, tenantId, async (client) => {
    const rows = (await client.query<{ activation_id: string; release_id: string; environment: string; line: string; kind: ReleaseActivation["kind"];
      effective_from: Date; actor: string; reason: string; created_at: Date; status: string }>(`select a.activation_id, a.release_id, a.environment, a.line, a.kind, a.effective_from, a.actor, a.reason, a.created_at, m.status
      from harness_control.release_activations a join harness_control.release_manifests m on m.tenant_id=a.tenant_id and m.release_id=a.release_id
      where a.tenant_id=$1 and coalesce(m.manifest->'scope'->>'cohort', '') <> '${SANDBOX_RELEASE_COHORT}'
      order by a.effective_from desc, a.created_at desc limit 500`, [tenantId])).rows;
    const inEffect = (await client.query<{ release_id: string }>(`select release_id from harness_control.release_manifests
      where tenant_id=$1 and status='active' and harness_control.release_in_effect(tenant_id, release_id)
        and coalesce(manifest->'scope'->>'cohort', '') <> '${SANDBOX_RELEASE_COHORT}' order by release_id`, [tenantId])).rows.map((row) => row.release_id);
    const activations: ReleaseActivation[] = rows.map((row) => ({ activationId: row.activation_id, releaseId: row.release_id, environment: row.environment, line: row.line,
      kind: row.kind, effectiveFrom: row.effective_from.toISOString(), actor: row.actor, reason: row.reason, createdAt: row.created_at.toISOString() }));
    const now = Date.now();
    // Still to come: future activations of releases that are still active (a rollback deprecates them).
    return { activations, inEffect, scheduled: activations.filter((entry, index) => Date.parse(entry.effectiveFrom) > now && rows[index]!.status === "active") };
  });
}

/**
 * Put an earlier release of a line back in effect now: it becomes active (from deprecated or a
 * superseded active state) with a ROLLBACK activation, and every other active release of its line,
 * including any scheduled one, is deprecated. Nothing is deleted; the history shows each step.
 */
export async function rollbackRelease(db: Database, input: { tenantId: string; releaseId: string; actor: string; reason: string }) {
  if (input.reason.trim().length < 3) throw new Error("release.rollback_reason_required");
  return tenantTransaction(db, input.tenantId, async (client) => {
    const current = (await client.query<ReleaseRow>(`select ${releaseColumns} from harness_control.release_manifests
      where tenant_id=$1 and release_id=$2 for update`, [input.tenantId, input.releaseId])).rows[0];
    if (!current) throw new Error("release.not_found");
    if (current.status !== "active" && current.status !== "deprecated") throw new Error("release.rollback_target_invalid");
    const earlier = await client.query("select 1 from harness_control.release_activations where tenant_id=$1 and release_id=$2 and effective_from <= transaction_timestamp()", [input.tenantId, input.releaseId]);
    if (!earlier.rowCount) throw new Error("release.rollback_target_never_effective");
    await requireApprovedArtifact(client, input.tenantId, "release-manifest", current.manifest_digest);
    const { environment, line } = await releaseLine(client, input.tenantId, current);
    const others = (await client.query<ReleaseRow>(`select ${releaseColumns} from harness_control.release_manifests m
      where m.tenant_id=$1 and m.release_id<>$2 and m.status='active' and m.manifest->'scope'->>'environment'=$3
        and exists (select 1 from harness_control.release_activations a where a.tenant_id=m.tenant_id and a.release_id=m.release_id and a.line=$4)
      for update`, [input.tenantId, input.releaseId, environment, line])).rows;
    for (const other of others) {
      await client.query(`update harness_control.release_manifests set status='deprecated', revision=revision+1, reason_code='release.rolled_back',
        activated_at=null, deprecated_at=transaction_timestamp(), updated_at=transaction_timestamp() where tenant_id=$1 and release_id=$2`, [input.tenantId, other.release_id]);
      await client.query(`insert into harness_control.release_events(event_id, tenant_id, release_id, revision, from_status, to_status, actor, reason_code, details)
        values ($1,$2,$3,$4,'active','deprecated',$5,'release.rolled_back',$6::jsonb)`, [`revt_${randomUUID()}`, input.tenantId, other.release_id, other.revision + 1, input.actor,
        JSON.stringify({ rolledBackTo: input.releaseId })]);
    }
    const updated = (await client.query<ReleaseRow>(`update harness_control.release_manifests set status='active', revision=revision+1, reason_code='release.rollback',
      activated_at=transaction_timestamp(), deprecated_at=null, updated_at=transaction_timestamp() where tenant_id=$1 and release_id=$2 returning ${releaseColumns}`,
    [input.tenantId, input.releaseId])).rows[0]!;
    await client.query(`insert into harness_control.release_events(event_id, tenant_id, release_id, revision, from_status, to_status, actor, reason_code, details)
      values ($1,$2,$3,$4,$5,'active',$6,'release.rollback',$7::jsonb)`, [`revt_${randomUUID()}`, input.tenantId, input.releaseId, updated.revision, current.status, input.actor,
      JSON.stringify({ reason: input.reason.trim(), deprecated: others.map((other) => other.release_id) })]);
    await client.query(`insert into harness_control.release_activations(tenant_id, activation_id, release_id, environment, line, kind, effective_from, actor, reason)
      values ($1,$2,$3,$4,$5,'ROLLBACK',transaction_timestamp(),$6,$7)`, [input.tenantId, `ract_${randomUUID()}`, input.releaseId, environment, line, input.actor, input.reason.trim()]);
    return mapRelease(updated);
  });
}

/** The releases in effect now in one environment (one per process): what new cases may run on. */
export async function listReleasesInEffect(db: Database, tenantId: string, environment: string): Promise<Array<ReturnType<typeof mapRelease>>> {
  return tenantTransaction(db, tenantId, async (client) => {
    const result = await client.query<ReleaseRow>(`
      select ${releaseColumns} from harness_control.release_manifests
      where tenant_id=$1 and status='active' and manifest->'scope'->>'environment'=$2 and harness_control.release_in_effect(tenant_id, release_id)
        -- A sandbox release is never offered to a new case.
        and coalesce(manifest->'scope'->>'cohort', '') <> '${SANDBOX_RELEASE_COHORT}'
      order by release_id
    `, [tenantId, environment]);
    return result.rows.map(mapRelease);
  });
}

/** Governed releases by default; `sandbox: true` lists the sandbox releases instead. */
export async function listReleases(db: Database, tenantId: string, options: { sandbox?: boolean } = {}): Promise<Array<ReturnType<typeof mapRelease>>> {
  return tenantTransaction(db, tenantId, async (client) => {
    const result = await client.query<ReleaseRow>(`
      select ${releaseColumns} from harness_control.release_manifests
      where tenant_id=$1 and (coalesce(manifest->'scope'->>'cohort', '') = '${SANDBOX_RELEASE_COHORT}') = $2
      order by updated_at desc, release_id desc limit 200
    `, [tenantId, options.sandbox === true]);
    return result.rows.map(mapRelease);
  });
}
