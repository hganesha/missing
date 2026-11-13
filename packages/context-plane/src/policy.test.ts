import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { harnessPlanV2Schema, skillCapabilityInputV1Schema, stableDigest } from "@ehf/contracts";
import { assembleContextPack, buildSkillCapabilityInput, resolveSkillPolicySection, skillPolicyConfigSchema } from "./index.js";

// The compiled KYC plan: every library skill node carries the pinned US KYC policy projected to
// its manifest's policy_context_fields (scripts/sync-kyc-package.mjs).
const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../../artifacts/archive/kyc-v2.plan.json", import.meta.url), "utf8")));
const binding = plan.policyBundles[0]!;
const node = (id: string) => plan.graph.nodes.find((candidate) => candidate.id === id)!;
const policyOf = (id: string) => skillPolicyConfigSchema.parse(node(id).config.skillPolicy);
const authority = {
  policyId: "policy.kyc.customer-acceptance.v1", policyVersion: "1.0.0",
  policyBundleDigest: binding.bundleDigest, policySnapshotDigest: "d".repeat(64),
};
const asOfTime = "2026-11-07T12:00:00.000Z";
const resolve = (id: string, extra: Partial<Parameters<typeof resolveSkillPolicySection>[0]> = {}) =>
  resolveSkillPolicySection({ config: node(id).config.skillPolicy, authority, purpose: "KYC_ONBOARDING", asOfTime, ...extra });

