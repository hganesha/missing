import { z } from "zod";

/**
 * Document Factory control-plane contracts (document factory plan §7). The Factory trains, evaluates and releases
 * document extraction models per catalog type. Everything here is tenant-scoped, digest-pinned and append-only:
 * a release is an immutable manifest registered in the artifact registry as `document-model-release`, approved by
 * someone other than its registrant, and activated (or rolled back) through release activation.
 */
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/);
const documentType = z.string().regex(/^[a-z][a-z0-9_]{0,99}$/);
const text = z.string().trim().min(1).max(2000);
const timestamp = z.string().datetime();
const probability = z.number().finite().min(0).max(1);

export const FACTORY_STRATEGIES = ["azure_prebuilt", "azure_template", "azure_neural", "layout_llm", "llm_only"] as const;
export const factoryStrategySchema = z.enum(FACTORY_STRATEGIES);
export type FactoryStrategy = z.infer<typeof factoryStrategySchema>;

/** Prebuilt Azure models the platform maps to catalog fields (packages/adapters document-model-azure.ts). */
export const FACTORY_PREBUILT_MODELS: Readonly<Record<string, string>> = Object.freeze({
  passport: "prebuilt-idDocument", national_identity_card: "prebuilt-idDocument", bank_statement: "prebuilt-bankStatement.us",
});

export const typeStrategySchema = z.object({
  documentType, contractHash: sha, strategy: factoryStrategySchema,
  /** Types sharing a model family train one model (one per family variant cluster). */
  modelFamily: id.nullable(),
  rationale: text, owner: z.string().min(1).max(200),
}).strict().superRefine((value, context) => {
  if (value.strategy === "azure_prebuilt" && !FACTORY_PREBUILT_MODELS[value.documentType]) {
    context.addIssue({ code: "custom", path: ["strategy"], message: "No prebuilt model is mapped for this type" });
  }
});
export type TypeStrategy = z.infer<typeof typeStrategySchema>;

const splitCounts = z.object({ train: z.number().int().min(0), validation: z.number().int().min(0), test: z.number().int().min(0) }).strict();
/** A digest-pinned dataset version (built by `document_factory.datasets.build_dataset_version`). */
export const datasetVersionSchema = z.object({
  datasetDigest: sha, documentType, contractHash: sha, previousDigest: sha.nullable(),
  counts: splitCounts, groups: splitCounts, labelSetDigest: sha,
  readiness: z.object({ train: z.boolean(), validation: z.boolean(), test_pipeline_proof: z.boolean(), test_qualification: z.boolean() }).strict(),
  /** Where the samples and labels live in the dataset store (never case evidence). */
  storageRef: z.string().min(1).max(500),
  excluded: z.number().int().min(0),
  registeredAt: timestamp, registeredBy: z.string().min(1),
}).strict();
export type DatasetVersion = z.infer<typeof datasetVersionSchema>;

export const modelVersionSchema = z.object({
  modelVersionId: id, documentType, kind: z.enum(["template", "neural", "prebuilt"]),
  /** The provider's model ID (a custom model ID, or the prebuilt model name). */
  providerModelId: z.string().min(1).max(200),
  datasetDigest: sha.nullable(), contractHash: sha,
  trainingJobId: id.nullable(), trainingHours: z.number().min(0).nullable(), costUsd: z.number().min(0).nullable(),
  status: z.enum(["training", "ready", "failed", "retired"]),
  createdAt: timestamp,
}).strict();
export type ModelVersion = z.infer<typeof modelVersionSchema>;

export const classifierVersionSchema = z.object({
  classifierVersionId: id, providerClassifierId: z.string().min(1).max(200),
  /** Catalog types plus `other`, which a classifier needs because Azure has no "none of these" output. */
  classes: z.array(z.string().min(1)).min(2).refine(classes => classes.includes("other"), "A classifier includes the `other` class"),
  datasetDigests: z.record(z.string(), sha),
  parent: id.nullable(), status: z.enum(["training", "ready", "failed", "retired"]), createdAt: timestamp,
}).strict();
export type ClassifierVersion = z.infer<typeof classifierVersionSchema>;

/** Per-type promotion gates. A type outside its gates stays out of the release; it never fails the others. */
export const factoryGatesSchema = z.object({
  minSealedTest: z.number().int().min(1).default(10),
  minKeyPrecision: probability.default(0.95),
  minKeyRecall: probability.default(0.8),
  maxWrongKeyValues: z.number().int().min(0).default(0),
  maxIntegrityFailures: z.number().int().min(0).default(0),
}).strict();
export type FactoryGates = z.infer<typeof factoryGatesSchema>;
export const DEFAULT_FACTORY_GATES: FactoryGates = factoryGatesSchema.parse({});

