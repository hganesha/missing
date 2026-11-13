import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { stableDigest } from "@ehf/contracts";
import { closeBusinessPolicyEvaluators, compileBusinessPolicy, evaluateBusinessPolicy, simulationBasis, type BusinessPolicySource } from "./business-policy.js";
import { referenceGateResult, regressionFacts, regressionSetSchema, runImpact, type RegressionCase } from "./impact.js";

// Impact simulation (Product Policy Studio phase F): the regression set through a baseline and a
// candidate, in OPA and in the reference evaluation, reproducibly.
const read = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");
const set = regressionSetSchema.parse(parse(read("domains/policy/regression/bank-synthetic.yaml")));
const kyb = parse(read("domains/kyb-agentic/policy.yaml")) as BusinessPolicySource;
const at = set.asOf;

/** The candidate: trusts start at CDD for payments, and adverse media now needs a reviewer's approval. */
function candidateOf(source: BusinessPolicySource): BusinessPolicySource {
  const next = structuredClone(source);
  next.diligence!.matrix.trust!.payments = "CDD";
  const media = next.diligence!.overlays.find((overlay) => overlay.id === "overlay.adverse-media")!;
  media.enabled = true;
  media.effect = { ...media.effect, requireApproval: { role: "Case.Reviewer", quorum: 1, reason: "Confirmed adverse media." } };
  return next;
}

async function opaImpact(baseline: BusinessPolicySource, candidate: BusinessPolicySource, gateId = "diligence-level") {
  const side = (source: BusinessPolicySource) => {
    const compiled = compileBusinessPolicy(source, { opaVersion: "1.9.0" });
    return {
      ref: { policyId: compiled.manifest.policyId, version: compiled.manifest.policyVersion, bundleDigest: compiled.manifest.bundleDigest },
      sets: compiled.policySets,
      evaluate: async (policySet: (typeof compiled.policySets)[number], entry: RegressionCase, facts: Record<string, unknown>, gate: string) =>
        (await evaluateBusinessPolicy({ compiled, facts, basis: simulationBasis(compiled, policySet, gate, `impact:${entry.id}`, at,
          { jurisdiction: entry.scope.jurisdiction, institution: set.metadata.institution, products: [...entry.scope.products].sort(), customerType: entry.scope.customerType, legalForm: entry.scope.legalForm }) })).result,
    };
  };
  return runImpact({ set, gateId, diligenceGateId: "diligence-level", levels: candidate.diligence!.levels, baseline: side(baseline), candidate: side(candidate) });
}

async function referenceImpact(baseline: BusinessPolicySource, candidate: BusinessPolicySource, gateId = "diligence-level") {
  const side = (source: BusinessPolicySource) => {
    const compiled = compileBusinessPolicy(source, { opaVersion: "1.9.0" });
    return {
      ref: { policyId: compiled.manifest.policyId, version: compiled.manifest.policyVersion, bundleDigest: compiled.manifest.bundleDigest },
      sets: compiled.policySets,
      evaluate: async (policySet: (typeof compiled.policySets)[number], entry: RegressionCase, facts: Record<string, unknown>, gate: string) =>
        referenceGateResult(source, gate, { gateId: gate, inputProfile: "canonical.onboarding.v2", facts, observations: {}, configuration: policySet.configuration, subjectIds: [],
          scope: { jurisdiction: entry.scope.jurisdiction, institution: set.metadata.institution, products: [...entry.scope.products].sort(), customerType: entry.scope.customerType, legalForm: entry.scope.legalForm } }),
    };
  };
  return runImpact({ set, gateId, diligenceGateId: "diligence-level", levels: candidate.diligence!.levels, baseline: side(baseline), candidate: side(candidate) });
}

afterAll(closeBusinessPolicyEvaluators);

