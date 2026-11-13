import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalRecordDigest, canonicalRecordInputSchema, harnessPlanV2Schema, stableDigest, type CanonicalRecord, type HarnessPlanV2 } from "@ehf/contracts";
import type { RuntimeContext } from "@ehf/runtime-core";
import { lowerHarnessPlanV2, type V2ExecutionAdapters } from "./index.js";

// End to end through the node executor (agentic plan phase 1): production slice 1's screening
// review agent runs a loop skill. The runtime, not the model, builds the skill's input from the
// skill's own selectors and the case's pinned slice policy; the gateway call names the skill; and
// the runtime judges task completion over the agent's skill nodes.
const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../../artifacts/kyb-screening.plan.json", import.meta.url), "utf8"))) as HarnessPlanV2;
const policyBytes = readFileSync(new URL("../../../domains/kyb-screening/policy/slice-policy.json", import.meta.url));
const policyBundleDigest = createHash("sha256").update(policyBytes).digest("hex");
const tenantId = "tenant-1";
const caseId = "case-1";
const capturedAt = "2026-11-09T12:00:00.000Z";

function record(objectType: string, objectId: string, data: Record<string, unknown>): CanonicalRecord {
  const input = canonicalRecordInputSchema.parse({
    object_type: objectType, object_id: objectId, version_id: "v-1", data, observed_at: "2026-11-09T11:00:00.000Z",
    source_refs: [], provenance: { method: "connector_normalizer", normalizer: "test@1", connector_id: "corpus:test" }, classification: "CONFIDENTIAL", synthetic: true,
  });
  const stored = { schema_version: "1.0.0", subject_ids: [], valid_from: null, valid_to: null, purposes: [], ...input, tenant_id: tenantId, case_id: caseId, supersedes: null };
  return { ...stored, recorded_at: capturedAt, record_digest: canonicalRecordDigest(stored) } as CanonicalRecord;
}

function snapshot(records: Record<string, CanonicalRecord[]>, pinnedDigest = policyBundleDigest) {
  const canonical = {
    apiVersion: "harness.factory/case-snapshot-v1" as const, kind: "CaseSnapshot" as const, tenantId, caseId, caseSequence: 7,
    dependencyDigest: "c".repeat(64), planDigest: plan.planDigest,
    policyAuthority: { policyId: "policy.kyb.screening-ownership.us", policyVersion: "1.0.0", policySnapshotDigest: "d".repeat(64), policyBundleDigest: pinnedDigest },
    consistency: "strong" as const, classification: "CONFIDENTIAL",
    data: {
      case: { caseId },
      subjects: [{ subject_id: "e-customer", display_name: "Thistlewood Fabrication Ltd", attributes: { country: "US" } }],
      facts: [], records, recordsAsOf: { asOf: capturedAt, knowledgeCutoff: capturedAt },
    },
  };
  const snapshotDigest = stableDigest(canonical);
  return { ...canonical, snapshotId: `snapshot_${snapshotDigest}`, snapshotDigest, capturedAt };
}

const skillValue = (status: string, payload: Record<string, unknown>) => ({ lifecycle: "COMPLETED_EXECUTION", computation: { business_status: status, payload } });
const predecessors = {
  "screening-sanctions-execute": skillValue("COMPLETED", { hits: [], coverage: [], universal_clearance: false }),
  "screening-pep-execute": skillValue("NEEDS_REVIEW", { hits: [{ entity_id: "e-chidi" }], coverage: [], universal_clearance: false }),
  "screening-match-disambiguate": skillValue("COMPLETED", { dispositions: [] }),
};

