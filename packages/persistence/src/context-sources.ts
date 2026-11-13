import {
  contextConnectionSaveSchema,
  contextBindingSaveSchema,
  contextConnectionSchema,
  contextBindingSchema,
  contextCheckSchema,
  contextActivationSchema,
  contextRefreshSaveSchema,
  stableDigest,
  connectorRegistrationSchema,
  type ContextRevision,
  type ContextConnection,
  type ContextBinding,
  type ContextSourceIndex,
  type ContextCheck,
} from "@ehf/contracts";
import type { Database } from "./index.js";

export class ContextSourceError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}
type Client = Pick<Database, "query">;
type Row = {
  definition: unknown;
  revision: number;
  digest: string;
  actor: string;
  created_at: Date;
  active_revision: number | null;
  disabled: boolean;
  kind: string;
};
const record = <T>(
  row: Row,
  parse: (value: unknown) => T,
): ContextRevision<T> => ({
  definition: parse(row.definition),
  revision: row.revision,
  digest: row.digest,
  actor: row.actor,
  createdAt: row.created_at.toISOString(),
});
async function scoped<T>(
  db: Database,
  tenantId: string,
  action: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id',$1,true)", [
      tenantId,
    ]);
    const result = await action(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
export async function contextSourceIndex(
  db: Database,
  tenantId: string,
): Promise<Omit<ContextSourceIndex, "canonicalTypes">> {
  return scoped(db, tenantId, async (client) => {
    const rows = await client.query<Row>(
      `select r.*,h.active_revision,h.disabled from harness_admin.context_source_revisions r
      join harness_admin.context_source_heads h using (tenant_id,kind,source_id)
      where r.tenant_id=$1 and (r.kind='connection' or r.revision=h.revision) order by source_id,revision desc limit 2001`,
      [tenantId],
    );
    if (rows.rows.length > 2000)
      throw new ContextSourceError("context_source.inventory_limit", 503);
    const checks = await client.query<{ report: unknown }>(
      "select report from harness_admin.context_source_checks where tenant_id=$1 order by created_at desc limit 200",
      [tenantId],
    );
    const refreshes = await client.query<{
      binding_id: string;
      revision: number;
      enabled: boolean;
      due_at: Date;
      run_id: string | null;
      last_success_at: Date | null;
      last_error: string | null;
      failures: number;
    }>(
      "select binding_id,revision,enabled,due_at,run_id,last_success_at,last_error,failures from integration.context_refresh_jobs where tenant_id=$1 order by binding_id limit 2000",
      [tenantId],
    );
    return {
      refreshes: refreshes.rows.map((r) => ({
        bindingId: r.binding_id,
        revision: r.revision,
        enabled: r.enabled,
        dueAt: r.due_at.toISOString(),
        runId: r.run_id,
        lastSuccessAt: r.last_success_at?.toISOString() ?? null,
        lastError: r.last_error,
        failures: r.failures,
      })),
      connections: rows.rows
        .filter((r) => r.kind === "connection")
        .map((r) => record(r, contextConnectionSchema.parse)),
      bindings: rows.rows
        .filter((r) => r.kind === "binding")
        .map((r) => ({
          ...record(r, contextBindingSchema.parse),
          activeRevision: r.active_revision,
          disabled: r.disabled,
          connectorId: contextConnectorId(
            tenantId,
            contextBindingSchema.parse(r.definition).id,
            r.revision,
          ),
        })),
      checks: checks.rows.map((r) => contextCheckSchema.parse(r.report)),
    };
  });
}
export async function saveContextSource(
  db: Database,
  input: {
    tenantId: string;
    actor: string;
    kind: "connection" | "binding";
    body: unknown;
  },
): Promise<ContextRevision<ContextConnection | ContextBinding>> {
  const parsed = (
    input.kind === "connection"
      ? contextConnectionSaveSchema
      : contextBindingSaveSchema
  ).safeParse(input.body);
  if (!parsed.success)
    throw new ContextSourceError("context_source.configuration_invalid", 400);
  const { definition, expectedRevision } = parsed.data;
  return scoped(db, input.tenantId, async (client) => {
    if (input.kind === "binding") {
      const binding = contextBindingSchema.parse(definition);
      const connection = await client.query<Row>(
        "select * from harness_admin.context_source_revisions where tenant_id=$1 and kind='connection' and source_id=$2 and revision=$3",
        [input.tenantId, binding.connectionId, binding.connectionRevision],
      );
      if (!connection.rowCount)
        throw new ContextSourceError(
          "context_source.connection_not_found",
          400,
        );
      if (
        binding.refresh.enabled &&
        contextConnectionSchema.parse(connection.rows[0]!.definition)
          .identityMode !== "service"
      )
        throw new ContextSourceError(
          "context_source.schedule_requires_service",
          400,
        );
    }
    const params = [input.tenantId, input.kind, definition.id];
    const head =
      expectedRevision === null
        ? await client.query(
            "insert into harness_admin.context_source_heads(tenant_id,kind,source_id,revision) values ($1,$2,$3,1) on conflict do nothing returning revision",
            params,
          )
        : await client.query(
            "update harness_admin.context_source_heads set revision=revision+1 where tenant_id=$1 and kind=$2 and source_id=$3 and revision=$4 returning revision",
            [...params, expectedRevision],
          );
    if (!head.rowCount)
      throw new ContextSourceError("context_source.revision_conflict");
    const revision = (expectedRevision ?? 0) + 1;
    const row = await client.query<Row>(
      "insert into harness_admin.context_source_revisions(tenant_id,kind,source_id,revision,definition,digest,actor) values ($1,$2,$3,$4,$5::jsonb,$6,$7) returning *",
      [
        ...params,
        revision,
        JSON.stringify(definition),
        stableDigest(definition),
        input.actor,
      ],
    );
    await client.query(
      "insert into harness_admin.context_source_events(tenant_id,kind,source_id,revision,action,actor,reason) values ($1,$2,$3,$4,'saved',$5,'Configuration revised')",
      [...params, revision, input.actor],
    );
    return record(row.rows[0]!, (value) =>
      input.kind === "connection"
        ? contextConnectionSchema.parse(value)
        : contextBindingSchema.parse(value),
    );
  });
}
export async function loadContextBinding(
  db: Database,
  input: {
    tenantId: string;
    bindingId: string;
    revision: number;
    executable?: boolean;
  },
): Promise<{
  binding: ContextRevision<ContextBinding>;
  connection: ContextRevision<ContextConnection>;
}> {
  return scoped(db, input.tenantId, async (client) => {
    const params = [input.tenantId, input.bindingId, input.revision];
    const result = await client.query<Row>(
      `select r.*,h.disabled from harness_admin.context_source_revisions r join harness_admin.context_source_heads h using (tenant_id,kind,source_id)
      where r.tenant_id=$1 and r.kind='binding' and r.source_id=$2 and r.revision=$3`,
      params,
    );
    if (!result.rowCount)
      throw new ContextSourceError("context_source.not_found", 404);
    const row = result.rows[0]!;
    if (input.executable) {
      const activated = await client.query(
        "select 1 from harness_admin.context_source_events where tenant_id=$1 and kind='binding' and source_id=$2 and revision=$3 and action='activated'",
        params,
      );
      if (row.disabled || !activated.rowCount)
        throw new ContextSourceError("context_source.inactive");
    }
    const binding = record(row, contextBindingSchema.parse);
    const connection = await client.query<Row>(
      "select * from harness_admin.context_source_revisions where tenant_id=$1 and kind='connection' and source_id=$2 and revision=$3",
      [
        input.tenantId,
        binding.definition.connectionId,
        binding.definition.connectionRevision,
      ],
    );
    if (!connection.rowCount)
      throw new ContextSourceError("context_source.connection_not_found", 404);
    return {
      binding,
      connection: record(connection.rows[0]!, contextConnectionSchema.parse),
    };
  });
}
export async function recordContextCheck(
  db: Database,
  tenantId: string,
  raw: ContextCheck,
): Promise<ContextCheck> {
  const report = contextCheckSchema.parse(raw);
  return scoped(db, tenantId, async (client) => {
    const head = await client.query<{ revision: number }>(
      "select revision from harness_admin.context_source_heads where tenant_id=$1 and kind='binding' and source_id=$2 for share",
      [tenantId, report.bindingId],
    );
    if (head.rows[0]?.revision !== report.revision)
      throw new ContextSourceError("context_source.revision_conflict");
    await client.query(
      "insert into harness_admin.context_source_checks(tenant_id,check_id,binding_id,revision,report) values ($1,$2,$3,$4,$5::jsonb)",
      [
        tenantId,
        report.id,
        report.bindingId,
        report.revision,
        JSON.stringify(report),
      ],
    );
    return report;
  });
}
export async function activateContextBinding(
  db: Database,
  input: { tenantId: string; actor: string; bindingId: string; body: unknown },
): Promise<{ activeRevision: number | null; disabled: boolean }> {
  const parsed = contextActivationSchema.safeParse(input.body);
  if (!parsed.success)
    throw new ContextSourceError("context_source.activation_invalid", 400);
  const { expectedRevision, revision, action, reason } = parsed.data;
  return scoped(db, input.tenantId, async (client) => {
    const params = [input.tenantId, input.bindingId];
    const head = await client.query<{
      revision: number;
      active_revision: number | null;
    }>(
      "select revision,active_revision from harness_admin.context_source_heads where tenant_id=$1 and kind='binding' and source_id=$2 for update",
      params,
    );
    if (head.rows[0]?.revision !== expectedRevision)
      throw new ContextSourceError("context_source.revision_conflict");
    let qualificationId: string | null = null;
    if (action === "activate") {
      const row = await client.query<Row>(
        "select * from harness_admin.context_source_revisions where tenant_id=$1 and kind='binding' and source_id=$2 and revision=$3",
        [...params, revision],
      );
      if (!row.rowCount)
        throw new ContextSourceError("context_source.not_found", 404);
      const connector = await client.query<{ status: string }>(
        "select status from harness_gateway.connector_registry where connector_id=$1",
        [contextConnectorId(input.tenantId, input.bindingId, revision)],
      );
      if (
        !connector.rowCount ||
        ["quarantined", "retired"].includes(connector.rows[0]!.status)
      )
        throw new ContextSourceError("context_source.connector_unavailable");
      const definition = contextBindingSchema.parse(row.rows[0]!.definition);
      const reports = await client.query<{ report: unknown }>(
        "select report from harness_admin.context_source_checks where tenant_id=$1 and binding_id=$2 and revision=$3 and report->>'kind'='qualify' order by created_at desc limit 1",
        [...params, revision],
      );
      const report =
        reports.rows[0] && contextCheckSchema.parse(reports.rows[0].report);
      if (
        !report ||
        report.status !== "passed" ||
        Date.parse(report.expiresAt) <= Date.now() ||
        report.bindingDigest !== row.rows[0]!.digest
      )
        throw new ContextSourceError("context_source.qualification_required");
      qualificationId = report.id;
      const conn = await client.query<{ digest: string }>(
        "select digest from harness_admin.context_source_revisions where tenant_id=$1 and kind='connection' and source_id=$2 and revision=$3",
        [
          input.tenantId,
          definition.connectionId,
          definition.connectionRevision,
        ],
      );
      if (conn.rows[0]?.digest !== report.connectionDigest)
        throw new ContextSourceError("context_source.connection_changed");
    }
    if (action === "activate") {
      const selected = await client.query<Row>(
        "select * from harness_admin.context_source_revisions where tenant_id=$1 and kind='binding' and source_id=$2 and revision=$3",
        [...params, revision],
      );
      const refresh = contextBindingSchema.parse(
        selected.rows[0]!.definition,
      ).refresh;
      if (refresh.enabled) {
        await client.query(
          `insert into integration.context_refresh_jobs(tenant_id,binding_id,revision,enabled,plan_digest,source_context_digest,run_input,interval_minutes)
          values ($1,$2,$3,true,$4,$5,$6::jsonb,$7) on conflict (tenant_id,binding_id) do update set revision=excluded.revision,enabled=true,
          plan_digest=excluded.plan_digest,source_context_digest=excluded.source_context_digest,run_input=excluded.run_input,interval_minutes=excluded.interval_minutes,
          due_at=now(),scheduled_for=now(),claim_id=null,lease_until=null,run_id=null,failures=0,last_error=null`,
          [
            ...params,
            revision,
            refresh.planDigest,
            refresh.sourceContextDigest,
            JSON.stringify({ ...refresh.input, tenantId: input.tenantId }),
            refresh.intervalMinutes,
          ],
        );
      } else
        await client.query(
          "update integration.context_refresh_jobs set enabled=false where tenant_id=$1 and binding_id=$2",
          params,
        );
    } else
      await client.query(
        "update integration.context_refresh_jobs set enabled=false where tenant_id=$1 and binding_id=$2",
        params,
      );
    await client.query(
      "update harness_admin.context_source_heads set active_revision=$3,disabled=$4 where tenant_id=$1 and kind='binding' and source_id=$2",
      [
        ...params,
        action === "activate" ? revision : head.rows[0]!.active_revision,
        action === "disable",
      ],
    );
    await client.query(
      "insert into harness_admin.context_source_events(tenant_id,kind,source_id,revision,action,actor,reason,qualification_id) values ($1,'binding',$2,$3,$4,$5,$6,$7)",
      [
        ...params,
        revision,
        action === "activate" ? "activated" : "disabled",
        input.actor,
        reason,
        qualificationId,
      ],
    );
    return {
      activeRevision:
        action === "activate" ? revision : head.rows[0]!.active_revision,
      disabled: action === "disable",
    };
  });
}

export async function contextSourceQualification(
  db: Database,
  tenantId: string,
  bindingId: string,
  revision: number,
): Promise<ContextCheck | null> {
  return scoped(db, tenantId, async (client) => {
    const rows = await client.query<{ report: unknown }>(
      `select c.report from harness_admin.context_source_checks c join harness_admin.context_source_events e
      on e.tenant_id=c.tenant_id and e.qualification_id=c.check_id
      where e.tenant_id=$1 and e.kind='binding' and e.source_id=$2 and e.revision=$3 and e.action='activated'
      order by e.event_id desc limit 1`,
      [tenantId, bindingId, revision],
    );
    return rows.rows[0] ? contextCheckSchema.parse(rows.rows[0].report) : null;
  });
}

export function contextConnectorId(
  tenantId: string,
  bindingId: string,
  revision: number,
): string {
  return `context-source:${stableDigest({ tenantId }).slice(0, 16)}:${bindingId}.r${revision}`;
}
export async function registerQualifiedContextConnector(
  db: Database,
  tenantId: string,
  bindingId: string,
  revision: number,
  provider: string,
): Promise<void> {
  const connector = connectorRegistrationSchema.parse({
    connectorId: contextConnectorId(tenantId, bindingId, revision),
    adapterId: "context-source",
    providerId: provider,
    providerName: provider,
    capabilityId: "context.source.read.v1",
    operation: `${bindingId}.r${revision}`,
    resultFamily: null,
    status: "live_ready",
    demoSupported: false,
    liveBlockers: [],
    source: {
      catalog: "context-sources",
      revision: `${bindingId}.r${revision}`,
    },
  });
  await db.query(
    "insert into harness_gateway.connector_registry(connector_id,capability_id,adapter_id,provider_id,definition,definition_digest,status) values ($1,$2,$3,$4,$5::jsonb,$6,'live_ready') on conflict do nothing",
    [
      connector.connectorId,
      connector.capabilityId,
      connector.adapterId,
      connector.providerId,
      JSON.stringify(connector),
      stableDigest(connector),
    ],
  );
}

export async function configureContextRefresh(
  db: Database,
  input: { tenantId: string; actor: string; bindingId: string; body: unknown },
): Promise<{ activeRevision: number; disabled: boolean }> {
  const parsed = contextRefreshSaveSchema.safeParse(input.body);
  if (!parsed.success)
    throw new ContextSourceError("context_source.refresh_invalid", 400);
  const { expectedRevision, revision, configuration, reason } = parsed.data;
  return scoped(db, input.tenantId, async (client) => {
    const params = [input.tenantId, input.bindingId];
    const head = await client.query<{
      revision: number;
      active_revision: number | null;
      disabled: boolean;
    }>(
      "select revision,active_revision,disabled from harness_admin.context_source_heads where tenant_id=$1 and kind='binding' and source_id=$2 for update",
      params,
    );
    if (head.rows[0]?.revision !== expectedRevision)
      throw new ContextSourceError("context_source.revision_conflict");
    if (head.rows[0].disabled || head.rows[0].active_revision !== revision)
      throw new ContextSourceError("context_source.inactive");
    if (configuration.enabled) {
      const row = await client.query<Row>(
        "select * from harness_admin.context_source_revisions where tenant_id=$1 and kind='binding' and source_id=$2 and revision=$3",
        [...params, revision],
      );
      const binding = contextBindingSchema.parse(row.rows[0]!.definition);
      const conn = await client.query<Row>(
        "select * from harness_admin.context_source_revisions where tenant_id=$1 and kind='connection' and source_id=$2 and revision=$3",
        [input.tenantId, binding.connectionId, binding.connectionRevision],
      );
      if (
        contextConnectionSchema.parse(conn.rows[0]!.definition).identityMode !==
        "service"
      )
        throw new ContextSourceError(
          "context_source.schedule_requires_service",
          400,
        );
      await client.query(
        `insert into integration.context_refresh_jobs(tenant_id,binding_id,revision,enabled,plan_digest,source_context_digest,run_input,interval_minutes)
        values ($1,$2,$3,true,$4,$5,$6::jsonb,$7) on conflict (tenant_id,binding_id) do update set revision=excluded.revision,enabled=true,
        plan_digest=excluded.plan_digest,source_context_digest=excluded.source_context_digest,run_input=excluded.run_input,interval_minutes=excluded.interval_minutes,
        due_at=now(),scheduled_for=now(),claim_id=null,lease_until=null,run_id=null,failures=0,last_error=null`,
        [
          ...params,
          revision,
          configuration.planDigest,
          configuration.sourceContextDigest,
          JSON.stringify({ ...configuration.input, tenantId: input.tenantId }),
          configuration.intervalMinutes,
        ],
      );
    } else
      await client.query(
        "update integration.context_refresh_jobs set enabled=false where tenant_id=$1 and binding_id=$2",
        params,
      );
    await client.query(
      "insert into harness_admin.context_source_events(tenant_id,kind,source_id,revision,action,actor,reason) values ($1,'binding',$2,$3,'refresh.configured',$4,$5)",
      [...params, revision, input.actor, reason],
    );
    return { activeRevision: revision, disabled: !configuration.enabled };
  });
}
