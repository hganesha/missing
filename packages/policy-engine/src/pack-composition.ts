/**
 * Pack layers and their tighten-only composition, browser-safe (no Node built-ins), so the Policy
 * Studio and its mock compute the effective policy the same way the packs compile
 * (Product Policy Studio phase E). `policy-packs.ts` adds digests and the effective packs.
 */
import { z } from "zod";
import { aliasLineage } from "@ehf/contracts/products";

// ---------------------------------------------------------------------------------------------
// Field rules

/**
 * How a field may change as layers compose. `min` / `max`: a numeric value may only go down / up.
 * `superset` / `subset`: a set may only grow / shrink. `fixed`: set once, never changed after.
 * `perKeyMin`: a map of numbers, each may only go down, and keys may be added. `ordered`: an enum
 * value may only move later in `order`. `trueWins`: a boolean may only become true.
 * `falseFixed`: must be false in every layer that sets it. `falseWins`: a boolean may only become false.
 * `perKeyLevelMax`: a map of ordered levels, each may only move later in `order`, and keys may be added.
 */
export type FieldRule =
  | { kind: "min" } | { kind: "max" } | { kind: "superset" } | { kind: "subset" } | { kind: "fixed" }
  | { kind: "perKeyMin" } | { kind: "ordered"; order: readonly string[] } | { kind: "trueWins" } | { kind: "falseFixed" }
  | { kind: "falseWins" } | { kind: "perKeyLevelMax"; order: readonly string[] };

const decimal = z.string().regex(/^(0(\.\d+)?|1(\.0+)?)$/, "policy_pack.decimal_invalid");
const stringSet = z.array(z.string().min(1)).max(64);
/** Due-diligence levels, lowest first. A floor may only raise the level a matrix cell gives. */
export const DILIGENCE_LEVEL_ORDER = ["SDD", "CDD", "EDD"] as const;
/**
 * `<customer type or *>:<product or *>`: the cases a floor covers. The product is a legacy id or a
 * taxonomy node, which covers every product beneath it.
 */
const floorKey = z.string().regex(/^(?:individual|corporate|\*):(?:[a-z0-9][a-z0-9_-]*|[A-Z][A-Z0-9_]{0,39}(?:\.[A-Z][A-Z0-9_]{0,39}){0,2}|\*)$/, "policy_pack.floor_key_invalid");

/**
 * Every field a pack may set. Fields read by library skills keep the library's names
 * (`policy_context_fields`); the rest are checkpoint and routing requirements.
 */
