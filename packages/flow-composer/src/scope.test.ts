import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { policyPackLayerSchema, type EffectivePolicyPack } from "@ehf/policy-engine";
import type { Agent } from "./compose.js";
import { resolveFlow, ScopeError, type ProcessScope } from "./scope.js";

const root = new URL("../../../", import.meta.url).pathname;
const roster = (JSON.parse(readFileSync(`${root}domains/agents/roster.json`, "utf8")) as { agents: Agent[] }).agents;
const packsDir = `${root}artifacts/policy/packs`;
const packs = new Map(readdirSync(packsDir).filter((file) => file.startsWith("policy.pack."))
  .map((file) => JSON.parse(readFileSync(join(packsDir, file), "utf8")) as EffectivePolicyPack).map((pack) => [pack.id, pack] as const));
const files = (dir: string): string[] => readdirSync(dir).sort().flatMap((name) => statSync(join(dir, name)).isDirectory() ? files(join(dir, name)) : name.endsWith(".yaml") ? [join(dir, name)] : []);
const layers = files(`${root}domains/policy/packs`).map((path) => policyPackLayerSchema.parse(parse(readFileSync(path, "utf8"))));

const PERSONAL: ProcessScope = { customerType: "individual", trigger: "onboarding", jurisdictions: ["US", "GB"], products: ["card", "deposit", "payments"] };
const BUSINESS: ProcessScope = { customerType: "corporate", trigger: "onboarding", jurisdictions: ["US", "GB"], products: ["deposit", "lending", "merchant_acquiring", "payments"] };
const decision = (result: ReturnType<typeof resolveFlow>, kind: string, id: string) => result.decisions.find((item) => item.kind === kind && item.id === id);

describe("resolveFlow", () => {
  it("derives the individual onboarding process, explaining each choice", () => {
    const result = resolveFlow(PERSONAL, { roster, packs });
    expect(result.flow.agents).not.toContain("agent.identity_ownership");
    expect(decision(result, "agent", "agent.identity_ownership")).toMatchObject({ action: "exclude", basis: { source: "roster", field: "customerTypes" } });
    expect(result.flow.excludedSkills).toEqual(["registry.company.verify", "screening.sanctions.ownership.evaluate", "screening.sanctions.control.evaluate"]);
    expect(result.flow.connectors).toEqual(["acquire-documents", "acquire-sanctions", "acquire-pep", "acquire-adverse-media"]);
    expect(result.flow.packs).toEqual(["policy.pack.us.bank-synthetic.personal-banking", "policy.pack.gb.bank-synthetic.personal-banking"]);
    expect(decision(result, "connector", "acquire-registry")).toMatchObject({ action: "exclude" });
  });

  it("derives the business onboarding process, with officers acquired because the pack screens directors", () => {
    const result = resolveFlow(BUSINESS, { roster, packs });
    expect(result.flow.agents).toContain("agent.identity_ownership");
    expect(result.flow.excludedSkills).toEqual([]);
    expect(decision(result, "connector", "acquire-officers")).toMatchObject({ action: "include", basis: { source: "pack", field: "screening_roles", value: "director" } });
    expect(result.flow.requirementsPackage).toBe("private_company");
  });

  it("changing the customer type recomposes agents, skills, connectors and packs", () => {
    const personal = resolveFlow(PERSONAL, { roster, packs }).flow;
    const business = resolveFlow({ ...PERSONAL, customerType: "corporate", products: BUSINESS.products }, { roster, packs }).flow;
    expect(business.agents.filter((id) => !personal.agents.includes(id))).toEqual(["agent.identity_ownership"]);
    expect(business.connectors.filter((id) => !personal.connectors.includes(id)).sort()).toEqual(["acquire-lei", "acquire-officers", "acquire-ownership", "acquire-registry"]);
    expect(business.packs.every((id) => id.endsWith("business-banking"))).toBe(true);
  });

  it("composes a pack for a product set no compiled pack covers, only for exactly those products", () => {
    const result = resolveFlow({ ...BUSINESS, jurisdictions: ["US"], products: ["deposit"] }, { roster, packs, layers });
    const [pack] = result.packs;
    expect(pack!.id).toBe("policy.pack.us.bank-synthetic.custom-deposit");
    expect(pack!.scope.products).toEqual(["deposit"]);
    // Deposit alone does not inherit merchant acquiring's adverse-media requirement.
    expect(pack!.values.required_screening_types).not.toContain("adverse_media");
  });

  it("names what is missing for an unsupported scope", () => {
    const refusal = (scope: ProcessScope, withLayers = true) => {
      try { resolveFlow(scope, { roster, packs, ...(withLayers ? { layers } : {}) }); } catch (error) { return error as ScopeError; }
      throw new Error("expected a refusal");
    };
    const germany = refusal({ ...PERSONAL, jurisdictions: ["DE"] });
    expect(germany.code).toBe("scope.pack_layer_missing");
    expect(germany.remedy).toContain("for DE");
    expect(refusal({ ...PERSONAL, products: ["custody"] }).remedy).toContain("product policy pack layer for custody");
    expect(refusal({ ...PERSONAL, products: ["deposit"] }, false).code).toBe("scope.pack_missing");
    expect(refusal({ ...PERSONAL, trigger: "event_review" }).code).toBe("scope.event_required");
    expect(refusal({ ...PERSONAL, trigger: "event_review", event: "ownership_change" }).code).toBe("scope.event_ineligible");
    expect(refusal({ ...PERSONAL, event: "identity_expiry" }).code).toBe("scope.event_unexpected");
    expect(refusal({ ...PERSONAL, customerType: "partnership" as never }).code).toBe("scope.customer_type_unsupported");
    expect(refusal({ ...BUSINESS, customerType: "trust", dueDiligence: "simplified" }).code).toBe("scope.due_diligence_ineligible");
    expect(refusal({ ...PERSONAL, trigger: "event_review", event: "trust_party_change" }).code).toBe("scope.event_ineligible");
    expect(refusal({ ...PERSONAL, jurisdictions: [] }).code).toBe("scope.jurisdictions_invalid");
  });
});

