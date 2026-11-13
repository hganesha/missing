import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createKycCaseRequestSchema, executionWorkItemSchema, harnessPlanV2Schema, registerEvidenceRequestSchema, stableDigest, type BusinessCommand } from "@ehf/contracts";
import { assembleContextPack } from "@ehf/context-plane";
import {
  createCaseStore, createKycCase, getContextReleaseEligibility, listCaseEvents, listCases, recordContextReleased,
  registerEvidence, submitBusinessCommand, verifyCaseLedger, type CaseStore,
} from "@ehf/case-store";
import { createDatabase, createExecutionWorkItem } from "@ehf/persistence";
import type { BlobContainer } from "@ehf/blob-store";
import { createMemoryBlobContainer } from "@ehf/blob-store/testing";
import { casePackPrefix, createContextStore, recordContextPack, sourcesOfPack, type ContextStore } from "./index.js";
import { releaseCase, type ReleaseDependencies } from "./release.js";

// Phase 4d (docs/implementation/data-stores-plan.md §3.3): after a case has been closed for
// the grace period, its context is deleted and its working data redacted, once nothing blocks
// it, and the release is recorded in its ledger. EHF_TEST_DATABASE_URL: one database with the
// control, case and context schemas (pgvector and AGE), as a superuser.

const adminUrl = process.env.EHF_TEST_DATABASE_URL;
const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../contracts/test-fixtures/agent-profiles.plan.json", import.meta.url), "utf8")));
const NODE = "case-assessment";
const DAY = 86_400_000;

