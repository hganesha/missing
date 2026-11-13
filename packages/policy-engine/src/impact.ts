import { z } from "zod";

export { holds, interpretGate, referenceGateResult } from "./gate-reference.js";

/**
 * Impact simulation (Product Policy Studio phase F): run a regression set of synthetic cases through
 * a baseline policy and a candidate, and report what changes. Browser-safe; the evaluation is
 * injected, so the control API runs the compiled bundles in OPA and the Policy Studio mock runs the
 * reference evaluation. Every input is fixed by the set (scope, signals, as-of time), so the same
 * policies and set always give the same report.
 */

const id = z.string().min(1).max(200);
const country = z.string().regex(/^[A-Z]{2}$/);

/**
 * Case signals, mapped onto the selected facts of the `canonical.onboarding.v2` input profile. A case
 * is clean by default (relationship known, every screening complete and clear, identity verified,
 * every agent task complete, low risk); each signal changes one part.
 */
export const regressionSignalsSchema = z.object({
  pepVerified: z.boolean().default(false),
  pepSignal: z.boolean().default(false),
  countries: z.array(country).max(10).default([]),
  ownershipInterests: z.number().int().min(0).max(20).default(0),
  adverseMedia: z.boolean().default(false),
  /** A transaction risk factor score, 0 to 1. */
  transactionRisk: z.number().min(0).max(1).optional(),
  /** The case's assessed risk tier, as the risk skills would report it. */
  assessedRisk: z.enum(["LOW", "MEDIUM", "HIGH"]).optional(),
  // Checkpoint evidence (the readiness and disposition gates read these).
  /** Screening types executed, complete and clear for the customer. */
  screened: z.array(z.enum(["sanctions", "pep", "adverse_media", "watchlist"])).max(4).default(["sanctions", "pep", "adverse_media"]),
  /** An unresolved screening candidate. */
  screeningHit: z.boolean().default(false),
  identityVerified: z.boolean().default(true),
  /** Every agent's task completed; false records one BLOCKED task. */
  tasksComplete: z.boolean().default(true),
  /** An open material contradiction. */
  contradiction: z.boolean().default(false),
  /** The highest risk factor score, 0 to 1 (low risk at or below the pack's ceiling). */
  riskScore: z.number().min(0).max(1).default(0.05),
}).strict();

export const regressionSetSchema = z.object({
  apiVersion: z.literal("harness.factory/policy-regression-set-v1"),
  kind: z.literal("PolicyRegressionSet"),
  metadata: z.object({ id, institution: id, version: z.string().regex(/^\d+\.\d+\.\d+$/), description: z.string().min(1).max(1000) }).strict(),
  /** The as-of time every case is evaluated at. */
  asOf: z.iso.datetime({ offset: true }),
  cases: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), label: z.string().min(1).max(200),
    scope: z.object({ jurisdiction: country, customerType: z.enum(["individual", "corporate"]), legalForm: id, products: z.array(id).min(1).max(20) }).strict(),
    signals: regressionSignalsSchema.prefault({}),
  }).strict()).min(1).max(500),
}).strict().superRefine((set, ctx) => {
  const ids = set.cases.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", message: "policy.regression_case_duplicate" });
});
export type RegressionSet = z.infer<typeof regressionSetSchema>;
export type RegressionCase = RegressionSet["cases"][number];

