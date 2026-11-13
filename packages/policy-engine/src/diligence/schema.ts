import { z } from "zod";
import { aliasLineage } from "@ehf/contracts/products";

/**
 * The diligence block of a business policy: which customer due-diligence level each party type
 * and product start from, which risk overlays escalate it, and what each level requires.
 * Browser-safe: the Policy Studio mock and the engine read the same schema.
 */

const id = z.string().min(1).max(200);
export const DILIGENCE_GATE_ID = "diligence-level";
/** Input pointers a diligence block may read: the evaluated input, including the verified scope. */
export const diligencePointer = z.string().regex(/^\/(?:facts|configuration|observations|subjectIds|scope)(?:\/(?:[^~]|~[01])*)?$/, "policy.diligence_pointer_invalid");
const level = z.string().regex(/^[A-Z][A-Z0-9_]{0,31}$/, "policy.diligence_level_invalid");
const overlayId = id.regex(/^(?!diligence\.)[a-z0-9][a-z0-9._-]*$/, "policy.diligence_overlay_id_invalid");
const legacyProductId = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/);
const SEG = "[A-Z][A-Z0-9_]{0,39}";
const nodeId = z.string().regex(new RegExp(`^${SEG}(?:\\.${SEG}){0,2}$`), "policy.diligence_product_node_invalid");
/** A legacy product id (`deposit`) or a node of the product taxonomy (`PAY`, `PAY.CARDS`). */
const productId = z.union([legacyProductId, nodeId]);
const country = z.string().regex(/^[A-Z]{2}$/);
/** The roles in a product other than the customer's own (contracts PARTY_PRODUCT_ROLES). */
export const RELATED_PRODUCT_ROLES = ["UNDERLYING_INVESTOR", "COUNTERPARTY", "INTERMEDIARY", "AUTHORIZED_USER"] as const;
export const SCREENING_TYPES = ["sanctions", "pep", "adverse_media", "watchlist"] as const;
const partyId = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/);

export const diligenceOverlaySchema = z.object({
  id: overlayId,
  label: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  /** The institution's choice. A pack's `mandatory_overlays` switches an overlay on regardless. */
  enabled: z.boolean(),
  /**
   * Where the overlay applies. Products are legacy ids or taxonomy nodes (a node covers every
   * product beneath it). Outside its scope an overlay neither fires nor asks for its inputs.
   */
  appliesTo: z.object({
    products: z.array(productId).min(1).max(50).optional(),
    partyTypes: z.array(partyId).min(1).max(50).optional(),
    jurisdictions: z.array(country).min(1).max(50).optional(),
  }).strict().optional(),
  /** Inputs that must be present; a missing one leaves the level unresolved rather than lower. */
  requires: z.array(diligencePointer).min(1).max(20),
  /** A business-policy predicate (see `PolicyPredicate`), validated when the policy compiles. */
  when: z.record(z.string(), z.unknown()),
  /**
   * What the rule does when it fires. Every effect only adds: raise the level (to a level, or by
   * steps), add evidence obligations, or require a person's approval. None can lower a level,
   * remove a requirement, switch a control off or grant anything.
   */
  effect: z.object({
    escalateTo: level.optional(),
    escalateBy: z.number().int().min(1).max(5).optional(),
    addRequirements: z.array(id).min(1).max(50).optional(),
    /** One approval by people holding a platform role, enforced at the approval gate as NEEDS_HUMAN. */
    requireApproval: z.object({
      role: z.string().regex(/^[A-Z][A-Za-z]*\.[A-Z][A-Za-z]*$/, "policy.diligence_approval_role_invalid"),
      quorum: z.number().int().min(1).max(5),
      reason: z.string().min(1).max(500),
    }).strict().optional(),
  }).strict(),
}).strict();
export type DiligenceOverlay = z.infer<typeof diligenceOverlaySchema>;

