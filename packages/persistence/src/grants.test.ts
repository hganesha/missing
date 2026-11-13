import contextSourceFixture from "../../contracts/test-fixtures/context-source.json" with { type: "json" };
import { saveContextSource, contextSourceIndex } from "./context-sources.js";
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { executionWorkItemSchema, stableDigest } from "@ehf/contracts";
import { completeGatewayReceipt, createDatabase, recordCapabilityCost, reserveGatewayReceipt, type Database } from "./index.js";
import { claimDelivery } from "./integrations.js";
import intelligenceFixture from "../../contracts/test-fixtures/intelligence-decision.json" with { type: "json" };
import { checkIntelligenceCandidate, intelligenceCandidates, saveIntelligenceCandidate } from "./intelligence.js";
import { createExecutionWorkItem, getExecutionWorkItem, listHumanWorkQueue, submitHumanWorkDecision } from "./execution-work.js";

// The control database's grant matrix (grants.sql) and controller roles (migration 035),
// exercised against a real PostgreSQL. EHF_TEST_DATABASE_URL must point at a migrated
// database as a role that can create roles; the test creates one throwaway login per
// service group and drops them afterwards.

const adminUrl = process.env.EHF_TEST_DATABASE_URL;
const MANAGED_SCHEMAS = ["harness_control", "harness_runtime", "harness_gateway", "harness_admin", "workflow", "integration", "observability",
  "langgraph_checkpoint"];
const SERVICE_GROUPS = ["ehf_svc_control_api", "ehf_svc_runtime_dispatcher", "ehf_svc_runtime_checkpoint", "ehf_svc_capability_gateway",
  "ehf_svc_integration_worker", "ehf_svc_case_execution"];
// Present in migrations, read and written by no code path. Granted to nobody until one is.
const UNUSED_TABLES = new Set(["harness_control.signing_key_revocations", "harness_control.release_allocations"]);

type Service = "control" | "dispatcher" | "gateway" | "integration" | "caseExecution" | "queueMetrics";
const GROUP: Record<Service, string> = {
  control: "ehf_svc_control_api", dispatcher: "ehf_svc_runtime_dispatcher", gateway: "ehf_svc_capability_gateway",
  integration: "ehf_svc_integration_worker", caseExecution: "ehf_svc_case_execution",
  queueMetrics: "ehf_svc_queue_metrics",
};

