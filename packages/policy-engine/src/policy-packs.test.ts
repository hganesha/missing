import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  casePolicyContextFromRelationship, composeEffectivePack, composePolicyLayers, evaluatePackGate, productLineageOf, PolicyPackError, policyPackLayerSchema, policyPackSelectionSchema,
  projectPackForSkill, selectPolicyPack, type EffectivePolicyPack, type PolicyPackLayer, type PolicyPackSelection,
} from "./policy-packs.js";

// Policy packs (agentic plan phase 2) on the repository's own sources and corpus heroes.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const yamlFiles = (dir: string): string[] => readdirSync(dir).sort().flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? yamlFiles(path) : name.endsWith(".yaml") ? [path] : [];
});
const layers = yamlFiles(join(root, "domains/policy/packs")).map((path) => policyPackLayerSchema.parse(parse(readFileSync(path, "utf8"))));
const selection = policyPackSelectionSchema.parse(parse(readFileSync(join(root, "domains/policy/selection.yaml"), "utf8")));
// As scripts/sync-policy-packs.mjs composes them: product layers inherit down the taxonomy.
const legacyMapping = (JSON.parse(readFileSync(join(root, "artifacts/products/taxonomy.json"), "utf8")) as { legacy: Record<string, string> }).legacy;
const onTaxonomy = { lineage: (product: string) => productLineageOf(product, legacyMapping) };
const packs = selection.packs.map((entry) => composeEffectivePack(layers, entry, onTaxonomy));
const pack = (id: string) => packs.find((item) => item.id === id)!;
const US_BUSINESS = "policy.pack.us.bank-synthetic.business-banking";
const GB_BUSINESS = "policy.pack.gb.bank-synthetic.business-banking";
const entry = (overrides: Partial<PolicyPackSelection["packs"][number]> = {}): PolicyPackSelection["packs"][number] =>
  ({ jurisdiction: "US", institution: "bank.synthetic", productSet: "test", products: ["deposit"], customerTypes: ["corporate"], ...overrides });
const withLayer = (id: string, change: (layer: PolicyPackLayer) => void) => layers.map((layer) => {
  if (layer.metadata.id !== id) return layer;
  const copy = structuredClone(layer);
  change(copy);
  return copy;
});
const refusal = (run: () => unknown) => { try { run(); return "composed"; } catch (error) { if (error instanceof PolicyPackError) return error.message; throw error; } };

type CorpusRecord = { object_type: string; id: string; data: Record<string, unknown>; observed_at: string };
const corpus = (party: string) => {
  const records: Record<string, CorpusRecord[]> = {};
  for (const line of readFileSync(join(root, `fixtures/context-corpus/parties/${party}/records.jsonl`), "utf8").split("\n").filter(Boolean)) {
    const record = JSON.parse(line) as CorpusRecord;
    (records[record.object_type] ??= []).push(record);
  }
  return records;
};
const pinned = (target: EffectivePolicyPack) => ({ policyId: target.id, policyBundleDigest: target.digest });

