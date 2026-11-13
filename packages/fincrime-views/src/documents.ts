import type { components } from "@ehf/ui-contracts";

/**
 * Case documents: canonical records -> the Experience API's document views
 * (`/v1/fincrime/cases/{caseId}/documents[/{documentId}]`, docs/implementation/document-intelligence.md).
 *
 * Inputs are what the case already holds: DocumentVersion, DocumentPage, Evidence and
 * ExtractedAssertion records (selected, current versions), plus the last outputs of the document
 * skills. Nothing here verifies or promotes anything: an extracted value is shown as an unverified
 * assertion with its spans, and a requirement is "satisfied" only by the presence of an accepted type.
 *
 * Offsets are Unicode code points (Python string indices) into the page text. They are passed through
 * unchanged; `codePointSlice` is the only correct way to cut page text with them in JavaScript.
 */
export type CaseDocuments = components["schemas"]["CaseDocuments"];
export type CaseDocumentDetail = components["schemas"]["CaseDocumentDetail"];
export type CaseDocumentSummary = components["schemas"]["CaseDocumentSummary"];

export type CanonicalRecordView = {
  object_type: string;
  object_id: string;
  version_id?: string;
  data: Record<string, unknown>;
  synthetic?: boolean;
};
export type DocumentReviewRecord = { review_id: string; object_ref: string; created_at: string; rationale: string; reviewer: { principalId: string }; details: { documentVersion: string; recordedSequence?: number; entries: Array<{ assertionId: string | null; assertionVersion: string | null; outcome: "CHECKED" | "CORRECTED" | "REJECTED" | "RESET"; correctedValue?: unknown }> } };
export type DocumentWorkItemRecord = { work_item_id: string; work_type: string; status: string; description?: string | null; subject_ref?: string | null; created_at: string };
export type DocumentViewContext = { caseSequence?: number; reviews?: DocumentReviewRecord[]; evidence?: Array<{ evidence_id: string; raw_digest: string }>; workItems?: DocumentWorkItemRecord[] };
/** The work types a document run raises (packages/contracts DOCUMENT_WORK_TYPES). */
const DOCUMENT_WORK_TYPES = new Set(["DOCUMENT_CLASSIFICATION", "DOCUMENT_EVIDENCE_GAP", "DOCUMENT_FIELD_REVIEW", "DOCUMENT_FIELD_CONFLICT"]);
const ROUTE_OUTCOMES = new Set(["AGREED_GROUNDED", "SELECTED_GROUNDED", "SINGLE_ROUTE", "UNGROUNDED", "CONFLICT", "VALIDATION_FAILED", "NOT_PRESENT", "OCR_DISAGREEMENT"]);

/** An assertion's route adjudication (`ehf.document.adjudication`), or null when one route ran. */
type AssertionRoutes = components["schemas"]["DocumentAssertionRoutes"];
function routesOf(data: Json): AssertionRoutes | null {
  const value = extension(data, "ehf.document.adjudication");
  if (!ROUTE_OUTCOMES.has(String(value.outcome))) return null;
  const candidates = Object.entries(record(value.candidates)).map(([route, raw]) => {
    const candidate = record(raw), read = candidate.value;
    return { route, value: read === null || read === undefined ? null : typeof read === "string" ? read : JSON.stringify(read), grounded: candidate.grounded === true,
      confidence: typeof candidate.confidence === "number" && candidate.confidence >= 0 && candidate.confidence <= 1 ? candidate.confidence : null };
  });
  return { outcome: value.outcome as never, rule: String(value.rule ?? ""), routeMode: (["llm_only", "shadow", "selective"].includes(String(value.route_mode)) ? value.route_mode : "shadow") as never,
    proposedRoute: String(value.proposed_route ?? "llm"), review: (["light", "standard", "required"].includes(String(value.review)) ? value.review : "required") as never, candidates };
}

