import type { ReconFailureReason, ReconMode } from "@ehf/contracts";
import { CaseStoreError, type CaseStoreDatabase } from "./index.js";
import { liveDiscoveryEnabled, publishLiveDiscovery, syntheticDiscoveryEnabled, verifyLiveDiscovery } from "./discovery.js";
import type { DiscoveryCaseReader } from "./discovery.js";
import { collectHostedDiscoveryRun, prepareHostedDiscoveryRun, readDiscoveryIntake } from "./discovery-observer.js";
import { claimReconJob, reconCaseBasis, updateReconJob } from "./recon-jobs.js";
import { searchCompanyOnWeb, webSearchConfigured } from "./recon-web-search.js";

type LaunchRequest = Awaited<ReturnType<typeof prepareHostedDiscoveryRun>>;

const REASON_BY_CODE: Record<string, ReconFailureReason> = {
  "discovery.web_search_timeout": "timeout",
  "discovery.web_provider_rejected": "provider_rejected",
  "discovery.web_search_failed": "provider_rejected",
  "discovery.web_response_incomplete": "output_unusable",
  "discovery.web_citations_missing": "output_unusable",
  "discovery.web_output_unusable": "output_unusable",
  "discovery.web_lease_lost": "interrupted",
  "discovery.case_not_eligible": "not_eligible",
  "discovery.case_finalized": "not_eligible",
};

/** The reason shown to the analyst for a failed attempt. Error codes only; never provider text. */
export function reconFailureReason(error: unknown): ReconFailureReason {
  return (error instanceof CaseStoreError && REASON_BY_CODE[error.code]) || "error";
}

export async function processReconJob(options: {
  store: DiscoveryCaseReader; discovery: CaseStoreDatabase; control: Pick<CaseStoreDatabase, "query">;
  tenantId: string; planDigest?: string; env: NodeJS.ProcessEnv;
  launch: (body: LaunchRequest, attempt: number) => Promise<string>;
}): Promise<boolean> {
  const { store, discovery, control, tenantId, env } = options;
  const modes: ReconMode[] = [];
  if (syntheticDiscoveryEnabled(env) && options.planDigest) modes.push("synthetic");
  if (liveDiscoveryEnabled(env) && webSearchConfigured(env)) modes.push("live");
  if (!modes.length) return false;
  const job = await claimReconJob(discovery, tenantId, modes);
  if (!job) return false;
  const caseId = job.case_id;
  let externalStarted = false;
  try {
    const anchor = await reconCaseBasis(store, tenantId, caseId, job.mode);
    const expired = job.deadline_at.getTime() <= Date.now();
    if (!anchor || anchor.finalized || anchor.basis !== job.basis || expired) {
      await updateReconJob(discovery, job, { status: "failed", reason: anchor && !anchor.finalized && anchor.basis === job.basis ? "expired" : "not_eligible" });
      return true;
    }
    const runId = job.parent_run_id ?? (await control.query<{ run_id: string | null }>(
      "select harness_runtime.discovery_parent_run($1,$2,$3) as run_id",
      [tenantId, caseId, job.parent_plan_digest],
    )).rows[0]?.run_id;
    if (!runId) {
      await updateReconJob(discovery, job, { status: "queued" });
      return true;
    }
    const scope = { tenantId, caseId, runId };
    if (job.mode === "live") {
      // A reclaimed in-flight request may already have reached the provider.
      if (job.status === "running") {
        await updateReconJob(discovery, job, { status: "failed", reason: "interrupted" });
        return true;
      }
      const found = await readDiscoveryIntake(control, scope);
      if (found.state !== "ready") {
        await updateReconJob(discovery, job, found.state === "pending" ? { status: "queued" } : { status: "failed", reason: "not_eligible" });
        return true;
      }
      await verifyLiveDiscovery(store, found.intake, job, anchor.company, env);
      if (await updateReconJob(discovery, job, { status: "running", parentRunId: runId, releaseLease: false })) {
        externalStarted = true;
        const result = await searchCompanyOnWeb(anchor.company, env);
        await publishLiveDiscovery(store, discovery, found.intake, job, anchor.company, result, env);
      }
      return true;
    }
    const planDigest = job.advisory_plan_digest ?? options.planDigest;
    if (!planDigest || planDigest !== options.planDigest) {
      await updateReconJob(discovery, job, { status: "failed", reason: "not_eligible" });
      return true;
    }
    const request = await prepareHostedDiscoveryRun(store, control, scope, planDigest, env);
    if (!job.advisory_run_id) {
      // Pin the preparation before making the HTTP call. A lost launch response is
      // retried with the same plan, parent, and attempt against the run idempotency key.
      if (await updateReconJob(discovery, job, { status: "queued", parentRunId: runId, planDigest, releaseLease: false })) {
        const advisoryRunId = await options.launch(request, job.attempt);
        await updateReconJob(discovery, job, { status: "running", advisoryRunId });
      }
      return true;
    }
    const result = await control.query<{ status: string | null }>(
      "select harness_runtime.discovery_run_status($1,$2,$3,$4::jsonb) as status",
      [tenantId, job.advisory_run_id, planDigest, JSON.stringify(request.input)],
    );
    const status = result.rows[0]?.status;
    if (status === "completed") {
      await collectHostedDiscoveryRun(store, discovery, control, scope, planDigest, job.advisory_run_id, env);
      await updateReconJob(discovery, job, { status: "complete" });
    } else {
      await updateReconJob(discovery, job, status && ["queued", "running", "retrying"].includes(status)
        ? { status: "running" } : { status: "failed", reason: "error" });
    }
  } catch (error) {
    const refused = error instanceof CaseStoreError && [403, 404, 409].includes(error.httpStatus);
    const pending = error instanceof CaseStoreError && error.code === "discovery.intake_settlement_pending";
    await updateReconJob(discovery, job, externalStarted || (refused && !pending)
      ? { status: "failed", reason: reconFailureReason(error) } : { status: job.advisory_run_id ? "running" : "queued" });
    if (externalStarted || !refused) throw error;
  }
  return true;
}