describe("composition", () => {
  it("composes the committed effective packs, byte for byte, with a basis for every value", () => {
    for (const item of packs) {
      expect(JSON.parse(readFileSync(join(root, `artifacts/policy/packs/${item.id}.json`), "utf8"))).toEqual(item);
      for (const field of Object.keys(item.values)) expect(item.basis[field as keyof typeof item.basis], `${item.id}:${field}`).toBeDefined();
      expect(item.status).toBe("CANDIDATE");
    }
    expect(packs.map((item) => item.id).sort()).toEqual(["policy.pack.au.bank-synthetic.business-banking", "policy.pack.au.bank-synthetic.personal-banking",
      GB_BUSINESS, "policy.pack.gb.bank-synthetic.personal-banking", US_BUSINESS, "policy.pack.us.bank-synthetic.personal-banking", "policy.pack.us.securities-synthetic.institutional-securities"]);
  });

  it("applies each jurisdiction's own requirements", () => {
    const us = pack(US_BUSINESS).values;
    const gb = pack(GB_BUSINESS).values;
    expect([us.jurisdiction, us.required_screening_lists, us.pep_scope]).toEqual(["US", ["ofac-sdn"], "foreign"]);
    expect([gb.jurisdiction, gb.required_screening_lists, gb.pep_scope]).toEqual(["GB", ["uk-sanctions"], "all"]);
    expect(gb.control_bases).toContain("significant_influence");
    const au = pack("policy.pack.au.bank-synthetic.business-banking").values;
    expect([au.jurisdiction, au.required_screening_lists, au.pep_scope, au.ownership_threshold]).toEqual(["AU", ["au-dfat-consolidated"], "all", "0.25"]);
    expect(pack(GB_BUSINESS).knownDifferences.map((difference) => difference.field)).toEqual(["ownership_threshold", "sanctions_ownership"]);
    // Institution appetite on top of both: PEP screening and dual control everywhere.
    for (const item of packs) expect([item.values.required_screening_types, item.values.dual_control_required]).toEqual([expect.arrayContaining(["sanctions", "pep"]), true]);
  });

  it("merges product layers by their tightest value, whatever their order", () => {
    const shuffled = composeEffectivePack([...layers].reverse(), selection.packs[1]!, onTaxonomy);
    expect(shuffled.digest).toBe(pack(US_BUSINESS).digest);
    // Lending tightens verification freshness; acquiring adds adverse media; payments adds attorneys.
    expect(pack(US_BUSINESS).values.freshness_seconds).toEqual({ VerificationRecord: 5184000, WatchlistEntry: 86400 });
    expect(pack(US_BUSINESS).values.required_screening_types).toEqual(["adverse_media", "pep", "sanctions"]);
    expect(pack(US_BUSINESS).values.screening_roles).toEqual(expect.arrayContaining(["attorney", "guarantor"]));
  });
});

