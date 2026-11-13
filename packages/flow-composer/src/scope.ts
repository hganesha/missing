import { composeEffectivePack, productLineageOf, type EffectivePolicyPack, type PolicyPackLayer, type PolicyPackSelection } from "@ehf/policy-engine";
import type { Agent, Flow } from "./compose.js";
import { connectors as ACQUISITION_CONNECTORS } from "./connectors.js";

/**
 * A process's scope: who it serves (one customer type), why it runs (one trigger), and where and for
 * which products. Changing any of these recomposes the process: `resolveFlow` derives the agents,
 * skills, acquisition connectors and policy packs it needs, each with the reason, so an author sees
 * why the process changed before accepting it.
 */
export type ProcessScope = {
  customerType: CustomerType;
  trigger: Trigger;
  /** ISO 3166 alpha-2, as the pack layers name them (US, GB, AU, ...). */
  jurisdictions: string[];
  /** Banking products (card, deposit, payments, lending, merchant_acquiring, ...) or taxonomy nodes (BRK, CUS, ...). */
  products: string[];
  /** The institution whose packs apply (defaults to the synthetic bank). */
  institution?: string;
  /** Simplified (SDD), standard (CDD, the default) or enhanced (EDD) due diligence. */
  dueDiligence?: DueDiligence;
  /** For an event_review: the event that triggered it (one of REVIEW_EVENTS). */
  event?: ReviewEvent;
};
export const DUE_DILIGENCE = ["simplified", "standard", "enhanced"] as const;
export type DueDiligence = (typeof DUE_DILIGENCE)[number];
export const CUSTOMER_TYPES = ["individual", "corporate", "trust"] as const;
export type CustomerType = (typeof CUSTOMER_TYPES)[number];
/**
 * The policy customer type a process customer type falls under: a trust is a legal arrangement, so the
 * business-banking packs (and the agents that serve legal entities) cover it.
 */
export const PACK_CUSTOMER_TYPE: Record<CustomerType, "individual" | "corporate"> = { individual: "individual", corporate: "corporate", trust: "corporate" };
/** Onboarding a new relationship; a periodic review of an existing one; a review an event triggers. */
export const TRIGGERS = ["onboarding", "periodic_review", "event_review"] as const;
export type Trigger = (typeof TRIGGERS)[number];

export type DecisionKind = "agent" | "skill" | "connector" | "pack" | "requirements" | "trigger" | "due_diligence";

/** Agents every review re-runs: the profile, screening and adverse media, risk, the decision and QA. */
const REVIEW_CORE_AGENTS = ["agent.intake_profile", "agent.screening", "agent.investigation", "agent.risk_edd", "agent.decision_support", "agent.qa_assurance"];
/**
 * The library's review events (kyc_documents REVIEW_EVENTS) and the further agents each re-runs, with
 * the customer types it can occur for. A review re-runs only what the event can have changed, plus the
 * core every review needs.
 */
export const REVIEW_EVENTS = {
  identity_expiry: { agents: ["agent.document_intelligence", "agent.identity_verification"], customerTypes: ["individual", "corporate", "trust"] },
  address_change: { agents: ["agent.document_intelligence", "agent.identity_verification"], customerTypes: ["individual", "corporate", "trust"] },
  person_name_change: { agents: ["agent.document_intelligence", "agent.identity_verification"], customerTypes: ["individual"] },
  entity_name_or_form_change: { agents: ["agent.document_intelligence", "agent.identity_verification", "agent.identity_ownership"], customerTypes: ["corporate"] },
  ownership_change: { agents: ["agent.document_intelligence", "agent.identity_ownership"], customerTypes: ["corporate", "trust"] },
  authority_change: { agents: ["agent.document_intelligence", "agent.identity_verification"], customerTypes: ["corporate", "trust"] },
  trust_party_change: { agents: ["agent.document_intelligence", "agent.identity_ownership"], customerTypes: ["trust"] },
  business_activity_change: { agents: ["agent.document_intelligence", "agent.relationship_product"], customerTypes: ["corporate"] },
  new_product_or_geography: { agents: ["agent.document_intelligence", "agent.relationship_product"], customerTypes: ["individual", "corporate", "trust"] },
  tax_circumstances_change: { agents: ["agent.document_intelligence"], customerTypes: ["individual", "corporate", "trust"] },
  risk_or_screening_trigger: { agents: [], customerTypes: ["individual", "corporate", "trust"] },
  account_closure_or_estate: { agents: ["agent.document_intelligence", "agent.identity_verification"], customerTypes: ["individual", "corporate", "trust"] },
} as const satisfies Record<string, { agents: string[]; customerTypes: CustomerType[] }>;
export type ReviewEvent = keyof typeof REVIEW_EVENTS;
/** One composition decision, with what caused it, for the author to review. */
export type CompositionDecision = {
  kind: DecisionKind; id: string; action: "include" | "exclude";
  reason: string;
  /** What the decision rests on: a scope attribute, a pack field (with the layer that set it) or a roster attribute. */
  basis: { source: "scope" | "pack" | "roster"; field: string; value?: unknown; packId?: string; layer?: string | undefined };
};
export class ScopeError extends Error {
  constructor(public readonly code: string, message: string, public readonly remedy?: string) { super(`${code}: ${message}`); }
}

