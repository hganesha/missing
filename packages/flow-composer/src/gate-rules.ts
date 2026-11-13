import type { BusinessPolicySource, PolicyPredicate } from "@ehf/policy-engine";

/**
 * SYNTHETIC checkpoint rules for the agentic KYC and KYB flows (business-policy-v2 gates over the
 * `canonical.onboarding.v2` input profile). They are placeholders an installation's policy owner
 * replaces or approves: every rule id starts `synthetic.` and every reason code that can stop or
 * decide a case says SYNTHETIC in the rule's own id, so nobody mistakes them for a real
 * institution's policy. The policy sets they bind stay CANDIDATE, and the case API refuses to
 * evaluate a candidate set (`policy.candidate_authority_forbidden`) until an owner approves it.
 *
 * What the rules read (OPA input): `/facts/selected/<selectorId>` — the gate node's projected case
 * snapshot (canonical records as `{object_type, object_id, data, observed_at, ...}`; case rows such
 * as claims and contradictions as stored) — `/facts/humanReview`, `/facts/asOf`, and
 * `/configuration`, the pinned effective pack's values plus installation content.
 *
 * The rules are first-match. Each gate lists what stops the case first, then what lets it pass;
 * `otherwise` never decides. Nothing here approves a case except the low-risk carve-out at the
 * disposition gate, and only when the pack grants it (`automatic_approval_low_risk`).
 */

export const AGENT_TASK_OUTCOME = "agent_task_outcome";
/** The claim the EDD trigger evaluation records when enhanced due diligence is required. */
export const EDD_REQUIRED = "edd_required";
export type GateId = "intake-ready" | "decision-ready" | "disposition";
type Gate = BusinessPolicySource["gates"][string];
type Result = Gate["otherwise"];
type Rule = Gate["rules"][number];

const selected = (selector: string) => `/facts/selected/${selector}`;

/** True when the list at `path` exists and has no items (fail closed when it is absent). */
const none = (path: string): PolicyPredicate => ({ every: { path, allowEmpty: true, where: { path: "/__no_item_matches__", op: "present" } } });

const gap = (code: string, path: string) => ({ code, path, subjectId: null });
const evidence = (code: string, path: string): Result => ({
  state: "NEEDS_EVIDENCE", reasonCodes: [code], ruleIds: [], actions: [], humanRequirement: null, gaps: [gap(code, path)],
});
const ready = (code: string): Result => ({ state: "DECIDED", reasonCodes: [code], ruleIds: [], actions: [], humanRequirement: null, gaps: [] });
const disposition = (outcome: "APPROVED" | "DECLINED", rationale: string) => ({
  kind: "case_command" as const, commandType: "FinalizeDisposition" as const, payload: { outcome, rationale },
});

const HUMAN_APPROVE = disposition("APPROVED", "Approved by the required reviewers under the SYNTHETIC checkpoint policy.");
const HUMAN_DECLINE = disposition("DECLINED", "Declined by the required reviewers under the SYNTHETIC checkpoint policy.");
/** Four-eyes: two independent reviewers, never the proposer, approve, decline or return the case. */
const humanReview = (quorum: 1 | 2, code: string): Result => ({
  state: "NEEDS_HUMAN", reasonCodes: [code], ruleIds: [], actions: [], gaps: [],
  humanRequirement: {
    roles: ["Case.Reviewer"], quorum, independentOfProposer: true, allowedChoices: ["APPROVE", "REJECT", "RETURN"],
    actionIntents: { APPROVE: [HUMAN_APPROVE], REJECT: [HUMAN_DECLINE], RETURN: [] }, ttlSeconds: 7 * 86400,
  },
});

/**
 * Agent task outcomes (the runtime's task-completion judgment, recorded as claims). COMPLETED: every
 * required skill passed. NEEDS_REVIEW: the skills passed but the evidence is ambiguous or the agent
 * asked for a person, which a checkpoint lets through to the people at disposition and never into the
 * low-risk carve-out. Anything else (BLOCKED, NEEDS_EVIDENCE, unknown) holds the case.
 */
const PASSED: string[] = ["COMPLETED", "NEEDS_REVIEW"];
const CLEAR: string[] = ["COMPLETED"];

/**
 * An outcome that holds the case. It may since have been superseded, so the rules that use it only
 * explain a case that did not pass.
 */
const agentTaskIncomplete: PolicyPredicate = { some: { path: selected("policyCaseClaims"), where: { all: [
  { path: "/predicate", op: "eq", value: AGENT_TASK_OUTCOME },
  { path: "/value/status", op: "ne", value: "COMPLETED" },
  { path: "/value/status", op: "ne", value: "NEEDS_REVIEW" },
] } } };
/**
 * Every recorded agent task outcome is in `accepted`, or superseded by a strictly later outcome of the
 * same agent that is (a re-run after the missing evidence arrived). `required`: at least one recorded.
 */
