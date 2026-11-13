import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalRecordDigest,
  harnessPlanV2Schema,
  recordCanonicalRecordsPayloadSchema,
  skillCapabilityInputV1Schema,
  skillCommitRequestSchema,
  skillEffectReleaseRequestSchema,
  skillExecutionBindingDigest,
  stableDigest,
  type CanonicalRecord,
  type SkillCommitRequest,
} from "@ehf/contracts";
import type { RuntimeContext } from "@ehf/runtime-core";
import { lowerHarnessPlanV2, type V2ExecutionAdapters } from "./index.js";

// packages/contracts/test-fixtures/skill-commit: ubo-propose (proposal) → ubo-review (reads
// records.BeneficialOwner) → case-close (internal_write, approval required) → approval → release.
const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../contracts/test-fixtures/skill-commit.plan.json", import.meta.url), "utf8")));
const tenantId = "tenant-1";
const caseId = "case-1";
const capturedAt = "2026-11-07T12:00:00.000Z";
const binding = (skillId: string) => plan.skillBindings!.find((item) => item.skillId === skillId)!;

/** A case API standing in for the case store: it keeps the records skill commits add and replays by execution. */
function fakeCaseStore() {
  const records: Record<string, CanonicalRecord[]> = {};
  const commits = new Map<string, { digest: string; response: Record<string, unknown> }>();
  const requests: SkillCommitRequest[] = [];
  const releases: Array<Record<string, unknown>> = [];
  let sequence = 4;
  let releaseAnswer: { status: number; body: Record<string, unknown> } | null = null;
  const snapshot = () => {
    const canonical = {
      apiVersion: "harness.factory/case-snapshot-v1" as const, kind: "CaseSnapshot" as const, tenantId, caseId, caseSequence: sequence,
      dependencyDigest: "c".repeat(64), planDigest: plan.planDigest,
      policyAuthority: { policyId: "policy.synthetic.neutral", policyVersion: "0.1.0", policySnapshotDigest: "d".repeat(64), policyBundleDigest: "e".repeat(64) },
      consistency: "strong" as const, classification: "CONFIDENTIAL",
      data: {
        case: { caseId },
        subjects: [{ subject_id: "S-1", display_name: "Meridian Trade Holdings Ltd", attributes: { country: "GB" } }],
        ...(Object.keys(records).length ? { records: structuredClone(records), recordsAsOf: { asOf: capturedAt, knowledgeCutoff: capturedAt } } : {}),
      },
    };
    const snapshotDigest = stableDigest(canonical);
    return { ...canonical, snapshotId: `snapshot_${snapshotDigest}`, snapshotDigest, capturedAt };
  };
  const commit = (raw: unknown) => {
    const request = skillCommitRequestSchema.parse(raw);
    requests.push(request);
    const digest = stableDigest(request);
    const prior = commits.get(request.binding.executionId);
    if (prior) {
      if (prior.digest !== digest) return { status: 409, body: { error: "skill_commit.idempotency_conflict" } };
      return { status: 200, body: { ...prior.response, replayed: true } };
    }
    if (request.expectedCaseSequence !== undefined && request.expectedCaseSequence !== sequence) {
      return { status: 409, body: { error: "skill_commit.case_sequence_stale", expected: request.expectedCaseSequence, current: sequence } };
    }
    const commands = request.commands.map((command) => {
      sequence += 1;
      if (command.commandType === "RecordCanonicalRecords") {
        for (const item of recordCanonicalRecordsPayloadSchema.parse(command.payload).records) {
          const record = { schema_version: "1.0.0", subject_ids: [], valid_from: null, valid_to: null, purposes: [], ...item, tenant_id: tenantId, case_id: caseId, supersedes: null };
          (records[item.object_type] ??= []).push({ ...record, recorded_at: capturedAt, record_digest: canonicalRecordDigest(record) } as CanonicalRecord);
        }
      }
      const ids: Record<string, string> = {};
      for (const key of ["claimId", "findingId", "contradictionId", "workItemId"]) if (typeof command.payload[key] === "string") ids[key] = command.payload[key] as string;
      return { localRef: command.localRef, commandType: command.commandType, caseSequence: sequence, createdIdentifiers: ids };
    });
    sequence += 1;
    const response = { outcome: "ACCEPTED", caseId, caseSequence: sequence, executionId: request.binding.executionId, bindingDigest: skillExecutionBindingDigest(request.binding),
      commands, held: request.held.map((effect) => ({ effectKey: effect.effectKey, status: "HELD" })) };
    commits.set(request.binding.executionId, { digest, response });
    return { status: 200, body: response };
  };
  return {
    records, requests, releases, snapshot, commit,
    answerRelease(answer: { status: number; body: Record<string, unknown> }) { releaseAnswer = answer; },
    release(raw: unknown) {
      const request = skillEffectReleaseRequestSchema.parse(raw);
      releases.push(request);
      if (releaseAnswer) return releaseAnswer;
      return request.decision.decision === "REJECT"
        ? { status: 200, body: { outcome: "DISCARDED", executionId: request.executionId, discarded: ["close"] } }
        : { status: 200, body: { outcome: "RELEASED", executionId: request.executionId, effects: [{ effectKey: "close", type: "case_command", status: "COMMITTED" }] } };
    },
  };
}

