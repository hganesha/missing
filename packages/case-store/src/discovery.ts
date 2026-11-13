import { businessDecisionSchema, discoveryBriefSchema, stableDigest, validateDiscoveryAdvisoryOutput, type DiscoveryBrief, type ReconMode } from "@ehf/contracts";
import type { PoolClient } from "pg";
import { isProductionProfile } from "@ehf/identity";
export { createDiscoveryDatabase } from "./discovery-database.js";
import { withDiscoveryTenant } from "./discovery-database.js";
import type { ReconJob } from "./recon-jobs.js";
import type { ReconCompany, WebReconResult } from "./recon-web-search.js";
import { qualify } from "./config.js";
import { discoveryFixtureName, makeDiscoveryFixture } from "./discovery-fixture.js";
import { CaseStoreError, normalizeDigest, withCaseTenant, type CaseStore, type CaseStoreDatabase } from "./index.js";

export function syntheticDiscoveryEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.DISCOVERY_SYNTHETIC_ENABLED === "true"
    && !isProductionProfile(env)
    && (env.RELEASE_ENVIRONMENT === undefined || env.RELEASE_ENVIRONMENT === "development");
}

export function liveDiscoveryEnabled(env: NodeJS.ProcessEnv): boolean {
  return (env.DISCOVERY_WEB_SEARCH_ENABLED ?? "true") === "true";
}

export function reconBasisDigest(parentPlan: string, subjectId: string, revision: number, mode: ReconMode) {
  return stableDigest(mode === "synthetic" ? [parentPlan, subjectId, revision] : [parentPlan, subjectId, revision, mode]);
}

export type DiscoveryCaseReader = Pick<CaseStore, "db" | "schemas">;

export type DiscoveryIntakeScope = {
  tenantId: string; caseId: string; intakeDecisionId: string;
  settlement?: { runId: string; workItemId: string; planDigest: string; receiptDigest: string };
};

async function discoveryAnchor(client: PoolClient, store: DiscoveryCaseReader, scope: DiscoveryIntakeScope, company?: ReconCompany) {
  const { tenantId, caseId, intakeDecisionId } = scope;
  const cases = qualify(store.schemas.core, "cases");
  const subjects = qualify(store.schemas.core, "discovery_corporate_anchors");
  const decisions = qualify(store.schemas.core, "business_decisions");
  const keys = [tenantId, caseId, intakeDecisionId];
  // Observe case authority in a read-only snapshot. Primary case writes can proceed concurrently.
  const current = (await client.query<{ harness_plan_digest: string; status: string; case_type: string; jurisdiction: string }>(
    `select harness_plan_digest, status, case_type, jurisdiction from ${cases}
     where tenant_id=$1 and case_id=$2`, [tenantId, caseId],
  )).rows[0];
  if (!current) throw new CaseStoreError("case.not_found", 404);
  const parentPlanDigest = normalizeDigest(current.harness_plan_digest);
  const row = (await client.query<{ receipt: unknown; receipt_digest: string }>(
    `select receipt, receipt_digest from ${decisions} where tenant_id=$1 and case_id=$2 and decision_id=$3`, keys,
  )).rows[0];
  const parsed = businessDecisionSchema.safeParse(row?.receipt);
  if (current.case_type !== "kyb_onboarding" || !parsed.success) {
    throw new CaseStoreError("discovery.intake_not_eligible", 409);
  }
  const { receiptDigest, ...decision } = parsed.data;
  if (decision.tenantId !== tenantId || decision.caseId !== caseId || decision.decisionId !== intakeDecisionId
    || decision.planDigest !== parentPlanDigest || decision.gateId !== "intake-ready"
    || decision.inputProfile !== "canonical.onboarding.v2" || decision.purpose !== "CDD_ONBOARDING"
    || decision.scope.customerType !== "corporate" || decision.scope.jurisdiction !== current.jurisdiction
    || decision.result.state !== "DECIDED" || receiptDigest !== row?.receipt_digest
    || stableDigest(decision) !== receiptDigest
    || (scope.settlement && (scope.settlement.planDigest !== parentPlanDigest || scope.settlement.receiptDigest !== receiptDigest))) {
    throw new CaseStoreError("discovery.intake_not_eligible", 409);
  }

  const anchors = await client.query<{ subject_id: string; revision: number; display_name: string | null; updated_at: Date }>(
    `select subject_id, revision, display_name, updated_at from ${subjects}
     where tenant_id=$1 and case_id=$2
     order by subject_id limit 2`, [tenantId, caseId],
  );
  const anchor = anchors.rows[0];
  const matchesCompany = company
    ? anchor?.display_name === company.companyName && current.jurisdiction === company.country
    : anchor?.display_name === discoveryFixtureName;
  if (anchors.rows.length !== 1 || !anchor || !matchesCompany
    || !decision.subjectIds.includes(anchor.subject_id) || anchor.updated_at.getTime() > Date.parse(decision.evaluatedAt)) {
    throw new CaseStoreError(company ? "discovery.case_not_eligible" : "discovery.fixture_subject_required", 409);
  }
  return { anchor, current, parentPlanDigest, receiptDigest };
}

