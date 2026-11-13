import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import {
  closeBusinessPolicyEvaluators, compileBusinessPolicy, evaluateBusinessPolicy,
  type EffectivePolicyPack,
} from "../../packages/policy-engine/src/index.js";
import { agenticBusinessPolicy } from "./agentic-business-policy.js";
import { AGENT_TASK_OUTCOME } from "./agentic-gate-rules.js";
import { interpret } from "./policy-interpreter.js";

/**
 * The SYNTHETIC checkpoint rules (agentic-gate-rules.ts) over hand-built case facts. Every scenario
 * runs through a small reference interpreter of the business-policy-v2 predicate language, so the
 * rules' logic is checked everywhere, and through the emitted OPA bundle wherever OPA is installed
 * (always in CI), which must agree with it.
 */

const root = new URL("../../", import.meta.url).pathname;
const pack = (id: string) => JSON.parse(readFileSync(`${root}artifacts/policy/packs/${id}.json`, "utf8")) as EffectivePolicyPack;
const fields = ["freshness_seconds", "verification_methods", "screening_threshold"];
const kyc = agenticBusinessPolicy("kyc-agentic", [pack("policy.pack.us.bank-synthetic.personal-banking"), pack("policy.pack.gb.bank-synthetic.personal-banking")], fields);
const kyb = agenticBusinessPolicy("kyb-agentic", [pack("policy.pack.us.bank-synthetic.business-banking"), pack("policy.pack.gb.bank-synthetic.business-banking")], fields);
const kycEdd = agenticBusinessPolicy("kyc-edd-agentic", [pack("policy.pack.us.bank-synthetic.personal-banking"), pack("policy.pack.gb.bank-synthetic.personal-banking")], fields, { dueDiligence: "enhanced" });
const kybReview = agenticBusinessPolicy("kyb-review-agentic", [pack("policy.pack.us.bank-synthetic.business-banking"), pack("policy.pack.gb.bank-synthetic.business-banking")], fields, { ownershipAgent: null });
const kybSdd = agenticBusinessPolicy("kyb-sdd-agentic", [pack("policy.pack.us.bank-synthetic.business-banking"), pack("policy.pack.gb.bank-synthetic.business-banking")], fields, { dueDiligence: "simplified" });

// ---------------------------------------------------------------------------------------------
// Case facts

const AS_OF = "2026-11-10T12:00:00Z";
const recent = (hoursAgo: number) => new Date(Date.parse(AS_OF) - hoursAgo * 3_600_000).toISOString();
const record = (objectType: string, id: string, data: Record<string, Json>, observedAt = recent(1)) =>
  ({ object_type: objectType, object_id: id, version_id: "v1", data, observed_at: observedAt, synthetic: true });
// Case claim rows as the case store projects them (created_at is when the outcome was recorded).
const task = (agent: string, status: string, hoursAgo = 3) => ({ predicate: AGENT_TASK_OUTCOME, value: { agent, status, reasons: [] }, status: "PROPOSED", created_at: recent(hoursAgo) });
const screening = (type: string, extra: Record<string, Json> = {}) =>
  record("ScreeningExecution", `screen-${type}`, { screening_type: type, status: "COMPLETED", truncated: false, candidate_count: 0, query_time: recent(2), subject: "c1", ...extra });