function harness(store: ReturnType<typeof fakeCaseStore>, gateway: (capabilityId: string, body: Record<string, unknown>) => Record<string, unknown>, snapshotFor: () => unknown = store.snapshot) {
  const events: Array<{ code: string; values: Record<string, unknown> }> = [];
  const invocations: Array<Record<string, unknown>> = [];
  const evidence: Array<{ key: string | null; body: Record<string, unknown> }> = [];
  const context: RuntimeContext = {
    state: { nodeStarted: async () => {}, nodeFinished: async () => {}, appendEvent: async (_run, event) => { events.push(event); }, markCheckpoint: async () => {} },
    plan, runId: "RUN-S", runAttempt: 1, workerId: "worker-1", fencingEpoch: 1,
    gatewayUrl: "http://gateway", caseApiUrl: "http://case", envelopeBrokerUrl: "http://control", executionGrant: "grant", serviceToken: "service-token",
  };
  const adapters: V2ExecutionAdapters = { loadCaseSnapshot: async () => snapshotFor(), evaluateGate: async () => { throw new Error("unused"); } };
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const target = String(url);
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const headers = new Headers(init.headers);
    if (target.includes("/v1/runtime/envelopes")) return Response.json({ envelope: "envelope", expiresInSeconds: 60, caseWrites: [] });
    if (target.includes("/v1/evidence:register")) {
      evidence.push({ key: headers.get("idempotency-key"), body });
      return Response.json({ evidence: { evidenceId: `ev_${stableDigest(headers.get("idempotency-key")).slice(0, 8)}` } });
    }
    if (target.endsWith("/skill-commits")) {
      expect(headers.get("x-execution-envelope")).toBe("envelope");
      const answer = store.commit(body);
      return Response.json(answer.body, { status: answer.status });
    }
    if (target.endsWith("/release")) {
      const answer = store.release(body);
      return Response.json(answer.body, { status: answer.status });
    }
    invocations.push(body);
    return Response.json({
      invocationId: body.invocationId, capabilityId: body.capabilityId, errorCode: null, provider: "skill-host:test", model: null, providerRequestId: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null }, latencyMs: 1, receiptDigest: "f".repeat(64), status: "succeeded",
      ...gateway(String(body.capabilityId), body),
    });
  }) as typeof globalThis.fetch;
  const run = (nodeId: string, values: Record<string, unknown> = {}) =>
    lowerHarnessPlanV2(plan, context, adapters, undefined, nodeId).invoke({ input: { tenantId, caseId }, values }) as Promise<{ values: Record<string, unknown> }>;
  return { events, invocations, evidence, run };
}