describe.skipIf(!adminUrl)("control database grant matrix", () => {
  let admin: pg.Pool;
  const logins: string[] = [];
  const as = {} as Record<Service, Database>;
  let canRun = false;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    const self = await admin.query<{ rolsuper: boolean; rolcreaterole: boolean }>("select rolsuper, rolcreaterole from pg_roles where rolname = current_user");
    canRun = Boolean(self.rows[0]?.rolsuper || self.rows[0]?.rolcreaterole);
    if (!canRun) return;
    const suffix = randomBytes(4).toString("hex");
    for (const [service, group] of Object.entries(GROUP) as [Service, string][]) {
      const login = `ehf_test_${service.toLowerCase()}_${suffix}`;
      const password = randomBytes(18).toString("hex");
      await admin.query(`create role ${login} login password '${password}' nosuperuser nobypassrls`);
      await admin.query(`grant ${group} to ${login}`);
      logins.push(login);
      const url = new URL(adminUrl!);
      url.username = login; url.password = password;
      as[service] = createDatabase(url.toString());
    }
  });

  afterAll(async () => {
    await Promise.all(Object.values(as).map((db) => db.end()));
    for (const login of logins) await admin.query(`drop role if exists ${login}`);
    await admin?.end();
  });

  const denied = async (db: Database, sql: string, values: unknown[] = []) =>
    expect(db.query(sql, values)).rejects.toThrow(/permission denied/);

  it("lets only control-api write intelligence proposals and enforces tenant RLS for its service role", async ({ skip }) => {
    if (!canRun) skip();
    const tenantId = `intelligence_grants_${randomUUID()}`;
    const scope = { tenantId, environment: "sandbox" };
    const candidate = await saveIntelligenceCandidate(as.control, { ...scope, actor: "reviewer", body: { definition: intelligenceFixture, expectedRevision: null, reason: "Service-role verification" } });
    expect(candidate.revision).toBe(1);
    const report = await checkIntelligenceCandidate(as.control, { ...scope, actor: "reviewer", bindingId: intelligenceFixture.id, expectedRevision: 1, evaluate: () => [] });
    expect(report.executionVerified).toBe(false);
    expect((await intelligenceCandidates(as.control, scope)).candidates).toHaveLength(1);
    expect((await intelligenceCandidates(as.control, { ...scope, tenantId: `${tenantId}_other` })).candidates).toEqual([]);
    expect((await as.control.query("select * from harness_admin.intelligence_binding_heads where tenant_id=$1", [tenantId])).rows).toEqual([]);
    for (const service of [as.gateway, as.dispatcher, as.integration]) await denied(service, "select * from harness_admin.intelligence_binding_heads");
    await denied(as.control, "update harness_admin.intelligence_binding_revisions set reason=reason");
    await denied(as.control, "delete from harness_admin.intelligence_events");
  });

  it("keeps connector configuration, qualification and refresh dispatch under separate service grants",async({skip})=>{
    if(!canRun)skip();
    const tenantId=`source_grants_${randomUUID()}`;
    await saveContextSource(as.control,{tenantId,actor:"author",kind:"connection",body:{definition:contextSourceFixture.connection,expectedRevision:null}});
    expect((await contextSourceIndex(as.control,tenantId)).connections).toHaveLength(1);
    expect((await contextSourceIndex(as.control,`${tenantId}_other`)).connections).toEqual([]);
    await denied(as.control,"insert into harness_admin.context_source_checks(tenant_id,check_id,binding_id,revision,report) values ($1,'forged','source',1,'{}')",[tenantId]);
    await denied(as.gateway,"update harness_admin.context_source_heads set active_revision=1 where tenant_id=$1",[tenantId]);
    await denied(as.gateway,"update integration.context_refresh_jobs set enabled=true");
    await denied(as.integration,"select * from harness_admin.context_source_revisions");
    await denied(as.integration,"select input from harness_runtime.runs");
  });

  it("lists every table in the grant matrix (fail closed for new tables)", async ({ skip }) => {
    if (!canRun) skip();
    const result = await admin.query<{ name: string; granted: boolean }>(`
      select n.nspname || '.' || c.relname as name,
             bool_or(has_table_privilege(r.rolname, c.oid, 'select,insert,update,delete')) as granted
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join unnest($2::text[]) as r(rolname)
      where c.relkind in ('r', 'p') and n.nspname = any($1::text[])
      group by 1 order by 1
    `, [MANAGED_SCHEMAS, SERVICE_GROUPS]);
    const missing = result.rows.filter((row) => !row.granted && !UNUSED_TABLES.has(row.name)).map((row) => row.name);
    expect(missing).toEqual([]);
    const unusedButGranted = result.rows.filter((row) => row.granted && UNUSED_TABLES.has(row.name)).map((row) => row.name);
    expect(unusedButGranted).toEqual([]);
  });

  it("keeps every service and controller role unable to log in, bypass RLS or own anything", async ({ skip }) => {
    if (!canRun) skip();
    const roles = await admin.query<{ rolname: string; rolcanlogin: boolean; rolsuper: boolean; rolbypassrls: boolean; owned: number }>(`
      select r.rolname, r.rolcanlogin, r.rolsuper, r.rolbypassrls,
             (select count(*)::int from pg_class c where c.relowner = r.oid) as owned
      from pg_roles r where r.rolname = any($1::text[])
    `, [[...SERVICE_GROUPS, "ehf_audit_reader", "ehf_workflow_controller", "ehf_integration_controller"]]);
    expect(roles.rows).toHaveLength(SERVICE_GROUPS.length + 3);
    for (const role of roles.rows) expect(role).toMatchObject({ rolcanlogin: false, rolsuper: false, rolbypassrls: false, owned: 0 });
  });

  it("no longer honours a client-set controller flag; controller scope comes from role membership", async ({ skip }) => {
    if (!canRun) skip();
    const tenantId = `grants_${randomUUID()}`;
    await createExecutionWorkItem(as.dispatcher, workItem(tenantId, "spoof"));

    // control-api is not a workflow controller. Claiming to be one in a session setting
    // used to open every tenant's work items; now it opens nothing.
    const spoof = await as.control.connect();
    try {
      await spoof.query("begin");
      await spoof.query("select set_config('app.workflow_controller', 'true', true)");
      await spoof.query("select set_config('app.tenant_id', 'some_other_tenant', true)");
      const seen = await spoof.query("select count(*)::int as n from workflow.work_items where tenant_id = $1", [tenantId]);
      expect(seen.rows[0].n).toBe(0);
      await spoof.query("rollback");
    } finally { spoof.release(); }

    // The dispatcher is a controller by membership and sees across tenants.
    const dispatcher = await as.dispatcher.query("select count(*)::int as n from workflow.work_items where tenant_id = $1", [tenantId]);
    expect(dispatcher.rows[0].n).toBe(1);
  });

  it("lets each service do its own work", async ({ skip }) => {
    if (!canRun) skip();
    const tenantId = `grants_${randomUUID()}`;
    // runtime-worker creates work; control-api runs the human decision on it.
    await createExecutionWorkItem(as.dispatcher, workItem(tenantId, "review"));
    expect((await listHumanWorkQueue(as.control, tenantId)).map((item) => item.workItem.workItemId)).toEqual(["review"]);
    const decision = await submitHumanWorkDecision(as.control, {
      decisionId: randomUUID(), tenantId, caseId: "case", workItemId: "review", principalId: "reviewer-a", decision: "APPROVE",
      reasonCode: "review.evidence_checked", rationale: "Reviewed", evidenceRefs: [], decidedAt: new Date().toISOString(),
    });
    expect(decision.workItem.status).toBe("COMPLETED");
    // The gateway reads the work item it serves and meters cost onto the run.
    expect((await getExecutionWorkItem(as.gateway, tenantId, "review"))?.workItemId).toBe("review");
    const runId = await insertRun(admin, tenantId);
    await recordCapabilityCost(as.gateway, { runId, costUsd: 0.25 });
    expect(Number((await admin.query("select cost_usd from harness_runtime.runs where run_id = $1", [runId])).rows[0].cost_usd)).toBe(0.25);
    // The integration worker claims deliveries across tenants (none are waiting here).
    await expect(claimDelivery(as.integration)).resolves.toBeDefined();
    // case-api may ask about an execution lease and nothing else.
    const allowed = await as.caseExecution.query(
      "select harness_runtime.lock_case_execution($1, $2, $3, $4, 1, 1, null, null) as allowed", [runId, tenantId, "case", "a".repeat(64)]);
    expect(allowed.rows[0].allowed).toBe(false);
  });

  it("refuses each service everything outside its row of the matrix", async ({ skip }) => {
    if (!canRun) skip();
    const tenantId = `grants_${randomUUID()}`;
    const runId = await insertRun(admin, tenantId);
    // The gateway meters cost but cannot change a run's status, lease or outcome.
    await denied(as.gateway, "update harness_runtime.runs set status = 'completed' where run_id = $1", [runId]);
    await denied(as.gateway, "update harness_runtime.runs set fencing_epoch = fencing_epoch + 1 where run_id = $1", [runId]);
    await denied(as.gateway, "insert into workflow.dispatch_outbox(tenant_id) values ('x')");
    // The dispatcher runs plans; it cannot admit them, administer models or touch integrations.
    await denied(as.dispatcher, "insert into harness_control.plans(plan_digest) values ('x')");
    await denied(as.dispatcher, "select * from harness_admin.providers");
    await denied(as.dispatcher, "select * from integration.deliveries");
    await denied(as.dispatcher, "delete from workflow.work_items");
    // control-api administers; it cannot dispatch work or rewrite gateway receipts.
    await denied(as.control, "insert into workflow.dispatch_outbox(tenant_id) values ('x')");
    await denied(as.control, "delete from harness_gateway.receipts");
    await denied(as.control, "delete from harness_runtime.runs");
    // The integration worker sees integrations only.
    await denied(as.integration, "select * from workflow.work_items");
    await denied(as.integration, "select * from harness_runtime.runs");
    await denied(as.integration, "insert into integration.connector_revisions(tenant_id) values ('x')");
    // case-api's control-database identity reads no table at all.
    await denied(as.caseExecution, "select * from harness_runtime.runs");
    await denied(as.caseExecution, "select * from workflow.work_items");
    // Nobody creates objects in a managed schema.
    for (const db of Object.values(as)) await denied(db, "create table harness_control.intruder(id int)");
  });

  it("separates source artifact administration from append-only gateway decisions", async ({ skip }) => {
    if (!canRun) skip();
    for (const [group, table, permissions] of [
      [GROUP.control, "harness_control.source_artifacts", [true, true, false, false]],
      [GROUP.gateway, "harness_control.source_artifacts", [true, false, false, false]],
      [GROUP.control, "harness_gateway.source_decisions", [true, false, false, false]],
      [GROUP.gateway, "harness_gateway.source_decisions", [true, true, false, false]],
      [GROUP.control, "observability.foundry_invocation_link", [true, false, false, false]],
      [GROUP.gateway, "observability.foundry_invocation_link", [false, true, false, false]],
      ["ehf_audit_reader", "observability.foundry_invocation_link", [false, false, false, false]],
    ] as const) {
      const result = await admin.query(`select has_table_privilege($1,$2,'SELECT') as read,
        has_table_privilege($1,$2,'INSERT') as append, has_table_privilege($1,$2,'UPDATE') as rewrite,
        has_table_privilege($1,$2,'DELETE') as remove`, [group, table]);
      expect(Object.values(result.rows[0])).toEqual(permissions);
    }
    await denied(as.dispatcher, "select * from harness_control.source_artifacts");
    await denied(as.integration, "select * from harness_gateway.source_decisions");
  });

  it("settles a Foundry correlation link with its authorized gateway receipt", async ({ skip }) => {
    if (!canRun) skip();
    const runId = await insertRun(admin, `foundry_${randomUUID()}`);
    const { plan_digest: planDigest } = (await admin.query<{ plan_digest: string }>(
      "select plan_digest from harness_runtime.runs where run_id=$1", [runId],
    )).rows[0]!;
    const invocationId = randomUUID();
    const traceId = "a".repeat(32);
    const parentSpanId = "b".repeat(16);
    const capabilityId = "foundry.agent.prompt.v1";
    expect(await reserveGatewayReceipt(as.gateway, {
      invocationId, runId, nodeId: "foundry", attempt: 1, fencingEpoch: 1, planDigest,
      permissionDigest: "c".repeat(64), capabilityId, effect: "paid",
      decision: "allowed", reasonCode: "permission.envelope_allowed", requestDigest: "d".repeat(64),
      traceId, spanId: "e".repeat(16),
      budget: { modelCall: true, maxCapabilityCalls: 2, maxModelCalls: 2, maxCostUsd: 10 },
    })).toMatchObject({ created: true });
    const result = {
      invocationId, capabilityId, status: "succeeded" as const, output: { text: "synthetic answer" },
      errorCode: null, provider: "azure_foundry_agents", model: "pilot", providerRequestId: null,
      usage: { inputTokens: 1, outputTokens: 1, costUsd: null }, latencyMs: 3, receiptDigest: "f".repeat(64),
    };
    const at = new Date().toISOString();
    const link = {
      traceId, parentSpanId, responseId: "resp_pilot", startedAt: at, completedAt: at,
      agentName: "pilot", agentVersion: "1", projectEndpoint: "https://sample.services.ai.azure.com/api/projects/pilot",
      applicationInsightsResourceId: "/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/pilot/providers/Microsoft.Insights/components/pilot",
    };
    await expect(completeGatewayReceipt(as.gateway, runId, result, { ...link, traceId: "b".repeat(32) }))
      .rejects.toThrow("gateway.foundry_receipt_link_mismatch");
    expect((await as.gateway.query("select result from harness_gateway.receipts where invocation_id=$1", [invocationId])).rows)
      .toEqual([{ result: null }]);
    await completeGatewayReceipt(as.gateway, runId, result, link);
    expect((await as.control.query("select run_id, attempt, response_id, parent_span_id from observability.foundry_invocation_link where invocation_id=$1", [invocationId])).rows)
      .toEqual([{ run_id: runId, attempt: 1, response_id: link.responseId, parent_span_id: parentSpanId }]);
    expect(JSON.stringify((await as.gateway.query("select result from harness_gateway.receipts where invocation_id=$1", [invocationId])).rows))
      .not.toContain(link.responseId);
    await denied(as.gateway, "select response_id from observability.foundry_invocation_link");
  });

  it("lets the autoscaler count ready work and read nothing else", async () => {
    if (!canRun) return;
    const ready = async () => Number((await as.queueMetrics.query<{ count: string }>("select harness_runtime.ready_run_count() as count")).rows[0]!.count);
    const before = await ready();
    const runId = await insertRun(admin, `tenant_${randomUUID()}`);
    // insertRun leaves the run leased; make it claimable now.
    await admin.query("update harness_runtime.runs set status = 'queued', lease_expires_at = null, available_at = null, attempt = 0 where run_id = $1", [runId]);
    expect(await ready()).toBe(before + 1);
    await admin.query("update harness_runtime.runs set available_at = now() + interval '1 hour' where run_id = $1", [runId]);
    expect(await ready()).toBe(before);
    expect(Number((await as.queueMetrics.query<{ count: string }>("select integration.ready_work_count() as count")).rows[0]!.count)).toBeGreaterThanOrEqual(0);
    await denied(as.queueMetrics, "select count(*) from harness_runtime.runs");
    await denied(as.queueMetrics, "select count(*) from integration.deliveries");
    await denied(as.queueMetrics, "select harness_runtime.lock_case_execution('t','c','e','w',1,1,'n',1)");
  });
});

