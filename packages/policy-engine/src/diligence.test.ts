import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { BusinessDecisionBasis } from "@ehf/contracts";
import { businessPolicyInput, closeBusinessPolicyEvaluators, compileBusinessPolicy, evaluateBusinessPolicy, type BusinessPolicySource } from "./business-policy.js";
import { evaluateDiligence } from "./diligence/evaluate.js";
import { diligenceDesignSchema, projectDiligenceDesign, type DiligenceSource } from "./diligence/schema.js";

const d = "a".repeat(64);
const design = diligenceDesignSchema.parse(parse(readFileSync(new URL("../../../domains/policy/diligence/bank-synthetic.yaml", import.meta.url), "utf8")));
const unresolved = { state: "UNRESOLVED" as const, reasonCodes: ["NOT_AUTHORED"], ruleIds: [], actions: [], humanRequirement: null, gaps: [] };

type Configuration = BusinessPolicySource["policySets"][number]["configuration"];
const CONFIGURATIONS: Record<string, Configuration> = {
  us: { mandatory_overlays: [], simplified_due_diligence_permitted: false, diligence_floors: {} },
  gb: { mandatory_overlays: ["overlay.pep", "overlay.high-risk-geography", "overlay.adverse-media"], simplified_due_diligence_permitted: false, diligence_floors: {} },
  open: { mandatory_overlays: [], simplified_due_diligence_permitted: true, diligence_floors: { "corporate:lending": "EDD", "*:card": "CDD", "individual:*": "SDD" } },
};
const PERSONAL = ["card", "deposit", "payments"], BUSINESS = ["deposit", "lending", "merchant_acquiring", "payments"];
const sets = Object.entries(CONFIGURATIONS).flatMap(([name, configuration]) => [
  { name, customerType: "individual" as const, products: PERSONAL },
  { name, customerType: "corporate" as const, products: BUSINESS },
].map((entry) => ({
  id: `set.${entry.name}.${entry.customerType}`, version: "2.0.0", status: "CANDIDATE" as const, packPin: { id: `pack.${entry.name}`, digest: d },
  scope: { jurisdiction: "US", institution: "bank.synthetic", products: entry.products, customerTypes: [entry.customerType], purposes: ["CDD_ONBOARDING"] },
  modules: [{ id: "pack.test", version: "1.0.0", digest: d }], configuration,
})));

function policy(diligence: unknown = projectDiligenceDesign(design, sets)): BusinessPolicySource {
  return {
    apiVersion: "harness.factory/business-policy-v2", kind: "BusinessPolicy",
    metadata: { id: "policy.diligence.test", version: "2.0.0", owner: "policy.owner" }, decisionTtlSeconds: 60,
    policySets: structuredClone(sets),
    gates: {
      "decision-ready": { inputProfile: "canonical.onboarding.v2", rules: [{ id: "r1", when: { path: "/facts/never", op: "present" }, result: structuredClone(unresolved) }], otherwise: structuredClone(unresolved) },
      // The seeded PEP rule requires an approval, which needs a gate to hold it at.
      disposition: { inputProfile: "canonical.onboarding.v2", rules: [{ id: "d1", when: { path: "/facts/never", op: "present" }, result: structuredClone(unresolved) }], otherwise: structuredClone(unresolved) },
    },
    diligence: diligence as DiligenceSource,
  };
}
const refusal = (change: (source: BusinessPolicySource) => void) => {
  const source = policy(); change(source);
  try { compileBusinessPolicy(source, { opaVersion: "1.9.0" }); return "compiled"; } catch (error) { return error instanceof Error ? error.message : String(error); }
};
const diligenceOf = (source: BusinessPolicySource) => source.diligence!;

afterAll(closeBusinessPolicyEvaluators);