const metrics = { duration_ms: 3, capability_calls: 0, model_calls: 0 };
function output(skillId: string, body: Record<string, unknown>, computation: Record<string, unknown>) {
  const pinned = binding(skillId);
  return { output: {
    contract_version: "skill.execution.v1", execution_id: String(body.invocationId), skill_id: skillId, skill_version: pinned.semver,
    bundle_digest: pinned.bundleDigest, manifest_digest: pinned.manifestDigest, effect_mode: pinned.effects!.mode, lifecycle: "COMPLETED_EXECUTION",
    computation: { business_status: "COMPLETED", payload: {}, proposed_records: [], unresolved_items: [], negative_searches: [], requested_effects: [], metrics, ...computation },
    error: null, trace: { code_digest: `sha256:${"9".repeat(64)}`, instructions_digest: null, subskill_executions: [] }, dependency_receipts: [],
  } };
}

const beneficialOwner = {
  record_type: "CanonicalRecord", local_ref: "bo-1",
  body: {
    object_type: "BeneficialOwner", object_id: "ubo:person-1", version_id: "v-1",
    data: { entity_id: "person-1", interest: 0.4, evidence_ids: ["ev-ownership"] },
    observed_at: "2026-11-07T11:00:00.000Z", source_refs: [], classification: "CONFIDENTIAL", synthetic: true,
  },
  evidence: [{ section_id: "subjects", content_digest: `sha256:${"a".repeat(64)}` }],
};

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