type Facts = { selected: Record<string, Json[]>; humanReview: Json };
function clean(customer: "individual" | "corporate"): Facts {
  return {
    humanReview: null,
    selected: {
      packRelationship: [record("BankingRelationship", "rel", { customerEntityId: "c1" })],
      // Business banking (merchant acquiring) also requires adverse-media screening.
      packScreening: [screening("sanctions"), screening("pep"), ...(customer === "corporate" ? [screening("adverse_media")] : [])],
      packVerification: [record("VerificationRecord", "ver", { subject: "c1", status: "VERIFIED", method: customer === "corporate" ? "registry_extract" : "government_id_document" }, recent(24))],
      policyRecordRiskFactor: [record("RiskFactor", "rf1", { name: "customer_type", score: "0.05" }), record("RiskFactor", "rf2", { name: "geography", score: "0.10" })],
      policyRecordScreeningHit: [], policyRecordPEPRelationship: [], policyRecordAdverseMediaEvent: [], policyRecordFinding: [], policyRecordFraudSignal: [],
      policyCaseClaims: [task("agent.intake_profile", "COMPLETED"), task("agent.screening", "COMPLETED"),
        ...(customer === "corporate" ? [task("agent.identity_ownership", "COMPLETED")] : [])],
      policyCaseContradictions: [],
      policyCaseDecisionRecommendations: [{ outcome: "REVIEW", requires_human_review: true }],
    },
  };
}
const configuration = (compiled: ReturnType<typeof compileBusinessPolicy>, jurisdiction = "US") =>
  compiled.policySets.find((set) => set.scope.jurisdiction === jurisdiction)!.configuration;
const DILIGENCE = { decisionId: "decision_diligence", caseSequence: 6, level: "CDD", requirements: ["EVD-SANCTIONS-SCREENING"], screeningTypes: ["sanctions"], approvals: [] };
const input = (policy: typeof kyc, gateId: string, facts: Facts, overrides: Record<string, Json> = {}) => ({
  // The case's diligence decision, as the case API supplies it to every gate after the diligence gate:
  // a CDD level whose rules require no approvals (the disposition gate's approval guard reads it).
  gateId, inputProfile: "canonical.onboarding.v2", facts: { ...facts, asOf: AS_OF, caseSequence: 7, diligence: DILIGENCE }, observations: {}, subjectIds: ["c1"],
  configuration: { ...configuration(policy.compiled), ...overrides },
});
const humanVotes = (approve: number, reject: number) => ({
  decisionId: "decision_prior", inputDigest: "a".repeat(64), requestDigest: "a".repeat(64), votes: [],
  requirement: { quorum: 2 }, counts: { APPROVE: approve, REJECT: reject, RETURN: 0 }, conflict: approve > 0 && reject > 0,
});

type Scenario = { name: string; policy: typeof kyc; gate: string; facts: Facts; overrides?: Record<string, Json>; state: string; reason: string; quorum?: number; outcome?: string; actions?: string[] };
const scenarios: Scenario[] = [];
const add = (s: Scenario) => scenarios.push(s);
const mutate = (customer: "individual" | "corporate", change: (f: Facts) => void) => { const f = clean(customer); change(f); return f; };