describe("tighten-only", () => {
  const compose = (changed: PolicyPackLayer[]) => refusal(() => composeEffectivePack(changed, entry({ products: ["deposit", "lending"] })));
  it("refuses a layer that loosens any field", () => {
    expect(compose(withLayer("pack.institution.bank-synthetic", (l) => { l.values.screening_threshold!.value = 0.99; }))).toBe("policy_pack.loosens:pack.institution.bank-synthetic:screening_threshold");
    expect(compose(withLayer("pack.institution.bank-synthetic", (l) => { l.values.verification_methods!.value = ["government_id_document", "registry_extract", "self_declaration"]; })))
      .toBe("policy_pack.loosens:pack.institution.bank-synthetic:verification_methods");
    expect(compose(withLayer("pack.product.lending", (l) => { l.values.screening_roles!.value = ["customer"]; }))).toBe("policy_pack.loosens:pack.product.lending:screening_roles");
    expect(compose(withLayer("pack.product.lending", (l) => { l.values.freshness_seconds!.value = { WatchlistEntry: 172800, VerificationRecord: 5184000 }; })))
      .toBe("policy_pack.loosens:pack.product.lending:freshness_seconds");
    expect(compose(withLayer("pack.institution.bank-synthetic", (l) => { l.values.dual_control_required = { value: false, basis: { text: "x", sources: [] } }; }))).toBe("composed");
    expect(compose(withLayer("pack.product.deposit", (l) => { l.values.dual_control_required = { value: false, basis: { text: "x", sources: [] } }; }))).toBe("policy_pack.loosens:pack.product.deposit:dual_control_required");
  });

  it("lets diligence controls only tighten: floors rise, mandatory overlays grow, SDD can only be withdrawn", () => {
    const basis = { text: "x", sources: [] };
    expect(compose(withLayer("pack.product.lending", (l) => { l.values.simplified_due_diligence_permitted = { value: true, basis }; })))
      .toBe("policy_pack.loosens:pack.product.lending:simplified_due_diligence_permitted");
    expect(compose(withLayer("pack.institution.bank-synthetic", (l) => { l.values.mandatory_overlays = { value: [], basis }; })))
      .toBe("composed");
    const floors = withLayer("pack.jurisdiction.us", (l) => { l.values.diligence_floors = { value: { "corporate:payments": "EDD", "*:lending": "CDD" }, basis }; });
    expect(compose(floors)).toBe("composed");
    const lowered = floors.map((layer) => layer.metadata.id !== "pack.institution.bank-synthetic" ? layer
      : { ...layer, values: { ...layer.values, diligence_floors: { value: { "corporate:payments": "CDD", "*:lending": "EDD" }, basis } } });
    expect(compose(lowered)).toBe("policy_pack.loosens:pack.institution.bank-synthetic:diligence_floors");
    const dropped = floors.map((layer) => layer.metadata.id !== "pack.institution.bank-synthetic" ? layer
      : { ...layer, values: { ...layer.values, diligence_floors: { value: { "*:lending": "EDD" }, basis } } });
    expect(compose(dropped)).toBe("policy_pack.loosens:pack.institution.bank-synthetic:diligence_floors");
    const raisedByProduct = withLayer("pack.product.lending", (l) => { l.values.diligence_floors = { value: { "corporate:lending": "EDD" }, basis }; });
    expect(composeEffectivePack(raisedByProduct, entry({ products: ["deposit", "lending"] })).values.diligence_floors).toEqual({ "corporate:lending": "EDD" });
    expect(() => policyPackLayerSchema.parse({ ...layers[0], values: { diligence_floors: { value: { "trust:deposit": "EDD" }, basis } } })).toThrow("policy_pack.value_invalid:diligence_floors");
  });

  it("applies the UK's mandatory diligence overlays and the institution's SDD decision", () => {
    expect(pack(GB_BUSINESS).values).toMatchObject({ mandatory_overlays: ["overlay.high-risk-geography", "overlay.pep"], simplified_due_diligence_permitted: false, diligence_floors: {} });
    expect(pack(US_BUSINESS).values).toMatchObject({ mandatory_overlays: [], simplified_due_diligence_permitted: false });
    expect(pack(GB_BUSINESS).basis.mandatory_overlays?.sources).toContain("https://www.legislation.gov.uk/uksi/2017/692/regulation/35");
  });

  it("never lets a layer enable an automatic decision or change a fixed rule", () => {
    expect(compose(withLayer("pack.institution.bank-synthetic", (l) => { l.values.automatic_approval_enabled = { value: true, basis: { text: "x", sources: [] } }; })))
      .toBe("policy_pack.loosens:pack.institution.bank-synthetic:automatic_approval_enabled");
    expect(compose(withLayer("pack.institution.bank-synthetic", (l) => { l.values.jurisdiction = { value: "GB", basis: { text: "x", sources: [] } }; })))
      .toBe("policy_pack.loosens:pack.institution.bank-synthetic:jurisdiction");
  });

  it("lets a layer withdraw the low-risk carve-out or lower its ceiling, never grant or raise it", () => {
    const composed = (changed: PolicyPackLayer[]) => composeEffectivePack(changed, entry({ products: ["deposit", "lending"] }));
    expect(composed(layers).values).toMatchObject({ automatic_approval_low_risk: true, low_risk_max_factor_score: "0.20" });
    // A product layer may withdraw it; the tightest value (false) wins over the other products.
    expect(composed(withLayer("pack.product.lending", (l) => { l.values.automatic_approval_low_risk = { value: false, basis: { text: "x", sources: [] } }; }))
      .values.automatic_approval_low_risk).toBe(false);
    expect(composed(withLayer("pack.product.lending", (l) => { l.values.low_risk_max_factor_score = { value: "0.10", basis: { text: "x", sources: [] } }; }))
      .values.low_risk_max_factor_score).toBe("0.10");
    // Once withdrawn below, no layer above grants it again, and the ceiling only goes down.
    expect(compose(withLayer("pack.jurisdiction.us", (l) => { l.values.automatic_approval_low_risk = { value: false, basis: { text: "x", sources: [] } }; })))
      .toBe("policy_pack.loosens:pack.institution.bank-synthetic:automatic_approval_low_risk");
    expect(compose(withLayer("pack.product.lending", (l) => { l.values.low_risk_max_factor_score = { value: "0.50", basis: { text: "x", sources: [] } }; })))
      .toBe("policy_pack.loosens:pack.product.lending:low_risk_max_factor_score");
  });

  it("needs exactly one layer of each scope, and a layer for every product in the set", () => {
    expect(refusal(() => composeEffectivePack(layers, entry({ products: ["custody"] })))).toBe("policy_pack.layer_missing:product:custody:US/bank.synthetic/test");
    expect(refusal(() => composeEffectivePack(layers, entry({ institution: "bank.other" })))).toBe("policy_pack.layer_missing:institution:US/bank.other/test");
    const twoUs = [...layers, { ...structuredClone(layers.find((l) => l.metadata.id === "pack.jurisdiction.us")!), metadata: { ...layers.find((l) => l.metadata.id === "pack.jurisdiction.us")!.metadata, id: "pack.jurisdiction.us-2" } }];
    expect(refusal(() => composeEffectivePack(twoUs, entry()))).toContain("policy_pack.layer_ambiguous:jurisdiction");
  });

  it("rejects an unknown field or an invalid value in a layer", () => {
    const layer = structuredClone(layers[0]!) as unknown as { values: Record<string, unknown> };
    layer.values.made_up = { value: 1, basis: { text: "x" } };
    expect(policyPackLayerSchema.safeParse(layer).success).toBe(false);
    const bad = structuredClone(layers[0]!) as unknown as { values: Record<string, { value: unknown }> };
    bad.values.screening_threshold!.value = 2;
    expect(policyPackLayerSchema.safeParse(bad).success).toBe(false);
  });
});

