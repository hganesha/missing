import { randomUUID } from "node:crypto";
import { stableDigest } from "@ehf/contracts";
import { contextTransaction } from "./context-setup.js";
import type { Database } from "./index.js";

/**
 * Policy pack layers edited in the studio (phase H): revisions of one layer, saved as drafts,
 * approved by a second person once composing every pack with them raises no problem, and published.
 * The caller validates the layer document (policyPackLayerSchema) and computes its problems; a
 * published revision replaces the repository's layer for the tenant.
 */
export class PackLayerRevisionError extends Error {
  constructor(message: string, readonly httpStatus: number) { super(message); }
}
export type PackLayerRevisionSummary = {
  layerId: string; revision: number; status: "DRAFT" | "APPROVED" | "PUBLISHED" | "SUPERSEDED"; digest: string; problems: string[]; reason: string;
  authoredBy: string; authoredAt: string; approvedBy: string | null; approvedAt: string | null; publishedBy: string | null; publishedAt: string | null;
};
export type PackLayerRevision = PackLayerRevisionSummary & { layer: Record<string, unknown> };

type Client = Pick<Database, "query">;
type Row = {
  layer_id: string; revision: number; status: PackLayerRevisionSummary["status"]; document: Record<string, unknown>; document_digest: string;
  problems: string[]; reason: string; authored_by: string; authored_at: Date; approved_by: string | null; approved_at: Date | null; published_by: string | null; published_at: Date | null;
};
const iso = (value: Date | null) => value ? value.toISOString() : null;
const summary = (row: Row): PackLayerRevisionSummary => ({
  layerId: row.layer_id, revision: row.revision, status: row.status, digest: row.document_digest, problems: row.problems, reason: row.reason,
  authoredBy: row.authored_by, authoredAt: row.authored_at.toISOString(), approvedBy: row.approved_by, approvedAt: iso(row.approved_at),
  publishedBy: row.published_by, publishedAt: iso(row.published_at),
});
const full = (row: Row): PackLayerRevision => ({ ...summary(row), layer: row.document });
const scope = (tenantId: string) => ({ tenantId, environment: "platform" });
const lock = (client: Client, tenantId: string, layerId: string) =>
  client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`policy-pack-layer:${tenantId}:${layerId}`]);
const event = (client: Client, tenantId: string, row: Pick<Row, "layer_id" | "revision">, type: string, actor: string, reason: string) =>
  client.query("insert into harness_admin.policy_pack_layer_events(tenant_id,event_id,layer_id,revision,event_type,actor_id,reason) values($1,$2,$3,$4,$5,$6,$7)",
    [tenantId, randomUUID(), row.layer_id, row.revision, type, actor, reason]);

/** Layers this tenant has revisions for, with their latest and published revisions. */
export async function listPackLayerRevisionHeads(db: Database, tenantId: string): Promise<Array<{ layerId: string; latest: PackLayerRevisionSummary; published: PackLayerRevision | null }>> {
  return contextTransaction(db, scope(tenantId), async (client) => {
    const rows = (await client.query<Row>("select * from harness_admin.policy_pack_layer_revisions where tenant_id=$1 order by layer_id, revision desc", [tenantId])).rows;
    const byLayer = new Map<string, Row[]>();
    for (const row of rows) byLayer.set(row.layer_id, [...(byLayer.get(row.layer_id) ?? []), row]);
    return [...byLayer].map(([layerId, revisions]) => {
      const published = revisions.find((row) => row.status === "PUBLISHED");
      return { layerId, latest: summary(revisions[0]!), published: published ? full(published) : null };
    });
  });
}

export async function listPackLayerRevisions(db: Database, tenantId: string, layerId: string): Promise<PackLayerRevision[]> {
  return contextTransaction(db, scope(tenantId), async (client) => (await client.query<Row>(
    "select * from harness_admin.policy_pack_layer_revisions where tenant_id=$1 and layer_id=$2 order by revision desc", [tenantId, layerId],
  )).rows.map(full));
}

