import { randomUUID } from "node:crypto";
import {
  institutionCatalogSchema, stableDigest,
  type InstitutionCatalog, type InstitutionCatalogRevision, type InstitutionCatalogRevisionSummary,
} from "@ehf/contracts";
import { contextTransaction } from "./context-setup.js";
import type { Database } from "./index.js";

/** Refusals carry the HTTP status the control API answers with. */
export class InstitutionCatalogError extends Error {
  constructor(message: string, readonly httpStatus: number) { super(message); }
}
type Client = Pick<Database, "query">;
type Row = {
  institution_id: string; revision: number; status: InstitutionCatalogRevision["status"]; document: unknown; document_digest: string; taxonomy_digest: string;
  problems: string[]; reason: string; authored_by: string; authored_at: Date; approved_by: string | null; approved_at: Date | null; published_by: string | null; published_at: Date | null;
};
const iso = (value: Date | null) => value ? value.toISOString() : null;
const summary = (row: Row): InstitutionCatalogRevisionSummary => ({
  institutionId: row.institution_id, revision: row.revision, status: row.status, digest: row.document_digest, taxonomyDigest: row.taxonomy_digest,
  problems: row.problems, reason: row.reason, authoredBy: row.authored_by, authoredAt: row.authored_at.toISOString(),
  approvedBy: row.approved_by, approvedAt: iso(row.approved_at), publishedBy: row.published_by, publishedAt: iso(row.published_at),
});
const full = (row: Row): InstitutionCatalogRevision => ({ ...summary(row), catalog: institutionCatalogSchema.parse(row.document) });
const scope = (tenantId: string) => ({ tenantId, environment: "platform" });
const lock = (client: Client, tenantId: string, institutionId: string) =>
  client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`institution-catalog:${tenantId}:${institutionId}`]);
const event = (client: Client, tenantId: string, row: Pick<Row, "institution_id" | "revision">, type: string, actor: string, reason: string) =>
  client.query("insert into harness_admin.institution_catalog_events(tenant_id,event_id,institution_id,revision,event_type,actor_id,reason) values($1,$2,$3,$4,$5,$6,$7)",
    [tenantId, randomUUID(), row.institution_id, row.revision, type, actor, reason]);

/** Institutions this tenant has catalog revisions for, with their latest and published revisions. */
export async function listInstitutionCatalogs(db: Database, tenantId: string): Promise<Array<{ institutionId: string; latest: InstitutionCatalogRevisionSummary; published: InstitutionCatalogRevisionSummary | null }>> {
  return contextTransaction(db, scope(tenantId), async (client) => {
    const rows = (await client.query<Row>("select * from harness_admin.institution_catalog_revisions where tenant_id=$1 order by institution_id, revision desc", [tenantId])).rows;
    const byInstitution = new Map<string, Row[]>();
    for (const row of rows) byInstitution.set(row.institution_id, [...(byInstitution.get(row.institution_id) ?? []), row]);
    return [...byInstitution].map(([institutionId, revisions]) => {
      const published = revisions.find((row) => row.status === "PUBLISHED");
      return { institutionId, latest: summary(revisions[0]!), published: published ? summary(published) : null };
    });
  });
}

export async function listInstitutionCatalogRevisions(db: Database, tenantId: string, institutionId: string): Promise<InstitutionCatalogRevisionSummary[]> {
  return contextTransaction(db, scope(tenantId), async (client) => (await client.query<Row>(
    "select * from harness_admin.institution_catalog_revisions where tenant_id=$1 and institution_id=$2 order by revision desc", [tenantId, institutionId],
  )).rows.map(summary));
}

export async function getInstitutionCatalogRevision(db: Database, tenantId: string, institutionId: string, revision: number | "latest" | "published"): Promise<InstitutionCatalogRevision | null> {
  return contextTransaction(db, scope(tenantId), async (client) => {
    const where = revision === "latest" ? "order by revision desc limit 1" : revision === "published" ? "and status='PUBLISHED'" : "and revision=$3";
    const row = (await client.query<Row>(`select * from harness_admin.institution_catalog_revisions where tenant_id=$1 and institution_id=$2 ${where}`,
      typeof revision === "number" ? [tenantId, institutionId, revision] : [tenantId, institutionId])).rows[0];
    return row ? full(row) : null;
  });
}

/**
 * Save a new DRAFT revision. The author names the revision they started from, so a concurrent
 * save is refused rather than overwritten; any unpublished revision before it is superseded.
 * Problems are computed by the caller against the current taxonomy and stored with the draft.
 */