describe("selection per case", () => {
  const relationship = (party: string) => corpus(party).BankingRelationship![0]!.data;
  it("reads jurisdiction, institution, products and customer type from the relationship", () => {
    expect(casePolicyContextFromRelationship(relationship("H04"))).toEqual({ jurisdiction: "US", institution: "bank.synthetic", products: ["deposit", "lending", "merchant_acquiring", "payments"], customerType: "corporate", legalForm: "corporation", legalArrangement: null });
    expect(casePolicyContextFromRelationship(relationship("H01"))).toMatchObject({ jurisdiction: "US", customerType: "individual" });
    // A trust is served by the corporate packs and flagged as a legal arrangement.
    expect(casePolicyContextFromRelationship(relationship("H12"))).toMatchObject({ customerType: "corporate", legalArrangement: "trust" });
  });

  it("selects exactly one pinned pack, across jurisdictions", () => {
    const h04 = casePolicyContextFromRelationship(relationship("H04"));
    expect(selectPolicyPack(packs, h04)).toMatchObject({ status: "selected", pack: { id: US_BUSINESS } });
    expect(selectPolicyPack(packs, { ...h04, jurisdiction: "GB" })).toMatchObject({ status: "selected", pack: { id: GB_BUSINESS } });
    const h01 = casePolicyContextFromRelationship(relationship("H01"));
    expect(selectPolicyPack(packs, h01)).toMatchObject({ status: "selected", pack: { id: "policy.pack.us.bank-synthetic.personal-banking" } });
  });

  it("lists the products the customer holds in another role apart from its own", () => {
    const data = structuredClone(relationship("H01")) as Record<string, unknown>;
    const products = data.products as Array<Record<string, unknown>>;
    data.productRoles = [{ entityId: data.customerEntityId, productId: products[1]!.productId, role: "AUTHORIZED_USER" }];
    const context = casePolicyContextFromRelationship(data);
    expect(context.products).toEqual(["deposit"]);
    expect(context.relatedProducts).toEqual([{ product: "card", role: "AUTHORIZED_USER" }]);
    // A related product that does not resolve stops the gate, as an own product would.
    products[1] = { productId: "x", offeringId: "unknown-offering" };
    (data.productRoles as Array<Record<string, unknown>>)[0]!.productId = "x";
    expect(casePolicyContextFromRelationship(data).unresolvedProducts).toEqual(["x"]);
  });

  it("stops for a person rather than guess: no pack, two packs, or a missing fact", () => {
    // H06 has correspondent and custody products no pinned pack covers.
    expect(selectPolicyPack(packs, casePolicyContextFromRelationship(relationship("H06"))).status).toBe("none");
    // A plan that pinned only the US packs cannot take a UK case.
    expect(selectPolicyPack(packs.filter((item) => item.scope.jurisdiction === "US"), { ...casePolicyContextFromRelationship(relationship("H04")), jurisdiction: "GB" }).status).toBe("none");
    const overlap = composeEffectivePack(layers, entry({ productSet: "deposit-only", products: ["deposit"] }));
    expect(selectPolicyPack([...packs, overlap], { jurisdiction: "US", institution: "bank.synthetic", products: ["deposit"], customerType: "corporate" }))
      .toMatchObject({ status: "ambiguous", candidates: expect.arrayContaining([US_BUSINESS, overlap.id]) });
    expect(selectPolicyPack(packs, { jurisdiction: "US", institution: null, products: ["deposit"], customerType: "corporate" }).status).toBe("context_incomplete");
  });
});