const finalized = (status: string) => ["APPROVED", "DECLINED", "CLOSED"].includes(status);

export async function prepareHostedDiscovery(store: DiscoveryCaseReader, scope: DiscoveryIntakeScope, env: NodeJS.ProcessEnv = process.env) {
  if (!syntheticDiscoveryEnabled(env)) throw new CaseStoreError("discovery.synthetic_disabled", 403);
  return withCaseTenant(store, scope.tenantId, async client => {
    const { current, receiptDigest } = await discoveryAnchor(client, store, scope);
    if (finalized(current.status)) throw new CaseStoreError("discovery.case_finalized", 409);
    // The runtime contract requires a caseId. Use a separate advisory identifier
    // so runtime records and model context never attach to the primary case.
    return {
      tenantId: scope.tenantId,
      caseId: `recon_${stableDigest({ tenantId: scope.tenantId, caseId: scope.caseId, receiptDigest })}`,
      seed: { companyName: discoveryFixtureName, country: current.jurisdiction },
    };
  }, { readOnly: true, repeatableRead: true });
}

export async function verifyLiveDiscovery(
  store: DiscoveryCaseReader, scope: DiscoveryIntakeScope, job: ReconJob, company: ReconCompany, env: NodeJS.ProcessEnv,
) {
  return withCaseTenant(store, scope.tenantId, async client => {
    await liveAnchor(client, store, scope, job, company, env);
  }, { readOnly: true, repeatableRead: true });
}

async function liveAnchor(
  client: PoolClient, store: DiscoveryCaseReader, scope: DiscoveryIntakeScope, job: ReconJob,
  company: ReconCompany, env: NodeJS.ProcessEnv,
) {
  if (!liveDiscoveryEnabled(env)) {
    throw new CaseStoreError("discovery.web_search_disabled", 403);
  }
  const basis = await discoveryAnchor(client, store, scope, company);
  if (finalized(basis.current.status) || job.deadline_at.getTime() <= Date.now()
    || job.basis !== reconBasisDigest(basis.parentPlanDigest, basis.anchor.subject_id, basis.anchor.revision, "live")) {
    throw new CaseStoreError("discovery.case_not_eligible", 409);
  }
  return basis;
}

export async function publishLiveDiscovery(
  store: DiscoveryCaseReader, discovery: CaseStoreDatabase, scope: DiscoveryIntakeScope, job: ReconJob,
  company: ReconCompany, result: WebReconResult, env: NodeJS.ProcessEnv,
) {
  return publishDiscovery(store, discovery, scope, env, { job, company, result });
}

export async function recordSyntheticDiscovery(
  store: DiscoveryCaseReader, discovery: CaseStoreDatabase, scope: DiscoveryIntakeScope,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ brief: DiscoveryBrief; replayed: boolean }> {
  return publishDiscovery(store, discovery, scope, env);
}