export const POLICY_PACK_FIELDS = {
  jurisdiction: { rule: { kind: "fixed" }, schema: z.string().regex(/^[A-Z]{2}$/), projected: true },
  screening_threshold: { rule: { kind: "min" }, schema: z.number().min(0).max(1), projected: true },
  ownership_threshold: { rule: { kind: "min" }, schema: decimal, projected: true },
  sanctions_ownership: { rule: { kind: "fixed" }, schema: z.object({ rule: z.enum(["ofac_50_percent"]), threshold: decimal }).strict(), projected: true },
  control_bases: { rule: { kind: "superset" }, schema: stringSet, projected: true },
  sanctions_control_bases: { rule: { kind: "superset" }, schema: stringSet, projected: true },
  verification_methods: { rule: { kind: "subset" }, schema: stringSet, projected: true },
  active_registry_statuses: { rule: { kind: "subset" }, schema: stringSet, projected: true },
  freshness_seconds: { rule: { kind: "perKeyMin" }, schema: z.record(z.string().min(1), z.number().int().positive()), projected: true },
  required_screening_types: { rule: { kind: "superset" }, schema: z.array(z.enum(["sanctions", "pep", "adverse_media", "watchlist"])), projected: false },
  required_screening_lists: { rule: { kind: "superset" }, schema: stringSet, projected: false },
  screening_roles: { rule: { kind: "superset" }, schema: stringSet, projected: false },
  pep_scope: { rule: { kind: "ordered", order: ["foreign", "foreign_and_international", "all"] }, schema: z.enum(["foreign", "foreign_and_international", "all"]), projected: false },
  // Per customer type; `trust` names a trust's own parties (a trust is served by the corporate packs).
  required_party_roles: { rule: { kind: "superset" }, schema: z.partialRecord(z.enum(["individual", "corporate", "trust"]), stringSet), projected: false },
  dual_control_required: { rule: { kind: "trueWins" }, schema: z.boolean(), projected: false },
  automatic_approval_enabled: { rule: { kind: "falseFixed" }, schema: z.boolean(), projected: false },
  /**
   * The one carve-out from "no approval without a person": a case the checkpoints find low risk
   * (every screen complete and clear, no PEP, no open material contradiction, every agent task
   * complete, every risk factor at or below `low_risk_max_factor_score`) may be approved by the
   * disposition gate. Granted by the layer that sets it; a layer above may only withdraw it.
   */
  automatic_approval_low_risk: { rule: { kind: "falseWins" }, schema: z.boolean(), projected: false },
  low_risk_max_factor_score: { rule: { kind: "min" }, schema: decimal, projected: false },
  automatic_decline_enabled: { rule: { kind: "falseFixed" }, schema: z.boolean(), projected: false },
  diligence_floors: { rule: { kind: "perKeyLevelMax", order: DILIGENCE_LEVEL_ORDER }, schema: z.record(floorKey, z.enum(DILIGENCE_LEVEL_ORDER)), projected: false },
  mandatory_overlays: { rule: { kind: "superset" }, schema: stringSet, projected: false },
  simplified_due_diligence_permitted: { rule: { kind: "falseWins" }, schema: z.boolean(), projected: false },
} as const satisfies Record<string, { rule: FieldRule; schema: z.ZodType; projected: boolean }>;
export type PolicyPackField = keyof typeof POLICY_PACK_FIELDS;
export const FIELD_NAMES = Object.keys(POLICY_PACK_FIELDS) as PolicyPackField[];

// ---------------------------------------------------------------------------------------------
// Sources

const basisSchema = z.object({
  text: z.string().min(1).max(1000),
  sources: z.array(z.string().url()).max(10).default([]),
}).strict();

export const policyPackLayerSchema = z.object({
  apiVersion: z.literal("harness.factory/policy-pack-layer-v1"),
  kind: z.literal("PolicyPackLayer"),
  metadata: z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/).max(120),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    layer: z.enum(["baseline", "jurisdiction", "institution", "business_line", "product"]),
    /** The scope a layer applies to; a baseline applies everywhere. */
    appliesTo: z.object({
      jurisdictions: z.array(z.string().regex(/^[A-Z]{2}$/)).optional(),
      institutions: z.array(z.string().min(1)).optional(),
      /** Business lines of the institution catalog (`business_line` layers name at least one). */
      businessLines: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]*$/)).optional(),
      /**
       * Products: a legacy product id (`deposit`) or any node of the product taxonomy
       * (`PAY`, `PAY.CARDS`). A node covers every product beneath it.
       */
      products: z.array(z.string().min(1)).optional(),
    }).strict().default({}),
    status: z.enum(["CANDIDATE", "APPROVED", "RETIRED"]),
    ownerRole: z.string().min(1),
    description: z.string().min(1),
  }).strict(),
  /** Each value with the reason it has this value. */
  values: z.record(z.string(), z.object({ value: z.unknown(), basis: basisSchema }).strict()),
  /** Compiled OPA decision-table bundles this layer binds its gates to, by policy id and digest. */
  gateBundles: z.record(z.string(), z.object({ policyId: z.string().min(1), bundleDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).default({}),
  /** Where the platform's mechanics cannot express this layer exactly, stated rather than hidden. */
  knownDifferences: z.array(z.object({ field: z.string().min(1), text: z.string().min(1) }).strict()).default([]),
}).strict().superRefine((layer, ctx) => {
  const to = layer.metadata.appliesTo;
  if (layer.metadata.layer === "business_line" && !to.businessLines?.length) ctx.addIssue({ code: "custom", message: "policy_pack.business_line_unscoped" });
  if (layer.metadata.layer !== "business_line" && to.businessLines) ctx.addIssue({ code: "custom", message: "policy_pack.business_lines_misplaced" });
  if (layer.metadata.layer !== "product" && to.products) ctx.addIssue({ code: "custom", message: "policy_pack.products_misplaced" });
  for (const [field, entry] of Object.entries(layer.values)) {
    const spec = POLICY_PACK_FIELDS[field as PolicyPackField];
    if (!spec) { ctx.addIssue({ code: "custom", message: `policy_pack.field_unknown:${field}` }); continue; }
    if (!spec.schema.safeParse(entry.value).success) ctx.addIssue({ code: "custom", message: `policy_pack.value_invalid:${field}` });
  }
});
export type PolicyPackLayer = z.infer<typeof policyPackLayerSchema>;

