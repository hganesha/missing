import { clone, type Rec } from "../fixtures.js";
import { type Ctx, fail, type Impl, notFound, ok, page } from "../http.js";
import { nextId } from "../state.js";

const TERMINAL = new Set(["completed", "denied", "failed", "cancelled"]);
const RUN_ATTRIBUTE = "run_kyb_1042";

/** Run records: the scenario run (live from the store) plus runs started in this session. */
function runRecords(ctx: Ctx): Rec[] {
  ctx.state.platform.startedRuns ??= [];
  return [ctx.state.store.run as Rec, ...(ctx.state.platform.startedRuns as Rec[])];
}

function runRecord(ctx: Ctx, runId: string): Rec | undefined {
  return runRecords(ctx).find((run) => run.runId === runId);
}

/**
 * RunSummary view for a run record. The view's RunStatus has no "cancelled" (the record's
 * runStatus does), so a cancelled run is shown as failed with terminalOutcome "cancelled"
 * (CONTRACT-GAPS GAP-018).
 */
function summary(ctx: Ctx, run: Rec): Rec {
  const harness = (ctx.state.platform.harnesses as Rec[]).find((entry) => entry.planDigest === run.planDigest) ?? (ctx.state.platform.harnesses as Rec[])[0]!;
  const base = (ctx.state.platform.runs as Rec[]).find((entry) => entry.runId === run.runId);
  const cancelled = run.status === "cancelled";
  return {
    ...(base ? clone(base) : {}),
    attempt: run.attempt,
    capabilityCalls: run.capabilityCalls,
    cost: { complete: run.costComplete, reportedUsd: run.costUsd },
    currentNodeId: run.currentNodeId,
    domain: harness.domain,
    durationMs: run.completedAt && run.startedAt ? Date.parse(run.completedAt) - Date.parse(run.startedAt) : null,
    fencingEpoch: run.fencingEpoch,
    fixture: true,
    harnessName: harness.name,
    modelCalls: run.modelCalls,
    modelTiers: harness.modelTiers ?? [],
    needsAttention: ["manual_review", "failed", "denied"].includes(run.status),
    packageVersion: harness.packageVersion,
    planDigest: run.planDigest,
    rootSpanId: run.rootSpanId,
    runId: run.runId,
    startedAt: run.startedAt ?? run.createdAt,
    status: cancelled ? "failed" : run.status,
    terminalOutcome: cancelled ? "cancelled" : run.terminalOutcome,
    traceId: run.traceId,
    traceViewerUrl: run.traceId ? `/platform/traces/${run.traceId}` : null,
    updatedAt: run.updatedAt,
  };
}

function eventsFor(ctx: Ctx, runId: string): Rec[] {
  return runId === ctx.state.store.run.runId ? (ctx.state.store.runEvents as Rec[]) : [];
}

function harnessDetail(ctx: Ctx, harness: Rec): Rec {
  return { ...clone(harness), fixture: true, plan: { ...clone(ctx.state.platform.plan), planDigest: harness.planDigest } };
}