/** Skills that only apply to some customer types: excluded elsewhere, with the reason. */
export const SKILL_CUSTOMER_TYPES: Record<string, { customerTypes: CustomerType[]; reason: string }> = {
  "registry.company.verify": { customerTypes: ["corporate"], reason: "Company registry verification needs a registered company; an individual or a trust has no company registration." },
  "screening.sanctions.ownership.evaluate": { customerTypes: ["corporate", "trust"], reason: "Sanctions exposure through ownership needs an ownership structure; an individual has none." },
  "screening.sanctions.control.evaluate": { customerTypes: ["corporate", "trust"], reason: "Sanctions exposure through control reads control rights over the customer; an individual has none." },
};

/** The acquisition connector each skill reads, so a skill in the flow brings the data it needs. */
export const CONNECTOR_FOR_SKILL: Record<string, string> = {
  "document.classify.catalog": "acquire-documents",
  "screening.sanctions.execute": "acquire-sanctions",
  "screening.pep.execute": "acquire-pep",
  "screening.adverse_media.execute": "acquire-adverse-media",
  "registry.company.verify": "acquire-registry",
  "ownership.graph.build": "acquire-ownership",
};
/** Connectors a legal-entity customer always needs, beyond its skills' own: identifiers and officers. */
const CORPORATE_CONNECTORS: Array<{ id: string; reason: string; packField?: string; packValue?: string }> = [
  { id: "acquire-lei", reason: "A legal entity is identified by its LEI where it has one." },
  { id: "acquire-officers", reason: "Directors are screened, so the entity's officers are acquired.", packField: "screening_roles", packValue: "director" },
];

/** The document requirements package (library entity-packages.json) for each customer type. */
const REQUIREMENTS_PACKAGE: Record<CustomerType, string> = { individual: "individual", corporate: "private_company", trust: "trust" };
/** Acquisition a customer type cannot use, with the reason (the provider covers companies only). */
const CONNECTORS_NOT_FOR: Partial<Record<CustomerType, Record<string, string>>> = {
  trust: { "acquire-ownership": "Company ownership discovery does not cover a trust; its parties and interests come from the trust deed and schedules." },
};

/**
 * What each due-diligence level changes (the bank's SDD / CDD / EDD standard):
 * - simplified: low risk, for an eligible legal entity (a listed company, government body or regulated
 *   institution): entity status is verified, beneficial ownership is exempt, no source of funds;
 * - standard: today's processes (identity documents, owners over 25 percent, declared purpose);
 * - enhanced: high risk: source of funds (and wealth, for a person) verified with documents, ownership
 *   mapped through every layer, the full EDD scope, never the low-risk carve-out.
 */
