import { z } from "zod";

/** Identifier shapes shared by every catalog: uppercase tokens joined by hyphens. */
const RULE_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const OBLIGATION_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const REASON_CODE = /^[A-Z][A-Z0-9_]*$/;
const OWNER_INPUT_ID = /^[A-Z0-9][A-Z0-9-]*$/;
const RISK_COHORT_ID = /^RC-[A-Z0-9-]+$/;
const FAILURE_COHORT_ID = /^FC-[A-Z0-9-]+$/;

/**
 * Zod shapes for the authored KYC policy artifacts.
 *
 * The catalogs are meant to be read and argued over by a policy owner, so they are YAML,
 * not code. These schemas are what stops that YAML from drifting into something the
 * compiler cannot turn into a bundle: unknown keys are rejected, every cross-reference is
 * checked by the loader, and a typo in a rule ID fails the build rather than silently
 * producing a gate that enforces nothing.
 */

const id = (pattern: RegExp) => z.string().regex(pattern);

export const policyOutcomeSchema = z.enum(["ALLOW", "BLOCK", "REVIEW", "UNKNOWN", "ERROR"]);
export type PolicyOutcome = z.infer<typeof policyOutcomeSchema>;

const metadataSchema = z.object({
  id: z.string().min(1),
  domain: z.string().min(1),
  jurisdiction: z.string().min(1),
  version: z.string().min(1),
  owner: z.string().min(1),
  description: z.string().min(1),
}).passthrough();

// ---------------------------------------------------------------- reason codes

export const reasonCodeSchema = z.object({
  code: id(REASON_CODE),
  outcome: policyOutcomeSchema,
  summary: z.string().min(1),
  analystGuidance: z.string().min(1),
  routeTo: z.string().min(1).nullable(),
  priority: z.enum(["NORMAL", "HIGH", "URGENT"]),
  retryable: z.boolean(),
  humanAuthorityRequired: z.boolean(),
  dualControlRequired: z.boolean().default(false),
  authorityBasis: z.string().min(1).optional(),
  ownerInputRefs: z.array(id(OWNER_INPUT_ID)).default([]),
  retired: z.boolean().default(false),
}).strict();

export const reasonCodeRegistrySchema = z.object({
  apiVersion: z.literal("harness.factory/reason-codes-v1"),
  kind: z.literal("ReasonCodeRegistry"),
  metadata: metadataSchema,
  spec: z.object({
    outcomes: z.array(policyOutcomeSchema),
    queues: z.array(z.object({
      id: z.string().min(1),
      name: z.string().min(1),
      description: z.string().min(1),
    }).strict()),
    codes: z.array(reasonCodeSchema).min(1),
  }).strict(),
}).strict();

// ---------------------------------------------------------------- rules

export const ruleSchema = z.object({
  id: id(RULE_ID),
  category: z.string().min(1),
  title: z.string().min(1),
  statement: z.string().min(1),
  severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW"]),
  automationClass: z.enum(["DETERMINISTIC_GATE", "AGENT_CONTRIBUTION", "HUMAN_ONLY"]),
  appliesTo: z.array(z.string().min(1)),
  evidenceObligations: z.array(id(OBLIGATION_ID)),
  reasonCode: id(REASON_CODE),
  authorityBasis: z.string().min(1),
  enforcedBy: z.array(z.string().min(1)),
  ownerInputRefs: z.array(id(OWNER_INPUT_ID)).default([]),
}).strict();

export const ruleCatalogSchema = z.object({
  apiVersion: z.literal("harness.factory/rule-catalog-v1"),
  kind: z.literal("RuleCatalog"),
  metadata: metadataSchema,
  spec: z.object({
    automationClasses: z.array(z.string()),
    severities: z.array(z.string()),
    categories: z.array(z.object({ id: z.string().min(1), name: z.string().min(1) }).strict()),
    rules: z.array(ruleSchema).min(1),
  }).strict(),
}).strict();

// ---------------------------------------------------------------- evidence obligations

