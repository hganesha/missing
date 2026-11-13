import { z } from "zod";
import { validateRecordData, LIBRARY_CONTEXT_SCHEMA_VERSION } from "@ehf/library-contracts";
import { stableDigest, type EffectivePolicySet } from "@ehf/contracts";

export const INSTALLATION_CONTENT_SCHEMA_VERSION = LIBRARY_CONTEXT_SCHEMA_VERSION;
const RESERVED_FIELDS = new Set(["version","jurisdiction","permissions","synthetic"]);
const id = z.string().min(1).max(200);
const contentField = z.discriminatedUnion("status", [
  z.object({ status: z.literal("UNRESOLVED"), owner: id, reason: z.string().min(1).max(1000) }).strict(),
  z.object({ status: z.literal("RESOLVED"), owner: id, basis: z.string().min(1).max(2000),
    schemaVersion: id, value: z.json() }).strict(),
  /**
   * Computed when the policy compiles (from its diligence block); the compiled set carries the value.
   * With `base`, the derived entries are combined with that content (e.g. SYNTHETIC placeholders):
   * the base's entries are kept, and the diligence decision can add to them, never remove one.
   */
  z.object({ status: z.literal("DERIVED"), owner: id, from: z.literal("diligence"),
    base: z.object({ owner: id, basis: z.string().min(1).max(2000), value: z.json() }).strict().optional() }).strict(),
]);
export const installationPolicyContentSchema = z.object({
  apiVersion: z.literal("harness.factory/installation-policy-content-v2"),
  requiredFields: z.array(id).max(100).refine(v => new Set(v).size === v.length),
  fields: z.record(id, contentField),
}).strict();
export type InstallationPolicyContent = z.infer<typeof installationPolicyContentSchema>;

/** Validate the library's closed Policy contract, including its nested types. No second field registry. */
export function validateInstallationContent(raw: unknown, jurisdiction: string) {
  const content = installationPolicyContentSchema.parse(raw);
  for (const [field, entry] of Object.entries(content.fields)) {
    if (RESERVED_FIELDS.has(field)) throw new Error(`policy.content_scope_field_forbidden:${field}`);
    if (entry.status === "RESOLVED") {
      if(entry.schemaVersion!==LIBRARY_CONTEXT_SCHEMA_VERSION) throw new Error(`policy.content_schema_version_mismatch:${field}`);
      const result = validateRecordData("Policy", { version: "installation.v2", jurisdiction, permissions: [], [field]: entry.value });
      if (!result.valid) throw new Error(`policy.content_invalid:${field}:${result.errors.join(";")}`);
    }
  }
  return { content, unresolved: content.requiredFields.filter(field => content.fields[field]?.status !== "RESOLVED"), digest: stableDigest(content) };
}

/** A skill still produces observations. Projected content does not confer adoption authority. */
export function projectInstallationContent(set: EffectivePolicySet, fields: readonly string[], permissions: string[]) {
  const parsed = validateInstallationContent(set.configuration.content, set.scope.jurisdiction);
  const wanted = [...new Set(fields)].sort();
  const values: Record<string, unknown> = { version: set.version, jurisdiction: set.scope.jurisdiction, permissions };
  const sources: Record<string, unknown> = {};
  for (const field of wanted) {
    const entry = parsed.content.fields[field];
    if (entry?.status === "RESOLVED") {
      values[field] = entry.value;
      sources[field] = `policy-set:${set.setDigest}/content:${parsed.digest}#${field}`;
    }
  }
  return { policyRef: set.packPin.id, policyVersion: set.version, bundleDigest: set.packPin.digest,
    effectivePolicySetDigest: set.setDigest, fields: wanted, values, sources,
    unresolved: wanted.filter(field => !Object.hasOwn(values, field)) };
}
