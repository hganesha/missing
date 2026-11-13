import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  bankingProductSchema, effectiveEligibility, institutionCatalogProblems, institutionCatalogSchema, PRODUCT_PARTY_TYPES, productCovered, productLineage, productTaxonomySchema, productWithin,
  resolveCaseProduct, resolveRelationshipProducts,
} from "@ehf/contracts";
import { casePolicyContextFromRelationship } from "./policy-packs.js";
import { canonicalProductFor, compileProductTaxonomy, ProductTaxonomyError } from "./products.js";

const root = new URL("../../../domains/products/", import.meta.url);
const read = (name: string) => parse(readFileSync(new URL(name, root), "utf8"));
const domains = () => readdirSync(new URL("taxonomy/", root)).filter((name) => name.endsWith(".yaml")).sort().map((name) => read(`taxonomy/${name}`));
const sources = () => ({ version: "1.0.0", domains: domains(), attributes: read("attributes.yaml"), legacy: read("legacy-mapping.yaml"), legacyProductTypes: bankingProductSchema.options });
const refusal = (change: (input: ReturnType<typeof sources>) => void) => {
  const input = sources(); change(input);
  try { compileProductTaxonomy(input); return "compiled"; } catch (error) { if (error instanceof ProductTaxonomyError) return error.message; throw error; }
};

describe("canonical product taxonomy", () => {
  const taxonomy = compileProductTaxonomy(sources());

  it("compiles the committed seed byte for byte: 18 domains, 129 classes, types for six domains", () => {
    expect(`${JSON.stringify(taxonomy, null, 2)}\n`).toBe(readFileSync(new URL("../../../artifacts/products/taxonomy.json", import.meta.url), "utf8"));
    const count = (level: string) => taxonomy.nodes.filter((node) => node.level === level).length;
    expect([count("domain"), count("class")]).toEqual([18, 129]);
    expect([...new Set(taxonomy.nodes.filter((node) => node.level === "type").map((node) => node.ancestors[0]))].sort()).toEqual(["BRK", "CUS", "DEP", "LND", "PAY", "WLT"]);
    expect(taxonomy.status).toBe("CANDIDATE");
    expect(productTaxonomySchema.parse(taxonomy)).toEqual(taxonomy);
  });

  it("keeps ids, parents, ancestors and children consistent", () => {
    const byId = new Map(taxonomy.nodes.map((node) => [node.id, node]));
    for (const node of taxonomy.nodes) {
      expect(node.ancestors).toEqual(productLineage(node.id).slice(0, -1));
      expect(node.parent).toBe(node.ancestors.at(-1) ?? null);
      for (const child of node.children) expect(byId.get(child)?.parent).toBe(node.id);
      expect(node.sectors).toEqual(byId.get(productLineage(node.id)[0]!)!.sectors);
    }
    expect(byId.get("BRK.PRIME")).toMatchObject({ level: "class", capabilities: { margin_financing: true, securities_lending: true, custody: true },
      children: ["BRK.PRIME.INSTITUTIONAL", "BRK.PRIME.PRIME_CUSTODY", "BRK.PRIME.SYNTHETIC"] });
    expect(byId.get("WLT.PRIVATE_BANKING")!.bundle).toContain("BRK.RETAIL");
  });

  it("maps every legacy case product type, and nothing else", () => {
    expect(Object.keys(taxonomy.legacy).sort()).toEqual([...bankingProductSchema.options].sort());
    expect(canonicalProductFor(taxonomy, "custody")).toBe("CUS.SAFEKEEPING");
    expect(canonicalProductFor(taxonomy, "brokerage")).toBeNull();
  });

  it("answers scope by prefix ancestry", () => {
    expect(productLineage("BRK.PRIME.INSTITUTIONAL")).toEqual(["BRK", "BRK.PRIME", "BRK.PRIME.INSTITUTIONAL"]);
    expect(productWithin("BRK.PRIME.INSTITUTIONAL", "BRK")).toBe(true);
    expect(productWithin("BRK.PRIME", "BRK.PRIME")).toBe(true);
    expect(productWithin("BRK.PRIMEX", "BRK.PRIME")).toBe(false);
    expect(productWithin("BRK", "BRK.PRIME")).toBe(false);
  });

  it("refuses unknown references, duplicates and unmapped or invented legacy types", () => {
    expect(refusal((input) => { (input.domains[0] as any).spec.classes[0].alsoClassifiedAs = ["NOPE.X"]; })).toBe("product.reference_unknown:AMG.MUTUAL_FUNDS:NOPE.X");
    expect(refusal((input) => { const domain = input.domains[0] as any; domain.spec.classes.push(structuredClone(domain.spec.classes[0])); })).toBe("product.id_duplicate:AMG.MUTUAL_FUNDS");
    expect(refusal((input) => { (input.legacy as any).spec.mappings = (input.legacy as any).spec.mappings.filter((entry: any) => entry.productType !== "fbo"); })).toBe("product.legacy_unmapped:fbo");
    expect(refusal((input) => { (input.legacy as any).spec.mappings.push({ productType: "brokerage", productId: "BRK", basis: "x" }); })).toBe("product.legacy_type_unknown:brokerage");
    expect(refusal((input) => { (input.legacy as any).spec.mappings[0].productId = "DEP.NOWHERE"; })).toBe("product.legacy_target_unknown:deposit:DEP.NOWHERE");
    expect(() => compileProductTaxonomy({ ...sources(), domains: [{ ...(domains()[0] as object), spec: { ...(domains()[0] as any).spec, risk: "x" } }] })).toThrow();
  });
});