export const policyPackSelectionSchema = z.object({
  apiVersion: z.literal("harness.factory/policy-pack-selection-v1"),
  kind: z.literal("PolicyPackSelection"),
  packs: z.array(z.object({
    jurisdiction: z.string().regex(/^[A-Z]{2}$/),
    institution: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
    /** A named product set, e.g. `business-banking`; the pack covers a case whose products are all in it. */
    productSet: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    /** The institution's business line this set belongs to, when a `business_line` layer should apply. */
    businessLine: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
    products: z.array(z.string().min(1)).min(1),
    customerTypes: z.array(z.enum(["individual", "corporate"])).min(1),
  }).strict()).min(1),
}).strict();
export type PolicyPackSelection = z.infer<typeof policyPackSelectionSchema>;

// ---------------------------------------------------------------------------------------------
// Composition

export type EffectivePolicyPack = {
  apiVersion: "harness.factory/policy-pack-v1";
  kind: "EffectivePolicyPack";
  id: string;
  version: string;
  status: "CANDIDATE" | "APPROVED";
  scope: { jurisdiction: string; institution: string; businessLine?: string; productSet: string; products: string[]; customerTypes: Array<"individual" | "corporate"> };
  layers: Array<{ id: string; version: string; layer: string; digest: string }>;
  values: Partial<Record<PolicyPackField, unknown>>;
  /** Which layer set each value, and why. */
  basis: Partial<Record<PolicyPackField, { layer: string; text: string; sources: string[] }>>;
  gateBundles: Record<string, { policyId: string; bundleDigest: string }>;
  knownDifferences: Array<{ layer: string; field: string; text: string }>;
  digest: string;
};

export class PolicyPackError extends Error {}

/** Canonical JSON: object keys sorted, so equal values compare and digest equal. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const asNumber = (value: unknown) => (typeof value === "string" ? Number(value) : (value as number));

/** Whether `next` may replace `previous` for `field` (it must not loosen). */
export function tightens(field: PolicyPackField, previous: unknown, next: unknown): boolean {
  const rule = POLICY_PACK_FIELDS[field].rule as FieldRule;
  switch (rule.kind) {
    case "min": return asNumber(next) <= asNumber(previous);
    case "max": return asNumber(next) >= asNumber(previous);
    case "superset": {
      if (Array.isArray(previous)) return (previous as string[]).every((item) => (next as string[]).includes(item));
      return Object.entries(previous as Record<string, string[]>).every(([key, items]) => items.every((item) => ((next as Record<string, string[]>)[key] ?? []).includes(item)));
    }
    case "subset": return (next as string[]).every((item) => (previous as string[]).includes(item));
    case "fixed": return canonical(previous) === canonical(next);
    case "perKeyMin": return Object.entries(previous as Record<string, number>).every(([key, seconds]) => key in (next as object) && (next as Record<string, number>)[key]! <= seconds);
    case "ordered": return rule.order.indexOf(next as string) >= rule.order.indexOf(previous as string);
    case "trueWins": return previous !== true || next === true;
    case "falseFixed": return next === false;
    case "falseWins": return previous !== false || next === false;
    case "perKeyLevelMax": return Object.entries(previous as Record<string, string>).every(([key, level]) =>
      key in (next as object) && rule.order.indexOf((next as Record<string, string>)[key]!) >= rule.order.indexOf(level));
  }
}