const agentTasksIn = (accepted: string[], required: boolean): PolicyPredicate => ({ all: [
  ...(required ? [{ some: { path: selected("policyCaseClaims"), where: { path: "/predicate", op: "eq", value: AGENT_TASK_OUTCOME } } } as PolicyPredicate] : []),
  { every: { path: selected("policyCaseClaims"), allowEmpty: !required, where: { any: [
    { path: "/predicate", op: "ne", value: AGENT_TASK_OUTCOME },
    { path: "/value/status", op: "in", value: accepted },
    { some: { path: selected("policyCaseClaims"), fromInput: true, where: { all: [
      { path: "/predicate", op: "eq", value: AGENT_TASK_OUTCOME },
      { path: "/value/agent", op: "eq", valueFromParent: { depth: 1, path: "/value/agent" } },
      { path: "/value/status", op: "in", value: accepted },
      { path: "/created_at", op: "after", valueFromParent: { depth: 1, path: "/created_at" } },
    ] } } },
  ] } } },
] });
/** Every agent's latest task passed (COMPLETED or NEEDS_REVIEW). */
const agentTasksComplete = agentTasksIn(PASSED, true);
/** The named agent's task passed (its latest outcome, with agentTasksComplete). */
const agentCompleted = (agent: string): PolicyPredicate => ({ some: { path: selected("policyCaseClaims"), where: { all: [
  { path: "/predicate", op: "eq", value: AGENT_TASK_OUTCOME },
  { path: "/value/agent", op: "eq", value: agent },
  { path: "/value/status", op: "in", value: PASSED },
] } } });

const oneRelationship: PolicyPredicate = { path: selected("packRelationship"), op: "count_gte", value: 1 };

/**
 * Each screening type the pack requires has a completed, untruncated run within the pack's list
 * freshness. A later failed or truncated re-run does not undo a valid one; an expired run is
 * superseded only by a fresh one.
 */
const screeningCovered: PolicyPredicate = { every: { path: "/configuration/required_screening_types", allowEmpty: false, where: {
  some: { path: selected("packScreening"), fromInput: true, where: { all: [
    { path: "/data/screening_type", op: "eq", valueFromParent: { depth: 1, path: "" } },
    { path: "/data/status", op: "eq", value: "COMPLETED" },
    { path: "/data/truncated", op: "eq", value: false },
    { path: "/data/query_time", op: "age_lte_seconds", valueFrom: "/configuration/freshness_seconds/WatchlistEntry" },
  ] } },
} } };
const screeningFailed: PolicyPredicate = { some: { path: selected("packScreening"), where: { any: [
  { path: "/data/status", op: "ne", value: "COMPLETED" },
  { path: "/data/truncated", op: "eq", value: true },
] } } };
/** The customer's identity is verified by an accepted method, within the pack's verification freshness. */
const identityVerified: PolicyPredicate = { some: { path: selected("packVerification"), where: { all: [
  { path: "/data/status", op: "eq", value: "VERIFIED" },
  { path: "/data/method", op: "in", valueFrom: "/configuration/verification_methods" },
  { path: "/observed_at", op: "age_lte_seconds", valueFrom: "/configuration/freshness_seconds/VerificationRecord" },
] } } };
/**
 * Ownership is complete when the ownership agent's task completed: the runtime's judgment over its
 * graph, effective-interest, beneficial-owner and verification skills, each of which answers
 * NEEDS_EVIDENCE while a range, cycle, opaque holder or unaccounted interest stays unresolved.
 */
const OWNERSHIP_AGENT = "agent.identity_ownership";
const contradictionOpen: PolicyPredicate = { some: { path: selected("policyCaseContradictions"), where: { all: [
  { path: "/status", op: "in", value: ["OPEN", "UNDER_INVESTIGATION"] },
  { path: "/materiality", op: "in", value: ["HIGH", "MATERIAL"] },
] } } };
const noOpenContradiction: PolicyPredicate = { every: { path: selected("policyCaseContradictions"), allowEmpty: true, where: {
  path: "/status", op: "in", value: ["RESOLVED", "ACCEPTED_RISK", "SUPERSEDED"],
} } };

/** Findings that no longer stand against the customer: resolved, or shown to be exculpatory. */
const SETTLED_FINDING = ["RESOLVED", "EXCULPATORY"];

/**
 * Low risk, for the disposition carve-out: every requirement above is met, nothing adverse was
 * found (no screening hit, PEP relationship or adverse-media event at all; no finding still standing),
 * and every risk factor scores at or below the pack's ceiling. Absent data is never low risk.
 */
