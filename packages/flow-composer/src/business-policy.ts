import { syntheticGates } from "./gate-rules.js";
import { POLICY_PACK_FIELDS, INSTALLATION_CONTENT_SCHEMA_VERSION, compileBusinessPolicy, DERIVABLE_CONTENT_FIELDS, projectDiligenceDesign,
  type DiligenceDesign, type EffectivePolicyPack, type BusinessPolicySource } from "@ehf/policy-engine";

type SyntheticField = { value: unknown; basis: string };
type SyntheticFields = { fields: Record<string, SyntheticField> };
/** domains/policy/synthetic-installation-content.yaml, parsed: SYNTHETIC placeholder policy content. */
export type SyntheticContent = {
  label: "SYNTHETIC"; owner: string; customerTypes: Record<string, SyntheticFields>;
  jurisdictionOverrides?: Record<string, Record<string, SyntheticFields>>;
  /** Per due-diligence level (simplified, enhanced), replacing fields such as the review interval. */
  dueDiligenceOverrides?: Record<string, SyntheticFields>;
};
type DueDiligence = "simplified" | "standard" | "enhanced";
/**
 * The institutions' diligence designs (domains/policy/diligence) and the taxonomy's legacy mapping
 * (artifacts/products/taxonomy.json), so the policy carries the institution's diligence block.
 */
export type DiligenceInputs = { designs: ReadonlyMap<string, DiligenceDesign>; legacy: Readonly<Record<string, string>> };

/** A synthetic placeholder for one field: the jurisdiction's override, else the customer type's value. */
function syntheticField(content: SyntheticContent, customerType: string, jurisdiction: string, field: string, dueDiligence: DueDiligence = "standard"): SyntheticField | undefined {
  if (content.label !== "SYNTHETIC") throw new Error("policy.synthetic_content_unlabelled");
  // Permission is never a placeholder: provider permission stays an installation owner's decision.
  if (field === "permitted_providers" || field === "permissions") return undefined;
  const entry = content.dueDiligenceOverrides?.[dueDiligence]?.fields[field]
    ?? content.jurisdictionOverrides?.[jurisdiction]?.[customerType]?.fields[field] ?? content.customerTypes[customerType]?.fields[field];
  if (entry && !entry.basis.startsWith("SYNTHETIC")) throw new Error(`policy.synthetic_content_unlabelled:${field}`);
  return entry;
}

/**
 * Installable authoring template. Pack values are inherited; content the packs leave open is filled
 * with clearly labelled SYNTHETIC placeholders (never a real institution's policy), and anything
 * still open stays UNRESOLVED.
 */
export function agenticBusinessPolicy(id: string, packs: EffectivePolicyPack[], fields: string[], synthetic: SyntheticContent,
  options: { dueDiligence?: DueDiligence; ownershipAgent?: string | null; diligence?: DiligenceInputs } = {}) {
  const dueDiligence = options.dueDiligence ?? "standard";
  const requiredFields = [...new Set(fields)].filter(field => !["version", "jurisdiction", "permissions", "synthetic"].includes(field)).sort();
  const customerTypes = [...new Set(packs.flatMap(pack => pack.scope.customerTypes))];
  if (customerTypes.length !== 1) throw new Error(`policy.flow_customer_type_ambiguous:${id}:${customerTypes.join(",")}`);
  const customerType = customerTypes[0]!;
  // The institution's diligence design, when it has one: the policy decides a diligence level, and the
  // EDD triggers and requirements the skills plan from are derived from it (combined with any
  // SYNTHETIC placeholders, which stay).
  const institutions = [...new Set(packs.map(pack => pack.scope.institution))];
  const design = institutions.length === 1 ? options.diligence?.designs.get(institutions[0]!) : undefined;
  const derivable = (field: string) => Boolean(design) && (DERIVABLE_CONTENT_FIELDS as readonly string[]).includes(field);
  const source: BusinessPolicySource = {
    apiVersion: "harness.factory/business-policy-v2", kind: "BusinessPolicy",
    metadata: { id: `policy.${id}.business.v2`, version: "2.0.0", owner: "installation.policy.owner" }, decisionTtlSeconds: 60,
    policySets: packs.map(pack => ({ id: `${pack.id}.v2`, version: "2.0.0", status: "CANDIDATE", packPin: { id: pack.id, digest: pack.digest },
      scope: { jurisdiction: pack.scope.jurisdiction, institution: pack.scope.institution, products: pack.scope.products,
        customerTypes: pack.scope.customerTypes, purposes: ["CDD_ONBOARDING"] },
      modules: pack.layers.map(layer => ({ id: layer.id, version: layer.version, digest: layer.digest })),
      configuration: { ...pack.values, content: { apiVersion: "harness.factory/installation-policy-content-v2", requiredFields,
        fields: Object.fromEntries(requiredFields.map(field => {
          const projected = POLICY_PACK_FIELDS[field as keyof typeof POLICY_PACK_FIELDS]?.projected;
          const placeholder = syntheticField(synthetic, customerType, pack.scope.jurisdiction, field, dueDiligence);
          if (derivable(field)) return [field, { status: "DERIVED", owner: "installation.policy.owner", from: "diligence",
            ...(placeholder ? { base: { owner: synthetic.owner, basis: placeholder.basis, value: placeholder.value } } : {}) }];
          return [field, projected && Object.hasOwn(pack.values, field)
            ? { status: "RESOLVED", owner: "installation.policy.owner", basis: `Inherited from pinned pack ${pack.id} (${pack.digest}); candidate until independently approved.`, schemaVersion: INSTALLATION_CONTENT_SCHEMA_VERSION, value: (pack.values as Record<string, unknown>)[field] }
            : placeholder
              // SYNTHETIC placeholder content (domains/policy/synthetic-installation-content.yaml):
              // lets every skill run in testing; the set stays CANDIDATE until an owner replaces it.
              ? { status: "RESOLVED", owner: synthetic.owner, basis: placeholder.basis, schemaVersion: INSTALLATION_CONTENT_SCHEMA_VERSION, value: placeholder.value }
              : { status: "UNRESOLVED", owner: "installation.policy.owner", reason: "Supply reviewed installation policy content." }];
        })) } } as never })),
    // SYNTHETIC checkpoint rules (agentic-gate-rules.ts): placeholders the installation's policy
    // owner replaces or approves. The sets stay CANDIDATE until then.
    gates: syntheticGates(customerType, { dueDiligence, ...(options.ownershipAgent !== undefined ? { ownershipAgent: options.ownershipAgent } : {}) }),
  };
  if (design) source.diligence = projectDiligenceDesign(design, source.policySets, options.diligence!.legacy);
  return { source, compiled: compileBusinessPolicy(source, { opaVersion: "1.9.0" }) };
}