/** The selected facts a case's signals stand for. */
export function regressionFacts(signals: z.input<typeof regressionSignalsSchema>, asOf: string, customerType: "individual" | "corporate" = "individual"): Record<string, unknown> {
  const s = regressionSignalsSchema.parse(signals);
  const before = (hours: number) => new Date(Date.parse(asOf) - hours * 3_600_000).toISOString();
  const record = (type: string, index: number, data: Record<string, unknown>, observedAt = before(1)) =>
    ({ object_type: type, object_id: `${type.toLowerCase()}-${index}`, version_id: "v1", data, observed_at: observedAt });
  const task = (agent: string, status = "COMPLETED") => ({ predicate: "agent_task_outcome", value: { agent, status, reasons: [] }, status: "PROPOSED", created_at: before(3) });
  return {
    asOf,
    humanReview: null,
    selected: {
      packRelationship: [record("BankingRelationship", 1, { customerEntityId: "customer" })],
      packScreening: s.screened.map((type, index) => record("ScreeningExecution", index + 1, {
        screening_type: type, status: "COMPLETED", truncated: false, candidate_count: s.screeningHit && type === "sanctions" ? 1 : 0, query_time: before(2), subject: "customer" })),
      packVerification: [record("VerificationRecord", 1, { subject: "customer", status: s.identityVerified ? "VERIFIED" : "UNVERIFIED",
        method: customerType === "corporate" ? "registry_extract" : "government_id_document" }, before(24))],
      policyRecordScreeningHit: s.screeningHit ? [record("ScreeningHit", 1, { features: { verified_match: false, score: 0.9 } })] : [],
      policyRecordFinding: [], policyRecordFraudSignal: [],
      policyCaseClaims: [task("agent.intake_profile"), task("agent.screening", s.tasksComplete ? "COMPLETED" : "BLOCKED"),
        ...(customerType === "corporate" ? [task("agent.identity_ownership")] : [])],
      policyCaseContradictions: s.contradiction ? [{ status: "OPEN", materiality: "MATERIAL" }] : [],
      policyCaseDecisionRecommendations: [{ outcome: "REVIEW", requires_human_review: true }],
      policyRecordPEPRelationship: s.pepVerified ? [record("PEPRelationship", 1, { source: "customer", target: "pep", relation: "self", verified: true })] : [],
      policyCaseFindings: s.pepSignal ? [{ findingType: "PEP_SIGNAL", status: "OPEN" }] : [],
      policyRecordGeographyExposure: s.countries.map((code, index) => record("GeographyExposure", index + 1, { country: code, basis: "residence", value: "1" })),
      packOwnership: Array.from({ length: s.ownershipInterests }, (_, index) => record("OwnershipInterest", index + 1, { owner: `owner-${index + 1}`, owned: "customer", interest: "0.2" })),
      policyRecordAdverseMediaEvent: s.adverseMedia ? [record("AdverseMediaEvent", 1, { status: "CONFIRMED" })] : [],
      policyRecordRiskFactor: [record("RiskFactor", 1, { name: "customer_type", score: String(s.riskScore) }),
        ...(s.transactionRisk === undefined ? [] : [record("RiskFactor", 2, { name: "transaction", score: String(s.transactionRisk) })])],
    },
    ...(s.assessedRisk ? { assessedRisk: { tier: s.assessedRisk, source: "regression-set" } } : {}),
  };
}

type PolicySetScope = { id: string; scope: { jurisdiction: string; institution: string; products: string[]; customerTypes: string[] } };
/** The one policy set that covers a case, or null (several matching count as none: never pick one). */
export function policySetFor<T extends PolicySetScope>(sets: readonly T[], institution: string, entry: Pick<RegressionCase, "scope">): T | null {
  const matches = sets.filter((set) => set.scope.jurisdiction === entry.scope.jurisdiction && set.scope.institution === institution
    && set.scope.customerTypes.includes(entry.scope.customerType) && entry.scope.products.every((product) => set.scope.products.includes(product)
      || set.scope.products.some((node) => /^[A-Z]/.test(node) && product.startsWith(`${node}.`))));
  return matches.length === 1 ? matches[0]! : null;
}

