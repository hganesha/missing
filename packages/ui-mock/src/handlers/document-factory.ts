import {
  DEFAULT_FACTORY_GATES, DEFAULT_FACTORY_PRICES, evaluateGates, factoryGatesSchema, planReleaseJob,
  type DatasetVersion, type FactoryGates, type ModelVersion, type ReleaseJob, type TypeStrategy,
} from "@ehf/contracts/document-factory";
import type { Schemas } from "@ehf/ui-contracts";
import { clone } from "../fixtures.js";
import { fail, ok, stableJson, type Ctx, type Impl } from "../http.js";

/**
 * The Document Factory in mock mode (PLT-23). The registry is seeded with the ten pilot types. Planning uses the
 * platform's own planner, so readiness, actions and estimates match control-api. A synthetic worker finishes a job
 * as soon as its spend is approved: models ready, a report with gates, and a release registered by the job's
 * planner. Every value is synthetic.
 */
type Release = Schemas["FactoryRelease"];
type Activation = Schemas["FactoryActivation"];
export type FactoryStore = {
  strategies: Array<TypeStrategy & { revision: number; createdBy: string; createdAt: string }>;
  datasets: DatasetVersion[]; models: ModelVersion[]; classifiers: Schemas["FactoryClassifierVersion"][];
  jobs: ReleaseJob[]; jobKeys: Map<string, { body: string; jobId: string }>; reports: Schemas["FactoryEvaluationReport"][];
  releases: Release[]; activations: Activation[]; events: Schemas["FactoryEvent"][];
};

const BUDGET_LIMIT_USD = 25;
const PILOT: Array<[string, TypeStrategy["strategy"], number, number, number]> = [
  // type, strategy, train, validation, test
  ["passport", "azure_prebuilt", 30, 8, 30], ["national_identity_card", "azure_prebuilt", 30, 8, 30], ["bank_statement", "azure_prebuilt", 30, 8, 30],
  ["w9", "azure_template", 30, 8, 30], ["w8bene", "azure_template", 30, 8, 30], ["certificate_of_incorporation", "azure_neural", 40, 10, 30],
  ["annual_return", "azure_neural", 40, 10, 30], ["substantial_shareholder_disclosure", "azure_neural", 40, 10, 30],
  ["utility_bill", "azure_neural", 12, 4, 6], ["articles_of_association", "layout_llm", 20, 5, 30],
];

async function hex(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(value)));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function seed(at: string): Promise<FactoryStore> {
  const store: FactoryStore = { strategies: [], datasets: [], models: [], classifiers: [], jobs: [], jobKeys: new Map(), reports: [], releases: [], activations: [], events: [] };
  for (const [documentType, strategy, train, validation, test] of PILOT) {
    const contractHash = await hex({ contract: documentType });
    store.strategies.push({ documentType, contractHash, strategy, modelFamily: null, rationale: "Sourcing manifest hypothesis (synthetic mock).", owner: "sourcing-manifest", revision: 1, createdBy: "factory-worker", createdAt: at });
    store.datasets.push({ datasetDigest: await hex({ dataset: documentType, v: 1 }), documentType, contractHash, previousDigest: null,
      counts: { train, validation, test }, groups: { train: Math.ceil(train / 2), validation: Math.ceil(validation / 2), test: Math.ceil(test / 2) },
      labelSetDigest: await hex({ labels: documentType }), readiness: { train: train >= 20, validation: validation >= 5, test_pipeline_proof: test >= 10, test_qualification: test >= 30 },
      storageRef: `datasets/${documentType}`, excluded: 0, registeredAt: at, registeredBy: "factory-worker" });
  }
  return store;
}

async function storeFor(ctx: Ctx): Promise<FactoryStore> {
  const key = String(ctx.session.tenant.tenantId);
  if (!ctx.state.documentFactory.has(key)) ctx.state.documentFactory.set(key, await seed(ctx.state.clock));
  return ctx.state.documentFactory.get(key)!;
}