for (const gate of ["intake-ready", "decision-ready"]) add({ name: `clean individual passes ${gate}`, policy: kyc, gate, facts: clean("individual"), state: "DECIDED", reason: gate === "intake-ready" ? "SYNTHETIC_INTAKE_READY" : "SYNTHETIC_DECISION_READY" });
add({ name: "clean low-risk individual is approved without a person", policy: kyc, gate: "disposition", facts: clean("individual"), state: "DECIDED", reason: "SYNTHETIC_LOW_RISK_APPROVED", outcome: "APPROVED" });
add({ name: "withdrawing the carve-out sends the same clean case to two reviewers", policy: kyc, gate: "disposition", facts: clean("individual"), overrides: { automatic_approval_low_risk: false }, state: "NEEDS_HUMAN", reason: "DUAL_CONTROL_REVIEW_REQUIRED", quorum: 2 });
add({ name: "no relationship stops intake", policy: kyc, gate: "intake-ready", facts: mutate("individual", (f) => { f.selected.packRelationship = []; }), state: "NEEDS_EVIDENCE", reason: "BANKING_RELATIONSHIP_MISSING" });
const rerun = (f: Facts) => { f.selected.policyCaseClaims!.push(task("agent.identity_verification", "BLOCKED", 5), task("agent.identity_verification", "COMPLETED", 2)); };
add({ name: "a blocked task re-run to completion no longer holds decision-ready", policy: kyc, gate: "decision-ready", facts: mutate("individual", rerun), state: "DECIDED", reason: "SYNTHETIC_DECISION_READY" });
add({ name: "a blocked task re-run to completion can take the low-risk carve-out", policy: kyc, gate: "disposition", facts: mutate("individual", rerun), state: "DECIDED", reason: "SYNTHETIC_LOW_RISK_APPROVED", outcome: "APPROVED" });
add({ name: "a superseded blocked task does not mask the real reason", policy: kyc, gate: "disposition", facts: mutate("individual", (f) => { rerun(f); f.selected.policyRecordPEPRelationship = [record("PEPRelationship", "pep", {})]; }), state: "NEEDS_HUMAN", reason: "DUAL_CONTROL_REVIEW_REQUIRED", quorum: 2 });
add({ name: "a completion recorded before the block does not supersede it", policy: kyc, gate: "decision-ready", facts: mutate("individual", (f) => { f.selected.policyCaseClaims!.push(task("agent.identity_verification", "COMPLETED", 5), task("agent.identity_verification", "BLOCKED", 2)); }), state: "NEEDS_EVIDENCE", reason: "AGENT_TASK_INCOMPLETE" });
add({ name: "another agent's completion does not supersede a block", policy: kyc, gate: "decision-ready", facts: mutate("individual", (f) => { f.selected.policyCaseClaims!.push(task("agent.identity_verification", "BLOCKED", 5), task("agent.screening", "COMPLETED", 1)); }), state: "NEEDS_EVIDENCE", reason: "AGENT_TASK_INCOMPLETE" });
const reviewRequested = (f: Facts) => { f.selected.policyCaseClaims!.push(task("agent.screening", "NEEDS_REVIEW", 1)); };
add({ name: "an agent asking for a person does not stop decision-ready", policy: kyc, gate: "decision-ready", facts: mutate("individual", reviewRequested), state: "DECIDED", reason: "SYNTHETIC_DECISION_READY" });
add({ name: "an agent asking for a person keeps the case out of the carve-out", policy: kyc, gate: "disposition", facts: mutate("individual", reviewRequested), state: "NEEDS_HUMAN", reason: "DUAL_CONTROL_REVIEW_REQUIRED", quorum: 2 });
add({ name: "a later clean re-run lifts an earlier review request", policy: kyc, gate: "disposition", facts: mutate("individual", (f) => { f.selected.policyCaseClaims!.push(task("agent.screening", "NEEDS_REVIEW", 5)); }), state: "DECIDED", reason: "SYNTHETIC_LOW_RISK_APPROVED", outcome: "APPROVED" });
add({ name: "an unknown task status is incomplete", policy: kyc, gate: "disposition", facts: mutate("individual", (f) => { f.selected.policyCaseClaims!.push(task("agent.screening", "CANCELLED", 1)); }), state: "NEEDS_EVIDENCE", reason: "AGENT_TASK_INCOMPLETE" });
add({ name: "a resolved finding does not hold a low-risk case", policy: kyc, gate: "disposition", facts: mutate("individual", (f) => { f.selected.policyRecordFinding = [record("Finding", "fd1", { claim: "address mismatch", evidence_ids: ["ev"], status: "RESOLVED" }), record("Finding", "fd2", { claim: "alias", evidence_ids: ["ev"], status: "EXCULPATORY" })]; }), state: "DECIDED", reason: "SYNTHETIC_LOW_RISK_APPROVED", outcome: "APPROVED" });
add({ name: "an agent's unverified finding goes to two reviewers", policy: kyc, gate: "disposition", facts: mutate("individual", (f) => { f.selected.policyRecordFinding = [record("Finding", "fd1", { claim: "IDENTITY: address mismatch", evidence_ids: ["ev"], status: "UNVERIFIED" })]; }), state: "NEEDS_HUMAN", reason: "DUAL_CONTROL_REVIEW_REQUIRED", quorum: 2 });
for (const gate of ["intake-ready", "decision-ready", "disposition"]) {
  add({ name: `a blocked agent task stops ${gate}`, policy: kyc, gate, facts: mutate("individual", (f) => { f.selected.policyCaseClaims!.push(task("agent.identity_verification", "BLOCKED")); }), state: "NEEDS_EVIDENCE", reason: "AGENT_TASK_INCOMPLETE" });
}
add({ name: "a missing PEP screen is not decision-ready", policy: kyc, gate: "decision-ready", facts: mutate("individual", (f) => { f.selected.packScreening = [screening("sanctions")]; }), state: "NEEDS_EVIDENCE", reason: "DECISION_EVIDENCE_INCOMPLETE" });
add({ name: "a failed screen is not decision-ready", policy: kyc, gate: "decision-ready", facts: mutate("individual", (f) => { f.selected.packScreening = [screening("sanctions"), screening("pep", { status: "FAILED" })]; }), state: "NEEDS_EVIDENCE", reason: "SCREENING_INCOMPLETE" });
add({ name: "a truncated screen is not decision-ready", policy: kyc, gate: "decision-ready", facts: mutate("individual", (f) => { f.selected.packScreening = [screening("sanctions", { truncated: true }), screening("pep")]; }), state: "NEEDS_EVIDENCE", reason: "SCREENING_INCOMPLETE" });
add({ name: "a later failed re-run does not undo a valid screen", policy: kyc, gate: "decision-ready", facts: mutate("individual", (f) => { f.selected.packScreening!.push(screening("pep", { status: "FAILED", query_time: recent(1) })); }), state: "DECIDED", reason: "SYNTHETIC_DECISION_READY" });
add({ name: "a fresh re-run supersedes an expired screen", policy: kyc, gate: "decision-ready", facts: mutate("individual", (f) => { f.selected.packScreening!.push(screening("sanctions", { query_time: recent(24 * 400) })); }), state: "DECIDED", reason: "SYNTHETIC_DECISION_READY" });
add({ name: "a stale screen is not decision-ready", policy: kyc, gate: "decision-ready", facts: mutate("individual", (f) => { f.selected.packScreening = [screening("sanctions", { query_time: recent(24 * 30) }), screening("pep")]; }), state: "NEEDS_EVIDENCE", reason: "DECISION_EVIDENCE_INCOMPLETE" });
add({ name: "an unverified identity is not decision-ready", policy: kyc, gate: "decision-ready", facts: mutate("individual", (f) => { f.selected.packVerification = [record("VerificationRecord", "ver", { status: "UNVERIFIED", method: "government_id_document" })]; }), state: "NEEDS_EVIDENCE", reason: "DECISION_EVIDENCE_INCOMPLETE" });
add({ name: "a PEP relationship goes to two reviewers", policy: kyc, gate: "disposition", facts: mutate("individual", (f) => { f.selected.policyRecordPEPRelationship = [record("PEPRelationship", "pep", { relation: "sibling", verified: true })]; }), state: "NEEDS_HUMAN", reason: "DUAL_CONTROL_REVIEW_REQUIRED", quorum: 2 });
add({ name: "a screening hit goes to two reviewers", policy: kyc, gate: "disposition", facts: mutate("individual", (f) => { f.selected.policyRecordScreeningHit = [record("ScreeningHit", "hit", { features: { verified_match: false, score: 0.9 } })]; }), state: "NEEDS_HUMAN", reason: "DUAL_CONTROL_REVIEW_REQUIRED", quorum: 2 });
add({ name: "an elevated risk factor goes to two reviewers", policy: kyc, gate: "disposition", facts: mutate("individual", (f) => { f.selected.policyRecordRiskFactor!.push(record("RiskFactor", "rf3", { name: "geography", score: "0.40" })); }), state: "NEEDS_HUMAN", reason: "DUAL_CONTROL_REVIEW_REQUIRED", quorum: 2 });
add({ name: "no risk factors is never low risk", policy: kyc, gate: "disposition", facts: mutate("individual", (f) => { f.selected.policyRecordRiskFactor = []; }), state: "NEEDS_HUMAN", reason: "DUAL_CONTROL_REVIEW_REQUIRED", quorum: 2 });
add({ name: "a decline recommendation goes to two reviewers", policy: kyc, gate: "disposition", facts: mutate("individual", (f) => { f.selected.policyCaseDecisionRecommendations = [{ outcome: "DECLINE" }]; }), state: "NEEDS_HUMAN", reason: "DUAL_CONTROL_REVIEW_REQUIRED", quorum: 2 });
add({ name: "an open material contradiction holds even two approvals", policy: kyc, gate: "disposition", facts: mutate("individual", (f) => {
  f.selected.policyCaseContradictions = [{ status: "OPEN", materiality: "MATERIAL" }]; f.humanReview = humanVotes(2, 0);
}), state: "NEEDS_HUMAN", reason: "MATERIAL_CONTRADICTION_OPEN", quorum: 2 });
add({ name: "two approvals approve", policy: kyc, gate: "disposition", facts: mutate("individual", (f) => { f.selected.policyRecordPEPRelationship = [record("PEPRelationship", "pep", {})]; f.humanReview = humanVotes(2, 0); }), state: "DECIDED", reason: "HUMAN_APPROVED", outcome: "APPROVED" });
add({ name: "one approval is not enough under dual control", policy: kyc, gate: "disposition", facts: mutate("individual", (f) => { f.selected.policyRecordPEPRelationship = [record("PEPRelationship", "pep", {})]; f.humanReview = humanVotes(1, 0); }), state: "NEEDS_HUMAN", reason: "DUAL_CONTROL_REVIEW_REQUIRED", quorum: 2 });
add({ name: "two declines decline, even with an open contradiction", policy: kyc, gate: "disposition", facts: mutate("individual", (f) => { f.selected.policyCaseContradictions = [{ status: "OPEN", materiality: "HIGH" }]; f.humanReview = humanVotes(0, 2); }), state: "DECIDED", reason: "HUMAN_DECLINED", outcome: "DECLINED" });
add({ name: "reviewers who disagree are asked again", policy: kyc, gate: "disposition", facts: mutate("individual", (f) => { f.humanReview = humanVotes(1, 1); }), state: "NEEDS_HUMAN", reason: "REVIEWERS_DISAGREE", quorum: 2 });
add({ name: "clean corporate with complete ownership is approved", policy: kyb, gate: "disposition", facts: clean("corporate"), state: "DECIDED", reason: "SYNTHETIC_LOW_RISK_APPROVED", outcome: "APPROVED" });
add({ name: "clean corporate with complete ownership is decision-ready", policy: kyb, gate: "decision-ready", facts: clean("corporate"), state: "DECIDED", reason: "SYNTHETIC_DECISION_READY" });
add({ name: "a corporate without adverse-media screening is not decision-ready", policy: kyb, gate: "decision-ready", facts: mutate("corporate", (f) => { f.selected.packScreening = [screening("sanctions"), screening("pep")]; }), state: "NEEDS_EVIDENCE", reason: "DECISION_EVIDENCE_INCOMPLETE" });
const ownershipBlocked = (f: Facts) => { f.selected.policyCaseClaims = [...f.selected.policyCaseClaims!.filter((c) => (c as { value: { agent: string } }).value.agent !== "agent.identity_ownership"), task("agent.identity_ownership", "NEEDS_EVIDENCE")]; };
const ownershipNotRun = (f: Facts) => { f.selected.policyCaseClaims = f.selected.policyCaseClaims!.filter((c) => (c as { value: { agent: string } }).value.agent !== "agent.identity_ownership"); };
add({ name: "incomplete ownership (the ownership agent's task did not complete) is not decision-ready", policy: kyb, gate: "decision-ready", facts: mutate("corporate", ownershipBlocked), state: "NEEDS_EVIDENCE", reason: "AGENT_TASK_INCOMPLETE" });
add({ name: "ownership never established is not decision-ready", policy: kyb, gate: "decision-ready", facts: mutate("corporate", ownershipNotRun), state: "NEEDS_EVIDENCE", reason: "DECISION_EVIDENCE_INCOMPLETE" });
add({ name: "a seeded ownership flag is not evidence of ownership", policy: kyb, gate: "decision-ready", facts: mutate("corporate", (f) => { ownershipNotRun(f); f.selected.packRelationship = [record("BankingRelationship", "rel", { ownershipComplete: true })]; }), state: "NEEDS_EVIDENCE", reason: "DECISION_EVIDENCE_INCOMPLETE" });
add({ name: "incomplete ownership is never low risk", policy: kyb, gate: "disposition", facts: mutate("corporate", ownershipBlocked), state: "NEEDS_EVIDENCE", reason: "AGENT_TASK_INCOMPLETE" });
add({ name: "an event review that does not run the ownership agent keeps the ownership established before", policy: kybReview, gate: "decision-ready", facts: mutate("corporate", ownershipNotRun), state: "DECIDED", reason: "SYNTHETIC_DECISION_READY" });