/** The last outputs of the document skills for this case (payloads as the library returns them). */
export type DocumentSkillOutputs = {
  classifications?: Array<{ document_version: string; document_type: string; basis: "title" | "unique_mention" | "ambiguous_or_unmatched" }>;
  extractions?: Array<{ document_version: string; extraction_status: "NEEDS_REVIEW" | "NEEDS_EVIDENCE" }>;
  requirements?: { requirements: Array<{ id: string; description: string | null; any_of: string[]; satisfied_by: string[]; satisfied: boolean }>; request_types: string[] };
  validity?: Array<{ document_version: string; status: CaseDocumentSummary["validity"] & string }>;
  conflicts?: Array<{ subject: string; field: string; values: Array<{ document_version: string; value: unknown; normalized: string }> }>;
};

const EPISTEMIC_NOTE = "Extracted values are unverified assertions bound to exact page spans. A document's presence is not acceptance, and nothing here is a fact until an authorized person accepts it.";

type Json = Record<string, unknown>;
const record = (value: unknown): Json => (value && typeof value === "object" && !Array.isArray(value) ? value as Json : {});
const extension = (data: Json, namespace: string): Json => record(record(record(data.extensions)[namespace]).value);
const text = (value: unknown): string | null => (typeof value === "string" && value.length ? value : null);

/** Slice by Unicode code points, the offset basis of every span in these views. */
export function codePointSlice(value: string, start: number, end: number): string {
  return Array.from(value).slice(start, end).join("");
}

function versionsOf(records: CanonicalRecordView[]): CanonicalRecordView[] {
  return records.filter((item) => item.object_type === "DocumentVersion")
    .sort((a, b) => String(a.data.document_id).localeCompare(String(b.data.document_id)));
}

function summarize(version: CanonicalRecordView, records: CanonicalRecordView[], outputs: DocumentSkillOutputs, context: DocumentViewContext = {}): CaseDocumentSummary {
  const data = version.data;
  const sha = String(data.artifact_hash);
  const source = extension(data, "ehf.connector");
  const classification = outputs.classifications?.find((item) => item.document_version === sha);
  const assertions = records.filter((item) => item.object_type === "ExtractedAssertion" && item.data.document_version === sha);
  const extraction = outputs.extractions?.find((item) => item.document_version === sha);
  const types = [...new Set(assertions.map(item => text(extension(item.data, "ehf.document").document_type)).filter(Boolean))];
  return {
    documentId: String(data.document_id),
    documentVersion: sha,
    filename: text(source.filename),
    mediaType: String(data.media_type),
    pageCount: typeof data.page_count === "number" ? data.page_count : 0,
    documentType: classification && classification.document_type !== "UNKNOWN" ? classification.document_type : types.length === 1 ? types[0]! : null,
    classificationBasis: classification?.basis ?? null,
    extractionStatus: extraction?.extraction_status ?? (assertions.length ? "NEEDS_REVIEW" : "NOT_EXTRACTED"),
    validity: outputs.validity?.find((item) => item.document_version === sha)?.status ?? null,
    assertionCount: assertions.length,
    reviewPending: assertions.filter(item => { const review = latestReview(context, String(data.document_id), sha, item.object_id, item.version_id ?? ""); return !review || !["CHECKED", "CORRECTED"].includes(review.outcome); }).length,
    conflicts: (outputs.conflicts ?? []).filter((conflict) => conflict.values.some((value) => value.document_version === sha)).length,
    synthetic: version.synthetic === true,
    evidenceId: context.evidence?.find(item => item.raw_digest.replace(/^sha256:/, "") === sha)?.evidence_id ?? null,
  };
}

