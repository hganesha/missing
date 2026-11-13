import { z } from "zod";
const id = z.string().min(1).max(512);
export const caseTraversalRootSchema = z.object({ objectType: id, objectId: id, versionId: id.optional() }).strict();
export const caseTraversalQuerySchema = z.object({
  root: caseTraversalRootSchema.optional(),
  subjects: z.array(id).min(1).max(32).optional(),
  asOf: z.iso.datetime({ offset: true }).optional(),
  knowledgeCutoff: z.iso.datetime({ offset: true }).optional(),
  direction: z.enum(["both", "outgoing", "incoming"]).default("both"),
  maxDepth: z.number().int().min(0).max(4).default(1),
  pageSize: z.number().int().min(1).max(50).default(25),
  cursor: z.string().min(1).max(32768).optional(),
}).strict();
export type CaseTraversalQuery = z.infer<typeof caseTraversalQuerySchema>;
export type CaseTraversalNode = {
  key: string; objectType: string; objectId: string; versionId: string;
  classification: string; subjectIds: string[]; observedAt: string; recordedAt: string;
  validFrom: string | null; validTo: string | null; data: Record<string, unknown>;
};
export type CaseTraversalGraph = {
  scope: "authorized_case"; snapshotDigest: string; relationshipDigest: string;
  asOf: string; knowledgeCutoff: string; purpose: string; subjects: string[];
  root: CaseTraversalNode | null; nodes: CaseTraversalNode[];
  edges: Array<{ id: string; source: string; target: string; relationId: string; label: string; field: string }>;
  unresolved: Array<{ source: string; relationId: string; field: string; reason: "not_visible_or_unresolved" | "ambiguous" | "invalid_reference" }>;
  nextCursor: string | null; complete: boolean; truncated: boolean; limitations: string[];
};
