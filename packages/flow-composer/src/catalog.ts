import { selectPolicyPack, type EffectivePolicyPack } from "@ehf/policy-engine";
import type { HarnessPlanV2 } from "@ehf/contracts";

/**
 * The plan catalogue: released plans, each composed for one process scope (recorded on its
 * checkpoints as `processScope`), and the case-time choice of plan and policy pack.
 *
 * A case names its scope: who (customer type), why (trigger, review event), how much (due diligence),
 * where (one policy jurisdiction) and for what (its products). The catalogue chooses the one released
 * plan composed for that customer type, trigger, event and due-diligence level, then the one pack that
 * plan pinned for the case's jurisdiction whose product set holds every product. Anything else (no
 * plan, two plans, no pack, two packs, a missing fact) is a reason to stop, never to pick one.
 */
export type CaseScope = {
  customerType: string;
  trigger: string;
  dueDiligence?: string | undefined;
  event?: string | undefined;
  jurisdiction: string;
  products: string[];
  institution?: string | undefined;
};

export type PlanScope = { customerType: string; trigger: string; dueDiligence: string; event?: string; jurisdictions: string[]; products: string[]; institution: string };

/** A plan's process scope and pinned packs, from its checkpoint gates; null when it was not composed for a scope. */
export function planScope(plan: Pick<HarnessPlanV2, "graph">): { scope: PlanScope; packs: EffectivePolicyPack[] } | null {
  const gate = plan.graph.nodes.find((node) => node.kind === "gate" && node.config.processScope && Array.isArray(node.config.policyPacks));
  if (!gate) return null;
  return { scope: gate.config.processScope as PlanScope, packs: gate.config.policyPacks as EffectivePolicyPack[] };
}

export type CasePlanSelection<P> =
  | { status: "selected"; plan: P; pack: EffectivePolicyPack; scope: PlanScope }
  | { status: "no_plan" | "ambiguous_plan" | "no_pack" | "ambiguous_pack" | "context_incomplete"; reason: string; candidates: string[] };

/** The one released plan and pinned pack a case falls under, or why there is none. */
export function selectCasePlan<P extends Pick<HarnessPlanV2, "graph" | "planDigest">>(plans: P[], scope: CaseScope): CasePlanSelection<P> {
  if (!scope.customerType || !scope.trigger || !scope.jurisdiction || !scope.products?.length) {
    return { status: "context_incomplete", reason: "a case names its customer type, trigger, jurisdiction and products", candidates: [] };
  }
  const dueDiligence = scope.dueDiligence ?? "standard";
  const institution = scope.institution ?? "bank.synthetic";
  const process = plans.map((plan) => ({ plan, composed: planScope(plan) })).filter((item) => item.composed
    && item.composed.scope.customerType === scope.customerType && item.composed.scope.trigger === scope.trigger
    && item.composed.scope.dueDiligence === dueDiligence && (item.composed.scope.event ?? null) === (scope.event ?? null));
  if (!process.length) {
    return { status: "no_plan", reason: `no released plan for ${scope.customerType} ${scope.trigger}${scope.event ? ` (${scope.event})` : ""} with ${dueDiligence} due diligence`, candidates: [] };
  }
  const covering = process.map((item) => ({ ...item, selection: selectPolicyPack(item.composed!.packs,
    // A trust falls under the business-banking packs (a legal arrangement), as composition placed it.
    { jurisdiction: scope.jurisdiction, institution, products: [...new Set(scope.products)].sort(), customerType: scope.customerType === "trust" ? "corporate" : scope.customerType }) }));
  const selected = covering.filter((item) => item.selection.status === "selected");
  if (selected.length === 1) {
    const only = selected[0]!;
    return { status: "selected", plan: only.plan, pack: (only.selection as { pack: EffectivePolicyPack }).pack, scope: only.composed!.scope };
  }
  if (selected.length > 1) return { status: "ambiguous_plan", reason: "more than one released plan covers this case", candidates: selected.map((item) => item.plan.planDigest) };
  const ambiguous = covering.find((item) => item.selection.status === "ambiguous");
  if (ambiguous) return { status: "ambiguous_pack", reason: (ambiguous.selection as { reason: string }).reason, candidates: (ambiguous.selection as { candidates: string[] }).candidates };
  return { status: "no_pack", reason: `no released plan pins a pack for ${scope.jurisdiction} covering ${scope.products.join(", ")}`, candidates: process.map((item) => item.plan.planDigest) };
}
