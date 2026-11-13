import { createHash } from "node:crypto";
import { externalBindingDraftSchema, type ExternalBindingRevision, type ExternalBindingDraft } from "@ehf/contracts";
import type { Database } from "./index.js";
import { ExternalProviderError } from "./external-providers.js";

type Row = { binding_id: string; definition: unknown; revision: number; source_digest: string; digest: string; reason: string; updated_at: Date; updated_by: string };
const record = (row: Row): ExternalBindingRevision => ({ bindingId: row.binding_id, definition: externalBindingDraftSchema.parse(row.definition), revision: row.revision, sourceDigest: row.source_digest, digest: row.digest, reason: row.reason, updatedAt: row.updated_at.toISOString(), updatedBy: row.updated_by });
async function scoped<T>(db: Database, tenantId: string, run: (client: Pick<Database, "query">) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const value = await run(client);
    await client.query("commit");
    return value;
  } catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
  finally { client.release(); }
}
export async function listExternalBindingRevisions(db: Database, tenantId: string): Promise<ExternalBindingRevision[]> {
  return scoped(db, tenantId, async client => (await client.query<Row>(`select distinct on (binding_id) * from harness_admin.external_capability_binding_revisions where tenant_id=$1 order by binding_id, revision desc`, [tenantId])).rows.map(record));
}
export async function externalBindingHistory(db: Database, tenantId: string, bindingId: string): Promise<ExternalBindingRevision[]> {
  return scoped(db, tenantId, async client => (await client.query<Row>(`select * from harness_admin.external_capability_binding_revisions where tenant_id=$1 and binding_id=$2 order by revision desc limit 30`, [tenantId, bindingId])).rows.map(record));
}
export async function saveExternalBindingRevision(db: Database, input: { tenantId: string; bindingId: string; actor: string; definition: ExternalBindingDraft; expectedRevision: number; sourceDigest: string; reason: string }): Promise<ExternalBindingRevision> {
  const definition = externalBindingDraftSchema.parse(input.definition);
  return scoped(db, input.tenantId, async client => {
    // Serialize the first save as well as edits, without requiring a pre-existing row.
    await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [JSON.stringify([input.tenantId, input.bindingId])]);
    const latest = await client.query<{ revision: number }>("select revision from harness_admin.external_capability_binding_revisions where tenant_id=$1 and binding_id=$2 order by revision desc limit 1", [input.tenantId, input.bindingId]);
    const revision = latest.rows[0]?.revision ?? 0;
    if (revision !== input.expectedRevision) throw new ExternalProviderError("external_binding.revision_conflict", 409);
    const digest = createHash("sha256").update(JSON.stringify({ definition, sourceDigest: input.sourceDigest, revision: revision + 1, reason: input.reason, actor: input.actor })).digest("hex");
    const result = await client.query<Row>(`insert into harness_admin.external_capability_binding_revisions (tenant_id,binding_id,revision,definition,source_digest,digest,reason,updated_by) values ($1,$2,$3,$4::jsonb,$5,$6,$7,$8) returning *`, [input.tenantId, input.bindingId, revision + 1, JSON.stringify(definition), input.sourceDigest, digest, input.reason, input.actor]);
    return record(result.rows[0]!);
  });
}
