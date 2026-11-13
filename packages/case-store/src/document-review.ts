import { z } from "zod";
import type { CanonicalRecord } from "@ehf/contracts";

export const documentReviewSchema = z.object({
  documentId: z.string().min(1), documentVersion: z.string().regex(/^[a-f0-9]{64}$/),
  entries: z.array(z.object({
    assertionId: z.string().min(1).nullable(), assertionVersion: z.string().min(1).nullable(),
    outcome: z.enum(["CHECKED", "CORRECTED", "REJECTED", "RESET"]), correctedValue: z.json().optional(),
    /** Which extraction route's reading the reviewer kept (`llm`, `azure_di`), or `manual` for their own value. */
    selectedRoute: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/).optional(),
  }).strict()).min(1).max(200),
  /** Open DOCUMENT_FIELD_CONFLICT work items this review resolves; each must be about an entry's assertion. */
  resolvedWorkItems: z.array(z.string().min(1).max(200)).max(50).optional(),
}).strict();
export type DocumentReview = z.infer<typeof documentReviewSchema>;

/** Validate references against the current selection, including the extraction version. */
export function validateDocumentReview(review: DocumentReview, records: Record<string, CanonicalRecord[]>) {
  if (!records.DocumentVersion?.some(record => record.data.document_id === review.documentId && record.data.artifact_hash === review.documentVersion)) throw new Error("document.version_conflict");
  const assertions = (records.ExtractedAssertion ?? []).filter(record => record.data.document_version === review.documentVersion);
  const seen = new Set<string | null>();
  for (const entry of review.entries) {
    if (seen.has(entry.assertionId)) throw new Error("document.review_duplicate");
    seen.add(entry.assertionId);
    if (entry.assertionId === null) {
      if (entry.assertionVersion !== null || !["CHECKED", "RESET"].includes(entry.outcome) || "correctedValue" in entry) throw new Error("document.review_invalid");
      continue;
    }
    const assertion = assertions.find(record => record.object_id === entry.assertionId);
    if (!assertion || assertion.version_id !== entry.assertionVersion) throw new Error("document.assertion_conflict");
    if (entry.outcome === "CORRECTED" && !("correctedValue" in entry)) throw new Error("document.correction_required");
    if (entry.outcome !== "CORRECTED" && "correctedValue" in entry) throw new Error("document.review_invalid");
    if (entry.selectedRoute !== undefined && entry.outcome === "RESET") throw new Error("document.review_invalid");
  }
  return assertions;
}

export const ADJUDICATION_EXTENSION = "ehf.document.adjudication";
const DOCUMENT_EXTENSION = "ehf.document";
export type DocumentFeedbackRow = {
  feedbackId: string; assertionId: string; assertionVersion: string; field: string; kind: "CORRECTION" | "REJECTION" | "CONFLICT_RESOLUTION";
  outcome: "CHECKED" | "CORRECTED" | "REJECTED"; proposedValue: unknown; finalValue: unknown; proposedRoute: string | null;
  adjudication: Record<string, unknown> | null; resolvedWorkItems: string[];
};

/**
 * The feedback a document review records (document factory plan Phase 4): every correction and rejection, and every
 * entry that resolves a route conflict, with what each route read. Confirmations of uncontested values are not
 * feedback. Review evidence for quality reporting only; never training data.
 */
export function documentFeedback(review: DocumentReview, assertions: CanonicalRecord[], reviewId: string, conflicts: Map<string, string[]>): DocumentFeedbackRow[] {
  const rows: DocumentFeedbackRow[] = [];
  for (const entry of review.entries) {
    if (!entry.assertionId || entry.outcome === "RESET") continue;
    const resolved = conflicts.get(entry.assertionId) ?? [];
    const kind = resolved.length ? "CONFLICT_RESOLUTION" : entry.outcome === "CORRECTED" ? "CORRECTION" : entry.outcome === "REJECTED" ? "REJECTION" : null;
    if (!kind) continue;
    const assertion = assertions.find(record => record.object_id === entry.assertionId)!;
    const extensions = (assertion.data.extensions ?? {}) as Record<string, { value?: Record<string, unknown> } | undefined>;
    const adjudication = extensions[ADJUDICATION_EXTENSION]?.value ?? null;
    const path = String(extensions[DOCUMENT_EXTENSION]?.value?.path ?? `/extracted_fields/${assertion.data.field}`);
    rows.push({
      feedbackId: `feedback_${reviewId.replace(/^review_/, "")}_${rows.length}`, assertionId: entry.assertionId, assertionVersion: entry.assertionVersion!,
      field: path.replace(/^\/extracted_fields\//, ""), kind, outcome: entry.outcome, proposedValue: assertion.data.value ?? null,
      finalValue: entry.outcome === "CORRECTED" ? entry.correctedValue ?? null : entry.outcome === "CHECKED" ? assertion.data.value ?? null : null,
      proposedRoute: typeof adjudication?.proposed_route === "string" ? adjudication.proposed_route : null,
      adjudication: adjudication ? { ...Object.fromEntries(["outcome", "rule", "route_mode", "candidates", "policy_digest", "route_policy_digest", "inputs_digest"]
        .filter(key => key in adjudication).map(key => [key, adjudication[key]])), ...(entry.selectedRoute ? { selected_route: entry.selectedRoute } : {}) }
        : entry.selectedRoute ? { selected_route: entry.selectedRoute } : null,
      resolvedWorkItems: resolved,
    });
  }
  return rows;
}