const metrics = z.object({
  documents: z.number().int().min(0), allKeyFieldsCorrect: z.number().int().min(0),
  keyPrecision: probability.nullable(), keyRecall: probability.nullable(),
  wrongKeyValues: z.number().int().min(0), integrityFailures: z.number().int().min(0),
}).strict();
export const typeEvaluationSchema = z.object({
  documentType, datasetDigest: sha, route: z.enum(["custom", "prebuilt", "llm_only", "adjudicated"]),
  release: metrics, baseline: metrics.nullable(), activeRelease: metrics.nullable(),
  gates: z.array(z.object({ gate: z.string().min(1), threshold: z.number(), value: z.number().nullable(), met: z.boolean() }).strict()),
  gatesMet: z.boolean(),
}).strict();
export const evaluationReportSchema = z.object({
  reportDigest: sha, jobId: id, gates: factoryGatesSchema,
  types: z.array(typeEvaluationSchema),
  classification: z.object({ documents: z.number().int().min(0), correct: z.number().int().min(0), otherRecall: probability.nullable() }).strict().nullable(),
  /** Previously released types re-evaluated against this candidate; a regression excludes the type. */
  regressions: z.array(z.object({ documentType, metric: z.string(), before: z.number(), after: z.number() }).strict()),
  createdAt: timestamp,
}).strict();
export type EvaluationReport = z.infer<typeof evaluationReportSchema>;

export const releaseRouteSchema = z.enum(["custom", "prebuilt", "llm_only"]);
export const releaseModeSchema = z.enum(["shadow", "selective", "parallel"]);
/**
 * The `document-model-release` manifest. Its digest is the registry digest. A type is in a release only with its
 * evaluation digest and met gates; changed types start in `shadow`.
 */
export const documentModelReleaseSchema = z.object({
  apiVersion: z.literal("document-factory/v1"), kind: z.literal("DocumentModelRelease"),
  releaseId: id, provider: z.literal("azure_document_intelligence"),
  classifier: z.object({ classifierVersionId: id, providerClassifierId: z.string().min(1) }).strict().nullable(),
  composedModelId: z.string().min(1).nullable(),
  types: z.array(z.object({
    documentType, route: releaseRouteSchema, mode: releaseModeSchema,
    modelVersionId: id.nullable(), providerModelId: z.string().min(1).nullable(),
    datasetDigest: sha.nullable(), evaluationDigest: sha, gatesMet: z.literal(true),
  }).strict()).min(1),
  routePolicyDigest: sha, adjudicationPolicyDigest: sha,
  evaluationReportDigest: sha, previousReleaseDigest: sha.nullable(),
  createdAt: timestamp,
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, type] of value.types.entries()) {
    if (seen.has(type.documentType)) context.addIssue({ code: "custom", path: ["types", index], message: "A type appears once" });
    seen.add(type.documentType);
    if (type.route !== "llm_only" && !type.providerModelId) context.addIssue({ code: "custom", path: ["types", index, "providerModelId"], message: "A model route names its model" });
  }
  if (value.types.some(type => type.route === "custom") && (!value.classifier || !value.composedModelId)) {
    context.addIssue({ code: "custom", path: ["composedModelId"], message: "Custom models are released under a classifier and composed model" });
  }
});
export type DocumentModelRelease = z.infer<typeof documentModelReleaseSchema>;

export const RELEASE_JOB_STAGES = ["readiness", "plan", "approval", "train", "classifier", "compose", "evaluate", "regression", "report"] as const;
export const releaseJobStatusSchema = z.enum(["planned", "awaiting_approval", "queued", "running", "cancelling", "cancelled", "failed", "completed"]);
export type ReleaseJobStatus = z.infer<typeof releaseJobStatusSchema>;