export const runs: Record<string, Impl> = {
  getRunsRunIdExecution: ctx => {
    const run = runRecord(ctx, ctx.params.runId);
    if (!run) return notFound(ctx, "Run");
    const display = ctx.state.platform.plan as Rec;
    const plan = { planDigest: run.planDigest, graph: { nodes: (display.nodes as Rec[]).map(node => ({ id: node.id, name: node.name, kind: node.primitive, summary: node.purpose ?? "", config: { ...(node.agentRef ? { agentRef: node.agentRef } : {}), ...(node.skillRefs?.length ? { skills: node.skillRefs } : {}) } })), edges: (display.edges as Rec[]).map(edge => ({ id: edge.id, from: edge.from, to: edge.to, condition: edge.conditionLabel ?? "" })) } };
    const observed = new Map<string, Rec>();
    for (const event of eventsFor(ctx, run.runId)) {
      if (!event.nodeId || !["node.started", "node.completed", "node.failed"].includes(event.code)) continue;
      const record = observed.get(event.nodeId) ?? { nodeId: event.nodeId, attempt: 1, fencingEpoch: 1, status: "running", startedAt: null, completedAt: null, errorCode: null, inputDigest: null, outputDigest: null, traceId: run.traceId, humanReview: null };
      if (event.code === "node.started") record.startedAt = event.occurredAt;
      else { record.completedAt = event.occurredAt; record.status = event.code === "node.completed" ? "completed" : "failed"; record.errorCode = event.values?.errorCode ?? null; }
      observed.set(event.nodeId, record);
    }
    return ok(ctx, { run: clone(run), plan, attempts: [...observed.values()] });
  },
  getPlans: (ctx) => {
    const query = ctx.url.searchParams.get("query")?.toLowerCase();
    const domain = ctx.url.searchParams.get("domain");
    const items = (ctx.state.platform.harnesses as Rec[]).filter((harness) =>
      (!query || `${harness.name} ${harness.planDigest}`.toLowerCase().includes(query)) && (!domain || harness.domain === domain));
    return ok(ctx, page(ctx, clone(items)));
  },
  postPlans: (ctx) => {
    const digest = String(ctx.body?.planDigest ?? "").replace(/^sha256:/, "");
    if (!/^[a-f0-9]{64}$/.test(digest)) return fail(ctx, 422, "plan.digest_invalid", "The compiled plan has no valid planDigest.");
    const exists = (ctx.state.platform.harnesses as Rec[]).some((harness) => harness.planDigest === digest);
    if (!exists) {
      const base = clone((ctx.state.platform.harnesses as Rec[])[0]!);
      ctx.state.platform.harnesses.push({ ...base, planDigest: digest, name: String(ctx.body?.name ?? base.name), admittedAt: ctx.state.clock, runs: 0, completedRuns: 0, lastRunAt: null });
    }
    return ok(ctx, { planDigest: digest, created: !exists }, 201);
  },
  getPlansPlanDigest: (ctx) => {
    const harness = (ctx.state.platform.harnesses as Rec[]).find((entry) => entry.planDigest === ctx.params.planDigest.replace(/^sha256:/, ""));
    return harness ? ok(ctx, harnessDetail(ctx, harness)) : notFound(ctx, "Plan");
  },
  getPlansPlanDigestRuns: (ctx) => {
    const digest = ctx.params.planDigest.replace(/^sha256:/, "");
    return ok(ctx, page(ctx, runRecords(ctx).filter((run) => run.planDigest === digest).map((run) => summary(ctx, run))));
  },
  getRuns: (ctx) => {
    const status = ctx.url.searchParams.get("status");
    return ok(ctx, page(ctx, runRecords(ctx).map((run) => summary(ctx, run)).filter((run) => !status || run.status === status)));
  },
  postRuns: (ctx) => {
    const key = ctx.request.headers.get("idempotency-key");
    if (!key) return fail(ctx, 400, "request.invalid", "Idempotency-Key is required to start a run.", { issues: [{ path: "header.Idempotency-Key", message: "required" }] });
    const existing = ctx.state.runLog.get(key);
    if (existing) return ok(ctx, existing, 201);
    if (ctx.state.runtimeAdmission.state === "stopped") return fail(ctx, 409, "runtime.admission_stopped", "Run admission is stopped for this environment.");
    const planDigest = String(ctx.body?.planDigest ?? "").replace(/^sha256:/, "");
    if (!(ctx.state.platform.harnesses as Rec[]).some((harness) => harness.planDigest === planDigest)) return notFound(ctx, "Plan");
    const run = {
      ...clone(ctx.state.store.run),
      runId: nextId(ctx.state, "run"),
      idempotencyKey: key,
      planDigest,
      status: "queued",
      terminalOutcome: null,
      input: clone(ctx.body?.input ?? {}),
      output: null,
      currentNodeId: null,
      latestCheckpointId: null,
      errorCode: null,
      traceId: null,
      rootSpanId: null,
      traceFlags: null,
      costUsd: 0,
      costComplete: true,
      modelCalls: 0,
      capabilityCalls: 0,
      createdAt: ctx.state.clock,
      startedAt: null,
      completedAt: null,
      updatedAt: ctx.state.clock,
    };
    ctx.state.platform.startedRuns.push(run);
    ctx.state.runLog.set(key, run);
    return ok(ctx, run, 201);
  },
  getRunsRunId: (ctx) => {
    const run = runRecord(ctx, ctx.params.runId);
    if (!run) return notFound(ctx, "Run");
    const harness = (ctx.state.platform.harnesses as Rec[]).find((entry) => entry.planDigest === run.planDigest) ?? (ctx.state.platform.harnesses as Rec[])[0]!;
    const events = eventsFor(ctx, run.runId).map((event) => ({
      attempt: run.attempt,
      code: event.code,
      details: clone(event.values ?? {}),
      durationMs: null,
      fencingEpoch: run.fencingEpoch,
      id: `${run.runId}:${event.sequence}`,
      isKnownCode: /^(run|node|capability|checkpoint|human)\./.test(event.code),
      nodeId: event.nodeId,
      occurredAt: event.occurredAt,
      runId: run.runId,
      sequence: event.sequence,
      status: event.status,
      summary: `${event.code}${event.nodeId ? ` · ${event.nodeId}` : ""}`,
    }));
    return ok(ctx, {
      ...summary(ctx, run),
      events,
      failureInfo: null,
      idempotencyKey: run.idempotencyKey,
      inputPayload: clone(run.input ?? {}),
      nodeAttempts: {},
      plan: harnessDetail(ctx, harness).plan,
      recentEventsPreview: events.slice(-3).reverse().map((event) => ({ code: event.code, occurredAt: event.occurredAt, sequence: event.sequence, summary: event.summary })),
    });
  },
  postRunsRunIdCancel: (ctx) => {
    const run = runRecord(ctx, ctx.params.runId);
    if (!run) return notFound(ctx, "Run");
    // Upstream answers 409 run.already_terminal (control-api app.ts), as the contract declares.
    if (TERMINAL.has(run.status)) return fail(ctx, 409, "run.already_terminal", `Run ${run.runId} is already ${run.status}.`);
    Object.assign(run, { status: "cancelled", terminalOutcome: "cancelled", completedAt: ctx.state.clock, updatedAt: ctx.state.clock });
    return ok(ctx, { outcome: "CANCELLED", run: clone(run) });
  },
  getRunsRunIdEvents: (ctx) => {
    if (!runRecord(ctx, ctx.params.runId)) return notFound(ctx, "Run");
    const after = Number(ctx.url.searchParams.get("after") ?? 0) || 0;
    const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? 100) || 100, 500);
    const events = eventsFor(ctx, ctx.params.runId).filter((event) => event.sequence > after);
    const slice = events.slice(0, limit);
    return ok(ctx, { events: clone(slice), nextCursor: events.length > limit ? String(slice.at(-1)!.sequence) : null });
  },
  getRunsRunIdAttempts: (ctx) => {
    const run = runRecord(ctx, ctx.params.runId);
    if (!run) return notFound(ctx, "Run");
    return ok(ctx, { runId: run.runId, attempts: [{ attempt: run.attempt, fencingEpoch: run.fencingEpoch, status: run.status, startedAt: run.startedAt }] });
  },
  getRunsRunIdTrace: (ctx) => {
    const run = runRecord(ctx, ctx.params.runId);
    if (!run) return notFound(ctx, "Run");
    if (!run.traceId) return fail(ctx, 404, "trace.not_bound", "No trace is bound to this run.");
    return ok(ctx, { traceId: run.traceId, rootSpanId: run.rootSpanId, traceFlags: run.traceFlags == null ? null : String(run.traceFlags) });
  },
  getTracesTraceId: (ctx) => {
    // Authority first: a trace is only visible through a run the caller may read; an unknown
    // or unauthorised trace is 404 either way, so existence does not leak.
    const trace = ctx.state.platform.trace as Rec;
    if (ctx.params.traceId !== trace.traceId) return notFound(ctx, "Trace");
    // Synthetic span attributes, including fields a UI must never render (cookie,
    // authorization, bodies), so the trace view's allow-list is exercised (PLT-08 AC2).
    const spans = (clone(trace.spans) as Rec[]).map((span, index) => ({
      ...span,
      tags: {
        "span.kind": index === 0 ? "server" : "internal",
        "ehf.run_id": RUN_ATTRIBUTE,
        ...(index === 0 ? { "http.request.method": "POST", "http.route": "/v1/runs", "http.response.status_code": 202 } : {}),
        ...(index === 2 ? { "ehf.capability_id": "registry.lookup", "otel.status_code": "OK" } : {}),
        "http.request.header.cookie": "SYNTHETIC-SECRET-cookie",
        "http.request.header.authorization": "SYNTHETIC-SECRET-bearer",
        "http.request.body": "SYNTHETIC-SECRET-body",
        ...(span.tags as Rec),
      },
    }));
    return ok(ctx, { ...clone(trace), backend: "jaeger", status: "available", spans, generatedAt: ctx.state.clock });
  },
};