describe.skipIf(!adminUrl)("context release after a case closes", () => {
  let admin: pg.Pool;
  let canRun = false;
  let cases: CaseStore;
  let contextAdmin: ContextStore;
  const suffix = randomBytes(4).toString("hex");
  const password = randomBytes(18).toString("hex");
  const logins = { context: `ehf_rel_ctx_${suffix}`, control: `ehf_rel_ctl_${suffix}` };
  let deps: ReleaseDependencies;
  let control: pg.Pool;
  let releaseContext: ContextStore;
  // Pack bodies in a pack container (phase 5), deleted with the case's context.
  let packBlobs: BlobContainer;
  const url = (login?: string) => { const value = new URL(adminUrl!); if (login) { value.username = login; value.password = password; } return value.toString(); };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    const ready = (await admin.query<{ ok: boolean }>(`select (select rolsuper from pg_roles where rolname = current_user)
      and to_regclass('context.case_releases') is not null and to_regclass('harness_runtime.runs') is not null
      and to_regclass('case_core.cases') is not null as ok`)).rows[0]!.ok;
    canRun = ready;
    if (!canRun) return;
    for (const [login, group] of [[logins.context, "ehf_svc_context_release"], [logins.control, "ehf_svc_case_data_release"]]) {
      await admin.query(`create role ${login} login password '${password}' nosuperuser nobypassrls`);
      await admin.query(`grant ${group} to ${login}`);
    }
    packBlobs = createMemoryBlobContainer({ container: "context-packs", immutability: "none" });
    await packBlobs.ensure();
    cases = createCaseStore({ connectionString: adminUrl! });
    contextAdmin = createContextStore({ connectionString: adminUrl!, packBlobs });
    releaseContext = createContextStore({ connectionString: url(logins.context), packBlobs });
    control = new pg.Pool({ connectionString: url(logins.control), max: 2 });
    deps = {
      context: releaseContext,
      control,
      graceDays: () => 30,
      caseApi: {
        closedCases: async (tenantId) => (await listCases(cases, { tenantId, status: "CLOSED" })).map((item) => String(item.caseId)),
        eligibility: (tenantId, caseId) => getContextReleaseEligibility(cases, tenantId, caseId),
        recordReleased: (tenantId, caseId, body) => recordContextReleased(cases, tenantId, caseId, { ...body, releasedBy: "context-release" }),
      },
    };
  }, 60_000);

  afterAll(async () => {
    await Promise.all([cases?.db.end(), contextAdmin?.db.end(), releaseContext?.db.end(), control?.end()]);
    if (canRun) for (const login of Object.values(logins)) await admin.query(`drop role if exists ${login}`);
    await admin?.end();
  });

  it("schedules, waits for live work, then releases context and working data and records it in the ledger", async ({ skip }) => {
    if (!canRun) skip();
    const tenantId = `rel_${randomUUID()}`;
    const planDigest = randomBytes(32).toString("hex");
    await admin.query("insert into harness_control.plans(plan_digest,plan_id,name,domain,version,plan,tenant_id) values($1,$2,'test','kyc','1','{}',$3)", [planDigest, `plan-${planDigest.slice(0, 8)}`, tenantId]);
    const newCase = async () => String((await createKycCase(cases, createKycCaseRequestSchema.parse({
      tenantId, policySnapshotDigest: "a".repeat(64), harnessPlanDigest: planDigest, actor: { type: "HUMAN", principalId: "requester", roles: [] },
    }), randomUUID())).case.caseId);
    const caseId = await newCase();
    const otherCase = await newCase();
    const runId = `run-${randomUUID()}`;
    await admin.query(`insert into harness_runtime.runs(run_id,idempotency_key,plan_digest,status,input,output,attempt,fencing_epoch,lease_expires_at,tenant_id,request_digest)
      values($1,$1,$2,'running',$3,$4,1,1,now()+interval '10 minutes',$5,'test')`,
      [runId, planDigest, { tenantId, caseId, subjectName: "Meridian Trade Holdings" }, { summary: "PEP exposure" }, tenantId]);
    await admin.query("insert into harness_runtime.run_events(run_id,sequence,event_key,code,node_id,status,values) values($1,1,'k','context.resolved',$2,'observed',$3)", [runId, NODE, { note: "case content" }]);
    await admin.query(`insert into harness_gateway.receipts(invocation_id,run_id,node_id,attempt,fencing_epoch,plan_digest,permission_digest,capability_id,effect,decision,reason_code,request_digest,result,receipt_digest,tenant_id)
      values($1,$2,$3,1,1,$4,$4,'model.reasoning','read','allowed','ok','r',$5,'d',$6)`, [`inv-${runId}`, runId, NODE, planDigest, { output: "model answer" }, tenantId]);

    // What the model was shown: recorded in the context store, promoted and cited by the agent.
    const pack = assembleContextPack({
      plan, nodeId: NODE, runId, selection: { assessmentContext: { subjects: [{ display_name: "Meridian", evidenceId: "ev_shared" }] } },
      snapshot: { snapshotId: `snapshot_${"a".repeat(64)}`, snapshotDigest: "a".repeat(64), tenantId, caseId, caseSequence: 1 }, task: "Assess.",
    });
    await recordContextPack(contextAdmin, { tenantId, caseId, runId, nodeId: NODE, attempt: 1, pack });
    const otherPack = assembleContextPack({
      plan, nodeId: NODE, runId: `run-${randomUUID()}`, selection: { assessmentContext: { subjects: [{ display_name: "Other" }] } },
      snapshot: { snapshotId: `snapshot_${"b".repeat(64)}`, snapshotDigest: "b".repeat(64), tenantId, caseId: otherCase, caseSequence: 1 }, task: "Assess.",
    });
    await recordContextPack(contextAdmin, { tenantId, caseId: otherCase, runId: otherPack.runId, nodeId: NODE, attempt: 1, pack: otherPack });
    const vector = JSON.stringify(Array.from({ length: 1536 }, (_, index) => (index === 0 ? 1 : 0)));
    for (const [chunk, chunkCase] of [["case-chunk", caseId], ["policy-chunk", null]] as const) {
      await admin.query(`insert into context.knowledge_chunks(tenant_id, chunk_id, case_id, source_kind, source_ref, title, content, embedding_model, embedding)
        values ($1, $2, $3, $4, $2, $2, 'text', 'test', $5::vector)`, [tenantId, chunk, chunkCase, chunkCase ? "evidence" : "policy", vector]);
    }
    const execution = { tenant_id: tenantId, case_id: caseId, run_id: runId, plan_digest: planDigest, attempt: 1, fencing_epoch: 1, node_id: NODE, context_required: true };
    const promoted = await registerEvidence(cases, registerEvidenceRequestSchema.parse({
      tenantId, caseId, type: "model_context", mediaType: "application/json", contentBase64: Buffer.from(JSON.stringify(pack)).toString("base64"),
      source: { type: "DERIVED", retrievedAt: new Date().toISOString() }, trust: { tier: "PLATFORM_RECORD", instructionTrust: "UNTRUSTED_DATA" },
      retentionClass: "DECISION_RECORD", createdBy: { type: "AGENT", principalId: "agent", roles: [] },
    }), randomUUID(), execution);
    const evidenceId = String(promoted.evidence.evidenceId);
    const command = (commandType: BusinessCommand["commandType"], payload: Record<string, unknown>, actor: BusinessCommand["actor"], authority: Record<string, unknown> = {}) => async () => {
      const sequence = (await listCaseEvents(cases, tenantId, caseId)).length;
      return submitBusinessCommand(cases, {
        commandId: randomUUID(), commandType, commandVersion: "v1", tenantId, caseId, actor,
        authority: { planDigest, policySnapshotDigest: "a".repeat(64), permissionEnvelopeDigest: "c".repeat(64), ...authority } as BusinessCommand["authority"],
        payload, preconditions: { caseSequence: sequence }, idempotencyKey: randomUUID(),
      }, actor.type === "AGENT" ? execution : undefined);
    };
    await command("AddSubject", { subjectType: "individual", displayName: "Meridian" }, { type: "AGENT", principalId: "agent", roles: [] },
      { contextEvidenceId: evidenceId, contextPackDigest: pack.packDigest })();
    await admin.query("update harness_runtime.runs set status = 'completed' where run_id = $1", [runId]);
    const person = { type: "HUMAN" as const, principalId: "analyst", roles: [] };
    await command("TransitionCaseStatus", { toStatus: "SUSPENDED", reason: "test" }, person)();
    await command("TransitionCaseStatus", { toStatus: "CLOSED", reason: "test" }, person)();
    const closedAt = Date.parse((await getContextReleaseEligibility(cases, tenantId, caseId))!.closed!.at);

    // Inside the grace period: scheduled, nothing touched.
    expect(await releaseCase({ ...deps, now: () => new Date(closedAt + DAY) }, tenantId, caseId)).toMatchObject({ state: "SCHEDULED" });
    expect((await admin.query("select count(*)::int as n from context.packs where tenant_id = $1 and case_id = $2", [tenantId, caseId])).rows[0].n).toBe(1);

    // A work item of the case still live: blocked.
    const work = await createExecutionWorkItem(createDatabase(adminUrl!), workItem(tenantId, caseId, runId, planDigest));
    const later = { ...deps, now: () => new Date(closedAt + 31 * DAY) };
    expect(await releaseCase(later, tenantId, caseId)).toMatchObject({ state: "BLOCKED", reason: "active_execution" });
    await admin.query("update workflow.work_items set status = 'CANCELLED', terminal_at = now() where tenant_id = $1 and work_item_id = $2", [tenantId, work.workItem.workItemId]);

    // The pack body is in the pack container, not the row.
    const blobsOf = async (id: string) => { const names: string[] = []; for await (const item of packBlobs.list(casePackPrefix(tenantId, id))) names.push(item.name); return names; };
    expect((await admin.query("select pack is null as moved, pack_blob_name from context.packs where tenant_id = $1 and case_id = $2", [tenantId, caseId])).rows[0])
      .toEqual({ moved: true, pack_blob_name: `${casePackPrefix(tenantId, caseId)}${pack.packDigest}.json` });
    expect(JSON.parse((await packBlobs.get((await blobsOf(caseId))[0]!)).toString()).packDigest).toBe(pack.packDigest);

    // Due and unblocked: released.
    expect(await releaseCase(later, tenantId, caseId)).toMatchObject({ state: "RELEASED" });
    expect(await blobsOf(caseId)).toEqual([]);
    expect((await blobsOf(otherCase)).length).toBe(1);
    const count = async (sql: string, values: unknown[]) => (await admin.query(sql, values)).rows[0].n as number;
    expect(await count("select count(*)::int as n from context.packs where tenant_id = $1 and case_id = $2", [tenantId, caseId])).toBe(0);
    expect(await count("select count(*)::int as n from context.packs where tenant_id = $1 and case_id = $2", [tenantId, otherCase])).toBe(1);
    expect(await count("select count(*)::int as n from context.knowledge_chunks where tenant_id = $1", [tenantId])).toBe(1);
    expect(await sourcesOfPack(contextAdmin, tenantId, pack.packDigest)).toEqual([]);
    expect((await sourcesOfPack(contextAdmin, tenantId, otherPack.packDigest)).length).toBeGreaterThan(0);
    const run = (await admin.query("select input, output from harness_runtime.runs where run_id = $1", [runId])).rows[0];
    expect(run).toEqual({ input: { tenantId, caseId, released: true }, output: { released: true } });
    expect((await admin.query("select values from harness_runtime.run_events where run_id = $1", [runId])).rows[0].values).toEqual({ released: true });
    expect((await admin.query("select result from harness_gateway.receipts where run_id = $1", [runId])).rows[0].result).toEqual({ released: true, receiptDigest: "d" });
    expect((await admin.query("select document->>'objective' as o from workflow.work_items where work_item_id = $1", [work.workItem.workItemId])).rows[0].o).toBe("[released]");

    // The decision record survives: the promoted pack, and a ledger event saying what was released.
    expect((await admin.query("select count(*)::int as n from evidence.evidence_objects where evidence_id = $1", [evidenceId])).rows[0].n).toBe(1);
    const last = (await listCaseEvents(cases, tenantId, caseId)).at(-1)!;
    expect(last.eventType).toBe("context.released");
    expect(last.payload).toMatchObject({ promotedEvidenceIds: [evidenceId], counts: expect.objectContaining({ contextPacks: 1, contextPackBlobs: 1, knowledgeChunks: 1, runs: 1 }) });
    expect(await verifyCaseLedger(cases, tenantId, caseId)).toMatchObject({ valid: true });
    const row = (await admin.query("select state, ledger_event_id from context.case_releases where tenant_id = $1 and case_id = $2", [tenantId, caseId])).rows[0];
    expect(row).toEqual({ state: "RELEASED", ledger_event_id: last.eventId });

    // Again: nothing more to do.
    expect(await releaseCase(later, tenantId, caseId)).toMatchObject({ state: "ALREADY_RELEASED" });
    expect((await listCaseEvents(cases, tenantId, caseId)).at(-1)!.eventId).toBe(last.eventId);
  });

  it("gives the release job's logins functions, not tables", async ({ skip }) => {
    if (!canRun) skip();
    await expect(releaseContext.db.query("select * from context.packs")).rejects.toThrow(/permission denied/);
    await expect(releaseContext.db.query("delete from context.packs")).rejects.toThrow(/permission denied/);
    await expect(control.query("select * from harness_runtime.runs")).rejects.toThrow(/permission denied/);
    await expect(control.query("update harness_runtime.runs set output = null")).rejects.toThrow(/permission denied/);
  });
});

