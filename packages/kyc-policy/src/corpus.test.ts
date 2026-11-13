import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { kycPolicyCatalog } from "./catalog.js";
import { corpusPath, GATE_ORDER, loadCorpus, loadCorpusManifest } from "./corpus.js";
import { caseAggregateSchema, evaluateGate } from "@ehf/policy-engine";

const catalog = kycPolicyCatalog();
const cases = loadCorpus();
const manifest = loadCorpusManifest();

describe("golden corpus", () => {
  it("meets the declared scale", () => {
    expect(cases.length).toBe(manifest.spec.caseCount);
    expect(cases.length).toBeGreaterThanOrEqual(catalog.minimumTotalCorpusCases);
  });

  it("has not been edited by hand since it was generated", () => {
    const digest = createHash("sha256").update(readFileSync(corpusPath("cases.jsonl"))).digest("hex");
    expect(digest).toBe(manifest.spec.casesDigest);
  });

  it("uses a unique id per case", () => {
    expect(new Set(cases.map((corpusCase) => corpusCase.caseId)).size).toBe(cases.length);
  });

  it("covers every risk cohort to its declared minimum", () => {
    for (const cohort of catalog.riskCohorts.values()) {
      const count = cases.filter((corpusCase) => corpusCase.riskCohort === cohort.id).length;
      expect(count, `${cohort.id} has ${count} cases, needs ${cohort.minimumCorpusCases}`)
        .toBeGreaterThanOrEqual(cohort.minimumCorpusCases);
    }
  });

  it("covers every failure cohort to its declared minimum", () => {
    for (const cohort of catalog.failureCohorts.values()) {
      const count = cases.filter((corpusCase) => corpusCase.failureCohorts.includes(cohort.id)).length;
      expect(count, `${cohort.id} has ${count} cases, needs ${cohort.minimumCorpusCases}`)
        .toBeGreaterThanOrEqual(cohort.minimumCorpusCases);
    }
  });

  it("makes each failure cohort produce the outcome it was defined to produce", () => {
    for (const corpusCase of cases) {
      for (const failureId of corpusCase.failureCohorts) {
        const cohort = catalog.failureCohorts.get(failureId)!;
        const matching = corpusCase.expectations.some(
          (expectation) =>
            expectation.outcome === cohort.requiredOutcome
            && expectation.reasonCode === cohort.requiredReasonCode,
        );
        expect(
          matching,
          `${corpusCase.caseId} is tagged ${failureId} but no gate produced ` +
          `${cohort.requiredOutcome}/${cohort.requiredReasonCode}`,
        ).toBe(true);
      }
    }
  });

  it("adjudicates gates in lifecycle order with no gaps", () => {
    for (const corpusCase of cases) {
      const gates = corpusCase.expectations.map((expectation) => expectation.gate);
      expect(gates).toEqual(GATE_ORDER.slice(0, gates.length));
    }
  });

  it("gives every expectation a rationale a person could disagree with", () => {
    for (const corpusCase of cases) {
      for (const expectation of corpusCase.expectations) {
        expect(expectation.rationale.length, `${corpusCase.caseId} ${expectation.gate}`).toBeGreaterThan(20);
      }
    }
  });

  it("reaches an automatic approval somewhere, and only in an eligible cohort", () => {
    const approvals = cases.flatMap((corpusCase) =>
      corpusCase.expectations
        .filter((expectation) => expectation.gate === "disposition" && expectation.outcome === "ALLOW")
        .map(() => corpusCase),
    );
    // One approval would prove the path exists but not that it is hard to reach by accident.
    // These are the near-misses: a resolved contradiction, a dismissed finding, confidence
    // exactly at the threshold, evidence exactly at its freshness limit.
    expect(approvals.length).toBeGreaterThanOrEqual(5);
    for (const corpusCase of approvals) {
      const cohort = catalog.riskCohorts.get(corpusCase.riskCohort)!;
      expect(cohort.automaticApprovalEligible, `${corpusCase.caseId} approved in ${cohort.id}`).toBe(true);
    }
  });

  it("never adjudicates an automatic decline", () => {
    for (const corpusCase of cases) {
      for (const expectation of corpusCase.expectations) {
        expect(expectation.reasonCode).not.toBe("DECLINED");
        const code = catalog.reasonCodes.get(expectation.reasonCode)!;
        expect(code.outcome).toBe(expectation.outcome);
      }
    }
  });
});

