import { expect, it } from "vitest";
import { stableDigest } from "./index.js";
import { DEFAULT_FACTORY_GATES, classifierVersionSchema, documentModelReleaseSchema, evaluateGates, releaseActivatable, typeStrategySchema, type EvaluationReport } from "./document-factory.js";

const sha = (seed: string) => stableDigest({ seed });

it("refuses a prebuilt strategy for a type with no mapped prebuilt model, and a classifier without `other`", () => {
  const strategy = { documentType: "w9", contractHash: sha("w9"), strategy: "azure_prebuilt", modelFamily: null, rationale: "x", owner: "a" };
  expect(typeStrategySchema.safeParse(strategy).success).toBe(false);
  expect(typeStrategySchema.safeParse({ ...strategy, documentType: "passport" }).success).toBe(true);
  expect(classifierVersionSchema.safeParse({ classifierVersionId: "c1", providerClassifierId: "c1", classes: ["w9", "passport"], datasetDigests: {}, parent: null, status: "ready", createdAt: new Date().toISOString() }).success).toBe(false);
});

it("gates a release on its own report: every type evaluated with every gate met", () => {
  const good = { documents: 12, allKeyFieldsCorrect: 12, keyPrecision: 1, keyRecall: 0.9, wrongKeyValues: 0, integrityFailures: 0 };
  const thin = { ...good, documents: 4 };
  expect(evaluateGates(DEFAULT_FACTORY_GATES, good).every(g => g.met)).toBe(true);
  expect(evaluateGates(DEFAULT_FACTORY_GATES, thin).find(g => g.gate === "min_sealed_test")?.met).toBe(false);
  const report: EvaluationReport = { reportDigest: sha("r"), jobId: "job-1", gates: DEFAULT_FACTORY_GATES, classification: null, regressions: [], createdAt: new Date().toISOString(),
    types: [{ documentType: "w9", datasetDigest: sha("d"), route: "custom", release: good, baseline: null, activeRelease: null, gates: evaluateGates(DEFAULT_FACTORY_GATES, good), gatesMet: true }] };
  const release = documentModelReleaseSchema.parse({ apiVersion: "document-factory/v1", kind: "DocumentModelRelease", releaseId: "rel-1", provider: "azure_document_intelligence",
    classifier: { classifierVersionId: "c1", providerClassifierId: "c1" }, composedModelId: "ehf-rel-1",
    types: [{ documentType: "w9", route: "custom", mode: "shadow", modelVersionId: "m1", providerModelId: "ehf-w9-1", datasetDigest: sha("d"), evaluationDigest: sha("r"), gatesMet: true }],
    routePolicyDigest: sha("p"), adjudicationPolicyDigest: sha("a"), evaluationReportDigest: sha("r"), previousReleaseDigest: null, createdAt: new Date().toISOString() });
  expect(releaseActivatable(release, report)).toEqual({ ok: true });
  expect(releaseActivatable({ ...release, evaluationReportDigest: sha("other") }, report)).toEqual({ ok: false, reason: "factory.release_report_mismatch" });
  expect(releaseActivatable(release, { ...report, types: [{ ...report.types[0]!, gatesMet: false }] })).toEqual({ ok: false, reason: "factory.release_gates_unmet:w9" });
  expect(releaseActivatable(release, { ...report, types: [] })).toEqual({ ok: false, reason: "factory.release_type_unevaluated:w9" });
  expect(documentModelReleaseSchema.safeParse({ ...release, classifier: null, composedModelId: null }).success).toBe(false);
});