describe("hosted skill output → case state → the next skill's context", () => {
  it("commits skill A's BeneficialOwner record so skill B's records.BeneficialOwner selector receives it in the same run", async () => {
    const store = fakeCaseStore();
    const proposer = harness(store, (_capability, body) => output("sample.ubo.propose", body, {
      payload: { owners: 1 },
      proposed_records: [
        beneficialOwner,
        { record_type: "Finding", local_ref: "f1", body: { finding_type: "UBO_IDENTIFIED", reason: "person-1 holds 40%." }, evidence: [] },
        { record_type: "Hypothesis", local_ref: "h1", body: { guess: "nominee" }, evidence: [] },
      ],
    }));
    const proposed = await proposer.run("ubo-propose");
    // One commit for the node attempt: the evidence link, the records, nothing for the hypothesis.
    expect(store.requests).toHaveLength(1);
    const commit = store.requests[0]!;
    expect(commit.commands.map((command) => [command.localRef, command.commandType])).toEqual([
      ["evidence", "LinkEvidence"], ["record:bo-1", "RecordCanonicalRecords"], ["record:f1", "RecordScreeningFinding"],
    ]);
    expect(commit.uncommitted).toEqual([{ localRef: "h1", recordType: "Hypothesis", reason: "record_type_not_committed" }]);
    expect(commit.expectedCaseSequence).toBeUndefined();
    expect(commit.binding).toMatchObject({ skillId: "sample.ubo.propose", receiptDigest: "f".repeat(64), codeDigest: `sha256:${"9".repeat(64)}` });
    const recordPayload = recordCanonicalRecordsPayloadSchema.parse(commit.commands[1]!.payload);
    expect(recordPayload.records[0]!.provenance).toEqual({
      method: "skill_proposal", skill_id: "sample.ubo.propose", skill_version: "0.1.0", execution_id: commit.binding.executionId,
      receipt_digest: "f".repeat(64), manifest_digest: binding("sample.ubo.propose").manifestDigest, connector_id: "skills:sample.ubo.propose",
    });
    expect(recordPayload.evidenceRefs).toEqual([commit.commands[0]!.payload.evidenceId]);
    expect(proposer.evidence[0]).toMatchObject({ key: `skill:${commit.binding.executionId}:evidence`, body: { type: "skill_computation" } });
    expect(proposed.values["ubo-propose"]).toMatchObject({ __skillCommit: { executionId: commit.binding.executionId, held: [], replayed: false } });
    expect(proposer.events.find((event) => event.code === "skill.commit.completed")?.values).toMatchObject({ committed: ["LinkEvidence", "RecordCanonicalRecords", "RecordScreeningFinding"], uncommitted: ["Hypothesis"] });

    // Skill B: its record selector reads what skill A committed.
    const reviewer = harness(store, (_capability, body) => {
      const input = skillCapabilityInputV1Schema.parse(body.input);
      const section = input.context.sections.find((item) => item.id === "recBeneficialOwner")!;
      return output("sample.ubo.review", body, { payload: { reviewed: (section.value as unknown[]).length } });
    });
    const reviewed = await reviewer.run("ubo-review");
    expect(reviewer.invocations).toHaveLength(1);
    const sent = skillCapabilityInputV1Schema.parse(reviewer.invocations[0]!.input);
    const section = sent.context.sections.find((item) => item.id === "recBeneficialOwner")!;
    expect(section.value).toEqual([expect.objectContaining({ object_id: "ubo:person-1", data: expect.objectContaining({ entity_id: "person-1", interest: 0.4 }), provenance: expect.objectContaining({ method: "skill_proposal" }) })]);
    expect(sent.context.missing).toEqual([]);
    expect(reviewed.values["ubo-review"]).toMatchObject({ computation: { payload: { reviewed: 1 } } });
    // A read-only skill commits nothing.
    expect(store.requests).toHaveLength(1);
  });

  it("does not call skill B before skill A's record exists (NEEDS_EVIDENCE), and replays skill A's commit without duplicates", async () => {
    const store = fakeCaseStore();
    const early = harness(store, () => { throw new Error("must not be called"); });
    expect((await early.run("ubo-review")).values["ubo-review"]).toMatchObject({ status: "NEEDS_EVIDENCE", code: "CONTEXT_MISSING" });
    // A replay of the same node attempt sees the same context, so it is the same skill execution.
    const frozen = store.snapshot();
    const proposer = harness(store, (_capability, body) => output("sample.ubo.propose", body, { proposed_records: [beneficialOwner] }), () => frozen);
    await proposer.run("ubo-propose");
    const again = await proposer.run("ubo-propose");
    expect(store.requests).toHaveLength(2);
    expect(stableDigest(store.requests[0])).toBe(stableDigest(store.requests[1]));
    expect(store.records.BeneficialOwner).toHaveLength(1);
    expect(again.values["ubo-propose"]).toMatchObject({ __skillCommit: { replayed: true } });
  });

  it("fails the node on a stale case sequence, an ungranted or forbidden effect, and journals the refusal", async () => {
    const store = fakeCaseStore();
    const stale = harness(store, (_capability, body) => output("sample.case.close", body, {
      requested_effects: [{ type: "case_command", command_type: "TransitionCaseStatus", idempotency_key: "close", payload: { toStatus: "CLOSED", reason: "r", expected_case_sequence: 3 }, justification_refs: [] }],
    }));
    await expect(stale.run("case-close")).rejects.toThrow("skill_commit.case_sequence_stale");
    expect(stale.events.find((event) => event.code === "skill.commit.failed")?.values).toMatchObject({ errorCode: "skill_commit.case_sequence_stale" });
    const forbidden = harness(store, (_capability, body) => output("sample.case.close", body, {
      requested_effects: [{ type: "case_command", command_type: "RecordReview", idempotency_key: "review", payload: {}, justification_refs: [] }],
    }));
    await expect(forbidden.run("case-close")).rejects.toThrow("skill.commit_effect_forbidden:RecordReview");
    const ungranted = harness(store, (_capability, body) => output("sample.case.close", body, {
      requested_effects: [{ type: "case_command", command_type: "RequestHumanReview", idempotency_key: "rhr", payload: {}, justification_refs: [] }],
    }));
    await expect(ungranted.run("case-close")).rejects.toThrow("skill.commit_effect_not_granted:RequestHumanReview");
    // An output whose effect mode is not the plan's pin (a registry entry changed since compile) commits nothing.
    const unpinned = harness(store, (_capability, body) => {
      const answer = output("sample.ubo.propose", body, { proposed_records: [beneficialOwner] });
      return { output: { ...answer.output, effect_mode: "internal_write" } };
    });
    await expect(unpinned.run("ubo-propose")).rejects.toThrow("skill.commit_effect_mode_unpinned");
    expect(unpinned.evidence).toEqual([]);
    expect(store.requests.map((request) => request.binding.skillId)).toEqual(["sample.case.close"]);
  });

  it("holds an approval-required skill's effect, then the release node commits it on APPROVE and discards it on REJECT", async () => {
    const store = fakeCaseStore();
    const closer = harness(store, (_capability, body) => output("sample.case.close", body, {
      business_status: "NEEDS_REVIEW", unresolved_items: [{ code: "HUMAN_REVIEW_REQUIRED", subject_ref: "subject:S-1", explanation: "Closing needs approval." }],
      requested_effects: [{ type: "case_command", command_type: "TransitionCaseStatus", idempotency_key: "close", payload: { toStatus: "SUSPENDED", reason: "skill" }, justification_refs: [] }],
    }));
    const closed = await closer.run("case-close");
    const commit = store.requests.at(-1)!;
    expect(commit.commands).toEqual([]);
    expect(commit).toMatchObject({ approval: "required", expectedCaseSequence: 4, releaseNodeId: "case-close-effects", approvalNodeId: "case-close-approval" });
    expect(commit.held).toEqual([expect.objectContaining({ effectKey: "close", type: "case_command", commandType: "TransitionCaseStatus", payload: { toStatus: "SUSPENDED", reason: "skill" } })]);
    expect(closer.events.find((event) => event.code === "skill.commit.held")).toBeTruthy();
    const skillValue = closed.values["case-close"];

    // The durable human work queue's approval output, as the worker commits it.
    const approval = { decision: "APPROVE", authority: "HUMAN", decisionIds: ["decision-1"], reviewerPrincipalId: "reviewer@example.test", reviewerPrincipalIds: ["reviewer@example.test"], reasonCode: "approved" };
    const releaser = harness(store, () => { throw new Error("no capability"); });
    const released = await releaser.run("case-close-effects", { "case-close": skillValue, "case-close-approval": approval });
    expect(store.releases.at(-1)).toEqual({
      tenantId, caseId, executionId: commit.binding.executionId, skillNodeId: "case-close", approvalNodeId: "case-close-approval",
      bindingDigest: skillExecutionBindingDigest(commit.binding),
      decision: { decision: "APPROVE", authority: "HUMAN", decisionIds: ["decision-1"], reviewerPrincipalIds: ["reviewer@example.test"], reasonCode: "approved" },
      routedActions: [],
    });
    expect(released.values["case-close-effects"]).toMatchObject({ decision: "APPROVE", __skillEffects: { outcome: "RELEASED" } });
    expect(releaser.events.find((event) => event.code === "skill.effects.released")).toBeTruthy();

    const rejected = await releaser.run("case-close-effects", { "case-close": skillValue, "case-close-approval": { ...approval, decision: "REJECT" } });
    expect(rejected.values["case-close-effects"]).toMatchObject({ decision: "REJECT", __skillEffects: { outcome: "DISCARDED" } });

    // A stale case at approval time fails the release node (the skill must be re-run).
    store.answerRelease({ status: 409, body: { error: "skill_release.case_sequence_stale" } });
    await expect(releaser.run("case-close-effects", { "case-close": skillValue, "case-close-approval": approval })).rejects.toThrow("skill_release.case_sequence_stale");
    // An approval without verifiable human authority never reaches the case.
    await expect(releaser.run("case-close-effects", { "case-close": skillValue, "case-close-approval": { decision: "APPROVE", authority: "AGENT", decisionIds: ["d"] } }))
      .rejects.toThrow("skill.release_approval_invalid");
  });
});
