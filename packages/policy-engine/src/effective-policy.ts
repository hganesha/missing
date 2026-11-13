import { effectivePolicySchema, type EffectiveControl, type EffectivePolicy } from "@ehf/contracts/products";
import { overlayInScope } from "./diligence/evaluate.js";
import { diligenceColumn, diligenceLineage, type DiligenceSource } from "./diligence/schema.js";
import {
  composePolicyLayers, normalized, POLICY_PACK_FIELDS, type AppliedLayer, type PolicyPackField, type PolicyPackLayer, type ProductLineage,
} from "./pack-composition.js";

/**
 * The effective policy for one product (Product Policy Studio phase C): the layers that apply to it,
 * general to specific, and every control they set, with the layer that set it, its status, basis and
 * history. With a diligence block and a party type it adds the matrix cell the product takes, the
 * floors that reach it and each overlay, applicable or not. Computed from the same composition the
 * effective packs use, so the inspector can never disagree with a released pack.
 */
export function effectivePolicy(
  layers: PolicyPackLayer[],
  scope: { jurisdiction: string; institution: string; businessLine?: string | undefined; product: string; customerType?: "individual" | "corporate" | undefined; partyType?: string | undefined },
  options: { lineage?: ProductLineage; diligence?: { source: DiligenceSource; id: string; version: string; status: string } } = {},
): EffectivePolicy {
  const composition = composePolicyLayers(layers, scope, [scope.product], options.lineage ? { lineage: options.lineage } : {});
  const chain = composition.chains[0]!;
  const trail: AppliedLayer[] = [...composition.scoped, ...chain.layers];
  const ref = ({ layer, target }: AppliedLayer) => ({ layer: layer.metadata.layer, id: layer.metadata.id, version: layer.metadata.version, target, status: layer.metadata.status });
  const statusOf = (applied: AppliedLayer, field?: PolicyPackField): EffectiveControl["status"] => {
    const rule = field ? POLICY_PACK_FIELDS[field].rule.kind : undefined;
    if (rule === "fixed" || rule === "falseFixed") return "PROTECTED";
    const kind = applied.layer.metadata.layer;
    if (kind === "baseline" || kind === "jurisdiction") return "PROTECTED";
    if (kind === "product" && applied.target === chain.lineage[0]) return "MODIFIED";
    return "INHERITED";
  };
  const regulatory = (applied: AppliedLayer) => applied.layer.metadata.layer === "baseline" || applied.layer.metadata.layer === "jurisdiction";
  const settersOf = (field: PolicyPackField) => trail.filter((applied) => Object.hasOwn(applied.layer.values, field));
  /**
   * The layer a value comes from: the last one that changed it. A lower layer that repeats a value
   * (as tighten-only sets and maps must) does not take it over.
   */
  const originOf = <T,>(setters: AppliedLayer[], valueOf: (applied: AppliedLayer) => T): AppliedLayer => {
    let origin = setters[0]!;
    for (let index = 1; index < setters.length; index++) if (canonical(valueOf(setters[index]!)) !== canonical(valueOf(setters[index - 1]!))) origin = setters[index]!;
    return origin;
  };
  const control = (fields: Omit<EffectiveControl, "regulatoryValue" | "conditions" | "evidence" | "enforced" | "reason" | "approvedBy"> & Partial<EffectiveControl>): EffectiveControl =>
    ({ regulatoryValue: null, conditions: null, evidence: [], enforced: false, reason: null, approvedBy: null, ...fields });

  const controls: EffectiveControl[] = [];
  for (const field of Object.keys(POLICY_PACK_FIELDS) as PolicyPackField[]) {
    if (!(field in composition.values)) continue;
    const setters = settersOf(field);
    const source = originOf(setters, (applied) => normalized(field, applied.layer.values[field]!.value));
    const lastRegulatory = [...setters].reverse().find(regulatory);
    const basis = source.layer.values[field]!.basis;
    controls.push(control({
      controlId: `pack.${field}`, kind: "pack_value", label: sentence(field), value: normalized(field, composition.values[field]) as EffectiveControl["value"],
      status: statusOf(source, field), source: ref(source), basis: { text: basis.text, sources: basis.sources },
      regulatoryValue: lastRegulatory && lastRegulatory !== source ? normalized(field, lastRegulatory.layer.values[field]!.value) as EffectiveControl["value"] : null,
      history: setters.map((applied) => ({ id: applied.layer.metadata.id, layer: applied.layer.metadata.layer, target: applied.target, value: normalized(field, applied.layer.values[field]!.value) as EffectiveControl["value"] })),
    }));
  }

  const diligence = options.diligence;
  if (diligence && scope.partyType) {
    const block = diligence.source;
    const party = block.partyTypes.find((entry) => entry.id === scope.partyType);
    if (!party) throw new Error(`effective_policy.party_type_unknown:${scope.partyType}`);
    const customerType = scope.customerType ?? party.customerType;
    const designRef = (target: string | null) => ({ layer: "diligence", id: diligence.id, version: diligence.version, target, status: diligence.status });
    const column = diligenceColumn(block, scope.product);
    if (column === undefined) {
      controls.push(control({ controlId: `diligence.cell.${party.id}`, kind: "diligence_cell", label: `Base level for ${party.label}`, value: null, status: "NOT_APPLICABLE",
        source: designRef(null), basis: null, history: [], reason: "product_not_in_matrix" }));
    } else {
      const level = block.matrix[party.id]![column]!;
      const own = column === scope.product || column === block.productAliases?.[scope.product];
      controls.push(control({ controlId: `diligence.cell.${party.id}.${column}`, kind: "diligence_cell", label: `Base level for ${party.label}`, value: level,
        status: own ? "MODIFIED" : "INHERITED", source: designRef(column), basis: null, history: [{ id: diligence.id, layer: "diligence", target: column, value: level }],
        evidence: block.requirements[level] ?? [] }));
    }
    // Floors: each key that reaches this product, with the layer that last set it.
    const floors = (composition.values.diligence_floors ?? {}) as Record<string, string>;
    const floorSetters = settersOf("diligence_floors");
    for (const node of [...diligenceLineage(block, scope.product), "*"]) for (const who of [customerType, "*"]) {
      const key = `${who}:${node}`;
      if (!Object.hasOwn(floors, key)) continue;
      const setters = floorSetters.filter((applied) => Object.hasOwn(applied.layer.values.diligence_floors!.value as object, key));
      const source = originOf(setters, (applied) => (applied.layer.values.diligence_floors!.value as Record<string, string>)[key]);
      const lastRegulatory = [...setters].reverse().find(regulatory);
      const basis = source.layer.values.diligence_floors!.basis;
      controls.push(control({ controlId: `diligence.floor.${key}`, kind: "diligence_floor", label: `Minimum level (${key})`, value: floors[key]!,
        status: statusOf(source), source: ref(source), basis: { text: basis.text, sources: basis.sources },
        regulatoryValue: lastRegulatory && lastRegulatory !== source ? (lastRegulatory.layer.values.diligence_floors!.value as Record<string, string>)[key]! : null,
        history: setters.map((applied) => ({ id: applied.layer.metadata.id, layer: applied.layer.metadata.layer, target: applied.target, value: (applied.layer.values.diligence_floors!.value as Record<string, string>)[key]! })) }));
    }
    // Overlays: applicable ones are conditional; the rest say why not.
    const mandatory = (composition.values.mandatory_overlays ?? []) as string[];
    const mandatorySetters = settersOf("mandatory_overlays");
    for (const overlay of block.overlays) {
      const enforcer = mandatory.includes(overlay.id) ? mandatorySetters.find((applied) => (applied.layer.values.mandatory_overlays!.value as string[]).includes(overlay.id)) : undefined;
      const to = overlay.appliesTo;
      const reason = !overlayInScope(block, { appliesTo: to?.products ? { products: to.products } : undefined }, { products: [scope.product], partyType: null, jurisdiction: null }) ? "outside_products"
        : to?.partyTypes && !to.partyTypes.includes(party.id) ? "outside_party_types"
        : to?.jurisdictions && !to.jurisdictions.includes(scope.jurisdiction) ? "outside_jurisdictions"
        : !overlay.enabled && !enforcer ? "switched_off" : null;
      const basis = enforcer?.layer.values.mandatory_overlays!.basis;
      controls.push(control({
        controlId: overlay.id, kind: "diligence_overlay", label: overlay.label, value: overlay.effect as EffectiveControl["value"],
        status: reason ? "NOT_APPLICABLE" : "CONDITIONAL", source: enforcer ? ref(enforcer) : designRef(null),
        basis: basis ? { text: basis.text, sources: basis.sources } : overlay.description ? { text: overlay.description, sources: [] } : null,
        history: [{ id: diligence.id, layer: "diligence", target: null, value: overlay.enabled }, ...(enforcer ? [{ id: enforcer.layer.metadata.id, layer: enforcer.layer.metadata.layer, target: enforcer.target, value: true }] : [])],
        conditions: overlay.when as EffectiveControl["conditions"], evidence: overlay.effect.addRequirements ?? [], enforced: Boolean(enforcer), reason,
      }));
    }
  }

  return effectivePolicySchema.parse({
    apiVersion: "harness.factory/effective-policy-v1",
    scope: { jurisdiction: scope.jurisdiction, institution: scope.institution, businessLine: scope.businessLine ?? null, product: scope.product, lineage: chain.lineage,
      customerType: scope.customerType ?? null, partyType: scope.partyType ?? null },
    trail: trail.map(ref),
    controls,
  });
}

const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) =>
  item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) : item);
const sentence = (field: string) => field.replaceAll("_", " ").replace(/^./, (first) => first.toUpperCase());
