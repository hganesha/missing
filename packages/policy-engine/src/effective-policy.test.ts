import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { effectivePolicySchema } from "@ehf/contracts";
import { effectivePolicy } from "./effective-policy.js";
import { diligenceDesignSchema, projectDiligenceDesign } from "./diligence/schema.js";
import { policyPackLayerSchema, productLineageOf, type PolicyPackLayer } from "./policy-packs.js";

// The effective policy for one product (Product Policy Studio phase C), on the repository's packs.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const yamlFiles = (dir: string): string[] => readdirSync(dir).sort().flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? yamlFiles(path) : name.endsWith(".yaml") ? [path] : [];
});
const repoLayers = yamlFiles(join(root, "domains/policy/packs")).map((path) => policyPackLayerSchema.parse(parse(readFileSync(path, "utf8"))));
const LEGACY = (JSON.parse(readFileSync(join(root, "artifacts/products/taxonomy.json"), "utf8")) as { legacy: Record<string, string> }).legacy;
const lineage = (product: string) => productLineageOf(product, LEGACY);
const basis = { text: "Test basis.", sources: [] };
const layer = (id: string, kind: PolicyPackLayer["metadata"]["layer"], appliesTo: PolicyPackLayer["metadata"]["appliesTo"], values: PolicyPackLayer["values"]): PolicyPackLayer =>
  policyPackLayerSchema.parse({ apiVersion: "harness.factory/policy-pack-layer-v1", kind: "PolicyPackLayer",
    metadata: { id, version: "1.0.0", layer: kind, appliesTo, status: "CANDIDATE", ownerRole: "owner", description: "test" }, values });
const design = diligenceDesignSchema.parse(parse(readFileSync(join(root, "domains/policy/diligence/bank-synthetic.yaml"), "utf8")));
const sets = [{ scope: { products: ["card", "deposit", "lending", "merchant_acquiring", "payments"], customerTypes: ["individual", "corporate"] } }];
const block = projectDiligenceDesign(design, sets, LEGACY);
const diligence = { source: block, id: design.metadata.id, version: design.metadata.version, status: design.metadata.status };

