import { expect, it } from "vitest";
import { checkSystem1Answer, documentAnalysisResultSchema } from "./intelligence-adapters.js";

it("abstains on unbounded choices, invalid types, missing confidence and primitive mismatches", () => {
  const config = { primitive: "choice" as const, options: ["match", "no_match"], minConfidence: 0.9 };
  expect(checkSystem1Answer(config, { primitive: "choice", value: "approve", confidence: 1 })).toEqual({ status: "abstain", reason: "unknown_option" });
  expect(checkSystem1Answer(config, { primitive: "choice", value: "match", confidence: null })).toEqual({ status: "abstain", reason: "confidence_unavailable" });
  expect(checkSystem1Answer(config, { primitive: "choice", value: "match", confidence: 0.89 })).toEqual({ status: "abstain", reason: "low_confidence" });
  expect(checkSystem1Answer(config, { primitive: "choice", value: "match", confidence: 1.2 })).toEqual({ status: "abstain", reason: "invalid_answer" });
  expect(checkSystem1Answer(config, { primitive: "noul", probability: 0.99, confidence: null })).toEqual({ status: "abstain", reason: "unexpected_primitive" });
  expect(checkSystem1Answer(config, { primitive: "choice", value: "match", confidence: 0.9 }).status).toBe("accepted");
  expect(checkSystem1Answer({ ...config, minConfidence: Number.NaN }, { primitive: "choice", value: "match", confidence: 0.9 }).status).toBe("abstain");
});
it("does not reinterpret truth probability as confidence or a score as a numeric probability", () => {
  expect(checkSystem1Answer({ primitive: "noul", options: [], minConfidence: 0.8 }, { primitive: "noul", probability: 0.99, confidence: null })).toEqual({ status: "abstain", reason: "confidence_unavailable" });
  expect(checkSystem1Answer({ primitive: "score", options: ["low", "medium", "high"], minConfidence: 0 }, { primitive: "score", level: "high", confidence: null }).status).toBe("accepted");
  expect(checkSystem1Answer({ primitive: "box", options: [], minConfidence: 0 }, { primitive: "box", box: { top: 0.8, bottom: 0.2, left: 0, right: 1 }, confidence: 1 }).status).toBe("abstain");
});
it("requires output provenance and review for partial or confidence-free document results", () => {
  const result = { contract: "document.analysis.v1", requestId: "request-1", providerJobId: "job-1", status: "succeeded", sourceDigest: "a".repeat(64), modelVersion: "processor-v3", outputRef: "artifact:result", pages: [{ page: 1, fields: [{ path: "name", valueRef: "artifact:result#name", confidence: null, box: null, sourceSpanRef: "artifact:source#page=1" }] }], reviewRequired: true, errorCode: null };
  expect(documentAnalysisResultSchema.safeParse(result).success).toBe(true);
  expect(documentAnalysisResultSchema.safeParse({ ...result, reviewRequired: false }).success).toBe(false);
  expect(documentAnalysisResultSchema.safeParse({ ...result, pages: [] }).success).toBe(false);
  expect(documentAnalysisResultSchema.safeParse({ ...result, outputRef: null }).success).toBe(false);
  expect(documentAnalysisResultSchema.safeParse({ ...result, status: "partial", pages: [], reviewRequired: false }).success).toBe(false);
});

import { System1Error, system1DistributionValid, validateSystem1Answers } from "./intelligence-adapters.js";
it("validates every adapter's answers with one validator and never invents a distribution", () => {
  const questions = { same_value: { type: "choice" as const, instructions: "Same?", criteria: { same: "Same", different: "Different", cannot_tell: "Not decidable" } } };
  const pin = { model: "typesafe/jev-1.13", returnedModel: "typesafe/jev-1.13-20260917" };
  const answer = (choice: string, probabilities: Record<string, number> | null) => ({ model: pin.returnedModel, answers: { same_value: { choice, probabilities } } });
  expect(validateSystem1Answers(answer("same", { same: 0.9, different: 0.05, cannot_tell: 0.05 }), questions, pin).same_value)
    .toEqual({ primitive: "choice", value: "same", confidence: null, probabilities: { same: 0.9, different: 0.05, cannot_tell: 0.05 } });
  expect(validateSystem1Answers(answer("different", null), questions, pin).same_value?.probabilities).toBeNull();
  const reason = (raw: Parameters<typeof validateSystem1Answers>[0]) => { try { validateSystem1Answers(raw, questions, pin); return null; } catch (error) { return (error as System1Error).reason; } };
  expect(reason({ ...answer("same", null), model: "typesafe/jev-1.13" })).toBe("model_substitution");
  expect(reason({ model: pin.returnedModel, answers: {} })).toBe("missing_or_unknown_questions");
  expect(reason(answer("maybe", null))).toBe("invalid_distribution");
  expect(reason(answer("same", { same: 0.4, different: 0.6, cannot_tell: 0 }))).toBe("invalid_distribution");
  expect(reason(answer("same", { same: 1 }))).toBe("invalid_distribution");
  expect(system1DistributionValid(["a", "b"], "a", { a: 0.5, b: 0.5 })).toBe(true);
  expect(checkSystem1Answer({ primitive: "choice", options: ["a", "b"], minConfidence: 0 }, { primitive: "choice", value: "a", confidence: null, probabilities: { a: 0.2, b: 0.8 } }))
    .toEqual({ status: "abstain", reason: "invalid_answer" });
});
