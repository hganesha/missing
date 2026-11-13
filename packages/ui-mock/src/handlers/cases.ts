import { applicationCaseType, applicationSubmissionSchema, mapApplicationSubmission, sha256Hex } from "@ehf/contracts/application-intake";
import { CATALOG_SNAPSHOT } from "./catalogs.js";
import { clone, RECORDS, type Rec } from "../fixtures.js";
import { type Ctx, fail, type Impl, notFound, ok, page, raw, stableJson } from "../http.js";
import { selectCasePlan } from "../case-plans.js";
import { caseSequence, resolveContradiction } from "../scenario.js";

/** Deterministic 64-hex digest for synthetic ledger values. */
export function hex64(seed: string): string {
  let out = "";
  let hash = 2166136261;
  while (out.length < 64) {
    for (let index = 0; index < seed.length; index += 1) {
      hash ^= seed.charCodeAt(index) + out.length;
      hash = Math.imul(hash, 16777619);
    }
    out += (hash >>> 0).toString(16).padStart(8, "0");
  }
  return out.slice(0, 64);
}

const REVIEW_COMMANDS = new Set(["FinalizeDisposition", "RecordReview"]);
const EXPORT_DIGEST = (caseId: string, sequence: number) => hex64(`export:${caseId}:${sequence}`);

function caseOf(ctx: Ctx): Rec | undefined {
  const summary = ctx.state.store.caseSummary as Rec;
  if (ctx.params.caseId === summary.caseId) return summary;
  return (ctx.state.platform.createdCases as Rec[] | undefined)?.find((entry) => entry.caseId === ctx.params.caseId);
}

function caseEtag(ctx: Ctx): string {
  return `"seq-${caseSequence(ctx.state)}"`;
}

function eventDigest(caseId: string, sequence: number): string {
  return hex64(`event:${caseId}:${sequence}`);
}