export type ImpactOutcome = {
  policySet: string | null; state: string; level: string | null; reasonCodes: string[]; ruleIds: string[];
  requirements: string[]; approvals: string[];
  /**
   * What the gate would do: each action (`FinalizeDisposition:APPROVED`, `ProposeWorkItem`) and the
   * people it asks for (`human:Case.Reviewer x2`). Empty for the diligence gate, which only decides a level.
   */
  actions: string[];
};
type Action = { kind?: string; commandType?: string; action?: string; payload?: { outcome?: unknown } };
type Result = {
  state: string; reasonCodes: string[]; ruleIds: string[]; actions?: Action[]; humanRequirement?: { roles?: string[]; quorum?: number } | null;
  outputs?: { diligence?: { level: string; requirements: string[]; screeningTypes?: string[]; approvals?: Array<{ ruleId: string; role: string; quorum: number; reason?: string }> } };
};

export function impactOutcome(policySet: string | null, result: Result | null): ImpactOutcome {
  if (!result) return { policySet, state: "NO_POLICY_SET", level: null, reasonCodes: [], ruleIds: [], requirements: [], approvals: [], actions: [] };
  const diligence = result.outputs?.diligence;
  const human = result.humanRequirement;
  return {
    policySet, state: result.state, level: diligence?.level ?? null, reasonCodes: [...result.reasonCodes], ruleIds: [...result.ruleIds],
    requirements: [...(diligence?.requirements ?? [])],
    approvals: (diligence?.approvals ?? []).map((approval) => `${approval.ruleId}:${approval.role}x${approval.quorum}`),
    actions: [
      ...(result.actions ?? []).map((action) => {
        const name = action.commandType ?? action.action ?? action.kind ?? "action";
        return typeof action.payload?.outcome === "string" ? `${name}:${action.payload.outcome}` : name;
      }),
      ...(human ? [`human:${[...(human.roles ?? [])].sort().join("+")} x${human.quorum ?? 1}`] : []),
    ],
  };
}

export const IMPACT_CHANGES = ["POLICY_SET_CHANGED", "STATE_CHANGED", "LEVEL_RAISED", "LEVEL_LOWERED", "REQUIREMENTS_ADDED", "REQUIREMENTS_REMOVED", "APPROVALS_ADDED", "APPROVALS_REMOVED", "ACTIONS_CHANGED", "RULES_CHANGED"] as const;
export type ImpactChange = (typeof IMPACT_CHANGES)[number];

/** What changed for one case, in a fixed order. */
export function impactChanges(baseline: ImpactOutcome, candidate: ImpactOutcome, levels: readonly string[]): ImpactChange[] {
  const changes = new Set<ImpactChange>();
  const added = (before: string[], after: string[]) => after.some((item) => !before.includes(item));
  if (baseline.policySet !== candidate.policySet) changes.add("POLICY_SET_CHANGED");
  if (baseline.state !== candidate.state) changes.add("STATE_CHANGED");
  if (baseline.level && candidate.level && baseline.level !== candidate.level) changes.add(levels.indexOf(candidate.level) > levels.indexOf(baseline.level) ? "LEVEL_RAISED" : "LEVEL_LOWERED");
  if (added(baseline.requirements, candidate.requirements)) changes.add("REQUIREMENTS_ADDED");
  if (added(candidate.requirements, baseline.requirements)) changes.add("REQUIREMENTS_REMOVED");
  if (added(baseline.approvals, candidate.approvals)) changes.add("APPROVALS_ADDED");
  if (added(candidate.approvals, baseline.approvals)) changes.add("APPROVALS_REMOVED");
  if ([...baseline.actions].sort().join("|") !== [...candidate.actions].sort().join("|")) changes.add("ACTIONS_CHANGED");
  if ([...baseline.ruleIds].sort().join("|") !== [...candidate.ruleIds].sort().join("|")) changes.add("RULES_CHANGED");
  return IMPACT_CHANGES.filter((change) => changes.has(change));
}