describe("diligence source checks", () => {
  it("adds the diligence gate beside the authored gates and binds it in every policy set", () => {
    const compiled = compileBusinessPolicy(policy(), { opaVersion: "1.9.0" });
    expect(compiled.manifest.gates.map((gate) => [gate.gateId, gate.allowedOutcomes])).toEqual([
      ["decision-ready", ["DECIDED", "NEEDS_EVIDENCE", "NEEDS_HUMAN", "NOT_APPLICABLE", "UNRESOLVED"]], ["diligence-level", ["DECIDED", "UNRESOLVED"]],
      ["disposition", ["DECIDED", "NEEDS_EVIDENCE", "NEEDS_HUMAN", "NOT_APPLICABLE", "UNRESOLVED"]]]);
    for (const set of compiled.policySets) expect(set.gateBindings["diligence-level"]).toMatchObject({ inputProfile: "canonical.onboarding.v2", bundleDigest: compiled.manifest.bundleDigest });
    expect(compiled.manifest.ruleIds).toContain("overlay.pep");
    expect(JSON.parse(compiled.files["data.json"]!).business.diligenceIndex.legalFormPath).toEqual(["scope", "legalForm"]);
  });

  it("refuses a matrix, overlay or requirement it cannot evaluate deterministically", () => {
    expect(refusal((s) => { delete diligenceOf(s).matrix.trust!.payments; })).toContain("policy.diligence_matrix_cell_missing:trust:payments");
    expect(refusal((s) => { diligenceOf(s).matrix.trust!.payments = "XDD"; })).toContain("policy.diligence_matrix_level_unknown:trust:payments");
    expect(refusal((s) => { diligenceOf(s).partyTypes[2]!.legalForms.push("ordinary_trust"); })).toContain("policy.diligence_legal_form_ambiguous");
    expect(refusal((s) => { diligenceOf(s).requirements.EDD = ["EVD-SOURCE-OF-FUNDS"]; })).toContain("policy.diligence_requirements_not_cumulative:EDD");
    expect(refusal((s) => { diligenceOf(s).overlays[0]!.effect = { escalateTo: "XDD" }; })).toContain("policy.diligence_overlay_level_unknown:overlay.pep");
    expect(refusal((s) => { diligenceOf(s).simplifiedLevel = "CDD"; })).toContain("policy.diligence_simplified_level_not_lowest");
    expect(refusal((s) => { diligenceOf(s).overlays[0]!.id = "diligence.pep"; })).toContain("policy.diligence_overlay_id_invalid");
    expect(refusal((s) => { diligenceOf(s).overlays[0]!.when = { path: "/elsewhere", op: "present" }; })).toBe("policy.predicate_path_invalid");
    expect(refusal((s) => { diligenceOf(s).overlays[0]!.when = { path: "/facts/x", op: "resembles" }; })).toBe("policy.diligence_overlay_condition_invalid:overlay.pep");
    expect(refusal((s) => { diligenceOf(s).inputs.legalForm = "/case/legalForm"; })).toContain("policy.diligence_pointer_invalid");
  });

  it("refuses a block that leaves a served product, customer type or mandatory overlay uncovered", () => {
    expect(refusal((s) => { diligenceOf(s).products = diligenceOf(s).products.filter((p) => p !== "lending"); for (const row of Object.values(diligenceOf(s).matrix)) delete row.lending; }))
      .toContain("policy.diligence_product_uncovered:set.us.corporate:lending");
    expect(refusal((s) => { const block = diligenceOf(s); block.partyTypes = block.partyTypes.filter((p) => p.customerType === "corporate"); delete block.matrix.individual; }))
      .toContain("policy.diligence_customer_type_uncovered:set.us.individual:individual");
    expect(refusal((s) => { diligenceOf(s).overlays = diligenceOf(s).overlays.filter((o) => o.id !== "overlay.adverse-media"); }))
      .toContain("policy.diligence_mandatory_overlay_unknown:set.gb.individual:overlay.adverse-media");
    expect(refusal((s) => { delete s.policySets[0]!.configuration.simplified_due_diligence_permitted; })).toContain("policy.diligence_sdd_permission_unset:set.us.individual");
  });

  it("keeps the gate id its own and outputs to the interpreter", () => {
    expect(refusal((s) => { s.gates["diligence-level"] = s.gates["decision-ready"]!; })).toContain("policy.diligence_gate_collision");
    const outputs = { diligence: { level: "CDD", baseLevel: "CDD", partyType: "company", products: ["deposit"], requirements: [], contributors: [{ kind: "cell", id: "x", level: "CDD" }] } };
    expect(refusal((s) => { Object.assign(s.gates["decision-ready"]!.otherwise, { state: "DECIDED", outputs }); })).toContain("policy.authored_outputs_forbidden");
  });
});

// ---- behaviour, on the reference evaluation ----------------------------------------------

