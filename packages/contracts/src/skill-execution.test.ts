import { describe, expect, it } from "vitest";
import {
  isDelegatedInvocationId,
  lockDigestFromRegistryReference,
  skillBundleLockSchema,
  skillBundleRegistryReference,
  skillBundleLockDigest,
  skillComputationSchema,
  skillExecutionResponseV1Schema,
  skillRequestedEffectSchema,
  skillEvidenceRefSchema,
} from "./index.js";

const digest = (char: string) => `sha256:${char.repeat(64)}`;
const lock = {
  bundle_id: "fincrime-skills", bundle_version: "0.4.0", bundle_digest: digest("a"), image_digest: digest("b"), python: "3.12.7",
  skills: [{
    id: "registry.company.verify", version: "0.3.0", maturity: "implemented_synthetic", manifest_digest: digest("c"),
    instructions_digest: digest("d"), code_digest: digest("e"), input_schema_digest: digest("f"), output_schema_digest: digest("1"),
    dependencies: { capabilities: ["business.registry.lookup.v1"], skills: ["entity.identifiers.validate@0.2.0"] },
    effects: "proposal", evaluation_report_digest: digest("2"),
  }],
  sbom_digest: digest("3"),
};
const metrics = { duration_ms: 812, capability_calls: 2, model_calls: 0 };

describe("skill.execution.v1 contracts", () => {
  it("parses the contract's bundle lock and binds its exact content into the registry reference", () => {
    const parsed = skillBundleLockSchema.parse(lock);
    expect(lockDigestFromRegistryReference(skillBundleRegistryReference(parsed))).toBe(skillBundleLockDigest(parsed));
    expect(skillBundleRegistryReference(parsed)).toMatch(/^skill-bundle:fincrime-skills@0\.4\.0;lock=[a-f0-9]{64}$/);
    expect(() => skillBundleLockSchema.parse({ ...lock, unknown: true })).toThrow();
    expect(() => skillBundleLockSchema.parse({ ...lock, extensions: { anything: [1, 2] } })).not.toThrow();
    expect(() => skillBundleLockSchema.parse({ ...lock, bundle_digest: "a".repeat(64) })).toThrow();
    expect(() => skillBundleLockSchema.parse({ ...lock, skills: [...lock.skills, lock.skills[0]] })).toThrow(/skill_duplicate/);
  });

  it("keeps lifecycle and business status independent and consistent", () => {
    const computation = { business_status: "NEEDS_EVIDENCE", payload: {}, metrics };
    const base = { contract_version: "skill.execution.v1", execution_id: "inv_1", trace: { subskill_executions: [] } };
    expect(skillExecutionResponseV1Schema.parse({ ...base, lifecycle: "COMPLETED_EXECUTION", computation }).computation?.proposed_records).toEqual([]);
    expect(() => skillExecutionResponseV1Schema.parse({ ...base, lifecycle: "COMPLETED_EXECUTION" })).toThrow(/completed_requires_computation/);
    expect(() => skillExecutionResponseV1Schema.parse({ ...base, lifecycle: "FAILED_EXECUTION" })).toThrow(/failed_requires_error/);
    expect(() => skillExecutionResponseV1Schema.parse({ ...base, lifecycle: "RUNNING", computation })).toThrow(/computation_only_when_completed/);
    expect(() => skillExecutionResponseV1Schema.parse({ ...base, lifecycle: "FAILED_EXECUTION", error: { code: "INPUT_INVALID", retryable: true } }))
      .toThrow(/retryable_only_for_transient_codes/);
    expect(skillExecutionResponseV1Schema.parse({ ...base, lifecycle: "FAILED_EXECUTION", error: { code: "TIMEOUT", retryable: true } }).error?.detail_ref).toBeNull();
    expect(() => skillExecutionResponseV1Schema.parse({ ...base, lifecycle: "CANCELLED", surprise: 1 })).toThrow();
  });

  it("types evidence, records and effects", () => {
    expect(skillEvidenceRefSchema.parse({ section_id: "subject", content_digest: digest("a"), span: null })).toBeTruthy();
    expect(skillEvidenceRefSchema.parse({ receipt_digest: "a".repeat(64), path: "$.result" })).toBeTruthy();
    expect(() => skillEvidenceRefSchema.parse({ section_id: "subject" })).toThrow();
    expect(() => skillRequestedEffectSchema.parse({ type: "case_command", idempotency_key: "k", payload: {} })).toThrow(/case_command_requires_command_type/);
    expect(() => skillRequestedEffectSchema.parse({ type: "case_command", command_type: "Approve", idempotency_key: "k", payload: {} })).toThrow();
    expect(() => skillRequestedEffectSchema.parse({ type: "external_action", idempotency_key: "k", payload: {} })).toThrow(/external_action_requires_action/);
    expect(skillComputationSchema.parse({
      business_status: "COMPLETED", payload: { ok: true }, metrics,
      proposed_records: [{ record_type: "Finding", local_ref: "f1", body: {}, evidence: [{ receipt_digest: "a".repeat(64) }] }],
      requested_effects: [{ type: "case_command", command_type: "RequestHumanReview", idempotency_key: "k", payload: {} }],
    }).requested_effects[0]?.justification_refs).toEqual([]);
    expect(() => skillComputationSchema.parse({ business_status: "COMPLETED", payload: {}, metrics, proposed_records: [{ record_type: "Decision", local_ref: "d", body: {}, evidence: [] }] }))
      .toThrow();
  });

  it("scopes delegated invocation ids to their execution", () => {
    expect(isDelegatedInvocationId("RUN-1:node:1", "RUN-1:node:1:registry-lookup")).toBe(true);
    expect(isDelegatedInvocationId("RUN-1:node:1", "RUN-1:node:1")).toBe(false);
    expect(isDelegatedInvocationId("RUN-1:node:1", "RUN-1:node:2:x")).toBe(false);
    expect(isDelegatedInvocationId("RUN-1:node:1", "RUN-1:node:1:a/b")).toBe(false);
  });
});