describe("institution catalogs", () => {
  const taxonomy = compileProductTaxonomy(sources());
  const seeds = JSON.parse(readFileSync(new URL("../../../artifacts/products/institutions.json", import.meta.url), "utf8")) as { catalogs: unknown[]; taxonomyDigest: string };
  const bank = () => institutionCatalogSchema.parse(structuredClone(seeds.catalogs.find((entry) => (entry as { institution: { id: string } }).institution.id === "bank.synthetic")));
  const securities = () => institutionCatalogSchema.parse(structuredClone(seeds.catalogs.find((entry) => (entry as { institution: { id: string } }).institution.id === "securities.synthetic")));

  it("ships two problem-free seeds stamped with the current taxonomy", () => {
    expect(seeds.taxonomyDigest).toBe(taxonomy.digest);
    expect(seeds.catalogs).toHaveLength(2);
    expect(institutionCatalogProblems(bank(), taxonomy)).toEqual([]);
    expect(institutionCatalogProblems(securities(), taxonomy)).toEqual([]);
  });

  it("reports every broken reference an approver must resolve", () => {
    const catalog = bank();
    const [checking, , , debit] = catalog.offerings;
    checking!.canonicalProductId = "DEP.NOPE";
    debit!.businessLine = "business-banking";
    debit!.canonicalProductId = "BRK.RETAIL.CASH";
    catalog.offerings[1]!.legalEntity = "nowhere";
    catalog.offerings[1]!.jurisdictions = ["FR"];
    catalog.offerings[2]!.variantAttributes = { leverage: "yes", fictional: true, product_complexity: "LOW" };
    catalog.offerings[4]!.bundle = ["business-checking", "missing"];
    catalog.offerings[5]!.legacyProductTypes = ["card"];
    catalog.taxonomy.digest = "0".repeat(64);
    expect(institutionCatalogProblems(catalog, taxonomy)).toEqual(expect.arrayContaining([
      "institution.taxonomy_outdated:1.0.0",
      "institution.offering_product_unknown:everyday-checking:DEP.NOPE",
      "institution.offering_outside_business_line:everyday-checking:personal-banking",
      "institution.offering_outside_business_line:debit-card:business-banking",
      "institution.offering_legal_entity_unknown:current-account-uk:nowhere",
      "institution.offering_jurisdiction_outside:current-account-uk:FR",
      "institution.attribute_value_invalid:saver-plus:leverage",
      "institution.attribute_unknown:saver-plus:fictional",
      "institution.offering_bundle_invalid:business-checking:business-checking",
      "institution.offering_bundle_invalid:business-checking:missing",
      "institution.legacy_ambiguous:card:debit-card,business-term-loan",
    ]));
  });

  it("refuses eligibility wider than the canonical product allows", () => {
    const catalog = securities();
    const prime = catalog.offerings.find((offering) => offering.offeringId === "prime-brokerage")!;
    const allowed = effectiveEligibility(taxonomy, prime.canonicalProductId);
    expect(allowed.length).toBeGreaterThan(0);
    const outside = PRODUCT_PARTY_TYPES.find((party) => !allowed.includes(party))!;
    prime.eligiblePartyTypes = [...prime.eligiblePartyTypes, outside];
    expect(institutionCatalogProblems(catalog, taxonomy)).toEqual([`institution.offering_eligibility_wider:prime-brokerage:${outside}`]);
  });

  it("resolves a case product: offering id, then the institution's legacy offering, then the taxonomy", () => {
    const catalog = bank();
    expect(resolveCaseProduct({ offeringId: "business-term-loan" }, catalog, taxonomy)).toEqual({
      canonicalProductId: "LND.SMALL_BUSINESS.TERM_LOAN", offeringId: "business-term-loan", lineage: ["LND", "LND.SMALL_BUSINESS", "LND.SMALL_BUSINESS.TERM_LOAN"], source: "offering" });
    expect(resolveCaseProduct({ productType: "card" }, catalog, taxonomy)).toMatchObject({ canonicalProductId: "PAY.CARDS.DEBIT", offeringId: "debit-card", source: "legacy_offering" });
    expect(resolveCaseProduct({ productType: "deposit" }, catalog, taxonomy)).toMatchObject({ canonicalProductId: canonicalProductFor(taxonomy, "deposit"), offeringId: null, source: "taxonomy_legacy" });
    expect(resolveCaseProduct({ productType: "deposit" }, null, taxonomy)?.source).toBe("taxonomy_legacy");
    expect(resolveCaseProduct({ offeringId: "nope" }, catalog, taxonomy)).toBeNull();
    expect(resolveCaseProduct({ productType: "nope" }, catalog, taxonomy)).toBeNull();
    expect(resolveCaseProduct({}, catalog, taxonomy)).toBeNull();
    catalog.offerings.find((offering) => offering.offeringId === "debit-card")!.status = "RETIRED";
    expect(resolveCaseProduct({ offeringId: "debit-card" }, catalog, taxonomy)).toBeNull();
    expect(resolveCaseProduct({ productType: "card" }, catalog, taxonomy)?.source).toBe("taxonomy_legacy");
  });
});