describe("skill projection", () => {
  it("projects only fields the pack sets, and never invents one", () => {
    const projected = projectPackForSkill(pack(US_BUSINESS), ["ownership_threshold", "control_bases", "permissions", "version", "edd_triggers"], { permissions: ["skill:ownership.ubo.resolve"] });
    expect(projected).toMatchObject({ policyRef: US_BUSINESS, bundleDigest: pack(US_BUSINESS).digest, unresolved: ["edd_triggers"],
      values: { ownership_threshold: "0.25", control_bases: ["appoint_board", "voting_majority"], permissions: ["skill:ownership.ubo.resolve"] } });
    // Checkpoint-only fields are not skill policy.
    expect(projectPackForSkill(pack(US_BUSINESS), ["required_screening_lists"]).unresolved).toEqual(["required_screening_lists"]);
  });

  it("reproduces production slice 1's candidate policy for the slice's products", () => {
    const slice = JSON.parse(readFileSync(join(root, "domains/kyb-screening/policy/slice-policy.json"), "utf8")) as Record<string, unknown>;
    const usDepositPayments = composeEffectivePack(layers, entry({ productSet: "slice", products: ["deposit", "payments"] }));
    const fields = ["jurisdiction", "screening_threshold", "ownership_threshold", "sanctions_ownership", "control_bases", "sanctions_control_bases", "verification_methods", "active_registry_statuses", "freshness_seconds"];
    const projected = projectPackForSkill(usDepositPayments, fields);
    expect(projected.unresolved).toEqual([]);
    // Same values; sets compare as sets (an effective pack stores them sorted).
    const asSet = (value: unknown) => (Array.isArray(value) ? [...value].sort() : value);
    for (const field of fields) expect(asSet(projected.values[field]), field).toEqual(asSet(slice[field]));
  });
});