type LayerScope = { jurisdiction: string; institution: string; businessLine?: string | undefined };

/** Whether a non-product layer applies to a scope (jurisdiction, institution, business line). */
function applies(layer: PolicyPackLayer, scope: LayerScope): boolean {
  const to = layer.metadata.appliesTo;
  if (layer.metadata.layer === "baseline") return true;
  if (to.jurisdictions && !to.jurisdictions.includes(scope.jurisdiction)) return false;
  if (to.institutions && !to.institutions.includes(scope.institution)) return false;
  if (to.businessLines && (!scope.businessLine || !to.businessLines.includes(scope.businessLine))) return false;
  return true;
}

/**
 * A product's lineage, most specific first: the product, then its taxonomy ancestors. A dotted
 * taxonomy id yields its prefixes (`PAY.CARDS.DEBIT`, `PAY.CARDS`, `PAY`); a legacy id yields
 * itself, then the lineage of the node `legacy` maps it to.
 */
export function productLineageOf(product: string, legacy: Readonly<Record<string, string>> = {}): string[] {
  return aliasLineage(product, legacy);
}
export type ProductLineage = (product: string) => string[];

/**
 * The node a product layer targets for a product: the most specific entry of the product's lineage
 * the layer names, with its rank (0 is the product itself). A product layer that names no products
 * applies to every product, as the most general target ("*").
 */
function productTarget(layer: PolicyPackLayer, scope: LayerScope, lineage: string[]): { target: string; rank: number } | null {
  if (layer.metadata.layer !== "product" || !applies(layer, scope)) return null;
  const named = layer.metadata.appliesTo.products;
  if (!named) return { target: "*", rank: lineage.length };
  const rank = lineage.findIndex((node) => named.includes(node));
  return rank < 0 ? null : { target: lineage[rank]!, rank };
}

/** The tightest of two values a field may hold (product layers merge order-independently). */
function tightest(field: PolicyPackField, a: unknown, b: unknown): unknown {
  const rule = POLICY_PACK_FIELDS[field].rule as FieldRule;
  switch (rule.kind) {
    case "min": return asNumber(b) < asNumber(a) ? b : a;
    case "max": return asNumber(b) > asNumber(a) ? b : a;
    case "superset": {
      if (Array.isArray(a)) return [...new Set([...(a as string[]), ...(b as string[])])].sort();
      const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])].sort();
      return Object.fromEntries(keys.map((key) => [key, [...new Set([...((a as Record<string, string[]>)[key] ?? []), ...((b as Record<string, string[]>)[key] ?? [])])].sort()]));
    }
    case "subset": return (a as string[]).filter((item) => (b as string[]).includes(item));
    case "fixed":
      if (canonical(a) !== canonical(b)) throw new PolicyPackError(`policy_pack.fixed_conflict:${field}`);
      return a;
    case "perKeyMin": {
      const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])].sort();
      return Object.fromEntries(keys.map((key) => [key, Math.min((a as Record<string, number>)[key] ?? Infinity, (b as Record<string, number>)[key] ?? Infinity)]));
    }
    case "ordered": return rule.order.indexOf(b as string) > rule.order.indexOf(a as string) ? b : a;
    case "trueWins": return a === true || b === true;
    case "falseFixed": return false;
    case "falseWins": return a !== false && b !== false;
    case "perKeyLevelMax": {
      const keys = [...new Set([...Object.keys(a as object), ...Object.keys(b as object)])].sort();
      const level = (map: unknown, key: string) => rule.order.indexOf((map as Record<string, string>)[key] ?? "");
      return Object.fromEntries(keys.map((key) => [key, level(b, key) > level(a, key) ? (b as Record<string, string>)[key] : (a as Record<string, string>)[key]]));
    }
  }
}

