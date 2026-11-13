import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { BusinessDecisionBasis } from "@ehf/contracts";
import { businessPolicyInput, closeBusinessPolicyEvaluators, compileBusinessPolicy, evaluateBusinessPolicy, type BusinessPolicySource } from "./business-policy.js";
import { applyApprovalGuard } from "./diligence/approvals.js";
import { evaluateDiligence, predicateMatches } from "./diligence/evaluate.js";
import { diligenceDesignSchema, diligenceSourceSchema, projectDiligenceDesign, type DiligenceSource } from "./diligence/schema.js";

// Rules with effects (Product Policy Studio phase D): added requirements with provenance, approvals
// carried by the diligence decision, and the guard that enforces them at disposition.
const d = "a".repeat(64);
const at = "2026-11-11T00:00:00Z";
const design = diligenceDesignSchema.parse(parse(readFileSync(new URL("../../../domains/policy/diligence/bank-synthetic.yaml", import.meta.url), "utf8")));
const unresolved = { state: "UNRESOLVED" as const, reasonCodes: ["NOT_AUTHORED"], ruleIds: [], actions: [], humanRequirement: null, gaps: [] };
const configuration = { mandatory_overlays: [], simplified_due_diligence_permitted: false, diligence_floors: {} };
const sets = (["individual", "corporate"] as const).map((customerType) => ({
  id: `set.${customerType}`, version: "2.0.0", status: "CANDIDATE" as const, packPin: { id: "pack.test", digest: d },
  scope: { jurisdiction: "US", institution: "bank.synthetic", products: customerType === "individual" ? ["card", "deposit", "payments"] : ["deposit", "lending", "merchant_acquiring", "payments"],
    customerTypes: [customerType], purposes: ["CDD_ONBOARDING"] },
  modules: [{ id: "pack.test", version: "1.0.0", digest: d }], configuration,
}));

/** The bank's rules with effects: approvals for PEPs and complex ownership, requirements for media. */
function effectsBlock(): DiligenceSource {
  const block = structuredClone(projectDiligenceDesign(design, sets));
  const rule = (id: string) => block.overlays.find((entry) => entry.id === id)!;
  rule("overlay.pep").effect = { escalateTo: "EDD", requireApproval: { role: "Case.Reviewer", quorum: 2, reason: "Senior approval of a PEP relationship." } };
  Object.assign(rule("overlay.adverse-media"), { enabled: true, effect: { addRequirements: ["EVD-PUBLIC-SOURCE-RESEARCH", "EVD-SOURCE-OF-FUNDS"] } });
  rule("overlay.complex-ownership").effect = { escalateTo: "EDD", addRequirements: ["EVD-PUBLIC-SOURCE-RESEARCH"], requireApproval: { role: "Harness.Approver", quorum: 1, reason: "Opaque ownership." } };
  rule("overlay.high-risk-geography").effect = { escalateBy: 1, addRequirements: ["EVD-EDD-NARRATIVE"] };
  return block;
}
const FINALIZE = { kind: "case_command" as const, commandType: "FinalizeDisposition" as const, payload: { outcome: "APPROVE", level: "$input/facts/diligence/level" } };
const HUMAN = { roles: ["Case.Analyst"], quorum: 1, independentOfProposer: true, allowedChoices: ["APPROVE" as const, "REJECT" as const], actionIntents: { APPROVE: [], REJECT: [] }, ttlSeconds: 3600 };
function policy(diligence: DiligenceSource = effectsBlock()): BusinessPolicySource {
  return {
    apiVersion: "harness.factory/business-policy-v2", kind: "BusinessPolicy",
    metadata: { id: "policy.effects.test", version: "2.0.0", owner: "policy.owner" }, decisionTtlSeconds: 60, policySets: structuredClone(sets),
    gates: {
      "decision-ready": { inputProfile: "canonical.onboarding.v2", rules: [{ id: "ready.never", when: { path: "/facts/never", op: "present" }, result: structuredClone(unresolved) }], otherwise: structuredClone(unresolved) },
      disposition: { inputProfile: "canonical.onboarding.v2", rules: [
        { id: "disposition.decide", when: { path: "/facts/flag", op: "eq", value: "decide" }, result: { state: "DECIDED", reasonCodes: ["READY"], ruleIds: [], actions: [FINALIZE], humanRequirement: null, gaps: [] } },
        { id: "disposition.human", when: { path: "/facts/flag", op: "eq", value: "human" }, result: { state: "NEEDS_HUMAN", reasonCodes: ["REVIEW"], ruleIds: [], actions: [], humanRequirement: HUMAN, gaps: [] } },
        { id: "disposition.intent", when: { path: "/facts/flag", op: "eq", value: "intent" }, result: { state: "DECIDED", reasonCodes: ["REVIEWED"], ruleIds: [], actions: [], humanRequirement: null, gaps: [], humanIntent: { decisionId: "decision_prior", choice: "APPROVE" } } },
      ], otherwise: structuredClone(unresolved) },
    },
    diligence,
  };
}
const source = policy();
const scope = (customerType: "individual" | "corporate", products: string[], legalForm: string) => ({ jurisdiction: "US", institution: "bank.synthetic", products, customerType, legalForm });
type Facts = { pep?: boolean; country?: string; owners?: number; media?: boolean };
function facts(options: Facts = {}): Record<string, unknown> {
  return { asOf: at, selected: {
    policyRecordPEPRelationship: options.pep ? [{ data: { verified: true } }] : [], policyCaseFindings: [],
    policyRecordGeographyExposure: options.country ? [{ data: { country: options.country } }] : [],
    packOwnership: Array.from({ length: options.owners ?? 0 }, (_, index) => ({ data: { owner: `x${index}` } })),
    policyRecordAdverseMediaEvent: options.media ? [{ data: { status: "CONFIRMED" } }] : [], policyRecordRiskFactor: [],
  } };
}
const run = (s: ReturnType<typeof scope>, f = facts()) => evaluateDiligence(source.diligence!, { gateId: "diligence-level", facts: f, observations: {}, configuration, scope: s });
const refusal = (change: (block: Record<string, any>) => void) => {
  const block = structuredClone(effectsBlock()) as Record<string, any>; change(block);
  const parsed = diligenceSourceSchema.safeParse(block);
  return parsed.success ? "accepted" : parsed.error.issues.map((issue) => issue.message).join(";");
};

