import { randomUUID } from "node:crypto";
import { discoveryFixtureCompany, reconFailureReasonSchema, reconJobStatusSchema, type CaseReconState, type ReconFailureReason, type ReconMode } from "@ehf/contracts";
import { reconCompanySchema } from "./recon-web-search.js";
import { qualify } from "./config.js";
import { withDiscoveryTenant } from "./discovery-database.js";
import { readLatestDiscoveryBrief, reconBasisDigest } from "./discovery.js";
import type { DiscoveryCaseReader } from "./discovery.js";
import { CaseStoreError, normalizeDigest, withCaseTenant, type CaseStoreDatabase } from "./index.js";

export async function reconCaseBasis(
  store: DiscoveryCaseReader, tenantId: string, caseId: string,
  mode: ReconMode = "synthetic",
) {
  return withCaseTenant(store, tenantId, async client => {
    const { rows } = await client.query<{ plan: string; status: string; subject_id: string; revision: number; display_name: string | null; jurisdiction: string }>(
      `select c.harness_plan_digest as plan,c.status,s.subject_id,s.revision,s.display_name,c.jurisdiction
       from ${qualify(store.schemas.core, "cases")} c
       join ${qualify(store.schemas.core, "discovery_corporate_anchors")} s using (tenant_id,case_id)
       where c.tenant_id=$1 and c.case_id=$2 and c.case_type='kyb_onboarding'
       order by s.subject_id limit 2`, [tenantId, caseId],
    );
    const anchor = rows[0];
    if (rows.length !== 1 || !anchor) return null;
    if (mode === "synthetic" && anchor.display_name !== discoveryFixtureCompany) return null;
    const company = reconCompanySchema.safeParse({ companyName: anchor.display_name, country: anchor.jurisdiction });
    if (!company.success) return null;
    const parentPlan = normalizeDigest(anchor.plan);
    return { parentPlan, basis: reconBasisDigest(parentPlan, anchor.subject_id, anchor.revision, mode), company: company.data,
      finalized: ["APPROVED", "DECLINED", "CLOSED"].includes(anchor.status) };
  }, { readOnly: true });
}

export async function caseReconStatus(
  store: DiscoveryCaseReader, discovery: CaseStoreDatabase, scope: { tenantId: string; caseId: string; subjectId: string },
  requestAllowed: boolean, mode: ReconMode = "synthetic",
): Promise<CaseReconState> {
  const { tenantId, caseId, subjectId } = scope;
  const basis = await reconCaseBasis(store, tenantId, caseId, mode);
  if (!basis) return { status: "unavailable", canRequest: false, brief: null };
  const row = await withDiscoveryTenant(discovery, tenantId, async client => (
    await client.query<{ status: string; failure_reason: string | null }>("select status,failure_reason from case_discovery.recon_jobs where tenant_id=$1 and case_id=$2 and basis=$3",
      [tenantId, caseId, basis.basis])
  ).rows[0], true);
  const brief = await readLatestDiscoveryBrief(store, discovery, tenantId, caseId, subjectId, mode);
  const status = brief && brief.origin !== "synthetic_fixture" ? "complete" : row ? reconJobStatusSchema.parse(row.status) : "idle";
  // A job that failed before reasons were recorded has none; it reads as a general error.
  const failureReason = status === "failed" ? reconFailureReasonSchema.catch("error").parse(row?.failure_reason) : undefined;
  return { status, canRequest: requestAllowed && !basis.finalized && (status === "idle" || status === "failed"), brief,
    ...(failureReason ? { failureReason } : {}) };
}

export async function requestCaseRecon(
  store: DiscoveryCaseReader, discovery: CaseStoreDatabase, scope: { tenantId: string; caseId: string; subjectId: string },
  mode: ReconMode = "synthetic",
): Promise<CaseReconState> {
  const { tenantId, caseId, subjectId } = scope;
  const basis = await reconCaseBasis(store, tenantId, caseId, mode);
  if (!basis || basis.finalized) throw new CaseStoreError("discovery.case_not_eligible", 409);
  const brief = await readLatestDiscoveryBrief(store, discovery, tenantId, caseId, subjectId, mode);
  if (brief && brief.origin !== "synthetic_fixture") return { status: "complete", canRequest: false, brief };
  const status = await withDiscoveryTenant(discovery, tenantId, async client => {
    const result = await client.query<{ status: string }>("select case_discovery.request_recon($1,$2,$3,$4) as status",
      [caseId, basis.basis, basis.parentPlan, mode]);
    return reconJobStatusSchema.parse(result.rows[0]?.status);
  });
  return { status, canRequest: false, brief };
}

export type ReconJob = {
  tenant_id: string; case_id: string; basis: string; parent_plan_digest: string; attempt: number;
  mode: ReconMode; status: "queued" | "running";
  parent_run_id: string | null; advisory_run_id: string | null; advisory_plan_digest: string | null;
  lease_token: string; deadline_at: Date;
};

export async function claimReconJob(db: CaseStoreDatabase, tenantId: string, modes: readonly ReconMode[]): Promise<ReconJob | null> {
  return withDiscoveryTenant(db, tenantId, async client => (await client.query<ReconJob>(`
    with candidate as (
      select tenant_id,case_id,basis from case_discovery.recon_jobs
      where tenant_id=$1 and mode=any($3::text[]) and status in ('queued','running') and next_at<=clock_timestamp()
        and (lease_until is null or lease_until<clock_timestamp())
      order by next_at,case_id limit 1 for update skip locked
    )
    update case_discovery.recon_jobs j set lease_token=$2,lease_until=clock_timestamp()+interval '60 seconds'
    from candidate c where (j.tenant_id,j.case_id,j.basis)=(c.tenant_id,c.case_id,c.basis) returning j.*
  `, [tenantId, randomUUID(), modes])).rows[0] ?? null);
}

/**
 * How long a held lease runs once the worker commits to an external call. It must outlast the
 * call's own timeout (50 seconds for web search) plus the publish, or a slow answer is thrown away
 * and the retry pays for a second one.
 */
const HELD_LEASE_SECONDS = 120;

export type ReconJobChange =
  | { status: "queued" | "running" | "complete"; parentRunId?: string; planDigest?: string; advisoryRunId?: string; releaseLease?: boolean }
  | { status: "failed"; reason: ReconFailureReason };

export async function updateReconJob(db: CaseStoreDatabase, job: ReconJob, change: ReconJobChange) {
  const held = change.status !== "failed" && change.releaseLease === false;
  const settled: { parentRunId?: string; planDigest?: string; advisoryRunId?: string } = change.status === "failed" ? {} : change;
  const changed = await withDiscoveryTenant(db, job.tenant_id, async client => client.query(`
    update case_discovery.recon_jobs set status=$5,
      parent_run_id=coalesce($6,parent_run_id), advisory_plan_digest=coalesce($7,advisory_plan_digest),
      advisory_run_id=coalesce($8,advisory_run_id),
      lease_until=case when $9 then null else clock_timestamp()+make_interval(secs => $11) end,
      lease_token=case when $9 then null else lease_token end,
      failure_reason=$10,
      next_at=clock_timestamp()+interval '2 seconds'
    where tenant_id=$1 and case_id=$2 and basis=$3 and lease_token=$4 and lease_until>clock_timestamp()
  `, [job.tenant_id, job.case_id, job.basis, job.lease_token, change.status, settled.parentRunId ?? null,
    settled.planDigest ?? null, settled.advisoryRunId ?? null, !held,
    change.status === "failed" ? change.reason : null, HELD_LEASE_SECONDS]));
  return changed.rowCount === 1;
}
