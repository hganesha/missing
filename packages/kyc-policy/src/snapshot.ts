import { z } from "zod";

import { caseAggregateSchema } from "@ehf/policy-engine";

/**
 * The view of the canonical case aggregate a policy gate is allowed to see.
 *
 * This is Lane B's provisional shape, published so the compiler, runtime and evaluation
 * lanes have something concrete to build against before the v2 `CaseSnapshot` contract
 * freezes. Lane A owns that contract; when it lands, this file becomes a projection onto
 * it rather than a definition of it, and the version string below moves with it.
 *
 * Two properties matter more than the field list:
 *
 *  - It is a read of the case store, never a payload handed over by an agent. A gate that
 *    accepted agent-supplied facts as arguments would let the agent decide its own gate.
 *  - It carries `caseSequence` (what was read) alongside `currentSequence` (what the store
 *    says is current). A decision computed from a superseded read is rejected rather than
 *    applied, which is why both numbers travel together.
 */
export const CASE_SNAPSHOT_SCHEMA_VERSION = "kyc.case-aggregate.v1" as const;

const isoDateTime = z.string().min(1);

export const snapshotEvidenceSchema = z.object({
  evidenceId: z.string().min(1),
  purpose: z.string().min(1),
  sourceType: z.enum(["TOOL", "UPLOAD", "INTERNAL_SYSTEM", "HUMAN", "DERIVED"]),
  trustTier: z.string().min(1),
  instructionTrust: z.enum(["TRUSTED", "UNTRUSTED_DATA", "UNTRUSTED_EXTERNAL"]),
  recordedAt: isoDateTime,
  /** The policy snapshot in force when this evidence was produced. */
  policySnapshotDigest: z.string().min(1).nullable().default(null),
}).strict();

export const snapshotClaimSchema = z.object({
  claimId: z.string().min(1),
  predicate: z.string().min(1),
  value: z.unknown(),
  evidenceRefs: z.array(z.string()).default([]),
}).strict();

export const snapshotFindingSchema = z.object({
  findingId: z.string().min(1),
  findingType: z.string().min(1),
  status: z.enum(["OPEN", "RESOLVED", "DISMISSED"]).default("OPEN"),
  evidenceRefs: z.array(z.string()).default([]),
}).strict();

export const snapshotContradictionSchema = z.object({
  contradictionId: z.string().min(1),
  materiality: z.enum(["LOW", "MEDIUM", "HIGH"]),
  status: z.enum(["OPEN", "RESOLVED", "ACCEPTED"]).default("OPEN"),
}).strict();

export const snapshotWorkItemSchema = z.object({
  workItemId: z.string().min(1),
  workType: z.string().min(1),
  status: z.enum(["PROPOSED", "IN_PROGRESS", "COMPLETED", "CANCELLED"]),
}).strict();

export const snapshotRecommendationSchema = z.object({
  recommendationId: z.string().min(1),
  outcome: z.string().min(1),
  rationale: z.string().default(""),
  policyRuleRefs: z.array(z.string()).default([]),
  findingRefs: z.array(z.string()).default([]),
  evidenceRefs: z.array(z.string()).default([]),
  confidence: z.number().nullable().default(null),
  requiresHumanReview: z.boolean().nullable().default(null),
}).strict();

/**
 * One screening provider's health and list state. Provider-neutral on purpose: the gate
 * asks whether coverage exists and how old the list was, never which vendor answered.
 */
export const snapshotProviderResultSchema = z.object({
  status: z.enum(["OK", "DEGRADED", "UNAVAILABLE"]),
  screenedAt: isoDateTime.nullable().default(null),
  listVersion: z.string().nullable().default(null),
  listPublishedAt: isoDateTime.nullable().default(null),
}).strict();

export const snapshotAttestationSchema = z.object({
  cohortId: z.string().min(1),
  status: z.enum(["VALID", "EXPIRED", "REVOKED"]),
  expiresAt: isoDateTime.nullable().default(null),
  signedBy: z.string().min(1),
}).strict();

export const kycCaseAggregateSchema = z.object({
  schemaVersion: z.literal(CASE_SNAPSHOT_SCHEMA_VERSION),
  tenantId: z.string().min(1),
  caseId: z.string().min(1),
  /** The sequence the snapshot was read at. */
  caseSequence: z.number().int().nonnegative(),
  /** The store's current sequence. Greater than caseSequence means the read is stale. */
  currentSequence: z.number().int().nonnegative().nullable().default(null),
  status: z.string().min(1),
  evaluatedAt: isoDateTime,
  policyAuthority: z.object({
    policyId: z.string().min(1),
    policyVersion: z.string().min(1),
    policySnapshotDigest: z.string().min(1),
  }).strict().nullable().default(null),
  subject: z.object({
    subjectId: z.string().min(1),
    legalName: z.string().nullable().default(null),
    dateOfBirth: z.string().nullable().default(null),
    address: z.string().nullable().default(null),
    taxpayerIdentificationNumber: z.string().nullable().default(null),
    country: z.string().nullable().default(null),
    customerType: z.enum(["individual", "sole_proprietor"]).nullable().default(null),
  }).strict().nullable().default(null),
  risk: z.object({
    riskTier: z.enum(["standard", "elevated", "high"]).nullable().default(null),
    jurisdictionRisk: z.enum(["LOW", "MEDIUM", "HIGH"]).nullable().default(null),
    productRisk: z.enum(["LOW", "MEDIUM", "HIGH"]).nullable().default(null),
    pepExposure: z.boolean().nullable().default(null),
  }).strict().nullable().default(null),
  /**
   * Whether the pinned bundle's institution settings are resolved and approved. It travels
   * on the case rather than being read from the policy because the same bundle is a
   * candidate in one environment and approved in another, and the disposition gate has to
   * be able to refuse to act on a candidate without being recompiled.
   */
  policyConfiguration: z.object({
    productionReady: z.boolean().nullable().default(null),
    automaticApprovalEnabled: z.boolean().nullable().default(null),
  }).strict().nullable().default(null),
  attestation: snapshotAttestationSchema.nullable().default(null),
  evidence: z.array(snapshotEvidenceSchema).default([]),
  claims: z.array(snapshotClaimSchema).default([]),
  findings: z.array(snapshotFindingSchema).default([]),
  contradictions: z.array(snapshotContradictionSchema).default([]),
  workItems: z.array(snapshotWorkItemSchema).default([]),
  recommendation: snapshotRecommendationSchema.nullable().default(null),
  screening: z.object({
    sanctions: snapshotProviderResultSchema.nullable().default(null),
    pep: snapshotProviderResultSchema.nullable().default(null),
    adverseMedia: snapshotProviderResultSchema.nullable().default(null),
  }).strict().nullable().default(null),
  /**
   * Set when the case service could not assemble a complete snapshot. The gate reports
   * ERROR rather than guessing; an errored evaluation never advances a case.
   */
  evaluationError: z.string().nullable().default(null),
}).strict();

export type KycCaseAggregate = z.infer<typeof kycCaseAggregateSchema>;
export type KycEvidence = z.infer<typeof snapshotEvidenceSchema>;
export type KycFinding = z.infer<typeof snapshotFindingSchema>;
export type KycRecommendation = z.infer<typeof snapshotRecommendationSchema>;
export type KycProviderResult = z.infer<typeof snapshotProviderResultSchema>;