function lowRisk(requirements: PolicyPredicate[]): PolicyPredicate {
  return { all: [
    { path: "/configuration/automatic_approval_low_risk", op: "eq", value: true },
    ...requirements,
    none(selected("policyRecordScreeningHit")),
    none(selected("policyRecordPEPRelationship")),
    none(selected("policyRecordAdverseMediaEvent")),
    // An agent's REVIEW or BLOCKING finding is recorded UNVERIFIED and holds the case for people
    // until a reviewer or an investigation skill settles it.
    { every: { path: selected("policyRecordFinding"), allowEmpty: true, where: { path: "/data/status", op: "in", value: SETTLED_FINDING } } },
    noOpenContradiction,
    { every: { path: selected("packScreening"), allowEmpty: false, where: { path: "/data/candidate_count", op: "lte", value: 0 } } },
    { every: { path: selected("policyRecordRiskFactor"), allowEmpty: false, where: {
      path: "/data/score", op: "lte", valueFrom: "/configuration/low_risk_max_factor_score" } } },
    { every: { path: selected("policyRecordFraudSignal"), allowEmpty: true, where: { any: [
      { path: "/data/kind", op: "ne", value: "document_tamper" },
      { path: "/data/score", op: "lte", valueFrom: "/configuration/low_risk_max_factor_score" },
    ] } } },
    // Decision support ran and did not recommend declining.
    { every: { path: selected("policyCaseDecisionRecommendations"), allowEmpty: false, where: { path: "/outcome", op: "ne", value: "DECLINE" } } },
  ] };
}

const rule = (id: string, when: PolicyPredicate, result: Result): Rule => ({ id: `synthetic.${id}`, when, result: result as Rule["result"] });

/** Enhanced due diligence: the customer's (and, for a person, the wealth's) source is verified with evidence. */
const fundsVerified = (customer: "individual" | "corporate"): PolicyPredicate => ({ all: [
  { some: { path: selected("policyRecordSourceOfFunds"), where: { path: "/data/verified", op: "eq", value: true } } },
  { every: { path: selected("policyRecordSourceOfFunds"), allowEmpty: false, where: { path: "/data/verified", op: "eq", value: true } } },
  ...(customer === "individual" ? [{ every: { path: selected("policyRecordSourceOfWealth"), allowEmpty: false, where: { path: "/data/verified", op: "eq", value: true } } } as PolicyPredicate] : []),
] });
const fundsUnverified = (customer: "individual" | "corporate"): PolicyPredicate => ({ any: [
  { path: selected("policyRecordSourceOfFunds"), op: "missing" },
  { every: { path: selected("policyRecordSourceOfFunds"), allowEmpty: true, where: { path: "/__no_item_matches__", op: "present" } } },
  { some: { path: selected("policyRecordSourceOfFunds"), where: { path: "/data/verified", op: "ne", value: true } } },
  ...(customer === "individual" ? [{ some: { path: selected("policyRecordSourceOfWealth"), where: { path: "/data/verified", op: "ne", value: true } } } as PolicyPredicate] : []),
] });

export type GateOptions = {
  dueDiligence?: "simplified" | "standard" | "enhanced";
  /**
   * The agent whose completed task establishes ownership. Defaults to the ownership agent for a
   * company under standard or enhanced due diligence; null when the process does not run it (an
   * event review the event cannot affect keeps the ownership established before).
   */
  ownershipAgent?: string | null;
};

/**
 * The three checkpoints for one customer type and due-diligence level. Simplified due diligence
 * (an eligible listed company, government body or regulated institution) is exempt from ownership;
 * enhanced due diligence needs verified source of funds (and of wealth for a person) and never takes
 * the low-risk carve-out.
 *
 * Each gate passes first and explains after: the pass rule requires every agent's latest task outcome
 * to be COMPLETED (a re-run supersedes an earlier BLOCKED one), and only a case that does not pass
 * meets the explanatory rules, the first matching naming the reason.
 */