const eddClaim = { predicate: "edd_required", value: { triggers: [{ id: "edd-pep-candidate", outcome: "PASS" }] }, status: "PROPOSED" };
const verifiedFunds = (f: Facts) => {
  f.selected.policyRecordSourceOfFunds = [record("SourceOfFunds", "sof", { claim: "salary", evidence_ids: ["ev"], verified: true })];
  f.selected.policyRecordSourceOfWealth = [record("SourceOfWealth", "sow", { claim: "inheritance", evidence_ids: ["ev"], verified: true })];
};
add({ name: "fired EDD triggers escalate a standard case instead of deciding it", policy: kyc, gate: "decision-ready", facts: mutate("individual", (f) => { f.selected.policyCaseClaims!.push(eddClaim); }), state: "NEEDS_EVIDENCE", reason: "EDD_ESCALATION_REQUIRED", actions: ["ProposeWorkItem"] });
add({ name: "enhanced due diligence needs verified source of funds and wealth", policy: kycEdd, gate: "decision-ready", facts: clean("individual"), state: "NEEDS_EVIDENCE", reason: "EDD_SOURCE_OF_FUNDS_UNVERIFIED" });
add({ name: "unverified source of wealth holds an enhanced case", policy: kycEdd, gate: "decision-ready", facts: mutate("individual", (f) => { verifiedFunds(f); f.selected.policyRecordSourceOfWealth = [record("SourceOfWealth", "sow", { verified: false })]; }), state: "NEEDS_EVIDENCE", reason: "EDD_SOURCE_OF_FUNDS_UNVERIFIED" });
add({ name: "an enhanced case with verified funds is decision-ready, and its EDD claim does not escalate again", policy: kycEdd, gate: "decision-ready", facts: mutate("individual", (f) => { verifiedFunds(f); f.selected.policyCaseClaims!.push(eddClaim); }), state: "DECIDED", reason: "SYNTHETIC_DECISION_READY" });
add({ name: "an enhanced case is never approved without people", policy: kycEdd, gate: "disposition", facts: mutate("individual", verifiedFunds), state: "NEEDS_HUMAN", reason: "DUAL_CONTROL_REVIEW_REQUIRED", quorum: 2 });
add({ name: "simplified due diligence is decision-ready without ownership", policy: kybSdd, gate: "decision-ready", facts: mutate("corporate", ownershipNotRun), state: "DECIDED", reason: "SYNTHETIC_DECISION_READY" });
add({ name: "a clean simplified case is approved as low risk without ownership", policy: kybSdd, gate: "disposition", facts: mutate("corporate", ownershipNotRun), state: "DECIDED", reason: "SYNTHETIC_LOW_RISK_APPROVED", outcome: "APPROVED" });