function latestReview(context: DocumentViewContext, documentId: string, version: string, assertionId: string | null, assertionVersion: string | null) {
  let result: components["schemas"]["DocumentReviewView"] | null = null;
  for (const review of [...(context.reviews ?? [])].sort((a, b) => (a.details?.recordedSequence ?? 0) - (b.details?.recordedSequence ?? 0) || a.created_at.localeCompare(b.created_at) || a.review_id.localeCompare(b.review_id))) {
    if (review.object_ref !== documentId || review.details?.documentVersion !== version) continue;
    // A later field decision invalidates an earlier whole-document review.
    if (assertionId === null && review.details.entries.some(entry => entry.assertionId !== null)) result = null;
    for (const entry of review.details.entries) if (entry.assertionId === assertionId && entry.assertionVersion === assertionVersion) result = { outcome: entry.outcome, ...(entry.outcome === "CORRECTED" ? { correctedValue: entry.correctedValue } : {}), actor: review.reviewer.principalId, at: review.created_at, rationale: review.rationale };
  }
  return result;
}

export function caseDocuments(caseId: string, records: CanonicalRecordView[], outputs: DocumentSkillOutputs = {}, context: DocumentViewContext = {}): CaseDocuments {
  return {
    caseId,
    documents: versionsOf(records).map((version) => summarize(version, records, outputs, context)),
    ...(context.caseSequence !== undefined ? { caseSequence: context.caseSequence } : {}),
    requirements: (outputs.requirements?.requirements ?? []).map((item) => ({
      id: item.id, description: item.description, anyOf: item.any_of, satisfiedBy: item.satisfied_by, satisfied: item.satisfied,
    })),
    requestTypes: outputs.requirements?.request_types ?? [],
    epistemicNote: EPISTEMIC_NOTE,
  };
}