describe("repository loading and preview", async () => {
  const { loadComposerRepository } = await import("./load.js");
  const { composeForScope, inferScope, previewScopeChange } = await import("./preview.js");
  const repository = loadComposerRepository({ domains: `${root}domains`, config: `${root}config` });

  it("composes effective packs from the layers identical to the compiled ones", () => {
    for (const [id, pack] of packs) expect(repository.packs.get(id)?.digest, id).toBe(pack.digest);
  });

  it("composes a tenant's processes with its published pack layer revisions", async () => {
    const { withPublishedLayers } = await import("./load.js");
    expect(withPublishedLayers(repository, [])).toBe(repository);
    const bank = structuredClone(repository.layers.find((layer) => layer.metadata.id === "pack.institution.bank-synthetic")!);
    bank.values.screening_threshold = { value: 0.8, basis: { text: "Tighter possible-match score.", sources: [] } };
    const tenant = withPublishedLayers(repository, [bank]);
    const id = "policy.pack.us.bank-synthetic.business-banking";
    expect(tenant.packs.get(id)!.values.screening_threshold).toBe(0.8);
    expect(tenant.packs.get(id)!.digest).not.toBe(repository.packs.get(id)!.digest);
    // A process composed for the tenant pins the tenant's pack.
    const composed = composeForScope(BUSINESS, tenant);
    expect(composed.sources.workflowSource).toContain(tenant.packs.get(id)!.digest);
  });

  it("composes exactly the released processes from their scopes", () => {
    for (const [scope, dir] of [[PERSONAL, "kyc-agentic"], [BUSINESS, "kyb-agentic"]] as const) {
      const composed = composeForScope(scope, repository);
      const generated = readFileSync(`${root}domains/${dir}/workflow.yaml`, "utf8").split("\n").filter((line) => !line.startsWith("#")).join("\n");
      expect(composed.sources.workflowSource.split("\n").filter((line) => !line.startsWith("#")).join("\n")).toBe(generated);
      expect(composed.sources.sourceFiles["policy.yaml"]).toBe(readFileSync(`${root}domains/${dir}/policy.yaml`, "utf8"));
    }
  });

  it("previews a customer-type change as the agents, skills, connectors, packs and nodes it adds and removes", () => {
    const workflow = parse(readFileSync(`${root}domains/kyc-agentic/workflow.yaml`, "utf8"));
    expect(inferScope(workflow)).toEqual({ ...PERSONAL, institution: "bank.synthetic" });
    const unchanged = previewScopeChange({ workflow, scope: PERSONAL, repository }).preview;
    expect(unchanged.unchanged).toBe(true);
    const { preview } = previewScopeChange({ workflow, scope: BUSINESS, repository });
    expect(preview.changes.agents).toEqual({ added: ["agent.identity_ownership"], removed: [] });
    expect(preview.changes.skills.added).toEqual(expect.arrayContaining(["registry.company.verify", "screening.sanctions.ownership.evaluate"]));
    expect(preview.changes.connectors.added.sort()).toEqual(["acquire-lei", "acquire-officers", "acquire-ownership", "acquire-registry"]);
    expect(preview.changes.packs).toEqual({ added: ["policy.pack.us.bank-synthetic.business-banking", "policy.pack.gb.bank-synthetic.business-banking"],
      removed: ["policy.pack.us.bank-synthetic.personal-banking", "policy.pack.gb.bank-synthetic.personal-banking"] });
    expect(preview.changes.nodes.added.map((node) => node.id)).toContain("identity-ownership-review");
  });
});