export const evidenceObligationSchema = z.object({
  id: id(OBLIGATION_ID),
  name: z.string().min(1),
  purpose: id(REASON_CODE),
  description: z.string().min(1),
  acceptableSourceTypes: z.array(z.enum(["TOOL", "UPLOAD", "INTERNAL_SYSTEM", "HUMAN", "DERIVED"])).min(1),
  minimumTrustTier: z.string().min(1),
  instructionTrust: z.enum(["TRUSTED", "UNTRUSTED_DATA", "UNTRUSTED_EXTERNAL"]),
  freshnessDays: z.number().int().positive().nullable(),
  requiredFor: z.array(z.string().min(1)),
  satisfiedBy: z.array(id(RULE_ID)),
  ownerInputRefs: z.array(id(OWNER_INPUT_ID)).default([]),
}).strict();

export const evidenceObligationCatalogSchema = z.object({
  apiVersion: z.literal("harness.factory/evidence-obligations-v1"),
  kind: z.literal("EvidenceObligationCatalog"),
  metadata: metadataSchema,
  spec: z.object({
    freshnessUnit: z.literal("days"),
    obligations: z.array(evidenceObligationSchema).min(1),
  }).strict(),
}).strict();

// ---------------------------------------------------------------- cohorts

const selectorValue = z.union([z.string(), z.boolean(), z.array(z.string())]);

export const riskCohortSchema = z.object({
  id: id(RISK_COHORT_ID),
  name: z.string().min(1),
  selector: z.record(z.string(), selectorValue),
  automaticApprovalEligible: z.boolean(),
  requiresAttestation: z.boolean(),
  minimumCorpusCases: z.number().int().nonnegative(),
  description: z.string().min(1).optional(),
  ownerInputRefs: z.array(id(OWNER_INPUT_ID)).default([]),
}).strict();

export const failureCohortSchema = z.object({
  id: id(FAILURE_COHORT_ID),
  name: z.string().min(1),
  description: z.string().min(1),
  requiredOutcome: policyOutcomeSchema,
  requiredReasonCode: id(REASON_CODE),
  minimumCorpusCases: z.number().int().nonnegative(),
}).strict();

export const cohortCatalogSchema = z.object({
  apiVersion: z.literal("harness.factory/cohorts-v1"),
  kind: z.literal("CohortCatalog"),
  metadata: metadataSchema,
  spec: z.object({
    assignmentPrecedence: z.array(id(RISK_COHORT_ID)).min(1),
    requiredAttributes: z.array(z.string().min(1)).min(1),
    attributePaths: z.record(z.string(), z.string().min(1)),
    minimumTotalCases: z.number().int().positive(),
    riskCohorts: z.array(riskCohortSchema).min(1),
    failureCohorts: z.array(failureCohortSchema).min(1),
  }).strict(),
}).strict();

// ---------------------------------------------------------------- owner inputs

export const ownerInputSchema = z.object({
  id: id(OWNER_INPUT_ID),
  title: z.string().min(1),
  question: z.string().min(1),
  owner: z.string().min(1),
  status: z.enum(["UNRESOLVED", "PROPOSED", "RESOLVED"]),
  blocksRelease: z.boolean(),
  reasonCode: id(REASON_CODE),
  placeholder: z.record(z.string(), z.unknown()),
  affects: z.array(z.string()),
}).strict();

export const ownerInputRegisterSchema = z.object({
  apiVersion: z.literal("harness.factory/owner-inputs-v1"),
  kind: z.literal("OwnerInputRegister"),
  metadata: metadataSchema,
  spec: z.object({
    releaseRule: z.string().min(1),
    inputs: z.array(ownerInputSchema).min(1),
  }).strict(),
}).strict();

// ---------------------------------------------------------------- decision tables

/**
 * Every extractor resolves a slice of the case snapshot to exactly one discrete token.
 * Keeping the vocabulary this small is what lets the same table drive the TypeScript
 * reference evaluator and the Rego bundle and stay legible to a policy owner.
 */