export async function publishHostedDiscovery(
  store: DiscoveryCaseReader, discovery: CaseStoreDatabase, scope: DiscoveryIntakeScope,
  execution: { runId: string; planDigest: string; output: unknown }, env: NodeJS.ProcessEnv = process.env,
): Promise<{ brief: DiscoveryBrief; replayed: boolean }> {
  const hosted = { ...execution, output: validateDiscoveryAdvisoryOutput(execution.output) };
  return publishDiscovery(store, discovery, scope, env, hosted);
}

async function publishDiscovery(
  store: DiscoveryCaseReader, discovery: CaseStoreDatabase, scope: DiscoveryIntakeScope, env: NodeJS.ProcessEnv,
  publication?: { runId: string; planDigest: string; output: ReturnType<typeof validateDiscoveryAdvisoryOutput> }
    | { job: ReconJob; company: ReconCompany; result: WebReconResult },
): Promise<{ brief: DiscoveryBrief; replayed: boolean }> {
  const live = publication && "job" in publication ? publication : undefined;
  const hosted = publication && "runId" in publication ? publication : undefined;
  if (!live && !syntheticDiscoveryEnabled(env)) throw new CaseStoreError("discovery.synthetic_disabled", 403);
  const { tenantId, caseId, intakeDecisionId } = scope;
  return withCaseTenant(store, tenantId, async (client) => {
    const { anchor, current, parentPlanDigest } = live
      ? await liveAnchor(client, store, scope, live.job, live.company, env)
      : await discoveryAnchor(client, store, scope);
    const origin = live ? live.result.origin : hosted ? "hosted_synthetic" : "synthetic_fixture";
    // The read projection checks the current case plan and subject revision before serving a brief.
    return withDiscoveryTenant(discovery, tenantId, async (discoveryClient) => {
      if (live) {
        // Fence the result against the lease and commit it with the job status.
        const updated = await discoveryClient.query(`
          update case_discovery.recon_jobs set status='complete',lease_token=null,lease_until=null
          where tenant_id=$1 and case_id=$2 and basis=$3 and mode='live' and status='running'
            and lease_token=$4 and lease_until>clock_timestamp() and deadline_at>clock_timestamp()
        `, [tenantId, caseId, live.job.basis, live.job.lease_token]);
        if (!updated.rowCount) throw new CaseStoreError("discovery.web_lease_lost", 409);
      }
      const briefKeys = [tenantId, caseId, intakeDecisionId, anchor.subject_id, anchor.revision, origin];
      const existing = async () => (await discoveryClient.query<{ brief: unknown }>(
        `select brief from case_discovery.briefs where tenant_id=$1 and case_id=$2
         and intake_decision_id=$3 and subject_id=$4 and subject_revision=$5 and origin=$6`, briefKeys,
      )).rows[0];
      const prior = await existing();
      if (prior) return { brief: discoveryBriefSchema.parse(prior.brief), replayed: true };
      if (finalized(current.status)) {
        throw new CaseStoreError("discovery.case_finalized", 409);
      }

      const fixtureKeys = publication ? briefKeys : briefKeys.slice(0, -1);
      const fields = {
        briefId: `discovery_${stableDigest(fixtureKeys)}`,
        caseId, subjectId: anchor.subject_id, parentPlanDigest, intakeDecisionId,
        ...(scope.settlement ? { intakeSettlement: { runId: scope.settlement.runId, workItemId: scope.settlement.workItemId } } : {}),
        recordedAt: new Date().toISOString(),
      };
      const brief = live ? discoveryBriefSchema.parse({
        ...fields, schemaVersion: "discovery.brief.v1", origin,
        status: live.result.signals.length ? "complete" : "no_leads",
        summary: "Public web search returned leads for optional analyst follow-up.",
        signals: live.result.signals.map((signal, index) => ({ ...signal, signalId: `lead-${index + 1}`, verificationStatus: "UNVERIFIED" })),
        sources: live.result.sources,
        limitations: ["Public web coverage is incomplete. Verify the entity and the reported event with the cited source before relying on a lead."],
      }) : hosted ? makeHostedBrief(fields, hosted) : makeDiscoveryFixture(fields);
      const inserted = await discoveryClient.query(
        `insert into case_discovery.briefs
          (tenant_id, case_id, intake_decision_id, subject_id, subject_revision, origin, parent_plan_digest, recorded_at, brief)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) on conflict do nothing`,
        [...briefKeys, parentPlanDigest, brief.recordedAt, JSON.stringify(brief)],
      );
      if (inserted.rowCount) return { brief, replayed: false };
      return { brief: discoveryBriefSchema.parse((await existing())?.brief), replayed: true };
    });
  }, { readOnly: true, repeatableRead: true });
}

