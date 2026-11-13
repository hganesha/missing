import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { harnessPlanV2Schema, stableDigest, type CapabilityResult, type HarnessPlanV2 } from "@ehf/contracts";
import {
  admitHarnessPlanV2,
  invokeCapability,
  invokeSkill,
  skillErrorCodeFor,
  skillExecutionId,
  toSkillResult,
  type RuntimeContext,
} from "./index.js";

const fixture = JSON.parse(readFileSync(new URL("../../contracts/test-fixtures/skill-bound.plan.json", import.meta.url), "utf8")) as unknown;
const plan = harnessPlanV2Schema.parse(fixture);

function context(overridePlan: HarnessPlanV2 = plan): RuntimeContext {
  return {
    state: { nodeStarted: async () => {}, nodeFinished: async () => {}, appendEvent: async () => {}, markCheckpoint: async () => {} },
    plan: overridePlan, runId: "RUN-1", runAttempt: 1, workerId: "worker-1", fencingEpoch: 1,
    gatewayUrl: "http://gateway", envelopeBrokerUrl: "http://control", executionGrant: "grant", serviceToken: "token",
  };
}

type Call = { invocationId: string; capabilityId: string; skill?: { candidateIndex: number; selectedConnectorId: string; reason: string; jurisdiction?: string } };

function succeeded(capabilityId: string, output: unknown = { status: "OK", alerts: [] }): CapabilityResult {
  return {
    invocationId: "x", capabilityId, status: "succeeded", output, errorCode: null, provider: "simulator", model: null,
    providerRequestId: null, usage: { inputTokens: null, outputTokens: null, costUsd: 0 }, latencyMs: 1, receiptDigest: "c".repeat(64),
  };
}

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

/** Gateway double: `failures` maps a candidate index to the error the gateway returns for it. */
function gateway(failures: Record<number, string> = {}): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    if (String(url).includes("/v1/runtime/envelopes")) {
      return new Response(JSON.stringify({ envelope: "envelope", expiresInSeconds: 60, caseWrites: [] }), { status: 200 });
    }
    const body = JSON.parse(String(init.body)) as Call;
    calls.push(body);
    const failure = failures[body.skill?.candidateIndex ?? -1];
    if (failure) return new Response(JSON.stringify({ error: failure }), { status: 400 });
    return new Response(JSON.stringify(succeeded(body.capabilityId)), { status: 200 });
  }) as typeof globalThis.fetch;
  return calls;
}

describe("skill-bound plan admission", () => {
  it("admits a harnessc plan with pinned skill bindings", () => {
    expect(admitHarnessPlanV2(fixture).skillBindings).toHaveLength(2);
  });

  it("rejects a skill node whose binding or envelope does not cover its candidates", () => {
    const reseal = (mutate: (copy: HarnessPlanV2) => void) => {
      const copy = structuredClone(plan);
      mutate(copy);
      const { planDigest: _digest, planId: _id, ...content } = copy;
      return { ...copy, planDigest: stableDigest(content) };
    };
    expect(() => admitHarnessPlanV2(reseal((copy) => { copy.skillBindings = copy.skillBindings!.filter((item) => item.skillId !== "screening.pep.execute"); })))
      .toThrow("runtime.v2.skill_binding_missing:pep-screen");
    expect(() => admitHarnessPlanV2(reseal((copy) => {
      copy.permissionEnvelopes = copy.permissionEnvelopes.map((envelope) => envelope.nodeId === "pep-screen" ? { ...envelope, capabilities: [] } : envelope);
    }))).toThrow("runtime.v2.skill_candidate_not_permitted:pep-screen:screening.pep.v1");
  });
});