afterAll(closeBusinessPolicyEvaluators);

describe("rule effects only add", () => {
  it("refuses an effect that is empty, contradictory, or anything but an addition", () => {
    expect(refusal((b) => { b.overlays[0].effect = {}; })).toContain("policy.diligence_overlay_effect_empty:overlay.pep");
    expect(refusal((b) => { b.overlays[0].effect = { escalateTo: "EDD", escalateBy: 1 }; })).toContain("policy.diligence_overlay_effect_conflict:overlay.pep");
    expect(refusal((b) => { b.overlays[0].effect = { addRequirements: ["EVD-X", "EVD-X"] }; })).toContain("policy.diligence_overlay_requirements_duplicate:overlay.pep");
    expect(refusal((b) => { b.overlays[0].effect = { requireApproval: { role: "senior management", quorum: 1, reason: "x" } }; })).toContain("policy.diligence_approval_role_invalid");
    // No effect can lower a level, remove a requirement, switch a control off or grant.
    for (const effect of [{ lowerTo: "SDD" }, { removeRequirements: ["EVD-CIP-ADDRESS"] }, { disableOverlays: ["overlay.pep"] }, { grant: "APPROVE" }, { escalateBy: 0 }, { escalateBy: -1 }])
      expect(refusal((b) => { b.overlays[0].effect = effect; }), JSON.stringify(effect)).not.toBe("accepted");
    expect(refusal((b) => { b.overlays[0].effect.requireApproval.quorum = 0; })).not.toBe("accepted");
  });

  it("refuses approvals without an approval gate, and a rule id an authored rule already uses", () => {
    const compile = (change: (s: BusinessPolicySource) => void) => { const s = policy(); change(s); try { compileBusinessPolicy(s, { opaVersion: "1.9.0" }); return "compiled"; } catch (error) { return String(error); } };
    expect(compile((s) => { delete s.gates.disposition; })).toContain("policy.diligence_approval_gate_missing:disposition");
    expect(compile((s) => { s.diligence!.approvalGateId = "decision-ready"; })).toBe("compiled");
    expect(compile((s) => { s.gates["decision-ready"]!.rules[0]!.id = "overlay.pep"; })).toContain("policy.diligence_rule_id_collision:overlay.pep");
  });
});