/** A set is stored sorted and unique, and a map by sorted keys, so an effective pack is canonical. */
export function normalized(field: PolicyPackField, value: unknown): unknown {
  const kind = (POLICY_PACK_FIELDS[field].rule as FieldRule).kind;
  if ((kind === "superset" || kind === "subset") && Array.isArray(value)) return [...new Set(value as string[])].sort();
  if (kind === "superset" && value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, [...new Set((value as Record<string, string[]>)[key])].sort()]));
  }
  if ((kind === "perKeyMin" || kind === "perKeyLevelMax") && value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, (value as Record<string, number>)[key]]));
  return value;
}

const SCOPE_LAYERS = ["baseline", "jurisdiction", "institution"] as const;

/** One layer as it applied to a scope: the taxonomy node a product layer targeted, if any. */
export type AppliedLayer = { layer: PolicyPackLayer; target: string | null };
type Setter = { layer: PolicyPackLayer; text: string; sources: string[] };

export type PolicyComposition = {
  /** Baseline, jurisdiction, institution and (when one applies) business line, in that order. */
  scoped: AppliedLayer[];
  /** Per product (sorted): its lineage and its product layers, most general first. */
  chains: Array<{ product: string; lineage: string[]; layers: AppliedLayer[] }>;
  /** Every applied layer once, in composition order. */
  chosen: PolicyPackLayer[];
  values: Partial<Record<PolicyPackField, unknown>>;
  basis: EffectivePolicyPack["basis"];
  /** The values before any product layer: what every product inherits. */
  institutionLevel: Partial<Record<PolicyPackField, unknown>>;
};

/**
 * Compose the layers for a scope and a set of products. The baseline, then exactly one
 * jurisdiction and one institution layer, then at most one business-line layer. Then, per product,
 * the product layers that target a node of its lineage, most general first (a layer for `PAY`,
 * then one for `PAY.CARDS`, then one for `card`): each may only tighten what the layers before it
 * set (`policy_pack.loosens:<layer>:<field>`), so a regulatory value is protected all the way down.
 * Products are then merged by their tightest values, so their order does not matter.
 */
