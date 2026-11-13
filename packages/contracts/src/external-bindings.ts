import { z } from "zod";

const ref = z.string().trim().min(1).max(240);
const refs = z.array(ref).max(100).refine(values => new Set(values).size === values.length, "Remove duplicate values.");
const country = z.string().regex(/^[a-z]{2}$/);
export const externalBindingDraftSchema = z.object({
  capabilityPath: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/),
  actions: refs.min(1),
  jurisdiction: z.object({ code: ref, evidenceRefs: refs }).strict(),
  coverage: z.object({
    status: z.enum(["unknown", "partial", "complete", "not_supported"]),
    eligibleSubjectCountries: z.array(country).max(250), eligibleAccountCountries: z.array(country).max(250),
    issuingAuthorities: refs, datasetRefs: refs, excludedScopes: refs, evidenceRefs: refs,
    freshnessPolicyRef: ref.nullable(),
  }).strict(),
}).strict();
export const externalBindingSaveSchema = z.object({
  definition: externalBindingDraftSchema, expectedRevision: z.number().int().nonnegative(),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), reason: z.string().trim().min(1).max(2000),
}).strict();
export type ExternalBindingDraft = z.infer<typeof externalBindingDraftSchema>;
export type ExternalBindingRevision = {
  bindingId: string; definition: ExternalBindingDraft; revision: number; sourceDigest: string;
  digest: string; reason: string; updatedAt: string; updatedBy: string;
};
export type ExternalBindingOptions = {
  definitions: Array<{ path: string; name: string; description: string; jurisdictionBasis: string; actions: string[] }>;
  jurisdictions: Array<{ code: string; name: string; kind: string }>;
};
export type ExternalBindingSource = { bindingId: string; sourceDigest: string; definition: ExternalBindingDraft };
export type ExternalBindingCatalog = ExternalBindingOptions & { bindings: ExternalBindingSource[] };
/** Shared semantic validation for the service and contract mock. Approval is never inferred. */
export function externalBindingError(draft: ExternalBindingDraft, options: ExternalBindingOptions): string | null {
  const definition = options.definitions.find(item => item.path === draft.capabilityPath);
  if (!definition) return "external_binding.capability_unknown";
  if (draft.actions.some(action => !definition.actions.includes(action))) return "external_binding.action_incompatible";
  if (!options.jurisdictions.some(item => item.code === draft.jurisdiction.code)) return "external_binding.jurisdiction_unknown";
  const countries = new Set(options.jurisdictions.filter(item => item.kind === "iso_3166_1").map(item => item.code));
  if ([...draft.coverage.eligibleSubjectCountries, ...draft.coverage.eligibleAccountCountries].some(code => !countries.has(code))) return "external_binding.country_unknown";
  if (draft.coverage.status !== "unknown" && !draft.coverage.evidenceRefs.length) return "external_binding.coverage_evidence_required";
  if (draft.jurisdiction.code === "global" && !draft.jurisdiction.evidenceRefs.length) return "external_binding.global_evidence_required";
  return null;
}
