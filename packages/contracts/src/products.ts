import { z } from "zod";

/**
 * The canonical financial-services product taxonomy (Product Policy Studio plan, phase A).
 *
 * A product here is a regulated relationship that supplies facts to policy: what is provided,
 * under which regulated activities, to which parties, with which capabilities and risk
 * dimensions. It never carries a due-diligence decision. Browser-safe: zod only.
 *
 * Levels: L1 sector is a classification on each domain (a domain may serve several sectors).
 * L2 domain (`DEP`), L3 class (`DEP.TRANSACTION`) and L4 type (`DEP.TRANSACTION.BUSINESS_CHECKING`)
 * are platform-owned nodes whose dotted ids name their ancestors. L5 variants and L6 SKUs belong
 * to an institution's catalog (phase B) and point at an L2–L4 node.
 */

const text = z.string().min(1).max(2000);
const segment = "[A-Z][A-Z0-9_]{0,39}";
export const productIdSchema = z.string().regex(new RegExp(`^${segment}(?:\\.${segment}){0,2}$`), "product.id_invalid");
export type ProductId = z.infer<typeof productIdSchema>;

export const PRODUCT_SECTORS = ["BANKING", "SECURITIES", "CAPITAL_MARKETS", "ASSET_MANAGEMENT", "WEALTH", "INSURANCE", "PAYMENTS", "FINTECH", "DIGITAL_ASSETS", "OTHER"] as const;
export const productSectorSchema = z.enum(PRODUCT_SECTORS);

/** Regulated activities a product can involve; an institution's licences decide which apply. */
export const REGULATED_ACTIVITIES = [
  "DEPOSIT_TAKING", "LENDING", "PAYMENT_SERVICES", "MONEY_TRANSMISSION", "CARD_ISSUING", "MERCHANT_ACQUIRING", "FOREIGN_EXCHANGE",
  "TRADE_FINANCE", "SECURITIES_BROKERAGE", "SECURITIES_DEALING", "SECURITIES_FINANCING", "SECURITIES_CUSTODY", "CLEARING", "SETTLEMENT",
  "INVESTMENT_ADVICE", "PORTFOLIO_MANAGEMENT", "FUND_MANAGEMENT", "FUND_ADMINISTRATION", "TRANSFER_AGENCY", "TRUST_AND_FIDUCIARY",
  "UNDERWRITING", "CORPORATE_FINANCE", "INSURANCE_UNDERWRITING", "INSURANCE_DISTRIBUTION", "PENSION_ADMINISTRATION", "CORRESPONDENT_SERVICES",
  "VIRTUAL_ASSET_SERVICES", "E_MONEY_ISSUANCE", "CHECK_CASHING", "PRECIOUS_METALS_DEALING",
] as const;
export const regulatedActivitySchema = z.enum(REGULATED_ACTIVITIES);

/** Canonical party classifications a product may be offered to (policy party types map onto them). */
export const PRODUCT_PARTY_TYPES = ["INDIVIDUAL", "SOLE_PROPRIETOR", "LEGAL_ENTITY", "PARTNERSHIP", "TRUST", "INVESTMENT_FUND", "FINANCIAL_INSTITUTION", "GOVERNMENT", "NONPROFIT"] as const;
export const productPartyTypeSchema = z.enum(PRODUCT_PARTY_TYPES);

/** Inherent risk dimensions a product exposes; weights and thresholds are institution policy. */
export const RISK_DIMENSIONS = [
  "OWNERSHIP_COMPLEXITY", "GEOGRAPHIC_EXPOSURE", "CROSS_BORDER", "CASH_INTENSITY", "THIRD_PARTY_FUNDING", "LEVERAGE", "ANONYMITY",
  "VELOCITY", "INTERMEDIARY_RISK", "NESTED_ACCESS", "TRANSFERABILITY", "VALUE_CONCENTRATION", "TRADE_BASED_RISK", "NEW_TECHNOLOGY",
] as const;
export const riskDimensionSchema = z.enum(RISK_DIMENSIONS);

/** A capability is offered (`true`), not offered (`false`) or set per institution offering (`configurable`). */
const capabilityValue = z.union([z.boolean(), z.literal("configurable")]);
const capabilityKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

