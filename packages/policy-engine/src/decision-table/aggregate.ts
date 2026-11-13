import { z } from "zod";

/**
 * The view of a case a decision-table gate evaluates.
 *
 * This is the domain-neutral half of what the canonical `CaseSnapshot` carries in its
 * `data` field. The contract fixes the envelope — identity, digests, policy authority,
 * consistency — and leaves the aggregate itself open; this says what the gate machinery
 * needs to find in there, and nothing more.
 *
 * It is deliberately open: a domain adds whatever else its policy wants to read, and the
 * path-based extractors reach it. What is fixed is the handful of collections the case
 * store itself defines, because those are what obligations, findings and work items mean
 * everywhere, not only in KYC.
 *
 * Two properties are not negotiable:
 *  - It is a read of the case store, never a payload an agent handed over. A gate that took
 *    agent-supplied facts as arguments would let the agent decide its own gate.
 *  - It carries the sequence it was read at alongside the store's current sequence, so a
 *    decision computed from a superseded read can be rejected rather than applied.
 */

const isoDateTime = z.string().min(1);

export const aggregateEvidenceSchema = z.object({
  evidenceId: z.string().min(1),
  purpose: z.string().min(1),
  sourceType: z.string().min(1),
  trustTier: z.string().min(1),
  instructionTrust: z.string().min(1),
  recordedAt: isoDateTime,
  /** The policy snapshot in force when this evidence was produced. */
  policySnapshotDigest: z.string().min(1).nullable().default(null),
}).passthrough();

export const aggregateClaimSchema = z.object({
  claimId: z.string().min(1),
  predicate: z.string().min(1),
  value: z.unknown(),
  evidenceRefs: z.array(z.string()).default([]),
}).passthrough();

export const aggregateFindingSchema = z.object({
  findingId: z.string().min(1),
  findingType: z.string().min(1),
  status: z.string().min(1).default("OPEN"),
  evidenceRefs: z.array(z.string()).default([]),
}).passthrough();

export const aggregateContradictionSchema = z.object({
  contradictionId: z.string().min(1),
  materiality: z.string().min(1),
  status: z.string().min(1).default("OPEN"),
}).passthrough();

export const aggregateWorkItemSchema = z.object({
  workItemId: z.string().min(1),
  workType: z.string().min(1),
  status: z.string().min(1),
}).passthrough();

export const aggregateRecommendationSchema = z.object({
  recommendationId: z.string().min(1),
  outcome: z.string().min(1),
  policyRuleRefs: z.array(z.string()).default([]),
  findingRefs: z.array(z.string()).default([]),
  evidenceRefs: z.array(z.string()).default([]),
  confidence: z.number().nullable().default(null),
  requiresHumanReview: z.boolean().nullable().default(null),
}).passthrough();

/**
 * One external provider's result. Provider-neutral by construction: a gate asks whether
 * coverage exists and how old the source list was, never which vendor answered.
 */
export const aggregateProviderResultSchema = z.object({
  status: z.enum(["OK", "DEGRADED", "UNAVAILABLE"]),
  screenedAt: isoDateTime.nullable().default(null),
  listVersion: z.string().nullable().default(null),
  listPublishedAt: isoDateTime.nullable().default(null),
}).passthrough();

export const aggregateAttestationSchema = z.object({
  cohortId: z.string().min(1),
  status: z.enum(["VALID", "EXPIRED", "REVOKED"]),
  expiresAt: isoDateTime.nullable().default(null),
  signedBy: z.string().min(1),
}).passthrough();

/**
 * Whether the pinned bundle's institution settings are resolved and approved.
 *
 * This travels on the aggregate rather than being read from the policy source because it is
 * a deployment fact, not a policy statement: the same bundle is unresolved in one
 * environment and approved in another, and a gate has to be able to refuse to act on the
 * former without being recompiled.
 */
export const aggregatePolicyConfigurationSchema = z.object({
  productionReady: z.boolean().nullable().default(null),
  automaticApprovalEnabled: z.boolean().nullable().default(null),
}).passthrough();

export const caseAggregateSchema = z.object({
  /** The sequence the aggregate was read at. */
  caseSequence: z.number().int().nonnegative(),
  /** The store's current sequence. Greater than caseSequence means the read is stale. */
  currentSequence: z.number().int().nonnegative().nullable().default(null),
  evaluatedAt: isoDateTime,
  policyAuthority: z.object({
    policySnapshotDigest: z.string().min(1),
  }).passthrough().nullable().default(null),
  policyConfiguration: aggregatePolicyConfigurationSchema.nullable().default(null),
  attestation: aggregateAttestationSchema.nullable().default(null),
  evidence: z.array(aggregateEvidenceSchema).default([]),
  claims: z.array(aggregateClaimSchema).default([]),
  findings: z.array(aggregateFindingSchema).default([]),
  contradictions: z.array(aggregateContradictionSchema).default([]),
  workItems: z.array(aggregateWorkItemSchema).default([]),
  recommendation: aggregateRecommendationSchema.nullable().default(null),
  /**
   * Set when the case service could not assemble a complete view. The gate reports ERROR
   * rather than guessing; an errored evaluation never advances a case.
   */
  evaluationError: z.string().nullable().default(null),
}).passthrough();

export type CaseAggregate = z.infer<typeof caseAggregateSchema>;
export type AggregateEvidence = z.infer<typeof aggregateEvidenceSchema>;
export type AggregateProviderResult = z.infer<typeof aggregateProviderResultSchema>;
