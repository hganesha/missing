import { contextDefinitionSchema } from "@ehf/contracts/context-setup";
import {
  ContextSetupError,
  stableDigest,
  type ContextDefinition,
  type ContextDefinitionRevision,
  type ContextSampleReport,
} from "@ehf/contracts";
import type { Database } from "./index.js";
export { ContextSetupError } from "@ehf/contracts";
export type ContextScope = { tenantId: string; environment: string };
export async function contextTransaction<T>(
  db: Database,
  scope: ContextScope,
  operation: (client: Pick<Database, "query">) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id',$1,true)", [
      scope.tenantId,
    ]);
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
type Row = {
  definition: unknown;
  revision: number;
  digest: string;
  created_by: string;
  created_at: Date;
};
const revision = (r: Row): ContextDefinitionRevision => ({
  definition: contextDefinitionSchema.parse(r.definition),
  revision: r.revision,
  digest: r.digest,
  createdBy: r.created_by,
  createdAt: r.created_at.toISOString(),
});
export async function listContextDefinitions(
  db: Database,
  scope: ContextScope,
) {
  return contextTransaction(db, scope, async (c) => {
    const rows = await c.query<Row>(
      `select distinct on(kind,id) * from harness_control.context_revisions where tenant_id=$1 and environment=$2 order by kind,id,revision desc limit 1001`,
      [scope.tenantId, scope.environment],
    );
    if (rows.rows.length > 1000)
      throw new ContextSetupError("context.inventory_limit", 503);
    return rows.rows.map(revision);
  });
}
export async function getContextDefinition(
  db: Database,
  scope: ContextScope,
  kind: ContextDefinition["kind"],
  id: string,
  expectedDigest?: string,
) {
  return contextTransaction(db, scope, async (c) => {
    const r = await c.query<Row>(
      "select * from harness_control.context_revisions where tenant_id=$1 and environment=$2 and kind=$3 and id=$4 and ($5::text is null or digest=$5) order by revision desc limit 1",
      [scope.tenantId, scope.environment, kind, id, expectedDigest ?? null],
    );
    return r.rows[0] ? revision(r.rows[0]) : null;
  });
}
export async function saveContextDefinition(
  db: Database,
  scope: ContextScope,
  input: {
    definition: ContextDefinition;
    expectedRevision: number;
    reason: string;
    actor: string;
  },
) {
  return contextTransaction(db, scope, async (c) => {
    const d = contextDefinitionSchema.parse(input.definition);
    const p = [scope.tenantId, scope.environment, d.kind, d.id];
    await c.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify(p),
    ]);
    const head = await c.query<{ revision: number }>(
      "select revision from harness_control.context_revisions where tenant_id=$1 and environment=$2 and kind=$3 and id=$4 order by revision desc limit 1",
      p,
    );
    if ((head.rows[0]?.revision ?? 0) !== input.expectedRevision)
      throw new ContextSetupError("context.revision_conflict", 409);
    const r = await c.query<Row>(
      `insert into harness_control.context_revisions(tenant_id,environment,kind,id,revision,digest,definition,reason,created_by) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) returning *`,
      [
        ...p,
        input.expectedRevision + 1,
        stableDigest(d),
        JSON.stringify(d),
        input.reason,
        input.actor,
      ],
    );
    return revision(r.rows[0]!);
  });
}
export async function saveContextSample(
  db: Database,
  scope: ContextScope,
  report: ContextSampleReport,
) {
  return contextTransaction(db, scope, async (c) => {
    await c.query(
      "insert into harness_control.context_samples(tenant_id,environment,id,mapping_id,report,digest,created_by,expires_at) values($1,$2,$3,$4,$5::jsonb,$6,$7,$8)",
      [
        scope.tenantId,
        scope.environment,
        report.id,
        report.mappingId,
        JSON.stringify(report),
        stableDigest(report),
        report.actor,
        report.expiresAt,
      ],
    );
    return report;
  });
}
export async function getContextSample(
  db: Database,
  scope: ContextScope,
  id: string,
) {
  return contextTransaction(db, scope, async (c) => {
    const r = await c.query<{ report: ContextSampleReport; digest: string }>(
      "select report,digest from harness_control.context_samples where tenant_id=$1 and environment=$2 and id=$3 and expires_at>now()",
      [scope.tenantId, scope.environment, id],
    );
    const row = r.rows[0];
    if (!row)
      throw new ContextSetupError("context.sample_not_found_or_expired", 404);
    if (stableDigest(row.report) !== row.digest)
      throw new ContextSetupError("context.sample_integrity_invalid", 409);
    return row.report;
  });
}
export type ContextEnablement = {
  mappingId: string;
  revision: number;
  mappingDigest: string;
  reportId: string;
  reportDigest: string;
  authority: NonNullable<ContextSampleReport["authority"]>;
  paused: boolean;
  enabledBy: string;
};
export async function getContextEnablement(
  db: Database,
  scope: ContextScope,
  mappingId: string,
) {
  return contextTransaction(db, scope, async (c) => {
    const r = await c.query<{
      mapping_id: string;
      revision: number;
      mapping_digest: string;
      report_id: string;
      report_digest: string;
      authority: ContextEnablement["authority"];
      paused: boolean;
      enabled_by: string;
    }>(
      "select * from harness_control.context_enablements where tenant_id=$1 and environment=$2 and mapping_id=$3 order by revision desc limit 1",
      [scope.tenantId, scope.environment, mappingId],
    );
    const row = r.rows[0];
    return row
      ? {
          mappingId: row.mapping_id,
          revision: row.revision,
          mappingDigest: row.mapping_digest,
          reportId: row.report_id,
          reportDigest: row.report_digest,
          authority: row.authority,
          paused: row.paused,
          enabledBy: row.enabled_by,
        }
      : null;
  });
}
export async function activateContextMapping(
  db: Database,
  scope: ContextScope,
  input: {
    mappingId: string;
    mappingDigest: string;
    report: ContextSampleReport;
    expectedRevision: number;
    actor: string;
    artifactDigests: string[];
    authorize: () => Promise<void>;
  },
) {
  return contextTransaction(db, scope, async (c) => {
    const params = [scope.tenantId, scope.environment, input.mappingId];
    await c.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify([...params, "enable"]),
    ]);
    const rows = await c.query<{ revision: number }>(
      "select revision from harness_control.context_enablements where tenant_id=$1 and environment=$2 and mapping_id=$3 order by revision desc limit 1",
      params,
    );
    if ((rows.rows[0]?.revision ?? 0) !== input.expectedRevision)
      throw new ContextSetupError("context.enablement_revision_conflict", 409);
    // The same advisory locks as draft saves close the test/activate revision race.
    const expected = [["mapping", input.mappingId, input.mappingDigest]];
    for (let index = 0; index < expected.length; index++) {
      const [kind, id, digest] = expected[index]!;
      await c.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
        JSON.stringify([scope.tenantId, scope.environment, kind, id]),
      ]);
      const row = await c.query<{
        digest: string;
        definition: ContextDefinition;
      }>(
        `select digest,definition from harness_control.context_revisions where tenant_id=$1 and environment=$2 and kind=$3 and id=$4 order by revision desc limit 1`,
        [scope.tenantId, scope.environment, kind, id],
      );
      const current = row.rows[0];
      if (!current || current.digest !== digest)
        throw new ContextSetupError("context.qualification_changed", 409);
      if (current.definition.kind === "mapping")
        expected.push([
          "resource",
          current.definition.resourceId,
          input.report.resourceDigest,
        ]);
      if (current.definition.kind === "resource")
        expected.push([
          "connection",
          current.definition.connectionId,
          input.report.connectionDigest,
        ]);
    }
    // Hold approvals against revocation for the duration of this activation transaction.
    if (input.artifactDigests.length)
      await c.query(
        "select digest from harness_control.artifact_registry where tenant_id=$1 and digest=any($2::text[]) for share",
        [scope.tenantId, input.artifactDigests],
      );
    await c.query(
      "select release_id from harness_control.release_manifests where tenant_id=$1 and plan_digest=$2 for share",
      [
        scope.tenantId,
        input.report.authority?.planDigest.replace(/^sha256:/, "") ?? "",
      ],
    );
    await input.authorize();
    if (
      Date.parse(input.report.expiresAt) <= Date.now() ||
      input.report.origin !== "live" ||
      input.report.issues.length ||
      !input.report.counts.candidates ||
      !input.report.authority
    )
      throw new ContextSetupError("context.sample_not_qualified", 409);
    await c.query(
      `insert into harness_control.context_enablements(tenant_id,environment,mapping_id,revision,mapping_digest,report_id,report_digest,authority,enabled_by) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)`,
      [
        ...params,
        input.expectedRevision + 1,
        input.mappingDigest,
        input.report.id,
        stableDigest(input.report),
        JSON.stringify(input.report.authority),
        input.actor,
      ],
    );
    return {
      mappingId: input.mappingId,
      revision: input.expectedRevision + 1,
      mappingDigest: input.mappingDigest,
      status: "enabled",
    };
  });
}
export async function pauseContextMapping(
  db: Database,
  scope: ContextScope,
  mappingId: string,
  revision: number,
  actor: string,
) {
  return contextTransaction(db, scope, async (c) => {
    const r = await c.query(
      "update harness_control.context_enablements set paused=true,paused_by=$5,paused_at=now() where not paused and tenant_id=$1 and environment=$2 and mapping_id=$3 and revision=$4 and revision=(select max(revision) from harness_control.context_enablements where tenant_id=$1 and environment=$2 and mapping_id=$3)",
      [scope.tenantId, scope.environment, mappingId, revision, actor],
    );
    if (!r.rowCount)
      throw new ContextSetupError("context.enablement_revision_conflict", 409);
    return { status: "paused" };
  });
}

/** History exposes metadata only; sample content is read through its protected report route. */
export async function listContextSampleHistory(
  db: Database,
  scope: ContextScope,
  mappingId: string,
  actor: string,
) {
  return contextTransaction(db, scope, async (c) => {
    const result = await c.query<{
      id: string;
      origin: string;
      mappingDigest: string;
      createdAt: string;
      counts: ContextSampleReport["counts"];
    }>(
      `select id,report->>'origin' as origin,report->>'mappingDigest' as "mappingDigest",report->>'createdAt' as "createdAt",report->'counts' as counts from harness_control.context_samples where tenant_id=$1 and environment=$2 and mapping_id=$3 and created_by=$4 and expires_at>now() order by report->>'createdAt' desc,id desc limit 20`,
      [scope.tenantId, scope.environment, mappingId, actor],
    );
    return result.rows;
  });
}