export type PolicyRef = { policyId: string; version: string; bundleDigest: string };
export type ImpactReport = {
  apiVersion: "harness.factory/policy-impact-v1";
  regressionSet: { id: string; version: string; cases: number };
  gateId: string;
  baseline: PolicyRef; candidate: PolicyRef;
  rows: Array<{ caseId: string; label: string; baseline: ImpactOutcome; candidate: ImpactOutcome; changes: ImpactChange[] }>;
  summary: { cases: number; changed: number; byChange: Record<ImpactChange, number> };
};

type Side<T extends PolicySetScope> = {
  ref: PolicyRef; sets: readonly T[];
  /** One gate's result for one case under one of the side's policy sets. */
  evaluate: (set: T, entry: RegressionCase, facts: Record<string, unknown>, gateId: string) => Promise<unknown>;
};

/**
 * Run every case of the set through both sides (one case at a time, in set order) at one gate and
 * report the differences. Each side chooses its own policy set for a case; a case no set covers is
 * reported as NO_POLICY_SET rather than forced into one. At a gate after the diligence gate, each
 * side first decides the case's diligence under its own policy and the gate reads that decision as
 * `facts.diligence`, as the case API supplies it (absent when the level is not decided).
 */
export async function runImpact<B extends PolicySetScope, C extends PolicySetScope>(input: {
  set: RegressionSet; gateId: string; levels: readonly string[]; baseline: Side<B>; candidate: Side<C>;
  /** The policy's diligence gate, when it has one. */
  diligenceGateId?: string | undefined;
}): Promise<ImpactReport> {
  const rows: ImpactReport["rows"] = [];
  const institution = input.set.metadata.institution;
  // Only the cases one side or the other serves (a KYC policy is not run on business customers).
  const served = (entry: RegressionCase) => [input.baseline.sets, input.candidate.sets].some((sets) => sets.some((set: PolicySetScope) =>
    set.scope.jurisdiction === entry.scope.jurisdiction && set.scope.customerTypes.includes(entry.scope.customerType)));
  const cases = input.set.cases.filter(served);
  for (const entry of cases) {
    const facts = regressionFacts(entry.signals, input.set.asOf, entry.scope.customerType);
    const outcome = async <T extends PolicySetScope>(side: Side<T>) => {
      const policySet = policySetFor(side.sets, institution, entry);
      if (!policySet) return impactOutcome(null, null);
      const caseFacts = structuredClone(facts);
      if (input.diligenceGateId && input.gateId !== input.diligenceGateId) {
        const decided = await side.evaluate(policySet, entry, structuredClone(facts), input.diligenceGateId) as Result;
        const diligence = decided.state === "DECIDED" ? decided.outputs?.diligence : undefined;
        if (diligence) caseFacts.diligence = { decisionId: `impact:${entry.id}:diligence`, caseSequence: 0, level: diligence.level, requirements: [...diligence.requirements],
          screeningTypes: [...(diligence.screeningTypes ?? [])], approvals: (diligence.approvals ?? []).map(({ ruleId, role, quorum, reason }) => ({ ruleId, role, quorum, reason: reason ?? "" })) };
      }
      return impactOutcome(policySet.id, await side.evaluate(policySet, entry, caseFacts, input.gateId) as Result);
    };
    const baseline = await outcome(input.baseline);
    const candidate = await outcome(input.candidate);
    rows.push({ caseId: entry.id, label: entry.label, baseline, candidate, changes: impactChanges(baseline, candidate, input.levels) });
  }
  const byChange = Object.fromEntries(IMPACT_CHANGES.map((change) => [change, rows.filter((row) => row.changes.includes(change)).length])) as Record<ImpactChange, number>;
  return {
    apiVersion: "harness.factory/policy-impact-v1",
    regressionSet: { id: input.set.metadata.id, version: input.set.metadata.version, cases: input.set.cases.length },
    /** Rows cover the cases either side serves. */
    gateId: input.gateId, baseline: input.baseline.ref, candidate: input.candidate.ref, rows,
    summary: { cases: rows.length, changed: rows.filter((row) => row.changes.length).length, byChange },
  };
}