describe("pack checkpoints on corpus heroes", () => {
  const h04 = corpus("H04");
  const input = (target: EffectivePolicyPack, records = h04) => ({ authority: pinned(target), customerType: "corporate" as const, records, asOf: "2026-09-30T00:00:00Z" });

  it("is UNKNOWN unless the case is pinned to exactly this pack", () => {
    expect(evaluatePackGate(pack(US_BUSINESS), "intake-ready", { ...input(pack(US_BUSINESS)), authority: pinned(pack(GB_BUSINESS)) })).toMatchObject({ outcome: "UNKNOWN", reasonCodes: ["POLICY_PACK_NOT_PINNED"] });
  });

  it("requires a trust's trustee instead of beneficial owners, and asks for no shareholding", () => {
    const target = pack(US_BUSINESS);
    expect((target.values.required_party_roles as Record<string, string[]>).trust).toEqual(["customer", "trustee"]);
    expect(target.values.screening_roles).toEqual(expect.arrayContaining(["trustee", "settlor", "protector", "beneficiary"]));
    const relationship = (roles: string[]) => ({ ...h04, BankingRelationship: [{ ...h04.BankingRelationship![0]!, data: { ...h04.BankingRelationship![0]!.data,
      parties: [{ entityId: h04.BankingRelationship![0]!.data.customerEntityId, role: "customer" }, ...roles.map((role, index) => ({ entityId: `party-${index}`, role }))] } }],
      OwnershipInterest: [], BeneficialOwner: [] });
    const trust = (roles: string[]) => ({ ...input(target, relationship(roles)), legalArrangement: "trust" as const });
    expect(evaluatePackGate(target, "intake-ready", trust(["settlor", "beneficiary"]))).toMatchObject({ outcome: "REVIEW", reasonCodes: ["PARTY_ROLE_MISSING:trustee"] });
    expect(evaluatePackGate(target, "intake-ready", trust(["trustee", "settlor"]))).toMatchObject({ outcome: "ALLOW" });
    expect(evaluatePackGate(target, "decision-ready", trust(["trustee", "settlor"])).reasonCodes).not.toContain("OWNERSHIP_UNRESOLVED");
    // The same parties for a company still need its beneficial owners and their ownership.
    expect(evaluatePackGate(target, "intake-ready", input(target, relationship(["trustee"])))).toMatchObject({ reasonCodes: ["PARTY_ROLE_MISSING:beneficial_owner"] });
  });

  it("allows intake when the relationship names the customer and its beneficial owners", () => {
    expect(evaluatePackGate(pack(US_BUSINESS), "intake-ready", input(pack(US_BUSINESS)))).toMatchObject({ outcome: "ALLOW", reasonCodes: [] });
  });

  it("allows decision-ready for H04, whose every subject is searched for every type its products require", () => {
    expect(evaluatePackGate(pack(US_BUSINESS), "decision-ready", input(pack(US_BUSINESS)))).toMatchObject({ outcome: "ALLOW", reasonCodes: [] });
  });

  it("holds decision-ready while a screening the pack requires is missing (H04 without its adverse-media searches, which its acquiring product requires)", () => {
    const withoutMedia = { ...h04, ScreeningExecution: (h04.ScreeningExecution ?? []).filter((record) => (record.data as { screening_type?: string }).screening_type !== "adverse_media") };
    const result = evaluatePackGate(pack(US_BUSINESS), "decision-ready", input(pack(US_BUSINESS), withoutMedia));
    expect(result.outcome).toBe("REVIEW");
    expect(result.reasonCodes).toEqual(["SCREENING_INCOMPLETE"]);
    expect((result.details.screeningGaps as string[]).every((gap) => gap.startsWith("adverse_media:"))).toBe(true);
  });

  it("allows decision-ready when every required screening is complete, current and on the required lists, in both jurisdictions", () => {
    for (const jurisdiction of ["US", "GB"] as const) {
      const target = composeEffectivePack(layers, entry({ jurisdiction, productSet: "deposit-payments", products: ["deposit", "payments"] }));
      expect(evaluatePackGate(target, "decision-ready", input(target)), jurisdiction).toMatchObject({ outcome: "ALLOW" });
    }
  });

  it("adds the screening types the diligence decision requires to the pack's", () => {
    const target = composeEffectivePack(layers, entry({ productSet: "deposit-payments", products: ["deposit", "payments"] }));
    // Without its adverse-media searches, H04 still meets the deposit-and-payments pack, which does not
    // ask for them; a decision that lists adverse media does.
    const records = { ...h04, ScreeningExecution: (h04.ScreeningExecution ?? []).filter((record) => record.data.screening_type !== "adverse_media") };
    expect(evaluatePackGate(target, "decision-ready", { ...input(target, records), facts: { screeningTypes: ["sanctions"] } }).outcome).toBe("ALLOW");
    const result = evaluatePackGate(target, "decision-ready", { ...input(target, records), facts: { screeningTypes: ["adverse_media", "sanctions"] } });
    expect(result).toMatchObject({ outcome: "REVIEW", reasonCodes: ["SCREENING_INCOMPLETE"] });
    expect(result.details.screeningTypes).toContain("adverse_media");
  });

  it("finds stale evidence and an unscreened subject", () => {
    const target = composeEffectivePack(layers, entry({ productSet: "deposit-payments", products: ["deposit", "payments"] }));
    expect(evaluatePackGate(target, "decision-ready", { ...input(target), asOf: "2027-06-30T00:00:00Z" }).reasonCodes).toContain("EVIDENCE_STALE");
    const executions = (h04.ScreeningExecution ?? []).filter((record) => record.data.subject !== "h04.entity.gareth");
    const result = evaluatePackGate(target, "decision-ready", input(target, { ...h04, ScreeningExecution: executions }));
    expect(result).toMatchObject({ outcome: "REVIEW", reasonCodes: ["SCREENING_INCOMPLETE"] });
    expect(result.details.screeningGaps).toEqual(expect.arrayContaining(["sanctions:h04.entity.gareth", "pep:h04.entity.gareth"]));
  });

  it("never decides a disposition automatically: a person decides, with dual control", () => {
    const target = composeEffectivePack(layers, entry({ productSet: "deposit-payments", products: ["deposit", "payments"] }));
    expect(evaluatePackGate(target, "disposition", input(target))).toMatchObject({ outcome: "REVIEW", reasonCodes: ["HUMAN_DECISION_REQUIRED"],
      details: { dualControlRequired: true, automaticApproval: false, automaticDecline: false } });
  });
});

// ---- inheritance down the product taxonomy (Product Policy Studio phase C) -----------------