describe("impact simulation", () => {
  it("parses the bank's regression set and maps signals onto the selected facts", () => {
    expect(set.cases.length).toBe(20);
    expect(regressionFacts({ pepVerified: true, countries: ["IR"], assessedRisk: "HIGH" }, at)).toMatchObject({ asOf: at, assessedRisk: { tier: "HIGH" },
      selected: { policyRecordPEPRelationship: [{ data: { verified: true } }], policyRecordGeographyExposure: [{ data: { country: "IR" } }], policyCaseFindings: [], packOwnership: [] } });
    expect(() => regressionSetSchema.parse({ ...parse(read("domains/policy/regression/bank-synthetic.yaml")), cases: [set.cases[0], set.cases[0]] })).toThrow("policy.regression_case_duplicate");
  });

  it("reports nothing changed when the candidate is the baseline", async () => {
    const report = await opaImpact(kyb, kyb);
    expect(report.summary).toMatchObject({ cases: 10, changed: 0 });
    expect(report.rows.every((row) => row.baseline.policySet !== null)).toBe(true);
  }, 120_000);

  it("finds exactly the cases a change affects, and why", async () => {
    const report = await opaImpact(kyb, candidateOf(kyb));
    const changed = Object.fromEntries(report.rows.filter((row) => row.changes.length).map((row) => [row.caseId, row.changes]));
    expect(changed).toEqual({
      // The same cell decides, at a lower level.
      "us-trust-payments": ["LEVEL_LOWERED", "REQUIREMENTS_REMOVED"],
      // Adverse media is not mandatory in GB: switching it on raises the level, adds its requirement and its approval.
      "gb-sole-trader-acquiring": ["LEVEL_RAISED", "REQUIREMENTS_ADDED", "APPROVALS_ADDED", "RULES_CHANGED"],
    });
    expect(report.rows.find((row) => row.caseId === "us-trust-payments")).toMatchObject({ baseline: { level: "EDD" }, candidate: { level: "CDD" } });
    expect(report.rows.find((row) => row.caseId === "gb-sole-trader-acquiring")!.candidate.approvals).toEqual(["overlay.adverse-media:Case.Reviewerx1"]);
    expect(report.summary).toMatchObject({ cases: 10, changed: 2, byChange: { LEVEL_LOWERED: 1, LEVEL_RAISED: 1, APPROVALS_ADDED: 1, STATE_CHANGED: 0 } });
  }, 120_000);

  it("is reproducible: the same report, and digest, from OPA twice and from the reference evaluation", async () => {
    const candidate = candidateOf(kyb);
    const first = await opaImpact(kyb, candidate);
    const again = await opaImpact(parse(stringify(kyb)) as BusinessPolicySource, parse(stringify(candidate)) as BusinessPolicySource);
    expect(stableDigest(again)).toBe(stableDigest(first));
    expect(await referenceImpact(kyb, candidate)).toEqual(first);
  }, 180_000);

  it("runs the checkpoint gates too, each reading the side's own diligence decision", async () => {
    // A candidate that withdraws the low-risk carve-out: clean cases go to two reviewers instead.
    const withdrawn = structuredClone(kyb);
    for (const policySet of withdrawn.policySets) (policySet.configuration as Record<string, unknown>).automatic_approval_low_risk = false;
    const report = await opaImpact(kyb, withdrawn, "disposition");
    expect(report.gateId).toBe("disposition");
    const clean = report.rows.find((row) => row.caseId === "us-company-deposit")!;
    expect(clean.baseline).toMatchObject({ state: "DECIDED", actions: ["FinalizeDisposition:APPROVED"] });
    expect(clean.candidate).toMatchObject({ state: "NEEDS_HUMAN", actions: ["human:Case.Reviewer x2"] });
    expect(clean.changes).toEqual(["STATE_CHANGED", "ACTIONS_CHANGED", "RULES_CHANGED"]);
    // A PEP owner's case needs people either way: the diligence rule's approvals hold it under both.
    expect(report.rows.find((row) => row.caseId === "gb-company-pep-owner")!.changes).toEqual([]);
    // The reference evaluation agrees with OPA at every gate.
    for (const gate of ["intake-ready", "decision-ready", "disposition"]) {
      expect(await referenceImpact(kyb, withdrawn, gate), gate).toEqual(await opaImpact(kyb, withdrawn, gate));
    }
  }, 300_000);

  it("maps checkpoint signals onto the evidence the readiness rules read", async () => {
    const facts = regressionFacts({ screened: ["sanctions"], identityVerified: false, tasksComplete: false }, at, "corporate") as { selected: Record<string, Array<{ data?: Record<string, unknown>; value?: Record<string, unknown> }>> };
    expect(facts.selected.packScreening!.map((record) => record.data!.screening_type)).toEqual(["sanctions"]);
    expect(facts.selected.packVerification![0]!.data).toMatchObject({ status: "UNVERIFIED", method: "registry_extract" });
    expect(facts.selected.policyCaseClaims!.map((claim) => [claim.value!.agent, claim.value!.status])).toContainEqual(["agent.screening", "BLOCKED"]);
    const ready = await opaImpact(kyb, kyb, "decision-ready");
    expect(ready.rows.every((row) => row.baseline.state === "DECIDED")).toBe(true);
  }, 120_000);
});