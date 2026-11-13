import { skillResultStatusSchema } from "@ehf/contracts";
import { z } from "zod";

const keys = new Set((
  "input output payload parameters context context_hash context_envelope execution_id idempotency_key trace_id " +
  "records canonical_records object_id object_type data version_id source evidence evidence_refs selectors purpose policy " +
  "status business_status lifecycle error code unresolved_items recordGaps policyGaps parameterGaps envelopeGaps " +
  "computation proposed_records proposed_actions document_version document_id artifact_hash page page_count " +
  "classifications extractions extraction_status unclassified extracted_fields observations subject catalog_hash " +
  "review_required promotion_allowed semantic_verification assessments conflicts compared requirements request_types " +
  "classification verification findings candidates calculation ownership result results events coverage hits matches " +
  "risk assessment tier triggers required decision reasoning score name address identifiers value source_spans"
).split(" "));
const digest = z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[a-zA-Z0-9_.:/@-]{1,220}$/);
const kinds = ["object", "array", "string", "number", "boolean", "null", "omitted"] as const;
const field = z.object({
  path: z.string().max(220).refine(path => path === "$" || path.startsWith("$/") &&
    path.slice(2).split("/").every(part => part === "*" || part === "~other" || keys.has(part))),
  type: z.enum(kinds),
  count: z.number().int().min(0).max(100_000).nullable(),
}).strict();
const shape = z.object({ fields: z.array(field).max(64), truncated: z.boolean() }).strict();
type Shape = z.infer<typeof shape>;

/** Keep contract field names, value types, and collection sizes. Scalar values and dynamic keys stay private. */
export function sandboxPayloadShape(input: unknown): Shape | null {
  if (input === undefined) return null;
  const fields: Shape["fields"] = [];
  let truncated = false;
  function visit(value: unknown, path: string, depth: number) {
    if (fields.length >= 64 || depth > 5 || path.length > 220) { truncated = true; return; }
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      fields.push({ path, type: value === null ? "null" : typeof value as "string" | "number" | "boolean", count: null });
      return;
    }
    if (Array.isArray(value)) {
      fields.push({ path, type: "array", count: Math.min(value.length, 100_000) });
      if (value.length) visit(value[0], `${path}/*`, depth + 1);
      if (value.length > 1) truncated = true;
      return;
    }
    if (!value || typeof value !== "object") return;
    const entries = Object.entries(value);
    fields.push({ path, type: "object", count: Math.min(entries.length, 100_000) });
    const omitted = entries.filter(([key]) => !keys.has(key)).length;
    if (omitted && fields.length < 64) fields.push({ path: `${path}/~other`, type: "omitted", count: Math.min(omitted, 100_000) });
    for (const [key, child] of entries.filter(([key]) => keys.has(key)).sort(([a], [b]) => a.localeCompare(b))) {
      visit(child, `${path}/${key}`, depth + 1);
    }
  }
  visit(input, "$", 0);
  return { fields, truncated };
}

const documentRef = z.object({
  documentId: z.string().regex(/^doc_[a-f0-9]{8,64}$/),
  version: digest,
}).strict();

const common = { nodeId: identifier, key: identifier, invocationId: identifier.nullable() };

export const sandboxSkillObservationSchema = z.object({
  ...common,
  kind: z.literal("skill"),
  data: z.object({
    skillId: identifier, skillVersion: identifier.nullable(),
    status: skillResultStatusSchema,
    contextHash: digest.nullable(), resultDigest: digest.nullable(),
    input: shape.nullable(), output: shape.nullable(),
    documents: z.array(z.object({ version: digest, status: z.enum(["NEEDS_REVIEW", "NEEDS_EVIDENCE", "COMPLETED", "FAILED"]) }).strict()).max(30),
  }).strict(),
}).strict();
export const sandboxDocumentObservationSchema = z.object({
  ...common,
  kind: z.literal("documents"),
  data: z.object({ documents: z.array(documentRef).max(30) }).strict(),
}).strict();
export const sandboxContextObservationSchema = z.object({
  ...common,
  kind: z.literal("context"),
  data: z.object({
    packDigest: digest, manifestDigest: digest.nullable(), snapshotId: identifier.nullable(),
    snapshotDigest: digest.nullable(), caseSequence: z.number().int().nonnegative().nullable(),
    usedChars: z.number().int().nonnegative(),
    sections: z.array(z.object({
      id: identifier, kind: z.enum(["case", "evidence", "policy", "upstream", "observation"]),
      digest, source: identifier.nullable(), required: z.boolean(),
      state: z.enum(["Included", "Dropped by budget", "Quarantined"]),
      items: z.number().int().nonnegative().nullable(),
      fields: z.array(field.shape.path).max(8),
    }).strict()).max(30),
    gaps: z.array(z.object({ selector: identifier, objectType: identifier, code: identifier, required: z.boolean() }).strict()).max(20),
    truncated: z.boolean(),
  }).strict(),
}).strict();
export const sandboxRuntimeObservationSchema = z.discriminatedUnion("kind", [sandboxSkillObservationSchema, sandboxDocumentObservationSchema]);
export type SandboxRuntimeObservation = z.infer<typeof sandboxRuntimeObservationSchema>;
export type SandboxObservation = SandboxRuntimeObservation | z.infer<typeof sandboxContextObservationSchema>;