function check(scenario: Scenario, result: { state: string; reasonCodes: string[]; humanRequirement: { quorum: number } | null; actions: Array<{ payload?: { outcome?: string } }> }) {
  expect(result.state, scenario.name).toBe(scenario.state);
  expect(result.reasonCodes, scenario.name).toEqual([scenario.reason]);
  if (scenario.quorum) expect(result.humanRequirement?.quorum, scenario.name).toBe(scenario.quorum);
  if (scenario.actions) expect(result.actions.map((action) => (action as { commandType?: string }).commandType), scenario.name).toEqual(scenario.actions);
  else expect(result.actions.map((action) => action.payload?.outcome), scenario.name).toEqual(scenario.outcome ? [scenario.outcome] : []);
}

describe("SYNTHETIC checkpoint rules (reference interpreter)", () => {
  it.each(scenarios.map((s) => [s.name, s] as const))("%s", (_name, scenario) => {
    check(scenario, interpret(scenario.policy.source, scenario.gate, input(scenario.policy, scenario.gate, scenario.facts, scenario.overrides)) as never);
  });

  it("are labelled synthetic, keep their sets CANDIDATE and never decide by default", () => {
    for (const policy of [kyc, kyb]) {
      for (const gate of Object.values(policy.source.gates)) {
        expect(gate.rules.every((rule) => rule.id.startsWith("synthetic."))).toBe(true);
        expect(gate.otherwise.state).not.toBe("DECIDED");
      }
      expect(policy.source.policySets.every((set) => set.status === "CANDIDATE")).toBe(true);
      expect(policy.compiled.productionEligible).toBe(false);
    }
  });

  it("only the low-risk rule approves without a person, and only when the pack grants it", () => {
    const approving = kyc.source.gates.disposition!.rules.filter((rule) => rule.result.state === "DECIDED" && !rule.result.humanIntent);
    expect(approving.map((rule) => rule.id)).toEqual(["synthetic.disposition.low-risk-approve"]);
    expect(JSON.stringify(approving[0]!.when)).toContain("/configuration/automatic_approval_low_risk");
  });
});