function harness(snap: unknown, actions: unknown[]) {
  const events: Array<{ code: string; values: Record<string, unknown> }> = [];
  const invocations: Array<Record<string, any>> = [];
  const queue = [...actions];
  const context: RuntimeContext = {
    state: { nodeStarted: async () => {}, nodeFinished: async () => {}, appendEvent: async (_run, event) => { events.push(event); }, markCheckpoint: async () => {} },
    plan, runId: "RUN-L", runAttempt: 1, workerId: "worker-1", fencingEpoch: 1,
    gatewayUrl: "http://gateway", caseApiUrl: "http://case", envelopeBrokerUrl: "http://control", executionGrant: "grant", serviceToken: "service-token",
  };
  const adapters: V2ExecutionAdapters = { loadCaseSnapshot: async () => snap, evaluateGate: async () => { throw new Error("unused"); } };
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const target = String(url);
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, any> : {};
    if (target.includes("/v1/runtime/envelopes")) return Response.json({ envelope: "envelope", expiresInSeconds: 60, caseWrites: [] });
    if (target.includes("/v1/evidence:register")) return Response.json({ evidence: { evidenceId: "ev_review_1" } });
    if (target.endsWith(`/v2/cases/${caseId}/sequence`)) return Response.json({ caseSequence: 7 });
    if (target.endsWith("/commands")) return Response.json({ outcome: "ACCEPTED", caseSequence: 8, createdIdentifiers: {} });
    invocations.push(body);
    const base = { invocationId: body.invocationId, capabilityId: body.capabilityId, errorCode: null, provider: "test", model: null, providerRequestId: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null }, latencyMs: 1, receiptDigest: "f".repeat(64), status: "succeeded" };
    if (String(body.capabilityId).startsWith("model.")) return Response.json({ ...base, output: queue.shift() });
    const binding = plan.skillBindings!.find((item) => item.candidates.some((candidate) => candidate.capabilityId === body.capabilityId))!;
    return Response.json({ ...base, output: {
      contract_version: "skill.execution.v1", execution_id: String(body.invocationId), skill_id: binding.skillId, skill_version: binding.semver,
      bundle_digest: binding.bundleDigest, manifest_digest: binding.manifestDigest.replace(/^sha256:/, ""), effect_mode: "read_only", lifecycle: "COMPLETED_EXECUTION",
      computation: { business_status: "COMPLETED", payload: { relationships: [{ source: "e-chidi", target: "e-customer", relation: "sibling" }] }, proposed_records: [],
        unresolved_items: [], negative_searches: [], requested_effects: [], metrics: { duration_ms: 3, capability_calls: 0, model_calls: 0 } },
      error: null, trace: { subskill_executions: [] }, dependency_receipts: [], capabilityId: body.capabilityId,
    } });
  }) as typeof globalThis.fetch;
  const run = () => lowerHarnessPlanV2(plan, context, adapters, undefined, "screening-review")
    .invoke({ input: { tenantId, caseId }, values: predecessors }) as Promise<{ values: Record<string, any> }>;
  return { events, invocations, run };
}

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });
const final = { action: "final", output: { summary: "PEP relative confirmed by relationship record.", proposals: [], gaps: [], requiresHumanReview: true } };
const pepRelationship = record("PEPRelationship", "pep-rel-1", { source: "e-chidi", target: "e-customer", relation: "sibling", verified: true });

describe("an agent loop skill through the node executor", () => {
  it("builds the skill's input from its own records and the pinned policy, names the skill to the gateway, and judges completion", async () => {
    const h = harness(snapshot({ PEPRelationship: [pepRelationship] }), [{ action: "call_skill", skill: "screening.pep.relationship.resolve", parameters: {} }, final]);
    const result = await h.run();
    const skillCall = h.invocations.find((call) => String(call.capabilityId).startsWith("skill."))!;
    expect(skillCall.capabilityId).toBe("skill.screening.pep.relationship.resolve.v0");
    expect(skillCall.skill).toMatchObject({ skillId: "screening.pep.relationship.resolve", reason: "agent_selected", candidateIndex: 0 });
    // The input is SkillCapabilityInput built by the runtime: the skill's records and its policy section.
    const sections = skillCall.input.context.sections as Array<{ kind: string; id: string }>;
    expect(sections.some((section) => section.kind === "policy")).toBe(true);
    expect(JSON.stringify(skillCall.input.context)).toContain("pep-rel-1");
    // Only this skill's records: nothing the other loop skill or the review selectors read.
    expect(JSON.stringify(skillCall.input.context)).not.toContain("ControlRight");
    expect(h.events.map((event) => event.code)).toEqual(expect.arrayContaining(["skill.loop.completed", "agent.step.call_skill", "agent.task.needs_review"]));
    // The PEP screen was NEEDS_REVIEW, and the agent asked for review: NEEDS_REVIEW, never COMPLETED.
    expect(result.values["screening-review"].__taskCompletion).toMatchObject({ status: "NEEDS_REVIEW",
      criteria: [{ nodeId: "screening-sanctions-execute", passed: true }, { nodeId: "screening-pep-execute", passed: false, observed: "NEEDS_REVIEW" }, { nodeId: "screening-match-disambiguate", passed: true }] });
    expect(result.values["screening-review"].summary).toBe("PEP relative confirmed by relationship record.");
  });

  it("does not call a skill whose required records are missing; the model sees NEEDS_EVIDENCE instead", async () => {
    const h = harness(snapshot({}), [{ action: "call_skill", skill: "screening.pep.relationship.resolve", parameters: {} }, final]);
    await h.run();
    expect(h.invocations.some((call) => String(call.capabilityId).startsWith("skill."))).toBe(false);
    expect(h.events.find((event) => event.code === "skill.loop.needs_evidence")?.values).toMatchObject({ skillId: "screening.pep.relationship.resolve", code: "CONTEXT_MISSING", skillCalled: false });
  });

  it("does not call a skill when the case is pinned to another policy", async () => {
    const h = harness(snapshot({ PEPRelationship: [pepRelationship] }, "e".repeat(64)), [{ action: "call_skill", skill: "screening.pep.relationship.resolve", parameters: {} }, final]);
    await h.run();
    expect(h.invocations.some((call) => String(call.capabilityId).startsWith("skill."))).toBe(false);
    expect(h.events.find((event) => event.code === "skill.loop.needs_evidence")?.values).toMatchObject({ code: "POLICY_UNRESOLVED" });
  });
});
