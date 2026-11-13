import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createKycCaseRequestSchema,
  registerEvidenceRequestSchema,
  SKILL_PROPOSAL_COMMANDS,
  skillCommitRequestSchema,
  skillExecutionBindingDigest,
  type CanonicalRecord,
  type SkillCommitRequest,
  type SkillEffectReleaseRequest,
} from "@ehf/contracts";
import {
  createCaseStore,
  createKycCase,
  getCanonicalCaseSnapshot,
  registerEvidence,
  submitBusinessCommand,
  type CaseStore,
} from "./index.js";
import {
  assertSkillCommitWithinEnvelope,
  commitSkillExecution,
  listSkillEffects,
  releaseSkillEffects,
  type SkillCommitAuthority,
} from "./skill-commits.js";


function binding(executionId: string) {
  return {
    skillId: "ownership.ubo.resolve", skillVersion: "0.2.0", executionId,
    manifestDigest: "a".repeat(64), bundleDigest: `sha256:${"b".repeat(64)}`, receiptDigest: "c".repeat(64),
    requestDigest: "d".repeat(64), contextHash: "e".repeat(64), codeDigest: `sha256:${"f".repeat(64)}`, instructionsDigest: null,
  };
}

function request(overrides: Partial<SkillCommitRequest> & { executionId?: string } = {}): SkillCommitRequest {
  const { executionId = "inv-1", ...rest } = overrides;
  return skillCommitRequestSchema.parse({
    tenantId: "t1", caseId: "c1", binding: binding(executionId), effectMode: "proposal", approval: "none",
    commands: [], held: [], releaseNodeId: null, approvalNodeId: null, uncommitted: [], ...rest,
  });
}

const claims = (overrides: Partial<SkillCommitAuthority> = {}): SkillCommitAuthority => ({
  tenant_id: "t1", case_id: "c1", run_id: "run-1", node_id: "ubo-resolve", plan_digest: "a".repeat(64), permission_digest: "b".repeat(64),
  attempt: 1, fencing_epoch: 1, case_writes: [...SKILL_PROPOSAL_COMMANDS], ...overrides,
});

describe("skill commit authority (case API, before the store)", () => {
  it("refuses command types outside the envelope, held-only commands, forbidden commands and mismatched shapes", () => {
    const command = (localRef: string, commandType: SkillCommitRequest["commands"][number]["commandType"]) => ({ localRef, commandType, payload: {} });
    expect(() => assertSkillCommitWithinEnvelope(request({ commands: [command("record:a", "ProposeClaim")] }), claims())).not.toThrow();
    expect(() => assertSkillCommitWithinEnvelope(request({ commands: [command("record:a", "ProposeClaim")] }), claims({ case_writes: ["LinkEvidence"] })))
      .toThrow("authorization.command_not_declared");
    expect(() => assertSkillCommitWithinEnvelope(request({ commands: [command("effect:k", "FinalizeDisposition")], expectedCaseSequence: 1 }), claims({ case_writes: ["FinalizeDisposition"] })))
      .toThrow("skill_commit.command_forbidden");
    expect(() => assertSkillCommitWithinEnvelope(request({ commands: [command("effect:k", "RecordReview")], expectedCaseSequence: 1 }), claims({ case_writes: ["RecordReview"] })))
      .toThrow("skill_commit.command_forbidden");
    // A record maps only to a §6.2 command; a held command cannot be committed directly.
    expect(() => assertSkillCommitWithinEnvelope(request({ commands: [command("record:a", "TransitionCaseStatus")] }), claims({ case_writes: ["TransitionCaseStatus"] })))
      .toThrow("skill_commit.command_shape_invalid");
    expect(() => assertSkillCommitWithinEnvelope(request({ commands: [command("effect:k", "TransitionCaseStatus")], expectedCaseSequence: 1 }), claims({ case_writes: ["TransitionCaseStatus"], case_writes_held: ["TransitionCaseStatus"] })))
      .toThrow("skill_commit.command_held_only");
    const held = { effectKey: "k", type: "case_command" as const, commandType: "TransitionCaseStatus" as const, payload: {}, justificationRefs: [], expiresAt: "2099-01-01T00:00:00Z" };
    const holding = request({ held: [held], expectedCaseSequence: 1, releaseNodeId: "x-effects", approvalNodeId: "x-approval" });
    expect(() => assertSkillCommitWithinEnvelope(holding, claims())).toThrow("authorization.command_not_declared");
    expect(() => assertSkillCommitWithinEnvelope(holding, claims({ case_writes_held: ["TransitionCaseStatus"] }))).not.toThrow();
    expect(() => assertSkillCommitWithinEnvelope(request({ tenantId: "t2" }), claims())).toThrow("authorization.execution_scope_mismatch");
  });
});

