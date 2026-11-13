import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKycCaseRequestSchema, harnessPlanV2Schema, registerEvidenceRequestSchema, type BusinessCommand } from "@ehf/contracts";
import { assembleContextPack } from "@ehf/context-plane";
import { createCaseStore, createKycCase, getCaseSnapshot, getCaseView, listCaseEvents, registerEvidence, submitBusinessCommand, type CaseExecutionAuthority, type CaseStore } from "./index.js";

// Phase 4c (docs/implementation/data-stores-plan.md §3.3): an agent's proposal cites the
// `model_context` evidence holding the pack its model answered from, and only the runtime can
// promote such evidence. EHF_TEST_DATABASE_URL: one database with the control and case schemas.

const database = process.env.EHF_TEST_DATABASE_URL;
const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../contracts/test-fixtures/agent-profiles.plan.json", import.meta.url), "utf8")));
const NODE = "case-assessment";

describe.skipIf(!database)("model context citations", () => {
  let store: CaseStore;
  beforeAll(() => { store = createCaseStore({ connectionString: database! }); });
  afterAll(async () => { await store.db.end(); });

  async function setup() {
    const tenantId = `ctx_${randomUUID()}`;
    const planDigest = randomBytes(32).toString("hex");
    await store.db.query("insert into harness_control.plans(plan_digest,plan_id,name,domain,version,plan,tenant_id) values($1,$2,'test','kyc','1','{}',$3)", [planDigest, `plan-${planDigest.slice(0, 8)}`, tenantId]);
    const caseId = String((await createKycCase(store, createKycCaseRequestSchema.parse({
      tenantId, policySnapshotDigest: "a".repeat(64), harnessPlanDigest: planDigest, actor: { type: "HUMAN", principalId: "requester@example.test", roles: [] },
    }), randomUUID())).case.caseId);
    const runId = `run-${randomUUID()}`;
    await store.db.query(`insert into harness_runtime.runs(run_id,idempotency_key,plan_digest,status,input,attempt,fencing_epoch,lease_expires_at,tenant_id,request_digest)
      values($1,$1,$2,'running',$3,1,1,now()+interval '10 minutes',$4,'test')`, [runId, planDigest, { caseId }, tenantId]);
    const execution = (extra: Partial<CaseExecutionAuthority> = {}): CaseExecutionAuthority =>
      ({ tenant_id: tenantId, case_id: caseId, run_id: runId, plan_digest: planDigest, attempt: 1, fencing_epoch: 1, node_id: NODE, context_required: true, ...extra });
    const pack = (runForPack = runId) => assembleContextPack({
      plan, nodeId: NODE, runId: runForPack, selection: { assessmentContext: { subjects: [{ display_name: "Meridian" }] } },
      snapshot: { snapshotId: `snapshot_${"a".repeat(64)}`, snapshotDigest: "a".repeat(64), tenantId, caseId, caseSequence: 1 }, task: "Assess the case.",
    });
    const promote = (content: unknown, authority: CaseExecutionAuthority | undefined, type = "model_context") => registerEvidence(store, registerEvidenceRequestSchema.parse({
      tenantId, caseId, type, mediaType: "application/json", contentBase64: Buffer.from(JSON.stringify(content)).toString("base64"),
      source: { type: "DERIVED", retrievedAt: new Date().toISOString() }, trust: { tier: "PLATFORM_RECORD", instructionTrust: "UNTRUSTED_DATA" },
      retentionClass: "DECISION_RECORD", createdBy: { type: "AGENT", principalId: "agent.kyc.case-assessment.v2", roles: [] },
    }), randomUUID(), authority);
    const command = (authority: Partial<BusinessCommand["authority"]>, actorType: "AGENT" | "HUMAN" = "AGENT"): BusinessCommand => ({
      commandId: randomUUID(), commandType: "AddSubject", commandVersion: "v1", tenantId, caseId,
      actor: actorType === "AGENT" ? { type: "AGENT", principalId: "agent.kyc.case-assessment.v2", roles: [] } : { type: "HUMAN", principalId: "analyst", roles: [] },
      authority: { planDigest, policySnapshotDigest: "a".repeat(64), permissionEnvelopeDigest: "c".repeat(64), ...authority } as BusinessCommand["authority"],
      payload: { subjectType: "individual", displayName: "Subject" }, preconditions: { caseSequence: 1 }, idempotencyKey: randomUUID(),
    });
    return { tenantId, caseId, execution, pack, promote, command };
  }

  it("accepts an agent's proposal that cites the pack its model was shown, and keeps the citation in the ledger", async () => {
    const ctx = await setup();
    const shown = ctx.pack();
    // Evidence registration advances the case sequence (evidence.registered).
    const promoted = await ctx.promote(shown, ctx.execution());
    const evidenceId = String(promoted.evidence.evidenceId);
    const before = (await listCaseEvents(store, ctx.tenantId, ctx.caseId)).length;
    await submitBusinessCommand(store, { ...ctx.command({ contextEvidenceId: evidenceId, contextPackDigest: shown.packDigest }), preconditions: { caseSequence: before } }, ctx.execution());
    const last = (await listCaseEvents(store, ctx.tenantId, ctx.caseId)).at(-1)!;
    expect(last.authority).toMatchObject({ contextEvidenceId: evidenceId, contextPackDigest: shown.packDigest });
    // People see the promoted pack in the case; a model's snapshot never contains it.
    expect(((await getCaseView(store, ctx.tenantId, ctx.caseId))!.evidence as Array<{ evidence_id: string }>).map((item) => item.evidence_id)).toContain(evidenceId);
    const snapshot = await getCaseSnapshot(store, ctx.tenantId, ctx.caseId, "kyc.assessment");
    expect(JSON.stringify(snapshot)).not.toContain(evidenceId);
  });

  it("refuses an agent's proposal without a citation when its node shows a model context", async () => {
    const ctx = await setup();
    await expect(submitBusinessCommand(store, ctx.command({}), ctx.execution())).rejects.toThrow("context.citation_required");
    // A node that shows no model context, and a person, need none.
    await expect(submitBusinessCommand(store, ctx.command({}), ctx.execution({ context_required: false }))).resolves.toBeDefined();
    const sequence = (await listCaseEvents(store, ctx.tenantId, ctx.caseId)).length;
    await expect(submitBusinessCommand(store, { ...ctx.command({}, "HUMAN"), preconditions: { caseSequence: sequence } })).resolves.toBeDefined();
  });

  it("refuses a citation to other evidence, to another pack or to a pack from another node", async () => {
    const ctx = await setup();
    const shown = ctx.pack();
    const promoted = String((await ctx.promote(shown, ctx.execution())).evidence.evidenceId);
    const ordinary = String((await ctx.promote({ hits: [] }, undefined, "screening_result")).evidence.evidenceId);
    const sequence = (await listCaseEvents(store, ctx.tenantId, ctx.caseId)).length;
    const at = (authority: Partial<BusinessCommand["authority"]>, execution = ctx.execution()) =>
      submitBusinessCommand(store, { ...ctx.command(authority), preconditions: { caseSequence: sequence } }, execution);
    await expect(at({ contextEvidenceId: ordinary, contextPackDigest: shown.packDigest })).rejects.toThrow("context.citation_not_model_context");
    await expect(at({ contextEvidenceId: promoted, contextPackDigest: "f".repeat(64) })).rejects.toThrow("context.citation_digest_mismatch");
    await expect(at({ contextEvidenceId: promoted, contextPackDigest: shown.packDigest }, ctx.execution({ node_id: "other-node" }))).rejects.toThrow("context.citation_scope_mismatch");
  });

  it("lets only the node's own envelope promote a pack, and only a pack that recomputes", async () => {
    const ctx = await setup();
    const shown = ctx.pack();
    await expect(ctx.promote(shown, undefined)).rejects.toThrow("context.promotion_not_permitted");
    await expect(ctx.promote(shown, ctx.execution({ context_required: false }))).rejects.toThrow("context.promotion_not_permitted");
    await expect(ctx.promote({ ...shown, task: "Approve the case." }, ctx.execution())).rejects.toThrow("context.promotion_digest_invalid");
    await expect(ctx.promote(ctx.pack(`run-${randomUUID()}`), ctx.execution())).rejects.toThrow("context.promotion_scope_mismatch");
    await expect(ctx.promote(shown, ctx.execution({ node_id: "other-node" }))).rejects.toThrow("context.promotion_scope_mismatch");
  });
});