export function caseDocumentDetail(documentId: string, records: CanonicalRecordView[], outputs: DocumentSkillOutputs = {}, context: DocumentViewContext = {}, expectedVersion?: string): CaseDocumentDetail | null {
  const version = versionsOf(records).find((item) => item.data.document_id === documentId &&
    (expectedVersion === undefined || String(item.data.artifact_hash).replace(/^sha256:/, "") === expectedVersion.replace(/^sha256:/, "")));
  if (!version) return null;
  const sha = String(version.data.artifact_hash);
  const pageRecords = records.filter((item) => item.object_type === "DocumentPage" && item.data.document_version === sha)
    .sort((a, b) => Number(a.data.page) - Number(b.data.page));
  const pageByRecord = new Map(pageRecords.map((item) => [item.object_id, Number(item.data.page)]));
  const assertions = records.filter((item) => item.object_type === "ExtractedAssertion" && item.data.document_version === sha).map((item) => {
    const info = extension(item.data, "ehf.document");
    const spans = (Array.isArray(info.source_spans) ? info.source_spans : []).map(record)
      .filter((span) => pageByRecord.has(String(span.page_id)))
      .map((span) => ({ page: pageByRecord.get(String(span.page_id))!, start: Number(span.start), end: Number(span.end), quote: String(span.quote) }));
    return {
      objectId: item.object_id, field: String(item.data.field), value: item.data.value as unknown, path: String(info.path ?? `/extracted_fields/${String(item.data.field)}`),
      verification: "UNVERIFIED" as const, reviewState: String(info.review_state ?? "PENDING_REVIEW"), spans,
      versionId: item.version_id ?? "", review: latestReview(context, documentId, sha, item.object_id, item.version_id ?? ""),
      confidence: typeof info.confidence === "number" && info.confidence >= 0 && info.confidence <= 1 ? info.confidence : null,
      contractHash: text(info.contract_hash), documentType: text(info.document_type), routes: routesOf(item.data),
    };
  });
  const evidence = records.filter((item) => item.object_type === "Evidence" && extension(item.data, "ehf.connector").document_version === sha);
  const pages = pageRecords.map((page) => {
    const number = Number(page.data.page);
    const source = extension(page.data, "ehf.connector");
    const rawGeometry = record(source.geometry);
    const geometry = typeof rawGeometry.width === "number" && rawGeometry.width > 0 && typeof rawGeometry.height === "number" && rawGeometry.height > 0 && (rawGeometry.rotation === "0" || rawGeometry.rotation === undefined) ? { width: rawGeometry.width, height: rawGeometry.height, rotation: "0" as const } : undefined;
    const highlights = [
      ...assertions.flatMap((assertion) => assertion.spans.filter((span) => span.page === number)
        .map((span) => ({ start: span.start, end: span.end, kind: "assertion" as const, field: assertion.field, ref: assertion.objectId }))),
      ...evidence.flatMap((item) => {
        const info = extension(item.data, "ehf.connector");
        return info.page === number && typeof info.page_start === "number" && typeof info.page_end === "number"
          ? [{ start: info.page_start, end: info.page_end, kind: "evidence" as const, field: null, ref: item.object_id }] : [];
      }),
    ].sort((a, b) => a.start - b.start || a.end - b.end);
    const regions = Array.isArray(source.regions) ? source.regions.map(record) : [];
    const located = highlights.map(highlight => {
      const region = geometry ? regions.find(region => Number(region.start) <= highlight.start && Number(region.end) >= highlight.end) : null;
      const bbox = region?.bbox;
      if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite) || !geometry) return highlight;
      const [x, y, right, bottom] = bbox as number[];
      if (x! < 0 || y! < 0 || right! <= x! || bottom! <= y! || right! > geometry.width || bottom! > geometry.height) return highlight;
      return { ...highlight, rect: { x: x!, y: y!, width: right! - x!, height: bottom! - y! } };
    });
    return { page: number, text: String(page.data.text), offsetBasis: "unicode_code_points" as const, highlights: located, ...(geometry ? { geometry } : {}) };
  });
  const conflicts = (outputs.conflicts ?? []).filter((conflict) => conflict.values.some((value) => value.document_version === sha))
    .map((conflict) => ({ field: conflict.field, values: conflict.values.map((value) => ({ documentVersion: value.document_version, value: value.value, normalized: value.normalized })) }));
  // The document's own work items: those naming one of its assertions, and those whose question names its version.
  const ids = new Set(assertions.map(assertion => assertion.objectId));
  const workItems = (context.workItems ?? []).filter(item => DOCUMENT_WORK_TYPES.has(item.work_type)
    && (item.subject_ref ? ids.has(item.subject_ref) : typeof item.description === "string" && item.description.includes(sha.slice(0, 12))))
    .map(item => ({ workItemId: item.work_item_id, workType: item.work_type, status: item.status, description: item.description ?? null,
      assertionId: item.subject_ref && ids.has(item.subject_ref) ? item.subject_ref : null, createdAt: new Date(item.created_at).toISOString() }))
    .sort((a, b) => (a.status === "OPEN" ? 0 : 1) - (b.status === "OPEN" ? 0 : 1) || a.createdAt.localeCompare(b.createdAt) || a.workItemId.localeCompare(b.workItemId));
  const summary = summarize(version, records, outputs, context);
  return { document: summary, pages, assertions, conflicts, workItems, review: summary.reviewPending ? null : latestReview(context, documentId, sha, null, null), ...(context.caseSequence !== undefined ? { caseSequence: context.caseSequence } : {}) };
}

/** Citation links for an authorized viewer. Keep the source text, field values and reviews out of the preview. */
export function documentCitationPreview(detail: CaseDocumentDetail): components["schemas"]["CaseDocumentCitationPreview"] {
  const evidence = detail.pages.flatMap(page => page.highlights.filter(span => span.kind === "evidence")
    .map(({ start, end, ref }) => ({ page: page.page, start, end, ref })));
  return {
    documentId: detail.document.documentId,
    documentVersion: detail.document.documentVersion,
    evidence: evidence.slice(0, 12),
    assertions: detail.assertions.slice(0, 20).map(assertion => ({
      field: assertion.field, verification: assertion.verification,
      spans: assertion.spans.slice(0, 10).map(({ page, start, end }) => ({ page, start, end, ref: assertion.objectId })),
    })),
    truncated: evidence.length > 12 || detail.assertions.length > 20 || detail.assertions.slice(0, 20).some(assertion => assertion.spans.length > 10),
  };
}