export const releasePlanTypeSchema = z.object({
  documentType, strategy: factoryStrategySchema,
  action: z.enum(["train", "reuse", "prebuilt", "llm_only", "blocked"]),
  /** Exactly what is missing for a blocked type; it does not stop the others. */
  blockers: z.array(z.string().min(1)),
  datasetDigest: sha.nullable(), reuseModelVersionId: id.nullable(),
}).strict();
export const releaseEstimateSchema = z.object({
  neuralTrainingHours: z.number().min(0), trainingCostUsd: z.number().min(0),
  layoutPages: z.number().int().min(0), evaluationCostUsd: z.number().min(0), durationMinutes: z.number().min(0),
  /** The provider allowance this estimate assumes (Azure: 10 free neural hours per month; template and classifier training free). */
  basis: z.string().min(1).max(400),
}).strict();
export const releaseJobSchema = z.object({
  jobId: id, status: releaseJobStatusSchema, stage: z.enum(RELEASE_JOB_STAGES),
  selection: z.array(documentType).min(1).max(300),
  plan: z.array(releasePlanTypeSchema), estimate: releaseEstimateSchema, gates: factoryGatesSchema,
  createdBy: z.string().min(1), createdAt: timestamp,
  spendApprovedBy: z.string().min(1).nullable(), spendApprovedAt: timestamp.nullable(),
  budgetOwnerApprovedBy: z.string().min(1).nullable(),
  progress: z.record(z.string(), z.object({ status: z.enum(["pending", "running", "done", "failed", "excluded", "skipped"]), detail: z.string().max(500).nullable() }).strict()),
  reportDigest: sha.nullable(), releaseDigest: sha.nullable(),
  error: z.string().max(500).nullable(), updatedAt: timestamp,
}).strict();
export type ReleaseJob = z.infer<typeof releaseJobSchema>;

export const createReleaseJobRequestSchema = z.object({
  selection: z.union([z.array(documentType).min(1).max(300), z.literal("changed_since_active")]),
  gates: factoryGatesSchema.partial().optional(),
}).strict();
export type CreateReleaseJobRequest = z.infer<typeof createReleaseJobRequestSchema>;

/** Gate results for one type's metrics. */
export function evaluateGates(gates: FactoryGates, release: z.infer<typeof metrics>): Array<{ gate: string; threshold: number; value: number | null; met: boolean }> {
  return [
    { gate: "min_sealed_test", threshold: gates.minSealedTest, value: release.documents, met: release.documents >= gates.minSealedTest },
    { gate: "min_key_precision", threshold: gates.minKeyPrecision, value: release.keyPrecision, met: release.keyPrecision !== null && release.keyPrecision >= gates.minKeyPrecision },
    { gate: "min_key_recall", threshold: gates.minKeyRecall, value: release.keyRecall, met: release.keyRecall !== null && release.keyRecall >= gates.minKeyRecall },
    { gate: "max_wrong_key_values", threshold: gates.maxWrongKeyValues, value: release.wrongKeyValues, met: release.wrongKeyValues <= gates.maxWrongKeyValues },
    { gate: "max_integrity_failures", threshold: gates.maxIntegrityFailures, value: release.integrityFailures, met: release.integrityFailures <= gates.maxIntegrityFailures },
  ];
}

/**
 * Whether a release manifest may activate: every type carries an evaluation digest found in the report with its
 * gates met, and the report is the one the manifest names.
 */
export function releaseActivatable(release: DocumentModelRelease, report: EvaluationReport): { ok: true } | { ok: false; reason: string } {
  if (release.evaluationReportDigest !== report.reportDigest) return { ok: false, reason: "factory.release_report_mismatch" };
  for (const type of release.types) {
    const evaluation = report.types.find(item => item.documentType === type.documentType);
    if (!evaluation) return { ok: false, reason: `factory.release_type_unevaluated:${type.documentType}` };
    if (!evaluation.gatesMet || evaluation.gates.some(gate => !gate.met)) return { ok: false, reason: `factory.release_gates_unmet:${type.documentType}` };
  }
  return { ok: true };
}

/**
 * Prices the estimate uses, as configured for the deployment. Defaults are Azure Document Intelligence list prices at
 * the time of writing: template and classifier training free, 10 free neural training hours a month then per hour,
 * layout and custom extraction per page. They are an estimate's basis, shown with it, never a bill.
 */
export type FactoryPrices = { neuralHourUsd: number; freeNeuralHours: number; layoutPageUsd: number; customPageUsd: number; neuralHoursPerModel: number };
export const DEFAULT_FACTORY_PRICES: FactoryPrices = { neuralHourUsd: 3, freeNeuralHours: 10, layoutPageUsd: 0.01, customPageUsd: 0.03, neuralHoursPerModel: 1 };

