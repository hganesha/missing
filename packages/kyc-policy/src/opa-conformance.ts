import { kycPolicyCatalog } from "./catalog.js";
import { loadCorpus } from "./corpus.js";
import { evaluateGate } from "@ehf/policy-engine";
import { findOpaBinary, OpaServer } from "./opa.js";

/**
 * Runs every corpus case through the compiled Rego bundle and compares it with the
 * reference evaluator, condition value by condition value.
 *
 * Outcome and reason code agreeing is the headline, but comparing the condition values too
 * is what makes this useful: when an extractor is subtly wrong the outcomes often still
 * coincide by luck on most cases, and the condition diff points straight at the extractor
 * rather than leaving someone to bisect the corpus.
 */
export interface ConformanceReport {
  evaluations: number;
  mismatches: string[];
}

export async function runConformance(): Promise<ConformanceReport> {
  const binary = findOpaBinary();
  if (!binary) throw new Error("No opa binary found. Set OPA_BIN or put opa on PATH.");

  const catalog = kycPolicyCatalog();
  const cases = loadCorpus();
  const server = new OpaServer(binary);
  const mismatches: string[] = [];
  let evaluations = 0;

  await server.start();
  try {
    for (const corpusCase of cases) {
      for (const expectation of corpusCase.expectations) {
        const reference = evaluateGate(expectation.gate, corpusCase.snapshot, catalog);
        const compiled = await server.evaluate(expectation.gate, corpusCase.snapshot);
        evaluations += 1;

        const where = `${corpusCase.caseId} ${expectation.gate}`;
        if (compiled.outcome !== reference.outcome || compiled.reasonCode !== reference.reasonCode) {
          mismatches.push(
            `${where}: rego ${compiled.outcome}/${compiled.reasonCode} (row ${compiled.matchedRowId ?? "default"}) ` +
            `vs reference ${reference.outcome}/${reference.reasonCode} (row ${reference.matchedRowId ?? "default"})`,
          );
        }
        if (compiled.cohortId !== reference.cohortId) {
          mismatches.push(`${where}: cohort rego ${compiled.cohortId} vs reference ${reference.cohortId}`);
        }
        if (compiled.matchedRowId !== reference.matchedRowId) {
          mismatches.push(`${where}: row rego ${compiled.matchedRowId} vs reference ${reference.matchedRowId}`);
        }
        if (compiled.routeTo !== reference.routeTo) {
          mismatches.push(`${where}: queue rego ${compiled.routeTo} vs reference ${reference.routeTo}`);
        }
        for (const [conditionId, referenceValue] of Object.entries(reference.conditionValues)) {
          const compiledValue = compiled.conditionValues[conditionId];
          if (compiledValue !== referenceValue) {
            mismatches.push(
              `${where}: condition ${conditionId} rego ${compiledValue ?? "<absent>"} vs reference ${referenceValue}`,
            );
          }
        }
      }
    }
  } finally {
    server.stop();
  }

  return { evaluations, mismatches };
}

async function main(): Promise<void> {
  const report = await runConformance();
  if (report.mismatches.length > 0) {
    process.stderr.write(`${report.mismatches.length} mismatches across ${report.evaluations} evaluations:\n`);
    for (const mismatch of report.mismatches.slice(0, 40)) process.stderr.write(`  ${mismatch}\n`);
    if (report.mismatches.length > 40) process.stderr.write(`  ... and ${report.mismatches.length - 40} more\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `OPA conformance: ${report.evaluations} evaluations, the compiled bundle and the reference evaluator agree on every one\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
});
