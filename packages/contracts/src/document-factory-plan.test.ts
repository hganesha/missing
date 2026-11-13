import { expect, it } from "vitest";
import { stableDigest } from "./index.js";
import { DEFAULT_FACTORY_GATES, planReleaseJob, type DatasetVersion, type TypeStrategy } from "./document-factory.js";

const sha = (seed: string) => stableDigest({ seed });
const strategy = (documentType: string, s: TypeStrategy["strategy"]): TypeStrategy => ({ documentType, contractHash: sha(documentType), strategy: s, modelFamily: null, rationale: "r", owner: "o" });
const dataset = (documentType: string, test = 12, train = 20): DatasetVersion => ({
  datasetDigest: sha(`${documentType}-data`), documentType, contractHash: sha(documentType), previousDigest: null,
  counts: { train, validation: 5, test }, groups: { train: 5, validation: 2, test: 4 }, labelSetDigest: sha("l"),
  readiness: { train: train >= 20, validation: true, test_pipeline_proof: true, test_qualification: false },
  storageRef: "s", excluded: 0, registeredAt: new Date().toISOString(), registeredBy: "w",
});

it("plans per type: blocked types say what is missing, unchanged models are reused, and the estimate shows its basis", () => {
  const { plan, estimate } = planReleaseJob({
    selection: ["w9", "passport", "utility_bill", "articles_of_association", "annual_return", "w8bene"], gates: DEFAULT_FACTORY_GATES,
    strategies: [strategy("w9", "azure_template"), strategy("passport", "azure_prebuilt"), strategy("utility_bill", "azure_neural"),
      strategy("articles_of_association", "layout_llm"), strategy("w8bene", "azure_template")],
    datasets: [dataset("w9"), dataset("passport"), dataset("utility_bill"), dataset("articles_of_association"), dataset("w8bene", 4, 3)],
    models: [{ modelVersionId: "w9-1", documentType: "w9", kind: "template", providerModelId: "ehf-w9-1", datasetDigest: sha("w9-data"), contractHash: sha("w9"),
      trainingJobId: null, trainingHours: null, costUsd: 0, status: "ready", createdAt: new Date().toISOString() }],
  });
  const byType = Object.fromEntries(plan.map(item => [item.documentType, item]));
  expect(byType.w9).toMatchObject({ action: "reuse", reuseModelVersionId: "w9-1" });
  expect(byType.passport?.action).toBe("prebuilt");
  expect(byType.utility_bill?.action).toBe("train");
  expect(byType.articles_of_association?.action).toBe("llm_only");
  expect(byType.annual_return).toMatchObject({ action: "blocked", blockers: ["No strategy is registered for this type.", "No dataset version is registered for this type."] });
  expect(byType.w8bene?.blockers).toEqual(["Training samples: 3 (fewer than the type needs).", "Sealed test documents: 4 of 10 required."]);
  expect(estimate).toMatchObject({ neuralTrainingHours: 1, trainingCostUsd: 0 });
  expect(estimate.basis).toContain("free neural hours");
});