describe("due-diligence levels", async () => {
  const { loadComposerRepository } = await import("./load.js");
  const { composeForScope } = await import("./preview.js");
  const repository = loadComposerRepository({ domains: `${root}domains`, config: `${root}config` });
  const nodes = (composed: ReturnType<typeof composeForScope>) => (composed.workflowDocument as { spec: { nodes: Array<{ id: string; kind: string; config?: Record<string, unknown> }> } }).spec.nodes;

  it("bounds the agents' records by the pinned packs' freshness (the strictest) and leaves the checkpoints' selectors unbounded", () => {
    const composed = composeForScope(BUSINESS, repository);
    const selectors = (parse(composed.sources.packageSource) as { contextSelectors: Array<{ id: string; record?: { objectType: string; maxAgeSeconds: number | null } }> }).contextSelectors;
    const agentVerification = selectors.filter((selector) => selector.record?.objectType === "VerificationRecord" && selector.id.includes("-review"));
    expect(agentVerification.length).toBeGreaterThan(0);
    // Business-banking packs hold verifications for 60 days in every jurisdiction.
    for (const selector of agentVerification) expect(selector.record!.maxAgeSeconds, selector.id).toBe(5184000);
    expect(selectors.filter((selector) => selector.id.startsWith("policyRecord")).every((selector) => !selector.record || selector.record.maxAgeSeconds === null)).toBe(true);
  });

  it("simplified due diligence exempts beneficial ownership for an eligible legal entity", () => {
    const composed = composeForScope({ ...BUSINESS, dueDiligence: "simplified" }, repository);
    expect(composed.flow.id).toBe("kyb-sdd-agentic");
    expect(composed.flow.agents).not.toContain("agent.identity_ownership");
    expect(composed.flow.connectors).not.toContain("acquire-ownership");
    expect(composed.flow.connectors).toContain("acquire-registry");
    expect(composed.flow.requirementsPackage).toBe("listed_company");
    expect(nodes(composed).some((node) => node.config?.skillId === "edd.source_of_funds.verify")).toBe(false);
    // Reviewed every three years; the decision-ready checkpoint does not require ownership.
    expect(composed.sources.sourceFiles["policy.yaml"]).toContain("value: 94608000");
    expect(composed.sources.sourceFiles["policy.yaml"]).not.toContain("ownershipComplete");
  });

  it("simplified due diligence does not apply to an individual", () => {
    expect(() => resolveFlow({ ...PERSONAL, dueDiligence: "simplified" }, { roster, packs })).toThrow("scope.due_diligence_ineligible");
  });

  it("enhanced due diligence verifies source of funds and wealth as required steps and never auto-approves", () => {
    const composed = composeForScope({ ...PERSONAL, dueDiligence: "enhanced" }, repository);
    expect(composed.flow.id).toBe("kyc-edd-agentic");
    const skills = nodes(composed).map((node) => node.config?.skillId).filter(Boolean);
    expect(skills).toEqual(expect.arrayContaining(["edd.scope.plan", "edd.source_of_funds.verify", "edd.source_of_wealth.assess"]));
    const scopePlan = nodes(composed).find((node) => node.config?.skillId === "edd.scope.plan")!;
    expect(scopePlan.config!.skillParameterBindings).toEqual({ trigger_ids: "edd-trigger-evaluate.payload.triggers[*].id" });
    const policy = composed.sources.sourceFiles["policy.yaml"]!;
    expect(policy).toContain("synthetic.decision.edd-funds-unverified");
    expect(policy).not.toContain("synthetic.disposition.low-risk-approve");
    expect(policy).toContain("value: 15552000");
  });

  it("enhanced due diligence maps a business's ownership through every layer", () => {
    const composed = composeForScope({ ...BUSINESS, dueDiligence: "enhanced" }, repository);
    const skills = nodes(composed).map((node) => node.config?.skillId);
    expect(skills).toEqual(expect.arrayContaining(["ownership.control.resolve", "ownership.nominee.detect", "ownership.circular.detect", "edd.source_of_funds.verify"]));
    expect(skills).not.toContain("edd.source_of_wealth.assess");
  });
});