export const DUE_DILIGENCE_RULES: Record<DueDiligence, {
  customerTypes: CustomerType[]; excludeAgents?: string[]; excludeSkills?: string[];
  promote?: Partial<Record<CustomerType, string[]>>; requirementsPackage?: Partial<Record<CustomerType, string>>; reason: string;
}> = {
  simplified: {
    customerTypes: ["corporate"],
    excludeAgents: ["agent.identity_ownership"],
    excludeSkills: ["screening.sanctions.ownership.evaluate", "edd.scope.plan", "edd.source_of_funds.verify", "edd.source_of_wealth.assess"],
    requirementsPackage: { corporate: "listed_company" },
    reason: "Simplified due diligence: entity status verified; beneficial ownership exempt and no source of funds for an eligible listed company, government body or regulated institution.",
  },
  standard: { customerTypes: ["individual", "corporate", "trust"], reason: "Standard customer due diligence." },
  enhanced: {
    customerTypes: ["individual", "corporate", "trust"],
    promote: {
      individual: ["edd.scope.plan", "edd.source_of_funds.verify", "edd.source_of_wealth.assess"],
      corporate: ["edd.scope.plan", "edd.source_of_funds.verify", "ownership.control.resolve", "ownership.nominee.detect", "ownership.circular.detect"],
      trust: ["edd.scope.plan", "edd.source_of_funds.verify", "ownership.control.resolve", "ownership.nominee.detect", "ownership.circular.detect"],
    },
    reason: "Enhanced due diligence: source of funds verified with documents, ownership mapped to natural persons through every layer, the full EDD scope.",
  },
};

const JURISDICTION_NAMES: Record<string, string> = { US: "US", GB: "UK", AU: "Australian" };
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];

export type ScopeInputs = {
  roster: Agent[];
  /** Compiled effective packs, by id (artifacts/policy/packs). */
  packs: Map<string, EffectivePolicyPack>;
  /** The policy pack layers (domains/policy/packs), to compose a pack for a product set no compiled pack covers. */
  layers?: PolicyPackLayer[];
  /** The taxonomy's legacy mapping, so a composed pack's product layers follow the taxonomy (as compiled packs do). */
  legacy?: Readonly<Record<string, string>>;
};

/**
 * The flow a scope needs, and every decision behind it. Throws a ScopeError naming what is missing
 * (a jurisdiction without a pack layer, a product without a product layer, an unsupported trigger).
 */