export const extractorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("evaluationStatus") }).strict(),
  z.object({ kind: z.literal("snapshotFreshness") }).strict(),
  z.object({ kind: z.literal("riskCohort") }).strict(),
  z.object({ kind: z.literal("cohortEligibility") }).strict(),
  z.object({ kind: z.literal("attestationStatus") }).strict(),
  z.object({ kind: z.literal("recommendationCitations") }).strict(),
  z.object({
    kind: z.literal("presence"),
    collection: z.enum(["evidence", "claims", "findings", "contradictions", "workItems"]),
    where: z.record(z.string(), z.union([z.string(), z.boolean()])),
    presentToken: z.string().default("PRESENT"),
    absentToken: z.string().default("ABSENT"),
  }).strict(),
  z.object({
    kind: z.literal("itemStatus"),
    collection: z.enum(["workItems", "findings", "contradictions"]),
    where: z.record(z.string(), z.union([z.string(), z.boolean()])),
    statusPath: z.string().min(1),
    map: z.record(z.string(), z.string()),
    absent: z.string().min(1),
    otherwise: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("strongestFinding"),
    collection: z.literal("findings"),
    openOnly: z.boolean().default(true),
    ranking: z.array(z.object({ findingType: z.string().min(1), token: z.string().min(1) }).strict()).min(1),
    absentToken: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("digestMatch"),
    left: z.object({
      collection: z.enum(["claims"]),
      where: z.record(z.string(), z.union([z.string(), z.boolean()])),
      valuePath: z.string().min(1),
    }).strict(),
    right: z.object({ path: z.string().min(1) }).strict(),
  }).strict(),
  z.object({
    kind: z.literal("attributesComplete"),
    path: z.string().min(1),
    required: z.array(z.string().min(1)).min(1),
  }).strict(),
  z.object({
    kind: z.literal("obligationFreshness"),
    obligation: id(OBLIGATION_ID),
  }).strict(),
  z.object({
    kind: z.literal("obligationsSatisfied"),
    obligations: z.array(id(OBLIGATION_ID)).optional(),
    scope: z.literal("cohortRequired").optional(),
    exclude: z.array(id(OBLIGATION_ID)).default([]),
  }).strict(),
  z.object({
    kind: z.literal("providerHealth"),
    basePath: z.string().min(1),
    providers: z.array(z.string().min(1)).min(1),
  }).strict(),
  z.object({
    kind: z.literal("listFreshness"),
    basePath: z.string().min(1),
    provider: z.string().min(1),
    maxAgeDaysOwnerInput: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("value"),
    path: z.string().min(1),
    domain: z.array(z.string().min(1)).min(1),
    absentToken: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("booleanValue"),
    path: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("numericThreshold"),
    path: z.string().min(1),
    minimumOwnerInput: z.string().min(1),
  }).strict(),
]);

export const conditionSchema = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
  description: z.string().min(1),
  extractor: extractorSchema,
  tokens: z.array(z.string().min(1)).min(2),
}).strict();

const whenSchema = z.record(z.string(), z.union([z.string(), z.array(z.string()).min(1)]));

export const decisionRowSchema = z.object({
  id: z.string().regex(/^[A-Z]{2}-\d{3}$/),
  /** Every rule this row discharges; an evidence row can discharge several at once. */
  rules: z.array(id(RULE_ID)).min(1),
  when: whenSchema,
  outcome: policyOutcomeSchema,
  reasonCode: id(REASON_CODE),
  transitionTo: z.string().min(1).optional(),
  disposition: z.enum(["APPROVED"]).optional(),
  escalation: z.object({
    queue: z.string().min(1),
    dualControl: z.boolean(),
  }).strict().optional(),
}).strict();

export const decisionTableSchema = z.object({
  apiVersion: z.literal("harness.factory/decision-table-v1"),
  kind: z.literal("DecisionTable"),
  metadata: z.object({
    id: z.string().min(1),
    gate: z.string().min(1),
    domain: z.string().min(1),
    version: z.string().min(1),
    owner: z.string().min(1),
    description: z.string().min(1),
    precedence: z.string().min(1).optional(),
  }).strict(),
  spec: z.object({
    transition: z.object({
      from: z.array(z.string().min(1)).min(1),
      onAllow: z.string().min(1),
      onReview: z.string().min(1).optional(),
    }).strict(),
    hitPolicy: z.literal("first"),
    invariants: z.array(z.object({
      id: z.string().min(1),
      statement: z.string().min(1),
      rule: id(RULE_ID),
    }).strict()).default([]),
    conditions: z.array(conditionSchema).min(1),
    rows: z.array(decisionRowSchema).min(1),
    default: z.object({
      rules: z.array(id(RULE_ID)).min(1),
      outcome: policyOutcomeSchema,
      reasonCode: id(REASON_CODE),
    }).strict(),
  }).strict(),
}).strict();

