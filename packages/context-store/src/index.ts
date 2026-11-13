import pg, { type PoolClient } from "pg";
import type { ContextPack, ContextSection } from "@ehf/context-plane";
import { blobContainerFromEnv, sha256Hex, type BlobContainer } from "@ehf/blob-store";
import { canonicalJson, stableDigest } from "@ehf/contracts";
import { databaseAuth, isProductionProfile } from "@ehf/identity";

/**
 * The context store (docs/implementation/data-stores-plan.md §3.3): every context pack an
 * agent or evaluate node was given, its sections and quarantine signals, the provenance
 * graph (Apache AGE) of what each pack drew on, and the retrieval index (pgvector).
 *
 * Working data: a case's packs are released after it closes (phase 4d); what an accepted
 * decision relied on is promoted to the evidence store first (phase 4c).
 */

export type ContextStore = {
  db: InstanceType<typeof pg.Pool>;
  /** Where pack bodies go (CONTEXT_PACK_BLOB_*); without it they stay in the database, outside production only. */
  packBlobs?: BlobContainer | null;
  packBlobRequired?: boolean;
};

export class ContextStoreError extends Error {
  constructor(readonly code: string, readonly httpStatus = 400) {
    super(code);
    this.name = "ContextStoreError";
  }
}

export function createContextStore(options: { connectionString?: string; packBlobs?: BlobContainer | null; env?: NodeJS.ProcessEnv } = {}): ContextStore {
  const env = options.env ?? process.env;
  const connectionString = options.connectionString ?? process.env.CONTEXT_DATABASE_URL;
  databaseAuth();
  if (!connectionString) throw new ContextStoreError("context_store.database_url_missing", 500);
  return {
    db: new pg.Pool({
      connectionString,
      max: Number(process.env.CONTEXT_DB_POOL_MAX ?? 4),
    }),
    packBlobs: options.packBlobs === undefined ? blobContainerFromEnv("CONTEXT_PACK", env) : options.packBlobs,
    packBlobRequired: isProductionProfile(env),
  };
}

/** Every pack blob of one case lives under this prefix, so release deletes them without a lookup. */
export function casePackPrefix(tenantId: string, caseId: string): string {
  return `tenants/${stableDigest(tenantId).slice(0, 16)}/cases/${encodeURIComponent(caseId)}/`;
}

function packBlobName(tenantId: string, caseId: string | null, packDigest: string): string {
  return caseId ? `${casePackPrefix(tenantId, caseId)}${packDigest}.json` : `tenants/${stableDigest(tenantId).slice(0, 16)}/nocase/${packDigest}.json`;
}

/** Delete a case's pack blobs (the release job, before it deletes the rows). Returns how many. */
export async function deleteCasePackBlobs(store: ContextStore, tenantId: string, caseId: string): Promise<number | null> {
  if (!store.packBlobs) return null;
  let deleted = 0;
  for await (const item of store.packBlobs.list(casePackPrefix(tenantId, caseId))) {
    if (await store.packBlobs.delete(item.name)) deleted += 1;
  }
  return deleted;
}

