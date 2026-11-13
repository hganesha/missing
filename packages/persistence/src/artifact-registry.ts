import { randomUUID } from "node:crypto";
import {
  artifactKindSchema,
  artifactRegistryEntrySchema,
  type ArtifactKind,
  type ArtifactRegistryEntry,
} from "@ehf/contracts";
import type { Database } from "./index.js";

/**
 * The artifact registry is the trust anchor for compiled governance artifacts.
 *
 * An artifact is executable only while the registry holds an entry for its exact
 * (tenant, kind, digest) that was approved by someone other than its registrant and
 * has not been revoked. Callers always recompute the digest from the content they are
 * about to trust before asking the registry; the registry never vouches for bytes it
 * was not shown the digest of.
 */
export type RegistryClient = {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
};

type RegistryRow = {
  tenant_id: string; artifact_kind: ArtifactKind; digest: string; reference: string;
  status: ArtifactRegistryEntry["status"]; registered_by: string; approved_by: string | null;
  revoked_by: string | null; reason_code: string | null; registered_at: Date;
  approved_at: Date | null; revoked_at: Date | null;
};

const columns = `tenant_id, artifact_kind, digest, reference, status, registered_by, approved_by,
  revoked_by, reason_code, registered_at, approved_at, revoked_at`;

function normalizeDigest(digest: string): string {
  const value = digest.replace(/^sha256:/, "");
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error("artifact.digest_invalid");
  return value;
}

function text(value: string, code: string, max = 300): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(code);
  return value;
}

function mapEntry(row: RegistryRow): ArtifactRegistryEntry {
  return artifactRegistryEntrySchema.parse({
    tenantId: row.tenant_id,
    kind: row.artifact_kind,
    digest: row.digest,
    reference: row.reference,
    status: row.status,
    registeredBy: row.registered_by,
    approvedBy: row.approved_by,
    revokedBy: row.revoked_by,
    reasonCode: row.reason_code,
    registeredAt: row.registered_at.toISOString(),
    approvedAt: row.approved_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  });
}