describe("policy context section (CR-4)", () => {
  it("projects the pinned bundle to exactly the skill's policy_context_fields, as a trusted policy section", () => {
    const resolution = resolve("screening-sanctions-execute");
    expect(resolution.status).toBe("ready");
    if (resolution.status !== "ready") return;
    expect(Object.keys(resolution.section.value as object).sort()).toEqual(policyOf("screening-sanctions-execute").fields);
    expect(resolution.section).toMatchObject({
      id: "policy", kind: "policy", trust: "TRUSTED_DATA", classification: "CONFIDENTIAL", purpose: "KYC_ONBOARDING",
      provenanceRef: `policy-snapshot:${"d".repeat(64)}`, quarantined: false,
      value: {
        version: "1.0.0", jurisdiction: "US",
        // owner input D01: possible-match score 0.85, list freshness 1 day; D05: identity verification 90 days.
        screening_threshold: 0.85, freshness_seconds: { WatchlistEntry: 86_400, VerificationRecord: 7_776_000 },
      },
    });
    expect(resolution.section.contentDigest).toBe(stableDigest(resolution.section.value));
    expect((resolution.section.value as { permissions: string[] }).permissions).toContain("skill:screening.sanctions.execute");
  });

  it("refuses when a field the skill declares has no source in the bundle, naming the field", () => {
    // risk.customer.assess needs risk_tiers, risk_weights and risk_model_version: the US KYC bundle has none.
    const resolution = resolve("risk-customer-assess");
    expect(resolution).toMatchObject({ status: "unresolved", missing: ["risk_model_version", "risk_tiers", "risk_weights"] });
    expect(policyOf("risk-customer-assess").unresolved).toEqual(["risk_model_version", "risk_tiers", "risk_weights"]);
  });

  it("refuses every field when the case is not pinned to the plan's bundle, or to no policy at all", () => {
    expect(resolve("decision-policy-resolve", { authority: { ...authority, policyBundleDigest: "e".repeat(64) } }))
      .toMatchObject({ status: "unresolved", missing: policyOf("decision-policy-resolve").fields, explanation: expect.stringContaining("not to the plan's") });
    expect(resolve("decision-policy-resolve", { authority: { ...authority, policyId: "policy.other.v1" } })).toMatchObject({ status: "unresolved" });
    expect(resolve("decision-policy-resolve", { authority: null })).toMatchObject({ status: "unresolved", explanation: expect.stringContaining("no pinned policy") });
    expect(resolve("decision-policy-resolve", { config: { ...policyOf("decision-policy-resolve"), extra: true } })).toMatchObject({ status: "unresolved", missing: ["policy"] });
  });

  it("computes a per-cohort value with the policy engine's cohort assignment, and refuses while the cohort is undetermined", () => {
    const subjects = [{ subject_id: "S-1", attributes: { customerType: "individual" } }];
    const riskFact = (value: Record<string, unknown>, status = "ACTIVE") => ({ fact_id: `f-${status}`, predicate: "kyc_risk_profile", status, value });
    const standardLow = { riskTier: "standard", jurisdictionRisk: "LOW", productRisk: "LOW", pepExposure: false };

    const ready = resolve("monitor-customer-schedule", { selection: { kycSubjects: subjects, policyFacts: [riskFact(standardLow)] } });
    expect(ready).toMatchObject({ status: "ready", cohortId: "RC-LOW-STANDARD-INDIVIDUAL" });
    // owner input D09: standard cohorts are reviewed every 36 months.
    if (ready.status === "ready") expect((ready.section.value as Record<string, unknown>).review_interval_seconds).toBe(36 * 30 * 86_400);
    const high = resolve("monitor-customer-schedule", { selection: { kycSubjects: subjects, policyFacts: [riskFact({ ...standardLow, riskTier: "high" })] } });
    if (high.status === "ready") expect((high.section.value as Record<string, unknown>).review_interval_seconds).toBe(6 * 30 * 86_400);
    expect(high).toMatchObject({ status: "ready", cohortId: "RC-HIGH-INDIVIDUAL" });

    // No risk profile fact (nothing in the library workflow writes one yet): cohort undetermined.
    expect(resolve("monitor-customer-schedule", { selection: { kycSubjects: subjects, policyFacts: [] } }))
      .toMatchObject({ status: "unresolved", missing: ["review_interval_seconds"], explanation: expect.stringContaining("could not be determined") });
    // Two active risk profiles are ambiguous, never a choice.
    expect(resolve("monitor-customer-schedule", { selection: { kycSubjects: subjects, policyFacts: [riskFact(standardLow), { ...riskFact(standardLow), fact_id: "f-2" }] } }))
      .toMatchObject({ status: "unresolved" });
    // A PEP-adjacent cohort has no risk-tier interval in the bundle.
    expect(resolve("monitor-customer-schedule", { selection: { kycSubjects: subjects, policyFacts: [riskFact({ ...standardLow, pepExposure: true })] } }))
      .toMatchObject({ status: "unresolved", explanation: expect.stringContaining("RC-PEP-ADJACENT") });
  });

  it("sends the section in SkillCapabilityInput.v1, and blocks the skill with POLICY_UNRESOLVED when a field is missing", () => {
    const snapshot = { snapshotId: `snapshot_${"b".repeat(64)}`, snapshotDigest: "b".repeat(64), tenantId: "tenant-1", caseId: "case-1", caseSequence: 5 };
    const envelope = { tenantId: "tenant-1", caseId: "case-1", subjectRefs: ["subject:S-1"], jurisdiction: "US", actor: "workload:runtime/w", policySnapshotRef: `policy-snapshot:${"d".repeat(64)}`, asOfTime };
    const invocation = { executionId: "3f1c2d4e-5a6b-8c7d-9e0f-112233445566", parameters: {}, purpose: "onboarding" as const, idempotencyKey: "RUN-1:x:1", traceId: "RUN-1" };

    const pack = assembleContextPack({ plan, nodeId: "decision-policy-resolve", runId: "RUN-1", snapshot, envelope, selection: { kycSubjects: [{ subject_id: "S-1" }] } });
    const built = buildSkillCapabilityInput(pack, { ...invocation, policy: resolve("decision-policy-resolve") });
    expect(built.status).toBe("ready");
    if (built.status !== "ready") return;
    const section = skillCapabilityInputV1Schema.parse(built.input).context.sections.find((item) => item.id === "policy")!;
    expect(section).toMatchObject({ kind: "policy", trust: "TRUSTED_DATA", provenance_ref: `policy-snapshot:${"d".repeat(64)}`, value: { version: "1.0.0", jurisdiction: "US" } });

    const riskPack = assembleContextPack({ plan, nodeId: "risk-factor-evaluate", runId: "RUN-1", snapshot, envelope, selection: { kycSubjects: [{ subject_id: "S-1" }], subjectName: "Ada", subjectCountry: "US" } });
    expect(buildSkillCapabilityInput(riskPack, { ...invocation, policy: resolve("risk-factor-evaluate") })).toMatchObject({
      status: "blocked", code: "POLICY_UNRESOLVED", policyGaps: ["risk_factor_maps"], explanation: expect.stringContaining("risk_factor_maps"),
    });
    // Unbound parameters block too, and missing evidence outranks the policy code.
    expect(buildSkillCapabilityInput(riskPack, { ...invocation, policy: resolve("risk-factor-evaluate"), unresolvedParameters: ["value"] }))
      .toMatchObject({ status: "blocked", code: "CONTEXT_MISSING", parameterGaps: ["value"], policyGaps: ["risk_factor_maps"] });
  });
});