const database = process.env.EHF_TEST_DATABASE_URL;

describe.skipIf(!database)("skill commit path in PostgreSQL", () => {
  async function setup(store: CaseStore) {
    const tenantId = `skills_${randomUUID()}`;
    const planDigest = randomBytes(32).toString("hex");
    const policy = "a".repeat(64);
    await store.db.query("insert into harness_control.plans(plan_digest,plan_id,name,domain,version,plan,tenant_id) values($1,$2,'test','kyb','1','{}',$3)", [planDigest, `plan-${planDigest.slice(0, 8)}`, tenantId]);
    const created = await createKycCase(store, createKycCaseRequestSchema.parse({
      tenantId, policySnapshotDigest: policy, harnessPlanDigest: planDigest, actor: { type: "HUMAN", principalId: "requester@example.test", roles: [] },
      policyAuthority: { policyId: "p", policyVersion: "1", policyBundleDigest: "c".repeat(64), dependencyDigest: "d".repeat(64) },
    }), randomUUID());
    const caseId = String(created.case.caseId);
    const runId = `run-${randomUUID()}`;
    await store.db.query(`insert into harness_runtime.runs(run_id,idempotency_key,plan_digest,status,input,attempt,fencing_epoch,lease_expires_at,tenant_id,request_digest)
      values($1,$1,$2,'running',$3,1,1,now()+interval '10 minutes',$4,'test')`, [runId, planDigest, { caseId }, tenantId]);
    const authority = (nodeId: string, extra: Partial<SkillCommitAuthority> = {}): SkillCommitAuthority => ({
      tenant_id: tenantId, case_id: caseId, run_id: runId, node_id: nodeId, plan_digest: planDigest, permission_digest: "b".repeat(64),
      attempt: 1, fencing_epoch: 1, case_writes: [...SKILL_PROPOSAL_COMMANDS], ...extra,
    });
    const evidence = async (executionId: string) => {
      const registered = await registerEvidence(store, registerEvidenceRequestSchema.parse({
        tenantId, caseId, type: "skill_computation", mediaType: "application/json",
        contentBase64: Buffer.from(JSON.stringify({ executionId })).toString("base64"),
        source: { type: "DERIVED", capability: "skills:ownership.ubo.resolve", retrievedAt: "2026-11-07T12:00:00Z" },
        trust: { tier: "SKILL_COMPUTATION", instructionTrust: "UNTRUSTED_DATA" },
        createdBy: { type: "AGENT", principalId: "skills:ownership.ubo.resolve@0.2.0", roles: [] },
      }), `skill:${executionId}:evidence`);
      return String(registered.evidence.evidenceId);
    };
    const sequence = async () => Number((await store.db.query("select case_sequence from case_core.cases where tenant_id=$1 and case_id=$2", [tenantId, caseId])).rows[0].case_sequence);
    return { tenantId, caseId, runId, authority, evidence, sequence };
  }

  const owner = (version: string) => ({
    object_type: "BeneficialOwner", object_id: "ubo:person-1", version_id: version,
    data: { entity_id: "person-1", evidence_ids: ["ev-registry"], interest: 0.4 },
    observed_at: "2026-11-07T11:00:00Z", source_refs: [], classification: "CONFIDENTIAL", synthetic: true,
    provenance: { method: "skill_proposal", skill_id: "ownership.ubo.resolve", skill_version: "0.2.0", execution_id: "inv", receipt_digest: "c".repeat(64) },
  });

  it("commits every record type atomically with an AGENT actor attributed to the skill, replays without duplicates and feeds the next snapshot", async () => {
    const store = createCaseStore({ connectionString: database! });
    try {
      const { tenantId, caseId, authority, evidence } = await setup(store);
      const evidenceId = await evidence("inv-records");
      const commit = request({
        tenantId, caseId, executionId: "inv-records",
        commands: [
          { localRef: "evidence", commandType: "LinkEvidence", payload: { evidenceId, purpose: "SKILL_COMPUTATION" } },
          { localRef: "record:a1", commandType: "ProposeClaim", payload: { claimId: "claim_skill_1", predicate: "ubo_count", value: 1, evidenceRefs: [evidenceId] } },
          { localRef: "record:f1", commandType: "RecordScreeningFinding", payload: { findingId: "finding_skill_1", findingType: "UBO_IDENTIFIED", reason: "40% holder", evidenceRefs: [evidenceId], factRefs: [] } },
          { localRef: "record:c1", commandType: "RaiseContradiction", payload: { contradictionId: "contradiction_skill_1", objectRefs: ["entity:A", "entity:B"], description: "Names differ", materiality: "LOW", detectionMethod: "skill:ownership.ubo.resolve@0.2.0" } },
          { localRef: "record:q1", commandType: "ProposeWorkItem", payload: { workItemId: "work_skill_1", workType: "SKILL_UNRESOLVED_QUESTION", description: "Who controls the trust?" } },
          { localRef: "record:bo", commandType: "RecordCanonicalRecords", payload: { records: [owner("v1")], evidenceRefs: [evidenceId] } },
        ],
        uncommitted: [{ localRef: "h1", recordType: "Hypothesis", reason: "record_type_not_committed" }],
      });
      const first = await commitSkillExecution(store, commit, authority("ubo-resolve"));
      expect(first).toMatchObject({ outcome: "ACCEPTED", executionId: "inv-records", bindingDigest: skillExecutionBindingDigest(commit.binding) });
      expect((first.commands as unknown[]).length).toBe(6);
      const claim = (await store.db.query("select status, asserted_by from case_core.case_claims where tenant_id=$1 and case_id=$2", [tenantId, caseId])).rows;
      expect(claim).toEqual([{ status: "PROPOSED", asserted_by: { type: "AGENT", principalId: "skills:ownership.ubo.resolve@0.2.0", executionId: authority("x").run_id, roles: [] } }]);
      expect((await store.db.query("select status from case_core.case_contradictions where tenant_id=$1 and case_id=$2", [tenantId, caseId])).rows).toEqual([{ status: "OPEN" }]);
      expect((await store.db.query("select status from case_core.case_work_items where tenant_id=$1 and case_id=$2", [tenantId, caseId])).rows).toEqual([{ status: "OPEN" }]);
      expect((await store.db.query("select finding_type from case_core.case_findings where tenant_id=$1 and case_id=$2", [tenantId, caseId])).rows).toEqual([{ finding_type: "UBO_IDENTIFIED" }]);
      const events = (await store.db.query("select event_type, payload from case_ledger.case_events where tenant_id=$1 and case_id=$2 order by case_sequence", [tenantId, caseId])).rows;
      const summary = events.find((event) => event.event_type === "skill.execution.committed")!;
      expect(summary.payload).toMatchObject({ skillId: "ownership.ubo.resolve", executionId: "inv-records", receiptDigest: "c".repeat(64), uncommitted: [{ recordType: "Hypothesis" }] });
      expect(events.find((event) => event.event_type === "work_item.created")!.payload.description).toBe("Who controls the trust?");

      // The next node's snapshot selects the committed version.
      const snapshot = await getCanonicalCaseSnapshot(store, tenantId, caseId, "KYB_ONBOARDING");
      const owners = (snapshot!.data.records as Record<string, CanonicalRecord[]>).BeneficialOwner!;
      expect(owners.map((record) => [record.object_id, record.version_id, record.provenance.method])).toEqual([["ubo:person-1", "v1", "skill_proposal"]]);

      // A replayed node attempt changes nothing; a different output under the same execution is refused.
      const replay = await commitSkillExecution(store, commit, authority("ubo-resolve"));
      expect(replay).toMatchObject({ replayed: true, caseSequence: first.caseSequence });
      expect((await store.db.query("select count(*)::int n from case_core.case_claims where tenant_id=$1 and case_id=$2", [tenantId, caseId])).rows[0].n).toBe(1);
      expect((await store.db.query("select set_config('app.tenant_id',$1,false), (select count(*)::int from case_core.canonical_records where tenant_id=$1 and case_id=$2) n", [tenantId, caseId])).rows[0].n).toBe(1);
      await expect(commitSkillExecution(store, { ...commit, uncommitted: [] }, authority("ubo-resolve"))).rejects.toThrow("skill_commit.idempotency_conflict");

      // All or nothing: one bad command (unlinked evidence) leaves no trace of the rest.
      const before = Number((await store.db.query("select case_sequence from case_core.cases where tenant_id=$1 and case_id=$2", [tenantId, caseId])).rows[0].case_sequence);
      await expect(commitSkillExecution(store, request({
        tenantId, caseId, executionId: "inv-partial",
        commands: [
          { localRef: "record:bo", commandType: "RecordCanonicalRecords", payload: { records: [owner("v2")], evidenceRefs: [evidenceId] } },
          { localRef: "record:a1", commandType: "ProposeClaim", payload: { predicate: "x", value: 1, evidenceRefs: ["evidence_not_linked"] } },
        ],
      }), authority("ubo-resolve"))).rejects.toThrow("evidence.not_linked");
      expect(Number((await store.db.query("select case_sequence from case_core.cases where tenant_id=$1 and case_id=$2", [tenantId, caseId])).rows[0].case_sequence)).toBe(before);
      const after = await getCanonicalCaseSnapshot(store, tenantId, caseId, "KYB_ONBOARDING");
      expect((after!.data.records as Record<string, CanonicalRecord[]>).BeneficialOwner!.map((record) => record.version_id)).toEqual(["v1"]);
    } finally { await store.db.end(); }
  });

  it("commits an immediate case_command effect only at the case sequence the skill computed against", async () => {
    const store = createCaseStore({ connectionString: database! });
    try {
      const { tenantId, caseId, authority, sequence } = await setup(store);
      const grant = authority("case-transition", { case_writes: ["TransitionCaseStatus"] });
      const effect = (executionId: string, expectedCaseSequence: number) => request({
        tenantId, caseId, executionId, effectMode: "internal_write", expectedCaseSequence,
        commands: [{ localRef: "effect:to-validating", commandType: "TransitionCaseStatus", payload: { toStatus: "VALIDATING", reason: "skill" } }],
      });
      await expect(commitSkillExecution(store, effect("inv-stale", (await sequence()) - 1), grant)).rejects.toThrow("skill_commit.case_sequence_stale");
      await commitSkillExecution(store, effect("inv-current", await sequence()), grant);
      expect((await store.db.query("select status from case_core.cases where tenant_id=$1 and case_id=$2", [tenantId, caseId])).rows[0].status).toBe("VALIDATING");
    } finally { await store.db.end(); }
  });

  function held(effectKey: string, extra: Record<string, unknown>) {
    return { effectKey, payload: {}, justificationRefs: [], expiresAt: new Date(Date.now() + 86_400_000).toISOString(), ...extra };
  }

  async function hold(store: CaseStore, ctx: Awaited<ReturnType<typeof setup>>, executionId: string) {
    const commit = request({
      tenantId: ctx.tenantId, caseId: ctx.caseId, executionId, effectMode: "external_write", approval: "required",
      expectedCaseSequence: await ctx.sequence(), releaseNodeId: "close-effects", approvalNodeId: "close-approval",
      held: [
        held("to-validating", { type: "case_command", commandType: "TransitionCaseStatus", payload: { toStatus: "VALIDATING", reason: "approved skill effect" } }),
        held("file", { type: "external_action", action: "regulatory.filing.submit", payload: { filing: "SAR" } }),
        held("delete", { type: "external_action", action: "evidence.retention.delete", payload: { artifact: "a" } }),
      ] as unknown as SkillCommitRequest["held"],
    });
    const response = await commitSkillExecution(store, commit, ctx.authority("close", { case_writes: [], case_writes_held: ["TransitionCaseStatus"] }));
    return { commit, response, bindingDigest: String(response.bindingDigest) };
  }

  const release = (ctx: Awaited<ReturnType<typeof setup>>, executionId: string, bindingDigest: string, decision: Partial<SkillEffectReleaseRequest["decision"]> = {}): SkillEffectReleaseRequest => ({
    tenantId: ctx.tenantId, caseId: ctx.caseId, executionId, skillNodeId: "close", approvalNodeId: "close-approval", bindingDigest,
    decision: { decision: "APPROVE", authority: "HUMAN", decisionIds: ["decision-1"], reviewerPrincipalIds: ["reviewer@example.test"], ...decision },
    routedActions: ["regulatory.filing.submit"],
  });

  it("holds an approval-required skill's effects, then commits them, queues the routed external action and keeps the unrouted one as NO_ROUTE", async () => {
    const store = createCaseStore({ connectionString: database! });
    try {
      const ctx = await setup(store);
      const { bindingDigest } = await hold(store, ctx, "inv-held");
      expect((await store.db.query("select status from case_core.cases where tenant_id=$1 and case_id=$2", [ctx.tenantId, ctx.caseId])).rows[0].status).toBe("INTAKE");
      expect((await listSkillEffects(store, ctx.tenantId, ctx.caseId)).map((effect) => effect.status)).toEqual(["HELD", "HELD", "HELD"]);
      const releaser = ctx.authority("close-effects", { case_writes: [], case_writes_held: ["TransitionCaseStatus"] });
      // Only the release node may release; the binding must be the approved one; the requester cannot approve.
      await expect(releaseSkillEffects(store, release(ctx, "inv-held", bindingDigest), ctx.authority("close", { case_writes_held: ["TransitionCaseStatus"] })))
        .rejects.toThrow("authorization.skill_release_node_mismatch");
      await expect(releaseSkillEffects(store, release(ctx, "inv-held", "0".repeat(64)), releaser)).rejects.toThrow("skill_release.binding_mismatch");
      await expect(releaseSkillEffects(store, release(ctx, "inv-held", bindingDigest, { reviewerPrincipalIds: ["requester@example.test"] }), releaser))
        .rejects.toThrow("skill_release.approval_not_independent");
      await expect(releaseSkillEffects(store, release(ctx, "inv-held", bindingDigest, { reviewerPrincipalIds: [] }), releaser)).rejects.toThrow("skill_release.approval_unverifiable");
      await expect(releaseSkillEffects(store, release(ctx, "inv-held", bindingDigest), ctx.authority("close-effects", { case_writes_held: [] })))
        .rejects.toThrow("authorization.command_not_declared");

      const released = await releaseSkillEffects(store, release(ctx, "inv-held", bindingDigest), releaser);
      expect(released.httpStatus).toBe(200);
      expect((released.body.effects as Array<{ effectKey: string; status: string }>).map((effect) => [effect.effectKey, effect.status]))
        .toEqual([["to-validating", "COMMITTED"], ["file", "QUEUED"], ["delete", "NO_ROUTE"]]);
      expect((await store.db.query("select status from case_core.cases where tenant_id=$1 and case_id=$2", [ctx.tenantId, ctx.caseId])).rows[0].status).toBe("VALIDATING");
      const outbox = (await store.db.query("select event_type from case_ledger.outbox where tenant_id=$1 and case_id=$2 order by case_sequence", [ctx.tenantId, ctx.caseId])).rows.map((row) => row.event_type);
      expect(outbox).toContain("external_action.regulatory.filing.submit");
      expect(outbox).not.toContain("external_action.evidence.retention.delete");
      expect(outbox.at(-1)).toBe("skill.effects.released");
      expect((await listSkillEffects(store, ctx.tenantId, ctx.caseId)).map((effect) => [effect.effectKey, effect.status]))
        .toEqual([["to-validating", "COMMITTED"], ["file", "QUEUED"], ["delete", "NO_ROUTE"]]);
      // Replaying the release changes nothing.
      expect((await releaseSkillEffects(store, release(ctx, "inv-held", bindingDigest), releaser)).body).toMatchObject({ replayed: true, outcome: "RELEASED" });
    } finally { await store.db.end(); }
  });

  it("discards held effects on a rejection, with an audit event", async () => {
    const store = createCaseStore({ connectionString: database! });
    try {
      const ctx = await setup(store);
      const { bindingDigest } = await hold(store, ctx, "inv-rejected");
      const result = await releaseSkillEffects(store, release(ctx, "inv-rejected", bindingDigest, { decision: "REJECT", reviewerPrincipalIds: [], reasonCode: "not_supported" }),
        ctx.authority("close-effects", { case_writes: [], case_writes_held: ["TransitionCaseStatus"] }));
      expect(result.body).toMatchObject({ outcome: "DISCARDED", discarded: ["to-validating", "file", "delete"] });
      expect((await store.db.query("select status from case_core.cases where tenant_id=$1 and case_id=$2", [ctx.tenantId, ctx.caseId])).rows[0].status).toBe("INTAKE");
      expect((await listSkillEffects(store, ctx.tenantId, ctx.caseId)).every((effect) => effect.status === "DISCARDED")).toBe(true);
      const last = (await store.db.query("select event_type, payload from case_ledger.case_events where tenant_id=$1 and case_id=$2 order by case_sequence desc limit 1", [ctx.tenantId, ctx.caseId])).rows[0];
      expect(last).toMatchObject({ event_type: "skill.effects.discarded", payload: { approval: { decision: "REJECT", reasonCode: "not_supported" } } });
    } finally { await store.db.end(); }
  });

  it("refuses an approved release when the case changed since the hold, or the approval came after the expiry", async () => {
    const store = createCaseStore({ connectionString: database! });
    try {
      const ctx = await setup(store);
      const releaser = ctx.authority("close-effects", { case_writes: [], case_writes_held: ["TransitionCaseStatus"] });
      const stale = await hold(store, ctx, "inv-stale");
      // Something else writes to the case while the reviewers look at the proposal.
      await submitBusinessCommand(store, {
        commandId: randomUUID(), commandType: "AddSubject", commandVersion: "v1", tenantId: ctx.tenantId, caseId: ctx.caseId,
        actor: { type: "HUMAN", principalId: "analyst@example.test", roles: [] },
        authority: { planDigest: ctx.authority("x").plan_digest, permissionEnvelopeDigest: "b".repeat(64), policySnapshotDigest: "a".repeat(64) },
        payload: { subjectType: "individual" }, preconditions: { caseSequence: await ctx.sequence() }, idempotencyKey: randomUUID(),
      });
      const refused = await releaseSkillEffects(store, release(ctx, "inv-stale", stale.bindingDigest), releaser);
      expect(refused).toMatchObject({ httpStatus: 409, body: { error: "skill_release.case_sequence_stale" } });
      expect((await store.db.query("select status from case_core.cases where tenant_id=$1 and case_id=$2", [ctx.tenantId, ctx.caseId])).rows[0].status).toBe("INTAKE");
      expect((await listSkillEffects(store, ctx.tenantId, ctx.caseId)).filter((effect) => effect.executionId === "inv-stale").every((effect) => effect.status === "STALE")).toBe(true);

      const late = await hold(store, ctx, "inv-late");
      const expired = await releaseSkillEffects(store, release(ctx, "inv-late", late.bindingDigest), releaser, () => Date.now() + 2 * 86_400_000);
      expect(expired).toMatchObject({ httpStatus: 409, body: { error: "skill_release.approval_expired" } });
      expect((await listSkillEffects(store, ctx.tenantId, ctx.caseId)).filter((effect) => effect.executionId === "inv-late").every((effect) => effect.status === "EXPIRED")).toBe(true);
    } finally { await store.db.end(); }
  });
});
