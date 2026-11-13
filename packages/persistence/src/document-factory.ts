import { randomUUID } from "node:crypto";
import { stableDigest } from "@ehf/contracts";
import {
  classifierVersionSchema, datasetVersionSchema, documentModelReleaseSchema, evaluationReportSchema, modelVersionSchema, releaseActivatable,
  releaseJobSchema, typeStrategySchema,
  type ClassifierVersion, type DatasetVersion, type DocumentModelRelease, type EvaluationReport, type ModelVersion, type ReleaseJob, type TypeStrategy,
} from "@ehf/contracts/document-factory";
import { approveArtifact, registerArtifact, requireApprovedArtifact, type RegistryClient } from "./artifact-registry.js";
import type { Database } from "./index.js";

/**
 * Document Factory registry (document factory plan §7). Every call is tenant-scoped through `app.tenant_id` and
 * row-level security; history tables are append-only (the database refuses changes). A release is an immutable
 * manifest plus an artifact-registry entry of kind `document-model-release`: registered by the job's creator,
 * approved by someone else, and activated per environment only with its evaluation report's gates met.
 */
export class FactoryError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

type Client = Pick<Database, "query">;
const RELEASE_KIND = "document-model-release" as const;

async function scoped<T>(db: Database, tenantId: string, action: (client: Client) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await action(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function event(client: Client, tenantId: string, kind: string, ref: string, actor: string, details: Record<string, unknown> = {}) {
  await client.query("insert into harness_control.factory_events(tenant_id,kind,ref,actor,details) values ($1,$2,$3,$4,$5::jsonb)",
    [tenantId, kind, ref, actor, JSON.stringify(details)]);
}

// ---------------------------------------------------------------- strategies and datasets

export async function saveTypeStrategy(db: Database, input: { tenantId: string; actor: string; body: unknown }): Promise<TypeStrategy & { revision: number }> {
  const body = typeStrategySchema.parse(input.body);
  return scoped(db, input.tenantId, async client => {
    const current = await client.query("select coalesce(max(revision),0)::int as revision from harness_control.factory_type_strategies where tenant_id=$1 and document_type=$2",
      [input.tenantId, body.documentType]);
    const revision = Number(current.rows[0]?.revision ?? 0) + 1;
    await client.query("insert into harness_control.factory_type_strategies(tenant_id,document_type,revision,body,created_by) values ($1,$2,$3,$4::jsonb,$5)",
      [input.tenantId, body.documentType, revision, JSON.stringify(body), input.actor]);
    await event(client, input.tenantId, "strategy.saved", body.documentType, input.actor, { revision, strategy: body.strategy });
    return { ...body, revision };
  });
}

export async function listTypeStrategies(db: Database, tenantId: string): Promise<Array<TypeStrategy & { revision: number; createdBy: string; createdAt: string }>> {
  return scoped(db, tenantId, async client => (await client.query(`select distinct on (document_type) body, revision, created_by, created_at
    from harness_control.factory_type_strategies where tenant_id=$1 order by document_type, revision desc`, [tenantId])).rows
    .map(row => ({ ...row.body, revision: row.revision, createdBy: row.created_by, createdAt: new Date(row.created_at).toISOString() })));
}

/** Register a dataset version. Idempotent for the same digest and body. */
export async function registerDatasetVersion(db: Database, input: { tenantId: string; actor: string; body: unknown }): Promise<DatasetVersion> {
  const body = datasetVersionSchema.parse(input.body);
  return scoped(db, input.tenantId, async client => {
    const inserted = await client.query(`insert into harness_control.factory_dataset_versions(tenant_id,dataset_digest,document_type,body,registered_by)
      values ($1,$2,$3,$4::jsonb,$5) on conflict (tenant_id, dataset_digest) do nothing returning dataset_digest`,
      [input.tenantId, body.datasetDigest, body.documentType, JSON.stringify(body), input.actor]);
    if (!inserted.rowCount) {
      const existing = await client.query("select body from harness_control.factory_dataset_versions where tenant_id=$1 and dataset_digest=$2", [input.tenantId, body.datasetDigest]);
      if (stableDigest(existing.rows[0]?.body) !== stableDigest(body)) throw new FactoryError("factory.dataset_conflict", 409);
      return body;
    }
    await event(client, input.tenantId, "dataset.registered", body.datasetDigest, input.actor, { documentType: body.documentType, counts: body.counts });
    return body;
  });
}

/** The latest dataset version per type (or every version of one type, newest first). */
export async function listDatasetVersions(db: Database, tenantId: string, documentType?: string): Promise<DatasetVersion[]> {
  return scoped(db, tenantId, async client => (documentType
    ? await client.query("select body from harness_control.factory_dataset_versions where tenant_id=$1 and document_type=$2 order by registered_at desc", [tenantId, documentType])
    : await client.query(`select distinct on (document_type) body from harness_control.factory_dataset_versions where tenant_id=$1
      order by document_type, registered_at desc`, [tenantId])).rows.map(row => datasetVersionSchema.parse(row.body)));
}

// ---------------------------------------------------------------- models and classifiers

export async function saveModelVersion(db: Database, input: { tenantId: string; actor: string; body: unknown }): Promise<ModelVersion> {
  const body = modelVersionSchema.parse(input.body);
  return scoped(db, input.tenantId, async client => {
    const existing = await client.query("select body from harness_control.factory_model_versions where tenant_id=$1 and model_version_id=$2 for update",
      [input.tenantId, body.modelVersionId]);
    if (existing.rows[0]) {
      const { status: _a, trainingHours: _b, costUsd: _c, ...before } = existing.rows[0].body as ModelVersion;
      const { status: _d, trainingHours: _e, costUsd: _f, ...after } = body;
      if (stableDigest(before) !== stableDigest(after)) throw new FactoryError("factory.model_version_conflict", 409);
      await client.query("update harness_control.factory_model_versions set status=$3, body=$4::jsonb, updated_at=transaction_timestamp() where tenant_id=$1 and model_version_id=$2",
        [input.tenantId, body.modelVersionId, body.status, JSON.stringify(body)]);
    } else {
      await client.query(`insert into harness_control.factory_model_versions(tenant_id,model_version_id,document_type,status,body)
        values ($1,$2,$3,$4,$5::jsonb)`, [input.tenantId, body.modelVersionId, body.documentType, body.status, JSON.stringify(body)]);
    }
    await event(client, input.tenantId, `model.${body.status}`, body.modelVersionId, input.actor, { documentType: body.documentType, kind: body.kind });
    return body;
  });
}

export async function listModelVersions(db: Database, tenantId: string): Promise<ModelVersion[]> {
  return scoped(db, tenantId, async client => (await client.query("select body from harness_control.factory_model_versions where tenant_id=$1 order by created_at desc", [tenantId]))
    .rows.map(row => modelVersionSchema.parse(row.body)));
}

export async function saveClassifierVersion(db: Database, input: { tenantId: string; actor: string; body: unknown }): Promise<ClassifierVersion> {
  const body = classifierVersionSchema.parse(input.body);
  return scoped(db, input.tenantId, async client => {
    await client.query(`insert into harness_control.factory_classifier_versions(tenant_id,classifier_version_id,status,body) values ($1,$2,$3,$4::jsonb)
      on conflict (tenant_id, classifier_version_id) do update set status=excluded.status, body=excluded.body, updated_at=transaction_timestamp()`,
      [input.tenantId, body.classifierVersionId, body.status, JSON.stringify(body)]);
    await event(client, input.tenantId, `classifier.${body.status}`, body.classifierVersionId, input.actor, { classes: body.classes });
    return body;
  });
}

export async function listClassifierVersions(db: Database, tenantId: string): Promise<ClassifierVersion[]> {
  return scoped(db, tenantId, async client => (await client.query("select body from harness_control.factory_classifier_versions where tenant_id=$1 order by created_at desc", [tenantId]))
    .rows.map(row => classifierVersionSchema.parse(row.body)));
}

// ---------------------------------------------------------------- release jobs

function jobFrom(row: Record<string, any>): ReleaseJob {
  return releaseJobSchema.parse({ ...row.body, status: row.status, stage: row.stage, spendApprovedBy: row.spend_approved_by ?? null,
    spendApprovedAt: row.spend_approved_at ? new Date(row.spend_approved_at).toISOString() : null, updatedAt: new Date(row.updated_at).toISOString() });
}

/**
 * Record a planned release job. Idempotent per idempotency key: the same request returns the same job, a different
 * request under the same key is a conflict. A job with nothing to train needs no spend approval and is queued at once.
 */
export async function createReleaseJob(db: Database, input: { tenantId: string; actor: string; idempotencyKey: string; requestDigest: string; job: ReleaseJob }): Promise<{ job: ReleaseJob; created: boolean }> {
  const job = releaseJobSchema.parse(input.job);
  if (!input.idempotencyKey.trim() || input.idempotencyKey.length > 200) throw new FactoryError("factory.idempotency_key_required");
  return scoped(db, input.tenantId, async client => {
    const inserted = await client.query(`insert into harness_control.factory_release_jobs(tenant_id,job_id,status,stage,body,idempotency_key,request_digest,created_by)
      values ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) on conflict (tenant_id, idempotency_key) do nothing returning *`,
      [input.tenantId, job.jobId, job.status, job.stage, JSON.stringify(job), input.idempotencyKey, input.requestDigest, input.actor]);
    if (inserted.rows[0]) {
      await event(client, input.tenantId, "job.created", job.jobId, input.actor, { selection: job.selection, status: job.status });
      return { job: jobFrom(inserted.rows[0]), created: true };
    }
    const existing = await client.query("select * from harness_control.factory_release_jobs where tenant_id=$1 and idempotency_key=$2", [input.tenantId, input.idempotencyKey]);
    if (existing.rows[0]?.request_digest !== input.requestDigest) throw new FactoryError("factory.idempotency_conflict", 409);
    return { job: jobFrom(existing.rows[0]), created: false };
  });
}

export async function getReleaseJob(db: Database, tenantId: string, jobId: string): Promise<ReleaseJob | null> {
  return scoped(db, tenantId, async client => {
    const row = (await client.query("select * from harness_control.factory_release_jobs where tenant_id=$1 and job_id=$2", [tenantId, jobId])).rows[0];
    return row ? jobFrom(row) : null;
  });
}

export async function listReleaseJobs(db: Database, tenantId: string, limit = 50): Promise<ReleaseJob[]> {
  return scoped(db, tenantId, async client => (await client.query("select * from harness_control.factory_release_jobs where tenant_id=$1 order by created_at desc limit $2",
    [tenantId, Math.min(Math.max(limit, 1), 200)])).rows.map(jobFrom));
}

/**
 * Approve a job's spend. The approver cannot be the job's creator (also enforced by a table check). When the
 * estimate exceeds the tenant's budget limit, a second approver (the budget owner, neither the creator nor the
 * first approver) must approve too before the job is queued.
 */
export async function approveReleaseSpend(db: Database, input: { tenantId: string; actor: string; jobId: string; budgetLimitUsd: number }): Promise<ReleaseJob> {
  return scoped(db, input.tenantId, async client => {
    const row = (await client.query("select * from harness_control.factory_release_jobs where tenant_id=$1 and job_id=$2 for update", [input.tenantId, input.jobId])).rows[0];
    if (!row) throw new FactoryError("factory.job_not_found", 404);
    if (row.created_by === input.actor || row.spend_approved_by === input.actor) throw new FactoryError("factory.separation_of_duties", 403);
    if (row.status !== "awaiting_approval") throw new FactoryError("factory.job_not_awaiting_approval", 409);
    const estimate = (row.body as ReleaseJob).estimate;
    const overBudget = estimate.trainingCostUsd + estimate.evaluationCostUsd > input.budgetLimitUsd;
    if (row.spend_approved_by && overBudget) {
      const body: ReleaseJob = { ...(row.body as ReleaseJob), budgetOwnerApprovedBy: input.actor };
      const updated = await client.query(`update harness_control.factory_release_jobs set status='queued', stage='train', body=$3::jsonb,
        updated_at=transaction_timestamp() where tenant_id=$1 and job_id=$2 returning *`, [input.tenantId, input.jobId, JSON.stringify(body)]);
      await event(client, input.tenantId, "job.budget_approved", input.jobId, input.actor, { estimate, budgetLimitUsd: input.budgetLimitUsd });
      return jobFrom(updated.rows[0]);
    }
    const updated = await client.query(`update harness_control.factory_release_jobs set status=$4, stage=$5, spend_approved_by=$3,
      spend_approved_at=transaction_timestamp(), updated_at=transaction_timestamp() where tenant_id=$1 and job_id=$2 returning *`,
      [input.tenantId, input.jobId, input.actor, overBudget ? "awaiting_approval" : "queued", overBudget ? "approval" : "train"]);
    await event(client, input.tenantId, "job.spend_approved", input.jobId, input.actor, { estimate, overBudget, budgetLimitUsd: input.budgetLimitUsd });
    return jobFrom(updated.rows[0]);
  });
}

/** Cancel a job: a job not yet running stops at once; a running job stops at its next step. */
export async function cancelReleaseJob(db: Database, input: { tenantId: string; actor: string; jobId: string }): Promise<ReleaseJob> {
  return scoped(db, input.tenantId, async client => {
    const result = await client.query(`update harness_control.factory_release_jobs set cancellation_requested=true,
      status=case when status in ('planned','awaiting_approval','queued') then 'cancelled' else 'cancelling' end, updated_at=transaction_timestamp()
      where tenant_id=$1 and job_id=$2 and status in ('planned','awaiting_approval','queued','running') returning *`, [input.tenantId, input.jobId]);
    if (!result.rows[0]) throw new FactoryError("factory.job_not_active", 409);
    await event(client, input.tenantId, "job.cancel_requested", input.jobId, input.actor);
    return jobFrom(result.rows[0]);
  });
}

/**
 * Claim the next queued job, or resume a running one whose lease expired (a job is resumable at step granularity:
 * every training step is idempotent by model ID). A cancelling job whose worker died is cancelled.
 */
export async function claimReleaseJob(db: Database, input: { tenantId: string; owner: string; leaseSeconds?: number }): Promise<ReleaseJob | null> {
  const lease = Math.min(Math.max(input.leaseSeconds ?? 600, 30), 3600);
  return scoped(db, input.tenantId, async client => {
    await client.query(`update harness_control.factory_release_jobs set status='cancelled', lease_owner=null, lease_until=null, updated_at=transaction_timestamp()
      where tenant_id=$1 and status='cancelling' and lease_until < now()`, [input.tenantId]);
    const result = await client.query(`update harness_control.factory_release_jobs set status='running', lease_owner=$2,
      lease_until=now() + make_interval(secs => $3), updated_at=transaction_timestamp()
      where (tenant_id, job_id) = (select tenant_id, job_id from harness_control.factory_release_jobs where tenant_id=$1
        and (status='queued' or (status='running' and lease_until < now())) and not cancellation_requested
        order by created_at for update skip locked limit 1) returning *`, [input.tenantId, input.owner, lease]);
    if (!result.rows[0]) return null;
    await event(client, input.tenantId, "job.claimed", result.rows[0].job_id, input.owner);
    return jobFrom(result.rows[0]);
  });
}

/**
 * The worker's progress report, under its lease: stage, per-type progress and status. Returns the job with
 * `cancellationRequested` so the worker stops at its next step. A worker without the lease is refused.
 */
export async function updateReleaseJob(db: Database, input: {
  tenantId: string; owner: string; jobId: string; leaseSeconds?: number;
  patch: { stage?: ReleaseJob["stage"] | undefined; progress?: ReleaseJob["progress"] | undefined; status?: "running" | "failed" | "completed" | "cancelled" | undefined;
    error?: string | null | undefined; reportDigest?: string | null | undefined; releaseDigest?: string | null | undefined };
}): Promise<{ job: ReleaseJob; cancellationRequested: boolean }> {
  const lease = Math.min(Math.max(input.leaseSeconds ?? 600, 30), 3600);
  return scoped(db, input.tenantId, async client => {
    const row = (await client.query("select * from harness_control.factory_release_jobs where tenant_id=$1 and job_id=$2 for update", [input.tenantId, input.jobId])).rows[0];
    if (!row) throw new FactoryError("factory.job_not_found", 404);
    if (row.lease_owner !== input.owner || !["running", "cancelling"].includes(row.status) || new Date(row.lease_until) < new Date()) {
      throw new FactoryError("factory.job_lease_lost", 409);
    }
    const job = jobFrom(row);
    const next: ReleaseJob = releaseJobSchema.parse({
      ...job, stage: input.patch.stage ?? job.stage, progress: { ...job.progress, ...(input.patch.progress ?? {}) },
      error: input.patch.error === undefined ? job.error : input.patch.error,
      reportDigest: input.patch.reportDigest === undefined ? job.reportDigest : input.patch.reportDigest,
      releaseDigest: input.patch.releaseDigest === undefined ? job.releaseDigest : input.patch.releaseDigest,
    });
    const finished = input.patch.status && input.patch.status !== "running";
    const status = finished ? (row.cancellation_requested && input.patch.status !== "completed" ? "cancelled" : input.patch.status!) : row.status;
    const updated = await client.query(`update harness_control.factory_release_jobs set status=$3, stage=$4, body=$5::jsonb, updated_at=transaction_timestamp(),
      lease_owner=case when $6 then null else lease_owner end, lease_until=case when $6 then null else now() + make_interval(secs => $7) end
      where tenant_id=$1 and job_id=$2 returning *`, [input.tenantId, input.jobId, status, next.stage, JSON.stringify(next), Boolean(finished), lease]);
    if (finished || input.patch.stage !== job.stage) await event(client, input.tenantId, finished ? `job.${status}` : "job.stage", input.jobId, input.owner, { stage: next.stage, error: next.error });
    return { job: jobFrom(updated.rows[0]), cancellationRequested: Boolean(updated.rows[0].cancellation_requested) };
  });
}

// ---------------------------------------------------------------- evaluation and releases

export async function recordEvaluationReport(db: Database, input: { tenantId: string; actor: string; report: unknown }): Promise<EvaluationReport> {
  const report = evaluationReportSchema.parse(input.report);
  const { reportDigest, ...body } = report;
  if (stableDigest(body) !== reportDigest) throw new FactoryError("factory.report_digest_mismatch");
  return scoped(db, input.tenantId, async client => {
    await client.query(`insert into harness_control.factory_evaluation_reports(tenant_id,report_digest,job_id,body) values ($1,$2,$3,$4::jsonb)
      on conflict (tenant_id, report_digest) do nothing`, [input.tenantId, reportDigest, report.jobId, JSON.stringify(report)]);
    await event(client, input.tenantId, "report.recorded", reportDigest, input.actor, { jobId: report.jobId, types: report.types.length });
    return report;
  });
}

export async function getEvaluationReport(db: Database, tenantId: string, digest: string): Promise<EvaluationReport | null> {
  return scoped(db, tenantId, async client => {
    const row = (await client.query("select body from harness_control.factory_evaluation_reports where tenant_id=$1 and report_digest=$2", [tenantId, digest])).rows[0];
    return row ? evaluationReportSchema.parse(row.body) : null;
  });
}

/**
 * Register a release candidate: the manifest, and an artifact-registry entry whose registrant is the job's creator.
 * Refused unless every type's gates were met in the named report.
 */
export async function registerFactoryRelease(db: Database, input: { tenantId: string; registrant: string; jobId: string; manifest: unknown }): Promise<{ digest: string; release: DocumentModelRelease }> {
  const release = documentModelReleaseSchema.parse(input.manifest);
  const digest = stableDigest(release);
  return scoped(db, input.tenantId, async client => {
    const report = (await client.query("select body from harness_control.factory_evaluation_reports where tenant_id=$1 and report_digest=$2 and job_id=$3",
      [input.tenantId, release.evaluationReportDigest, input.jobId])).rows[0];
    if (!report) throw new FactoryError("factory.release_report_missing", 409);
    const check = releaseActivatable(release, evaluationReportSchema.parse(report.body));
    if (!check.ok) throw new FactoryError(check.reason, 409);
    await client.query(`insert into harness_control.factory_releases(tenant_id,release_digest,release_id,job_id,report_digest,body,created_by)
      values ($1,$2,$3,$4,$5,$6::jsonb,$7) on conflict (tenant_id, release_digest) do nothing`,
      [input.tenantId, digest, release.releaseId, input.jobId, release.evaluationReportDigest, JSON.stringify(release), input.registrant]);
    await registerArtifact(client as unknown as RegistryClient, { tenantId: input.tenantId, kind: RELEASE_KIND, digest, reference: `document-model-release:${release.releaseId}`, actor: input.registrant });
    await event(client, input.tenantId, "release.registered", digest, input.registrant, { releaseId: release.releaseId, types: release.types.map(t => t.documentType) });
    return { digest, release };
  });
}

/** Approve a release (`release.approve`); the artifact registry refuses the registrant. */
export async function approveFactoryRelease(db: Database, input: { tenantId: string; actor: string; digest: string }) {
  return scoped(db, input.tenantId, async client => {
    try {
      const entry = await approveArtifact(client as unknown as RegistryClient, { tenantId: input.tenantId, kind: RELEASE_KIND, digest: input.digest, actor: input.actor });
      await event(client, input.tenantId, "release.approved", input.digest, input.actor);
      return entry;
    } catch (error) {
      if (error instanceof Error && error.message === "artifact.separation_of_duties") throw new FactoryError("factory.separation_of_duties", 403);
      if (error instanceof Error && error.message === "artifact.not_registered") throw new FactoryError("factory.release_not_found", 404);
      throw error;
    }
  });
}

type ActivationRow = { activation_id: string; release_digest: string; environment: string; kind: string; effective_from: Date; actor: string; reason: string; created_at: Date };
const activationView = (row: ActivationRow) => ({ activationId: row.activation_id, releaseDigest: row.release_digest, environment: row.environment, kind: row.kind,
  effectiveFrom: new Date(row.effective_from).toISOString(), actor: row.actor, reason: row.reason, createdAt: new Date(row.created_at).toISOString() });

/** The release whose activation started last (and has started) in an environment, from its activation history. */
export function factoryReleaseInEffect(activations: ReturnType<typeof activationView>[], environment: string, at = new Date()): string | null {
  const started = activations.filter(a => a.environment === environment && Date.parse(a.effectiveFrom) <= at.getTime())
    .sort((a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return started[0]?.releaseDigest ?? null;
}

/**
 * Activate an approved release in an environment, now or from a date. Requires a fresh registry read (approved,
 * not revoked) and the evaluation report's gates met for every type.
 */
export async function activateFactoryRelease(db: Database, input: { tenantId: string; actor: string; digest: string; environment: string; effectiveFrom?: string | undefined; reason: string }) {
  if (!/^[a-z][a-z0-9_-]{0,39}$/.test(input.environment)) throw new FactoryError("factory.environment_invalid");
  return scoped(db, input.tenantId, async client => {
    const row = (await client.query("select body from harness_control.factory_releases where tenant_id=$1 and release_digest=$2", [input.tenantId, input.digest])).rows[0];
    if (!row) throw new FactoryError("factory.release_not_found", 404);
    try {
      await requireApprovedArtifact(client as unknown as RegistryClient, input.tenantId, RELEASE_KIND, input.digest);
    } catch (error) {
      throw new FactoryError(error instanceof Error && error.message.startsWith("artifact.revoked") ? "factory.release_revoked" : "factory.release_not_approved", 409);
    }
    const release = documentModelReleaseSchema.parse(row.body);
    const report = (await client.query("select body from harness_control.factory_evaluation_reports where tenant_id=$1 and report_digest=$2", [input.tenantId, release.evaluationReportDigest])).rows[0];
    const check = report ? releaseActivatable(release, evaluationReportSchema.parse(report.body)) : { ok: false as const, reason: "factory.release_report_missing" };
    if (!check.ok) throw new FactoryError(check.reason, 409);
    const now = new Date();
    const from = input.effectiveFrom ? new Date(input.effectiveFrom) : now;
    if (Number.isNaN(from.getTime()) || from.getTime() > now.getTime() + 5 * 365 * 86_400_000) throw new FactoryError("factory.effective_from_invalid");
    const kind = from.getTime() > now.getTime() ? "SCHEDULE" : "ACTIVATE";
    const inserted = await client.query(`insert into harness_control.factory_release_activations(tenant_id,activation_id,release_digest,environment,kind,effective_from,actor,reason)
      values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [input.tenantId, `fact_${randomUUID().replaceAll("-", "")}`, input.digest, input.environment, kind,
      kind === "ACTIVATE" ? now.toISOString() : from.toISOString(), input.actor, input.reason]);
    await event(client, input.tenantId, `release.${kind.toLowerCase()}`, input.digest, input.actor, { environment: input.environment, effectiveFrom: from.toISOString() });
    return activationView(inserted.rows[0]);
  });
}

/**
 * Roll an environment back: the release in effect before the current one takes effect again, now. Refused when
 * there is nothing earlier, or the earlier release was revoked since.
 */
export async function rollbackFactoryRelease(db: Database, input: { tenantId: string; actor: string; environment: string; reason: string }) {
  return scoped(db, input.tenantId, async client => {
    const rows = (await client.query("select * from harness_control.factory_release_activations where tenant_id=$1 and environment=$2",
      [input.tenantId, input.environment])).rows.map(activationView);
    const current = factoryReleaseInEffect(rows, input.environment);
    if (!current) throw new FactoryError("factory.nothing_in_effect", 409);
    const history = rows.filter(a => Date.parse(a.effectiveFrom) <= Date.now())
      .sort((a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const previous = history.find(a => a.releaseDigest !== current)?.releaseDigest;
    if (!previous) throw new FactoryError("factory.no_previous_release", 409);
    try {
      await requireApprovedArtifact(client as unknown as RegistryClient, input.tenantId, RELEASE_KIND, previous);
    } catch {
      throw new FactoryError("factory.previous_release_not_executable", 409);
    }
    const inserted = await client.query(`insert into harness_control.factory_release_activations(tenant_id,activation_id,release_digest,environment,kind,effective_from,actor,reason)
      values ($1,$2,$3,$4,'ROLLBACK',transaction_timestamp(),$5,$6) returning *`,
      [input.tenantId, `fact_${randomUUID().replaceAll("-", "")}`, previous, input.environment, input.actor, input.reason]);
    await event(client, input.tenantId, "release.rollback", previous, input.actor, { environment: input.environment, from: current });
    return activationView(inserted.rows[0]);
  });
}

/** Releases with registry status, and per environment the release in effect and the activation history. */
export async function listFactoryReleases(db: Database, tenantId: string) {
  return scoped(db, tenantId, async client => {
    const releases = (await client.query(`select r.release_digest, r.release_id, r.job_id, r.report_digest, r.body, r.created_by, r.created_at,
        a.status, a.approved_by, a.approved_at, a.revoked_by, a.reason_code
      from harness_control.factory_releases r left join harness_control.artifact_registry a
        on a.tenant_id=r.tenant_id and a.artifact_kind='document-model-release' and a.digest=r.release_digest
      where r.tenant_id=$1 order by r.created_at desc`, [tenantId])).rows;
    const activations = (await client.query("select * from harness_control.factory_release_activations where tenant_id=$1 order by created_at desc", [tenantId])).rows.map(activationView);
    const environments = [...new Set(activations.map(a => a.environment))].sort();
    return {
      releases: releases.map(row => ({ digest: row.release_digest as string, releaseId: row.release_id as string, jobId: row.job_id as string, reportDigest: row.report_digest as string,
        manifest: documentModelReleaseSchema.parse(row.body), registeredBy: row.created_by as string, registeredAt: new Date(row.created_at).toISOString(),
        status: (row.status ?? "registered") as "registered" | "approved" | "revoked", approvedBy: row.approved_by ?? null,
        approvedAt: row.approved_at ? new Date(row.approved_at).toISOString() : null, revokedBy: row.revoked_by ?? null, revocationReason: row.reason_code ?? null })),
      environments: environments.map(environment => ({ environment, inEffect: factoryReleaseInEffect(activations, environment),
        scheduled: activations.filter(a => a.environment === environment && Date.parse(a.effectiveFrom) > Date.now()) })),
      activations,
    };
  });
}

/**
 * The model a case run's document route uses for one type: the release in effect in `environment`, if it is still
 * approved (not revoked) and releases the type on a model route. Null means no release covers the type, and the
 * caller falls back to the platform's prebuilt routes. Read by the capability gateway (select-only grants).
 */
export async function releasedDocumentModel(db: Database, input: { tenantId: string; environment: string; documentType: string; at?: Date }): Promise<
  { releaseDigest: string; releaseId: string; route: DocumentModelRelease["types"][number]["route"]; mode: DocumentModelRelease["types"][number]["mode"]; providerModelId: string | null } | null> {
  return scoped(db, input.tenantId, async client => {
    const activations = (await client.query("select * from harness_control.factory_release_activations where tenant_id=$1 and environment=$2",
      [input.tenantId, input.environment])).rows.map(activationView);
    const digest = factoryReleaseInEffect(activations, input.environment, input.at);
    if (!digest) return null;
    const row = (await client.query(`select r.body, a.status from harness_control.factory_releases r join harness_control.artifact_registry a
        on a.tenant_id=r.tenant_id and a.artifact_kind='document-model-release' and a.digest=r.release_digest
      where r.tenant_id=$1 and r.release_digest=$2`, [input.tenantId, digest])).rows[0];
    if (!row || row.status !== "approved") return null;
    const release = documentModelReleaseSchema.parse(row.body);
    const type = release.types.find(t => t.documentType === input.documentType);
    if (!type) return null;
    return { releaseDigest: digest, releaseId: release.releaseId, route: type.route, mode: type.mode,
      providerModelId: type.route === "custom" ? release.composedModelId ?? type.providerModelId : type.providerModelId };
  });
}

export async function listFactoryEvents(db: Database, tenantId: string, ref?: string, limit = 100) {
  return scoped(db, tenantId, async client => (await client.query(`select event_id, kind, ref, actor, details, created_at from harness_control.factory_events
    where tenant_id=$1 and ($2::text is null or ref=$2) order by event_id desc limit $3`, [tenantId, ref ?? null, Math.min(Math.max(limit, 1), 500)])).rows
    .map(row => ({ eventId: Number(row.event_id), kind: row.kind as string, ref: row.ref as string, actor: row.actor as string, details: row.details, createdAt: new Date(row.created_at).toISOString() })));
}