describe("skill candidate selection", () => {
  it("selects the first pinned candidate and records the selection in the gateway request", async () => {
    const calls = gateway();
    const result = await invokeCapability(context(), "sanctions-screen", { name: "Acme" });
    expect(result.status).toBe("succeeded");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.invocationId).toBe(`RUN-1:sanctions-screen:${stableDigest({ name: "Acme" }).slice(0, 24)}`);
    expect(calls[0]!.skill).toEqual({
      skillId: "screening.sanctions.execute", skillVersion: "0.1.0", selectedCapabilityId: "screening.sanctions.v1",
      selectedConnectorId: "opensanctions:sanctions", candidateIndex: 0, reason: "first_candidate",
    });
  });

  it("falls back on a transient failure only to the next candidate with equivalent coverage", async () => {
    const calls = gateway({ 0: "adapter.opensanctions_timeout" });
    const invocation = await invokeSkill(context(), "sanctions-screen", { name: "Acme" });
    // Candidate 1 (another provider's lists) is skipped: never a fallback across coverage groups.
    expect(calls.map((call) => call.skill?.candidateIndex)).toEqual([0, 2]);
    expect(invocation.selection).toMatchObject({ candidateIndex: 2, selectedConnectorId: "wiring:opensanctions:screening.sanctions", reason: "fallback_after_timeout:candidate_0" });
    expect(invocation.attempts.map((attempt) => attempt.errorCode)).toEqual(["TIMEOUT", null]);
    expect(new Set(calls.map((call) => call.invocationId)).size).toBe(2);
  });

  it("never falls back across coverage groups, even when the equivalent candidate also fails", async () => {
    const calls = gateway({ 0: "adapter.kyc_wiring_http_429", 2: "adapter.kyc_wiring_unreachable" });
    await expect(invokeSkill(context(), "sanctions-screen", { name: "Acme" })).rejects.toThrow("adapter.kyc_wiring_unreachable");
    expect(calls.map((call) => call.skill?.candidateIndex)).toEqual([0, 2]);
  });

  it("does not fall back on a non-transient failure", async () => {
    const calls = gateway({ 0: "adapter.kyc_wiring_subject_missing" });
    await expect(invokeSkill(context(), "sanctions-screen", { name: "Acme" })).rejects.toThrow("adapter.kyc_wiring_subject_missing");
    expect(calls).toHaveLength(1);
  });

  it("does not fall back when the resolution policy forbids it", async () => {
    const calls = gateway({ 0: "adapter.opensanctions_timeout" });
    await expect(invokeSkill(context(), "pep-screen", { name: "Acme" })).rejects.toThrow("adapter.opensanctions_timeout");
    expect(calls).toHaveLength(1);
  });
  it("permits only equivalent source coverage fallback and stops on global policy/integrity failures", async () => {
    const eligible = gateway({ 0: "gateway.source_policy_denied:source_policy.required_scope_not_supported" });
    expect((await invokeSkill(context(), "sanctions-screen", { name: "Acme" })).selection.candidateIndex).toBe(2);
    expect(eligible.map((call) => call.skill?.candidateIndex)).toEqual([0, 2]);
    for (const reason of ["authority_unavailable", "artifact_revoked", "endpoint_denied", "applicability_unresolved", "explicit_deny", "evidence_incomplete"]) {
      const calls = gateway({ 0: `gateway.source_policy_denied:source_policy.${reason}` });
      await expect(invokeSkill(context(), "sanctions-screen", { name: "Acme" })).rejects.toThrow(reason);
      expect(calls).toHaveLength(1);
    }
    const forbidden = gateway({ 0: "gateway.source_policy_denied:source_policy.required_scope_not_supported" });
    await expect(invokeSkill(context(), "pep-screen", { name: "Acme" })).rejects.toThrow("required_scope_not_supported");
    expect(forbidden).toHaveLength(1);
  });

  it("selects by jurisdiction: a candidate the gateway refuses for coverage is skipped, across coverage groups", async () => {
    const calls = gateway({ 0: "gateway.skill_coverage_denied:jurisdiction_not_covered" });
    const invocation = await invokeSkill(context(), "sanctions-screen", { name: "Acme" }, { jurisdiction: "gb" });
    expect(calls.map((call) => call.skill?.candidateIndex)).toEqual([0, 1]);
    expect(calls.every((call) => call.skill?.jurisdiction === "GB")).toBe(true);
    expect(invocation.selection).toMatchObject({ candidateIndex: 1, reason: "skipped_jurisdiction_not_covered:candidate_0", jurisdiction: "GB" });
    expect(invocation.attempts.map((attempt) => attempt.errorCode)).toEqual(["POLICY_UNRESOLVED", null]);
  });

  it("skips refused candidates even when fallback is forbidden, and measures later fallback from the selected one", async () => {
    const pep = gateway({ 0: "gateway.skill_coverage_denied:entitlement_missing" });
    await invokeSkill(context(), "pep-screen", { name: "Acme" }, { jurisdiction: "US" });
    expect(pep.map((call) => call.skill?.candidateIndex)).toEqual([0, 1]);
    // Candidate 1 (its own coverage group) times out: candidate 2 shares the refused
    // candidate's group, not the selected one's, so it is not a fallback.
    const sanctions = gateway({ 0: "gateway.skill_coverage_denied:list_stale", 1: "adapter.kyc_wiring_timeout" });
    await expect(invokeSkill(context(), "sanctions-screen", { name: "Acme" }, { jurisdiction: "US" })).rejects.toThrow("adapter.kyc_wiring_timeout");
    expect(sanctions.map((call) => call.skill?.candidateIndex)).toEqual([0, 1]);
  });

  it("fails with the coverage refusal when no pinned candidate is eligible", async () => {
    const calls = gateway({ 0: "gateway.skill_coverage_denied:coverage_unregistered", 1: "gateway.skill_coverage_denied:coverage_unregistered" });
    await expect(invokeSkill(context(), "pep-screen", { name: "Acme" })).rejects.toThrow("gateway.skill_coverage_denied:coverage_unregistered");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.skill).not.toHaveProperty("jurisdiction");
  });

  it("records an agent loop's explicit choice of a candidate", async () => {
    const calls = gateway();
    await invokeCapability(context(), "sanctions-screen", { name: "Acme" }, { capabilityId: "screening.sanctions.v1", step: 2 });
    expect(calls[0]!.skill).toMatchObject({ candidateIndex: 0, reason: "agent_selected" });
  });
});