describe("KYC projection of the case aggregate", () => {
  it("is accepted by the engine's domain-neutral view", () => {
    // The engine reads an open aggregate; this package narrows it to what KYC actually
    // carries. If the narrowing ever stopped being a projection -- a renamed collection, a
    // field that changed shape -- the gate machinery would silently see less than it thinks.
    for (const corpusCase of cases) {
      expect(() => caseAggregateSchema.parse(corpusCase.snapshot), corpusCase.caseId).not.toThrow();
    }
  });

  it("carries the collections every extractor reads", () => {
    const parsed = caseAggregateSchema.parse(cases[0]!.snapshot);
    for (const key of ["evidence", "claims", "findings", "contradictions", "workItems"]) {
      expect(Array.isArray(parsed[key as keyof typeof parsed]), key).toBe(true);
    }
    expect(parsed.policyConfiguration).not.toBeNull();
  });
});

describe("reference evaluator against the corpus", () => {
  it("reproduces every adjudicated verdict", () => {
    const disagreements: string[] = [];
    for (const corpusCase of cases) {
      for (const expectation of corpusCase.expectations) {
        const evaluation = evaluateGate(expectation.gate, corpusCase.snapshot, catalog);
        if (evaluation.outcome !== expectation.outcome || evaluation.reasonCode !== expectation.reasonCode) {
          disagreements.push(
            `${corpusCase.caseId} ${expectation.gate}: adjudicated ` +
            `${expectation.outcome}/${expectation.reasonCode}, tables produced ` +
            `${evaluation.outcome}/${evaluation.reasonCode} via row ${evaluation.matchedRowId ?? "default"}`,
          );
        }
      }
    }
    expect(disagreements.slice(0, 20).join("\n")).toBe("");
    expect(disagreements).toHaveLength(0);
  });

  it("assigns the cohort the corpus says the case is in", () => {
    for (const corpusCase of cases) {
      const evaluation = evaluateGate("disposition", corpusCase.snapshot, catalog);
      expect(evaluation.cohortId, corpusCase.caseId).toBe(corpusCase.riskCohort);
    }
  });

  it("records every condition value, not only the matched one", () => {
    const corpusCase = cases[0]!;
    const table = catalog.tables.get("table.kyc.disposition.v1")!;
    const evaluation = evaluateGate("disposition", corpusCase.snapshot, catalog);
    expect(Object.keys(evaluation.conditionValues).sort())
      .toEqual(table.spec.conditions.map((condition) => condition.id).sort());
  });

  it("is deterministic and independent of collection ordering", () => {
    for (const corpusCase of cases.slice(0, 60)) {
      const shuffled = {
        ...corpusCase.snapshot,
        evidence: [...corpusCase.snapshot.evidence].reverse(),
        findings: [...corpusCase.snapshot.findings].reverse(),
        contradictions: [...corpusCase.snapshot.contradictions].reverse(),
        workItems: [...corpusCase.snapshot.workItems].reverse(),
      };
      for (const gate of GATE_ORDER) {
        const first = evaluateGate(gate, corpusCase.snapshot, catalog);
        const second = evaluateGate(gate, shuffled, catalog);
        expect(second.outcome, `${corpusCase.caseId} ${gate}`).toBe(first.outcome);
        expect(second.reasonCode).toBe(first.reasonCode);
        expect(second.conditionValues).toEqual(first.conditionValues);
      }
    }
  });

  it("routes each non-ALLOW verdict to the queue its reason code names", () => {
    for (const corpusCase of cases) {
      for (const expectation of corpusCase.expectations) {
        const evaluation = evaluateGate(expectation.gate, corpusCase.snapshot, catalog);
        const code = catalog.reasonCodes.get(evaluation.reasonCode)!;
        expect(evaluation.routeTo).toBe(code.routeTo);
        if (evaluation.outcome !== "ALLOW") expect(evaluation.routeTo).not.toBeNull();
      }
    }
  });
});
