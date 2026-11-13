import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import { kycPolicyCatalog } from "./catalog.js";
import { corpusPath } from "./corpus.js";
import { buildCorpus, CORPUS_SEED } from "./generate-corpus.js";

/** Writes the golden corpus and its manifest. Importing the builder writes nothing. */
const catalog = kycPolicyCatalog();
const cases = buildCorpus(catalog);
const lines = `${cases.map((corpusCase) => JSON.stringify(corpusCase)).join("\n")}\n`;
writeFileSync(corpusPath("cases.jsonl"), lines);

const riskCohortCounts: Record<string, number> = {};
const failureCohortCounts: Record<string, number> = {};
const outcomeCounts: Record<string, number> = {};
for (const corpusCase of cases) {
  riskCohortCounts[corpusCase.riskCohort] = (riskCohortCounts[corpusCase.riskCohort] ?? 0) + 1;
  for (const failureId of corpusCase.failureCohorts) {
    failureCohortCounts[failureId] = (failureCohortCounts[failureId] ?? 0) + 1;
  }
  for (const expectation of corpusCase.expectations) {
    const key = `${expectation.gate}:${expectation.outcome}`;
    outcomeCounts[key] = (outcomeCounts[key] ?? 0) + 1;
  }
}

const manifest = {
  apiVersion: "harness.factory/corpus-v1",
  kind: "GoldenCorpusManifest",
  metadata: {
    id: "corpus.kyc.golden.v1",
    domain: "kyc",
    jurisdiction: "US",
    version: "1.0.0",
    owner: "kyc-policy-operations",
    description:
      "Adjudicated KYC cases spanning every risk and failure cohort. Each case is judged by a " +
      "policy-owner rubric written independently of the decision tables; the reference evaluator " +
      "and the compiled Rego bundle must both reproduce every verdict.",
    generatedBy: "@ehf/kyc-policy corpus:generate",
    seed: CORPUS_SEED,
  },
  spec: {
    caseCount: cases.length,
    casesFile: "cases.jsonl",
    casesDigest: createHash("sha256").update(lines).digest("hex"),
    riskCohortCounts,
    failureCohortCounts,
    outcomeCounts,
  },
};
writeFileSync(corpusPath("manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`corpus: ${cases.length} cases, digest ${manifest.spec.casesDigest.slice(0, 12)}\n`);