export const diligenceSourceSchema = z.object({
  /** Lowest first. Every contributor can only raise the level. */
  levels: z.array(level).min(2).max(6),
  /** The level that needs `simplified_due_diligence_permitted`; it must be the lowest. */
  simplifiedLevel: level.optional(),
  gateId: id.default(DILIGENCE_GATE_ID),
  inputProfile: id,
  inputs: z.object({ legalForm: diligencePointer }).strict(),
  partyTypes: z.array(z.object({
    id: partyId, label: z.string().min(1).max(200),
    customerType: z.enum(["individual", "corporate"]),
    legalForms: z.array(id).min(1).max(50),
  }).strict()).min(1).max(50),
  /**
   * The matrix columns: legacy product ids or taxonomy nodes. A case product takes the most
   * specific column in its lineage (itself, then the node it maps to, then that node's ancestors).
   */
  products: z.array(productId).min(1).max(50),
  /** Legacy product id → the taxonomy node it maps to (from the taxonomy's legacy mapping). */
  productAliases: z.record(legacyProductId, nodeId).optional(),
  /** Party type → product → base level. Every cell is required. */
  matrix: z.record(partyId, z.record(productId, level)),
  overlays: z.array(diligenceOverlaySchema).max(50),
  /**
   * What a party in another role brings (phase G): a case's products the customer holds as an
   * underlying investor, counterparty, intermediary or authorised user add these obligations. A role
   * the block does not list leaves the decision unresolved rather than requiring nothing.
   */
  roleRequirements: z.partialRecord(z.enum(RELATED_PRODUCT_ROLES), z.array(id).max(200)).optional(),
  /** Screening type → the obligation that requires it: the decision lists the types its requirements imply. */
  screening: z.partialRecord(z.enum(SCREENING_TYPES), id).optional(),
  /**
   * The gate where approvals that rules require are enforced (default `disposition`): while any is
   * pending there, a decided result becomes a request for people with the approval roles.
   */
  approvalGateId: id.optional(),
  /** Level → the evidence obligations it requires; a higher level requires everything a lower one does. */
  requirements: z.record(level, z.array(id).max(200)),
}).strict().superRefine((v, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const unique = (values: string[]) => new Set(values).size === values.length;
  if (!unique(v.levels)) issue("policy.diligence_level_duplicate");
  if (v.simplifiedLevel !== undefined && v.simplifiedLevel !== v.levels[0]) issue("policy.diligence_simplified_level_not_lowest");
  if (!unique(v.partyTypes.map((party) => party.id))) issue("policy.diligence_party_type_duplicate");
  const forms = v.partyTypes.flatMap((party) => party.legalForms);
  if (!unique(forms)) issue("policy.diligence_legal_form_ambiguous");
  if (!unique(v.products)) issue("policy.diligence_product_duplicate");
  if (!unique(v.overlays.map((overlay) => overlay.id))) issue("policy.diligence_overlay_duplicate");
  for (const party of v.partyTypes) {
    const row = v.matrix[party.id];
    if (!row) { issue(`policy.diligence_matrix_row_missing:${party.id}`); continue; }
    for (const product of v.products) {
      const cell = row[product];
      if (cell === undefined) issue(`policy.diligence_matrix_cell_missing:${party.id}:${product}`);
      else if (!v.levels.includes(cell)) issue(`policy.diligence_matrix_level_unknown:${party.id}:${product}`);
    }
    for (const product of Object.keys(row)) if (!v.products.includes(product)) issue(`policy.diligence_matrix_product_unknown:${party.id}:${product}`);
  }
  for (const party of Object.keys(v.matrix)) if (!v.partyTypes.some((entry) => entry.id === party)) issue(`policy.diligence_matrix_party_type_unknown:${party}`);
  for (const overlay of v.overlays) {
    const effect = overlay.effect;
    if (Object.keys(effect).length === 0) issue(`policy.diligence_overlay_effect_empty:${overlay.id}`);
    if (effect.escalateTo !== undefined && effect.escalateBy !== undefined) issue(`policy.diligence_overlay_effect_conflict:${overlay.id}`);
    if (effect.addRequirements && !unique(effect.addRequirements)) issue(`policy.diligence_overlay_requirements_duplicate:${overlay.id}`);
    for (const party of overlay.appliesTo?.partyTypes ?? []) if (!v.partyTypes.some((entry) => entry.id === party)) issue(`policy.diligence_overlay_party_type_unknown:${overlay.id}:${party}`);
    if (effect.escalateTo !== undefined && !v.levels.includes(effect.escalateTo)) issue(`policy.diligence_overlay_level_unknown:${overlay.id}`);
    if (effect.escalateBy !== undefined && effect.escalateBy >= v.levels.length) issue(`policy.diligence_overlay_escalation_invalid:${overlay.id}`);
  }
  for (const key of Object.keys(v.requirements)) if (!v.levels.includes(key)) issue(`policy.diligence_requirements_level_unknown:${key}`);
  for (const [role, obligations] of Object.entries(v.roleRequirements ?? {})) if (!unique(obligations ?? [])) issue(`policy.diligence_role_requirements_duplicate:${role}`);
  v.levels.forEach((entry, index) => {
    const required = v.requirements[entry];
    if (!required) { issue(`policy.diligence_requirements_missing:${entry}`); return; }
    if (!unique(required)) issue(`policy.diligence_requirements_duplicate:${entry}`);
    const lower = index > 0 ? v.requirements[v.levels[index - 1]!] ?? [] : [];
    if (lower.some((obligation) => !required.includes(obligation))) issue(`policy.diligence_requirements_not_cumulative:${entry}`);
  });
});
export type DiligenceSource = z.infer<typeof diligenceSourceSchema>;

/** A JSON pointer as the array path OPA's `object.get` reads. */
export const pointerParts = (pointer: string) => pointer === "" ? [] : pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));

/** Whether any rule requires an approval, which makes the approval gate enforce them. */
export const requiresApprovals = (source: Pick<DiligenceSource, "overlays">) => source.overlays.some((overlay) => overlay.effect.requireApproval !== undefined);
/** The gate approvals are enforced at. */
export const approvalGateOf = (source: Pick<DiligenceSource, "approvalGateId">) => source.approvalGateId ?? "disposition";