const nodeFields = {
  name: z.string().min(1).max(120),
  definition: text,
  aliases: z.array(z.string().min(1).max(120)).max(20).default([]),
  regulatedActivities: z.array(regulatedActivitySchema).max(10).default([]),
  eligiblePartyTypes: z.array(productPartyTypeSchema).max(9).default([]),
  capabilities: z.record(capabilityKey, capabilityValue).default({}),
  riskDimensions: z.array(riskDimensionSchema).max(14).default([]),
  /** Other classifications of the same product (a tokenised security is also a digital asset). */
  alsoClassifiedAs: z.array(productIdSchema).max(10).default([]),
  /** A bundle of other products rather than one instrument or service (private banking). */
  bundle: z.array(productIdSchema).max(20).default([]),
};

const typeSourceSchema = z.object({ code: z.string().regex(new RegExp(`^${segment}$`)), ...nodeFields }).strict();
const classSourceSchema = z.object({ code: z.string().regex(new RegExp(`^${segment}$`)), ...nodeFields, types: z.array(typeSourceSchema).max(60).default([]) }).strict();

/** One domain file in `domains/products/taxonomy`. Codes are relative; ids are composed. */
export const productDomainSourceSchema = z.object({
  apiVersion: z.literal("harness.factory/product-domain-v1"),
  kind: z.literal("ProductDomain"),
  metadata: z.object({ code: z.string().regex(new RegExp(`^${segment}$`)), version: z.string().regex(/^\d+\.\d+\.\d+$/), status: z.enum(["CANDIDATE", "APPROVED"]), owner: z.string().min(1) }).strict(),
  spec: z.object({ sectors: z.array(productSectorSchema).min(1).max(4), ...nodeFields, classes: z.array(classSourceSchema).min(1).max(60) }).strict(),
}).strict();
export type ProductDomainSource = z.infer<typeof productDomainSourceSchema>;

export const PRODUCT_ATTRIBUTE_GROUPS = [
  "identity", "institution", "eligibility", "regulatory", "jurisdiction", "structure", "ownership", "funding", "behaviour", "channel",
  "exposure", "intermediary", "asset", "risk", "monitoring", "lifecycle",
] as const;
/** A reusable, typed attribute that offerings and relationships carry (never extra product leaves). */
export const productAttributeDefinitionSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  group: z.enum(PRODUCT_ATTRIBUTE_GROUPS),
  name: z.string().min(1).max(120),
  description: text,
  type: z.enum(["string", "boolean", "number", "enum", "enum_list", "string_list", "date", "money"]),
  values: z.array(z.string().min(1).max(80)).max(60).optional(),
  /** Where the value comes from: the product definition, the institution offering or the case relationship. */
  setAt: z.enum(["product", "offering", "relationship"]),
}).strict().superRefine((value, ctx) => {
  if ((value.type === "enum" || value.type === "enum_list") !== Boolean(value.values?.length)) ctx.addIssue({ code: "custom", message: `product.attribute_values_mismatch:${value.id}` });
});
export type ProductAttributeDefinition = z.infer<typeof productAttributeDefinitionSchema>;

export const productAttributesSourceSchema = z.object({
  apiVersion: z.literal("harness.factory/product-attributes-v1"),
  kind: z.literal("ProductAttributes"),
  metadata: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), status: z.enum(["CANDIDATE", "APPROVED"]), owner: z.string().min(1) }).strict(),
  spec: z.object({ attributes: z.array(productAttributeDefinitionSchema).min(1).max(300) }).strict(),
}).strict();

/** How today's case `productType` values map onto the taxonomy (decision 2: additive, never replaced). */
export const legacyProductMappingSchema = z.object({
  apiVersion: z.literal("harness.factory/legacy-product-mapping-v1"),
  kind: z.literal("LegacyProductMapping"),
  metadata: z.object({ version: z.string().regex(/^\d+\.\d+\.\d+$/), status: z.enum(["CANDIDATE", "APPROVED"]), owner: z.string().min(1) }).strict(),
  spec: z.object({ mappings: z.array(z.object({ productType: z.string().min(1), productId: productIdSchema, basis: text }).strict()).min(1).max(100) }).strict(),
}).strict();

/** One compiled node with its level and ancestry; `sectors` are inherited from the domain. */
export const productNodeSchema = z.object({
  id: productIdSchema,
  level: z.enum(["domain", "class", "type"]),
  parent: productIdSchema.nullable(),
  ancestors: z.array(productIdSchema).max(2),
  sectors: z.array(productSectorSchema).min(1),
  ...nodeFields,
  children: z.array(productIdSchema),
}).strict();
export type ProductNode = z.infer<typeof productNodeSchema>;