function workItem(tenantId: string, caseId: string, runId: string, planDigest: string) {
  const timestamp = new Date().toISOString();
  return executionWorkItemSchema.parse({
    apiVersion: "harness.factory/execution-work-item-v1", kind: "ExecutionWorkItem", tenantId, caseId, workItemId: `wi-${randomUUID()}`,
    workType: "approval", capabilityId: "human.review", assuranceClass: "HIGH", revision: 0, caseSequenceBasis: 1,
    planDigest, policyContextRef: "policy", schemaVersion: "work.v1", objective: "Review Meridian Trade Holdings",
    subjectRefs: [], requiredOutputs: ["decision"], constraints: { runId, nodeId: NODE, note: "case content" }, dependencyIds: [], dependencyDigest: stableDigest([]),
    invalidationPolicy: "BLOCK", status: "HUMAN_REQUIRED", reasonCode: "review", priority: 10, readyAt: null, deadlineAt: null, terminalAt: null,
    dispatch: { generation: 0, queue: "human", publishedAt: null, brokerMessageId: null }, lease: null,
    limits: { maxAttempts: 3, maxReworkCycles: 2, maxDurationMs: 60000, maxCostUsd: 1, maxModelCalls: 1, maxCapabilityCalls: 1 },
    result: null, createdBy: { type: "SYSTEM", principalId: "test", roles: [] }, transitionSequence: 0, traceId: null, createdAt: timestamp, updatedAt: timestamp,
  });
}
