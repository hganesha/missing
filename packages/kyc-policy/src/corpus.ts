import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import { decisionTableOutcomeSchema as policyOutcomeSchema } from "@ehf/policy-engine";

import { KYC_POLICY_ROOT } from "./catalog.js";
import { kycCaseAggregateSchema, type KycCaseAggregate } from "./snapshot.js";

/** Gates are adjudicated in lifecycle order; a corpus case may exercise any subset. */
export const GATE_ORDER = ["screening-ready", "decision-ready", "disposition"] as const;
export type GateId = (typeof GATE_ORDER)[number];

export const corpusExpectationSchema = z.object({
  gate: z.enum(GATE_ORDER),
  outcome: policyOutcomeSchema,
  reasonCode: z.string().min(1),
  /**
   * Why a policy owner would reach this outcome, in their words. It is the part of the
   * corpus a human can disagree with, which is what makes the corpus an adjudication
   * rather than a recording of whatever the code happened to do.
   */
  rationale: z.string().min(1),
}).strict();

export const corpusCaseSchema = z.object({
  caseId: z.string().min(1),
  riskCohort: z.string().min(1),
  failureCohorts: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  adjudication: z.object({
    adjudicatedBy: z.string().min(1),
    adjudicatedAt: z.string().min(1),
    method: z.string().min(1),
  }).strict(),
  snapshot: kycCaseAggregateSchema,
  expectations: z.array(corpusExpectationSchema).min(1),
}).strict();

export type CorpusCase = z.infer<typeof corpusCaseSchema>;
export type CorpusExpectation = z.infer<typeof corpusExpectationSchema>;

export const corpusManifestSchema = z.object({
  apiVersion: z.literal("harness.factory/corpus-v1"),
  kind: z.literal("GoldenCorpusManifest"),
  metadata: z.object({
    id: z.string().min(1),
    domain: z.string().min(1),
    jurisdiction: z.string().min(1),
    version: z.string().min(1),
    owner: z.string().min(1),
    description: z.string().min(1),
    generatedBy: z.string().min(1),
    seed: z.number().int(),
  }).strict(),
  spec: z.object({
    caseCount: z.number().int().positive(),
    casesFile: z.string().min(1),
    /** sha256 of the cases file, so a hand-edited corpus is caught rather than trusted. */
    casesDigest: z.string().regex(/^[a-f0-9]{64}$/),
    riskCohortCounts: z.record(z.string(), z.number().int().nonnegative()),
    failureCohortCounts: z.record(z.string(), z.number().int().nonnegative()),
    outcomeCounts: z.record(z.string(), z.number().int().nonnegative()),
  }).strict(),
}).strict();

export type CorpusManifest = z.infer<typeof corpusManifestSchema>;

export function corpusPath(file: string): string {
  return resolve(KYC_POLICY_ROOT, "fixtures/corpus", file);
}

export function loadCorpus(file = "cases.jsonl"): CorpusCase[] {
  const raw = readFileSync(corpusPath(file), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return corpusCaseSchema.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(`Corpus line ${index + 1} is invalid: ${(error as Error).message}`);
      }
    });
}

export function loadCorpusManifest(file = "manifest.json"): CorpusManifest {
  return corpusManifestSchema.parse(JSON.parse(readFileSync(corpusPath(file), "utf8")));
}

export type { KycCaseAggregate };
