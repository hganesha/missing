import { intelligenceDefinitionSchema, intelligenceSaveSchema, stableDigest, type IntelligenceRecord, type IntelligenceActivity, type IntelligenceCheckReport, type IntelligenceCheck } from "@ehf/contracts";
import type { Database } from "./index.js";

type Scope = { tenantId: string; environment: string };
type Row = { definition: unknown; revision: number; digest: string; created_at: Date; created_by: string; reason: string };
export class IntelligenceError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
const record = (row: Row): IntelligenceRecord => ({ definition: intelligenceDefinitionSchema.parse(row.definition), revision: row.revision, digest: row.digest, createdAt: row.created_at.toISOString(), createdBy: row.created_by, reason: row.reason });
async function scoped<T>(db: Database, scope: Scope, operation: (client: Pick<Database, "query">) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [scope.tenantId]);
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
export async function intelligenceCandidates(db: Database, scope: Scope): Promise<{ candidates: IntelligenceRecord[]; history: IntelligenceRecord[]; activity: IntelligenceActivity[]; reports: IntelligenceCheckReport[] }> {
  return scoped(db, scope, async client => {
    const params = [scope.tenantId, scope.environment];
    const rows = await client.query<Row & { position: number }>(`select * from (
      select r.*, row_number() over (partition by r.binding_id order by r.revision desc) as position
      from harness_admin.intelligence_binding_revisions r where tenant_id=$1 and environment=$2
    ) recent where position <= 10 order by binding_id, revision desc limit 10001`, params);
    if (rows.rows.length > 10000) throw new IntelligenceError("intelligence.inventory_limit", 503);
    const events = await client.query<{ binding_id: string; revision: number; action: string; actor: string; reason: string; created_at: Date }>("select * from harness_admin.intelligence_events where tenant_id=$1 and environment=$2 order by event_id desc limit 100", params);
    const checks = await client.query<{ report: IntelligenceCheckReport }>(`select distinct on (binding_id) report from harness_admin.intelligence_configuration_checks
      where tenant_id=$1 and environment=$2 order by binding_id, check_id desc`, params);
    return {
      candidates: rows.rows.filter(row => Number(row.position) === 1).map(record), history: rows.rows.map(record),
      activity: events.rows.map(row => ({ bindingId: row.binding_id, revision: row.revision, action: row.action, actor: row.actor, reason: row.reason, at: row.created_at.toISOString() })),
      reports: checks.rows.map(row => row.report),
    };
  });
}
export async function saveIntelligenceCandidate(db: Database, input: Scope & { actor: string; body: unknown }): Promise<IntelligenceRecord> {
  const { definition, expectedRevision, reason } = intelligenceSaveSchema.parse(input.body);
  return scoped(db, input, async client => {
    if (definition.serviceClass === "reasoning" && definition.configuration.profileId) {
      const profile = await client.query("select profile_id from harness_admin.model_profile_revisions where tenant_id=$1 and profile_id=$2 limit 1", [input.tenantId, definition.configuration.profileId]);
      if (!profile.rowCount) throw new IntelligenceError("intelligence.profile_not_found", 400);
    }
    const params = [input.tenantId, input.environment, definition.id];
    if (expectedRevision === null) {
      const head = await client.query("insert into harness_admin.intelligence_binding_heads(tenant_id,environment,binding_id,revision) values ($1,$2,$3,1) on conflict do nothing returning revision", params);
      if (!head.rowCount) throw new IntelligenceError("intelligence.revision_conflict", 409);
    } else {
      const head = await client.query("update harness_admin.intelligence_binding_heads set revision=revision+1 where tenant_id=$1 and environment=$2 and binding_id=$3 and revision=$4 returning revision", [...params, expectedRevision]);
      if (!head.rowCount) throw new IntelligenceError("intelligence.revision_conflict", 409);
    }
    const revision = (expectedRevision ?? 0) + 1;
    const result = await client.query<Row>(`insert into harness_admin.intelligence_binding_revisions(tenant_id,environment,binding_id,revision,definition,digest,created_by,reason)
      values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) returning *`, [...params, revision, JSON.stringify(definition), stableDigest(definition), input.actor, reason]);
    await client.query("insert into harness_admin.intelligence_events(tenant_id,environment,binding_id,revision,action,actor,reason) values ($1,$2,$3,$4,$5,$6,$7)", [...params, revision, expectedRevision === null ? "candidate.created" : "candidate.revised", input.actor, reason]);
    return record(result.rows[0]!);
  });
}
export async function checkIntelligenceCandidate(db: Database, input: Scope & { bindingId: string; expectedRevision: number; actor: string; evaluate: (definition: IntelligenceRecord["definition"]) => IntelligenceCheck[] }): Promise<IntelligenceCheckReport> {
  return scoped(db, input, async client => {
    const params = [input.tenantId, input.environment, input.bindingId];
    const head = await client.query<{ revision: number }>("select revision from harness_admin.intelligence_binding_heads where tenant_id=$1 and environment=$2 and binding_id=$3 for update", params);
    if (!head.rowCount) throw new IntelligenceError("intelligence.not_found", 404);
    if (head.rows[0]!.revision !== input.expectedRevision) throw new IntelligenceError("intelligence.revision_conflict", 409);
    const result = await client.query<Row>("select * from harness_admin.intelligence_binding_revisions where tenant_id=$1 and environment=$2 and binding_id=$3 and revision=$4", [...params, input.expectedRevision]);
    const candidate = record(result.rows[0]!);
    const report: IntelligenceCheckReport = { bindingId: input.bindingId, revision: candidate.revision, digest: candidate.digest, checkedAt: new Date().toISOString(), checkedBy: input.actor, checks: input.evaluate(candidate.definition), executionVerified: false };
    await client.query("insert into harness_admin.intelligence_configuration_checks(tenant_id,environment,binding_id,revision,report) values ($1,$2,$3,$4,$5::jsonb)", [...params, candidate.revision, JSON.stringify(report)]);
    await client.query("insert into harness_admin.intelligence_events(tenant_id,environment,binding_id,revision,action,actor,reason) values ($1,$2,$3,$4,'configuration.checked',$5,$6)", [...params, candidate.revision, input.actor, "Offline configuration checks; execution remains unverified"]);
    return report;
  });
}