function event(store: FactoryStore, ctx: Ctx, kind: string, ref: string, details: Record<string, unknown> = {}) {
  store.events.unshift({ eventId: store.events.length + 1, kind, ref, actor: ctx.subject, details, createdAt: ctx.state.clock });
}

function inEffect(activations: Activation[], environment: string, now: string): string | null {
  return activations.filter(a => a.environment === environment && a.effectiveFrom <= now)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.createdAt.localeCompare(a.createdAt))[0]?.releaseDigest ?? null;
}

function releasesView(store: FactoryStore, now: string): Schemas["FactoryReleases"] {
  const environments = [...new Set(store.activations.map(a => a.environment))].sort();
  return { releases: clone(store.releases), activations: clone(store.activations),
    environments: environments.map(environment => ({ environment, inEffect: inEffect(store.activations, environment, now), scheduled: store.activations.filter(a => a.environment === environment && a.effectiveFrom > now) })) };
}

function plan(store: FactoryStore, body: Record<string, any> | undefined) {
  const gates: FactoryGates = factoryGatesSchema.parse({ ...DEFAULT_FACTORY_GATES, ...(body?.gates ?? {}) });
  let selection: string[] | null = Array.isArray(body?.selection) ? body.selection.map(String) : null;
  if (body?.selection === "changed_since_active") {
    const released = new Set(store.releases.flatMap(r => r.manifest.types.map(t => `${t.documentType}:${t.datasetDigest}`)));
    selection = store.datasets.filter(d => !released.has(`${d.documentType}:${d.datasetDigest}`)).map(d => d.documentType);
  }
  if (!selection?.length) return null;
  const planned = planReleaseJob({ selection, gates, strategies: store.strategies, datasets: store.datasets, models: store.models, prices: DEFAULT_FACTORY_PRICES });
  return { gates, ...planned, overBudget: planned.estimate.trainingCostUsd + planned.estimate.evaluationCostUsd > BUDGET_LIMIT_USD, budgetLimitUsd: BUDGET_LIMIT_USD };
}