describe("review triggers", async () => {
  const { loadComposerRepository } = await import("./load.js");
  const { composeForScope } = await import("./preview.js");
  const repository = loadComposerRepository({ domains: `${root}domains`, config: `${root}config` });
  const nodes = (composed: ReturnType<typeof composeForScope>) => (composed.workflowDocument as { spec: { nodes: Array<{ id: string; config?: Record<string, unknown> }> } }).spec.nodes;

  it("a periodic review re-performs due diligence with the periodic-review documents", () => {
    const composed = composeForScope({ ...PERSONAL, trigger: "periodic_review" }, repository);
    expect(composed.flow.id).toBe("kyc-periodic-review-agentic");
    expect(composed.flow.agents).toEqual(resolveFlow(PERSONAL, { roster, packs }).flow.agents);
    const requirements = nodes(composed).find((node) => node.config?.skillId === "document.requirements.resolve")!;
    expect((requirements.config!.skillParameters as { event: string }).event).toBe("periodic_review");
  });

  it("an ownership-change review re-runs ownership, documents and the review core, not identity or products", () => {
    const composed = composeForScope({ ...BUSINESS, trigger: "event_review", event: "ownership_change" }, repository);
    expect(composed.flow.id).toBe("kyb-review-ownership-change-agentic");
    expect(composed.flow.agents).toEqual(["agent.intake_profile", "agent.document_intelligence", "agent.identity_ownership", "agent.screening",
      "agent.investigation", "agent.risk_edd", "agent.decision_support", "agent.qa_assurance"]);
    const result = resolveFlow({ ...BUSINESS, trigger: "event_review", event: "ownership_change" }, { roster, packs });
    expect(result.decisions.find((item) => item.id === "agent.identity_verification")).toMatchObject({ action: "exclude", basis: { field: "event" } });
    // Facts bound from the identity check it skips stay unbound (unknown, never a pass).
    const compile = nodes(composed).find((node) => node.config?.skillId === "decision.requirements.compile")!;
    // (The diligence decision's level and requirements are bound from the diligence gate.)
    expect(Object.keys(compile.config!.skillParameterBindings as object)).toEqual(["facts.tier", "facts.diligence_level", "facts.diligence_requirements"]);
    expect(composed.flow.connectors).toContain("acquire-ownership");
  });

  it("a risk or screening trigger re-runs only the review core", () => {
    const composed = composeForScope({ ...PERSONAL, trigger: "event_review", event: "risk_or_screening_trigger", dueDiligence: "enhanced" }, repository);
    expect(composed.flow.id).toBe("kyc-edd-review-risk-or-screening-trigger-agentic");
    expect(composed.flow.agents).not.toContain("agent.document_intelligence");
    expect(composed.flow.connectors).toEqual(["acquire-sanctions", "acquire-pep", "acquire-adverse-media"]);
  });
});

