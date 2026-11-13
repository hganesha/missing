import { describe, expect, it } from "vitest";
import type { CapabilityResult } from "@ehf/contracts";
import { skillResultFromExecution } from "./skill-execution.js";

const receipt = "a".repeat(64);
const dependency = "b".repeat(64);

function result(output: Record<string, unknown>): CapabilityResult {
  return {
    invocationId: "RUN-1:verify:1", capabilityId: "skill.sample.registry.verify.v1", status: "succeeded",
    output: {
      contract_version: "skill.execution.v1", execution_id: "RUN-1:verify:1", skill_id: "sample.registry.verify", skill_version: "0.1.0",
      bundle_digest: `sha256:${"c".repeat(64)}`, manifest_digest: "d".repeat(64), effect_mode: "proposal",
      computation: null, error: null, trace: { subskill_executions: [] }, dependency_receipts: [dependency],
      ...output,
    },
    errorCode: null, provider: "skill-host:ehf-reference-skills", model: "sample.registry.verify@0.1.0", providerRequestId: "RUN-1:verify:1",
    usage: { inputTokens: null, outputTokens: null, costUsd: null }, latencyMs: 40, receiptDigest: receipt,
  };
}

const input = (output: Record<string, unknown>) => ({
  result: result(output), executionId: "0f6c2b1e-1d2a-8c3b-a4d5-e6f708192a3b", policySnapshotRef: "policy:kyc@1",
  contextHash: "e".repeat(64), traceRef: "trace-1", subjectRef: "company:Sample",
});
const metrics = { duration_ms: 12, capability_calls: 1, model_calls: 0 };

describe("SkillResult.v1 from a skill-host execution", () => {
  it("keeps the skill's business status and cites the receipts", () => {
    const completed = skillResultFromExecution({
      ...input({ lifecycle: "COMPLETED_EXECUTION", computation: { business_status: "COMPLETED", payload: {}, proposed_records: [], unresolved_items: [], negative_searches: [], requested_effects: [], metrics } }),
      committedRefs: { findings: ["finding:F-1"] },
    });
    expect(completed).toMatchObject({
      status: "COMPLETED", error: null, result_refs: [`receipt:${receipt}`], evidence_refs: [`receipt:${dependency}`], finding_refs: ["finding:F-1"],
      metrics: { duration_ms: 12, provider_calls: 1, cost_estimate: 0 },
    });
    const needs = skillResultFromExecution(input({ lifecycle: "COMPLETED_EXECUTION", computation: { business_status: "NEEDS_EVIDENCE", payload: {}, metrics } }));
    expect(needs.status).toBe("NEEDS_EVIDENCE");
    expect(needs.unresolved_items[0]?.code).toBe("EVIDENCE_INSUFFICIENT");
  });

  it("maps failed and cancelled executions to FAILED or BLOCKED with a §4.3 code", () => {
    expect(skillResultFromExecution(input({ lifecycle: "FAILED_EXECUTION", error: { code: "TIMEOUT", retryable: true, detail_ref: null } })))
      .toMatchObject({ status: "FAILED", error: { code: "TIMEOUT", retryable: true } });
    expect(skillResultFromExecution(input({ lifecycle: "FAILED_EXECUTION", error: { code: "ACCESS_DENIED", retryable: false, detail_ref: null } })))
      .toMatchObject({ status: "BLOCKED", error: { code: "ACCESS_DENIED", retryable: false } });
    expect(skillResultFromExecution(input({ lifecycle: "CANCELLED" }))).toMatchObject({ status: "FAILED", error: { code: "CONTROL_FAILED" } });
    expect(() => skillResultFromExecution({ ...input({}), result: { ...result({}), output: { lifecycle: "x" } } })).toThrow("runtime.skill_output_invalid");
  });
});
