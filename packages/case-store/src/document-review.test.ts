import { expect, it } from "vitest";
import type { CanonicalRecord } from "@ehf/contracts";
import { documentFeedback, documentReviewSchema, validateDocumentReview } from "./document-review.js";
const hash = "a".repeat(64);
const records = { DocumentVersion: [{ data: { document_id: "doc", artifact_hash: hash } }], ExtractedAssertion: [{ object_id: "assertion", version_id: "v2", data: { document_version: hash, value: "original" } }] } as unknown as Record<string, CanonicalRecord[]>;
const review = (entry: object) => documentReviewSchema.parse({ documentId: "doc", documentVersion: hash, entries: [{ assertionId: "assertion", assertionVersion: "v2", outcome: "CHECKED", ...entry }] });
it("accepts JSON corrections without modifying the immutable extraction", () => {
  for (const correctedValue of [null, false, 0, [{ name: "reviewed" }]]) expect(validateDocumentReview(review({ outcome: "CORRECTED", correctedValue }), records)).toHaveLength(1);
  expect(records.ExtractedAssertion![0]!.data.value).toBe("original");
});
it("rejects stale versions, duplicate entries, incomplete corrections and whole-document values", () => {
  expect(() => validateDocumentReview(review({ assertionVersion: "v1" }), records)).toThrow("document.assertion_conflict");
  expect(() => validateDocumentReview(review({ outcome: "CORRECTED" }), records)).toThrow("document.correction_required");
  expect(() => validateDocumentReview(review({ assertionId: null, assertionVersion: null, correctedValue: "not-a-document-field" }), records)).toThrow("document.review_invalid");
  const duplicate = review({}); duplicate.entries.push(duplicate.entries[0]!);
  expect(() => validateDocumentReview(duplicate, records)).toThrow("document.review_duplicate");
});
it("records corrections, rejections and resolved route conflicts as feedback, never plain confirmations", () => {
  const adjudication = { outcome: "CONFLICT", rule: "R6", route_mode: "shadow", proposed_route: "llm", policy_digest: "p", route_policy_digest: "r", inputs_digest: "i",
    candidates: { llm: { value: "original" }, azure_di: { value: "other" } }, comparison: "different" };
  const assertions = [{ object_id: "assertion", version_id: "v2", data: { field: "document_number", document_version: hash, value: "original",
    extensions: { "ehf.document": { value: { path: "/extracted_fields/document_number" } }, "ehf.document.adjudication": { value: adjudication } } } }] as unknown as CanonicalRecord[];
  const corrected = documentFeedback(review({ outcome: "CORRECTED", correctedValue: "other", selectedRoute: "azure_di" }), assertions, "review_1", new Map([["assertion", ["work_1"]]]));
  expect(corrected).toEqual([expect.objectContaining({ kind: "CONFLICT_RESOLUTION", outcome: "CORRECTED", field: "document_number", proposedValue: "original", finalValue: "other",
    proposedRoute: "llm", resolvedWorkItems: ["work_1"], adjudication: expect.objectContaining({ outcome: "CONFLICT", selected_route: "azure_di", candidates: adjudication.candidates }) })]);
  expect(corrected[0]!.adjudication).not.toHaveProperty("comparison");
  expect(documentFeedback(review({ outcome: "REJECTED" }), assertions, "review_2", new Map())).toEqual([expect.objectContaining({ kind: "REJECTION", finalValue: null })]);
  expect(documentFeedback(review({}), assertions, "review_3", new Map())).toEqual([]);
  expect(() => validateDocumentReview(review({ outcome: "RESET", selectedRoute: "llm" }), records)).toThrow("document.review_invalid");
});