// ---------------------------------------------------------------- policy

export const policySchema = z.object({
  apiVersion: z.literal("harness.factory/policy-v1"),
  kind: z.literal("Policy"),
  metadata: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    domain: z.string().min(1),
    jurisdiction: z.string().min(1),
    owner: z.string().min(1),
    description: z.string().min(1),
    status: z.enum(["DRAFT", "CANDIDATE", "APPROVED", "RETIRED"]),
  }).strict(),
  spec: z.object({
    compilation: z.object({
      target: z.literal("opa"),
      regoVersion: z.literal("v1"),
      entrypoint: z.string().regex(/^data\.[a-z0-9_.]+$/),
      deterministic: z.literal(true),
      networkAccess: z.literal("denied"),
    }).strict(),
    authority: z.object({
      source: z.string().min(1),
      casePath: z.string().min(1),
      requireSnapshotDigest: z.boolean(),
      requireCaseSequence: z.boolean(),
      rejectCrossSnapshotEvidence: z.boolean(),
      staleSnapshotOutcome: policyOutcomeSchema,
    }).strict(),
    subject: z.record(z.string(), z.unknown()),
    institutionSettings: z.object({
      automaticDeclineEnabled: z.literal(false),
      automaticApprovalEnabled: z.boolean().nullable(),
    }).passthrough(),
    commandMappings: z.object({
      recordEvaluation: z.object({ commandType: z.string().min(1) }).strict(),
      routeHumanReview: z.object({ commandType: z.string().min(1) }).strict(),
      finalizeDisposition: z.object({
        commandType: z.string().min(1),
        authority: z.literal("HUMAN_ONLY"),
      }).strict(),
    }).strict(),
    evaluation: z.object({
      corpus: z.string().min(1),
      minimumCases: z.number().int().positive(),
    }).strict(),
    defaultOutcome: policyOutcomeSchema,
    unknownHandling: policyOutcomeSchema,
    errorHandling: policyOutcomeSchema,
    outcomes: z.array(policyOutcomeSchema),
    authorityMatrix: z.record(z.string(), z.unknown()),
    catalog: z.object({
      rules: z.string().min(1),
      reasonCodes: z.string().min(1),
      evidenceObligations: z.string().min(1),
      cohorts: z.string().min(1),
      ownerInputs: z.string().min(1),
    }).strict(),
    gates: z.record(z.string(), z.object({
      description: z.string().min(1),
      table: z.string().min(1),
      transition: z.object({
        from: z.array(z.string().min(1)).min(1),
        to: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
      }).strict(),
      mayFinalizeDisposition: z.boolean(),
      finalizeConstraints: z.object({
        allowedDispositions: z.array(z.literal("APPROVED")),
        eligibleCohorts: z.array(id(RISK_COHORT_ID)),
        requiresAttestation: z.boolean(),
        ownerInputRefs: z.array(id(OWNER_INPUT_ID)).default([]),
      }).strict().optional(),
    }).strict()),
    routing: z.record(z.string(), z.unknown()),
    audit: z.record(z.string(), z.unknown()),
  }).strict(),
}).strict();

export type ReasonCode = z.infer<typeof reasonCodeSchema>;
export type Rule = z.infer<typeof ruleSchema>;
export type EvidenceObligation = z.infer<typeof evidenceObligationSchema>;
export type RiskCohort = z.infer<typeof riskCohortSchema>;
export type FailureCohort = z.infer<typeof failureCohortSchema>;
export type OwnerInput = z.infer<typeof ownerInputSchema>;
export type DecisionTable = z.infer<typeof decisionTableSchema>;
export type DecisionRow = z.infer<typeof decisionRowSchema>;
export type Condition = z.infer<typeof conditionSchema>;
export type Extractor = z.infer<typeof extractorSchema>;
export type Policy = z.infer<typeof policySchema>;