describe("product resolver", () => {
  const taxonomy = compileProductTaxonomy(sources());
  const seeds = JSON.parse(readFileSync(new URL("../../../artifacts/products/institutions.json", import.meta.url), "utf8")) as { catalogs: unknown[] };
  const securities = institutionCatalogSchema.parse(seeds.catalogs.find((entry) => (entry as { institution: { id: string } }).institution.id === "securities.synthetic"));

  it("keeps today's product types as the policy scope, with their canonical products", () => {
    const resolved = resolveRelationshipProducts({ customerEntityId: "c", products: [{ productId: "p1", productType: "card" }, { productId: "p2", productType: "deposit" }] }, null, taxonomy);
    expect(resolved.policyProducts).toEqual(["card", "deposit"]);
    expect(resolved.resolutions.map((entry) => [entry.canonicalProductId, entry.source])).toEqual([["PAY.CARDS", "product_type"], ["DEP", "product_type"]]);
  });

  it("resolves a canonical product as given and an offering through the institution's catalog", () => {
    const resolved = resolveRelationshipProducts({ customerEntityId: "c", products: [
      { productId: "p1", offeringId: "prime-brokerage" }, { productId: "p2", canonicalProductId: "CUS.SAFEKEEPING.INSTITUTIONAL_CUSTODY" }] }, securities, taxonomy);
    expect(resolved).toMatchObject({ policyProducts: ["BRK.PRIME.INSTITUTIONAL", "CUS.SAFEKEEPING.INSTITUTIONAL_CUSTODY"], unresolved: [] });
    expect(resolved.resolutions[0]).toMatchObject({ source: "offering", offeringId: "prime-brokerage", canonicalProductId: "BRK.PRIME.INSTITUTIONAL" });
  });

  it("leaves an unknown offering unresolved, and keeps other parties' products out of the customer's scope", () => {
    const products = [{ productId: "p1", offeringId: "cash-brokerage" }, { productId: "p2", offeringId: "no-such-offering" }, { productId: "p3", offeringId: "managed-portfolios" }];
    const resolved = resolveRelationshipProducts({ customerEntityId: "c", products, productRoles: [{ entityId: "c", productId: "p3", role: "UNDERLYING_INVESTOR" }] }, securities, taxonomy);
    expect(resolved).toMatchObject({ policyProducts: ["BRK.RETAIL.CASH"], unresolved: ["p2"] });
    expect(resolved.resolutions.find((entry) => entry.productId === "p3")).toMatchObject({ role: "UNDERLYING_INVESTOR", canonicalProductId: "WLT.WEALTH_MANAGEMENT.DISCRETIONARY" });
    // Without the institution's catalog an offering cannot resolve.
    expect(resolveRelationshipProducts({ customerEntityId: "c", products: [products[0]!] }, null, taxonomy).unresolved).toEqual(["p1"]);
  });

  it("covers a taxonomy product by the legacy type it falls under, and only that one", () => {
    const legacy = taxonomy.legacy;
    expect(productCovered("PAY.CARDS.DEBIT", ["card", "deposit", "payments"], legacy)).toBe(true);
    expect(productCovered("DEP.TRANSACTION.PERSONAL_CHECKING", ["card", "deposit", "payments"], legacy)).toBe(true);
    // Merchant acquiring has its own legacy type: a set that only names payments does not cover it.
    expect(productCovered("PAY.MERCHANT_ACQUIRING.CARD_ACQUIRING", ["card", "deposit", "payments"], legacy)).toBe(false);
    expect(productCovered("PAY.MERCHANT_ACQUIRING.CARD_ACQUIRING", ["deposit", "lending", "merchant_acquiring", "payments"], legacy)).toBe(true);
    // A legacy type stays exact, as before.
    expect(productCovered("merchant_acquiring", ["payments"], legacy)).toBe(false);
    expect(productCovered("PAY.CARDS.DEBIT", ["card"])).toBe(false);
  });

  it("covers a product by a taxonomy node in a set's scope, never by a sibling or a legacy id's prefix", () => {
    expect(productCovered("BRK.PRIME.INSTITUTIONAL", ["BRK", "CUS"])).toBe(true);
    expect(productCovered("BRK.PRIME.INSTITUTIONAL", ["BRK.RETAIL"])).toBe(false);
    expect(productCovered("card", ["card", "deposit"])).toBe(true);
    expect(productCovered("cards", ["card"])).toBe(false);
  });

  it("reads a securities relationship into the case policy context", () => {
    const relationship = { policyJurisdiction: "US", institutionId: "securities.synthetic", customerEntityId: "fund-1",
      entities: [{ entityId: "fund-1", legalForm: "fund" }], products: [{ productId: "p1", offeringId: "prime-brokerage" }, { productId: "p2", offeringId: "unknown-sku" }] };
    expect(casePolicyContextFromRelationship(relationship, { catalog: securities, legacy: taxonomy.legacy })).toMatchObject({
      jurisdiction: "US", institution: "securities.synthetic", customerType: "corporate", legalForm: "fund", products: ["BRK.PRIME.INSTITUTIONAL"], unresolvedProducts: ["p2"] });
    // A bank relationship reads exactly as before the resolver.
    expect(casePolicyContextFromRelationship({ products: [{ productId: "a", productType: "card" }] })).toEqual({ jurisdiction: null, institution: null, products: ["card"], customerType: null, legalForm: null, legalArrangement: null });
  });
});