/**
 * A case product's lineage, most specific first. A taxonomy node yields itself and its ancestors
 * (`PAY.CARDS.DEBIT`, `PAY.CARDS`, `PAY`); a legacy id yields itself, then the lineage of the node
 * its alias names. The Rego interpreter computes the same list.
 */
export function diligenceLineage(source: Pick<DiligenceSource, "productAliases">, product: string): string[] {
  return aliasLineage(product, source.productAliases ?? {});
}

/** The matrix column a case product takes: the most specific entry of its lineage, if any. */
export function diligenceColumn(source: Pick<DiligenceSource, "productAliases" | "products">, product: string): string | undefined {
  return diligenceLineage(source, product).find((node) => source.products.includes(node));
}

/** Precomputed paths the interpreter reads, kept beside the block in the bundle's data. */
export function diligenceIndex(source: DiligenceSource) {
  return {
    legalFormPath: pointerParts(source.inputs.legalForm),
    requires: Object.fromEntries(source.overlays.map((overlay) => [overlay.id, overlay.requires.map(pointerParts)])),
  };
}

/**
 * Checks against the policy sets the block serves: every product a set can hold has a column,
 * every customer type a set serves has a party type, and every overlay a pack makes mandatory
 * exists. A gap here would leave real cases without a level, so compilation refuses it.
 */
export function checkDiligenceCoverage(source: DiligenceSource, sets: Array<{ id: string; scope: { products: string[]; customerTypes: string[] }; configuration: Record<string, unknown> }>): string[] {
  const problems: string[] = [];
  for (const set of sets) {
    for (const product of set.scope.products) if (diligenceColumn(source, product) === undefined) problems.push(`policy.diligence_product_uncovered:${set.id}:${product}`);
    for (const type of set.scope.customerTypes) if (!source.partyTypes.some((party) => party.customerType === type)) problems.push(`policy.diligence_customer_type_uncovered:${set.id}:${type}`);
    const mandatory = set.configuration.mandatory_overlays;
    if (mandatory !== undefined && (!Array.isArray(mandatory) || mandatory.some((entry) => typeof entry !== "string"))) problems.push(`policy.diligence_mandatory_overlays_invalid:${set.id}`);
    else for (const overlay of (mandatory as string[] | undefined) ?? []) if (!source.overlays.some((entry) => entry.id === overlay)) problems.push(`policy.diligence_mandatory_overlay_unknown:${set.id}:${overlay}`);
    if (source.simplifiedLevel !== undefined && set.configuration.simplified_due_diligence_permitted === undefined) problems.push(`policy.diligence_sdd_permission_unset:${set.id}`);
  }
  return problems;
}

/** An institution's diligence design, from which each installation policy takes the part it serves. */
export const diligenceDesignSchema = z.object({
  apiVersion: z.literal("harness.factory/diligence-design-v1"),
  kind: z.literal("DiligenceDesign"),
  metadata: z.object({
    id: id, institution: id, version: z.string().regex(/^\d+\.\d+\.\d+$/),
    status: z.enum(["CANDIDATE", "APPROVED"]), ownerRole: id, description: z.string().min(1).max(1000),
  }).strict(),
  spec: diligenceSourceSchema,
}).strict();
export type DiligenceDesign = z.infer<typeof diligenceDesignSchema>;

/**
 * The design restricted to the customer types and products the policy's sets serve: the columns
 * some served product's lineage reaches, and the aliases of the served products. `aliases` (the
 * taxonomy's legacy mapping) adds to the design's own.
 */
export function projectDiligenceDesign(design: DiligenceDesign, sets: Array<{ scope: { products: string[]; customerTypes: string[] } }>, aliases: Readonly<Record<string, string>> = {}): DiligenceSource {
  const types = new Set(sets.flatMap((set) => set.scope.customerTypes));
  const wanted = [...new Set(sets.flatMap((set) => set.scope.products))].sort();
  const spec = design.spec;
  const allAliases = { ...aliases, ...spec.productAliases };
  const productAliases = Object.fromEntries(wanted.filter((product) => Object.hasOwn(allAliases, product)).map((product) => [product, allAliases[product]!]));
  // Columns a served product's lineage reaches, and columns beneath a served taxonomy node (a set
  // serving BRK keeps BRK.PRIME, since a prime brokerage case takes that column).
  const reached = new Set(wanted.flatMap((product) => diligenceLineage({ productAliases }, product)));
  for (const column of spec.products) if (wanted.some((product) => /^[A-Z]/.test(product) && column.startsWith(`${product}.`))) reached.add(column);
  const partyTypes = spec.partyTypes.filter((party) => types.has(party.customerType));
  const products = spec.products.filter((product) => reached.has(product));
  return diligenceSourceSchema.parse({
    ...spec, partyTypes, products, ...(Object.keys(productAliases).length ? { productAliases } : {}),
    matrix: Object.fromEntries(partyTypes.map((party) => [party.id, Object.fromEntries(products.map((product) => [product, spec.matrix[party.id]![product]!]))])),
  });
}