async function event(client: RegistryClient, entry: { tenantId: string; kind: ArtifactKind; digest: string },
  from: string | null, to: string, actor: string, reasonCode: string | null) {
  await client.query(`insert into harness_control.artifact_registry_events(
    event_id, tenant_id, artifact_kind, digest, from_status, to_status, actor, reason_code
  ) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [`aevt_${randomUUID()}`, entry.tenantId, entry.kind, entry.digest, from, to, actor, reasonCode]);
}

async function lock(client: RegistryClient, tenantId: string, kind: ArtifactKind, digest: string) {
  const result = await client.query<RegistryRow>(`select ${columns} from harness_control.artifact_registry
    where tenant_id=$1 and artifact_kind=$2 and digest=$3 for update`, [tenantId, kind, digest]);
  return result.rows[0] ?? null;
}

/**
 * Record that an artifact exists. Idempotent for the same reference; a digest cannot
 * be re-registered under a different reference, and a revoked digest stays revoked.
 */
export async function registerArtifact(client: RegistryClient, input: {
  tenantId: string; kind: ArtifactKind; digest: string; reference: string; actor: string;
}): Promise<ArtifactRegistryEntry> {
  const kind = artifactKindSchema.parse(input.kind);
  const digest = normalizeDigest(input.digest);
  const reference = text(input.reference, "artifact.reference_invalid");
  const actor = text(input.actor, "artifact.actor_required");
  const inserted = await client.query<RegistryRow>(`insert into harness_control.artifact_registry(
      tenant_id, artifact_kind, digest, reference, status, registered_by
    ) values ($1,$2,$3,$4,'registered',$5)
    on conflict (tenant_id, artifact_kind, digest) do nothing
    returning ${columns}`, [input.tenantId, kind, digest, reference, actor]);
  if (inserted.rows[0]) {
    await event(client, { tenantId: input.tenantId, kind, digest }, null, "registered", actor, null);
    return mapEntry(inserted.rows[0]);
  }
  const existing = await lock(client, input.tenantId, kind, digest);
  if (!existing || existing.reference !== reference) throw new Error("artifact.registry_conflict");
  return mapEntry(existing);
}

/** Approve a registered artifact. Separation of duties is enforced here and by a table check. */
export async function approveArtifact(client: RegistryClient, input: {
  tenantId: string; kind: ArtifactKind; digest: string; actor: string;
}): Promise<ArtifactRegistryEntry> {
  const kind = artifactKindSchema.parse(input.kind);
  const digest = normalizeDigest(input.digest);
  const actor = text(input.actor, "artifact.actor_required");
  const current = await lock(client, input.tenantId, kind, digest);
  if (!current) throw new Error("artifact.not_registered");
  if (current.status === "revoked") throw new Error("artifact.revoked");
  if (current.status === "approved") return mapEntry(current);
  if (current.registered_by === actor) throw new Error("artifact.separation_of_duties");
  const result = await client.query<RegistryRow>(`update harness_control.artifact_registry
    set status='approved', approved_by=$4, approved_at=transaction_timestamp()
    where tenant_id=$1 and artifact_kind=$2 and digest=$3 returning ${columns}`, [input.tenantId, kind, digest, actor]);
  await event(client, { tenantId: input.tenantId, kind, digest }, current.status, "approved", actor, null);
  return mapEntry(result.rows[0]!);
}

/**
 * Register and approve in one step. Only for artifacts whose approval happened at an
 * upstream authority the caller has already verified (for example, a deployment
 * package whose digest the protected pipeline pinned into this environment).
 */
export async function registerApprovedArtifact(client: RegistryClient, input: {
  tenantId: string; kind: ArtifactKind; digest: string; reference: string; registeredBy: string; approvedBy: string;
}): Promise<ArtifactRegistryEntry> {
  const entry = await registerArtifact(client, { ...input, actor: input.registeredBy });
  if (entry.status === "approved") return entry;
  return approveArtifact(client, { ...input, actor: input.approvedBy });
}

export async function revokeArtifact(client: RegistryClient, input: {
  tenantId: string; kind: ArtifactKind; digest: string; actor: string; reasonCode: string;
}): Promise<ArtifactRegistryEntry> {
  const kind = artifactKindSchema.parse(input.kind);
  const digest = normalizeDigest(input.digest);
  const actor = text(input.actor, "artifact.actor_required");
  const reasonCode = text(input.reasonCode, "artifact.reason_required");
  const current = await lock(client, input.tenantId, kind, digest);
  if (!current) throw new Error("artifact.not_registered");
  if (current.status === "revoked") return mapEntry(current);
  const result = await client.query<RegistryRow>(`update harness_control.artifact_registry
    set status='revoked', revoked_by=$4, reason_code=$5, revoked_at=transaction_timestamp()
    where tenant_id=$1 and artifact_kind=$2 and digest=$3 returning ${columns}`, [input.tenantId, kind, digest, actor, reasonCode]);
  await event(client, { tenantId: input.tenantId, kind, digest }, current.status, "revoked", actor, reasonCode);
  return mapEntry(result.rows[0]!);
}

/** A fresh read at every authority boundary; registry state is never cached. */
export async function requireApprovedArtifact(client: RegistryClient, tenantId: string, kind: ArtifactKind, digest: string): Promise<ArtifactRegistryEntry> {
  const result = await client.query<RegistryRow>(`select ${columns} from harness_control.artifact_registry
    where tenant_id=$1 and artifact_kind=$2 and digest=$3`, [tenantId, artifactKindSchema.parse(kind), normalizeDigest(digest)]);
  const row = result.rows[0];
  if (!row) throw new Error(`artifact.not_registered:${kind}`);
  if (row.status === "revoked") throw new Error(`artifact.revoked:${kind}`);
  if (row.status !== "approved") throw new Error(`artifact.not_approved:${kind}`);
  return mapEntry(row);
}

async function tenantScoped<T>(db: Database, tenantId: string, action: (client: RegistryClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await action(client as unknown as RegistryClient);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function getArtifactRegistryEntry(db: Database, tenantId: string, kind: ArtifactKind, digest: string): Promise<ArtifactRegistryEntry | null> {
  return tenantScoped(db, tenantId, async (client) => {
    const result = await client.query<RegistryRow>(`select ${columns} from harness_control.artifact_registry
      where tenant_id=$1 and artifact_kind=$2 and digest=$3`, [tenantId, artifactKindSchema.parse(kind), normalizeDigest(digest)]);
    return result.rows[0] ? mapEntry(result.rows[0]) : null;
  });
}

export async function listArtifactRegistry(db: Database, tenantId: string, kind?: ArtifactKind): Promise<ArtifactRegistryEntry[]> {
  return tenantScoped(db, tenantId, async (client) => {
    const result = await client.query<RegistryRow>(`select ${columns} from harness_control.artifact_registry
      where tenant_id=$1 and ($2::text is null or artifact_kind=$2)
      order by registered_at desc limit 200`, [tenantId, kind ? artifactKindSchema.parse(kind) : null]);
    return result.rows.map(mapEntry);
  });
}

export async function registerArtifactEntry(db: Database, input: Parameters<typeof registerArtifact>[1]) {
  return tenantScoped(db, input.tenantId, (client) => registerArtifact(client, input));
}

export async function revokeArtifactEntry(db: Database, input: Parameters<typeof revokeArtifact>[1]) {
  return tenantScoped(db, input.tenantId, (client) => revokeArtifact(client, input));
}

export async function requireApprovedArtifactEntry(db: Database, tenantId: string, kind: ArtifactKind, digest: string) {
  return tenantScoped(db, tenantId, (client) => requireApprovedArtifact(client, tenantId, kind, digest));
}