describe("requirements with provenance, and approvals", () => {
  it("adds requirements without changing the level, and says where each came from", () => {
    const media = run(scope("corporate", ["deposit"], "corporation"), facts({ media: true })).outputs!.diligence;
    expect(media.level).toBe("CDD");
    expect(media.requirements.slice(-2)).toEqual(["EVD-PUBLIC-SOURCE-RESEARCH", "EVD-SOURCE-OF-FUNDS"]);
    expect(media.requirementSources.find((entry) => entry.requirement === "EVD-PUBLIC-SOURCE-RESEARCH")).toEqual({ requirement: "EVD-PUBLIC-SOURCE-RESEARCH", from: ["overlay.adverse-media"] });
    expect(media.requirementSources.find((entry) => entry.requirement === "EVD-SOURCE-OF-FUNDS")).toEqual({ requirement: "EVD-SOURCE-OF-FUNDS", from: ["overlay.adverse-media"] });
    expect(media.requirementSources.find((entry) => entry.requirement === "EVD-CIP-ADDRESS")).toEqual({ requirement: "EVD-CIP-ADDRESS", from: ["diligence.level.CDD"] });
    expect(media.contributors).toContainEqual({ kind: "overlay", id: "overlay.adverse-media", level: "CDD" });
    expect(media.approvals).toEqual([]);
  });

  it("lists every rule behind a requirement, once, and the approvals of the rules that fired", () => {
    const all = run(scope("corporate", ["deposit"], "corporation"), facts({ pep: true, media: true, owners: 3, country: "IR" })).outputs!.diligence;
    expect(all.level).toBe("EDD");
    expect(all.requirements.filter((entry) => entry === "EVD-PUBLIC-SOURCE-RESEARCH")).toHaveLength(1);
    expect(all.requirementSources.find((entry) => entry.requirement === "EVD-PUBLIC-SOURCE-RESEARCH")!.from).toEqual(["overlay.adverse-media", "overlay.complex-ownership"]);
    expect(all.requirementSources.find((entry) => entry.requirement === "EVD-SOURCE-OF-FUNDS")!.from).toEqual(["diligence.level.EDD", "overlay.adverse-media"]);
    expect(all.approvals).toEqual([
      { ruleId: "overlay.complex-ownership", role: "Harness.Approver", quorum: 1, reason: "Opaque ownership." },
      { ruleId: "overlay.pep", role: "Case.Reviewer", quorum: 2, reason: "Senior approval of a PEP relationship." }]);
    for (const entry of all.requirementSources) expect(entry.from.length).toBeGreaterThan(0);
  });

  it("decides every effects corpus case exactly as the reference evaluation does, under OPA", async () => {
    const compiled = compileBusinessPolicy(source, { opaVersion: "1.9.0" });
    const variants: Facts[] = [{}, { pep: true }, { media: true }, { owners: 3 }, { country: "IR" }, { pep: true, media: true }, { pep: true, owners: 4, country: "KP", media: true }];
    let compared = 0;
    for (const set of compiled.policySets) {
      const customerType = set.scope.customerTypes[0]!;
      for (const legalForm of customerType === "individual" ? ["individual"] : ["corporation", "fund", "ordinary_trust"]) for (const products of [[set.scope.products[0]!], set.scope.products]) for (const variant of variants) {
        const basis = basisFor(compiled, set, "diligence-level", scope(customerType, products, legalForm));
        const input = facts(variant);
        const opa = (await evaluateBusinessPolicy({ compiled, basis, facts: input })).result;
        expect(opa, `${legalForm} ${products.join("+")} ${JSON.stringify(variant)}`).toEqual(evaluateDiligence(source.diligence!, businessPolicyInput({ basis, facts: input, configuration: set.configuration })));
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(50);
  }, 120_000);
});

function basisFor(compiled: ReturnType<typeof compileBusinessPolicy>, set: ReturnType<typeof compileBusinessPolicy>["policySets"][number], gateId: string, s: ReturnType<typeof scope>): BusinessDecisionBasis {
  return { tenantId: "t", caseId: "c", planDigest: d, releaseDigest: d, caseSequence: 1, snapshotDigest: d, dependencyDigest: d, selectedInputDigest: d,
    effectivePolicySetDigest: set.setDigest, policyBundleDigest: compiled.manifest.bundleDigest, inputProfile: "canonical.onboarding.v2", gateId, purpose: "CDD_ONBOARDING",
    subjectIds: [], proposerPrincipalIds: [], evaluatedAt: at, knowledgeCutoff: at, scope: s };
}

describe("the approval guard at disposition", () => {
  const PEP = { ruleId: "overlay.pep", role: "Case.Reviewer", quorum: 2, reason: "PEP" };
  const OWNERSHIP = { ruleId: "overlay.complex-ownership", role: "Harness.Approver", quorum: 1, reason: "Ownership" };
  /**
   * A review as the case store reports it. `satisfied` says per choice whether its votes met the total
   * and each role's quorum (here: its count reaches the total, as when every vote came from the right roles).
   */
  const review = (roles: string[], quorum: number, counts: Record<string, number>, conflict = false, roleQuorums?: Record<string, number>, satisfied?: Record<string, boolean>) => {
    const all = { APPROVE: 0, REJECT: 0, RETURN: 0, ...counts };
    return { decisionId: "decision_review", requirement: { ...HUMAN, roles, quorum, ...(roleQuorums ? { roleQuorums } : {}) }, counts: all, conflict,
      satisfied: satisfied ?? Object.fromEntries(Object.entries(all).map(([choice, count]) => [choice, count >= quorum])) };
  };
  const BOTH = { "Case.Reviewer": 2, "Harness.Approver": 1 };
  const diligenceFacts = [undefined, { level: "EDD", approvals: [] }, { level: "EDD", approvals: [PEP] }, { level: "EDD", approvals: [PEP, OWNERSHIP] }, { approvals: [{ role: 1 }] }];
  const reviews = [undefined, review(["Case.Reviewer"], 2, { APPROVE: 2 }), review(["Case.Reviewer"], 2, { REJECT: 2 }), review(["Case.Reviewer"], 2, { APPROVE: 1 }),
    review(["Case.Reviewer"], 2, { APPROVE: 2, REJECT: 2 }, true), review(["Case.Reviewer", "Harness.Approver"], 2, { APPROVE: 2 }), review(["Harness.Approver"], 1, { APPROVE: 1 }), review(["Case.Reviewer"], 1, { APPROVE: 1 }),
    // Per-role quorums: met, met for REJECT, and three votes that do not fill the roles' slots.
    review(["Case.Reviewer"], 2, { APPROVE: 2 }, false, { "Case.Reviewer": 2 }), review(["Case.Reviewer", "Harness.Approver"], 3, { APPROVE: 3 }, false, BOTH),
    review(["Case.Reviewer", "Harness.Approver"], 3, { REJECT: 3 }, false, BOTH), review(["Case.Reviewer", "Harness.Approver"], 3, { APPROVE: 3 }, false, BOTH, { APPROVE: false, REJECT: false, RETURN: false }),
    review(["Case.Reviewer", "Harness.Approver"], 3, { APPROVE: 3 }, false, { "Case.Reviewer": 1, "Harness.Approver": 1 })];
  /** The authored gate as the compiled rules decide it: first match, else otherwise. */
  const authored = (input: Record<string, unknown>) => {
    const gate = source.gates.disposition!;
    const rule = gate.rules.find((entry) => predicateMatches(entry.when, input, [], input));
    return rule ? { ...structuredClone(rule.result), ruleIds: [rule.id] } : structuredClone(gate.otherwise);
  };
  const resolve = (value: unknown, input: Record<string, unknown>): unknown => typeof value === "string" && value.startsWith("$input/")
    ? value.slice(7).split("/").reduce<any>((current, part) => current?.[part], input)
    : Array.isArray(value) ? value.map((item) => resolve(item, input)) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, input)])) : value;

  it("never lets an approval grant: a decision stands only with its authored actions, after people approve", async () => {
    const compiled = compileBusinessPolicy(source, { opaVersion: "1.9.0" });
    const set = compiled.policySets.find((entry) => entry.scope.customerTypes.includes("corporate"))!;
    let compared = 0;
    for (const flag of ["decide", "human", "intent", "nothing"]) for (const diligence of diligenceFacts) for (const humanReview of reviews) {
      const factsIn = { asOf: at, flag, ...(diligence ? { diligence } : {}), ...(humanReview ? { humanReview } : {}) };
      const basis = basisFor(compiled, set, "disposition", scope("corporate", ["deposit"], "corporation"));
      const input = businessPolicyInput({ basis, facts: factsIn, configuration: set.configuration });
      const opa = (await evaluateBusinessPolicy({ compiled, basis, facts: factsIn })).result;
      const reference = resolve(applyApprovalGuard(authored(input), input), input);
      const label = `${flag} ${JSON.stringify(diligence)} ${JSON.stringify(humanReview)}`;
      expect(opa, label).toEqual(reference);
      compared++;
      const pending = diligence && Array.isArray(diligence.approvals) && diligence.approvals.length > 0 && typeof (diligence.approvals[0] as { role: unknown }).role === "string";
      // The properties, independent of the reference.
      if (diligence === undefined || !pending && !(Array.isArray(diligence.approvals) && diligence.approvals.length === 0)) {
        expect(opa.state, label).not.toBe("DECIDED");
      }
      if (pending && opa.state === "DECIDED") {
        expect(opa.humanIntent, label).toBeDefined();
        if (opa.humanIntent?.choice === "APPROVE") expect(opa.actions, label).toEqual(flag === "decide" ? [{ ...FINALIZE, payload: { outcome: "APPROVE", level: "EDD" } }] : []);
        else expect(opa.actions, label).toEqual([]);
      }
      if (pending && opa.state === "NEEDS_HUMAN") {
        const roles = (diligence!.approvals as Array<{ role: string }>).map((entry) => entry.role);
        expect(opa.humanRequirement!.roles, label).toEqual(expect.arrayContaining(roles));
        expect(opa.actions, label).toEqual([]);
      }
    }
    expect(compared).toBe(4 * diligenceFacts.length * reviews.length);
  }, 120_000);

  it("asks the approval roles to decide, then lets the authored decision through once they approve", async () => {
    const compiled = compileBusinessPolicy(source, { opaVersion: "1.9.0" });
    const set = compiled.policySets.find((entry) => entry.scope.customerTypes.includes("corporate"))!;
    const decide = async (extra: Record<string, unknown>) => (await evaluateBusinessPolicy({ compiled, basis: basisFor(compiled, set, "disposition", scope("corporate", ["deposit"], "corporation")),
      facts: { asOf: at, flag: "decide", diligence: { level: "EDD", approvals: [PEP, OWNERSHIP] }, ...extra } })).result;
    const asked = await decide({});
    expect(asked).toMatchObject({ state: "NEEDS_HUMAN", reasonCodes: ["DILIGENCE_APPROVAL_REQUIRED"], ruleIds: ["disposition.decide", "overlay.complex-ownership", "overlay.pep"],
      humanRequirement: { roles: ["Case.Reviewer", "Harness.Approver"], quorum: 3, roleQuorums: BOTH,
        actionIntents: { APPROVE: [{ ...FINALIZE, payload: { outcome: "APPROVE", level: "EDD" } }], REJECT: [], RETURN: [] } } });
    // Each role keeps its own quorum: two reviewers and one approver, three people in all.
    const approved = await decide({ humanReview: review(["Case.Reviewer", "Harness.Approver"], 3, { APPROVE: 3 }, false, BOTH) });
    expect(approved).toMatchObject({ state: "DECIDED", humanIntent: { decisionId: "decision_review", choice: "APPROVE" }, actions: asked.humanRequirement!.actionIntents.APPROVE });
    expect(approved.reasonCodes).toEqual(["DILIGENCE_APPROVAL_GRANTED", "READY"]);
    const rejected = await decide({ humanReview: review(["Case.Reviewer", "Harness.Approver"], 3, { REJECT: 3 }, false, BOTH) });
    expect(rejected).toMatchObject({ state: "DECIDED", reasonCodes: ["DILIGENCE_APPROVAL_REJECTED"], actions: [], humanIntent: { choice: "REJECT" } });
    // A review by fewer roles, a lower quorum for a role, or votes that do not fill each role's slots does not count.
    expect((await decide({ humanReview: review(["Case.Reviewer"], 2, { APPROVE: 2 }, false, { "Case.Reviewer": 2 }) })).state).toBe("NEEDS_HUMAN");
    expect((await decide({ humanReview: review(["Case.Reviewer", "Harness.Approver"], 3, { APPROVE: 3 }, false, { "Case.Reviewer": 1, "Harness.Approver": 1 }) })).state).toBe("NEEDS_HUMAN");
    expect((await decide({ humanReview: review(["Case.Reviewer", "Harness.Approver"], 3, { APPROVE: 3 }, false, BOTH, { APPROVE: false, REJECT: false, RETURN: false }) })).state).toBe("NEEDS_HUMAN");
  }, 60_000);

  it("leaves gates other than the approval gate as authored", async () => {
    const compiled = compileBusinessPolicy(source, { opaVersion: "1.9.0" });
    const set = compiled.policySets[0]!;
    const result = (await evaluateBusinessPolicy({ compiled, basis: basisFor(compiled, set, "decision-ready", scope("individual", ["card"], "individual")), facts: { asOf: at } })).result;
    expect(result).toEqual(unresolved);
  });
});
