import { clone, FINCRIME, PERSONAS, persona, SCENARIOS, type Rec, type ScenarioName } from "../fixtures.js";
import { fail, type Impl, ok, raw, sessionFor } from "../http.js";
import { advanceClock, loadScenario, NO_FAULTS, notify, resetState } from "../state.js";
import {catalogIndex} from '@ehf/fincrime-views';
import {tenantCatalogSnapshot} from './catalogs.js';

const MAX_PER_GROUP = 8;

function matches(query: string, ...values: Array<string | null | undefined>): boolean {
  return values.some((value) => value?.toLowerCase().includes(query));
}

export const shell: Record<string, Impl> = {
  // ---- Auth (the BFF's OIDC endpoints; the mock signs the current persona back in) ----
  getAuthLogin: (ctx) => {
    ctx.state.sessionExpired = false;
    notify(ctx.state, "session");
    const returnTo = ctx.url.searchParams.get("returnTo") ?? "/";
    return raw(ctx, `<!doctype html><meta http-equiv="refresh" content="0;url=${encodeURI(returnTo)}">Signed in (mock).`, "text/html");
  },
  getAuthCallback: (ctx) => raw(ctx, "<!doctype html>Signed in (mock).", "text/html"),
  postAuthLogout: (ctx) => {
    ctx.state.sessionExpired = true;
    notify(ctx.state, "session");
    return raw(ctx, "", "text/plain");
  },

  // ---- Session ----
  getSession: (ctx) => ok(ctx, { ...ctx.session, environment: { ...ctx.session.environment } }),

  getSearch: async (ctx) => {
    const query = (ctx.url.searchParams.get("q") ?? "").trim().toLowerCase();
    const store = ctx.state.store;
    const groups: Array<{ kind: string; items: Rec[] }> = [];
    const add = (kind: string, items: Rec[]) => {
      if (items.length) groups.push({ kind, items: items.slice(0, MAX_PER_GROUP) });
    };
    if (query) {
      const sourceSnapshot = await tenantCatalogSnapshot(ctx);
      const summary = store.caseSummary;
      if (ctx.session.actions.includes("case.read") && matches(query, summary.caseId, summary.externalRef, store.snapshot.data?.subject?.name)) {
        add("case", [{ id: summary.caseId, title: `${summary.caseId} · ${store.snapshot.data?.subject?.name ?? summary.externalRef}`, subtitle: summary.status, route: `/work/cases/${summary.caseId}` }]);
      }
      if (ctx.session.actions.includes("human_work.read")) {
        add("work_item", (store.humanQueue as Rec[]).filter((item) => matches(query, item.workItem.workItemId, item.workItem.objective, item.workItem.caseId))
          .map((item) => ({ id: item.workItem.workItemId, title: item.workItem.objective, subtitle: item.workItem.caseId, route: `/platform/human-work?item=${item.workItem.workItemId}` })));
      }
      if (ctx.session.actions.includes("run.read") && matches(query, store.run.runId)) {
        add("run", [{ id: store.run.runId, title: store.run.runId, subtitle: store.run.status, route: `/platform/runs/${store.run.runId}` }]);
      }
      if (ctx.session.actions.includes("plan.read")) {
        add("plan", (ctx.state.platform.harnesses as Rec[]).filter((plan) => matches(query, plan.name, plan.planDigest))
          .map((plan) => ({ id: plan.planDigest, title: plan.name, subtitle: plan.packageVersion, route: `/platform/plans/${plan.planDigest}` })));
      }
      if (ctx.session.actions.includes("draft.read")) {
        add("draft", (ctx.state.platform.drafts as Rec[]).filter((draft) => matches(query, draft.name, draft.draftId))
          .map((draft) => ({ id: draft.draftId, title: draft.name, subtitle: draft.status, route: `/platform/drafts/${draft.draftId}` })));
        const catalog = FINCRIME.catalog as Rec;
        add("task", (catalog.tasks as Rec[]).filter((task) => matches(query, task.id, task.objective))
          .map((task) => ({ id: task.id, title: `${sourceSnapshot.entries.find(entry=>entry.kind==='agents'&&entry.id===task.agent_profile)?.title??task.id} task`, subtitle: task.objective, route: `/agents/${task.agent_profile}/tasks/${task.id}` })));
      }
      const groupNames = {context:'context_product',skills:'skill',agents:'agent','external-capabilities':'external_capability',policies:'policy',documents:'document_type',products:'product'};
      const snapshot = await tenantCatalogSnapshot(ctx);
      const found=catalogIndex(snapshot,ctx.session.actions,{q:query,limit:100});
      for(const board of found.boards) add(groupNames[board.kind],catalogIndex(snapshot,ctx.session.actions,{kind:board.kind,q:query,limit:MAX_PER_GROUP}).items.map(item=>({id:item.id,title:item.title,subtitle:item.group,route:`/catalogs/${item.kind}?selected=${encodeURIComponent(item.id)}&inventory=${item.entryType}`})));
      if (ctx.session.actions.includes("release.read")) {
        add("release", (store.releases as Rec[]).filter((release) => matches(query, release.releaseId))
          .map((release) => ({ id: release.releaseId, title: release.releaseId, subtitle: release.status, route: `/platform/releases?release=${release.releaseId}` })));
      }
    }
    return ok(ctx, { query, groups });
  },

  // ---- Shell aggregations ----
  getOverview: (ctx) => ok(ctx, { ...clone(ctx.state.platform.overview), generatedAt: ctx.state.clock, telemetryFreshThrough: ctx.state.clock }),
  getSystem: (ctx) => ok(ctx, { ...clone(ctx.state.platform.system), generatedAt: ctx.state.clock, telemetryFreshThrough: ctx.state.clock }),
  // Synthetic connection health: one of each status, so every state of the screen can be seen.
  getPlatformHealth: (ctx) => {
    const row = (id: string, name: string, group: string, reportedBy: string, status = "Ready", detail = "Responding.", latencyMs: number | null = 12) => ({ id, name, group, status, detail, latencyMs, reportedBy });
    const components = [
      row("experience-bff", "Experience API", "service", "experience-bff", "Ready", "Serving this request.", 0),
      row("control-api", "Control plane API", "service", "experience-bff"),
      row("case-api", "Case API", "service", "experience-bff"),
      row("capability-gateway", "Capability gateway", "service", "experience-bff"),
      row("control-store", "Control store (PostgreSQL)", "store", "control-api", "Ready", "Responding.", 3),
      row("context-store", "Context store (PostgreSQL, pgvector, AGE)", "store", "control-api", "Ready", "Responding.", 4),
      row("case-store", "Case store (PostgreSQL)", "store", "case-api", "Ready", "Responding.", 3),
      row("evidence-store", "Evidence store (object storage)", "store", "case-api", "Ready", "Reachable; immutability enforced.", 41),
      row("runtime-host", "Agent runtime host", "runtime", "control-api", "Ready", "Responding.", 9),
      row("skill-host", "Skill runtime (skill host)", "endpoint", "capability-gateway", "Unavailable", "No response within 5 seconds.", 5000),
      row("evidence-pipeline", "Document intelligence (evidence pipeline)", "endpoint", "capability-gateway", "NotConfigured", "Not configured in this deployment.", null),
      row("kyc-wiring", "KYC provider wiring", "endpoint", "capability-gateway", "NotConfigured", "Not configured in this deployment.", null),
      row("model:recorded", "Model provider: Recorded", "endpoint", "capability-gateway", "NotConfigured", "Recorded responses; no model endpoint is called.", null),
    ];
    return ok(ctx, { generatedAt: ctx.state.clock, overall: "Degraded", components });
  },

  // ---- Mock controls (x-mock-only) ----
  getMockPersonas: (ctx) => ok(ctx, PERSONAS.map((entry) => clone(entry.persona))),
  putMockSession: (ctx) => {
    const personaId = String(ctx.body?.personaId ?? "");
    try {
      persona(personaId);
    } catch {
      return fail(ctx, 400, "request.invalid", `Unknown persona ${personaId}.`);
    }
    ctx.state.personaId = personaId;
    ctx.state.sessionExpired = false;
    ctx.state.revokedRoles.clear();
    notify(ctx.state, "session");
    return ok(ctx, sessionFor(ctx.state));
  },
  getMockScenario: (ctx) => ok(ctx, { scenario: ctx.state.scenario, clock: ctx.state.clock, available: [...SCENARIOS] }),
  putMockScenario: (ctx) => {
    const scenario = String(ctx.body?.scenario ?? "") as ScenarioName;
    if (!SCENARIOS.includes(scenario)) return fail(ctx, 400, "request.invalid", `Unknown scenario ${scenario}.`);
    loadScenario(ctx.state, scenario);
    notify(ctx.state, "scenario");
    return ok(ctx, { scenario: ctx.state.scenario, clock: ctx.state.clock, available: [...SCENARIOS] });
  },
  putMockClock: (ctx) => {
    if (typeof ctx.body?.set === "string" && !Number.isNaN(Date.parse(ctx.body.set))) ctx.state.clock = new Date(ctx.body.set).toISOString().replace(/\.000Z$/, "Z");
    if (typeof ctx.body?.advanceSeconds === "number") advanceClock(ctx.state, ctx.body.advanceSeconds);
    notify(ctx.state, "clock");
    return ok(ctx, { clock: ctx.state.clock });
  },
  putMockFaults: (ctx) => {
    const body = (ctx.body ?? {}) as Rec;
    const faults = ctx.state.faults;
    for (const key of Object.keys(NO_FAULTS) as Array<keyof typeof NO_FAULTS>) {
      if (key in body) (faults as Rec)[key] = clone(body[key]);
    }
    notify(ctx.state, "faults");
    const { sticky: _sticky, ...active } = faults;
    return ok(ctx, { active });
  },
  postMockReset: (ctx) => {
    resetState(ctx.state, ctx.state.scenario);
    notify(ctx.state, "reset");
    return ok(ctx, { ok: true });
  },
};
