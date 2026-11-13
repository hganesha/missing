import { pathToFileURL } from "node:url";
import pg from "pg";
import { createWorkloadTokenProvider, databaseAuth } from "@ehf/identity";
import { createContextStore, deleteCasePackBlobs, withContextTenant, type ContextStore } from "./index.js";

/**
 * The context release job (docs/implementation/data-stores-plan.md §3.3, phase 4d).
 *
 * For each closed case of a tenant, once it has been closed for the grace period (30 days by
 * default, per tenant configurable), the job confirms through case-api that the case is still
 * closed, under no legal hold, and that every context its records cite was promoted to
 * evidence; confirms in the control database that nothing for the case is still running; then
 * deletes the case's context (pack bodies in blob storage, packs, sections, signals, case-scoped
 * chunks, graph nodes),
 * redacts its working data in the control database to digest markers, and records the release
 * in the case's ledger. Every step is idempotent, so a crash part way is repaired by the next run.
 */

export type ReleaseEligibility = {
  caseId: string;
  status: string;
  closed: { sequence: number; at: string } | null;
  released: { sequence: number; closedSequence: number } | null;
  citedContext: Array<{ evidenceId: string; packDigest: string }>;
  unpromotedCitations: string[];
  legalHold: boolean;
};

/** What the job may do through case-api (role Context.Release): list, read eligibility, record. */
export type CaseReleaseApi = {
  closedCases(tenantId: string): Promise<string[]>;
  eligibility(tenantId: string, caseId: string): Promise<ReleaseEligibility | null>;
  recordReleased(tenantId: string, caseId: string, body: {
    closedSequence: number; releasedAt: string; counts: Record<string, number | null>; promotedEvidenceIds: string[];
  }): Promise<{ eventId: string }>;
};

export type ReleaseDependencies = {
  context: ContextStore;
  /** The job's login to the control database (group ehf_svc_case_data_release). */
  control: Pick<pg.Pool, "query">;
  caseApi: CaseReleaseApi;
  graceDays: (tenantId: string) => number;
  now?: () => Date;
};

export type ReleaseOutcome = {
  caseId: string;
  state: "RELEASED" | "SCHEDULED" | "BLOCKED" | "ALREADY_RELEASED" | "NOT_CLOSED";
  reason?: string;
  eligibleAt?: string;
};

async function recordState(deps: ReleaseDependencies, tenantId: string, row: {
  caseId: string; closedSequence: number; closedAt: string; eligibleAt: string; state: "SCHEDULED" | "BLOCKED" | "RELEASED";
  blockedReason?: string; counts?: unknown; promoted?: unknown; ledgerEventId?: string; releasedAt?: string;
}): Promise<void> {
  await withContextTenant(deps.context, tenantId, (client) => client.query(`
    insert into context.case_releases(tenant_id, case_id, closed_sequence, closed_at, eligible_at, state, blocked_reason,
      counts, promoted_evidence, ledger_event_id, released_at, updated_at)
    values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, clock_timestamp())
    on conflict (tenant_id, case_id, closed_sequence) do update set
      state = excluded.state, blocked_reason = excluded.blocked_reason, eligible_at = excluded.eligible_at,
      counts = coalesce(excluded.counts, context.case_releases.counts),
      promoted_evidence = coalesce(excluded.promoted_evidence, context.case_releases.promoted_evidence),
      ledger_event_id = coalesce(excluded.ledger_event_id, context.case_releases.ledger_event_id),
      released_at = excluded.released_at, updated_at = excluded.updated_at
    where context.case_releases.state <> 'RELEASED'
  `, [tenantId, row.caseId, row.closedSequence, row.closedAt, row.eligibleAt, row.state, row.blockedReason ?? null,
    row.counts === undefined ? null : JSON.stringify(row.counts), row.promoted === undefined ? null : JSON.stringify(row.promoted),
    row.ledgerEventId ?? null, row.releasedAt ?? null]));
}

/** Release one closed case if it is due and nothing blocks it. */
export async function releaseCase(deps: ReleaseDependencies, tenantId: string, caseId: string): Promise<ReleaseOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const eligibility = await deps.caseApi.eligibility(tenantId, caseId);
  if (!eligibility?.closed) return { caseId, state: "NOT_CLOSED" };
  if (eligibility.released) return { caseId, state: "ALREADY_RELEASED" };
  const closed = eligibility.closed;
  const eligibleAt = new Date(Date.parse(closed.at) + deps.graceDays(tenantId) * 86_400_000).toISOString();
  const base = { caseId, closedSequence: closed.sequence, closedAt: closed.at, eligibleAt };
  if (now.toISOString() < eligibleAt) {
    await recordState(deps, tenantId, { ...base, state: "SCHEDULED" });
    return { caseId, state: "SCHEDULED", eligibleAt };
  }
  const blocked = eligibility.legalHold ? "legal_hold" : eligibility.unpromotedCitations.length ? "unpromoted_citation" : null;
  if (blocked) {
    await recordState(deps, tenantId, { ...base, state: "BLOCKED", blockedReason: blocked });
    return { caseId, state: "BLOCKED", reason: blocked };
  }
  const live = Number((await deps.control.query<{ live: number }>("select harness_runtime.case_live_executions($1, $2) as live", [tenantId, caseId])).rows[0]?.live ?? 0);
  if (live > 0) {
    await recordState(deps, tenantId, { ...base, state: "BLOCKED", blockedReason: "active_execution" });
    return { caseId, state: "BLOCKED", reason: "active_execution" };
  }
  // Pack bodies in blob storage go first: the rows still name the case if this step is interrupted.
  const packBlobs = await deleteCasePackBlobs(deps.context, tenantId, caseId);
  const context = await withContextTenant(deps.context, tenantId, async (client) =>
    (await client.query<{ packs: number; sections: number; signals: number; chunks: number; graph_packs: number }>("select * from context.release_case($1)", [caseId])).rows[0]!);
  const runtime = (await deps.control.query<{ counts: Record<string, number | null> }>("select harness_runtime.release_case_working_data($1, $2) as counts", [tenantId, caseId])).rows[0]!.counts;
  const counts = {
    contextPacks: context.packs, contextPackBlobs: packBlobs, contextSections: context.sections, quarantineSignals: context.signals,
    knowledgeChunks: context.chunks, graphPacks: context.graph_packs, ...runtime,
  };
  const promotedEvidenceIds = [...new Set(eligibility.citedContext.map((citation) => citation.evidenceId))];
  const releasedAt = now.toISOString();
  const recorded = await deps.caseApi.recordReleased(tenantId, caseId, { closedSequence: closed.sequence, releasedAt, counts, promotedEvidenceIds });
  await recordState(deps, tenantId, { ...base, state: "RELEASED", counts, promoted: eligibility.citedContext, ledgerEventId: recorded.eventId, releasedAt });
  return { caseId, state: "RELEASED" };
}