type Facts = { pep?: boolean; finding?: boolean; country?: string; owners?: number; media?: boolean; transaction?: string; omit?: string[] };
function facts(options: Facts = {}): Record<string, unknown> {
  const selected: Record<string, unknown> = {
    policyRecordPEPRelationship: options.pep ? [{ object_type: "PEPRelationship", object_id: "p1", version_id: "v1", data: { source: "a", target: "b", relation: "self", verified: true } }] : [],
    policyCaseFindings: options.finding ? [{ findingType: "PEP_SIGNAL", status: "OPEN" }] : [{ findingType: "PEP_SIGNAL", status: "CLOSED" }],
    policyRecordGeographyExposure: options.country ? [{ object_type: "GeographyExposure", object_id: "g1", version_id: "v1", data: { country: options.country, basis: "residence", value: "1" } }] : [],
    packOwnership: Array.from({ length: options.owners ?? 0 }, (_, index) => ({ object_type: "OwnershipInterest", object_id: `o${index}`, version_id: "v1", data: { owner: `x${index}`, owned: "c", interest: "0.2" } })),
    policyRecordAdverseMediaEvent: options.media ? [{ object_type: "AdverseMediaEvent", object_id: "m1", version_id: "v1", data: { status: "CONFIRMED" } }] : [],
    policyRecordRiskFactor: options.transaction ? [{ object_type: "RiskFactor", object_id: "r1", version_id: "v1", data: { name: "transaction", score: options.transaction } }] : [],
  };
  for (const key of options.omit ?? []) delete selected[key];
  return { asOf: "2026-11-11T00:00:00Z", selected };
}
const scope = (customerType: "individual" | "corporate", products: string[], legalForm?: string) =>
  ({ jurisdiction: "US", institution: "bank.synthetic", products, customerType, ...(legalForm === undefined ? {} : { legalForm }) });
const source = policy();
const run = (configuration: string, s: ReturnType<typeof scope>, f = facts()) =>
  evaluateDiligence(source.diligence!, { gateId: "diligence-level", facts: f, observations: {}, configuration: CONFIGURATIONS[configuration]!, scope: s });

describe("diligence level", () => {
  it("starts from the matrix cell and takes the strictest cell across products", () => {
    expect(run("us", scope("corporate", ["deposit"], "corporation")).outputs?.diligence).toMatchObject({ level: "CDD", baseLevel: "CDD", partyType: "company" });
    const trust = run("us", scope("corporate", ["deposit", "payments"], "ordinary_trust"));
    expect(trust).toMatchObject({ state: "DECIDED", reasonCodes: ["DILIGENCE_LEVEL_EDD"], ruleIds: ["diligence.cell.trust.deposit", "diligence.cell.trust.payments"] });
    expect(trust.outputs?.diligence.requirements).toContain("EVD-SOURCE-OF-FUNDS");
  });

  it("applies an SDD cell as CDD until simplified due diligence is permitted, and says why", () => {
    const withheld = run("us", scope("individual", ["deposit"], "individual"));
    expect(withheld.outputs?.diligence).toMatchObject({ level: "CDD", baseLevel: "SDD" });
    expect(withheld.outputs?.diligence.contributors.at(-1)).toEqual({ kind: "permission", id: "diligence.permission.sdd", level: "CDD" });
    const permitted = run("open", scope("individual", ["deposit"], "individual"));
    expect(permitted.outputs?.diligence).toMatchObject({ level: "SDD", requirements: ["EVD-CIP-IDENTITY-DOCUMENT", "EVD-SANCTIONS-SCREENING"] });
  });

  it("only escalates: overlays, floors and mandatory overlays raise the level, never lower it", () => {
    expect(run("us", scope("corporate", ["deposit"], "llc"), facts({ pep: true })).outputs?.diligence.level).toBe("EDD");
    expect(run("us", scope("individual", ["card"], "individual"), facts({ finding: true })).outputs?.diligence.contributors.map((c) => c.id))
      .toEqual(["diligence.cell.individual.card", "overlay.pep"]);
    expect(run("us", scope("corporate", ["deposit"], "corporation"), facts({ country: "IR" })).outputs?.diligence).toMatchObject({ level: "EDD" });
    expect(run("us", scope("corporate", ["deposit"], "corporation"), facts({ country: "FR" })).outputs?.diligence.level).toBe("CDD");
    expect(run("us", scope("corporate", ["deposit"], "corporation"), facts({ owners: 3 })).outputs?.diligence.level).toBe("EDD");
    // A disabled overlay stays off unless a pack makes it mandatory.
    expect(run("us", scope("corporate", ["deposit"], "corporation"), facts({ media: true })).outputs?.diligence.level).toBe("CDD");
    expect(run("gb", scope("corporate", ["deposit"], "corporation"), facts({ media: true })).outputs?.diligence.level).toBe("EDD");
    // Floors raise a cell; a floor below the cell changes nothing and is not listed.
    const floored = run("open", scope("corporate", ["lending"], "corporation"));
    expect(floored.outputs?.diligence).toMatchObject({ level: "EDD", baseLevel: "CDD" });
    expect(floored.outputs?.diligence.contributors).toContainEqual({ kind: "floor", id: "diligence.floor.corporate:lending", level: "EDD" });
    expect(run("open", scope("corporate", ["deposit"], "corporation"), facts({ pep: false })).ruleIds).toEqual(["diligence.cell.company.deposit"]);
    // escalateBy stops at the top level.
    expect(run("us", scope("corporate", ["payments"], "ordinary_trust"), facts({ country: "KP" })).outputs?.diligence.level).toBe("EDD");
  });

  it("stays unresolved, never lower, when an input is missing or does not fit", () => {
    expect(run("us", scope("corporate", ["deposit"], "corporation"), facts({ omit: ["policyRecordPEPRelationship"] })))
      .toMatchObject({ state: "UNRESOLVED", reasonCodes: ["DILIGENCE_INPUT_MISSING"], gaps: [{ code: "DILIGENCE_INPUT_MISSING", path: "/facts/selected/policyRecordPEPRelationship", subjectId: null }] });
    // A disabled overlay's inputs are not demanded.
    expect(run("us", scope("corporate", ["deposit"], "corporation"), facts({ omit: ["policyRecordAdverseMediaEvent"] })).state).toBe("DECIDED");
    expect(run("gb", scope("corporate", ["deposit"], "corporation"), facts({ omit: ["policyRecordAdverseMediaEvent"] })).state).toBe("UNRESOLVED");
    expect(run("us", scope("corporate", ["deposit"])).gaps).toEqual([{ code: "DILIGENCE_INPUT_MISSING", path: "/scope/legalForm", subjectId: null }]);
    expect(run("us", scope("corporate", ["deposit"], "unknown")).reasonCodes).toEqual(["DILIGENCE_PARTY_TYPE_UNKNOWN"]);
    expect(run("us", scope("individual", ["deposit"], "corporation")).reasonCodes).toEqual(["DILIGENCE_PARTY_TYPE_SCOPE_MISMATCH"]);
    expect(run("us", scope("corporate", ["deposit", "crypto"], "corporation")).gaps).toEqual([{ code: "DILIGENCE_PRODUCT_NOT_IN_MATRIX", path: "/scope/products/crypto", subjectId: null }]);
  });
});

