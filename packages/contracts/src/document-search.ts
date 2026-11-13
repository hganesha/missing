import { z } from "zod";
const id = z.string().trim().min(1).max(512);
export const documentSearchScopeSchema = z
  .object({
    purpose: id,
    subjects: z.array(id).min(1).max(32).optional(),
  })
  .strict();
export const documentSearchRequestSchema = documentSearchScopeSchema
  .extend({
    query: z.string().trim().min(1).max(500),
    mode: z.literal("lexical").default("lexical"),
    maxResults: z.number().int().min(1).max(20).default(5),
    snippetChars: z.number().int().min(80).max(1600).default(500),
    contextBudget: z.number().int().min(100).max(16000).default(4000),
  })
  .strict();
export const documentCitationRequestSchema = documentSearchScopeSchema
  .extend({ citationId: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export type DocumentSearchRequest = z.infer<typeof documentSearchRequestSchema>;
export type DocumentCitation = {
  citationId: string;
  documentId: string;
  documentVersion: string;
  artifactHash: string;
  artifactRef: string;
  page: number;
  start: number;
  end: number;
  offsetUnit: "codepoint";
  chunkDigest: string;
  generation: string;
  parserVersion: string;
  chunkerVersion: string;
  textCoverage: "extracted_text" | "cited_quotes" | "unknown";
  pageRecord: { objectId: string; versionId: string };
};