export function resolveFlow(scope: ProcessScope, inputs: ScopeInputs): { flow: Flow; packs: EffectivePolicyPack[]; decisions: CompositionDecision[] } {
  validateScope(scope);
  const institution = scope.institution ?? "bank.synthetic";
  const packCustomer = PACK_CUSTOMER_TYPE[scope.customerType];
  const dueDiligence = scope.dueDiligence ?? "standard";
  const level = DUE_DILIGENCE_RULES[dueDiligence];
  if (!level.customerTypes.includes(scope.customerType)) {
    throw new ScopeError("scope.due_diligence_ineligible", `${dueDiligence} due diligence does not apply to ${scope.customerType} customers`,
      "Simplified due diligence is for an eligible legal entity (a listed company, government body or regulated institution); use standard due diligence.");
  }
  const decisions: CompositionDecision[] = [];
  const decide = (decision: CompositionDecision) => decisions.push(decision);
  // The trigger: onboarding and periodic review run every agent; an event review runs the core review
  // agents and those its event touches.
  let reviewAgents: string[] | null = null;
  if (scope.trigger === "event_review") {
    const event = scope.event ? REVIEW_EVENTS[scope.event] : undefined;
    if (!event) throw new ScopeError("scope.event_required", "an event review names its event", `Choose one of ${Object.keys(REVIEW_EVENTS).join(", ")}.`);
    if (!(event.customerTypes as readonly string[]).includes(scope.customerType)) {
      throw new ScopeError("scope.event_ineligible", `${scope.event} does not occur for ${scope.customerType} customers`, `Choose an event for ${scope.customerType} customers.`);
    }
    reviewAgents = [...REVIEW_CORE_AGENTS, ...event.agents];
  } else if (scope.event) {
    throw new ScopeError("scope.event_unexpected", "only an event review names an event", "Remove the event, or choose the event_review trigger.");
  }
  decide({ kind: "trigger", id: scope.trigger, action: "include", basis: { source: "scope", field: "trigger", value: scope.trigger },
    reason: scope.trigger === "onboarding" ? "A new relationship: the full onboarding due diligence runs."
      : scope.trigger === "periodic_review" ? "A scheduled review of an existing relationship: due diligence is re-performed at its level, with the periodic-review documents."
      : `A review triggered by ${scope.event!.replaceAll("_", " ")}: the agents it can affect re-run, with screening, adverse media, risk and the decision.` });
  decide({ kind: "due_diligence", id: dueDiligence, action: "include", reason: level.reason, basis: { source: "scope", field: "dueDiligence", value: dueDiligence } });

  // Packs: one per jurisdiction, for exactly the scope's products.
  const products = [...new Set(scope.products)].sort();
  const packs = scope.jurisdictions.map((jurisdiction) => {
    const compiled = [...inputs.packs.values()].find((item) => item.scope.jurisdiction === jurisdiction && item.scope.institution === institution
      && item.scope.customerTypes.includes(packCustomer) && sameSet(item.scope.products, products));
    if (compiled) {
      decide({ kind: "pack", id: compiled.id, action: "include", reason: `The ${jurisdiction} ${compiled.scope.productSet} pack covers exactly these products.`, basis: { source: "scope", field: "jurisdictions", value: jurisdiction, packId: compiled.id } });
      return compiled;
    }
    if (!inputs.layers) throw new ScopeError("scope.pack_missing", `no compiled pack covers ${jurisdiction} ${scope.customerType} ${products.join(", ")}`, "Compile a pack for this product set (domains/policy/selection.yaml).");
    const productSet = `custom-${products.join("-").replaceAll("_", "-")}`;
    const entry: PolicyPackSelection["packs"][number] = { jurisdiction, institution, productSet, products, customerTypes: [packCustomer] };
    let composed: EffectivePolicyPack;
    try {
      composed = composeEffectivePack(inputs.layers, entry, inputs.legacy ? { lineage: (product: string) => productLineageOf(product, inputs.legacy) } : {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const missing = /layer_missing:(\w+)(?::(\w+))?/.exec(message);
      throw new ScopeError("scope.pack_layer_missing", message,
        missing ? `Author a ${missing[1]} policy pack layer${missing[2] && missing[1] === "product" ? ` for ${missing[2]}` : ""} for ${jurisdiction} (domains/policy/packs).` : undefined);
    }
    decide({ kind: "pack", id: composed.id, action: "include", reason: `Composed for ${jurisdiction} from its layers for exactly these products.`, basis: { source: "scope", field: "products", value: products, packId: composed.id } });
    return composed;
  });

  // Agents: every roster agent that serves this customer type, in roster order.
  const agents = inputs.roster.filter((agent) => {
    const serves = agent.customerTypes.includes(packCustomer);
    const exempt = serves && (level.excludeAgents ?? []).includes(agent.id);
    const untouched = serves && !exempt && reviewAgents !== null && !reviewAgents.includes(agent.id);
    decide({ kind: "agent", id: agent.id, action: serves && !exempt && !untouched ? "include" : "exclude",
      reason: untouched ? `A ${scope.event!.replaceAll("_", " ")} review does not re-run ${agent.name}.` : exempt ? level.reason
        : serves ? `${agent.name} serves ${scope.customerType} customers.` : `${agent.name} serves only ${agent.customerTypes.join(", ")} customers.`,
      basis: untouched ? { source: "scope", field: "event", value: scope.event } : exempt ? { source: "scope", field: "dueDiligence", value: dueDiligence }
        : { source: "roster", field: "customerTypes", value: agent.customerTypes } });
    return serves && !exempt && !untouched;
  });

  // Skills that cannot apply to this customer type.
  const agentSkills = new Set(agents.flatMap((agent) => [...agent.skills.hydration, ...agent.skills.required, ...agent.skills.optional]));
  const excludedSkills = Object.entries(SKILL_CUSTOMER_TYPES).filter(([skillId, rule]) => agentSkills.has(skillId) && !rule.customerTypes.includes(scope.customerType))
    .map(([skillId, rule]) => {
      decide({ kind: "skill", id: skillId, action: "exclude", reason: rule.reason, basis: { source: "scope", field: "customerType", value: scope.customerType } });
      return skillId;
    });
  for (const skillId of level.excludeSkills ?? []) {
    if (!agentSkills.has(skillId) || excludedSkills.includes(skillId)) continue;
    excludedSkills.push(skillId);
    decide({ kind: "skill", id: skillId, action: "exclude", reason: level.reason, basis: { source: "scope", field: "dueDiligence", value: dueDiligence } });
  }
  const promotedSkills = (level.promote?.[scope.customerType] ?? []).filter((skillId) => agentSkills.has(skillId) && !excludedSkills.includes(skillId));
  for (const skillId of promotedSkills) {
    decide({ kind: "skill", id: skillId, action: "include", reason: `${level.reason} ${skillId} runs as a required step.`, basis: { source: "scope", field: "dueDiligence", value: dueDiligence } });
  }
  const runs = (skillId: string) => (agents.some((agent) => [...agent.skills.hydration, ...agent.skills.required].includes(skillId)) || promotedSkills.includes(skillId))
    && !excludedSkills.includes(skillId);

  // Connectors: the data the flow's skills read, plus what a legal entity always needs.
  const wanted = new Set<string>();
  const notFor = CONNECTORS_NOT_FOR[scope.customerType] ?? {};
  for (const [skillId, connector] of Object.entries(CONNECTOR_FOR_SKILL)) {
    if (!runs(skillId) || notFor[connector]) continue;
    wanted.add(connector);
    decide({ kind: "connector", id: connector, action: "include", reason: `${skillId} reads what it acquires.`, basis: { source: "roster", field: "skills.required", value: skillId } });
  }
  if (packCustomer === "corporate") {
    for (const connector of CORPORATE_CONNECTORS) {
      // A trust has no company officers to look up; its trustees come from the trust deed.
      if (scope.customerType === "trust" && connector.id === "acquire-officers") continue;
      const pack = connector.packField ? packs.find((item) => valueIncludes(item.values[connector.packField as keyof typeof item.values], connector.packValue)) : undefined;
      if (connector.packField && !pack) continue;
      wanted.add(connector.id);
      decide({ kind: "connector", id: connector.id, action: "include", reason: connector.reason,
        basis: pack ? { source: "pack", field: connector.packField!, value: connector.packValue, packId: pack.id, layer: pack.basis[connector.packField as keyof typeof pack.basis]?.layer }
          : { source: "scope", field: "customerType", value: scope.customerType } });
    }
  }
  // Screening the packs require must have its skill in the flow.
  for (const item of packs) {
    for (const type of (item.values.required_screening_types as string[] | undefined) ?? []) {
      const skillId = type === "adverse_media" ? "screening.adverse_media.execute" : type === "watchlist" ? null : `screening.${type}.execute`;
      if (skillId && !runs(skillId)) {
        throw new ScopeError("scope.required_screening_unserved", `${item.id} requires ${type} screening and no agent in the flow runs ${skillId}`, `Add an agent that runs ${skillId}.`);
      }
    }
  }
  const connectors = ACQUISITION_CONNECTORS.map((connector: { id: string }) => connector.id).filter((id: string) => wanted.has(id));
  for (const connector of ACQUISITION_CONNECTORS as Array<{ id: string }>) {
    if (!wanted.has(connector.id)) decide({ kind: "connector", id: connector.id, action: "exclude", reason: notFor[connector.id] ?? "No skill in the flow reads what it acquires.", basis: { source: "scope", field: "customerType", value: scope.customerType } });
  }

  const requirementsPackage = level.requirementsPackage?.[scope.customerType] ?? REQUIREMENTS_PACKAGE[scope.customerType];
  decide({ kind: "requirements", id: requirementsPackage, action: "include",
    reason: `The document requirements for a ${requirementsPackage === "individual" ? "natural person" : requirementsPackage.replaceAll("_", " ")}.`,
    basis: { source: "scope", field: level.requirementsPackage?.[scope.customerType] ? "dueDiligence" : "customerType", value: level.requirementsPackage?.[scope.customerType] ? dueDiligence : scope.customerType } });

  const individual = scope.customerType === "individual";
  const trust = scope.customerType === "trust";
  const regions = scope.jurisdictions.map((j) => JURISDICTION_NAMES[j] ?? j);
  const productSets = [...new Set(packs.map((item) => item.scope.productSet))];
  const level3 = { simplified: "SDD", standard: "", enhanced: "EDD" }[dueDiligence];
  const trigger = scope.trigger === "onboarding" ? "" : scope.trigger === "periodic_review" ? "periodic-review" : `review-${scope.event!.replaceAll("_", "-")}`;
  const what = scope.trigger === "onboarding" ? "onboarding" : scope.trigger === "periodic_review" ? "periodic review" : `${scope.event!.replaceAll("_", " ")} review`;
  const verb = scope.trigger === "onboarding" ? "Onboard" : "Review";
  // Another institution's processes are named after it (securities.synthetic: securities-agentic).
  const firm = institution === "bank.synthetic" ? null : institution.split(".")[0]!;
  const flow: Flow = {
    id: `${firm ?? (individual ? "kyc" : "kyb")}${trust ? "-trust" : ""}${level3 ? `-${level3.toLowerCase()}` : ""}${trigger ? `-${trigger}` : ""}-agentic`,
    domain: individual ? "kyc" : "kyb",
    title: `Agentic ${individual ? "KYC" : "KYB"}${level3 ? ` (${level3})` : ""}${firm ? ` at ${institution}` : ""}: ${individual ? "individual" : trust ? "trust" : "business"} ${what}`,
    // The composer serves agents and packs by the policy customer type; the scope keeps the trust.
    customerType: packCustomer,
    objective: `${verb} ${individual ? "an individual" : trust ? "a trust" : "a business"} customer${level3 ? ` with ${dueDiligence} due diligence` : ""} under ${firm ? `${institution}'s` : "the bank's"} ${regions.join(" or ")} ${productSets.join(" or ")} policy pack: ${NUMBER_WORDS[agents.length] ?? agents.length} agents work the case with the library's skills, three pack checkpoints decide whether it is ready, and a person decides.`,
    agents: agents.map((agent) => agent.id),
    excludedSkills,
    packs: packs.map((item) => item.id),
    requirementsPackage,
    connectors,
    allowedRegions: [...scope.jurisdictions],
    ...(dueDiligence !== "standard" ? { dueDiligence } : {}),
    ...(promotedSkills.length ? { promotedSkills } : {}),
    ...(scope.trigger === "periodic_review" ? { reviewEvent: "periodic_review" } : scope.trigger === "event_review" ? { reviewEvent: scope.event! } : {}),
    scope: { customerType: scope.customerType, trigger: scope.trigger, dueDiligence, ...(scope.event ? { event: scope.event } : {}),
      jurisdictions: [...scope.jurisdictions], products: products, institution },
  };
  return { flow, packs, decisions };
}

export function validateScope(scope: ProcessScope): void {
  if (!(CUSTOMER_TYPES as readonly string[]).includes(scope.customerType)) {
    throw new ScopeError("scope.customer_type_unsupported", `customer type ${scope.customerType} has no process`, "Choose individual or corporate.");
  }
  if (!(TRIGGERS as readonly string[]).includes(scope.trigger)) throw new ScopeError("scope.trigger_unknown", `unknown trigger ${scope.trigger}`);
  if (scope.dueDiligence !== undefined && !(DUE_DILIGENCE as readonly string[]).includes(scope.dueDiligence)) throw new ScopeError("scope.due_diligence_unknown", `unknown due-diligence level ${scope.dueDiligence}`);
  if (!scope.jurisdictions.length || scope.jurisdictions.some((j) => !/^[A-Z]{2}$/.test(j))) throw new ScopeError("scope.jurisdictions_invalid", "name one or more ISO 3166 alpha-2 jurisdictions");
  if (new Set(scope.jurisdictions).size !== scope.jurisdictions.length) throw new ScopeError("scope.jurisdictions_invalid", "a jurisdiction is listed twice");
  if (!scope.products.length || scope.products.some((p) => !/^([a-z][a-z_]{0,63}|[A-Z][A-Z0-9_]{0,39}(\.[A-Z][A-Z0-9_]{0,39}){0,2})$/.test(p))) throw new ScopeError("scope.products_invalid", "name one or more products");
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);
const valueIncludes = (value: unknown, wanted?: string) => Array.isArray(value) ? value.includes(wanted)
  : value && typeof value === "object" ? Object.values(value).some((item) => Array.isArray(item) && item.includes(wanted)) : false;