/** Release every due case of one tenant. */
export async function releaseTenant(deps: ReleaseDependencies, tenantId: string): Promise<ReleaseOutcome[]> {
  const outcomes: ReleaseOutcome[] = [];
  for (const caseId of await deps.caseApi.closedCases(tenantId)) outcomes.push(await releaseCase(deps, tenantId, caseId));
  return outcomes;
}

/** Grace period in days: CONTEXT_RELEASE_GRACE_DAYS (default 30), per tenant overridable by CONTEXT_RELEASE_GRACE_DAYS_BY_TENANT (JSON). */
export function graceDaysFromEnv(env: NodeJS.ProcessEnv = process.env): (tenantId: string) => number {
  const fallback = Number(env.CONTEXT_RELEASE_GRACE_DAYS ?? 30);
  const byTenant = env.CONTEXT_RELEASE_GRACE_DAYS_BY_TENANT ? JSON.parse(env.CONTEXT_RELEASE_GRACE_DAYS_BY_TENANT) as Record<string, number> : {};
  for (const value of [fallback, ...Object.values(byTenant)]) {
    if (!Number.isFinite(value) || value < 0 || value > 3650) throw new Error("context_release.grace_days_invalid");
  }
  return (tenantId) => byTenant[tenantId] ?? fallback;
}

/** case-api over HTTP with the job's workload credential (one grant per tenant, role Context.Release). */
export function httpCaseReleaseApi(options: { baseUrl: string; token: (tenantId: string) => Promise<string> | string; fetchImpl?: typeof fetch }): CaseReleaseApi {
  const call = async (tenantId: string, path: string, init: RequestInit = {}) => {
    const response = await (options.fetchImpl ?? fetch)(`${options.baseUrl.replace(/\/$/, "")}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${await options.token(tenantId)}`, "content-type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(String(body.error ?? `context_release.case_api_${response.status}`));
    return body;
  };
  return {
    async closedCases(tenantId) {
      const ids: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await call(tenantId, `/v1/context-release/cases${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`) as
          { caseIds?: string[]; nextCursor?: string | null } | null;
        ids.push(...(page?.caseIds ?? []));
        cursor = page?.nextCursor ?? null;
      } while (cursor);
      return ids;
    },
    eligibility: async (tenantId, caseId) => await call(tenantId, `/v1/cases/${encodeURIComponent(caseId)}/context-release`) as ReleaseEligibility | null,
    async recordReleased(tenantId, caseId, body) {
      const result = await call(tenantId, `/v1/cases/${encodeURIComponent(caseId)}/context-release`, { method: "POST", body: JSON.stringify(body) });
      if (!result || typeof result.eventId !== "string") throw new Error("context_release.record_failed");
      return { eventId: result.eventId };
    },
  };
}

export async function main(): Promise<void> {
  const tenants = (process.env.CONTEXT_RELEASE_TENANTS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!tenants.length) throw new Error("context_release.tenants_missing");
  const baseUrl = process.env.CASE_API_URL;
  if (!baseUrl) throw new Error("context_release.case_api_url_missing");
  // The release job's one identity: its development token, or its workload-identity token.
  const token = createWorkloadTokenProvider({ staticTokenEnv: "CONTEXT_RELEASE_SERVICE_TOKEN" });
  databaseAuth();
  if (!process.env.DATABASE_URL) throw new Error("context_release.database_url_missing");
  const control = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const context = createContextStore();
  try {
    const deps: ReleaseDependencies = { context, control, caseApi: httpCaseReleaseApi({ baseUrl, token }), graceDays: graceDaysFromEnv() };
    for (const tenantId of tenants) {
      for (const outcome of await releaseTenant(deps, tenantId)) {
        process.stdout.write(`${tenantId} ${outcome.caseId}: ${outcome.state}${outcome.reason ? ` (${outcome.reason})` : ""}${outcome.eligibleAt ? ` eligible ${outcome.eligibleAt}` : ""}\n`);
      }
    }
  } finally {
    await Promise.all([control.end(), context.db.end()]);
  }
}

if (import.meta.main ?? (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) await main();