/** The synthetic worker: models, report and release for an approved job. */
async function complete(store: FactoryStore, job: ReleaseJob, at: string) {
  const short = job.jobId.slice(4, 16);
  const types: Schemas["FactoryEvaluationReport"]["types"] = [];
  for (const item of job.plan) {
    if (item.action === "blocked") continue;
    if (item.action === "llm_only") { job.progress[item.documentType] = { status: "skipped", detail: "The LLM route needs no model release." }; continue; }
    if (item.action === "train") store.models.unshift({ modelVersionId: `${item.documentType}-${short}`, documentType: item.documentType,
      kind: item.strategy === "azure_neural" ? "neural" : "template", providerModelId: `ehf-${item.documentType.replaceAll("_", "-")}-${short}`,
      datasetDigest: item.datasetDigest, contractHash: store.datasets.find(d => d.documentType === item.documentType)!.contractHash,
      trainingJobId: job.jobId, trainingHours: item.strategy === "azure_neural" ? 0.6 : null, costUsd: 0, status: "ready", createdAt: at });
    const dataset = store.datasets.find(d => d.documentType === item.documentType)!;
    const precise = item.documentType === "substantial_shareholder_disclosure" ? 0.91 : 0.99;
    const release = { documents: dataset.counts.test, allKeyFieldsCorrect: Math.round(dataset.counts.test * (precise > 0.95 ? 0.93 : 0.7)), keyPrecision: precise, keyRecall: 0.96,
      wrongKeyValues: precise > 0.95 ? 0 : 3, integrityFailures: 0 };
    const gates = evaluateGates(job.gates, release);
    const met = gates.every(g => g.met);
    types.push({ documentType: item.documentType, datasetDigest: dataset.datasetDigest, route: item.action === "prebuilt" ? "prebuilt" : "custom", release,
      baseline: { ...release, keyPrecision: 0.99, keyRecall: 0.99, wrongKeyValues: 0 }, activeRelease: null, gates, gatesMet: met });
    job.progress[item.documentType] = { status: met ? "done" : "excluded", detail: met ? "Gates met." : "Gates not met: " + gates.filter(g => !g.met).map(g => g.gate).join(", ") };
  }
  const body = { jobId: job.jobId, gates: job.gates, types, classification: types.some(t => t.route === "custom") ? { documents: 120, correct: 118, otherRecall: 0.95 } : null, regressions: [], createdAt: at };
  const report = { ...body, reportDigest: await hex(body) };
  store.reports.unshift(report);
  const passing = types.filter(t => t.gatesMet);
  if (passing.length) {
    const custom = passing.some(t => t.route === "custom");
    const manifest: Schemas["FactoryReleaseManifest"] = { apiVersion: "document-factory/v1", kind: "DocumentModelRelease", releaseId: `rel-${short}`, provider: "azure_document_intelligence",
      classifier: custom ? { classifierVersionId: `cls-${short}`, providerClassifierId: `ehf-cls-${short}` } : null, composedModelId: custom ? `ehf-release-${short}` : null,
      types: passing.map(t => ({ documentType: t.documentType, route: t.route === "prebuilt" ? "prebuilt" : "custom", mode: "shadow",
        modelVersionId: t.route === "custom" ? `${t.documentType}-${short}` : null,
        providerModelId: t.route === "custom" ? `ehf-${t.documentType.replaceAll("_", "-")}-${short}` : t.documentType === "bank_statement" ? "prebuilt-bankStatement.us" : "prebuilt-idDocument",
        datasetDigest: t.datasetDigest, evaluationDigest: report.reportDigest, gatesMet: true as const })),
      routePolicyDigest: await hex("routes"), adjudicationPolicyDigest: await hex("adjudication"), evaluationReportDigest: report.reportDigest,
      previousReleaseDigest: store.releases[0]?.digest ?? null, createdAt: at };
    const digest = await hex(manifest);
    store.releases.unshift({ digest, releaseId: manifest.releaseId, jobId: job.jobId, reportDigest: report.reportDigest, manifest, registeredBy: job.createdBy,
      registeredAt: at, status: "registered", approvedBy: null, approvedAt: null, revokedBy: null, revocationReason: null });
    job.releaseDigest = digest;
  }
  Object.assign(job, { status: "completed", stage: "report", reportDigest: report.reportDigest, error: passing.length ? null : "No type met its gates; nothing was released.", updatedAt: at });
}

function jobOf(store: FactoryStore, id: string) { return store.jobs.find(job => job.jobId === id); }

