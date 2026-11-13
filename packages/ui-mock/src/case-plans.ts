import type { Rec } from "./fixtures.js";
import { hex64 } from "./handlers/cases.js";

/**
 * The mock's plan catalogue and case-time plan selection (control-api case-plans.ts over
 * @ehf/flow-composer selectCasePlan): a case names its scope and gets the one released plan composed
 * for its customer type, trigger, review event and due-diligence level, and the one pack that plan
 * pinned for the case's jurisdiction whose product set holds every product. Nothing is chosen by
 * default: no plan, no pack or more than one is refused with the reason.
 */

export type CaseScope = {
  customerType: "individual" | "corporate" | "trust"; trigger: "onboarding" | "periodic_review" | "event_review";
  dueDiligence?: "simplified" | "standard" | "enhanced"; event?: string; jurisdiction: string; products: string[]; institution?: string;
};
export type CasePlanResult = { status: 200; body: Rec } | { status: 400 | 422; error: string; message: string; candidates: string[] };

const INSTITUTION = "bank.synthetic";
const PERSONAL = ["card", "deposit", "payments"];
const BUSINESS = ["deposit", "lending", "merchant_acquiring", "payments"];
/** A trust falls under the business-banking packs (a legal arrangement). */
const PACK_CUSTOMER = { individual: "individual", corporate: "corporate", trust: "corporate" } as const;

type CatalogPlan = { id: string; customerType: CaseScope["customerType"]; dueDiligence: NonNullable<CaseScope["dueDiligence"]>; jurisdictions: string[] };
/** Released agentic plans (onboarding): standard KYC/KYB for US and GB; KYC EDD, KYB EDD and KYB SDD for US, GB and AU. */
export const CASE_PLAN_CATALOG: readonly CatalogPlan[] = [
  { id: "kyc-agentic", customerType: "individual", dueDiligence: "standard", jurisdictions: ["US", "GB"] },
  { id: "kyb-agentic", customerType: "corporate", dueDiligence: "standard", jurisdictions: ["US", "GB"] },
  { id: "kyc-edd-agentic", customerType: "individual", dueDiligence: "enhanced", jurisdictions: ["US", "GB", "AU"] },
  { id: "kyb-edd-agentic", customerType: "corporate", dueDiligence: "enhanced", jurisdictions: ["US", "GB", "AU"] },
  { id: "kyb-sdd-agentic", customerType: "corporate", dueDiligence: "simplified", jurisdictions: ["US", "GB", "AU"] },
];
export const planDigestOf = (planId: string) => hex64(`plan:${planId}`);

function packsOf(plan: CatalogPlan) {
  const customer = PACK_CUSTOMER[plan.customerType];
  const productSet = customer === "corporate" ? "business-banking" : "personal-banking";
  const products = customer === "corporate" ? BUSINESS : PERSONAL;
  return plan.jurisdictions.map((jurisdiction) => {
    const id = `policy.pack.${jurisdiction.toLowerCase()}.bank-synthetic.${productSet}`;
    return { id, version: "1.0.0+1.0.0+1.0.0+1.0.0", digest: hex64(`pack:${id}`), scope: { jurisdiction, institution: INSTITUTION, productSet, products: [...products], customerTypes: [customer] } };
  });
}

const CUSTOMER_TYPES = ["individual", "corporate", "trust"];
const TRIGGERS = ["onboarding", "periodic_review", "event_review"];
const LEVELS = ["simplified", "standard", "enhanced"];
const KEYS = new Set(["customerType", "trigger", "dueDiligence", "event", "jurisdiction", "products", "institution"]);
const PRODUCT = /^[a-z][a-z_]{0,63}$/;

/** The request shape control-api accepts (caseScopeSchema, strict). */
export function isCaseScope(value: unknown): value is CaseScope {
  const scope = value as Rec;
  return Boolean(scope) && typeof scope === "object" && !Array.isArray(scope) && Object.keys(scope).every((key) => KEYS.has(key))
    && CUSTOMER_TYPES.includes(scope.customerType) && TRIGGERS.includes(scope.trigger)
    && (scope.dueDiligence === undefined || LEVELS.includes(scope.dueDiligence))
    && (scope.event === undefined || (typeof scope.event === "string" && PRODUCT.test(scope.event)))
    && typeof scope.jurisdiction === "string" && /^[A-Z]{2}$/.test(scope.jurisdiction)
    && Array.isArray(scope.products) && scope.products.length >= 1 && scope.products.length <= 20 && scope.products.every((product: unknown) => typeof product === "string" && PRODUCT.test(product))
    && (scope.institution === undefined || (typeof scope.institution === "string" && /^[a-z0-9][a-z0-9.-]*$/.test(scope.institution) && scope.institution.length <= 120));
}

/** The one released plan and pinned pack a case falls under, or why there is none. */
export function selectCasePlan(value: unknown): CasePlanResult {
  if (!isCaseScope(value)) return { status: 400, error: "case.scope_invalid", message: "Choose a customer type, trigger, policy jurisdiction and at least one product.", candidates: [] };
  const scope = value;
  const dueDiligence = scope.dueDiligence ?? "standard";
  const institution = scope.institution ?? INSTITUTION;
  const products = [...new Set(scope.products)].sort();
  // Every released plan is an onboarding process; reviews have no released plan yet.
  const process = CASE_PLAN_CATALOG.filter((plan) => plan.customerType === scope.customerType && scope.trigger === "onboarding" && plan.dueDiligence === dueDiligence && scope.event === undefined);
  if (!process.length) {
    return { status: 422, error: "case.plan_no_plan", message: `no released plan for ${scope.customerType} ${scope.trigger}${scope.event ? ` (${scope.event})` : ""} with ${dueDiligence} due diligence`, candidates: [] };
  }
  const covering = process.map((plan) => ({ plan, packs: packsOf(plan).filter((pack) => pack.scope.jurisdiction === scope.jurisdiction && pack.scope.institution === institution
    && products.every((product) => pack.scope.products.includes(product)) && pack.scope.customerTypes.includes(PACK_CUSTOMER[scope.customerType])) }));
  const selected = covering.filter((item) => item.packs.length === 1);
  if (selected.length > 1) return { status: 422, error: "case.plan_ambiguous_plan", message: "more than one released plan covers this case", candidates: selected.map((item) => planDigestOf(item.plan.id)) };
  const ambiguous = covering.find((item) => item.packs.length > 1);
  if (!selected.length && ambiguous) return { status: 422, error: "case.plan_ambiguous_pack", message: "more than one pinned pack applies", candidates: ambiguous.packs.map((pack) => pack.id) };
  if (!selected.length) {
    return { status: 422, error: "case.plan_no_pack", message: `no released plan pins a pack for ${scope.jurisdiction} covering ${scope.products.join(", ")}`, candidates: process.map((plan) => planDigestOf(plan.id)) };
  }
  const { plan, packs: [pack] } = selected[0]!;
  return {
    status: 200,
    body: {
      planDigest: planDigestOf(plan.id), policySnapshotDigest: hex64(`policy-source:${plan.id}`),
      policyAuthority: { policyId: pack!.id, policyVersion: pack!.version, policyBundleDigest: pack!.digest, dependencyDigest: hex64(`dependencies:${plan.id}`) },
      scope: { customerType: plan.customerType, trigger: "onboarding", dueDiligence: plan.dueDiligence, jurisdictions: [...plan.jurisdictions], products: [...pack!.scope.products], institution: INSTITUTION },
      pack: { id: pack!.id, scope: { ...pack!.scope, products: [...pack!.scope.products], customerTypes: [...pack!.scope.customerTypes] } },
    },
  };
}