export function composePolicyLayers(layers: PolicyPackLayer[], scope: LayerScope, products: string[], options: { lineage?: ProductLineage; where?: string } = {}): PolicyComposition {
  const lineageOf = options.lineage ?? ((product: string) => productLineageOf(product));
  const where = options.where ?? `${scope.jurisdiction}/${scope.institution}`;
  const live = layers.filter((layer) => layer.metadata.status !== "RETIRED");
  const scoped: AppliedLayer[] = SCOPE_LAYERS.map((kind) => {
    const matches = live.filter((layer) => layer.metadata.layer === kind && applies(layer, scope));
    if (matches.length > 1) throw new PolicyPackError(`policy_pack.layer_ambiguous:${kind}:${matches.map((m) => m.metadata.id).join(",")}`);
    if (matches.length === 0) throw new PolicyPackError(`policy_pack.layer_missing:${kind}:${where}`);
    return { layer: matches[0]!, target: null };
  });
  const lines = live.filter((layer) => layer.metadata.layer === "business_line" && applies(layer, scope));
  if (lines.length > 1) throw new PolicyPackError(`policy_pack.layer_ambiguous:business_line:${lines.map((m) => m.metadata.id).join(",")}`);
  if (lines[0]) scoped.push({ layer: lines[0], target: null });

  const chains = [...new Set(products)].sort().map((product) => {
    const lineage = lineageOf(product);
    const ranked = live.flatMap((layer) => { const hit = productTarget(layer, scope, lineage); return hit ? [{ layer, ...hit }] : []; });
    if (ranked.length === 0) throw new PolicyPackError(`policy_pack.layer_missing:product:${product}:${where}`);
    for (const entry of ranked) {
      const same = ranked.filter((other) => other.rank === entry.rank);
      if (same.length > 1) throw new PolicyPackError(`policy_pack.layer_ambiguous:product:${product}${entry.target === product ? "" : `:${entry.target}`}`);
    }
    ranked.sort((a, b) => b.rank - a.rank);
    return { product, lineage, layers: ranked.map(({ layer, target }) => ({ layer, target })) };
  });

  const values: Partial<Record<PolicyPackField, unknown>> = {};
  const basis: EffectivePolicyPack["basis"] = {};
  const check = (layer: PolicyPackLayer, field: PolicyPackField, base: Partial<Record<PolicyPackField, unknown>>, value: unknown) => {
    if (field in base && !tightens(field, base[field], value)) throw new PolicyPackError(`policy_pack.loosens:${layer.metadata.id}:${field}`);
    if (POLICY_PACK_FIELDS[field].rule.kind === "falseFixed" && value !== false) throw new PolicyPackError(`policy_pack.loosens:${layer.metadata.id}:${field}`);
  };
  for (const { layer } of scoped) {
    for (const [name, entryValue] of Object.entries(layer.values)) {
      const field = name as PolicyPackField;
      check(layer, field, values, entryValue.value);
      values[field] = entryValue.value;
      basis[field] = { layer: layer.metadata.id, text: entryValue.basis.text, sources: entryValue.basis.sources };
    }
  }
  const institutionLevel = { ...values };
  for (const chain of chains) {
    // The chain: each layer tightens what the more general layers before it set.
    const chainValues = { ...institutionLevel };
    const setters = new Map<PolicyPackField, Setter>();
    for (const { layer } of chain.layers) {
      for (const [name, entryValue] of Object.entries(layer.values)) {
        const field = name as PolicyPackField;
        check(layer, field, chainValues, entryValue.value);
        chainValues[field] = entryValue.value;
        setters.set(field, { layer, text: entryValue.basis.text, sources: entryValue.basis.sources });
      }
    }
    // Merged with the other products' chains by the tightest value.
    for (const [field, setter] of setters) {
      const value = chainValues[field];
      const merged = field in values && values[field] !== institutionLevel[field] ? tightest(field, values[field], value) : value;
      if (canonical(merged) !== canonical(values[field])) {
        const previous = basis[field];
        basis[field] = previous && previous.layer !== setter.layer.metadata.id && values[field] !== institutionLevel[field]
          ? { layer: `${previous.layer}+${setter.layer.metadata.id}`, text: `${previous.text} ${setter.text}`, sources: [...previous.sources, ...setter.sources] }
          : { layer: setter.layer.metadata.id, text: setter.text, sources: setter.sources };
      }
      values[field] = merged;
    }
  }
  const chosen: PolicyPackLayer[] = [];
  for (const { layer } of [...scoped, ...chains.flatMap((chain) => chain.layers)]) if (!chosen.includes(layer)) chosen.push(layer);
  return { scoped, chains, chosen, values, basis, institutionLevel };
}


/**
 * What stops a set of layers from composing: for every selected pack, the tighten-only refusal (a
 * loosened value, a missing or ambiguous layer, a jurisdiction mismatch), as `<pack>: <code>`. Empty
 * when every pack composes. The studio shows these while a layer is edited, and approval requires none.
 */
export function packCompositionProblems(layers: PolicyPackLayer[], selection: Pick<PolicyPackSelection, "packs">, options: { lineage?: ProductLineage } = {}): string[] {
  const problems: string[] = [];
  for (const entry of selection.packs) {
    const where = `${entry.jurisdiction}/${entry.institution}/${entry.productSet}`;
    try {
      const { values } = composePolicyLayers(layers, { jurisdiction: entry.jurisdiction, institution: entry.institution, ...(entry.businessLine ? { businessLine: entry.businessLine } : {}) },
        entry.products, { ...options, where });
      if (values.jurisdiction !== entry.jurisdiction) problems.push(`${where}: policy_pack.jurisdiction_mismatch:${entry.jurisdiction}`);
    } catch (error) {
      problems.push(`${where}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return [...new Set(problems)];
}

/** The repository's layers with a tenant's published revisions in their place (or added, for a new layer id). */
export function withLayerRevisions(layers: readonly PolicyPackLayer[], revisions: readonly PolicyPackLayer[]): PolicyPackLayer[] {
  const replaced = new Map(revisions.map((layer) => [layer.metadata.id, layer]));
  return [...layers.map((layer) => replaced.get(layer.metadata.id) ?? layer), ...revisions.filter((layer) => !layers.some((entry) => entry.metadata.id === layer.metadata.id))];
}