describe("SkillResult.v1 mapping", () => {
  const base = { skillId: "screening.sanctions.execute", skillVersion: "0.1.0", policySnapshotRef: "policy:1", contextHash: "a".repeat(64), traceRef: "trace-1", durationMs: 5, providerCalls: 1 };
  const wiring = (outcome: string, extra: Record<string, unknown> = {}) => succeeded("screening.sanctions.v1", {
    status: "OK", provider: "KYC_WIRING", outcome, checkStatus: "completed", error: null,
    evidenceRefs: [{ evidenceId: "ev-1" }], ...extra,
  });

  it("is COMPLETED only when the implementation completed with a result", () => {
    const result = toSkillResult({ ...base, outcome: { result: wiring("failed") } });
    expect(result).toMatchObject({ status: "COMPLETED", error: null, evidence_refs: ["evidence:ev-1"], result_refs: [`receipt:${"c".repeat(64)}`] });
  });

  it("maps unknown, not_checked and inconclusive wiring outcomes to NEEDS_EVIDENCE, never a pass", () => {
    for (const outcome of ["unknown", "not_checked", "inconclusive"]) {
      expect(toSkillResult({ ...base, outcome: { result: wiring(outcome) } }).status, outcome).toBe("NEEDS_EVIDENCE");
    }
    expect(toSkillResult({ ...base, outcome: { result: wiring("unknown", { status: "UNKNOWN", error: { code: "wiring.check_failed" } }) } }).unresolved_items[0]!.explanation)
      .toContain("wiring.check_failed");
    expect(toSkillResult({ ...base, outcome: { result: succeeded("screening.sanctions.v1", null) } }).status).toBe("NEEDS_EVIDENCE");
    expect(toSkillResult({ ...base, outcome: { result: wiring("review") } }).status).toBe("NEEDS_REVIEW");
    expect(toSkillResult({ ...base, outcome: { result: wiring("passed", { checkStatus: "partial" }) } }).status).toBe("PARTIAL");
  });

  it("maps failures to FAILED or BLOCKED with §4.3 codes", () => {
    expect(toSkillResult({ ...base, outcome: { error: new Error("adapter.kyc_wiring_timeout") } }))
      .toMatchObject({ status: "FAILED", error: { code: "TIMEOUT", retryable: true } });
    expect(toSkillResult({ ...base, outcome: { error: new Error("gateway.capability_denied") } }))
      .toMatchObject({ status: "BLOCKED", error: { code: "ACCESS_DENIED", retryable: false } });
    expect(toSkillResult({ ...base, outcome: { result: { ...succeeded("x"), status: "failed", errorCode: "adapter.kyc_wiring_http_503" } } }))
      .toMatchObject({ status: "FAILED", error: { code: "SOURCE_UNAVAILABLE", retryable: true } });
  });

  it("classifies gateway errors conservatively", () => {
    expect(skillErrorCodeFor("adapter.databricks_serving_http_429")).toBe("RATE_LIMITED");
    expect(skillErrorCodeFor("gateway.invocation_in_progress")).toBe("CONTROL_FAILED");
    expect(skillErrorCodeFor("gateway.budget_denied")).toBe("CONTROL_FAILED");
    expect(skillErrorCodeFor("gateway.capability_denied")).toBe("ACCESS_DENIED");
    expect(skillErrorCodeFor("something.new")).toBe("CONTROL_FAILED");
    expect(skillErrorCodeFor("gateway.skill_coverage_denied:entitlement_missing")).toBe("ACCESS_DENIED");
    expect(skillErrorCodeFor("gateway.skill_coverage_denied:jurisdiction_unknown")).toBe("CONTEXT_MISSING");
    expect(skillErrorCodeFor("gateway.skill_coverage_denied:list_stale")).toBe("CONTEXT_STALE");
    expect(skillErrorCodeFor("gateway.skill_coverage_denied:jurisdiction_not_covered")).toBe("POLICY_UNRESOLVED");
    expect(skillExecutionId("seed")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
