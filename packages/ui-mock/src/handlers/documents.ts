import { caseDocumentDetail, caseDocuments, documentCitationPreview, type CanonicalRecordView, type DocumentSkillOutputs, type DocumentReviewRecord, type DocumentWorkItemRecord } from "@ehf/fincrime-views";
import { validatorFor } from "@ehf/ui-contracts/validate";
import fixture from "@ehf/fincrime-views/fixtures/documents.kyb-1042.json" with { type: "json" };
import { clone, type Rec } from "../fixtures.js";
import { type Ctx, fail, type Impl, notFound, ok } from "../http.js";

/**
 * Case documents (EHF document intelligence). The views come from the same projection the BFF uses
 * (@ehf/fincrime-views) over records generated from the document catalog's golden examples, so the
 * mock and the BFF cannot disagree about what a document view means.
 */
const records = (fixture as { records: CanonicalRecordView[] }).records;
const outputs = (fixture as { outputs: DocumentSkillOutputs }).outputs;
const fixtureWorkItems = (fixture as { workItems: DocumentWorkItemRecord[] }).workItems;

function uploads(ctx: Ctx): Rec[] {
  const fin = ctx.state.fin as Rec & { documentUploads?: Rec[] };
  fin.documentUploads ??= [];
  return fin.documentUploads;
}
function reviews(ctx: Ctx): DocumentReviewRecord[] { ctx.state.fin.documentReviews ??= []; return ctx.state.fin.documentReviews as DocumentReviewRecord[]; }
/** The fixture's document work items, with any this session's reviews resolved (as the case store completes them). */
function workItems(ctx: Ctx): DocumentWorkItemRecord[] {
  const resolved = (ctx.state.fin.documentResolvedWorkItems ??= []) as string[];
  return fixtureWorkItems.map(item => resolved.includes(item.work_item_id) ? { ...item, status: "COMPLETED" } : item);
}
const context = (ctx: Ctx) => ({ caseSequence: Number(ctx.state.store.caseSummary.caseSequence), reviews: reviews(ctx), workItems: workItems(ctx) });
function detailFor(ctx: Ctx) { return caseDocumentDetail(ctx.params.documentId!, records, outputs, context(ctx), ctx.url.searchParams.get("version") ?? undefined); }

function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return crypto.subtle.digest("SHA-256", bytes).then((digest) => Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""));
}