const opa = process.env.OPA_BIN ?? process.env.OPA_PATH ?? "opa";
const opaInstalled = (() => { try { execFileSync(opa, ["version"], { stdio: "ignore" }); return true; } catch { return false; } })();
afterAll(closeBusinessPolicyEvaluators);

describe.skipIf(!opaInstalled && !process.env.CI)("SYNTHETIC checkpoint rules (emitted OPA bundle)", () => {
  it.each(scenarios.map((s) => [s.name, s] as const))("%s", async (_name, scenario) => {
    const compiled = scenario.policy.compiled;
    const set = compiled.policySets.find((item) => item.scope.jurisdiction === "US")!;
    const facts = { ...scenario.facts, asOf: AS_OF, caseSequence: 7, diligence: DILIGENCE };
    const evaluated = compileBusinessPolicy({ ...scenario.policy.source, policySets: scenario.policy.source.policySets.map((item) =>
      item.id === set.id && scenario.overrides ? { ...item, configuration: { ...item.configuration, ...scenario.overrides } } : item) }, { opaVersion: "1.9.0" });
    const target = evaluated.policySets.find((item) => item.id === set.id)!;
    const d = "a".repeat(64);
    const decision = await evaluateBusinessPolicy({ compiled: evaluated, facts: facts as never, opaPath: opa, basis: {
      tenantId: "tenant.test", caseId: "case.test", planDigest: d, releaseDigest: d, caseSequence: 7, snapshotDigest: d, selectedInputDigest: d,
      proposerPrincipalIds: [], dependencyDigest: d, effectivePolicySetDigest: target.setDigest, policyBundleDigest: evaluated.manifest.bundleDigest,
      gateId: scenario.gate, inputProfile: "canonical.onboarding.v2", purpose: "CDD_ONBOARDING", subjectIds: ["c1"], evaluatedAt: AS_OF, knowledgeCutoff: AS_OF,
      scope: { jurisdiction: "US", institution: target.scope.institution, products: target.scope.products, customerType: target.scope.customerTypes[0]! },
    } });
    check(scenario, decision.result as never);
  });
});