describe("plan catalogue", async () => {
  const { selectCasePlan, planScope } = await import("./catalog.js");
  const plan = (name: string) => JSON.parse(readFileSync(`${root}artifacts/${name}.plan.json`, "utf8"));
  const kyc = plan("kyc-agentic");
  const kyb = plan("kyb-agentic");

  it("reads a released plan's process scope and pinned packs", () => {
    expect(planScope(kyc)).toMatchObject({ scope: { customerType: "individual", trigger: "onboarding", dueDiligence: "standard", jurisdictions: ["US", "GB"] } });
    expect(planScope(kyc)!.packs.map((pack) => pack.id)).toEqual(["policy.pack.us.bank-synthetic.personal-banking", "policy.pack.gb.bank-synthetic.personal-banking"]);
  });

  it("picks the plan for the case's process and the pack for its jurisdiction and products", () => {
    const selection = selectCasePlan([kyc, kyb], { customerType: "corporate", trigger: "onboarding", jurisdiction: "GB", products: ["deposit", "payments"] });
    expect(selection).toMatchObject({ status: "selected", plan: { planDigest: kyb.planDigest }, pack: { id: "policy.pack.gb.bank-synthetic.business-banking" } });
  });

  it("an escalated case finds the enhanced plan, in every jurisdiction it was composed for", () => {
    const edd = plan("kyc-edd-agentic");
    const selection = selectCasePlan([kyc, kyb, edd, plan("kyb-edd-agentic"), plan("kyb-sdd-agentic")],
      { customerType: "individual", trigger: "onboarding", dueDiligence: "enhanced", jurisdiction: "AU", products: ["card"] });
    expect(selection).toMatchObject({ status: "selected", plan: { planDigest: edd.planDigest }, pack: { id: "policy.pack.au.bank-synthetic.personal-banking" } });
    // The standard process's checkpoints carry the escalation; the enhanced process's do not.
    expect(readFileSync(`${root}domains/kyc-agentic/policy.yaml`, "utf8")).toContain("synthetic.decision.edd-escalation");
    expect(readFileSync(`${root}domains/kyc-edd-agentic/policy.yaml`, "utf8")).not.toContain("synthetic.decision.edd-escalation");
    const eddTrigger = kyc.graph.nodes.find((node: { config: Record<string, unknown> }) => node.config.skillId === "edd.trigger.evaluate");
    expect(JSON.stringify(eddTrigger.config.caseWrites)).toContain("edd_required");
  });

  it("stops instead of guessing", () => {
    const base = { customerType: "individual", trigger: "onboarding", jurisdiction: "US", products: ["deposit"] };
    expect(selectCasePlan([kyc, kyb], { ...base, dueDiligence: "enhanced" }).status).toBe("no_plan");
    expect(selectCasePlan([kyc, kyb], { ...base, jurisdiction: "AU" }).status).toBe("no_pack");
    expect(selectCasePlan([kyc, kyb], { ...base, products: ["lending"] }).status).toBe("no_pack");
    expect(selectCasePlan([kyc, kyc], base).status).toBe("ambiguous_plan");
    expect(selectCasePlan([kyc], { ...base, products: [] }).status).toBe("context_incomplete");
  });
});

describe("trust customers", async () => {
  const { loadComposerRepository } = await import("./load.js");
  const { composeForScope } = await import("./preview.js");
  const { selectCasePlan } = await import("./catalog.js");
  const repository = loadComposerRepository({ domains: `${root}domains`, config: `${root}config` });
  const TRUST: ProcessScope = { ...BUSINESS, customerType: "trust" };

  it("onboards a trust under the business-banking packs with the trust documents and no company registry", () => {
    const result = resolveFlow(TRUST, { roster, packs });
    expect(result.flow.id).toBe("kyb-trust-agentic");
    expect(result.flow.packs).toEqual(["policy.pack.us.bank-synthetic.business-banking", "policy.pack.gb.bank-synthetic.business-banking"]);
    expect(result.flow.agents).toContain("agent.identity_ownership");
    expect(result.flow.requirementsPackage).toBe("trust");
    expect(result.flow.excludedSkills).toContain("registry.company.verify");
    expect(result.flow.connectors).toEqual(["acquire-lei", "acquire-documents", "acquire-sanctions", "acquire-pep", "acquire-adverse-media"]);
    expect(result.decisions.find((item) => item.id === "acquire-ownership")).toMatchObject({ action: "exclude", reason: expect.stringContaining("trust deed") });
  });

  it("composes a trust process whose scope finds it in the catalogue", () => {
    const composed = composeForScope(TRUST, repository);
    expect(composed.flow.title).toBe("Agentic KYB: trust onboarding");
    const plan = { planDigest: "trust", graph: { nodes: (composed.workflowDocument as { spec: { nodes: unknown[] } }).spec.nodes } } as never;
    expect(selectCasePlan([plan], { customerType: "trust", trigger: "onboarding", jurisdiction: "GB", products: ["deposit"] }))
      .toMatchObject({ status: "selected", pack: { id: "policy.pack.gb.bank-synthetic.business-banking" } });
    expect(selectCasePlan([plan], { customerType: "corporate", trigger: "onboarding", jurisdiction: "GB", products: ["deposit"] }).status).toBe("no_plan");
  });
});