export const cases: Record<string, Impl> = {
  getCases: (ctx) => {
    const status = ctx.url.searchParams.get("status");
    const query = ctx.url.searchParams.get("query")?.toLowerCase();
    const planDigest = ctx.url.searchParams.get("planDigest");
    const all = [ctx.state.store.caseSummary as Rec, ...((ctx.state.platform.createdCases as Rec[] | undefined) ?? [])];
    const items = all.filter((entry) => (!status || entry.status === status)
      && (!planDigest || entry.harnessPlanDigest === planDigest.replace(/^sha256:/, ""))
      && (!query || `${entry.caseId} ${entry.externalRef}`.toLowerCase().includes(query)));
    return ok(ctx, page(ctx, clone(items)));
  },
  postCasePlansSelect: (ctx) => {
    const selection = selectCasePlan(ctx.body);
    if (selection.status !== 200) return fail(ctx, selection.status, selection.error, selection.message, selection.candidates.length ? { candidates: selection.candidates } : undefined);
    return ok(ctx, selection.body);
  },
  postCases: (ctx) => {
    ctx.state.platform.createdCases ??= [];
    const harnessPlanDigest = String(ctx.body?.harnessPlanDigest ?? "").replace(/^sha256:/, "");
    // Opened by its scope, the BFF re-selects the plan and pins its pack in the scope's jurisdiction;
    // otherwise the plan's single policy pin applies, in US.
    let jurisdiction = "US";
    let caseType = String(ctx.body?.caseType ?? "KYB");
    if (ctx.body?.scope !== undefined) {
      const selection = selectCasePlan(ctx.body.scope);
      if (selection.status !== 200) return fail(ctx, selection.status, selection.error, selection.message, selection.candidates.length ? { candidates: selection.candidates } : undefined);
      if (selection.body.planDigest !== harnessPlanDigest) return fail(ctx, 409, "case.plan_selection_changed", "The released plan for this scope changed since it was shown. Review the selection and create the case again.");
      jurisdiction = ctx.body.scope.jurisdiction;
      // As the BFF does: the case type follows the scope's customer type.
      caseType = applicationCaseType(ctx.body.scope.customerType).caseType;
    }
    const caseId = `KYB-${2000 + ctx.state.platform.createdCases.length + 1}`;
    ctx.state.platform.createdCases.push({
      tenantId: ctx.session.tenant.tenantId, caseId, caseType, jurisdiction, status: "INTAKE", caseSequence: 1,
      externalRef: String(ctx.body?.externalRef ?? caseId), harnessPlanDigest,
      classification: String(ctx.body?.classification ?? "confidential"), createdAt: ctx.state.clock, updatedAt: ctx.state.clock,
    });
    return ok(ctx, { caseId, caseSequence: 1 }, 201);
  },
  /**
   * Application intake (the BFF's postApplications composition): select the plan for the scope, open
   * a KYB case for a business or trust (KYC for a person) and record its subjects and canonical
   * records, mapped exactly as the BFF maps them. Keyed by the Idempotency-Key: a retry answers as
   * the original did; the same key with a different application conflicts.
   */
  postApplications: (ctx) => {
    const key = ctx.request.headers.get("idempotency-key") ?? "";
    if (key.length < 8) return fail(ctx, 400, "application.idempotency_key_required", "Send an Idempotency-Key with the application.");
    const parsed = applicationSubmissionSchema.safeParse(ctx.body);
    if (!parsed.success) {
      return fail(ctx, 400, "application.request_invalid", "The application is not valid.", { issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code, message: issue.message })) });
    }
    const submission = parsed.data;
    const documentTypes = new Set(CATALOG_SNAPSHOT.entries.filter((entry) => entry.kind === "documents" && entry.entryType === "definition").map((entry) => entry.id));
    const unknown = submission.documents.flatMap((document, index) => documentTypes.has(document.documentType) ? [] : [{ path: `documents.${index}.documentType`, code: "custom", message: "application.document_type_unknown" }]);
    if (unknown.length) return fail(ctx, 400, "application.request_invalid", "A document type is not in the document field catalog.", { issues: unknown });
    const selection = selectCasePlan(submission.scope);
    if (selection.status !== 200) return fail(ctx, selection.status, selection.error, selection.message, selection.candidates.length ? { candidates: selection.candidates } : undefined);
    const planDigest = String(selection.body.planDigest);
    if (submission.harnessPlanDigest !== undefined && submission.harnessPlanDigest.replace(/^sha256:/, "") !== planDigest) {
      return fail(ctx, 409, "case.plan_selection_changed", "The released plan for this scope changed since it was shown. Review the selection and submit again.");
    }
    const intakes = (ctx.state.platform.applicationIntakes ??= {}) as Record<string, { digest: string; response: Rec }>;
    const digest = stableJson(submission);
    const prior = intakes[key];
    if (prior) return prior.digest === digest ? ok(ctx, clone(prior.response), 201) : fail(ctx, 409, "command.idempotency_conflict", "This Idempotency-Key was used for a different application.");
    ctx.state.platform.createdCases ??= [];
    // Documents become content-addressed case evidence, as case-api registers an upload.
    const documents = submission.documents.map((document) => {
      const sha256 = sha256Hex(Uint8Array.from(atob(document.contentBase64), (char) => char.charCodeAt(0)));
      return { evidenceId: `evidence_${sha256.slice(0, 16)}`, artifactRef: `artifact://mock/${sha256}`, sha256 };
    });
    const intake = mapApplicationSubmission(submission, { tenantId: ctx.session.tenant.tenantId, observedAt: ctx.state.clock, documents });
    const caseId = `${intake.caseType === "kyb_onboarding" ? "KYB" : "KYC"}-${2000 + ctx.state.platform.createdCases.length + 1}`;
    ctx.state.platform.createdCases.push({
      tenantId: ctx.session.tenant.tenantId, caseId, caseType: intake.caseType, jurisdiction: submission.scope.jurisdiction, status: "INTAKE",
      caseSequence: 1 + intake.subjects.length + Math.ceil(intake.records.length / 200),
      externalRef: submission.externalRef ?? caseId, harnessPlanDigest: planDigest, classification: submission.classification,
      createdAt: ctx.state.clock, updatedAt: ctx.state.clock,
    });
    ((ctx.state.platform.applicationRecords ??= {}) as Rec)[caseId] = { subjects: intake.subjects, records: intake.records };
    const pack = selection.body.pack as Rec;
    const response = { caseId, caseType: intake.caseType, planDigest, pack: { id: pack.id, scope: clone(pack.scope) }, subjectsAdded: intake.subjects.length, documentsUploaded: documents.length, recordsRecorded: intake.records.length,
      // The mock configures no document-only extraction plan, so each upload is named as not started.
      documentRuns: documents.map((document) => ({ documentId: `doc_${document.sha256.slice(0, 24)}`, status: "NOT_STARTED" as const, reason: "document.extraction_plan_not_configured" })) };
    intakes[key] = { digest, response };
    return ok(ctx, clone(response), 201);
  },
  getCasesCaseId: (ctx) => {
    const summary = caseOf(ctx);
    if (!summary) return notFound(ctx, "Case");
    const store = ctx.state.store;
    const own = summary === store.caseSummary;
    const events = own ? (store.caseEvents as Rec[]) : [];
    const activities = events.map((event) => ({
      actorLabel: `${event.actor.type.toLowerCase()} · ${event.actor.principalId}`,
      authority: {},
      eventDigest: eventDigest(summary.caseId, event.sequence),
      eventId: `${summary.caseId}:${event.sequence}`,
      eventType: event.commandType,
      evidenceRefs: [],
      occurredAt: event.occurredAt,
      payload: { summary: event.summary },
      previousEventDigest: event.sequence > 1 ? eventDigest(summary.caseId, event.sequence - 1) : null,
      sequence: event.sequence,
    }));
    const workItems = own ? (store.workItems as Rec[]) : [];
    const subject = own ? store.snapshot.data.subject : null;
    const nodes = [
      { id: summary.caseId, label: summary.externalRef, subtitle: summary.caseType, category: "Case", status: summary.status, data: clone(summary) },
      ...(subject ? [{ id: `subject:${subject.subjectId}`, label: subject.name, subtitle: subject.kind, category: "Subject", data: clone(subject) }] : []),
      ...workItems.map((item) => ({ id: item.workItemId, label: item.objective, subtitle: item.workType, category: "Work", status: item.status, data: { workItemId: item.workItemId } })),
    ];
    const edges = nodes.slice(1).map((node, index) => ({ id: `edge-${index + 1}`, from: summary.caseId, to: node.id, label: node.category === "Subject" ? "HAS_SUBJECT" : "HAS_WORK" }));
    const latest = activities.at(-1)?.sequence ?? summary.caseSequence;
    return ok(ctx, {
      generatedAt: ctx.state.clock,
      viewSchema: "harness.factory/case-detail-view-v1",
      etag: `seq-${summary.caseSequence}`,
      case: clone(summary),
      counts: own ? clone(ctx.state.fin.caseRoom.counts) : {},
      graph: { nodes, edges, categories: ["Case", "Subject", "Work"].filter((category) => nodes.some((node) => node.category === category)) },
      activities,
      executionRefs: own ? [{ run_id: store.run.runId }] : [],
      ledger: { eventCount: activities.length, latestSequence: latest, headDigest: activities.length ? eventDigest(summary.caseId, latest) : null, valid: true, checkedEvents: activities.length, failedSequence: null },
    }, 200, { etag: own ? caseEtag(ctx) : `"seq-${summary.caseSequence}"` });
  },
  getCasesCaseIdBusinessDecisionsDecisionId: (ctx) => fail(ctx,404,"policy.not_available","This archived scenario has no v2 policy decision."),
  getCasesCaseIdSnapshot: (ctx) => (caseOf(ctx) === ctx.state.store.caseSummary ? ok(ctx, clone(ctx.state.store.snapshot), 200, { etag: caseEtag(ctx) }) : notFound(ctx, "Case snapshot")),
  getCasesCaseIdEvents: (ctx) => {
    if (caseOf(ctx) !== ctx.state.store.caseSummary) return notFound(ctx, "Case");
    const after = Number(ctx.url.searchParams.get("after") ?? 0) || 0;
    const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? 100) || 100, 500);
    const events = (ctx.state.store.caseEvents as Rec[]).filter((event) => event.sequence > after);
    const slice = events.slice(0, limit);
    return ok(ctx, { events: clone(slice), nextCursor: events.length > limit ? String(slice.at(-1)!.sequence) : null }, 200, { etag: caseEtag(ctx) });
  },
  postCasesCaseIdCommands: (ctx) => {
    if (caseOf(ctx) !== ctx.state.store.caseSummary) return notFound(ctx, "Case");
    const body = (ctx.body ?? {}) as Rec;
    const commandType = String(body.commandType ?? "");
    // x-action "case.write | case.review (FinalizeDisposition, RecordReview)": by command type.
    const action = REVIEW_COMMANDS.has(commandType) ? "case.review" : "case.write";
    if (!ctx.session.actions.includes(action)) return fail(ctx, 403, "authorization.role_missing", `Your role does not permit ${commandType}. Requires ${action}.`, { actor: ctx.subject });
    const key = String(body.idempotencyKey ?? "");
    const prior = ctx.state.commandLog.get(key);
    if (prior) {
      if (prior.body === stableJson(body)) return ok(ctx, prior.receipt);
      return fail(ctx, 409, "case.command_idempotency_conflict", "This idempotency key was already used for a different command.");
    }
    const commandId = `cmd_${ctx.state.store.caseSummary.caseId}_${ctx.state.commandLog.size + 100}`;
    const current = caseSequence(ctx.state);
    let receipt: Rec;
    if (body.preconditions?.caseSequence !== current) {
      receipt = { outcome: "CONFLICT", commandId, caseSequence: current, reasonCode: "case.sequence_conflict", eventIds: [] };
    } else if (commandType === "RecordPolicyEvaluation") {
      return fail(ctx, 403, "policy.evaluator_endpoint_required", "Policy evaluations are recorded by the policy evaluator, not as a command.");
    } else if (commandType === "ResolveContradiction") {
      const actor = { type: "HUMAN", principalId: ctx.subject, roles: ctx.session.roles };
      const result = resolveContradiction(ctx.state, String(body.payload?.contradictionId ?? ""), { ...body, actor });
      receipt = result
        ? { outcome: "ACCEPTED", commandId, caseSequence: result.sequence, reasonCode: null, eventIds: [`${ctx.state.store.caseSummary.caseId}:${result.sequence}`] }
        : { outcome: "REJECTED", commandId, caseSequence: current, reasonCode: "case.contradiction_not_open", eventIds: [] };
    } else {
      receipt = { outcome: "ACCEPTED", commandId, caseSequence: current, reasonCode: null, eventIds: [] };
    }
    ctx.state.commandLog.set(key, { body: stableJson(body), receipt });
    return ok(ctx, receipt);
  },
  postCasesCaseIdExports: (ctx) => {
    const summary = caseOf(ctx);
    if (!summary) return notFound(ctx, "Case");
    return ok(ctx, { digest: EXPORT_DIGEST(summary.caseId, summary.caseSequence), caseSequence: summary.caseSequence }, 201);
  },
  getCasesCaseIdExportsDigestFormat: (ctx) => {
    const summary = caseOf(ctx);
    if (!summary) return notFound(ctx, "Case");
    if (!/^[a-f0-9]{64}$/.test(ctx.params.digest)) return fail(ctx, 400, "request.invalid", "Export digest must be 64 hex characters.");
    const format = ctx.params.format;
    const name = `${summary.caseId}-audit.${format}`;
    if (format === "json") return raw(ctx, JSON.stringify({ caseId: summary.caseId, caseSequence: summary.caseSequence, events: ctx.state.store.caseEvents, synthetic: true }), "application/json", 200, { "content-disposition": `attachment; filename="${name}"` });
    if (format === "html") return raw(ctx, `<!doctype html><title>${summary.caseId} audit export</title><p>Synthetic audit export</p>`, "text/html", 200, { "content-disposition": `attachment; filename="${name}"` });
    if (format === "pdf") return raw(ctx, "%PDF-1.4\n% synthetic audit export\n", "application/pdf", 200, { "content-disposition": `attachment; filename="${name}"` });
    return fail(ctx, 400, "request.invalid", "Export format must be json, html or pdf.");
  },
  postCasesCaseIdLedgerVerify: (ctx) => {
    const summary = caseOf(ctx);
    if (!summary) return notFound(ctx, "Case");
    const events = summary === ctx.state.store.caseSummary ? (ctx.state.store.caseEvents as Rec[]) : [];
    const last = events.at(-1)?.sequence;
    return ok(ctx, { verified: true, checkedEvents: events.length, headDigest: last ? eventDigest(summary.caseId, last) : null, failedSequence: null });
  },
  getEvidenceEvidenceId: (ctx) => {
    const record = RECORDS.find((entry) => entry.id === ctx.params.evidenceId);
    return record ? ok(ctx, clone(record)) : notFound(ctx, "Evidence");
  },
};