// ---- the compiled interpreter agrees with the reference on a corpus ---------------------

describe("OPA agreement", () => {
  it("decides every corpus case exactly as the reference evaluation does", async () => {
    const compiled = compileBusinessPolicy(source, { opaVersion: "1.9.0" });
    const legalForms = { individual: ["individual", "corporation"], corporate: ["corporation", "ordinary_trust", "charity", "sole_proprietor", "unknown", undefined] } as const;
    const variants: Facts[] = [{}, { pep: true }, { finding: true }, { country: "MM" }, { country: "DE" }, { owners: 3 }, { media: true }, { transaction: "0.9" },
      { omit: ["policyCaseFindings"] }, { omit: ["policyRecordAdverseMediaEvent"] }, { pep: true, country: "IR", owners: 4 }];
    let compared = 0;
    for (const set of compiled.policySets) {
      const customerType = set.scope.customerTypes[0]!;
      const productSets = [[set.scope.products[0]!], set.scope.products, [set.scope.products.at(-1)!, "crypto"]];
      for (const legalForm of legalForms[customerType]) for (const products of productSets) for (const variant of variants) {
        const basis: BusinessDecisionBasis = { tenantId: "t", caseId: "c", planDigest: d, releaseDigest: d, caseSequence: 1, snapshotDigest: d, dependencyDigest: d,
          selectedInputDigest: d, effectivePolicySetDigest: set.setDigest, policyBundleDigest: compiled.manifest.bundleDigest, inputProfile: "canonical.onboarding.v2",
          gateId: "diligence-level", purpose: "CDD_ONBOARDING", subjectIds: [], proposerPrincipalIds: [], evaluatedAt: "2026-11-11T00:00:00Z", knowledgeCutoff: "2026-11-11T00:00:00Z",
          scope: scope(customerType, products.filter((p) => p !== "crypto"), legalForm) };
        if (products.includes("crypto")) basis.scope.products = products;
        const input = facts(variant);
        let opa: unknown;
        try { opa = (await evaluateBusinessPolicy({ compiled, basis, facts: input })).result; }
        catch (error) { if (String(error).includes("decision_authority_mismatch")) continue; throw error; }
        const reference = evaluateDiligence(source.diligence!, businessPolicyInput({ basis, facts: input, configuration: set.configuration }));
        expect(opa, `${set.id} ${String(legalForm)} ${products.join("+")} ${JSON.stringify(variant)}`).toEqual(reference);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(200);
  }, 120_000);

  it("leaves the authored gates as they were", async () => {
    const compiled = compileBusinessPolicy(source, { opaVersion: "1.9.0" });
    const set = compiled.policySets[0]!;
    const decision = await evaluateBusinessPolicy({ compiled, facts: {}, basis: { tenantId: "t", caseId: "c", planDigest: d, releaseDigest: d, caseSequence: 1, snapshotDigest: d,
      dependencyDigest: d, selectedInputDigest: d, effectivePolicySetDigest: set.setDigest, policyBundleDigest: compiled.manifest.bundleDigest, inputProfile: "canonical.onboarding.v2",
      gateId: "decision-ready", purpose: "CDD_ONBOARDING", subjectIds: [], proposerPrincipalIds: [], evaluatedAt: "2026-11-11T00:00:00Z", knowledgeCutoff: "2026-11-11T00:00:00Z",
      scope: scope("individual", ["card"], "individual") } });
    expect(decision.result).toEqual({ ...unresolved, ruleIds: [] });
  });
});

// ---- scope on the product taxonomy (Product Policy Studio phase C) -------------------------

const ALIASES = { card: "PAY.CARDS", payments: "PAY", deposit: "DEP", lending: "LND", merchant_acquiring: "PAY.MERCHANT_ACQUIRING" };
const BROKERAGE = ["BRK.PRIME.INSTITUTIONAL", "BRK.RETAIL.CASH"];
const scopedSets = ["US", "GB"].flatMap((jurisdiction) => sets.map((set) => ({
  ...structuredClone(set), id: `${set.id}.${jurisdiction.toLowerCase()}`,
  scope: { ...set.scope, jurisdiction, products: set.scope.customerTypes[0] === "corporate" ? [...set.scope.products, ...BROKERAGE, "PAY.CARDS.DEBIT"] : set.scope.products },
})));
/** The bank's design with family columns, node floors and scoped overlays. */
function scopedDiligence(): DiligenceSource {
  const block = structuredClone(projectDiligenceDesign(design, sets, ALIASES));
  block.products = ["card", "deposit", "lending", "PAY", "BRK", "BRK.PRIME"];
  for (const [party, row] of Object.entries(block.matrix)) {
    const payments = row.payments!;
    delete row.payments; delete row.merchant_acquiring;
    row.PAY = payments; row.BRK = "CDD";
    row["BRK.PRIME"] = party === "fund" ? "CDD" : "EDD";
  }
  const overlay = (id: string) => block.overlays.find((entry) => entry.id === id)!;
  Object.assign(overlay("overlay.high-transaction-risk"), { enabled: true, appliesTo: { products: ["PAY"] } });
  Object.assign(overlay("overlay.complex-ownership"), { appliesTo: { partyTypes: ["company", "trust"] } });
  Object.assign(overlay("overlay.high-risk-geography"), { appliesTo: { jurisdictions: ["GB"] } });
  return block;
}
function scopedPolicy(): BusinessPolicySource {
  return { ...policy(scopedDiligence()), policySets: structuredClone(scopedSets) as BusinessPolicySource["policySets"] };
}
const scopedSource = scopedPolicy();
const FLOORED = { ...CONFIGURATIONS.us!, diligence_floors: { "corporate:BRK": "EDD", "*:PAY.CARDS": "CDD" } };
const runScoped = (s: Record<string, unknown>, f = facts(), configuration: Configuration = CONFIGURATIONS.us!) =>
  evaluateDiligence(scopedSource.diligence!, { gateId: "diligence-level", facts: f, observations: {}, configuration, scope: s });

describe("diligence on the product taxonomy", () => {
  it("compiles a block whose columns are taxonomy nodes and whose overlays are scoped", () => {
    expect(() => compileBusinessPolicy(scopedSource, { opaVersion: "1.9.0" })).not.toThrow();
    expect(scopedSource.diligence!.productAliases).toEqual(ALIASES);
  });

  it("takes the most specific column in each product's lineage", () => {
    const company = (products: string[]) => runScoped({ ...scope("corporate", products, "corporation") }).outputs?.diligence;
    expect(company(["payments"])).toMatchObject({ level: "CDD", products: ["payments"] });
    expect(runScoped(scope("corporate", ["merchant_acquiring"], "corporation")).ruleIds).toContain("diligence.cell.company.PAY");
    expect(runScoped(scope("corporate", ["card"], "corporation")).ruleIds).toContain("diligence.cell.company.card");
    expect(company(["BRK.PRIME.INSTITUTIONAL"])).toMatchObject({ level: "EDD", contributors: [{ kind: "cell", id: "diligence.cell.company.BRK.PRIME", level: "EDD" }] });
    expect(company(["BRK.RETAIL.CASH"])).toMatchObject({ level: "CDD", contributors: [{ kind: "cell", id: "diligence.cell.company.BRK", level: "CDD" }] });
    // A debit card is a card: it takes the card column, not the payments family's.
    expect(runScoped(scope("corporate", ["PAY.CARDS.DEBIT"], "corporation")).ruleIds).toEqual(["diligence.cell.company.card"]);
    expect(runScoped(scope("corporate", ["BRK.PRIME.INSTITUTIONAL"], "fund")).outputs?.diligence.level).toBe("CDD");
    expect(runScoped(scope("corporate", ["DIG.CUSTODY"], "corporation")).gaps).toEqual([{ code: "DILIGENCE_PRODUCT_NOT_IN_MATRIX", path: "/scope/products/DIG.CUSTODY", subjectId: null }]);
  });

  it("applies a floor set on a node to every product beneath it", () => {
    const floored = runScoped(scope("corporate", ["BRK.RETAIL.CASH"], "fund"), facts(), FLOORED);
    expect(floored.outputs?.diligence).toMatchObject({ level: "EDD", baseLevel: "CDD" });
    expect(floored.outputs?.diligence.contributors).toContainEqual({ kind: "floor", id: "diligence.floor.corporate:BRK", level: "EDD" });
    expect(runScoped(scope("individual", ["card"], "individual"), facts(), { ...FLOORED, diligence_floors: { "*:PAY": "EDD" } }).outputs?.diligence.level).toBe("EDD");
    expect(runScoped(scope("individual", ["deposit"], "individual"), facts(), { ...FLOORED, diligence_floors: { "*:PAY": "EDD" } }).outputs?.diligence.level).toBe("CDD");
  });

  it("fires an overlay only within its scope, and asks for its inputs only there", () => {
    const risky = facts({ transaction: "0.9" });
    expect(runScoped(scope("corporate", ["payments"], "corporation"), risky).ruleIds).toContain("overlay.high-transaction-risk");
    expect(runScoped(scope("corporate", ["deposit"], "corporation"), risky).ruleIds).not.toContain("overlay.high-transaction-risk");
    expect(runScoped(scope("corporate", ["deposit"], "corporation"), facts({ omit: ["policyRecordRiskFactor"] })).state).toBe("DECIDED");
    expect(runScoped(scope("corporate", ["deposit", "payments"], "corporation"), facts({ omit: ["policyRecordRiskFactor"] })).reasonCodes).toEqual(["DILIGENCE_INPUT_MISSING"]);
    // Party type: complex ownership reaches companies and trusts, not funds.
    expect(runScoped(scope("corporate", ["deposit"], "corporation"), facts({ owners: 3 })).outputs?.diligence.level).toBe("EDD");
    expect(runScoped(scope("corporate", ["deposit"], "fund"), facts({ owners: 3 })).outputs?.diligence.level).toBe("CDD");
    // Jurisdiction: the geography overlay is a GB rule here.
    expect(runScoped({ ...scope("corporate", ["deposit"], "corporation"), jurisdiction: "GB" }, facts({ country: "IR" })).outputs?.diligence.level).toBe("EDD");
    expect(runScoped(scope("corporate", ["deposit"], "corporation"), facts({ country: "IR" })).outputs?.diligence.level).toBe("CDD");
    expect(runScoped(scope("corporate", ["deposit"], "corporation"), facts({ omit: ["policyRecordGeographyExposure"] })).state).toBe("DECIDED");
  });

  it("refuses a scope naming an unknown party type or a malformed node, and an uncovered product", () => {
    const refuse = (change: (source: BusinessPolicySource) => void) => { const s = scopedPolicy(); change(s); try { compileBusinessPolicy(s, { opaVersion: "1.9.0" }); return "compiled"; } catch (error) { return String(error); } };
    expect(refuse((s) => { s.diligence!.overlays[0]!.appliesTo = { partyTypes: ["pirate"] }; })).toContain("policy.diligence_overlay_party_type_unknown:overlay.pep:pirate");
    expect(refuse((s) => { s.diligence!.overlays[0]!.appliesTo = { products: ["Pay.cards"] }; })).not.toBe("compiled");
    expect(refuse((s) => { s.policySets[1]!.scope.products.push("DIG.CUSTODY"); })).toContain("policy.diligence_product_uncovered:set.us.corporate.us:DIG.CUSTODY");
  });

  it("decides every scoped corpus case exactly as the reference evaluation does, under OPA", async () => {
    const legalForms = { individual: ["individual", "corporation"], corporate: ["corporation", "ordinary_trust", "fund", "unknown"] } as const;
    const variants: Facts[] = [{}, { pep: true }, { country: "IR" }, { owners: 3 }, { transaction: "0.9" }, { omit: ["policyRecordRiskFactor"] }, { omit: ["policyRecordGeographyExposure"] }, { owners: 4, transaction: "0.95" }];
    const configurations: Configuration[] = [{}, { diligence_floors: FLOORED.diligence_floors }, { diligence_floors: { "*:PAY": "EDD", "individual:*": "SDD" }, simplified_due_diligence_permitted: true }];
    let compared = 0;
    for (const extra of configurations) {
      const varied = scopedPolicy();
      for (const set of varied.policySets) Object.assign(set.configuration, extra);
      const compiled = compileBusinessPolicy(varied, { opaVersion: "1.9.0" });
      for (const set of compiled.policySets) {
        const customerType = set.scope.customerTypes[0]!;
        const productSets = customerType === "corporate"
          ? [["payments"], ["merchant_acquiring", "deposit"], ["BRK.PRIME.INSTITUTIONAL"], ["BRK.RETAIL.CASH", "lending"], ["PAY.CARDS.DEBIT"], set.scope.products]
          : [["card"], ["deposit"], set.scope.products];
        for (const legalForm of legalForms[customerType]) for (const products of productSets) for (const variant of variants) {
          const basis: BusinessDecisionBasis = { tenantId: "t", caseId: "c", planDigest: d, releaseDigest: d, caseSequence: 1, snapshotDigest: d, dependencyDigest: d,
            selectedInputDigest: d, effectivePolicySetDigest: set.setDigest, policyBundleDigest: compiled.manifest.bundleDigest, inputProfile: "canonical.onboarding.v2",
            gateId: "diligence-level", purpose: "CDD_ONBOARDING", subjectIds: [], proposerPrincipalIds: [], evaluatedAt: "2026-11-11T00:00:00Z", knowledgeCutoff: "2026-11-11T00:00:00Z",
            scope: { ...scope(customerType, products, legalForm), jurisdiction: set.scope.jurisdiction } };
          const input = facts(variant);
          const opa = (await evaluateBusinessPolicy({ compiled, basis, facts: input })).result;
          const reference = evaluateDiligence(scopedSource.diligence!, businessPolicyInput({ basis, facts: input, configuration: set.configuration }));
          expect(opa, `${set.id} ${legalForm} ${products.join("+")} ${JSON.stringify(variant)} ${JSON.stringify(extra)}`).toEqual(reference);
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(1000);
  }, 300_000);
});

// ---- party roles and screening scope (Product Policy Studio phase G, finished) --------------

function rolePolicy(): BusinessPolicySource {
  const s = scopedPolicy();
  s.diligence!.roleRequirements = { UNDERLYING_INVESTOR: ["EVD-SOURCE-OF-FUNDS", "EVD-PEP-SCREENING"], AUTHORIZED_USER: ["EVD-CIP-IDENTITY-DOCUMENT"] };
  s.diligence!.screening = { sanctions: "EVD-SANCTIONS-SCREENING", pep: "EVD-PEP-SCREENING", adverse_media: "EVD-ADVERSE-MEDIA" };
  return s;
}
const roleSource = rolePolicy();
const runRoles = (s: Record<string, unknown>, f = facts()) =>
  evaluateDiligence(roleSource.diligence!, { gateId: "diligence-level", facts: f, observations: {}, configuration: CONFIGURATIONS.us!, scope: s });

describe("party roles and screening scope", () => {
  it("adds a related role's requirements, attributed to the role", () => {
    const own = runRoles(scope("individual", ["deposit"], "individual")).outputs!.diligence;
    const related = runRoles({ ...scope("individual", ["deposit"], "individual"), relatedProducts: [{ product: "BRK.PRIME.INSTITUTIONAL", role: "UNDERLYING_INVESTOR" }] }).outputs!.diligence;
    expect(related.level).toBe(own.level);
    expect(related.requirements).toEqual([...own.requirements, "EVD-SOURCE-OF-FUNDS"]);
    expect(related.requirementSources).toContainEqual({ requirement: "EVD-SOURCE-OF-FUNDS", from: ["diligence.role.UNDERLYING_INVESTOR"] });
    expect(related.requirementSources).toContainEqual({ requirement: "EVD-PEP-SCREENING", from: ["diligence.level.CDD", "diligence.role.UNDERLYING_INVESTOR"] });
  });

  it("leaves the decision unresolved for a role the block does not list", () => {
    const result = runRoles({ ...scope("individual", ["deposit"], "individual"), relatedProducts: [{ product: "PAY.CARDS", role: "COUNTERPARTY" }] });
    expect(result.state).toBe("UNRESOLVED");
    expect(result.gaps).toEqual([{ code: "DILIGENCE_ROLE_REQUIREMENTS_MISSING", path: "/scope/relatedProducts/PAY.CARDS", subjectId: null }]);
  });

  it("lists the screening types the requirements imply", () => {
    expect(runRoles(scope("individual", ["deposit"], "individual")).outputs!.diligence.screeningTypes).toEqual(["pep", "sanctions"]);
    expect(runRoles(scope("individual", ["deposit"], "individual"), facts({ pep: true })).outputs!.diligence.screeningTypes).toEqual(["adverse_media", "pep", "sanctions"]);
  });

  it("refuses a role outside the vocabulary", () => {
    const s = rolePolicy();
    (s.diligence!.roleRequirements as Record<string, string[]>).OWNER = ["EVD-SOURCE-OF-FUNDS"];
    expect(() => compileBusinessPolicy(s, { opaVersion: "1.9.0" })).toThrow();
  });

  it("decides role and screening cases exactly as the reference evaluation does, under OPA", async () => {
    const compiled = compileBusinessPolicy(roleSource, { opaVersion: "1.9.0" });
    const relatedSets = [undefined, [], [{ product: "BRK.PRIME.INSTITUTIONAL", role: "UNDERLYING_INVESTOR" }],
      [{ product: "PAY.CARDS", role: "AUTHORIZED_USER" }, { product: "BRK.RETAIL.CASH", role: "UNDERLYING_INVESTOR" }],
      [{ product: "PAY.CARDS", role: "COUNTERPARTY" }]];
    const variants: Facts[] = [{}, { pep: true }, { media: true }, { owners: 3 }];
    let compared = 0;
    for (const set of compiled.policySets) {
      const customerType = set.scope.customerTypes[0]!;
      const legalForm = customerType === "individual" ? "individual" : "corporation";
      for (const relatedProducts of relatedSets) for (const variant of variants) {
        const basis = { tenantId: "t", caseId: "c", planDigest: d, releaseDigest: d, caseSequence: 1, snapshotDigest: d, dependencyDigest: d,
          selectedInputDigest: d, effectivePolicySetDigest: set.setDigest, policyBundleDigest: compiled.manifest.bundleDigest, inputProfile: "canonical.onboarding.v2",
          gateId: "diligence-level", purpose: "CDD_ONBOARDING", subjectIds: [], proposerPrincipalIds: [], evaluatedAt: "2026-11-11T00:00:00Z", knowledgeCutoff: "2026-11-11T00:00:00Z",
          scope: { ...scope(customerType, [set.scope.products[0]!], legalForm), jurisdiction: set.scope.jurisdiction, ...(relatedProducts ? { relatedProducts } : {}) } } as BusinessDecisionBasis;
        const input = facts(variant);
        const opa = (await evaluateBusinessPolicy({ compiled, basis, facts: input })).result;
        const reference = evaluateDiligence(roleSource.diligence!, businessPolicyInput({ basis, facts: input, configuration: set.configuration }));
        expect(opa, `${set.id} ${JSON.stringify(relatedProducts)} ${JSON.stringify(variant)}`).toEqual(reference);
        compared++;
      }
    }
    expect(compared).toBeGreaterThan(80);
  }, 120_000);
});