export const documents: Record<string, Impl> = {
  getFincrimeCasesCaseIdDocuments: (ctx) => {
    if (ctx.params.caseId !== ctx.state.store.caseSummary.caseId) return notFound(ctx, "Case");
    const view = caseDocuments(ctx.params.caseId!, records, outputs, context(ctx));
    // Uploaded in this session: stored, not yet parsed, classified or extracted.
    const uploaded = uploads(ctx).map((item) => ({
      documentId: item.documentId, documentVersion: item.sha256, filename: item.filename, mediaType: item.mediaType, pageCount: 0,
      documentType: null, classificationBasis: null, extractionStatus: "NOT_EXTRACTED", validity: null,
      assertionCount: 0, reviewPending: 0, conflicts: 0, synthetic: true,
    }));
    return ok(ctx, { ...view, documents: [...view.documents, ...uploaded] }, 200, { etag: `"docs-${uploads(ctx).length}"` });
  },
  getFincrimeCasesCaseIdDocumentsDocumentId: (ctx) => {
    if (ctx.params.caseId !== ctx.state.store.caseSummary.caseId) return notFound(ctx, "Case");
    const detail = detailFor(ctx);
    if (detail) return ok(ctx, detail);
    if (uploads(ctx).some((item) => item.documentId === ctx.params.documentId)) {
      const item = uploads(ctx).find(item => item.documentId === ctx.params.documentId)!;
      return ok(ctx, { document: { documentId: item.documentId, documentVersion: item.sha256, filename: item.filename, mediaType: item.mediaType, pageCount: 0, documentType: null, classificationBasis: null, extractionStatus: "NOT_EXTRACTED", validity: null, assertionCount: 0, reviewPending: 0, conflicts: 0, synthetic: true }, pages: [], assertions: [], conflicts: [], caseSequence: context(ctx).caseSequence });
    }
    return notFound(ctx, "Document");
  },
  getFincrimeCasesCaseIdDocumentsDocumentIdCitations: ctx => {
    if (ctx.params.caseId !== ctx.state.store.caseSummary.caseId) return notFound(ctx, "Case");
    const detail = detailFor(ctx);
    return detail ? ok(ctx, documentCitationPreview(detail)) : notFound(ctx, "Document version");
  },
  postFincrimeCasesCaseIdDocuments: async (ctx) => {
    if (ctx.params.caseId !== ctx.state.store.caseSummary.caseId) return notFound(ctx, "Case");
    if (!(ctx.session.actions as string[]).includes("evidence.write")) return fail(ctx, 403, "authorization.role_missing", "Uploading a document needs evidence.write.");
    const body = ctx.body as { filename: string; mediaType: string; contentBase64: string; documentType?: string };
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = Uint8Array.from(atob(body.contentBase64), (char) => char.charCodeAt(0));
    } catch {
      return fail(ctx, 400, "document.request_invalid", "contentBase64 is not valid base64.");
    }
    const sha256 = await sha256Hex(bytes);
    const result = { documentId: `doc_${sha256.slice(0, 24)}`, sha256, filename: body.filename, mediaType: body.mediaType,
      documentType: body.documentType ?? null, status: "UPLOADED_UNPARSED", evidenceId: `ev_mock_${sha256.slice(0, 16)}` };
    if (!uploads(ctx).some((item) => item.documentId === result.documentId)) uploads(ctx).push({ ...clone(result), contentBase64: body.contentBase64 });
    return ok(ctx, result, 201);
  },
  getFincrimeCasesCaseIdDocumentsDocumentIdContent: ctx => {
    if (ctx.params.caseId !== ctx.state.store.caseSummary.caseId) return notFound(ctx, "Case");
    const uploaded = uploads(ctx).find(item => item.documentId === ctx.params.documentId);
    if (uploaded) return ok(ctx, { filename: uploaded.filename, mediaType: uploaded.mediaType, contentBase64: uploaded.contentBase64, documentVersion: uploaded.sha256 });
    const detail = detailFor(ctx);
    if (!detail) return notFound(ctx, "Document");
    const text = detail.pages.map(page => page.text).join("\n\n");
    return ok(ctx, { filename: detail.document.filename ?? detail.document.documentId, mediaType: "text/plain", contentBase64: btoa(String.fromCharCode(...new TextEncoder().encode(text))), documentVersion: detail.document.documentVersion });
  },
  postFincrimeCasesCaseIdDocumentsDocumentIdReviews: ctx => {
    if (ctx.params.caseId !== ctx.state.store.caseSummary.caseId) return notFound(ctx, "Case");
    if (!validatorFor("DocumentReviewRequest")(ctx.body)) return fail(ctx, 400, "document.review_invalid", "Review the required fields.");
    const detail = detailFor(ctx), body = ctx.body!;
    if (!detail) return notFound(ctx, "Document");
    ctx.state.fin.documentReviewReceipts ??= {};
    const receiptKey = `${ctx.params.documentId}:${body.idempotencyKey}`;
    const held = ctx.state.fin.documentReviewReceipts[receiptKey];
    if (held) return JSON.stringify(held.body) === JSON.stringify(body) ? ok(ctx, held.receipt) : fail(ctx, 409, "command.idempotency_conflict", "This key was used for a different review.");
    if (detail.document.documentVersion !== body.documentVersion || body.expectedCaseSequence !== context(ctx).caseSequence) return fail(ctx, 409, "document.version_conflict", "The document or case changed. Refresh before reviewing.");
    const seen = new Set();
    for (const entry of body.entries as Rec[]) {
      const assertion = detail.assertions.find(assertion => assertion.objectId === entry.assertionId);
      if (seen.has(entry.assertionId) || entry.assertionId !== null && (!assertion || assertion.versionId !== entry.assertionVersion)) return fail(ctx, 409, "document.assertion_conflict", "This extracted assertion changed.");
      seen.add(entry.assertionId);
      if (entry.outcome === "CORRECTED" && !("correctedValue" in entry)) return fail(ctx, 400, "document.correction_required", "Enter the corrected value.");
      if (entry.assertionId === null && entry.outcome === "CHECKED" && (!detail.assertions.length || detail.assertions.some(assertion => !["CHECKED", "CORRECTED"].includes(assertion.review?.outcome ?? "")))) return fail(ctx, 409, "document.review_incomplete", "Review every field before completing document review.");
    }
    // A route conflict is resolved by a decision on its assertion in the same review (case-store RecordReview).
    for (const workItemId of (body.resolvedWorkItems ?? []) as string[]) {
      const item = detail.workItems?.find(candidate => candidate.workItemId === workItemId);
      if (!item || item.status !== "OPEN") return fail(ctx, 409, "work_item.not_open", "This work item is already resolved.");
      const entry = (body.entries as Rec[]).find(candidate => candidate.assertionId !== null && candidate.assertionId === item.assertionId);
      if (item.workType !== "DOCUMENT_FIELD_CONFLICT" || !entry || entry.outcome === "RESET") return fail(ctx, 409, "document.conflict_resolution_invalid", "Decide the conflicting field in the same review.");
    }
    (ctx.state.fin.documentResolvedWorkItems as string[]).push(...((body.resolvedWorkItems ?? []) as string[]));
    reviews(ctx).push({ review_id: crypto.randomUUID(), object_ref: ctx.params.documentId!, created_at: new Date(Date.parse(ctx.state.clock) + reviews(ctx).length).toISOString(), rationale: body.rationale, reviewer: { principalId: ctx.subject }, details: { documentVersion: body.documentVersion, entries: clone(body.entries) } });
    ctx.state.store.caseSummary.caseSequence += 1;
    const receipt = { outcome: "ACCEPTED", commandId: `review_${crypto.randomUUID()}`, caseSequence: context(ctx).caseSequence, eventIds: [], reasonCode: null };
    ctx.state.fin.documentReviewReceipts[receiptKey] = { body: clone(body), receipt };
    return ok(ctx, receipt);
  },
  postFincrimeCasesCaseIdDocumentsDocumentIdRerun: ctx => {
    if (ctx.params.caseId !== ctx.state.store.caseSummary.caseId) return notFound(ctx, "Case");
    const detail = detailFor(ctx), uploaded = uploads(ctx).find(item => item.documentId === ctx.params.documentId);
    if (!detail && !uploaded) return notFound(ctx, "Document");
    if (ctx.body?.documentVersion !== (detail?.document.documentVersion ?? uploaded?.sha256)) return fail(ctx, 409, "document.version_conflict", "Refresh this document before rerunning.");
    const key = ctx.request.headers.get("idempotency-key");
    if (!key) return fail(ctx, 400, "run.idempotency_key_required", "A rerun needs an idempotency key.");
    ctx.state.fin.documentReruns ??= {};
    const held = ctx.state.fin.documentReruns[key];
    if (held) return held.documentId === ctx.params.documentId ? ok(ctx, { runId: held.runId }) : fail(ctx, 409, "run.idempotency_conflict", "This key belongs to another document.");
    const runId = `run_doc_${crypto.randomUUID()}`;
    ctx.state.platform.startedRuns ??= [];
    ctx.state.platform.startedRuns.push({ ...clone(ctx.state.store.run), runId, status: "queued", terminalOutcome: null, idempotencyKey: key, input: { caseId: ctx.params.caseId, documentId: ctx.params.documentId }, output: null, currentNodeId: null, createdAt: ctx.state.clock, startedAt: null, completedAt: null, updatedAt: ctx.state.clock });
    ctx.state.fin.documentReruns[key] = { documentId: ctx.params.documentId, runId };
    return ok(ctx, { runId });
  },
};