async function insertRun(admin: pg.Pool, tenantId: string): Promise<string> {
  const planDigest = randomBytes(32).toString("hex");
  const runId = `run_${randomUUID()}`;
  await admin.query("insert into harness_control.plans(plan_digest, plan_id, name, domain, version, plan, tenant_id) values ($1, $2, 'grants', 'kyc', '1', '{}', $3) on conflict do nothing",
    [planDigest, `plan-${runId}`, tenantId]);
  await admin.query(`insert into harness_runtime.runs(run_id, idempotency_key, plan_digest, status, input, attempt, fencing_epoch, lease_expires_at, tenant_id, request_digest)
    values ($1, $1, $2, 'running', '{"caseId":"case"}', 1, 1, now() + interval '5 minutes', $3, 'grants')`, [runId, planDigest, tenantId]);
  return runId;
}

function workItem(tenantId: string, workItemId: string) {
  const timestamp = new Date().toISOString();
  return executionWorkItemSchema.parse({
    apiVersion: "harness.factory/execution-work-item-v1", kind: "ExecutionWorkItem", tenantId, caseId: "case", workItemId,
    workType: "approval", capabilityId: "human.review", assuranceClass: "HIGH", revision: 0, caseSequenceBasis: 1,
    planDigest: "a".repeat(64), policyContextRef: "policy", schemaVersion: "work.v1", objective: "Review",
    subjectRefs: [], requiredOutputs: ["decision"], constraints: {}, dependencyIds: [], dependencyDigest: stableDigest([]),
    invalidationPolicy: "BLOCK", status: "HUMAN_REQUIRED", reasonCode: "review", priority: 10, readyAt: null, deadlineAt: null, terminalAt: null,
    dispatch: { generation: 0, queue: "human", publishedAt: null, brokerMessageId: null }, lease: null,
    limits: { maxAttempts: 3, maxReworkCycles: 2, maxDurationMs: 60000, maxCostUsd: 1, maxModelCalls: 1, maxCapabilityCalls: 1 },
    result: null, createdBy: { type: "SYSTEM", principalId: "test", roles: [] }, transitionSequence: 0, traceId: null, createdAt: timestamp, updatedAt: timestamp,
  });
}