/**
 * The plan and estimate for a release job (plan §7.4 steps 2–3), from what the registry holds. Pure.
 *
 * - A type with no strategy, no dataset, too few training or validation samples (for a trained strategy) or too
 *   small a sealed test is blocked, with exactly what is missing; it does not stop the others.
 * - A trained type whose ready model was built from the same dataset and contract is reused, not retrained.
 */
export function planReleaseJob(input: {
  selection: string[]; gates: FactoryGates; prices?: FactoryPrices;
  strategies: TypeStrategy[]; datasets: DatasetVersion[]; models: ModelVersion[];
}): { plan: Array<z.infer<typeof releasePlanTypeSchema>>; estimate: z.infer<typeof releaseEstimateSchema> } {
  const prices = input.prices ?? DEFAULT_FACTORY_PRICES;
  const plan = [...new Set(input.selection)].sort().map(documentType => {
    const strategy = input.strategies.find(item => item.documentType === documentType);
    const dataset = input.datasets.find(item => item.documentType === documentType) ?? null;
    const blockers: string[] = [];
    if (!strategy) blockers.push("No strategy is registered for this type.");
    if (!dataset) blockers.push("No dataset version is registered for this type.");
    const trained = strategy?.strategy === "azure_template" || strategy?.strategy === "azure_neural";
    if (dataset) {
      if (strategy && dataset.contractHash !== strategy.contractHash) blockers.push("The dataset was labelled against another contract version.");
      if (trained && !dataset.readiness.train) blockers.push(`Training samples: ${dataset.counts.train} (fewer than the type needs).`);
      if (trained && !dataset.readiness.validation) blockers.push(`Validation samples: ${dataset.counts.validation} (fewer than the type needs).`);
      if (dataset.counts.test < input.gates.minSealedTest) blockers.push(`Sealed test documents: ${dataset.counts.test} of ${input.gates.minSealedTest} required.`);
    }
    const reuse = trained && dataset ? input.models.find(model => model.documentType === documentType && model.status === "ready"
      && model.datasetDigest === dataset.datasetDigest && model.contractHash === dataset.contractHash) : undefined;
    const action = blockers.length ? "blocked" as const
      : strategy!.strategy === "azure_prebuilt" ? "prebuilt" as const
        : !trained ? "llm_only" as const : reuse ? "reuse" as const : "train" as const;
    return { documentType, strategy: strategy?.strategy ?? "llm_only", action, blockers, datasetDigest: dataset?.datasetDigest ?? null, reuseModelVersionId: reuse?.modelVersionId ?? null };
  });
  const runnable = plan.filter(item => item.action !== "blocked");
  const datasetOf = (type: string) => input.datasets.find(item => item.documentType === type);
  const neural = runnable.filter(item => item.action === "train" && item.strategy === "azure_neural").length;
  const templates = runnable.filter(item => item.action === "train" && item.strategy === "azure_template").length;
  const neuralTrainingHours = neural * prices.neuralHoursPerModel;
  const trainingDocs = runnable.filter(item => item.action === "train")
    .reduce((sum, item) => sum + (datasetOf(item.documentType)?.counts.train ?? 0) + (datasetOf(item.documentType)?.counts.validation ?? 0), 0);
  const testDocs = runnable.reduce((sum, item) => sum + (datasetOf(item.documentType)?.counts.test ?? 0), 0);
  const modelTestDocs = runnable.filter(item => item.action !== "llm_only").reduce((sum, item) => sum + (datasetOf(item.documentType)?.counts.test ?? 0), 0);
  const layoutPages = trainingDocs + testDocs;
  const round = (value: number) => Math.round(value * 100) / 100;
  return {
    plan,
    estimate: {
      neuralTrainingHours, trainingCostUsd: round(Math.max(0, neuralTrainingHours - prices.freeNeuralHours) * prices.neuralHourUsd),
      layoutPages, evaluationCostUsd: round(layoutPages * prices.layoutPageUsd + modelTestDocs * prices.customPageUsd),
      durationMinutes: Math.round(5 + 45 * neural + 5 * templates + 2 * runnable.length + testDocs * 0.2),
      basis: `Each document counted as one page. Neural training ${prices.neuralHoursPerModel} h per model, with ${prices.freeNeuralHours} free neural hours a month assumed unused, then ${prices.neuralHourUsd} USD per hour. Template and classifier training free. Layout ${prices.layoutPageUsd} USD per page; custom or prebuilt extraction ${prices.customPageUsd} USD per page.`,
    },
  };
}
