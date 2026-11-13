import { z } from "zod";

/**
 * Field candidates from a provider extraction model (`document.model_fields.v1`), mapped to catalog
 * pointers but not yet anchored. Route A of the document factory: a platform adapter (Azure Document
 * Intelligence prebuilt models first) reads the original and reports, per catalog leaf, the value it
 * read, the text as printed, and its confidence. The skill library anchors each value on the canonical
 * page text (`kyc_documents.route_answers`); a value that does not occur there is not used.
 */
export const DOCUMENT_MODEL_FIELDS_CONTRACT = "document.model_fields.v1";

export const documentModelFieldSchema = z.object({
  path: z.string().regex(/^\/extracted_fields\/[a-z][a-z0-9_]*(?:\/(?:\d+|[a-z][a-z0-9_]*))*$/),
  value: z.string().min(1).max(20_000),
  content: z.string().max(20_000).nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  page: z.number().int().positive().nullable(),
  /** A named, deterministic transform when the value is not a single printed field (for example joining names). */
  transform: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).nullable(),
  provider_field: z.string().max(200),
}).strict();

export const documentModelFieldsSchema = z.object({
  contract: z.literal(DOCUMENT_MODEL_FIELDS_CONTRACT),
  provider: z.string().min(1).max(120),
  model: z.string().min(1).max(120),
  model_version: z.string().min(1).max(120).optional(),
  document_type: z.string().regex(/^[a-z][a-z0-9_]*$/),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  provider_document_type: z.string().max(200).nullable(),
  provider_document_confidence: z.number().min(0).max(1).nullable(),
  fields: z.array(documentModelFieldSchema).max(5000),
}).strict();

export type DocumentModelFields = z.infer<typeof documentModelFieldsSchema>;
export type DocumentModelField = z.infer<typeof documentModelFieldSchema>;