export const documentFactory: Record<string, Impl> = {
  getDocumentFactory: async ctx => {
    const store = await storeFor(ctx);
    const body: Schemas["FactoryOverview"] = { strategies: clone(store.strategies), datasets: clone(store.datasets), models: clone(store.models), classifiers: clone(store.classifiers),
      jobs: clone(store.jobs.slice(0, 20)), ...releasesView(store, ctx.state.clock), budgetLimitUsd: BUDGET_LIMIT_USD, defaultGates: DEFAULT_FACTORY_GATES };
    return ok(ctx, body);
  },
  getDocumentFactoryDatasetsDocumentType: async ctx => ok(ctx, { versions: clone((await storeFor(ctx)).datasets.filter(d => d.documentType === ctx.params.documentType)) }),
  putDocumentFactoryStrategiesDocumentType: async ctx => {
    const store = await storeFor(ctx);
    const previous = store.strategies.find(s => s.documentType === ctx.params.documentType);
    const body = ctx.body as Record<string, any>;
    const next = { documentType: ctx.params.documentType, contractHash: String(body.contractHash), strategy: body.strategy, modelFamily: body.modelFamily ?? null,
      rationale: String(body.rationale), owner: ctx.subject, revision: (previous?.revision ?? 0) + 1, createdBy: ctx.subject, createdAt: ctx.state.clock };
    store.strategies = [...store.strategies.filter(s => s.documentType !== next.documentType), next];
    event(store, ctx, "strategy.saved", next.documentType, { strategy: next.strategy });
    return ok(ctx, next);
  },
  postDocumentFactoryReleasePlan: async ctx => {
    const planned = plan(await storeFor(ctx), ctx.body);
    return planned ? ok(ctx, planned) : fail(ctx, 409, "factory.nothing_changed", "No type has new data since the active release.");
  },
  postDocumentFactoryReleaseJobs: async ctx => {
    const store = await storeFor(ctx);
    const key = ctx.request.headers.get("idempotency-key");
    if (!key) return fail(ctx, 400, "factory.idempotency_key_required", "Retry with an idempotency key.");
    const previous = store.jobKeys.get(key);
    if (previous) return previous.body === stableJson(ctx.body) ? ok(ctx, { ...clone(jobOf(store, previous.jobId)!), overBudget: false, budgetLimitUsd: BUDGET_LIMIT_USD })
      : fail(ctx, 409, "factory.idempotency_conflict", "This request was already used with different content.");
    const planned = plan(store, ctx.body);
    if (!planned) return fail(ctx, 409, "factory.nothing_changed", "No type has new data since the active release.");
    if (!planned.plan.some(item => item.action !== "blocked")) return fail(ctx, 409, "factory.every_type_blocked", "Every selected type is blocked; see readiness.");
    const at = ctx.state.clock;
    const job: ReleaseJob = { jobId: `job_${(await hex({ key, at })).slice(0, 24)}`, status: "awaiting_approval", stage: "approval", selection: planned.plan.map(p => p.documentType),
      plan: planned.plan, estimate: planned.estimate, gates: planned.gates, createdBy: ctx.subject, createdAt: at, spendApprovedBy: null, spendApprovedAt: null, budgetOwnerApprovedBy: null,
      progress: Object.fromEntries(planned.plan.map(p => [p.documentType, { status: p.action === "blocked" ? "excluded" as const : "pending" as const, detail: p.blockers.join(" ") || null }])),
      reportDigest: null, releaseDigest: null, error: null, updatedAt: at };
    store.jobs.unshift(job);
    store.jobKeys.set(key, { body: stableJson(ctx.body), jobId: job.jobId });
    event(store, ctx, "job.created", job.jobId, { selection: job.selection });
    return ok(ctx, { ...clone(job), overBudget: planned.overBudget, budgetLimitUsd: BUDGET_LIMIT_USD });
  },
  getDocumentFactoryReleaseJobsJobId: async ctx => {
    const store = await storeFor(ctx);
    const job = jobOf(store, ctx.params.jobId);
    return job ? ok(ctx, { ...clone(job), events: clone(store.events.filter(e => e.ref === job.jobId)) }) : fail(ctx, 404, "factory.job_not_found", "No such release job.");
  },
  postDocumentFactoryReleaseJobsJobIdApproveSpend: async ctx => {
    const store = await storeFor(ctx);
    const job = jobOf(store, ctx.params.jobId);
    if (!job) return fail(ctx, 404, "factory.job_not_found", "No such release job.");
    if (job.createdBy === ctx.subject || job.spendApprovedBy === ctx.subject) return fail(ctx, 403, "factory.separation_of_duties", "Someone other than the planner (and the first approver) must approve this spend.");
    if (job.status !== "awaiting_approval") return fail(ctx, 409, "factory.job_not_awaiting_approval", "This job is not waiting for approval.");
    const over = job.estimate.trainingCostUsd + job.estimate.evaluationCostUsd > BUDGET_LIMIT_USD;
    if (over && !job.spendApprovedBy) Object.assign(job, { spendApprovedBy: ctx.subject, spendApprovedAt: ctx.state.clock });
    else {
      if (over) job.budgetOwnerApprovedBy = ctx.subject;
      else Object.assign(job, { spendApprovedBy: ctx.subject, spendApprovedAt: ctx.state.clock });
      event(store, ctx, "job.spend_approved", job.jobId);
      await complete(store, job, ctx.state.clock);
      event(store, ctx, "job.completed", job.jobId);
    }
    return ok(ctx, clone(job));
  },
  postDocumentFactoryReleaseJobsJobIdCancel: async ctx => {
    const store = await storeFor(ctx);
    const job = jobOf(store, ctx.params.jobId);
    if (!job || !["planned", "awaiting_approval", "queued", "running"].includes(job.status)) return fail(ctx, 409, "factory.job_not_active", "Only an active job can be cancelled.");
    Object.assign(job, { status: "cancelled", updatedAt: ctx.state.clock });
    event(store, ctx, "job.cancel_requested", job.jobId);
    return ok(ctx, clone(job));
  },
  getDocumentFactoryReportsDigest: async ctx => {
    const report = (await storeFor(ctx)).reports.find(r => r.reportDigest === ctx.params.digest);
    return report ? ok(ctx, clone(report)) : fail(ctx, 404, "factory.report_not_found", "No such evaluation report.");
  },
  getDocumentFactoryReleases: async ctx => ok(ctx, releasesView(await storeFor(ctx), ctx.state.clock)),
  postDocumentFactoryReleasesDigestApprove: async ctx => {
    const store = await storeFor(ctx);
    const release = store.releases.find(r => r.digest === ctx.params.digest);
    if (!release) return fail(ctx, 404, "factory.release_not_found", "No such release.");
    if (release.registeredBy === ctx.subject) return fail(ctx, 403, "factory.separation_of_duties", "The person who planned this release cannot approve it.");
    Object.assign(release, { status: "approved", approvedBy: ctx.subject, approvedAt: ctx.state.clock });
    event(store, ctx, "release.approved", release.digest);
    return ok(ctx, { tenantId: String(ctx.session.tenant.tenantId), kind: "document-model-release", digest: release.digest, reference: `document-model-release:${release.releaseId}`,
      status: "approved", registeredBy: release.registeredBy, approvedBy: ctx.subject, revokedBy: null, reasonCode: null, registeredAt: release.registeredAt, approvedAt: ctx.state.clock, revokedAt: null });
  },
  postDocumentFactoryReleasesDigestActivate: async ctx => {
    const store = await storeFor(ctx);
    const release = store.releases.find(r => r.digest === ctx.params.digest);
    if (!release) return fail(ctx, 404, "factory.release_not_found", "No such release.");
    if (release.status !== "approved") return fail(ctx, 409, "factory.release_not_approved", "A release must be approved by a second person before it is activated.");
    const body = ctx.body as Record<string, any>;
    const scheduled = typeof body.effectiveFrom === "string" && body.effectiveFrom > ctx.state.clock;
    const activation: Activation = { activationId: `fact_${store.activations.length + 1}`, releaseDigest: release.digest, environment: String(body.environment),
      kind: scheduled ? "SCHEDULE" : "ACTIVATE", effectiveFrom: scheduled ? body.effectiveFrom : ctx.state.clock, actor: ctx.subject, reason: String(body.reason), createdAt: ctx.state.clock };
    store.activations.unshift(activation);
    event(store, ctx, `release.${activation.kind.toLowerCase()}`, release.digest, { environment: activation.environment });
    return ok(ctx, activation);
  },
  postDocumentFactoryEnvironmentsEnvironmentRollback: async ctx => {
    const store = await storeFor(ctx);
    const environment = ctx.params.environment;
    const current = inEffect(store.activations, environment, ctx.state.clock);
    if (!current) return fail(ctx, 409, "factory.nothing_in_effect", "Nothing is in effect in this environment.");
    const previous = store.activations.filter(a => a.environment === environment && a.effectiveFrom <= ctx.state.clock && a.releaseDigest !== current)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom) || b.createdAt.localeCompare(a.createdAt))[0];
    if (!previous) return fail(ctx, 409, "factory.no_previous_release", "There is no earlier release to roll back to.");
    const activation: Activation = { activationId: `fact_${store.activations.length + 1}`, releaseDigest: previous.releaseDigest, environment, kind: "ROLLBACK",
      effectiveFrom: ctx.state.clock, actor: ctx.subject, reason: String((ctx.body as Record<string, any>).reason), createdAt: ctx.state.clock };
    store.activations.unshift(activation);
    event(store, ctx, "release.rollback", previous.releaseDigest, { environment, from: current });
    return ok(ctx, activation);
  },
};
