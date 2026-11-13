import type { Rec } from "./fixtures.js";

/**
 * A miniature of @ehf/flow-composer for the mock: an agentic KYC/KYB process composed from its
 * scope (customer type, trigger, jurisdictions, products), and the preview of a scope change with
 * the reason for every decision. Reasons and node ids follow the real composer's output for the
 * synthetic bank so the UI shows what the control API would.
 */

export type DueDiligence = "simplified" | "standard" | "enhanced";
export type ProcessScope = { customerType: "individual" | "corporate" | "trust"; trigger: string; jurisdictions: string[]; products: string[]; institution?: string; dueDiligence?: DueDiligence; event?: string };
export type ScopeRefusal = { status: 422; error: string; message: string; remedy?: string };

export const AGENTIC_KYC_DRAFT_ID = "draft_6f1c2c3e-0000-4000-8000-000000000003";
export const SCOPE_FILE = "scope.yaml";
const POLICY_REF = "kyc-agentic.business";
const INSTITUTION = "bank.synthetic";
const PERSONAL_PRODUCTS = ["card", "deposit", "payments"];
const BUSINESS_PRODUCTS = ["deposit", "lending", "merchant_acquiring", "payments"];
/** Jurisdictions with a jurisdiction layer; DE has no institution layer yet. */
const JURISDICTIONS = [{ code: "AU", available: true }, { code: "DE", available: false }, { code: "GB", available: true }, { code: "US", available: true }];
const PRODUCTS = [...new Set([...PERSONAL_PRODUCTS, ...BUSINESS_PRODUCTS])].sort();
const TRIGGERS = ["onboarding", "periodic_review", "event_review"];
type CustomerType = ProcessScope["customerType"];
type PackCustomer = "individual" | "corporate";
/** A trust is a legal arrangement: the business-banking packs and the agents that serve legal entities cover it (flow-composer PACK_CUSTOMER_TYPE). */
const PACK_CUSTOMER: Record<CustomerType, PackCustomer> = { individual: "individual", corporate: "corporate", trust: "corporate" };
const packCustomer = (scope: ProcessScope) => PACK_CUSTOMER[scope.customerType];
/** SDD / CDD / EDD as @ehf/flow-composer DUE_DILIGENCE_RULES defines them. */
const DUE_DILIGENCE: Record<DueDiligence, { customerTypes: CustomerType[]; excludeAgents?: string[]; excludeSkills?: string[]; promote?: Partial<Record<CustomerType, string[]>>; requirements?: Partial<Record<CustomerType, [string, string]>>; reason: string }> = {
  simplified: {
    customerTypes: ["corporate"], excludeAgents: ["agent.identity_ownership"],
    excludeSkills: ["screening.sanctions.ownership.evaluate", "edd.scope.plan", "edd.source_of_funds.verify", "edd.source_of_wealth.assess"],
    requirements: { corporate: ["listed_company", "The document requirements for a listed company."] },
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
const levelOf = (scope: ProcessScope) => DUE_DILIGENCE[scope.dueDiligence ?? "standard"];
const ALL_TYPES: CustomerType[] = ["individual", "corporate", "trust"];
/** The library's review events, the further agents each re-runs and the customer types it occurs for (flow-composer REVIEW_EVENTS). */
const REVIEW_EVENTS: Record<string, { agents: string[]; customerTypes: CustomerType[] }> = {
  identity_expiry: { agents: ["agent.document_intelligence", "agent.identity_verification"], customerTypes: ALL_TYPES },
  address_change: { agents: ["agent.document_intelligence", "agent.identity_verification"], customerTypes: ALL_TYPES },
  person_name_change: { agents: ["agent.document_intelligence", "agent.identity_verification"], customerTypes: ["individual"] },
  entity_name_or_form_change: { agents: ["agent.document_intelligence", "agent.identity_verification", "agent.identity_ownership"], customerTypes: ["corporate"] },
  ownership_change: { agents: ["agent.document_intelligence", "agent.identity_ownership"], customerTypes: ["corporate", "trust"] },
  authority_change: { agents: ["agent.document_intelligence", "agent.identity_verification"], customerTypes: ["corporate", "trust"] },
  trust_party_change: { agents: ["agent.document_intelligence", "agent.identity_ownership"], customerTypes: ["trust"] },
  business_activity_change: { agents: ["agent.document_intelligence"], customerTypes: ["corporate"] },
  new_product_or_geography: { agents: ["agent.document_intelligence"], customerTypes: ALL_TYPES },
  tax_circumstances_change: { agents: ["agent.document_intelligence"], customerTypes: ALL_TYPES },
  risk_or_screening_trigger: { agents: [], customerTypes: ALL_TYPES },
  account_closure_or_estate: { agents: ["agent.document_intelligence", "agent.identity_verification"], customerTypes: ALL_TYPES },
};
const REVIEW_CORE_AGENTS = ["agent.intake_profile", "agent.screening", "agent.risk_edd", "agent.decision_support"];
/** An event review re-runs only the core review agents and those its event can affect; null runs every agent. */
const reviewAgents = (scope: ProcessScope) => scope.trigger === "event_review" && scope.event ? [...REVIEW_CORE_AGENTS, ...REVIEW_EVENTS[scope.event]!.agents] : null;
const event = (scope: ProcessScope) => String(scope.event ?? "").replaceAll("_", " ");

export const PERSONAL_SCOPE: ProcessScope = { customerType: "individual", trigger: "onboarding", jurisdictions: ["US", "GB"], products: [...PERSONAL_PRODUCTS], institution: INSTITUTION };

export function scopeOptions(): Rec {
  return {
    customerTypes: ALL_TYPES.map((value) => ({ value, available: true })),
    triggers: TRIGGERS.map((value) => ({ value, available: true })),
    events: Object.entries(REVIEW_EVENTS).map(([value, rule]) => ({ value, customerTypes: [...rule.customerTypes] })),
    dueDiligence: (Object.keys(DUE_DILIGENCE) as DueDiligence[]).map((value) => ({ value, available: true, customerTypes: [...DUE_DILIGENCE[value].customerTypes], description: DUE_DILIGENCE[value].reason })),
    jurisdictions: JURISDICTIONS.map((item) => ({ ...item })),
    products: [...PRODUCTS],
    institutions: [{ id: "pack.institution.bank-synthetic", appliesTo: [INSTITUTION] }],
  };
}

// ---- Roster -----------------------------------------------------------------------------

/** `optional` skills run only when a due-diligence level promotes them. Agents serve policy customer types (a trust is served as a legal entity). */
type Agent = { id: string; name: string; customerTypes: PackCustomer[]; skills: string[]; optional?: string[] };
const BOTH: Agent["customerTypes"] = ["individual", "corporate"];
const ROSTER: Agent[] = [
  { id: "agent.intake_profile", name: "Intake and profile agent", customerTypes: BOTH, skills: ["intake.profile.normalize"] },
  { id: "agent.document_intelligence", name: "Document intelligence agent", customerTypes: BOTH, skills: ["document.classify.catalog"] },
  { id: "agent.identity_verification", name: "Identity and verification agent", customerTypes: BOTH, skills: ["identity.document.verify"] },
  { id: "agent.identity_ownership", name: "Ownership and control agent", customerTypes: ["corporate"], skills: ["registry.company.verify", "ownership.graph.build", "ownership.interest.calculate", "ownership.ubo.resolve", "ownership.ubo.verify"],
    optional: ["ownership.control.resolve", "ownership.nominee.detect", "ownership.circular.detect"] },
  { id: "agent.screening", name: "Screening agent", customerTypes: BOTH, skills: ["screening.sanctions.execute", "screening.pep.execute", "screening.adverse_media.execute", "screening.sanctions.ownership.evaluate"] },
  { id: "agent.risk_edd", name: "Risk and EDD agent", customerTypes: BOTH, skills: ["risk.customer.score"], optional: ["edd.scope.plan", "edd.source_of_funds.verify", "edd.source_of_wealth.assess"] },
  { id: "agent.decision_support", name: "Decision support agent", customerTypes: BOTH, skills: ["decision.recommend"] },
];
/** Skills that only apply to some customer types (flow-composer SKILL_CUSTOMER_TYPES). */
const SKILL_CUSTOMER_TYPES: Record<string, { customerTypes: CustomerType[]; reason: string }> = {
  "registry.company.verify": { customerTypes: ["corporate"], reason: "Company registry verification needs a registered company; an individual or a trust has no company registration." },
  "screening.sanctions.ownership.evaluate": { customerTypes: ["corporate", "trust"], reason: "Sanctions exposure through ownership needs an ownership structure; an individual has none." },
};
const skillServes = (skill: string, scope: ProcessScope) => SKILL_CUSTOMER_TYPES[skill]?.customerTypes.includes(scope.customerType) ?? true;
/** Acquisition a customer type cannot use, with the reason. */
const CONNECTORS_NOT_FOR: Partial<Record<CustomerType, Record<string, string>>> = {
  trust: {
    "acquire-ownership": "Company ownership discovery does not cover a trust; its parties and interests come from the trust deed and schedules.",
    "acquire-officers": "A trust has no company officers to look up; its trustees come from the trust deed.",
  },
};
const notFor = (scope: ProcessScope, connector: string) => CONNECTORS_NOT_FOR[scope.customerType]?.[connector];
/** The document requirements package for each customer type. */
const REQUIREMENTS: Record<CustomerType, [string, string]> = {
  individual: ["individual", "The document requirements for a natural person."],
  corporate: ["private_company", "The document requirements for a private company."],
  trust: ["trust", "The document requirements for a trust: the trust deed, schedules and the parties' identities."],
};
const CONNECTOR_FOR_SKILL: Record<string, [string, string]> = {
  "document.classify.catalog": ["acquire-documents", "Document collection"],
  "screening.sanctions.execute": ["acquire-sanctions", "Sanctions list lookup"],
  "screening.pep.execute": ["acquire-pep", "PEP lookup"],
  "screening.adverse_media.execute": ["acquire-adverse-media", "Adverse media search"],
  "registry.company.verify": ["acquire-registry", "Company registry lookup"],
  "ownership.graph.build": ["acquire-ownership", "Ownership discovery"],
};
const CORPORATE_CONNECTORS: Array<[string, string]> = [["acquire-lei", "LEI lookup"], ["acquire-officers", "Officers lookup"]];

const promoted = (scope: ProcessScope) => levelOf(scope).promote?.[scope.customerType] ?? [];
const skillsFor = (agent: Agent, scope: ProcessScope) => [...agent.skills, ...(agent.optional ?? []).filter((skill) => promoted(scope).includes(skill))]
  .filter((skill) => skillServes(skill, scope) && !(levelOf(scope).excludeSkills ?? []).includes(skill));
const agentsFor = (scope: ProcessScope) => ROSTER.filter((agent) => agent.customerTypes.includes(packCustomer(scope)) && !(levelOf(scope).excludeAgents ?? []).includes(agent.id)
  && (reviewAgents(scope)?.includes(agent.id) ?? true));

// ---- Packs ------------------------------------------------------------------------------

function packFor(scope: ProcessScope, jurisdiction: string): { id: string; reason: string } {
  const segment = packCustomer(scope) === "corporate" ? "business-banking" : "personal-banking";
  const standard = packCustomer(scope) === "corporate" ? BUSINESS_PRODUCTS : PERSONAL_PRODUCTS;
  const products = [...scope.products].sort();
  if (products.length === standard.length && products.every((product, index) => product === standard[index])) {
    return { id: `policy.pack.${jurisdiction.toLowerCase()}.bank-synthetic.${segment}`, reason: `The ${jurisdiction} ${segment} pack covers exactly these products.` };
  }
  return { id: `policy.pack.${jurisdiction.toLowerCase()}.bank-synthetic.${segment}.${products.join("-").replaceAll("_", "-")}`, reason: `Composed from the ${jurisdiction} jurisdiction layer and the product layers for ${products.join(", ")}.` };
}

/** The same refusals the composer gives (ScopeError code, message and remedy). */
export function refuse(scope: ProcessScope): ScopeRefusal | null {
  const refusal = (error: string, message: string, remedy: string): ScopeRefusal => ({ status: 422, error, message: `${error}: ${message}`, remedy });
  const products = [...scope.products].sort().join("-").replaceAll("_", "-");
  if (scope.trigger === "event_review") {
    const rule = scope.event ? REVIEW_EVENTS[scope.event] : undefined;
    if (!rule) return refusal("scope.event_required", "an event review names its event", `Choose one of ${Object.keys(REVIEW_EVENTS).join(", ")}.`);
    if (!rule.customerTypes.includes(scope.customerType)) return refusal("scope.event_ineligible", `${scope.event} does not occur for ${scope.customerType} customers`, `Choose an event for ${scope.customerType} customers.`);
  } else if (scope.event) return refusal("scope.event_unexpected", "only an event review names an event", "Remove the event, or choose the event_review trigger.");
  const dueDiligence = scope.dueDiligence ?? "standard";
  if (!DUE_DILIGENCE[dueDiligence].customerTypes.includes(scope.customerType)) {
    return refusal("scope.due_diligence_ineligible", `${dueDiligence} due diligence does not apply to ${scope.customerType} customers`,
      "Simplified due diligence is for an eligible legal entity (a listed company, government body or regulated institution); use standard due diligence.");
  }
  for (const code of scope.jurisdictions) {
    if (!JURISDICTIONS.some((item) => item.code === code && item.available)) {
      return refusal("scope.pack_layer_missing", `policy_pack.layer_missing:jurisdiction:${code}/${INSTITUTION}/custom-${products}`, `Author a jurisdiction policy pack layer for ${code} (domains/policy/packs).`);
    }
  }
  for (const product of scope.products) {
    if (!PRODUCTS.includes(product)) {
      return refusal("scope.pack_layer_missing", `policy_pack.layer_missing:product:${product}:${scope.jurisdictions[0]}/${INSTITUTION}/custom-${products}`, `Author a product policy pack layer for ${product} for ${scope.jurisdictions[0]} (domains/policy/packs).`);
    }
  }
  return null;
}

// ---- Composition ------------------------------------------------------------------------

const slug = (id: string) => id.replaceAll(".", "-").replaceAll("_", "-");

/** The workflow a scope composes: acquisition, agent chains, three pack gates and dual-control review. */
export function composeWorkflow(scope: ProcessScope): Rec {
  const corporate = packCustomer(scope) === "corporate";
  const trust = scope.customerType === "trust";
  const packs = scope.jurisdictions.map((jurisdiction) => ({
    id: packFor(scope, jurisdiction).id, version: "2026.11.0",
    scope: { jurisdiction, institution: scope.institution ?? INSTITUTION, products: [...scope.products].sort(), customerTypes: [packCustomer(scope)] },
  }));
  const nodes: Rec[] = [];
  const edges: Rec[] = [];
  const node = (id: string, kind: string, name: string, config: Rec = {}, summary?: string) => {
    nodes.push({ id, kind, name, ...(summary ? { summary } : {}), inputSchema: { type: "object" }, outputSchema: { type: "object" }, contextSelectorIds: [], config: { caseWrites: [], ...config } });
    return id;
  };
  const link = (from: string, to: string) => edges.push({ id: `edge-${from}-${to}`, from, to, kind: "data" });
  const chain = (from: string, ids: string[]) => ids.reduce((previous, id) => (link(previous, id), id), from);
  const gate = (gateId: string, name: string, summary: string) => node(gateId, "gate", name, { policyRef: POLICY_REF, gateId, policyPacks: packs }, summary);
  const agent = (id: string) => {
    const member = ROSTER.find((entry) => entry.id === id)!;
    const steps = skillsFor(member, scope).map((skill) => node(slug(skill), "tool", skill, { skillId: skill, agentRef: member.id }));
    steps.push(node(`${slug(member.id.replace(/^agent\./, ""))}-review`, "agent", `${member.name} (review)`, { agentRef: member.id }));
    return steps;
  };
  const parallel = (from: string, calls: Array<[string, string]>, joinId: string, joinName: string) => {
    for (const [id, name] of calls) { node(id, "tool", name, { capabilityId: `connector.${id}` }); link(from, id); link(id, joinId); }
    return node(joinId, "join", joinName);
  };

  const has = (id: string) => agentsFor(scope).some((member) => member.id === id);
  const runs = agentsFor(scope).flatMap((member) => skillsFor(member, scope));
  const reads = (skill: string) => runs.includes(skill) && !notFor(scope, CONNECTOR_FOR_SKILL[skill]![0]) ? [CONNECTOR_FOR_SKILL[skill]!] : [];
  let last = node("intake", "input", scope.trigger === "onboarding" ? "Onboarding application" : scope.trigger === "periodic_review" ? "Periodic review due" : `Review event: ${event(scope)}`);
  last = chain(last, agent("agent.intake_profile"));
  last = chain(last, [gate("intake-ready", "Policy pack: intake-ready", "The pinned pack's intake requirements: a resolved relationship and an in-scope customer type.")]);
  const acquisition: Array<[string, string]> = ["document.classify.catalog", "screening.sanctions.execute", "screening.pep.execute", "screening.adverse_media.execute"].flatMap(reads);
  const evidence = parallel(last, acquisition, "evidence-acquired", "Evidence acquisition barrier");
  // A join's own node is created after its calls; place it after them in the node list.
  last = evidence;
  if (corporate) last = parallel(last, [...reads("registry.company.verify"), ...CORPORATE_CONNECTORS.filter(([id]) => !notFor(scope, id)), ...reads("ownership.graph.build")], "identity-acquired", "Identity acquisition barrier");
  if (has("agent.document_intelligence")) last = chain(last, agent("agent.document_intelligence"));
  if (has("agent.identity_verification")) last = chain(last, agent("agent.identity_verification"));
  if (has("agent.identity_ownership")) last = chain(last, agent("agent.identity_ownership"));
  last = chain(last, agent("agent.screening"));
  last = chain(last, agent("agent.risk_edd"));
  last = chain(last, [gate("decision-ready", "Policy pack: decision-ready", "The pinned pack's evidence for a decision: required screening executed and current, ownership resolved for a business.")]);
  last = chain(last, agent("agent.decision_support"));
  last = chain(last, [node("human-decision", "approval", "Decision review (dual control)")]);
  last = chain(last, [gate("disposition", "Policy pack: disposition", "The released installation policy authorizes disposition or requests scoped human evidence.")]);
  const what = scope.trigger === "onboarding" ? "onboarding" : scope.trigger === "periodic_review" ? "periodic review" : `${event(scope)} review`;
  chain(last, [node("result", "output", `${what[0]!.toUpperCase()}${what.slice(1)} outcome`)]);
  const suffix = scope.trigger === "onboarding" ? "" : scope.trigger === "periodic_review" ? "-periodic-review" : `-review-${String(scope.event).replaceAll("_", "-")}`;
  return {
    apiVersion: "ladder.workflow/v1", kind: "Workflow",
    metadata: { name: `${corporate ? "kyb" : "kyc"}${trust ? "-trust" : ""}-agentic${suffix}`, title: `Agentic ${corporate ? "KYB" : "KYC"} ${trust ? "trust " : ""}${what}`, ...(scope.dueDiligence && scope.dueDiligence !== "standard" ? { dueDiligence: scope.dueDiligence } : {}) },
    spec: { nodes, edges },
  };
}

type Shape = { agents: string[]; skills: string[]; connectors: string[]; packs: string[]; nodes: Array<{ id: string; kind: string; name: string }> };
function shape(workflow: Rec): Shape {
  const nodes = ((workflow?.spec?.nodes ?? []) as Rec[]).filter((entry) => typeof entry?.id === "string");
  const gate = nodes.find((entry) => entry.kind === "gate" && Array.isArray(entry.config?.policyPacks));
  return {
    agents: [...new Set(nodes.filter((entry) => entry.kind === "agent" && typeof entry.config?.agentRef === "string").map((entry) => String(entry.config.agentRef)))],
    skills: [...new Set(nodes.filter((entry) => typeof entry.config?.skillId === "string").map((entry) => String(entry.config.skillId)))].sort(),
    connectors: nodes.filter((entry) => entry.id.startsWith("acquire-")).map((entry) => entry.id),
    packs: ((gate?.config?.policyPacks ?? []) as Rec[]).map((pack) => String(pack.id)),
    nodes: nodes.map((entry) => ({ id: String(entry.id), kind: String(entry.kind), name: String(entry.name ?? entry.id) })),
  };
}

/** A draft's scope: its scope file, else what its gates' pinned packs say. */
export function inferScope(workflow: Rec, sourceFiles: Record<string, string> = {}): ProcessScope | null {
  if (sourceFiles[SCOPE_FILE]) {
    try { return JSON.parse(sourceFiles[SCOPE_FILE]) as ProcessScope; } catch { /* fall back to the packs */ }
  }
  const gate = ((workflow?.spec?.nodes ?? []) as Rec[]).find((entry) => entry.kind === "gate" && Array.isArray(entry.config?.policyPacks));
  const packs = (gate?.config?.policyPacks ?? []) as Array<{ scope: { jurisdiction: string; institution: string; products: string[]; customerTypes: string[] } }>;
  if (!packs.length) return null;
  const customerTypes = [...new Set(packs.flatMap((pack) => pack.scope.customerTypes))];
  if (customerTypes.length !== 1) return null;
  return { customerType: customerTypes[0] as ProcessScope["customerType"], trigger: "onboarding", jurisdictions: packs.map((pack) => pack.scope.jurisdiction), products: [...packs[0]!.scope.products], institution: packs[0]!.scope.institution };
}

function decisions(scope: ProcessScope): Rec[] {
  const corporate = packCustomer(scope) === "corporate";
  const dueDiligence = scope.dueDiligence ?? "standard";
  const level = levelOf(scope);
  const byLevel = { source: "scope", field: "dueDiligence", value: dueDiligence };
  const out: Rec[] = [
    { kind: "trigger", id: scope.trigger, action: "include", basis: { source: "scope", field: "trigger", value: scope.trigger },
      reason: scope.trigger === "onboarding" ? "A new relationship: the full onboarding due diligence runs."
        : scope.trigger === "periodic_review" ? "A scheduled review of an existing relationship: due diligence is re-performed at its level, with the periodic-review documents."
        : `A review triggered by ${event(scope)}: the agents it can affect re-run, with screening, adverse media, risk and the decision.` },
    { kind: "due_diligence", id: dueDiligence, action: "include", reason: level.reason, basis: { ...byLevel } },
  ];
  for (const jurisdiction of scope.jurisdictions) {
    const pack = packFor(scope, jurisdiction);
    out.push({ kind: "pack", id: pack.id, action: "include", reason: pack.reason, basis: { source: "scope", field: "jurisdictions", value: jurisdiction, packId: pack.id } });
  }
  for (const agent of ROSTER) {
    const serves = agent.customerTypes.includes(packCustomer(scope));
    const untouched = serves && !(reviewAgents(scope)?.includes(agent.id) ?? true);
    const exempt = serves && !untouched && (level.excludeAgents ?? []).includes(agent.id);
    out.push({ kind: "agent", id: agent.id, action: serves && !exempt && !untouched ? "include" : "exclude",
      reason: untouched ? `A ${event(scope)} review does not re-run ${agent.name}.` : exempt ? level.reason : serves ? `${agent.name} serves ${scope.customerType} customers.` : `${agent.name} serves only ${agent.customerTypes.join(", ")} customers.`,
      basis: untouched ? { source: "scope", field: "event", value: scope.event } : exempt ? { ...byLevel } : { source: "roster", field: "customerTypes", value: [...agent.customerTypes] } });
  }
  for (const [skill, rule] of Object.entries(SKILL_CUSTOMER_TYPES)) {
    if (!rule.customerTypes.includes(scope.customerType)) out.push({ kind: "skill", id: skill, action: "exclude", reason: rule.reason, basis: { source: "scope", field: "customerType", value: scope.customerType } });
  }
  const offered = agentsFor(scope).flatMap((agent) => [...agent.skills, ...(agent.optional ?? [])]);
  for (const skill of level.excludeSkills ?? []) if (offered.includes(skill) && skillServes(skill, scope)) out.push({ kind: "skill", id: skill, action: "exclude", reason: level.reason, basis: { ...byLevel } });
  for (const skill of promoted(scope)) out.push({ kind: "skill", id: skill, action: "include", reason: `${level.reason} ${skill} runs as a required step.`, basis: { ...byLevel } });
  const skills = agentsFor(scope).flatMap((agent) => skillsFor(agent, scope));
  for (const [skill, [connector]] of Object.entries(CONNECTOR_FOR_SKILL)) {
    const excluded = notFor(scope, connector);
    if (excluded) out.push({ kind: "connector", id: connector, action: "exclude", reason: excluded, basis: { source: "scope", field: "customerType", value: scope.customerType } });
    else if (skills.includes(skill)) out.push({ kind: "connector", id: connector, action: "include", reason: `${skill} reads what it acquires.`, basis: { source: "roster", field: "skills.required", value: skill } });
    else out.push({ kind: "connector", id: connector, action: "exclude", reason: "No skill in the flow reads what it acquires.", basis: { source: "scope", field: "customerType", value: scope.customerType } });
  }
  const firstPack = packFor(scope, scope.jurisdictions[0]!).id;
  const productLayers = scope.products.filter((product) => product === "lending" || product === "payments").sort();
  for (const [connector] of CORPORATE_CONNECTORS) {
    if (!corporate || notFor(scope, connector)) out.push({ kind: "connector", id: connector, action: "exclude", reason: notFor(scope, connector) ?? "No skill in the flow reads what it acquires.", basis: { source: "scope", field: "customerType", value: scope.customerType } });
    else if (connector === "acquire-lei") out.push({ kind: "connector", id: connector, action: "include", reason: "A legal entity is identified by its LEI where it has one.", basis: { source: "scope", field: "customerType", value: "corporate" } });
    else out.push({ kind: "connector", id: connector, action: "include", reason: "Directors are screened, so the entity's officers are acquired.",
      basis: { source: "pack", field: "screening_roles", value: "director", packId: firstPack, layer: productLayers.length ? productLayers.map((product) => `pack.product.${product}`).join("+") : "pack.institution.bank-synthetic" } });
  }
  const requirements = level.requirements?.[scope.customerType];
  const [requirementsId, requirementsReason] = REQUIREMENTS[scope.customerType];
  out.push(requirements
    ? { kind: "requirements", id: requirements[0], action: "include", reason: requirements[1], basis: { ...byLevel } }
    : { kind: "requirements", id: requirementsId, action: "include", reason: requirementsReason, basis: { source: "scope", field: "customerType", value: scope.customerType } });
  return out;
}

const diff = (before: string[], after: string[]) => ({ added: after.filter((x) => !before.includes(x)), removed: before.filter((x) => !after.includes(x)) });

/** What changing a process to `scope` adds and removes, and why. */
export function previewScope(workflow: Rec, sourceFiles: Record<string, string> | undefined, scope: ProcessScope): { preview: Rec; composed: Rec } {
  const composed = composeWorkflow(scope);
  const before = shape(workflow);
  const after = shape(composed);
  const ids = (nodes: Shape["nodes"]) => nodes.map((entry) => entry.id);
  const changes = {
    agents: diff(before.agents, after.agents), skills: diff(before.skills, after.skills),
    connectors: diff(before.connectors, after.connectors), packs: diff(before.packs, after.packs),
    nodes: { added: after.nodes.filter((entry) => !ids(before.nodes).includes(entry.id)), removed: before.nodes.filter((entry) => !ids(after.nodes).includes(entry.id)) },
  };
  const unchanged = Object.values(changes).every((change) => !change.added.length && !change.removed.length);
  return { preview: { scope, previous: inferScope(workflow, sourceFiles), decisions: decisions(scope), changes, unchanged }, composed };
}

/** The seeded agentic KYC draft: a composed personal-banking process for US and GB. */
export function agenticKycDraft(base: Rec): Rec {
  const workflow = composeWorkflow(PERSONAL_SCOPE);
  const parsedPackage = { name: "kyc-agentic", domain: "fincrime", version: "0.1.0", objective: "Onboard a personal-banking customer with agentic due diligence and dual-control review",
    policies: [{ policyId: POLICY_REF, policyVersion: "2026.11.0" }], contextSelectors: [], contextClassificationPolicies: [], integrations: { triggers: [], humanActions: [], publications: [] } };
  return {
    ...base,
    draftId: AGENTIC_KYC_DRAFT_ID, name: "Agentic KYC onboarding", version: "0.1.0", revision: 1, status: "DRAFT", diagnostics: [],
    packageSource: `${JSON.stringify(parsedPackage, null, 2)}\n`, workflowSource: `${JSON.stringify(workflow, null, 2)}\n`, parsedPackage, parsedWorkflow: workflow,
    sourceFiles: { "policy.yaml": "# The synthetic bank's business policy for agentic KYC (mock)\n" },
    events: [{ eventId: `${AGENTIC_KYC_DRAFT_ID}-e1`, eventType: "draft.created", actor: "m.lindqvist", revision: 1, details: {}, occurredAt: base.createdAt }],
  };
}

export function isScope(value: unknown): value is ProcessScope {
  const scope = value as Rec;
  return Boolean(scope) && typeof scope === "object" && ALL_TYPES.includes(scope.customerType) && TRIGGERS.includes(scope.trigger)
    && (scope.dueDiligence === undefined || Object.keys(DUE_DILIGENCE).includes(scope.dueDiligence))
    && (scope.event === undefined || Object.keys(REVIEW_EVENTS).includes(scope.event))
    && Array.isArray(scope.jurisdictions) && scope.jurisdictions.length > 0 && scope.jurisdictions.every((code: unknown) => typeof code === "string" && /^[A-Z]{2}$/.test(code))
    && Array.isArray(scope.products) && scope.products.length > 0 && scope.products.every((product: unknown) => typeof product === "string" && /^[a-z][a-z_]{0,63}$/.test(product));
}