/** Save a DRAFT; the author names the revision they started from, so a concurrent save is refused. */
export async function createPackLayerRevision(db: Database, input: {
  tenantId: string; actor: string; layerId: string; layer: Record<string, unknown>; expectedRevision: number; reason: string; problems: string[];
}): Promise<PackLayerRevision> {
  if (input.reason.trim().length < 3) throw new PackLayerRevisionError("pack_layer.reason_required", 400);
  return contextTransaction(db, scope(input.tenantId), async (client) => {
    await lock(client, input.tenantId, input.layerId);
    const latest = (await client.query<{ revision: number }>("select max(revision) as revision from harness_admin.policy_pack_layer_revisions where tenant_id=$1 and layer_id=$2",
      [input.tenantId, input.layerId])).rows[0]?.revision ?? 0;
    if (latest !== input.expectedRevision) throw new PackLayerRevisionError("pack_layer.revision_conflict", 409);
    const superseded = (await client.query<Row>("update harness_admin.policy_pack_layer_revisions set status='SUPERSEDED' where tenant_id=$1 and layer_id=$2 and status in ('DRAFT','APPROVED') returning *",
      [input.tenantId, input.layerId])).rows;
    for (const row of superseded) await event(client, input.tenantId, row, "SUPERSEDED", input.actor, `Superseded by revision ${latest + 1}`);
    const row = (await client.query<Row>(
      "insert into harness_admin.policy_pack_layer_revisions(tenant_id,layer_id,revision,status,document,document_digest,problems,reason,authored_by) values($1,$2,$3,'DRAFT',$4::jsonb,$5,$6::jsonb,$7,$8) returning *",
      [input.tenantId, input.layerId, latest + 1, JSON.stringify(input.layer), stableDigest(input.layer), JSON.stringify(input.problems), input.reason.trim(), input.actor],
    )).rows[0]!;
    await event(client, input.tenantId, row, "CREATED", input.actor, input.reason.trim());
    return full(row);
  });
}

async function current(client: Client, tenantId: string, layerId: string, revision: number): Promise<Row> {
  const row = (await client.query<Row>("select * from harness_admin.policy_pack_layer_revisions where tenant_id=$1 and layer_id=$2 and revision=$3 for update",
    [tenantId, layerId, revision])).rows[0];
  if (!row) throw new PackLayerRevisionError("pack_layer.revision_not_found", 404);
  return row;
}

/** Approve a DRAFT: a second person, and no problems when composed against the layers as they are now. */
export async function approvePackLayerRevision(db: Database, input: {
  tenantId: string; actor: string; layerId: string; revision: number; reason: string; problems: string[];
}): Promise<PackLayerRevision> {
  return contextTransaction(db, scope(input.tenantId), async (client) => {
    await lock(client, input.tenantId, input.layerId);
    const row = await current(client, input.tenantId, input.layerId, input.revision);
    if (row.status !== "DRAFT") throw new PackLayerRevisionError("pack_layer.revision_not_draft", 409);
    if (row.authored_by === input.actor) throw new PackLayerRevisionError("pack_layer.approver_is_author", 403);
    if (input.problems.length) throw new PackLayerRevisionError("pack_layer.problems_unresolved", 409);
    const approved = (await client.query<Row>(
      "update harness_admin.policy_pack_layer_revisions set status='APPROVED',problems='[]'::jsonb,approved_by=$4,approved_at=now() where tenant_id=$1 and layer_id=$2 and revision=$3 returning *",
      [input.tenantId, input.layerId, input.revision, input.actor])).rows[0]!;
    await event(client, input.tenantId, approved, "APPROVED", input.actor, input.reason);
    return full(approved);
  });
}

/** Publish an APPROVED revision; the previously published one is superseded atomically. */
export async function publishPackLayerRevision(db: Database, input: {
  tenantId: string; actor: string; layerId: string; revision: number; reason: string;
}): Promise<PackLayerRevision> {
  return contextTransaction(db, scope(input.tenantId), async (client) => {
    await lock(client, input.tenantId, input.layerId);
    const row = await current(client, input.tenantId, input.layerId, input.revision);
    if (row.status !== "APPROVED") throw new PackLayerRevisionError("pack_layer.revision_not_approved", 409);
    if (row.authored_by === input.actor) throw new PackLayerRevisionError("pack_layer.publisher_is_author", 403);
    const previous = (await client.query<Row>("update harness_admin.policy_pack_layer_revisions set status='SUPERSEDED' where tenant_id=$1 and layer_id=$2 and status='PUBLISHED' returning *",
      [input.tenantId, input.layerId])).rows;
    for (const old of previous) await event(client, input.tenantId, old, "SUPERSEDED", input.actor, `Superseded by revision ${input.revision}`);
    const published = (await client.query<Row>(
      "update harness_admin.policy_pack_layer_revisions set status='PUBLISHED',published_by=$4,published_at=now() where tenant_id=$1 and layer_id=$2 and revision=$3 returning *",
      [input.tenantId, input.layerId, input.revision, input.actor])).rows[0]!;
    await event(client, input.tenantId, published, "PUBLISHED", input.actor, input.reason);
    return full(published);
  });
}