export function syntheticGates(customer: "individual" | "corporate", dueDiligenceOrOptions: GateOptions["dueDiligence"] | GateOptions = "standard"): Record<GateId, Gate> {
  const options: GateOptions = typeof dueDiligenceOrOptions === "string" ? { dueDiligence: dueDiligenceOrOptions } : dueDiligenceOrOptions;
  const dueDiligence = options.dueDiligence ?? "standard";
  const profile = "canonical.onboarding.v2";
  const enhanced = dueDiligence === "enhanced";
  const ownershipAgent = options.ownershipAgent !== undefined ? options.ownershipAgent
    : customer === "corporate" && dueDiligence !== "simplified" ? OWNERSHIP_AGENT : null;
  const decisionRequirements: PolicyPredicate[] = [
    agentTasksComplete, screeningCovered, identityVerified,
    ...(ownershipAgent ? [agentCompleted(ownershipAgent)] : []),
    ...(enhanced ? [fundsVerified(customer)] : []),
  ];
  const incomplete = (gate: string) => rule(`${gate}.agent-task-incomplete`, agentTaskIncomplete, evidence("AGENT_TASK_INCOMPLETE", selected("policyCaseClaims")));
  const settled = agentTasksIn(PASSED, false);
  return {
    "intake-ready": { inputProfile: profile, rules: [
      rule("intake.ready", { all: [oneRelationship, settled] }, ready("SYNTHETIC_INTAKE_READY")),
      rule("intake.relationship-missing", none(selected("packRelationship")), evidence("BANKING_RELATIONSHIP_MISSING", selected("packRelationship"))),
      incomplete("intake"),
    ], otherwise: evidence("BANKING_RELATIONSHIP_MISSING", selected("packRelationship")) },

    "decision-ready": { inputProfile: profile, rules: [
      // A standard or simplified process never decides a case its EDD triggers flag: it escalates it to
      // the enhanced process (case-plan selection with enhanced due diligence) through a work item.
      ...(enhanced ? [] : [rule("decision.edd-escalation", { some: { path: selected("policyCaseClaims"), where: { path: "/predicate", op: "eq", value: EDD_REQUIRED } } }, {
        ...evidence("EDD_ESCALATION_REQUIRED", selected("policyCaseClaims")),
        actions: [{ kind: "case_command", commandType: "ProposeWorkItem", payload: { workItemId: "edd-escalation", workType: "EDD_ESCALATION", priority: "HIGH",
          description: "The EDD triggers fired: continue this case under the enhanced due-diligence process (source of funds and wealth verified, ownership fully mapped)." } }],
      })]),
      rule("decision.ready", { all: decisionRequirements }, ready("SYNTHETIC_DECISION_READY")),
      // Why not: a missing source-of-funds verification or a failed screen first, then an agent task
      // still outstanding (incomplete ownership shows here: the ownership agent's task did not complete).
      ...(enhanced ? [rule("decision.edd-funds-unverified", fundsUnverified(customer), evidence("EDD_SOURCE_OF_FUNDS_UNVERIFIED", selected("policyRecordSourceOfFunds")))] : []),
      rule("decision.screening-failed", screeningFailed, evidence("SCREENING_INCOMPLETE", selected("packScreening"))),
      incomplete("decision"),
    ], otherwise: evidence("DECISION_EVIDENCE_INCOMPLETE", selected("packScreening")) },

    disposition: { inputProfile: profile, rules: [
      // A person's answer, once the required number of independent reviewers agree.
      rule("disposition.review-conflict", { path: "/facts/humanReview/conflict", op: "eq", value: true }, humanReview(2, "REVIEWERS_DISAGREE")),
      rule("disposition.human-decline", { path: "/facts/humanReview/counts/REJECT", op: "gte", valueFrom: "/facts/humanReview/requirement/quorum" },
        { ...ready("HUMAN_DECLINED"), actions: [HUMAN_DECLINE], humanIntent: { decisionId: "$input/facts/humanReview/decisionId", choice: "REJECT" } } as Result),
      // No approval, by people or by the carve-out, while a material contradiction is open: the
      // reviewers resolve it first (the case store refuses such an approval too).
      rule("disposition.material-contradiction", contradictionOpen, humanReview(2, "MATERIAL_CONTRADICTION_OPEN")),
      rule("disposition.human-approve", { path: "/facts/humanReview/counts/APPROVE", op: "gte", valueFrom: "/facts/humanReview/requirement/quorum" },
        { ...ready("HUMAN_APPROVED"), actions: [HUMAN_APPROVE], humanIntent: { decisionId: "$input/facts/humanReview/decisionId", choice: "APPROVE" } } as Result),
      // The low-risk carve-out the pack grants: approved without a person. Never under enhanced due diligence.
      // Only when every agent's latest outcome is COMPLETED: an agent that asked for a person gets one.
      ...(enhanced ? [] : [rule("disposition.low-risk-approve", lowRisk([...decisionRequirements, agentTasksIn(CLEAR, true)]), {
        ...ready("SYNTHETIC_LOW_RISK_APPROVED"),
        actions: [disposition("APPROVED", "Automatically approved as low risk under the SYNTHETIC checkpoint policy: every check complete and clear, every risk factor within the pack's ceiling.")],
      })]),
      // Everything else whose agent tasks are settled goes to people: two independent reviewers where
      // the pack requires dual control, else one.
      rule("disposition.dual-control", { all: [settled, { path: "/configuration/dual_control_required", op: "eq", value: true }] }, humanReview(2, "DUAL_CONTROL_REVIEW_REQUIRED")),
      rule("disposition.human-review", settled, humanReview(1, "HUMAN_REVIEW_REQUIRED")),
    ], otherwise: evidence("AGENT_TASK_INCOMPLETE", selected("policyCaseClaims")) },
  };
}