/** Run `work` in one transaction bound to `tenantId`; every context table and graph function reads it. */
export async function withContextTenant<T>(
  store: ContextStore,
  tenantId: string,
  work: (client: PoolClient) => Promise<T>,
  options: { readOnly?: boolean } = {},
): Promise<T> {
  if (!tenantId) throw new ContextStoreError("context.tenant_required");
  const client = await store.db.connect();
  try {
    await client.query(options.readOnly ? "begin read only" : "begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export type PackSource = { ref: string; kind: string; sectionId: string; trust: string; disposition: Disposition };
type Disposition = "INCLUDED" | "DROPPED_BUDGET" | "QUARANTINED";

const MAX_EVIDENCE_REFS_PER_SECTION = 500;

function disposition(pack: ContextPack, section: ContextSection): Disposition {
  if (section.quarantined) return "QUARANTINED";
  return pack.budget.droppedSectionIds.includes(section.id) ? "DROPPED_BUDGET" : "INCLUDED";
}

/** `case:<id>@<sequence>/<source>:<path>` names one read; the graph links the stable part. */
export function stableProvenanceRef(provenanceRef: string): string {
  return provenanceRef.replace(/^(case:[^@/]+)@\d+\//, "$1/");
}

function evidenceIds(value: unknown): string[] {
  const ids = new Set<string>();
  const visit = (item: unknown) => {
    if (!item || typeof item !== "object" || ids.size >= MAX_EVIDENCE_REFS_PER_SECTION) return;
    const record = item as Record<string, unknown>;
    for (const key of ["evidenceId", "evidence_id"]) if (typeof record[key] === "string") ids.add(record[key] as string);
  };
  if (Array.isArray(value)) value.forEach(visit);
  else if (value && typeof value === "object") {
    visit(value);
    for (const nested of Object.values(value as Record<string, unknown>)) if (Array.isArray(nested)) nested.forEach(visit);
  }
  return [...ids];
}

/** What a pack drew on, for the provenance graph: each section's stable source, and each evidence object in it. */
export function packSources(pack: ContextPack): PackSource[] {
  const sources: PackSource[] = [];
  for (const section of pack.sections) {
    const common = { sectionId: section.id, trust: section.trust, disposition: disposition(pack, section) };
    sources.push({ ref: stableProvenanceRef(section.provenanceRef), kind: section.kind, ...common });
    if (section.kind === "evidence") {
      for (const id of evidenceIds(section.value)) sources.push({ ref: `evidence:${id}`, kind: "evidence_object", ...common });
    }
  }
  return sources;
}

export type RecordPackInput = {
  tenantId: string;
  caseId: string | null;
  runId: string;
  nodeId: string;
  attempt: number;
  pack: ContextPack;
  snapshot?: { snapshotId: string; snapshotDigest: string; caseSequence: number } | null;
};

/** Record one pack, its sections, signals and graph links. Idempotent by pack digest. */
export async function recordContextPack(store: ContextStore, input: RecordPackInput): Promise<{ recorded: boolean }> {
  const { pack } = input;
  if (input.pack.runId !== input.runId || input.pack.nodeId !== input.nodeId) throw new ContextStoreError("context.pack_identity_mismatch");
  if (pack.manifest && (pack.manifest.tenantId !== input.tenantId || (input.caseId && pack.manifest.caseId !== input.caseId))) {
    throw new ContextStoreError("context.manifest_scope_mismatch", 403);
  }
  if (!store.packBlobs && store.packBlobRequired) throw new ContextStoreError("context_store.pack_blob_required_in_production", 500);
  // Body first, row second: the same pack always renders to the same bytes, so a retry rewrites
  // nothing, and a crash in between leaves a blob the case's release still deletes.
  let body: { container: string; name: string } | null = null;
  if (store.packBlobs) {
    const bytes = Buffer.from(canonicalJson(pack), "utf8");
    const name = packBlobName(input.tenantId, input.caseId, pack.packDigest);
    await store.packBlobs.putImmutable(name, bytes, { contentType: "application/json", sha256: sha256Hex(bytes) });
    body = { container: `${store.packBlobs.account}/${store.packBlobs.container}`, name };
  }
  return withContextTenant(store, input.tenantId, async (client) => {
    const inserted = await client.query(`
      insert into context.packs(
        tenant_id, pack_digest, case_id, run_id, node_id, attempt, plan_digest, capability_id, agent_id, prompt_digest,
        manifest_digest, manifest, snapshot_id, snapshot_digest, case_sequence, budget, quarantined, pack, pack_container, pack_blob_name)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, $13, $14, $15, $16::jsonb, $17, $18::jsonb, $19, $20)
      on conflict (tenant_id, pack_digest) do nothing
    `, [
      input.tenantId, pack.packDigest, input.caseId, input.runId, input.nodeId, input.attempt, pack.planDigest,
      pack.capabilityId, pack.instructions?.agentId ?? null, pack.instructions?.promptDigest ?? null,
      pack.manifest?.manifestDigest ?? null, pack.manifest ? JSON.stringify(pack.manifest) : null,
      input.snapshot?.snapshotId ?? null, input.snapshot?.snapshotDigest ?? null, input.snapshot?.caseSequence ?? null,
      JSON.stringify(pack.budget), pack.signals.length > 0, body ? null : JSON.stringify(pack), body?.container ?? null, body?.name ?? null,
    ]);
    if (!inserted.rowCount) return { recorded: false };
    for (const section of pack.sections) {
      await client.query(`
        insert into context.pack_sections(tenant_id, pack_digest, section_id, kind, trust, disposition, required,
          classification, purpose, provenance_ref, content_digest)
        values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `, [input.tenantId, pack.packDigest, section.id, section.kind, section.trust, disposition(pack, section), section.required,
        section.classification, section.purpose, section.provenanceRef, section.contentDigest]);
    }
    for (const signal of pack.signals) {
      await client.query(`
        insert into context.quarantine_signals(tenant_id, pack_digest, section_id, signal) values ($1, $2, $3, $4)
        on conflict do nothing
      `, [input.tenantId, pack.packDigest, signal.sectionId, signal.code]);
    }
    await client.query("select context.graph_link_pack($1, $2, $3::jsonb)", [pack.packDigest, input.caseId, JSON.stringify(packSources(pack))]);
    return { recorded: true };
  });
}

/** Every pack of the tenant that drew on `ref`: an evidence id (`evidence:<id>`), a selector or a receipt. */
export async function packsDrawingOn(store: ContextStore, tenantId: string, ref: string) {
  return withContextTenant(store, tenantId, async (client) => (await client.query<{
    pack_digest: string; case_id: string | null; section_id: string; disposition: Disposition;
  }>("select * from context.graph_packs_drawing_on($1) order by pack_digest, section_id", [ref])).rows.map((row) => ({
    packDigest: row.pack_digest, caseId: row.case_id || null, sectionId: row.section_id, disposition: row.disposition,
  })), { readOnly: true });
}

/** Everything one pack drew on, from the provenance graph. */
export async function sourcesOfPack(store: ContextStore, tenantId: string, packDigest: string) {
  return withContextTenant(store, tenantId, async (client) => (await client.query<{
    ref: string; kind: string; section_id: string; disposition: Disposition;
  }>("select * from context.graph_sources_of($1) order by ref, section_id", [packDigest])).rows.map((row) => ({
    ref: row.ref, kind: row.kind, sectionId: row.section_id, disposition: row.disposition,
  })), { readOnly: true });
}

export type KnowledgeMatch = { chunkId: string; sourceKind: string; sourceRef: string; title: string; content: string; metadata: Record<string, unknown>; similarity: number };

/** Tenant-scoped cosine similarity search over the retrieval index. */
export async function searchKnowledge(store: ContextStore, tenantId: string, embedding: number[], topK: number): Promise<KnowledgeMatch[]> {
  const limit = Math.max(1, Math.min(20, Math.trunc(topK)));
  return withContextTenant(store, tenantId, async (client) => (await client.query<{
    chunk_id: string; source_kind: string; source_ref: string; title: string; content: string; metadata: Record<string, unknown>; distance: number;
  }>(`
    select chunk_id, source_kind, source_ref, title, content, metadata, embedding <=> $1::vector as distance
    from context.knowledge_chunks where tenant_id = $2 order by embedding <=> $1::vector limit $3
  `, [JSON.stringify(embedding), tenantId, limit])).rows.map((row) => ({
    chunkId: row.chunk_id, sourceKind: row.source_kind, sourceRef: row.source_ref, title: row.title, content: row.content,
    metadata: row.metadata, similarity: 1 - Number(row.distance),
  })), { readOnly: true });
}

export * from "./document-search.js";
