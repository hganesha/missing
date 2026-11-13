import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { caseDocumentDetail, caseDocuments, codePointSlice, documentCitationPreview, type CanonicalRecordView, type DocumentSkillOutputs, type DocumentReviewRecord } from "./documents.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/documents.kyb-1042.json", import.meta.url), "utf8")) as {
  caseId: string; records: CanonicalRecordView[]; outputs: DocumentSkillOutputs;
};

describe("case documents projection", () => {
  it("lists every document version with its classification, extraction state and requirement coverage", () => {
    const view = caseDocuments(fixture.caseId, fixture.records, fixture.outputs);
    expect(view.documents.map((item) => item.documentType).sort()).toEqual(["bank_statement", "passport", "shareholder_register"]);
    for (const document of view.documents) {
      expect(document.extractionStatus).toBe("NEEDS_REVIEW");
      expect(document.reviewPending).toBe(document.assertionCount);
      expect(document.synthetic).toBe(true);
    }
    expect(view.requirements.find((item) => item.id === "EVD-BUSINESS-REGISTRATION")).toMatchObject({ satisfied: false, satisfiedBy: [] });
    expect(view.requirements.find((item) => item.id === "EVD-DIRECTOR-IDENTITY")).toMatchObject({ satisfied: true, satisfiedBy: ["passport"] });
    expect(view.requestTypes).toEqual(["certificate_of_incorporation", "company_registry_extract"]);
    expect(view.epistemicNote).toMatch(/unverified/);
  });

  it("puts every extracted value on its page as a highlight whose code-point span quotes the page exactly", () => {
    const view = caseDocuments(fixture.caseId, fixture.records, fixture.outputs);
    for (const summary of view.documents) {
      const detail = caseDocumentDetail(summary.documentId, fixture.records, fixture.outputs, {}, summary.documentVersion)!;
      expect(detail.assertions.length).toBe(summary.assertionCount);
      const preview = documentCitationPreview(detail);
      expect(preview.documentVersion).toBe(summary.documentVersion);
      expect(preview.assertions.flatMap(assertion => assertion.spans).length).toBeGreaterThan(0);
      expect(JSON.stringify(preview)).not.toMatch(/"value"|"quote"|"text"|"review"/);
      for (const assertion of detail.assertions) {
        expect(assertion.verification).toBe("UNVERIFIED");
        for (const span of assertion.spans) {
          const page = detail.pages.find((item) => item.page === span.page)!;
          expect(codePointSlice(page.text, span.start, span.end)).toBe(span.quote);
          expect(page.highlights).toContainEqual({ start: span.start, end: span.end, kind: "assertion", field: assertion.field, ref: assertion.objectId });
        }
      }
    }
    expect(caseDocumentDetail("doc_missing", fixture.records, fixture.outputs)).toBeNull();
    expect(caseDocumentDetail(view.documents[0]!.documentId, fixture.records, fixture.outputs, {}, "0".repeat(64))).toBeNull();
  });

  it("slices by code points, not UTF-16 units", () => {
    expect(codePointSlice("𝐀cme Ltd", 1, 4)).toBe("cme");
    expect("𝐀cme Ltd".slice(1, 4)).not.toBe("cme");
  });

  it("invalidates old field reviews and document completion when extraction versions change", () => {
    const doc = caseDocuments(fixture.caseId, fixture.records).documents[0]!;
    const records = structuredClone(fixture.records);
    const fields = records.filter(record => record.object_type === "ExtractedAssertion" && record.data.document_version === doc.documentVersion);
    for (const field of fields) field.version_id = "v1";
    const review: DocumentReviewRecord = { review_id: "r1", object_ref: doc.documentId, created_at: "2026-11-01T00:00:00Z", reviewer: { principalId: "reviewer" }, rationale: "Compared source", details: { documentVersion: doc.documentVersion, recordedSequence: 2, entries: [...fields.map(field => ({ assertionId: field.object_id, assertionVersion: "v1", outcome: "CHECKED" as const })), { assertionId: null, assertionVersion: null, outcome: "CHECKED" }] } };
    const initial = caseDocumentDetail(doc.documentId, records, {}, { reviews: [review] })!;
    expect(initial.document.reviewPending).toBe(0);
    expect(initial.review?.outcome).toBe("CHECKED");
    fields[0]!.version_id = "v2";
    const rerun = caseDocumentDetail(doc.documentId, records, {}, { reviews: [review] })!;
    expect(rerun.document.reviewPending).toBe(1);
    expect(rerun.review).toBeNull();
    expect(rerun.assertions.find(field => field.objectId === fields[0]!.object_id)?.review).toBeNull();
  });

  it("uses recorded source geometry and refuses out-of-page rectangles", () => {
    const records = structuredClone(fixture.records);
    const doc = caseDocuments(fixture.caseId, records).documents[0]!;
    const page = records.find(record => record.object_type === "DocumentPage" && record.data.document_version === doc.documentVersion)!;
    const text = String(page.data.text);
    page.data.extensions = { "ehf.connector": { value: { geometry: { width: 600, height: 800, rotation: "0" }, regions: [{ start: 0, end: Array.from(text).length, bbox: [20, 30, 580, 90] }] } } };
    const detail = caseDocumentDetail(doc.documentId, records)!;
    expect(detail.pages[0]!.highlights[0]?.rect).toEqual({ x: 20, y: 30, width: 560, height: 60 });
    (page.data.extensions as any)["ehf.connector"].value.regions[0].bbox[2] = 700;
    expect(caseDocumentDetail(doc.documentId, records)!.pages[0]!.highlights[0]?.rect).toBeUndefined();
  });
});