function makeHostedBrief(
  fields: Pick<DiscoveryBrief, "briefId" | "caseId" | "subjectId" | "parentPlanDigest" | "intakeDecisionId" | "intakeSettlement" | "recordedAt">,
  hosted: { runId: string; planDigest: string; output: ReturnType<typeof validateDiscoveryAdvisoryOutput> },
): DiscoveryBrief {
  const { search, draft } = hosted.output;
  const citedIds = new Set(draft.signals.flatMap(signal => signal.sourceIds));
  return discoveryBriefSchema.parse({
    ...fields,
    schemaVersion: "discovery.brief.v1",
    origin: "hosted_synthetic",
    advisoryExecution: { runId: hosted.runId, planDigest: hosted.planDigest },
    status: draft.signals.length ? "complete" : "no_leads",
    summary: draft.summary,
    signals: draft.signals.map((signal, index) => ({ ...signal, signalId: `lead-${index + 1}`, verificationStatus: "UNVERIFIED" })),
    sources: search.results.filter(result => citedIds.has(result.sourceId)).map(({ snippet: _snippet, ...source }) => source),
    limitations: [search.limitations[0], ...draft.limitations],
  });
}

export async function readLatestDiscoveryBrief(
  store: DiscoveryCaseReader, discovery: CaseStoreDatabase, tenantId: string, caseId: string, subjectId: string,
  mode: ReconMode = "synthetic",
): Promise<DiscoveryBrief | null> {
  return withCaseTenant(store, tenantId, async (client) => {
    const table = (name: string) => qualify(store.schemas.core, name);
    // Check current assignment in the same snapshot as the brief read.
    const authorized = (await client.query(
      `select 1 from ${table("case_assignments")} a
       where a.tenant_id=$1 and a.case_id=$2
       and (a.assignees ? $3 or exists (
         select 1 from ${table("case_team_members")} m
         where m.tenant_id=a.tenant_id and m.team_id=a.team_id and m.subject_id=$3 and m.removed_at is null
       ))`, [tenantId, caseId, subjectId],
    )).rowCount;
    if (!authorized) throw new CaseStoreError("authorization.discovery_standing_missing", 403);

    const anchors = await client.query<{ plan: string; subject_id: string; revision: number; finalized_at: Date | null }>(
      `select c.harness_plan_digest as plan, s.subject_id, s.revision,
         case when c.status in ('APPROVED','DECLINED','CLOSED') then c.updated_at end as finalized_at from ${table("cases")} c
       join ${table("case_subjects")} s on s.tenant_id=c.tenant_id and s.case_id=c.case_id
       where c.tenant_id=$1 and c.case_id=$2 and c.case_type='kyb_onboarding'
         and s.subject_type='legal_entity' and s.attributes->>'role'='customer'
       limit 2`, [tenantId, caseId],
    );
    const anchor = anchors.rows[0];
    if (anchors.rows.length !== 1 || !anchor) return null;

    return withDiscoveryTenant(discovery, tenantId, async (db) => {
      const row = (await db.query<{ brief: unknown }>(
        `select brief from case_discovery.briefs
         where tenant_id=$1 and case_id=$2 and parent_plan_digest=$3 and subject_id=$4 and subject_revision=$5
           and ($6::timestamptz is null or recorded_at <= $6) and (origin in ('openrouter_web','azure_foundry_web'))=$7
         order by (origin='hosted_synthetic') desc, recorded_at desc, intake_decision_id desc limit 1`,
        [tenantId, caseId, normalizeDigest(anchor.plan), anchor.subject_id, anchor.revision, anchor.finalized_at, mode === "live"],
      )).rows[0];
      return row ? discoveryBriefSchema.parse(row.brief) : null;
    }, true);
  }, { readOnly: true, repeatableRead: true });
}