describe("effective policy", () => {
  const nonProduct = repoLayers.filter((entry) => entry.metadata.layer !== "product");
  const family = layer("pack.family.pay", "product", { products: ["PAY"] }, { screening_threshold: { value: 0.8, basis }, diligence_floors: { value: { "*:PAY": "CDD" }, basis } });
  const card = layer("pack.product.card", "product", { products: ["card"] }, { screening_threshold: { value: 0.75, basis }, diligence_floors: { value: { "*:PAY": "CDD", "corporate:card": "EDD" }, basis } });
  const scope = { jurisdiction: "GB", institution: "bank.synthetic", product: "card", customerType: "corporate" as const, partyType: "company" };

  it("lists the inheritance trail from regulation down to the product", () => {
    const policy = effectivePolicy([...nonProduct, family, card], scope, { lineage, diligence });
    expect(effectivePolicySchema.parse(policy)).toEqual(policy);
    expect(policy.scope.lineage).toEqual(["card", "PAY.CARDS", "payments", "PAY"]);
    expect(policy.trail.map((entry) => [entry.layer, entry.id, entry.target])).toEqual([
      ["baseline", "pack.baseline", null], ["jurisdiction", "pack.jurisdiction.uk", null], ["institution", "pack.institution.bank-synthetic", null],
      ["product", "pack.family.pay", "PAY"], ["product", "pack.product.card", "card"]]);
  });

  it("says where each value was set and whether a lower layer may change it", () => {
    const controls = new Map(effectivePolicy([...nonProduct, family, card], scope, { lineage, diligence }).controls.map((entry) => [entry.controlId, entry]));
    // Set by the regulator: protected, and the history shows it.
    expect(controls.get("pack.mandatory_overlays")).toMatchObject({ status: "PROTECTED", source: { layer: "jurisdiction", id: "pack.jurisdiction.uk" } });
    expect(controls.get("pack.automatic_approval_enabled")).toMatchObject({ status: "PROTECTED", value: false });
    // Set by the institution: inherited.
    expect(controls.get("pack.dual_control_required")).toMatchObject({ status: "INHERITED", source: { layer: "institution" }, value: true });
    // Tightened for this product: modified, with every step of its history.
    expect(controls.get("pack.screening_threshold")).toMatchObject({ status: "MODIFIED", value: 0.75, source: { id: "pack.product.card", target: "card" },
      history: [{ id: "pack.baseline", value: 0.95 }, { id: "pack.institution.bank-synthetic", value: 0.85 }, { id: "pack.family.pay", value: 0.8 }, { id: "pack.product.card", value: 0.75 }].map((entry) => expect.objectContaining(entry)) });
    // Inherited from a family layer when the product sets nothing itself.
    const withoutCard = new Map(effectivePolicy([...nonProduct, family], scope, { lineage, diligence }).controls.map((entry) => [entry.controlId, entry]));
    expect(withoutCard.get("pack.screening_threshold")).toMatchObject({ status: "INHERITED", source: { id: "pack.family.pay", target: "PAY" } });
  });

  it("keeps the regulatory value beside a value a lower layer tightened", () => {
    const tighter = layer("pack.product.card", "product", { products: ["card"] }, { mandatory_overlays: { value: ["overlay.pep", "overlay.high-risk-geography", "overlay.complex-ownership"], basis } });
    const control = effectivePolicy([...nonProduct, tighter], scope, { lineage, diligence }).controls.find((entry) => entry.controlId === "pack.mandatory_overlays")!;
    expect(control).toMatchObject({ status: "MODIFIED", regulatoryValue: ["overlay.high-risk-geography", "overlay.pep"] });
  });

  it("adds the diligence cell, the floors that reach the product and every overlay", () => {
    const controls = new Map(effectivePolicy([...nonProduct, family, card], scope, { lineage, diligence }).controls.map((entry) => [entry.controlId, entry]));
    expect(controls.get("diligence.cell.company.card")).toMatchObject({ kind: "diligence_cell", value: "CDD", status: "MODIFIED", source: { layer: "diligence", target: "card" } });
    expect(controls.get("diligence.cell.company.card")!.evidence).toContain("EVD-BENEFICIAL-OWNERSHIP");
    // The card layer repeats the family's floor (a map may only grow): the family stays its origin.
    expect(controls.get("diligence.floor.*:PAY")).toMatchObject({ value: "CDD", status: "INHERITED", source: { id: "pack.family.pay", target: "PAY" } });
    expect(controls.get("diligence.floor.*:PAY")!.history.map((entry) => entry.id)).toEqual(["pack.family.pay", "pack.product.card"]);
    expect(controls.get("diligence.floor.corporate:card")).toMatchObject({ value: "EDD", status: "MODIFIED" });
    // The UK makes PEP and geography mandatory; adverse media is mandatory there too.
    expect(controls.get("overlay.pep")).toMatchObject({ status: "CONDITIONAL", enforced: true, source: { layer: "jurisdiction" } });
    expect(controls.get("overlay.high-transaction-risk")).toMatchObject({ status: "NOT_APPLICABLE", reason: "switched_off", enforced: false });
    // A rule's added requirements are its evidence; its approval is part of its value.
    const withEffects = structuredClone(block);
    withEffects.overlays.find((entry) => entry.id === "overlay.pep")!.effect = { escalateTo: "EDD", addRequirements: ["EVD-PUBLIC-SOURCE-RESEARCH"], requireApproval: { role: "Case.Reviewer", quorum: 2, reason: "PEP" } };
    const pep = effectivePolicy([...nonProduct, family, card], scope, { lineage, diligence: { ...diligence, source: withEffects } }).controls.find((entry) => entry.controlId === "overlay.pep")!;
    expect(pep).toMatchObject({ evidence: ["EVD-PUBLIC-SOURCE-RESEARCH"], value: { requireApproval: { role: "Case.Reviewer", quorum: 2 } } });
  });

  it("says why a scoped overlay does not apply, and when the product is outside the matrix", () => {
    const scoped = structuredClone(block);
    scoped.overlays.find((entry) => entry.id === "overlay.complex-ownership")!.appliesTo = { products: ["LND"] };
    scoped.overlays.find((entry) => entry.id === "overlay.pep")!.appliesTo = { partyTypes: ["individual"] };
    scoped.overlays.find((entry) => entry.id === "overlay.high-risk-geography")!.appliesTo = { jurisdictions: ["US"] };
    const controls = new Map(effectivePolicy([...nonProduct, family, card], scope, { lineage, diligence: { ...diligence, source: scoped } }).controls.map((entry) => [entry.controlId, entry]));
    expect(controls.get("overlay.complex-ownership")).toMatchObject({ status: "NOT_APPLICABLE", reason: "outside_products" });
    expect(controls.get("overlay.pep")).toMatchObject({ status: "NOT_APPLICABLE", reason: "outside_party_types" });
    expect(controls.get("overlay.high-risk-geography")).toMatchObject({ status: "NOT_APPLICABLE", reason: "outside_jurisdictions" });
    const custody = layer("pack.product.custody", "product", { products: ["CUS"] }, {});
    const outside = effectivePolicy([...nonProduct, custody], { ...scope, product: "custody" }, { lineage, diligence });
    expect(outside.controls.find((entry) => entry.kind === "diligence_cell")).toMatchObject({ status: "NOT_APPLICABLE", reason: "product_not_in_matrix", value: null });
    expect(() => effectivePolicy([...nonProduct, family], { ...scope, partyType: "pirate" }, { lineage, diligence })).toThrow("effective_policy.party_type_unknown:pirate");
  });

  it("agrees with the effective pack for a one-product set", async () => {
    const { composeEffectivePack } = await import("./policy-packs.js");
    const pack = composeEffectivePack([...nonProduct, family, card], { jurisdiction: "GB", institution: "bank.synthetic", productSet: "cards", products: ["card"], customerTypes: ["corporate"] }, { lineage });
    const policy = effectivePolicy([...nonProduct, family, card], scope, { lineage });
    expect(Object.fromEntries(policy.controls.map((entry) => [entry.controlId.slice("pack.".length), entry.value]))).toEqual(pack.values);
  });
});