describe("product layers on taxonomy nodes", () => {
  const LEGACY = { card: "PAY.CARDS", payments: "PAY", deposit: "DEP", merchant_acquiring: "PAY.MERCHANT_ACQUIRING" };
  const lineage = (product: string) => productLineageOf(product, LEGACY);
  const basis = { text: "x", sources: [] };
  const layer = (id: string, kind: PolicyPackLayer["metadata"]["layer"], appliesTo: PolicyPackLayer["metadata"]["appliesTo"], values: PolicyPackLayer["values"]): PolicyPackLayer =>
    policyPackLayerSchema.parse({ apiVersion: "harness.factory/policy-pack-layer-v1", kind: "PolicyPackLayer",
      metadata: { id, version: "1.0.0", layer: kind, appliesTo, status: "CANDIDATE", ownerRole: "owner", description: "test" }, values });
  const roles = (list: string[]) => ({ screening_roles: { value: list, basis } });
  // The synthetic bank's screening roles (institution layer), trust parties included.
  const base = ["customer", "beneficial_owner", "control_person", "director", "signatory", "trustee", "settlor", "protector", "beneficiary"];
  const family = layer("pack.family.pay", "product", { products: ["PAY"] }, { ...roles([...base, "attorney"]), screening_threshold: { value: 0.8, basis } });
  const cards = layer("pack.class.pay-cards", "product", { products: ["PAY.CARDS"] }, { screening_threshold: { value: 0.75, basis } });
  const card = layer("pack.product.card", "product", { products: ["card"] }, { screening_threshold: { value: 0.7, basis } });
  const others = layers.filter((entry) => entry.metadata.layer !== "product");
  const own = (product: string) => layer(`pack.product.${product}`, "product", { products: [product] }, {});

  it("gives each product its lineage, most specific first", () => {
    // A legacy type is its node, and each node is preceded by the legacy types that map to it.
    expect(lineage("card")).toEqual(["card", "PAY.CARDS", "payments", "PAY"]);
    expect(lineage("PAY.CARDS.DEBIT")).toEqual(["PAY.CARDS.DEBIT", "card", "PAY.CARDS", "payments", "PAY"]);
    expect(lineage("custody")).toEqual(["custody"]);
  });

  it("composes general to specific, each layer tightening the one above it", () => {
    const set = [...others, family, cards, card, own("deposit")];
    const composition = composePolicyLayers(set, { jurisdiction: "US", institution: "bank.synthetic" }, ["card", "deposit"], { lineage });
    expect(composition.chains.find((chain) => chain.product === "card")!.layers.map((applied) => [applied.layer.metadata.id, applied.target]))
      .toEqual([["pack.family.pay", "PAY"], ["pack.class.pay-cards", "PAY.CARDS"], ["pack.product.card", "card"]]);
    const pack = composeEffectivePack(set, entry({ products: ["card", "deposit"] }), { lineage });
    expect(pack.values).toMatchObject({ screening_threshold: 0.7, screening_roles: [...base, "attorney"].sort() });
    expect(pack.basis.screening_threshold?.layer).toBe("pack.product.card");
    expect(pack.layers.map((entry) => entry.id).slice(-4)).toEqual(["pack.family.pay", "pack.class.pay-cards", "pack.product.card", "pack.product.deposit"]);
    // A family layer reaches every product beneath it; a product outside it is untouched.
    expect(composeEffectivePack([...others, family, own("payments"), own("deposit")], entry({ products: ["deposit", "payments"] }), { lineage }).values.screening_roles).toContain("attorney");
    expect(composeEffectivePack([...others, family, own("deposit")], entry({ products: ["deposit"] }), { lineage }).values.screening_roles).not.toContain("attorney");
  });

  it("refuses a lower node that loosens a higher one, and a regulatory value at any depth", () => {
    const loose = layer("pack.class.pay-cards", "product", { products: ["PAY.CARDS"] }, { screening_threshold: { value: 0.82, basis } });
    expect(refusal(() => composeEffectivePack([...others, family, loose, card], entry({ products: ["card"] }), { lineage }))).toBe("policy_pack.loosens:pack.class.pay-cards:screening_threshold");
    const dropped = layer("pack.product.card", "product", { products: ["card"] }, roles(base));
    expect(refusal(() => composeEffectivePack([...others, family, dropped], entry({ products: ["card"] }), { lineage }))).toBe("policy_pack.loosens:pack.product.card:screening_roles");
    // The UK's mandatory overlays are protected: no node below can drop one.
    const gbLoose = layer("pack.family.pay", "product", { products: ["PAY"] }, { mandatory_overlays: { value: ["overlay.pep"], basis } });
    expect(refusal(() => composeEffectivePack([...others, gbLoose, card], entry({ jurisdiction: "GB", products: ["card"] }), { lineage }))).toBe("policy_pack.loosens:pack.family.pay:mandatory_overlays");
    expect(refusal(() => composeEffectivePack([...others, layer("pack.class.x", "product", { products: ["PAY.CARDS"] }, { automatic_approval_enabled: { value: true, basis } }), card], entry({ products: ["card"] }), { lineage })))
      .toBe("policy_pack.loosens:pack.class.x:automatic_approval_enabled");
  });

  it("needs a product layer somewhere in the lineage, and one layer per node", () => {
    expect(composeEffectivePack([...others, family], entry({ products: ["card"] }), { lineage }).values.screening_threshold).toBe(0.8);
    expect(refusal(() => composeEffectivePack([...others, family], entry({ products: ["deposit"] }), { lineage }))).toBe("policy_pack.layer_missing:product:deposit:US/bank.synthetic/test");
    const twin = layer("pack.family.pay-2", "product", { products: ["PAY"] }, {});
    expect(refusal(() => composeEffectivePack([...others, family, twin, card], entry({ products: ["card"] }), { lineage }))).toBe("policy_pack.layer_ambiguous:product:card:PAY");
    // Without the legacy mapping a legacy id has no ancestors, as before phase C.
    expect(refusal(() => composeEffectivePack([...others, family], entry({ products: ["card"] })))).toBe("policy_pack.layer_missing:product:card:US/bank.synthetic/test");
  });

  it("applies a business-line layer between the institution and the products, only to its line", () => {
    const line = layer("pack.business-line.business-banking", "business_line", { institutions: ["bank.synthetic"], businessLines: ["business-banking"] }, { screening_threshold: { value: 0.8, basis } });
    const set = [...others, line, own("deposit")];
    const scoped = composeEffectivePack(set, entry({ businessLine: "business-banking" }), { lineage });
    expect(scoped).toMatchObject({ scope: { businessLine: "business-banking" }, values: { screening_threshold: 0.8 }, basis: { screening_threshold: { layer: "pack.business-line.business-banking" } } });
    expect(scoped.layers.map((entry) => entry.layer)).toEqual(["baseline", "jurisdiction", "institution", "business_line", "product"]);
    expect(composeEffectivePack(set, entry({ businessLine: "personal-banking" }), { lineage }).values.screening_threshold).toBe(0.85);
    expect(composeEffectivePack(set, entry(), { lineage }).scope).not.toHaveProperty("businessLine");
    const looser = layer("pack.business-line.business-banking", "business_line", { businessLines: ["business-banking"] }, { screening_threshold: { value: 0.9, basis } });
    expect(refusal(() => composeEffectivePack([...others, looser, own("deposit")], entry({ businessLine: "business-banking" }), { lineage }))).toBe("policy_pack.loosens:pack.business-line.business-banking:screening_threshold");
    // A product below the line may only tighten it.
    const product = layer("pack.product.deposit", "product", { products: ["deposit"] }, { screening_threshold: { value: 0.82, basis } });
    expect(refusal(() => composeEffectivePack([...others, line, product], entry({ businessLine: "business-banking" }), { lineage }))).toBe("policy_pack.loosens:pack.product.deposit:screening_threshold");
    expect(() => layer("x", "business_line", {}, {})).toThrow("policy_pack.business_line_unscoped");
    expect(() => layer("x", "institution", { products: ["PAY"] }, {})).toThrow("policy_pack.products_misplaced");
  });
});

describe("the repository's packs on the taxonomy", () => {
  it("compose exactly the committed effective packs, with the payments family inherited by cards and merchant acquiring", () => {
    for (const composed of packs) expect(`${JSON.stringify(composed, null, 2)}\n`).toBe(readFileSync(join(root, `artifacts/policy/packs/${composed.id}.json`), "utf8"));
    const personal = pack("policy.pack.us.bank-synthetic.personal-banking");
    expect(personal.layers.map((entry) => entry.id)).toContain("pack.product.family.pay");
    expect(personal.basis.screening_roles?.layer).toBe("pack.product.family.pay");
    expect(personal.values.screening_roles).toContain("attorney");
  });
});