export async function createInstitutionCatalogRevision(db: Database, input: {
  tenantId: string; actor: string; catalog: InstitutionCatalog; expectedRevision: number; reason: string; problems: string[];
}): Promise<InstitutionCatalogRevision> {
  const catalog = institutionCatalogSchema.parse(input.catalog);
  const institutionId = catalog.institution.id;
  return contextTransaction(db, scope(input.tenantId), async (client) => {
    await lock(client, input.tenantId, institutionId);
    const latest = (await client.query<{ revision: number }>("select max(revision) as revision from harness_admin.institution_catalog_revisions where tenant_id=$1 and institution_id=$2",
      [input.tenantId, institutionId])).rows[0]?.revision ?? 0;
    if (latest !== input.expectedRevision) throw new InstitutionCatalogError("institution.revision_conflict", 409);
    const superseded = (await client.query<Row>("update harness_admin.institution_catalog_revisions set status='SUPERSEDED' where tenant_id=$1 and institution_id=$2 and status in ('DRAFT','APPROVED') returning *",
      [input.tenantId, institutionId])).rows;
    for (const row of superseded) await event(client, input.tenantId, row, "SUPERSEDED", input.actor, `Superseded by revision ${latest + 1}`);
    const row = (await client.query<Row>(
      "insert into harness_admin.institution_catalog_revisions(tenant_id,institution_id,revision,status,document,document_digest,taxonomy_digest,problems,reason,authored_by) values($1,$2,$3,'DRAFT',$4::jsonb,$5,$6,$7::jsonb,$8,$9) returning *",
      [input.tenantId, institutionId, latest + 1, JSON.stringify(catalog), stableDigest(catalog), catalog.taxonomy.digest, JSON.stringify(input.problems), input.reason, input.actor],
    )).rows[0]!;
    await event(client, input.tenantId, row, "CREATED", input.actor, input.reason);
    return full(row);
  });
}

async function current(client: Client, tenantId: string, institutionId: string, revision: number): Promise<Row> {
  const row = (await client.query<Row>("select * from harness_admin.institution_catalog_revisions where tenant_id=$1 and institution_id=$2 and revision=$3 for update",
    [tenantId, institutionId, revision])).rows[0];
  if (!row) throw new InstitutionCatalogError("institution.revision_not_found", 404);
  return row;
}

/**
 * Approve a DRAFT. A second person must approve, and the caller rechecks problems against the
 * current taxonomy at approval time: a catalog with problems cannot be approved.
 */
export async function approveInstitutionCatalogRevision(db: Database, input: {
  tenantId: string; actor: string; institutionId: string; revision: number; reason: string; problems: string[];
}): Promise<InstitutionCatalogRevision> {
  return contextTransaction(db, scope(input.tenantId), async (client) => {
    await lock(client, input.tenantId, input.institutionId);
    const row = await current(client, input.tenantId, input.institutionId, input.revision);
    if (row.status !== "DRAFT") throw new InstitutionCatalogError("institution.revision_not_draft", 409);
    if (row.authored_by === input.actor) throw new InstitutionCatalogError("institution.approver_is_author", 403);
    if (input.problems.length) throw new InstitutionCatalogError("institution.problems_unresolved", 409);
    const approved = (await client.query<Row>(
      "update harness_admin.institution_catalog_revisions set status='APPROVED',problems='[]'::jsonb,approved_by=$4,approved_at=now() where tenant_id=$1 and institution_id=$2 and revision=$3 returning *",
      [input.tenantId, input.institutionId, input.revision, input.actor])).rows[0]!;
    await event(client, input.tenantId, approved, "APPROVED", input.actor, input.reason);
    return full(approved);
  });
}

/** Publish an APPROVED revision; the previously published revision is superseded atomically. */
export async function publishInstitutionCatalogRevision(db: Database, input: {
  tenantId: string; actor: string; institutionId: string; revision: number; reason: string;
}): Promise<InstitutionCatalogRevision> {
  return contextTransaction(db, scope(input.tenantId), async (client) => {
    await lock(client, input.tenantId, input.institutionId);
    const row = await current(client, input.tenantId, input.institutionId, input.revision);
    if (row.status !== "APPROVED") throw new InstitutionCatalogError("institution.revision_not_approved", 409);
    if (row.authored_by === input.actor) throw new InstitutionCatalogError("institution.publisher_is_author", 403);
    const previous = (await client.query<Row>("update harness_admin.institution_catalog_revisions set status='SUPERSEDED' where tenant_id=$1 and institution_id=$2 and status='PUBLISHED' returning *",
      [input.tenantId, input.institutionId])).rows;
    for (const old of previous) await event(client, input.tenantId, old, "SUPERSEDED", input.actor, `Superseded by revision ${input.revision}`);
    const published = (await client.query<Row>(
      "update harness_admin.institution_catalog_revisions set status='PUBLISHED',published_by=$4,published_at=now() where tenant_id=$1 and institution_id=$2 and revision=$3 returning *",
      [input.tenantId, input.institutionId, input.revision, input.actor])).rows[0]!;
    await event(client, input.tenantId, published, "PUBLISHED", input.actor, input.reason);
    return full(published);
  });
}