export const productTaxonomySchema = z.object({
  apiVersion: z.literal("harness.factory/product-taxonomy-v1"),
  kind: z.literal("ProductTaxonomy"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  status: z.enum(["CANDIDATE", "APPROVED"]),
  domains: z.array(z.object({ code: z.string(), version: z.string(), status: z.enum(["CANDIDATE", "APPROVED"]), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()),
  nodes: z.array(productNodeSchema),
  attributes: z.array(productAttributeDefinitionSchema),
  legacy: z.record(z.string(), productIdSchema),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type ProductTaxonomy = z.infer<typeof productTaxonomySchema>;

/** The node itself and its ancestors, most general first: `BRK.PRIME.X` → `BRK`, `BRK.PRIME`, `BRK.PRIME.X`. */
export function productLineage(id: string): string[] {
  const parts = id.split(".");
  return parts.map((_, index) => parts.slice(0, index + 1).join("."));
}

/** Whether `id` is `scope` or sits under it in the taxonomy. */
export function productWithin(id: string, scope: string): boolean {
  return id === scope || id.startsWith(`${scope}.`);
}

// ---------------------------------------------------------------------------------------------
// Institution catalog (layer B, phase B): an institution's profile and its offerings (SKUs),
// each mapped onto a canonical product. Administered configuration with revisions in control-api.

const localId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/, "institution.id_invalid");
const country = z.string().regex(/^[A-Z]{2}$/, "institution.country_invalid");
export const REGULATORY_REGIMES = ["BANKING", "BROKER_DEALER", "INVESTMENT_ADVISER", "INSURER", "VASP", "MSB", "FUND_MANAGER", "TRUST_COMPANY"] as const;

export const institutionOfferingSchema = z.object({
  /** The institution's own product code (L6 SKU). */
  offeringId: localId,
  name: z.string().min(1).max(120),
  description: z.string().max(1000).default(""),
  canonicalProductId: productIdSchema,
  businessLine: localId,
  legalEntity: localId,
  jurisdictions: z.array(country).min(1).max(50),
  /** May only narrow what the canonical product allows. Empty means "as the canonical product". */
  eligiblePartyTypes: z.array(productPartyTypeSchema).max(9).default([]),
  /** Values of offering-level attributes (`setAt: offering`) that make this a variant (L5). */
  variantAttributes: z.record(z.string(), z.json()).default({}),
  /** Other offerings sold or serviced together with this one. */
  bundle: z.array(localId).max(20).default([]),
  /** Today's case `productType` values that mean this offering at this institution. */
  legacyProductTypes: z.array(z.string().min(1)).max(10).default([]),
  status: z.enum(["ACTIVE", "CLOSED_TO_NEW", "RETIRED"]).default("ACTIVE"),
}).strict();
export type InstitutionOffering = z.infer<typeof institutionOfferingSchema>;

export const institutionCatalogSchema = z.object({
  apiVersion: z.literal("harness.factory/institution-catalog-v1"),
  kind: z.literal("InstitutionCatalog"),
  institution: z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,79}$/),
    name: z.string().min(1).max(160),
    description: z.string().max(2000).default(""),
    synthetic: z.boolean().default(false),
    jurisdictions: z.array(country).min(1).max(50),
    legalEntities: z.array(z.object({
      id: localId, name: z.string().min(1).max(160), jurisdiction: country,
      regulatoryRegimes: z.array(z.enum(REGULATORY_REGIMES)).min(1).max(8),
      bookingEntity: z.boolean().default(true),
    }).strict()).min(1).max(50),
    businessLines: z.array(z.object({
      id: localId, name: z.string().min(1).max(120),
      /** Canonical nodes (any level) whose products this business line may offer. */
      productScope: z.array(productIdSchema).min(1).max(40),
    }).strict()).min(1).max(40),
  }).strict(),
  offerings: z.array(institutionOfferingSchema).max(500),
  /** The canonical taxonomy the catalog was written against. */
  taxonomy: z.object({ version: z.string(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
}).strict();
export type InstitutionCatalog = z.infer<typeof institutionCatalogSchema>;

/** The canonical eligibility of a node: its own list, or the nearest ancestor's; empty means unrestricted. */
export function effectiveEligibility(taxonomy: Pick<ProductTaxonomy, "nodes">, productId: string): string[] {
  const byId = new Map(taxonomy.nodes.map((node) => [node.id, node]));
  for (const id of productLineage(productId).reverse()) {
    const node = byId.get(id);
    if (node?.eligiblePartyTypes.length) return node.eligiblePartyTypes;
  }
  return [];
}

/**
 * Problems an approver must see resolved before a catalog can be approved: references that do
 * not resolve, offerings outside their business line, eligibility wider than the canonical product,
 * attributes that are not offering-level or not valid, and ambiguous legacy mappings.
 */
export function institutionCatalogProblems(catalog: InstitutionCatalog, taxonomy: Pick<ProductTaxonomy, "nodes" | "attributes" | "digest" | "version">): string[] {
  const problems: string[] = [];
  const nodes = new Set(taxonomy.nodes.map((node) => node.id));
  const entities = new Map(catalog.institution.legalEntities.map((entity) => [entity.id, entity]));
  const lines = new Map(catalog.institution.businessLines.map((line) => [line.id, line]));
  const attributes = new Map(taxonomy.attributes.map((attribute) => [attribute.id, attribute]));
  const unique = (values: string[], code: string) => { const seen = new Set<string>(); for (const value of values) { if (seen.has(value)) problems.push(`${code}:${value}`); seen.add(value); } };
  unique(catalog.institution.legalEntities.map((entity) => entity.id), "institution.legal_entity_duplicate");
  unique(catalog.institution.businessLines.map((line) => line.id), "institution.business_line_duplicate");
  unique(catalog.offerings.map((offering) => offering.offeringId), "institution.offering_duplicate");
  if (catalog.taxonomy.digest !== taxonomy.digest) problems.push(`institution.taxonomy_outdated:${catalog.taxonomy.version}`);
  for (const entity of catalog.institution.legalEntities) if (!catalog.institution.jurisdictions.includes(entity.jurisdiction)) problems.push(`institution.legal_entity_jurisdiction_outside:${entity.id}`);
  for (const line of catalog.institution.businessLines) for (const scope of line.productScope) if (!nodes.has(scope)) problems.push(`institution.business_line_scope_unknown:${line.id}:${scope}`);
  const legacy = new Map<string, string[]>();
  for (const offering of catalog.offerings) {
    const id = offering.offeringId;
    if (!nodes.has(offering.canonicalProductId)) problems.push(`institution.offering_product_unknown:${id}:${offering.canonicalProductId}`);
    const line = lines.get(offering.businessLine);
    if (!line) problems.push(`institution.offering_business_line_unknown:${id}:${offering.businessLine}`);
    else if (!line.productScope.some((scope) => productWithin(offering.canonicalProductId, scope))) problems.push(`institution.offering_outside_business_line:${id}:${offering.businessLine}`);
    if (!entities.has(offering.legalEntity)) problems.push(`institution.offering_legal_entity_unknown:${id}:${offering.legalEntity}`);
    for (const jurisdiction of offering.jurisdictions) if (!catalog.institution.jurisdictions.includes(jurisdiction)) problems.push(`institution.offering_jurisdiction_outside:${id}:${jurisdiction}`);
    const allowed = nodes.has(offering.canonicalProductId) ? effectiveEligibility(taxonomy, offering.canonicalProductId) : [];
    for (const party of offering.eligiblePartyTypes) if (allowed.length && !allowed.includes(party)) problems.push(`institution.offering_eligibility_wider:${id}:${party}`);
    for (const [key, value] of Object.entries(offering.variantAttributes)) {
      const attribute = attributes.get(key);
      if (!attribute) { problems.push(`institution.attribute_unknown:${id}:${key}`); continue; }
      if (attribute.setAt !== "offering") { problems.push(`institution.attribute_not_offering_level:${id}:${key}`); continue; }
      const valid = attribute.type === "boolean" ? typeof value === "boolean"
        : attribute.type === "number" ? typeof value === "number"
        : attribute.type === "enum" ? typeof value === "string" && (attribute.values ?? []).includes(value)
        : attribute.type === "enum_list" ? Array.isArray(value) && value.every((item) => typeof item === "string" && (attribute.values ?? []).includes(item))
        : attribute.type === "string_list" ? Array.isArray(value) && value.every((item) => typeof item === "string")
        : typeof value === "string";
      if (!valid) problems.push(`institution.attribute_value_invalid:${id}:${key}`);
    }
    for (const member of offering.bundle) if (member === id || !catalog.offerings.some((entry) => entry.offeringId === member)) problems.push(`institution.offering_bundle_invalid:${id}:${member}`);
    for (const productType of offering.legacyProductTypes) legacy.set(productType, [...(legacy.get(productType) ?? []), id]);
  }
  for (const [productType, ids] of legacy) if (ids.length > 1) problems.push(`institution.legacy_ambiguous:${productType}:${ids.join(",")}`);
  return problems;
}

export type ResolvedProduct = { canonicalProductId: string; offeringId: string | null; lineage: string[]; source: "offering" | "legacy_offering" | "taxonomy_legacy" };

/**
 * Resolve a case product to the canonical taxonomy: an exact offering id first, then the offering
 * the institution declared for a legacy `productType`, then the taxonomy's own legacy mapping.
 * Anything else stays unresolved (null), never defaulted.
 */
export function resolveCaseProduct(input: { offeringId?: string | null; productType?: string | null },
  catalog: Pick<InstitutionCatalog, "offerings"> | null, taxonomy: Pick<ProductTaxonomy, "legacy">): ResolvedProduct | null {
  const active = (catalog?.offerings ?? []).filter((offering) => offering.status !== "RETIRED");
  if (input.offeringId) {
    const offering = active.find((entry) => entry.offeringId === input.offeringId);
    return offering ? { canonicalProductId: offering.canonicalProductId, offeringId: offering.offeringId, lineage: productLineage(offering.canonicalProductId), source: "offering" } : null;
  }
  if (!input.productType) return null;
  const declared = active.filter((entry) => entry.legacyProductTypes.includes(input.productType!));
  if (declared.length === 1) return { canonicalProductId: declared[0]!.canonicalProductId, offeringId: declared[0]!.offeringId, lineage: productLineage(declared[0]!.canonicalProductId), source: "legacy_offering" };
  if (declared.length > 1) return null;
  const canonical = Object.hasOwn(taxonomy.legacy, input.productType) ? taxonomy.legacy[input.productType]! : null;
  return canonical ? { canonicalProductId: canonical, offeringId: null, lineage: productLineage(canonical), source: "taxonomy_legacy" } : null;
}

/**
 * A revision of an institution catalog held by the control API (phase B). Revisions are
 * append-only: a new draft supersedes any unpublished one, approval needs a second person and no
 * problems, and publishing supersedes the previously published revision.
 */
export const INSTITUTION_CATALOG_STATUSES = ["DRAFT", "APPROVED", "PUBLISHED", "SUPERSEDED"] as const;
export const institutionCatalogRevisionSummarySchema = z.object({
  institutionId: z.string(),
  revision: z.number().int().min(1),
  status: z.enum(INSTITUTION_CATALOG_STATUSES),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  taxonomyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  problems: z.array(z.string()),
  reason: z.string(),
  authoredBy: z.string(), authoredAt: z.string(),
  approvedBy: z.string().nullable(), approvedAt: z.string().nullable(),
  publishedBy: z.string().nullable(), publishedAt: z.string().nullable(),
}).strict();
export type InstitutionCatalogRevisionSummary = z.infer<typeof institutionCatalogRevisionSummarySchema>;
export const institutionCatalogRevisionSchema = institutionCatalogRevisionSummarySchema.extend({ catalog: institutionCatalogSchema }).strict();
export type InstitutionCatalogRevision = z.infer<typeof institutionCatalogRevisionSchema>;
export const saveInstitutionCatalogSchema = z.object({
  catalog: institutionCatalogSchema,
  /** The latest revision the author started from; 0 for an institution with none. */
  expectedRevision: z.number().int().min(0),
  reason: z.string().trim().min(3).max(500),
}).strict();
export const institutionCatalogDecisionSchema = z.object({ reason: z.string().trim().min(3).max(500) }).strict();

/**
 * The effective policy for one product (Product Policy Studio phase C): every control that applies,
 * where it was set, and whether a lower layer may change it. Computed by the policy engine, never
 * stored; the studio's inspector, coverage matrix and simulator read it.
 *
 * - PROTECTED: set by a regulatory layer (baseline or jurisdiction), or a value no layer may change;
 *   layers below may only tighten it.
 * - INHERITED: set above this product (institution, business line, or a product layer for an ancestor node).
 * - MODIFIED: set for this product itself (its own node or legacy id).
 * - CONDITIONAL: a diligence overlay that applies here and raises the level when its condition holds.
 * - NOT_APPLICABLE: a diligence overlay outside its scope or switched off (see `reason`).
 */
export const EFFECTIVE_CONTROL_STATUSES = ["PROTECTED", "INHERITED", "MODIFIED", "CONDITIONAL", "NOT_APPLICABLE"] as const;
const effectiveLayerSchema = z.object({
  layer: z.string(), id: z.string(), version: z.string(),
  /** The taxonomy node (or legacy id) a product layer or matrix column targets. */
  target: z.string().nullable(),
  status: z.string(),
}).strict();
export const effectiveControlSchema = z.object({
  controlId: z.string(),
  kind: z.enum(["pack_value", "diligence_cell", "diligence_floor", "diligence_overlay"]),
  label: z.string(),
  value: z.json(),
  status: z.enum(EFFECTIVE_CONTROL_STATUSES),
  source: effectiveLayerSchema.nullable(),
  basis: z.object({ text: z.string(), sources: z.array(z.string()) }).strict().nullable(),
  /** The regulatory value when a lower layer tightened it: no layer may loosen past it. */
  regulatoryValue: z.json().nullable(),
  /** Every layer that set this control, most general first. */
  history: z.array(z.object({ id: z.string(), layer: z.string(), target: z.string().nullable(), value: z.json() }).strict()),
  /** An overlay's condition (a business-policy predicate). */
  conditions: z.json().nullable(),
  /** Evidence obligations the control brings (a matrix cell: its level's requirements). */
  evidence: z.array(z.string()),
  /** Switched on by a pack layer: no layer below it can switch it off. */
  enforced: z.boolean(),
  /** Why a control does not apply: outside_products, outside_party_types, outside_jurisdictions, switched_off, product_not_in_matrix. */
  reason: z.string().nullable(),
  /** Layers carry no approval record yet; their status says CANDIDATE or APPROVED. */
  approvedBy: z.string().nullable(),
}).strict();
export type EffectiveControl = z.infer<typeof effectiveControlSchema>;
export const effectivePolicySchema = z.object({
  apiVersion: z.literal("harness.factory/effective-policy-v1"),
  scope: z.object({
    jurisdiction: z.string(), institution: z.string(), businessLine: z.string().nullable(), product: z.string(),
    /** The product's lineage, most specific first. */
    lineage: z.array(z.string()),
    customerType: z.enum(["individual", "corporate"]).nullable(), partyType: z.string().nullable(),
  }).strict(),
  /** The layers that apply, in composition order: the inheritance trail. */
  trail: z.array(effectiveLayerSchema),
  controls: z.array(effectiveControlSchema),
}).strict();
export type EffectivePolicy = z.infer<typeof effectivePolicySchema>;


/**
 * A party's role in one product of a relationship (Product Policy Studio phase G). The customer's
 * own products are CUSTOMER; an UNDERLYING_INVESTOR, COUNTERPARTY, INTERMEDIARY or AUTHORIZED_USER
 * relationship carries its own requirements and is not part of the customer's diligence scope.
 */
export const PARTY_PRODUCT_ROLES = ["CUSTOMER", "UNDERLYING_INVESTOR", "COUNTERPARTY", "INTERMEDIARY", "AUTHORIZED_USER"] as const;
export const partyProductRelationshipSchema = z.object({ entityId: z.string().min(1), productId: z.string().min(1), role: z.enum(PARTY_PRODUCT_ROLES) }).strict();
export type PartyProductRelationship = z.infer<typeof partyProductRelationshipSchema>;

export type RelationshipProduct = { productId: string; productType?: string | undefined; canonicalProductId?: string | undefined; offeringId?: string | undefined };
export type ProductResolution = {
  productId: string;
  /** The id policy scope uses: the legacy product type when there is one, else the canonical product. */
  policyProduct: string | null;
  canonicalProductId: string | null;
  offeringId: string | null;
  source: "product_type" | "canonical" | "offering" | "unresolved";
  /** The customer's role in this product. */
  role: (typeof PARTY_PRODUCT_ROLES)[number];
};

/**
 * The product resolver (phase G): each product of a relationship as policy sees it. A legacy
 * `productType` keeps today's scope id (its canonical product comes from the taxonomy); otherwise a
 * `canonicalProductId` is used as is; otherwise an `offeringId` resolves through the institution's
 * published catalog. Anything else is unresolved, never defaulted. Only the customer's own products
 * (role CUSTOMER) enter the customer's policy scope.
 */
export function resolveRelationshipProducts(input: {
  products: readonly RelationshipProduct[]; customerEntityId: string; productRoles?: readonly PartyProductRelationship[] | undefined;
}, catalog: Pick<InstitutionCatalog, "offerings"> | null, taxonomy: Pick<ProductTaxonomy, "legacy">): {
  resolutions: ProductResolution[]; policyProducts: string[]; unresolved: string[];
} {
  const roleOf = (productId: string): ProductResolution["role"] =>
    input.productRoles?.find((entry) => entry.productId === productId && entry.entityId === input.customerEntityId)?.role ?? "CUSTOMER";
  const resolutions = input.products.map((product): ProductResolution => {
    const role = roleOf(product.productId);
    if (product.productType) {
      const canonical = product.canonicalProductId ?? (Object.hasOwn(taxonomy.legacy, product.productType) ? taxonomy.legacy[product.productType]! : null);
      return { productId: product.productId, policyProduct: product.productType, canonicalProductId: canonical, offeringId: product.offeringId ?? null, source: "product_type", role };
    }
    if (product.canonicalProductId) return { productId: product.productId, policyProduct: product.canonicalProductId, canonicalProductId: product.canonicalProductId, offeringId: product.offeringId ?? null, source: "canonical", role };
    const resolved = product.offeringId ? resolveCaseProduct({ offeringId: product.offeringId }, catalog, taxonomy) : null;
    return resolved
      ? { productId: product.productId, policyProduct: resolved.canonicalProductId, canonicalProductId: resolved.canonicalProductId, offeringId: resolved.offeringId, source: "offering", role }
      : { productId: product.productId, policyProduct: null, canonicalProductId: null, offeringId: product.offeringId ?? null, source: "unresolved", role };
  });
  const own = resolutions.filter((entry) => entry.role === "CUSTOMER");
  return {
    resolutions,
    policyProducts: [...new Set(own.flatMap((entry) => entry.policyProduct ? [entry.policyProduct] : []))].sort(),
    unresolved: own.filter((entry) => entry.policyProduct === null).map((entry) => entry.productId),
  };
}

const isNode = (id: string) => /^[A-Z]/.test(id);

/**
 * A product's lineage with today's product types folded in, most specific first. A legacy type is
 * its taxonomy node (`card` is PAY.CARDS), and a node is preceded by the legacy types that map to it,
 * so `PAY.CARDS.DEBIT` reads PAY.CARDS.DEBIT, card, PAY.CARDS, payments, PAY. A debit card offering
 * therefore inherits whatever applies to `card`. An unmapped legacy id is its own lineage.
 */
export function aliasLineage(product: string, legacy: Readonly<Record<string, string>> = {}): string[] {
  const canonical = isNode(product) ? product : Object.hasOwn(legacy, product) ? legacy[product]! : null;
  if (!canonical) return [product];
  const aliasesOf = (node: string) => Object.keys(legacy).filter((id) => legacy[id] === node && id !== product).sort();
  const nodes = canonical.split(".").map((_, index, parts) => parts.slice(0, index + 1).join(".")).reverse();
  return [...(isNode(product) ? [] : [product]), ...nodes.flatMap((node) => [...aliasesOf(node), node])];
}

/**
 * Whether a scope product is covered by a set's products: the same id; a taxonomy node above it; or,
 * for a taxonomy id, the most specific legacy type it falls under (a debit card is covered by `card`,
 * but a merchant acquiring product is not covered by `payments` merely because both sit under PAY).
 */
export function productCovered(product: string, setProducts: readonly string[], legacy: Readonly<Record<string, string>> = {}): boolean {
  if (setProducts.includes(product)) return true;
  const lineage = aliasLineage(product, legacy);
  if (setProducts.some((entry) => isNode(entry) && lineage.includes(entry))) return true;
  if (!isNode(product)) return false;
  const equivalent = lineage.find((id) => !isNode(id));
  return equivalent !== undefined && setProducts.includes(equivalent);
}
