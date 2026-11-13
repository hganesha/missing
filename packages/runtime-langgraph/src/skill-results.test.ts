import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { harnessPlanV2Schema, stableDigest, type HarnessPlanV2 } from "@ehf/contracts";
import { assembleContextPack } from "@ehf/context-plane";
import type { RuntimeContext } from "@ehf/runtime-core";
import { contextEnvelopeInputFor, lowerHarnessPlanV2, type V2ExecutionAdapters } from "./index.js";

const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../contracts/test-fixtures/skill-bound.plan.json", import.meta.url), "utf8")));

function snapshotFor(target: HarnessPlanV2) {
  const canonical = {
    apiVersion: "harness.factory/case-snapshot-v1" as const, kind: "CaseSnapshot" as const,
    tenantId: "tenant-1", caseId: "case-1", caseSequence: 4,
    dependencyDigest: "c".repeat(64), planDigest: target.planDigest,
    policyAuthority: { policyId: "policy.test", policyVersion: "1", policySnapshotDigest: "d".repeat(64), policyBundleDigest: "e".repeat(64) },
    consistency: "strong" as const, classification: "PII",
    data: { subjects: [{ subject_id: "S-1", display_name: "Meridian Trade Holdings Ltd", attributes: { country: "GB" } }] },
  };
  const snapshotDigest = stableDigest(canonical);
  return { ...canonical, snapshotId: `snapshot_${snapshotDigest}`, snapshotDigest, capturedAt: "2026-11-07T12:00:00.000Z" };
}

function harness(gatewayResult: (capabilityId: string) => Record<string, unknown>) {
  const events: Array<{ code: string; values: Record<string, unknown> }> = [];
  const context: RuntimeContext = {
    state: { nodeStarted: async () => {}, nodeFinished: async () => {}, appendEvent: async (_run, event) => { events.push(event); }, markCheckpoint: async () => {} },
    plan, runId: "RUN-S", runAttempt: 1, workerId: "worker-1", fencingEpoch: 1,
    gatewayUrl: "http://gateway", envelopeBrokerUrl: "http://control", executionGrant: "grant", serviceToken: "service-token",
  };
  const adapters: V2ExecutionAdapters = {
    loadCaseSnapshot: async () => snapshotFor(plan),
    evaluateGate: async () => { throw new Error("unused"); },
    executeFanoutBody: async () => { throw new Error("unused"); },
  };
  const calls: Array<{ skill?: { jurisdiction?: string } }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { invocationId: string; capabilityId: string; skill?: { jurisdiction?: string } };
    if (!String(url).includes("/v1/runtime/envelopes")) calls.push(body);
    if (String(url).includes("/v1/runtime/envelopes")) return new Response(JSON.stringify({ envelope: "envelope", expiresInSeconds: 60, caseWrites: [] }), { status: 200 });
    return new Response(JSON.stringify({
      invocationId: body.invocationId, capabilityId: body.capabilityId, errorCode: null, provider: "test", model: null, providerRequestId: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null }, latencyMs: 1, receiptDigest: "f".repeat(64), output: null, status: "succeeded",
      ...gatewayResult(body.capabilityId),
    }), { status: 200 });
  }) as typeof globalThis.fetch;
  return { events, calls, run: () => lowerHarnessPlanV2(plan, context, adapters, undefined, "pep-screen").invoke({ input: { tenantId: "tenant-1", caseId: "case-1" }, values: {} }) };
}

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

describe("skill-bound nodes", () => {
  it("journal SkillResult.v1 and let an incomplete check through as NEEDS_EVIDENCE, never as a pass", async () => {
    const { events, run } = harness(() => ({ output: { operationId: "opensanctions:pep", outcome: "not_checked", bankDecision: "not_evaluated", evidenceRefs: [] } }));
    const result = await run() as { values: Record<string, unknown> };
    expect(result.values["pep-screen"]).toMatchObject({ outcome: "not_checked" });
    const skill = events.find((event) => event.code.startsWith("skill.result."))!;
    expect(skill.code).toBe("skill.result.needs_evidence");
    expect(skill.values).toMatchObject({ skillId: "screening.pep.execute", skillVersion: "0.1.0", status: "NEEDS_EVIDENCE", errorCode: null, unresolvedCodes: ["EVIDENCE_INSUFFICIENT"] });
    expect(JSON.stringify(skill.values)).not.toContain("Meridian");
  });

  it("send the subject jurisdiction from the snapshot with the selection, for the gateway's coverage check", async () => {
    const { calls, run } = harness(() => ({ output: { operationId: "opensanctions:pep", outcome: "clear", evidenceRefs: [] } }));
    await run();
    expect(calls[0]?.skill).toMatchObject({ skillId: "screening.pep.execute", jurisdiction: "GB" });
  });

  it("fail the node closed when the skill is BLOCKED", async () => {
    const { events, run } = harness(() => ({ status: "denied", errorCode: "gateway.capability_denied" }));
    await expect(run()).rejects.toThrow("skill.blocked:ACCESS_DENIED");
    expect(events.find((event) => event.code.startsWith("skill.result."))?.code).toBe("skill.result.blocked");
  });
});

describe("context envelope inputs", () => {
  it("derive tenant, case, subjects, jurisdiction, policy snapshot and as-of time from the run and snapshot", () => {
    const snapshot = snapshotFor(plan);
    expect(contextEnvelopeInputFor({ tenantId: "tenant-1", caseId: "case-1" }, snapshot, { runId: "RUN-S", workerId: "worker-1" }, "pep-screen")).toEqual({
      tenantId: "tenant-1", caseId: "case-1", subjectRefs: ["subject:S-1"], jurisdiction: "GB", actor: "workload:runtime/worker-1",
      policySnapshotRef: `policy-snapshot:${"d".repeat(64)}`, asOfTime: "2026-11-07T12:00:00.000Z", correlationId: "RUN-S:pep-screen",
    });
    const pack = assembleContextPack({
      plan, nodeId: "pep-screen", runId: "RUN-S", selection: { name: "Meridian Trade Holdings Ltd" }, snapshot,
      envelope: contextEnvelopeInputFor({ tenantId: "tenant-1", caseId: "case-1" }, snapshot, { runId: "RUN-S", workerId: "worker-1" }, "pep-screen"),
    });
    expect(pack.contextGaps).toEqual([]);
    expect(pack.contextEnvelope).toMatchObject({ tenant_id: "tenant-1", case_id: "case-1", jurisdiction: "GB", context_hash: pack.packDigest });
  });

  it("report what the run cannot establish instead of defaulting it", () => {
    const pack = assembleContextPack({ plan, nodeId: "pep-screen", runId: "RUN-S", selection: { name: "x" },
      envelope: contextEnvelopeInputFor({ tenantId: "tenant-1", caseId: "case-1" }, null, { runId: "RUN-S", workerId: "worker-1" }, "pep-screen") });
    expect(pack.contextEnvelope).toBeNull();
    expect(pack.contextGaps.map((gap) => gap.field).sort()).toEqual(["as_of_time", "jurisdiction", "policy_snapshot_ref", "subject_refs"]);
  });
});
