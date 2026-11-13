import { businessDecisionGrantSchema, effectivePolicySetSchema } from "./business-decisions.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { planSourceAuthorizationSchema } from "./source-policy.js";
export * from "./source-policy.js";
export * from "./financial-crime.js";
export * from "./products.js";
export * from "./business-decisions.js";

export const effectClassSchema = z.enum([
  "none",
  "read",
  "reversible",
  "paid",
  "external",
  "destructive",
]);

export const capabilityKindSchema = z.enum(["model", "tool", "deterministic"]);

export const capabilityDefinitionSchema = z.object({
  id: z.string().min(1),
  kind: capabilityKindSchema,
  effect: effectClassSchema,
  adapterBindingId: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()).default({}),
  outputSchema: z.record(z.string(), z.unknown()).default({}),
  timeoutMs: z.number().int().positive(),
  maxAttempts: z.number().int().positive().max(10).default(1),
  idempotent: z.boolean(),
}).strict();

export const permissionEnvelopeSchema = z.object({
  nodeId: z.string().min(1),
  capabilities: z.array(z.string().min(1)),
  effects: z.array(effectClassSchema),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const graphEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(["data", "dependency", "control"]),
  condition: z.string().optional(),
  sourcePath: z.string().optional(),
  targetPath: z.string().optional(),
}).strict();

export const businessCommandTypeSchema = z.enum([
  "AddSubject",
  "LinkEvidence",
  "ProposeClaim",
  "AcceptClaimAsFact",
  "RecordScreeningFinding",
  "RecordAssumption",
  "RaiseContradiction",
  "ResolveContradiction",
  "ProposeWorkItem",
  "CompleteWorkItem",
  "LinkExecution",
  "SubmitDecisionRecommendation",
  "RecordGateResult",
  "RecordPolicyEvaluation",
  "RecordQAResult",
  "RecordReview",
  "RequestHumanReview",
  "TransitionCaseStatus",
  "FinalizeDisposition",
  // Case assignment to a team and people (docs/implementation/case-access-model.md).
  "AssignCase",
  // Canonical record store (see the "Canonical records" block at the end of this file).
  "RecordCanonicalRecords",
  "RecordFinancialCrimeOutcome",
  // Moves the case onto the plan and policy pack its policy escalated it to (case.replan only).
  "ReplanCase",
]);

export const caseWriteContractSchema = z.object({
  commandType: businessCommandTypeSchema,
  when: z.string().min(1).optional(),
  /**
   * Repeat the write for each item of a list in the node's result (a path such as
   * `output.documentChecks`); the item is `item` (and `itemIndex`) in `when` and the payload.
   */
  forEach: z.string().regex(/^(output|values|nodeInput)(\.[\w$-]+)+$/).optional(),
  payload: z.record(z.string(), z.unknown()),
  payloadSchema: z.record(z.string(), z.unknown()),
}).strict();

/**
 * Case commands a hosted skill's output may become (skill.execution.v1 §6.2): the evidence link
 * for the skill computation and the commands its proposed records map to.
 */
export const SKILL_PROPOSAL_COMMANDS = [
  "LinkEvidence", "ProposeClaim", "RecordScreeningFinding", "RaiseContradiction", "ProposeWorkItem", "RecordCanonicalRecords",
] as const satisfies readonly z.infer<typeof businessCommandTypeSchema>[];

/**
 * Decision, disposition, review, approval and evaluator records: never a skill's to create
 * (§6.2). Refused as a skill grant by harnessc, as an effect by the gateway, and on the case
 * API's skill-commit and release endpoints. `RecordFinancialCrimeOutcome` is the financial-crime
 * controller's retained observation of an execution (docs/fincrime-integration.md), never a
 * skill's own effect.
 */
export const SKILL_FORBIDDEN_COMMANDS = [
  "FinalizeDisposition", "RecordReview", "RecordQAResult", "RecordGateResult", "RecordPolicyEvaluation", "AcceptClaimAsFact",
  "RecordFinancialCrimeOutcome", "AssignCase",
] as const satisfies readonly z.infer<typeof businessCommandTypeSchema>[];

export function isSkillForbiddenCommand(commandType: string): boolean {
  return (SKILL_FORBIDDEN_COMMANDS as readonly string[]).includes(commandType);
}

/**
 * A node's grant to commit a hosted skill's output (not a declarative write: the runtime never
 * materializes it). `proposal`: a §6.2 record command; `effect`: a `case_command` effect committed
 * when the skill completes; `held`: a `case_command` effect of an approval-required skill, held on
 * the skill node until its approval; `release`: the same command on the node after the approval
 * that commits (or discards) the held effects. `held` and `release` grants go into the envelope's
 * `case_writes_held`, never into `case_writes`, so the case API commits them only through the
 * skill-commit (hold) and release endpoints. harnessc checks every grant against the skill
 * binding's pinned `effects`.
 */
export const SKILL_GRANT_KINDS = ["proposal", "effect", "held", "release"] as const;
export const skillCaseWriteGrantSchema = z.object({
  commandType: businessCommandTypeSchema,
  skillGrant: z.enum(SKILL_GRANT_KINDS),
}).strict();

/** One `config.caseWrites` entry: a declarative case write or a skill grant. */
export const caseWriteEntrySchema = z.union([caseWriteContractSchema, skillCaseWriteGrantSchema]);

export function isSkillCaseWriteGrant(entry: unknown): entry is z.infer<typeof skillCaseWriteGrantSchema> {
  return Boolean(entry) && typeof entry === "object" && !Array.isArray(entry) && "skillGrant" in (entry as Record<string, unknown>);
}

/** Whether a grant goes into the envelope's `case_writes_held` rather than `case_writes`. */
export function isHeldSkillGrant(entry: unknown): boolean {
  return isSkillCaseWriteGrant(entry) && (entry.skillGrant === "held" || entry.skillGrant === "release");
}

/**
 * A plan-declared, node-scoped view of the canonical case snapshot. These are digest-bound
 * into an execution envelope before a runtime may ask the Case API for context.
 */
export const caseReadGrantSchema = z.object({
  id: z.string().min(1),
  source: z.enum(["case", "evidence", "policy"]),
  path: z.string().min(1),
  purpose: z.string().min(1),
  classification: z.string().min(1),
  required: z.boolean(),
  /**
   * Canonical-record selector (`path: records.<ObjectType>`): the skill library's requirement
   * shape. The case store projects only these fields; the context plane turns an unmet
   * `minCount` into CONTEXT_MISSING and an age above `maxAgeSeconds` into CONTEXT_STALE.
   * See `canonicalRecordRequirementSchema` and docs/implementation/canonical-records.md.
   */
  record: z.object({
    objectType: z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/),
    fields: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).min(1).max(64),
    /** Of `fields`, those a record may lack (an optional data-model field): projected when present, never a gap. */
    nullableFields: z.array(z.string().regex(/^[a-z][a-z0-9_]{0,63}$/)).max(64).optional(),
    minCount: z.number().int().nonnegative(),
    maxAgeSeconds: z.number().int().nonnegative().nullable(),
  }).strict().refine((record) => (record.nullableFields ?? []).every((field) => record.fields.includes(field)), "context.nullable_field_undeclared").optional(),
}).strict();

/**
 * A declarative transformation that is applied to a context value before it can
 * leave the Case Store. The transform kind is an implementation vocabulary; every
 * value that controls its behavior belongs to the compiled domain-package policy.
 */
export const contextMaskTransformSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("replace"),
    replacement: z.string().min(1).max(1_000),
  }).strict(),
  z.object({
    kind: z.literal("partial"),
    visiblePrefix: z.number().int().nonnegative(),
    visibleSuffix: z.number().int().nonnegative(),
    replacement: z.string().min(1).max(64),
  }).strict(),
  z.object({
    kind: z.literal("hash"),
    prefix: z.string().max(64),
  }).strict(),
]);

/**
 * Classification treatment is release configuration, not a Case API constant.
 * Every selector in a v2 plan must have one matching policy. `deny` remains useful
 * for declaring a class the release will not disclose, while `mask` requires an
 * explicit, reviewable transform.
 */
export const contextClassificationPolicySchema = z.object({
  classification: z.string().min(1),
  action: z.enum(["allow", "mask", "deny"]),
  transform: contextMaskTransformSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.action === "mask" && !value.transform) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["transform"], message: "Mask policies require a transform." });
  }
  if (value.action !== "mask" && value.transform) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["transform"], message: "Only mask policies may define a transform." });
  }
});

/**
 * Agent runtimes are pluggable. A runtime adapter is a place the per-node executor can
 * run (a local container, a Kubernetes-hosted runtime service, a Databricks App, ...); the
 * set is open and resolved by the dispatcher's adapter registry, not fixed here.
 */
export const runtimeAdapterIdSchema = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
export const runtimeProviderKindSchema = runtimeAdapterIdSchema;

/**
 * Where a node runs: `<adapter>` (the adapter's administered default binding) or
 * `<adapter>:<binding>` (a named runtime binding). Examples: `local_http`,
 * `local_http:kyc-investigator`, `databricks:kyc-investigator`.
 */
export const runtimeTargetSchema = z.string().regex(/^[a-z][a-z0-9_]{1,39}(:[a-z0-9][a-z0-9._-]{0,99})?$/);

/** Runtime adapters the platform ships; a target outside this set must be registered at startup. */
export const BUILT_IN_RUNTIME_ADAPTERS = ["local_http", "databricks"] as const;

/**
 * A named, administered runtime binding. It says where a runtime is reached and how the
 * dispatcher authenticates, never a credential: secrets are referenced by environment
 * variable name and stay in the dispatcher's environment or workload identity.
 *
 * `platform_token` presents the dispatcher's own service credential -- the development
 * shared token, or its workload-identity token under `WORKLOAD_AUTH=workload_identity`.
 */
export const runtimeBindingSchema = z.object({
  adapter: runtimeAdapterIdSchema,
  endpoint: z.string().url().max(400),
  auth: z.enum(["platform_token", "databricks_oauth_m2m"]),
  workspaceHost: z.string().url().max(400).optional(),
  clientIdEnv: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).optional(),
  clientSecretEnv: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).optional(),
  description: z.string().max(500).optional(),
}).strict().superRefine((binding, context) => {
  if (binding.auth === "databricks_oauth_m2m" && (!binding.workspaceHost || !binding.clientIdEnv || !binding.clientSecretEnv)) {
    context.addIssue({ code: "custom", path: ["auth"], message: "databricks_oauth_m2m requires workspaceHost, clientIdEnv and clientSecretEnv" });
  }
});
export const runtimeBindingsSchema = z.record(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/), runtimeBindingSchema);

export const skillImplementationSchema = z.object({
  language: z.literal("python"), entrypoint: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()), outputSchema: z.record(z.string(), z.unknown()),
  dependencies: z.object({ skills: z.array(z.string()), capabilities: z.array(z.string()), libraries: z.array(z.string()) }).strict(),
  requiredContext: z.array(z.record(z.string(), z.unknown())), optionalContext: z.array(z.record(z.string(), z.unknown())),
  policyContextFields: z.array(z.string()), effects: z.enum(["read_only", "internal_write", "human_gated"]),
  bundleCodeHash: z.string().regex(/^[a-f0-9]{64}$/), instructionHash: z.string().regex(/^[a-f0-9]{64}$/),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/), canonicalManifest: z.string().min(1),
}).strict();
export const canonicalAgentProfileSchema = z.object({
  canonical: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), taskIds: z.array(z.string().min(1)),
}).strict();

export const runStatusSchema = z.enum([
  "queued",
  "running",
  "retrying",
  "completed",
  "manual_review",
  "denied",
  "failed",
  "cancelled",
]);

export const runRequestSchema = z.object({
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  input: z.unknown(),
  sourceContextDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export const runRecordSchema = z.object({
  runId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceContextDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  status: runStatusSchema,
  terminalOutcome: z.string().nullable(),
  input: z.unknown(),
  output: z.unknown().nullable(),
  attempt: z.number().int().nonnegative(),
  fencingEpoch: z.number().int().nonnegative(),
  latestCheckpointId: z.string().nullable(),
  currentNodeId: z.string().nullable(),
  errorCode: z.string().nullable(),
  traceId: z.string().regex(/^[a-f0-9]{32}$/).nullable(),
  rootSpanId: z.string().regex(/^[a-f0-9]{16}$/).nullable(),
  traceFlags: z.number().int().min(0).max(255).nullable(),
  costUsd: z.number().nonnegative(),
  costComplete: z.boolean(),
  modelCalls: z.number().int().nonnegative(),
  capabilityCalls: z.number().int().nonnegative(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  updatedAt: z.string(),
}).strict();

export const runtimeEventSchema = z.object({
  runId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  code: z.string().regex(/^[a-z0-9_.-]+$/),
  nodeId: z.string().nullable(),
  status: z.enum(["observed", "passed", "failed", "denied"]),
  values: z.record(z.string(), z.unknown()),
  occurredAt: z.string(),
}).strict();


/**
 * Provider-observed state of an invocation.
 *
 * Needed because a dispatcher that loses contact with a provider mid-invocation cannot
 * otherwise tell "still running" from "finished, and the result is lost" -- and the
 * difference decides whether a retry is safe.
 */
export const runtimeInvocationStatusSchema = z.object({
  contractVersion: z.literal("runtime.status.v1"),
  invocationId: z.string().min(1),
  state: z.enum(["pending", "running", "completed", "failed", "cancelled", "unknown"]),
  providerMetadata: z.record(z.string(), z.string()).default({}),
}).strict();

export const runtimeSettlementSchema = z.discriminatedUnion('status',[
  z.object({status:z.literal('fulfilled'),value:z.unknown()}).strict(),
  z.object({status:z.literal('rejected'),reason:z.object({code:z.string(),message:z.string()}).strict()}).strict(),
]);
export const legacyRuntimeInvocationResultSchema = z.object({
  contractVersion: z.literal("runtime.result.v1"),
  invocationId: z.string().min(1),
  runId: z.string().min(1),
  status: z.enum(["completed", "denied", "failed"]),
  output: z.unknown().nullable(),
  errorCode: z.string().min(1).nullable(),
  checkpointId: z.string().nullable(),
  providerMetadata: z.record(z.string(), z.string()).default({}),
}).strict();
export const runtimeInvocationResultV2Schema=legacyRuntimeInvocationResultSchema.extend({
  contractVersion:z.literal('runtime.result.v2'),settlements:z.record(z.string(),runtimeSettlementSchema),
}).strict();
export const runtimeInvocationResultSchema=z.discriminatedUnion('contractVersion',[legacyRuntimeInvocationResultSchema,runtimeInvocationResultV2Schema]);

export const sha256DigestSchema = z.string().regex(/^(sha256:)?[a-f0-9]{64}$/);

export const kycCaseStatusSchema = z.enum([
  "INTAKE",
  "VALIDATING",
  "SCREENING",
  "INVESTIGATING",
  "READY_FOR_DECISION",
  "QA_REVIEW",
  "HUMAN_REVIEW",
  "NEEDS_INFORMATION",
  "SUSPENDED",
  "APPROVED",
  "DECLINED",
  "CLOSED",
]);

export const caseActorSchema = z.object({
  type: z.enum(["AGENT", "HUMAN", "SYSTEM", "INTEGRATION"]),
  principalId: z.string().min(1),
  executionId: z.string().min(1).optional(),
  roles: z.array(z.string().min(1)).default([]),
}).strict();

export const caseAuthoritySchema = z.object({
  planDigest: sha256DigestSchema,
  permissionEnvelopeDigest: sha256DigestSchema,
  policySnapshotDigest: sha256DigestSchema,
  /**
   * What a model was shown when it produced this proposal: the `model_context` evidence
   * holding the context pack, and that pack's digest (data-stores-plan.md §3.3). Required by
   * the case service for an agent's command under an envelope with `context_required`.
   */
  businessActionGrant: businessDecisionGrantSchema.optional(),
  contextEvidenceId: z.string().min(1).optional(),
  contextPackDigest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().refine((authority) => (authority.contextEvidenceId === undefined) === (authority.contextPackDigest === undefined), {
  message: "contextEvidenceId and contextPackDigest go together",
});

export const createKycCaseRequestSchema = z.object({
  tenantId: z.string().min(1),
  caseType: z.enum(["kyc_onboarding", "kyb_onboarding"]).default("kyc_onboarding"),
  schemaVersion: z.enum(["kyc.case.v1", "kyb.case.v1"]).default("kyc.case.v1"),
  // Every jurisdiction with a policy pack layer (domains/policy/packs/jurisdictions).
  jurisdiction: z.enum(["US", "GB", "AU"]).default("US"),
  externalRef: z.string().min(1).optional(),
  policySnapshotDigest: sha256DigestSchema,
  harnessPlanDigest: sha256DigestSchema,
  policyAuthority: z.object({
    policyId: z.string().min(1), policyVersion: z.string().min(1),
    policyBundleDigest: sha256DigestSchema, dependencyDigest: sha256DigestSchema,
  }).strict().optional(),
  classification: z.string().min(1).default("CONFIDENTIAL"),
  actor: caseActorSchema,
}).strict().refine(v => v.schemaVersion === (v.caseType === "kyb_onboarding" ? "kyb.case.v1" : "kyc.case.v1"), "case.schema_type_mismatch");

/**
 * Whether a node is an agent reasoning node that is given a context pack: an agent or evaluate
 * node with an agent profile, context selectors or an agent loop. The runtime assembles (and
 * records) a pack for exactly these nodes, and the envelope broker marks their envelopes
 * `context_required`.
 */
export function nodeShowsModelContext(node: { kind: string; contextSelectorIds: string[]; config: Record<string, unknown> }): boolean {
  return (node.kind === "agent" || node.kind === "evaluate")
    && (typeof node.config.agentRef === "string" || node.contextSelectorIds.length > 0 || node.config.loop !== undefined);
}

export const businessCommandSchema = z.object({
  commandId: z.string().min(1),
  commandType: businessCommandTypeSchema,
  commandVersion: z.string().min(1),
  tenantId: z.string().min(1),
  caseId: z.string().min(1),
  actor: caseActorSchema,
  authority: caseAuthoritySchema,
  payload: z.record(z.string(), z.unknown()),
  preconditions: z.object({
    caseSequence: z.number().int().nonnegative(),
    subjectRevision: z.number().int().nonnegative().optional(),
  }).strict(),
  idempotencyKey: z.string().min(1).max(300),
  occurredAt: z.string().datetime().optional(),
}).strict();

export const evidenceSourceSchema = z.object({
  type: z.enum(["TOOL", "UPLOAD", "INTERNAL_SYSTEM", "HUMAN", "DERIVED"]),
  providerBindingDigest: sha256DigestSchema.optional(),
  dataset: z.string().min(1).optional(),
  datasetVersion: z.string().min(1).optional(),
  capability: z.string().min(1).optional(),
  retrievedAt: z.string().datetime(),
  sourceEffectiveAt: z.string().datetime().optional(),
}).strict();

/** Evidence retention classes; each has one rule in the evidence store (data-stores-plan.md §3.6). */
export const EVIDENCE_RETENTION_CLASSES = ["KYC_REGULATED", "DECISION_RECORD", "EXECUTION_SUPPORT", "TRANSIENT_UPLOAD", "QUARANTINE"] as const;
export type EvidenceRetentionClass = typeof EVIDENCE_RETENTION_CLASSES[number];

export const registerEvidenceRequestSchema = z.object({
  tenantId: z.string().min(1),
  caseId: z.string().min(1),
  schemaVersion: z.literal("harness.evidence.v1").default("harness.evidence.v1"),
  type: z.string().min(1),
  mediaType: z.string().min(1),
  contentBase64: z.string().min(1),
  declaredDigest: sha256DigestSchema.optional(),
  source: evidenceSourceSchema,
  subjectRefs: z.array(z.string().min(1)).default([]),
  trust: z.object({
    tier: z.string().min(1),
    instructionTrust: z.enum(["TRUSTED", "UNTRUSTED_DATA", "UNTRUSTED_EXTERNAL"]),
  }).strict(),
  classification: z.string().min(1).default("CONFIDENTIAL"),
  retentionClass: z.enum(EVIDENCE_RETENTION_CLASSES).default("KYC_REGULATED"),
  residency: z.string().min(1).default("US"),
  createdBy: caseActorSchema,
}).strict();

/**
 * A person's case-document upload (case-api `POST /v1/cases/:caseId/documents`). The case API
 * fills in the evidence envelope: type DOCUMENT, UPLOAD source, untrusted external content and
 * the authenticated actor. `documentType` is the uploader's claim (a kyc document-catalog id or
 * alias), never a classification result.
 */
export const documentUploadSchema = z.object({
  filename: z.string().min(1).max(255).regex(/^[^/\\\u0000-\u001f]+$/),
  mediaType: z.string().min(1).max(127).regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
  contentBase64: z.string().min(1),
  declaredDigest: sha256DigestSchema.optional(),
  documentType: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/).optional(),
  subjectRefs: z.array(z.string().min(1)).max(32).default([]),
  residency: z.string().min(1).default("US"),
}).strict();
export type DocumentUpload = z.infer<typeof documentUploadSchema>;

export const commandOutcomeSchema = z.enum(["ACCEPTED", "REJECTED", "CONFLICT", "IN_PROGRESS"]);

export const executionEnvelopeClaimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.string().min(1),
  jti: z.string().min(1),
  tenant_id: z.string().min(1),
  case_id: z.string().min(1).nullable(),
  work_item_id: z.string().min(1).optional(),
  work_fencing_epoch: z.number().int().nonnegative().optional(),
  run_id: z.string().min(1),
  node_id: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  plan_digest: z.string().regex(/^[a-f0-9]{64}$/),
  permission_digest: z.string().regex(/^[a-f0-9]{64}$/),
  capabilities: z.array(z.string()),
  effects: z.array(effectClassSchema),
  /**
   * Canonical command types the plan declares this node may submit. The case service
   * checks a command against this list, so a runtime cannot invent a case write the
   * compiled plan never granted it.
   */
  case_writes: z.array(businessCommandTypeSchema).default([]),
  /**
   * Command types this node may only hold (a skill node: the effects of an approval-required
   * skill) or release after its approval (the release node), through the case API's skill-commit
   * and release endpoints; never through the generic command endpoint. Absent when empty.
   */
  case_writes_held: z.array(businessCommandTypeSchema).optional(),
  /**
   * The node shows a model a context pack (nodeShowsModelContext). Its agent commands must
   * then cite the `model_context` evidence of the pack the model answered from.
   */
  context_required: z.boolean().optional(),
  /**
   * Canonical context selectors the admitted plan grants to this node. A Case API
   * snapshot endpoint uses this plan-bound list rather than trusting caller-supplied paths.
   */
  case_reads: z.array(caseReadGrantSchema).default([]),
  /** Classification handling is bound into the plan with the node's context read grants. */
  case_read_policies: z.array(contextClassificationPolicySchema).default([]),
  fencing_epoch: z.number().int().nonnegative(),
  /**
   * Present only on a delegated envelope (skill.execution.v1 §6.1): the skill execution
   * the authority was delegated to, `skills:<skill_id>@<semver>`. A delegated envelope is
   * the parent node envelope narrowed to the skill's declared dependency capabilities.
   */
  delegated_to: z.string().regex(/^skills:[a-z][a-z_]*(\.[a-z][a-z0-9_]*)+@[0-9A-Za-z.+-]{1,64}$/).optional(),
  /** The `jti` of the node envelope a delegated envelope was derived from. */
  parent_jti: z.string().min(1).optional(),
  iat: z.number().int(),
  exp: z.number().int(),
}).strict().superRefine((claims, ctx) => {
  if ((claims.delegated_to === undefined) !== (claims.parent_jti === undefined)) {
    ctx.addIssue({ code: "custom", path: ["delegated_to"], message: "execution_envelope.delegation_claims_incomplete" });
  }
});

/**
 * Authority the dispatcher hands to a runtime for the length of one invocation.
 *
 * The runtime used to hold the envelope signing secret and mint its own capability
 * envelopes, which meant a compromised runtime -- such as a hosted runtime the platform
 * does not operate -- could grant itself any capability, effect, node or epoch it liked.
 * It now receives this grant instead and exchanges it, per node, at the control plane,
 * which re-checks the lease and fence before signing anything.
 */
export const runtimeGrantClaimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.string().min(1),
  jti: z.string().min(1),
  run_id: z.string().min(1),
  attempt: z.number().int().positive(),
  worker_id: z.string().min(1),
  plan_digest: z.string().regex(/^[a-f0-9]{64}$/),
  fencing_epoch: z.number().int().positive(),
  node_id: z.string().min(1).optional(),
  work_item_id: z.string().min(1).optional(),
  work_fencing_epoch: z.number().int().positive().optional(),
  iat: z.number().int(),
  exp: z.number().int(),
}).strict();

export const envelopeRequestSchema = z.object({
  runId: z.string().min(1),
  nodeId: z.string().min(1),
  attempt: z.number().int().nonnegative(),
  invocationId: z.string().min(1),
}).strict();

// ---------------------------------------------------------------------------
// Business skills (financial-crime canonical skills catalog). Not to be confused with
// agent instructions (`agentProfileSchema.instructions`, registered through
// `skillRegistrationSchema`): a business skill is a versioned business
// contract (`screening.sanctions.execute`) that capabilities implement. See
// docs/implementation/business-skills.md and docs/implementation/agent-profiles.md. The bulk
// of the schemas is at the end of this file; the pieces below are referenced by the request
// and plan contracts.
// ---------------------------------------------------------------------------

/** Catalog skill ID: `<domain>.<subject>[.<qualifier>…]`, never versioned, e.g. `entity.resolve`. */
export const BUSINESS_SKILL_ID_PATTERN = /^[a-z][a-z_]*(\.[a-z][a-z0-9_]*)+$/;
export const businessSkillIdSchema = z.string().max(128).regex(BUSINESS_SKILL_ID_PATTERN, "business_skill.id_invalid");
export const SEMVER_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
export const semverSchema = z.string().max(64).regex(SEMVER_PATTERN, "semver.invalid");

/**
 * Which pinned implementation candidate served one skill-bound invocation, and why. The
 * runtime sends it with the capability request; the gateway checks it against the admitted
 * plan's skill binding and stores it on the receipt.
 */
export const skillSelectionRecordSchema = z.object({
  skillId: businessSkillIdSchema,
  skillVersion: semverSchema,
  selectedCapabilityId: z.string().min(1),
  /** Connector (adapter binding) of the selected candidate, as pinned in the plan. */
  selectedConnectorId: z.string().min(1).optional(),
  candidateIndex: z.number().int().nonnegative(),
  reason: z.string().min(1).max(200),
  /**
   * The subject jurisdiction (ISO alpha-2) the runtime established for this invocation, which
   * the gateway checks against connector coverage when the binding's policy requires it.
   * Absent or null when the run could not establish one.
   */
  jurisdiction: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
}).strict();

export const capabilityRequestSchema = z.object({
  invocationId: z.string().min(1),
  capabilityId: z.string().min(1),
  effect: effectClassSchema,
  input: z.unknown(),
  /** Present when a skill-bound node invoked a pinned implementation candidate. */
  skill: skillSelectionRecordSchema.optional(),
}).strict();

export const capabilityResultSchema = z.object({
  invocationId: z.string(),
  capabilityId: z.string(),
  status: z.enum(["succeeded", "failed", "denied"]),
  output: z.unknown().nullable(),
  errorCode: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  providerRequestId: z.string().nullable(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative().nullable(),
    outputTokens: z.number().int().nonnegative().nullable(),
    costUsd: z.number().nonnegative().nullable(),
  }).strict(),
  latencyMs: z.number().int().nonnegative(),
  receiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
  sourceDecisionId: z.string().min(1).optional(),
  evidenceUseDecisionId: z.string().min(1).optional(),
}).strict();

export const authoringStatusSchema = z.enum([
  "DRAFT",
  "COMPILED",
  "EVALUATED",
  "APPROVED",
  "PUBLISHED",
]);

export const authoringDraftInputSchema = z.object({
  packageSource: z.string().min(1),
  workflowSource: z.string().min(1),
}).strict();

export const capabilityRegistrationSchema = capabilityDefinitionSchema.extend({
  description: z.string().min(1),
  owner: z.string().min(1),
  dataClasses: z.array(z.string().min(1)).default([]),
  status: z.enum(["draft", "active", "deprecated"]).default("active"),
}).superRefine((capability, ctx) => {
  if (capability.status === "active" && capability.adapterBindingId.startsWith("unconfigured:")) {
    ctx.addIssue({
      code: "custom",
      path: ["adapterBindingId"],
      message: "capability.active_binding_unconfigured",
    });
  }
});

/**
 * Canonical capability ID: `<namespace>.<subject>[.<qualifier>…].v<major>`.
 *
 * Lowercase segments joined by dots, at least two before the version, always versioned.
 * A capability ID names *what* is done, never *who* does it: provider, vendor, adapter and
 * environment names belong in the connector (see docs/implementation/capability-naming.md).
 */
export const CANONICAL_CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$/;

export const canonicalCapabilityIdSchema = z.string().regex(CANONICAL_CAPABILITY_ID_PATTERN, "capability.id_not_canonical");

/** Connector ID is the gateway `adapterBindingId`: `<adapter>:<binding>`. */
export const connectorIdSchema = z.string().regex(/^[a-z][a-z0-9_-]*:[A-Za-z0-9][A-Za-z0-9_.:-]*$/, "connector.id_invalid");

export const connectorStatusSchema = z.enum(["available", "live_ready", "quarantined", "retired"]);

/**
 * The v2 canonical capability model (data-adapters docs/CANONICAL_EXTERNAL_CAPABILITY_MODEL.md):
 * the semantic layer behind a platform capability ID. Platform IDs stay `<name>.v<major>`; the
 * model's `<capability_path>.intelligence.<jurisdiction>` keys appear on connectors, where the
 * provider and its jurisdiction scope live. See docs/implementation/capability-naming.md.
 */
export const CANONICAL_MODEL_CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.intelligence\.([a-z]{2}(_[a-z0-9]+)?|global|unresolved)$/;
const canonicalPathSchema = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/);

export const canonicalCapabilityDefinitionSchema = z.object({
  capabilityPath: canonicalPathSchema,
  modelVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
  definitionVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
  status: z.enum(["proposed", "approved", "deprecated"]),
  kind: z.enum(["intelligence", "operational", "reference", "testing"]),
  jurisdictionBasis: z.enum(["registry_authority", "issuer_authority", "dataset_authority", "policy_jurisdiction", "financial_source_authority", "account_servicing", "integration_scope"]),
  requiredScopeFields: z.array(z.string().min(1)).min(1),
  subjectTypes: z.array(z.string().min(1)).min(1),
  defaultAction: z.string().min(1),
  resultFamily: z.string().min(1),
  /** The v1 atlas name this family keeps as its platform ID; null for families added in v2. */
  legacyCapability: z.string().min(1).nullable(),
  /** Platform capability IDs this capability can never stand in for, even as a fallback. */
  notSubstitutableFor: z.array(canonicalCapabilityIdSchema),
}).strict();

export const canonicalConnectorBindingSchema = z.object({
  legacyBindingId: z.string().regex(/^[a-z0-9-]+:[a-z_.]+$/),
  bindingIds: z.array(z.string().min(1)).min(1),
  capabilityIds: z.array(z.string().regex(CANONICAL_MODEL_CAPABILITY_ID_PATTERN)).min(1),
  capabilityPaths: z.array(canonicalPathSchema).min(1),
  jurisdictions: z.array(z.string().min(1)).min(1),
  migration: z.enum(["vocabulary_mapping", "semantic_correction", "conditional_split"]),
  /** Only `alias_pending_approval` may be bound; the others are refused by the gateway. */
  runtimeDisposition: z.enum(["alias_pending_approval", "migration_required", "quarantined"]),
}).strict();

export const connectorRegistrationSchema = z.object({
  connectorId: connectorIdSchema,
  adapterId: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  providerId: z.string().min(1).nullable(),
  providerName: z.string().min(1).nullable(),
  capabilityId: canonicalCapabilityIdSchema,
  operation: z.string().min(1),
  resultFamily: z.string().min(1).nullable(),
  status: connectorStatusSchema,
  demoSupported: z.boolean(),
  liveBlockers: z.array(z.string().min(1)),
  source: z.object({
    catalog: z.string().min(1),
    revision: z.string().min(1),
  }).strict(),
  /** The connector's v2 provider capability bindings; null for platform connectors. */
  canonical: canonicalConnectorBindingSchema.nullable().default(null),
}).strict().superRefine((connector, ctx) => {
  if (!connector.connectorId.startsWith(`${connector.adapterId}:`)) {
    ctx.addIssue({ code: "custom", path: ["connectorId"], message: "connector.adapter_prefix_mismatch" });
  }
  if (connector.canonical && connector.canonical.capabilityIds.length !== connector.canonical.capabilityPaths.length) {
    ctx.addIssue({ code: "custom", path: ["canonical", "capabilityPaths"], message: "connector.canonical_paths_mismatch" });
  }
});

export const connectorCatalogCapabilitySchema = z.object({
  capabilityId: canonicalCapabilityIdSchema,
  atlasCapability: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/).nullable(),
  resultFamily: z.string().min(1).nullable(),
  kind: capabilityKindSchema,
  effect: effectClassSchema,
  description: z.string().min(1),
  dataClasses: z.array(z.string().min(1)).default([]),
  /** The connector a new release binds by default; null while no connector exists. */
  defaultConnectorId: connectorIdSchema.nullable(),
  /** The capability's v2 canonical definition; null for platform-only capabilities. */
  canonical: canonicalCapabilityDefinitionSchema.nullable().default(null),
}).strict();

/**
 * A connector template: for an adapter whose binding names are deployment-specific (a
 * serving endpoint, an index, a deployment), the shape a concrete connector must have.
 * Operators register concrete connectors from it (gateway POST /v1/connectors).
 */
export const connectorTemplateSchema = z.object({
  adapterId: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  cloud: z.enum(["local", "databricks", "vendor", "any"]),
  /** Anchored regular expression (source) the binding name must match. */
  bindingPattern: z.string().min(3).refine((source) => {
    if (!source.startsWith("^") || !source.endsWith("$")) return false;
    try { new RegExp(source); return true; } catch { return false; }
  }, "connector_template.binding_pattern_invalid"),
  capabilityIds: z.array(canonicalCapabilityIdSchema).min(1),
  /** Environment variable names the gateway reads to reach the provider; never values. */
  configEnv: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
  description: z.string().min(1),
}).strict();

/**
 * Request to register one concrete connector from a connector template (gateway
 * POST /v1/connectors). The connector ID is `<adapterId>:<binding>`.
 */
export const connectorTemplateRegistrationSchema = z.object({
  adapterId: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  binding: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/).max(256),
  capabilityId: canonicalCapabilityIdSchema,
  status: z.enum(["available", "live_ready"]).default("available"),
  providerId: z.string().min(1).max(128).optional(),
  providerName: z.string().min(1).max(200).optional(),
  liveBlockers: z.array(z.string().min(1).max(128)).max(20).default([]),
}).strict();

export const connectorCatalogSchema = z.object({
  apiVersion: z.literal("harness.factory/connector-catalog-v1"),
  generatedFrom: z.object({
    catalog: z.string().min(1),
    revision: z.string().min(1),
    canonicalModelVersion: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/).optional(),
  }).strict(),
  capabilities: z.array(connectorCatalogCapabilitySchema),
  connectors: z.array(connectorRegistrationSchema),
  connectorTemplates: z.array(connectorTemplateSchema).default([]),
}).strict().superRefine((catalog, ctx) => {
  const templateAdapters = new Set<string>();
  catalog.connectorTemplates.forEach((template, index) => {
    if (templateAdapters.has(template.adapterId)) {
      ctx.addIssue({ code: "custom", path: ["connectorTemplates", index, "adapterId"], message: "connector_catalog.template_duplicate" });
    }
    templateAdapters.add(template.adapterId);
    template.capabilityIds.forEach((capabilityId, capabilityIndex) => {
      if (!catalog.capabilities.some((capability) => capability.capabilityId === capabilityId)) {
        ctx.addIssue({ code: "custom", path: ["connectorTemplates", index, "capabilityIds", capabilityIndex], message: "connector_catalog.capability_unknown" });
      }
    });
  });
  const capabilities = new Map<string, z.infer<typeof connectorCatalogCapabilitySchema>>();
  catalog.capabilities.forEach((capability, index) => {
    if (capabilities.has(capability.capabilityId)) {
      ctx.addIssue({ code: "custom", path: ["capabilities", index, "capabilityId"], message: "connector_catalog.capability_duplicate" });
    }
    capabilities.set(capability.capabilityId, capability);
  });
  const connectors = new Map<string, z.infer<typeof connectorRegistrationSchema>>();
  catalog.connectors.forEach((connector, index) => {
    if (connectors.has(connector.connectorId)) {
      ctx.addIssue({ code: "custom", path: ["connectors", index, "connectorId"], message: "connector_catalog.connector_duplicate" });
    }
    connectors.set(connector.connectorId, connector);
    if (!capabilities.has(connector.capabilityId)) {
      ctx.addIssue({ code: "custom", path: ["connectors", index, "capabilityId"], message: "connector_catalog.capability_unknown" });
    }
  });
  catalog.capabilities.forEach((capability, index) => {
    if (!capability.defaultConnectorId) return;
    const connector = connectors.get(capability.defaultConnectorId);
    // Model-profile connectors are shared by every model task, so a model capability may
    // default to any connector registered under a model capability.
    const served = connector && (connector.capabilityId === capability.capabilityId
      || capability.kind === "model" && capabilities.get(connector.capabilityId)?.kind === "model");
    if (!connector || !served) {
      ctx.addIssue({ code: "custom", path: ["capabilities", index, "defaultConnectorId"], message: "connector_catalog.default_connector_invalid" });
    } else if (connector.status === "quarantined" || connector.status === "retired"
      || (connector.canonical && connector.canonical.runtimeDisposition !== "alias_pending_approval")) {
      ctx.addIssue({ code: "custom", path: ["capabilities", index, "defaultConnectorId"], message: "connector_catalog.default_connector_unusable" });
    }
  });
  catalog.capabilities.forEach((capability, index) => {
    capability.canonical?.notSubstitutableFor.forEach((capabilityId, refIndex) => {
      if (!capabilities.has(capabilityId) || capabilityId === capability.capabilityId) {
        ctx.addIssue({ code: "custom", path: ["capabilities", index, "canonical", "notSubstitutableFor", refIndex], message: "connector_catalog.substitution_reference_invalid" });
      }
    });
  });
  // A wiring connector serves the capability whose v2 family it maps to, unless the mapping is a
  // correction (then it keeps its legacy capability and must not be bound).
  catalog.connectors.forEach((connector, index) => {
    if (!connector.canonical || connector.canonical.runtimeDisposition !== "alias_pending_approval") return;
    const path = capabilities.get(connector.capabilityId)?.canonical?.capabilityPath;
    if (path && !connector.canonical.capabilityPaths.every((candidate) => candidate === path)) {
      ctx.addIssue({ code: "custom", path: ["connectors", index, "canonical", "capabilityPaths"], message: "connector_catalog.canonical_family_mismatch" });
    }
  });
});

export const authoringSourceSchema = z.object({
  type: z.enum(["manual", "github"]),
  url: z.string().url().optional(),
  path: z.string().min(1).optional(),
  revision: z.string().min(1).optional(),
}).strict();

export const skillRegistrationSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().min(1),
  description: z.string().min(1),
  instructions: z.string().min(1),
  allowedCapabilityIds: z.array(z.string().min(1)).default([]),
  source: authoringSourceSchema.default({ type: "manual" }),
  version: z.string().min(1).default("0.1.0"),
  status: z.enum(["draft", "active", "deprecated"]).default("active"),
  implementation: skillImplementationSchema.optional(),
}).strict();

export const agentRegistrationSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  name: z.string().min(1),
  description: z.string().min(1),
  role: z.string().min(1),
  prompt: z.string().min(1),
  modelProfileId: z.string().min(1).default("model.standard.v1"),
  runtimeTarget: runtimeTargetSchema.default("local_http"),
  skillIds: z.array(z.string().min(1)).default([]),
  /** Default, explicit reads copied into the process and pinned to its signed plan. */
  caseReads: z.array(caseReadGrantSchema).max(64).optional(),
  caseWrites: z.array(caseWriteContractSchema).default([]),
  primaryCapabilityId: z.string().min(1).optional(),
  inputSchema: z.record(z.string(), z.unknown()).default({ type: "object" }),
  outputSchema: z.record(z.string(), z.unknown()).default({ type: "object" }),
  source: authoringSourceSchema.default({ type: "manual" }),
  version: z.string().min(1).default("0.1.0"),
  status: z.enum(["draft", "active", "deprecated"]).default("active"),
  canonicalProfile: canonicalAgentProfileSchema.optional(),
}).strict();

export const evaluationReportSchema = z.object({
  passed: z.boolean(),
  evaluatedAt: z.string(),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  checks: z.array(z.object({
    id: z.string(),
    label: z.string(),
    passed: z.boolean(),
    detail: z.string(),
  }).strict()),
}).strict();

/**
 * Administered platform configuration.
 *
 * Three kinds of value live here, and the difference between them is the whole design.
 *
 * A *model profile document* is what `harnessc` digests into a plan's `modelProfiles`
 * entry, so its shape is fixed at exactly the fields below. Editing one is therefore not
 * an update: it mints a new immutable revision with a new digest, and plans compiled
 * against the old revision keep resolving to the old revision.
 *
 * A *provider record* is operational binding -- where a provider is reached and which
 * credential answers for it. It is deliberately outside the digested document so an
 * endpoint can be repointed, or a provider swapped, without invalidating the digest that
 * every already-compiled plan carries.
 *
 * A *platform setting* is an operational knob that no plan is compiled against at all.
 */
export const modelProfileDocumentSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  /** Provider record id, resolved at invocation time against the provider registry. */
  provider: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  model: z.string().min(1),
  maxOutputTokens: z.number().int().positive().max(200_000),
  timeoutMs: z.number().int().positive().max(600_000),
  maxConcurrency: z.number().int().positive().max(64),
}).strict();

/**
 * How a provider binding is reached: OpenRouter, any OpenAI-compatible endpoint, Anthropic's
 * Messages API (the official SDK; `baseUrl` null means the public API), or the recorded adapter.
 */
export const providerKindSchema = z.enum(["openrouter", "openai_compatible", "anthropic", "recorded"]);

/**
 * A provider binding. `credentialRef` names the environment variable that holds the
 * credential; the credential value itself never enters the control plane, the admin API,
 * or this record. An operator changes which credential is used by naming a different
 * variable, not by pasting a key into a form.
 */
export const providerRecordSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  kind: providerKindSchema,
  displayName: z.string().min(1).max(120),
  baseUrl: z.string().url().max(400).nullable(),
  credentialRef: z.string().regex(/^[A-Z][A-Z0-9_]{2,64}$/).nullable(),
  siteUrl: z.string().url().max(400).nullable(),
  appName: z.string().min(1).max(120).nullable(),
  status: z.enum(["active", "disabled"]),
}).strict();

// ---------------------------------------------------------------------------
// Connector coverage
// ---------------------------------------------------------------------------

/**
 * Operator-supplied connector coverage (spec §9 resolution constraints).
 *
 * A business skill's resolution policy can require that the implementation it selects is
 * entitled for the tenant (`require_entitlement`), covers the subject's jurisdiction
 * (`require_jurisdiction_coverage`) and screens against current lists
 * (`require_list_freshness`). Provider metadata cannot answer those questions: catalogue
 * coverage is often empty, and a licence is a contract, not an API field. The deployment's
 * operator states them per tenant in the administered gateway setting `connectorCoverage`
 * (environment fallback `CONNECTOR_COVERAGE_JSON`), keyed by connector (adapter binding) ID.
 *
 * Nothing is assumed: a connector with no entry fails every requirement the policy sets, an
 * unknown jurisdiction fails jurisdiction coverage, and a connector that declares no list
 * provenance fails freshness.
 */

const jurisdictionCodeSchema = z.string().regex(/^[A-Z]{2}$/, "coverage.jurisdiction_invalid");

/** One list the connector screens against, as last ingested, with the age the operator tolerates. */
export const connectorListSnapshotSchema = z.object({
  id: z.string().min(1).max(128),
  asOf: z.string().datetime({ offset: true }),
  maxAgeHours: z.number().positive().max(8_760),
}).strict();

export const connectorListProvenanceSchema = z.discriminatedUnion("mode", [
  /**
   * The provider serves its current lists on every call (a hosted screening API). Freshness
   * is the provider's contractual obligation; `attestedBy` names who confirmed it.
   */
  z.object({ mode: z.literal("provider_hosted"), attestedBy: z.string().min(1).max(200) }).strict(),
  /** The connector screens against ingested snapshots whose age the platform can check. */
  z.object({ mode: z.literal("snapshot"), items: z.array(connectorListSnapshotSchema).min(1).max(64) }).strict(),
]);

export const connectorCoverageEntrySchema = z.object({
  /** The tenant holds a licence or agreement for this connector. */
  entitled: z.boolean(),
  /** ISO 3166-1 alpha-2 codes the connector covers; `*` is an explicit claim of any jurisdiction. */
  jurisdictions: z.array(z.union([z.literal("*"), jurisdictionCodeSchema])).max(300),
  lists: connectorListProvenanceSchema.nullable().default(null),
  notes: z.string().max(500).optional(),
}).strict();

/**
 * Keys are connector IDs (`opensanctions:sanctions`), or a prefix ending in `*`
 * (`wiring:opensanctions:*`) that applies to every connector it matches. An exact key wins
 * over a prefix, and a longer prefix over a shorter one.
 */
const coverageKeySchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:\/-]*\*?$/, "coverage.connector_key_invalid");
export const connectorCoverageSchema = z.record(coverageKeySchema, connectorCoverageEntrySchema);

export type ConnectorCoverageEntry = z.infer<typeof connectorCoverageEntrySchema>;
export type ConnectorCoverage = z.infer<typeof connectorCoverageSchema>;

export const COVERAGE_DENIAL_REASONS = [
  "coverage_unregistered",
  "entitlement_missing",
  "jurisdiction_unknown",
  "jurisdiction_not_covered",
  "list_freshness_unknown",
  "list_stale",
] as const;
export type CoverageDenialReason = typeof COVERAGE_DENIAL_REASONS[number];

export type CoverageRequirements = {
  require_entitlement: boolean;
  require_list_freshness: boolean;
  require_jurisdiction_coverage: boolean;
};

export type CoverageVerdict =
  | { eligible: true; entryKey: string | null }
  | { eligible: false; reason: CoverageDenialReason; entryKey: string | null; detail: string | null };

/** The entry that governs a connector: the exact key, else the longest matching `*` prefix. */
export function coverageEntryFor(coverage: ConnectorCoverage, connectorId: string): { key: string; entry: ConnectorCoverageEntry } | null {
  const exact = coverage[connectorId];
  if (exact) return { key: connectorId, entry: exact };
  let best: { key: string; entry: ConnectorCoverageEntry } | null = null;
  for (const [key, entry] of Object.entries(coverage)) {
    if (!key.endsWith("*")) continue;
    const prefix = key.slice(0, -1);
    if (connectorId.startsWith(prefix) && (!best || prefix.length > best.key.length - 1)) best = { key, entry };
  }
  return best;
}

/** Upper-case ISO alpha-2, or null when the value is not a jurisdiction code. */
export function normalizeJurisdiction(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/**
 * Whether a pinned candidate's connector may serve this invocation under the skill's policy.
 * Checks run in a fixed order (registration, entitlement, jurisdiction, freshness) so the
 * reported reason is stable. A policy that requires nothing is always eligible.
 */
export function evaluateConnectorCoverage(input: {
  coverage: ConnectorCoverage;
  connectorId: string;
  policy: CoverageRequirements;
  jurisdiction: string | null | undefined;
  now: Date;
}): CoverageVerdict {
  const { policy } = input;
  if (!policy.require_entitlement && !policy.require_jurisdiction_coverage && !policy.require_list_freshness) {
    return { eligible: true, entryKey: null };
  }
  const found = coverageEntryFor(input.coverage, input.connectorId);
  const deny = (reason: CoverageDenialReason, detail: string | null = null): CoverageVerdict =>
    ({ eligible: false, reason, entryKey: found?.key ?? null, detail });
  if (!found) return deny("coverage_unregistered");
  const { entry } = found;
  if (policy.require_entitlement && !entry.entitled) return deny("entitlement_missing");
  if (policy.require_jurisdiction_coverage) {
    const jurisdiction = normalizeJurisdiction(input.jurisdiction);
    if (!jurisdiction) return deny("jurisdiction_unknown");
    if (!entry.jurisdictions.includes("*") && !entry.jurisdictions.includes(jurisdiction)) return deny("jurisdiction_not_covered", jurisdiction);
  }
  if (policy.require_list_freshness) {
    if (!entry.lists) return deny("list_freshness_unknown");
    if (entry.lists.mode === "snapshot") {
      for (const list of entry.lists.items) {
        const ageMs = input.now.getTime() - Date.parse(list.asOf);
        if (!(ageMs <= list.maxAgeHours * 3_600_000)) return deny("list_stale", list.id);
      }
    }
  }
  return { eligible: true, entryKey: found.key };
}

/**
 * The §4.3 code a coverage refusal maps to. Entitlement is an access question; an unknown
 * jurisdiction is missing context; stale lists are stale context; a connector the operator
 * never registered, or one that does not cover the jurisdiction, leaves the policy unresolved.
 */
export function coverageDenialSkillCode(reason: CoverageDenialReason): "ACCESS_DENIED" | "CONTEXT_MISSING" | "CONTEXT_STALE" | "POLICY_UNRESOLVED" {
  switch (reason) {
    case "entitlement_missing": return "ACCESS_DENIED";
    case "jurisdiction_unknown": return "CONTEXT_MISSING";
    case "list_freshness_unknown":
    case "list_stale": return "CONTEXT_STALE";
    default: return "POLICY_UNRESOLVED";
  }
}

/** Gateway error code for a coverage refusal; the runtime treats it as "skip this candidate". */
export const SKILL_COVERAGE_DENIED_PREFIX = "gateway.skill_coverage_denied:";

export function coverageReasonFromError(message: string): CoverageDenialReason | null {
  const at = message.indexOf(SKILL_COVERAGE_DENIED_PREFIX);
  if (at < 0) return null;
  const reason = message.slice(at + SKILL_COVERAGE_DENIED_PREFIX.length).match(/^[a-z_]+/)?.[0];
  return (COVERAGE_DENIAL_REASONS as readonly string[]).includes(reason ?? "") ? reason as CoverageDenialReason : null;
}

export const platformSettingsSchema = z.object({
  dispatcher: z.object({
    pollIntervalMs: z.number().int().min(100).max(60_000),
    leaseSeconds: z.number().int().min(5).max(3_600),
    concurrency: z.number().int().min(1).max(64),
    retryBaseMs: z.number().int().min(100).max(600_000),
    retryMaxMs: z.number().int().min(1_000).max(3_600_000),
  }).strict(),
  gateway: z.object({
    /** `platform_default` follows the security profile: allow in development, deny in production. */
    recordedFallback: z.enum(["allow", "deny", "platform_default"]),
    /**
     * Per-tenant connector entitlement, jurisdiction coverage and list provenance that skill
     * resolution policies are checked against (`connector-coverage.ts`). Empty means nothing
     * is attested, so every policy requirement fails closed.
     */
    connectorCoverage: connectorCoverageSchema.default({}),
  }).strict(),
  envelope: z.object({
    ttlSeconds: z.number().int().min(30).max(3_600),
  }).strict(),
  authoring: z.object({
    defaultBudgets: z.object({
      maxDurationMs: z.number().int().positive().max(86_400_000),
      maxCostUsd: z.number().nonnegative().max(1_000),
      maxModelCalls: z.number().int().nonnegative().max(1_000),
      maxCapabilityCalls: z.number().int().nonnegative().max(1_000),
    }).strict(),
  }).strict(),
  /**
   * The agent runtime a run is dispatched to.
   *
   * A plan node may declare its own `runtimeTarget`, and that still wins: the plan is the
   * authority over where its nodes run, and an administered default must not silently
   * move a node the author placed deliberately. This section decides the default and
   * carries the binding details for whichever provider is selected.
   */
  runtime: z.object({
    provider: runtimeTargetSchema,
    /** Named runtime bindings a plan node can target as `<adapter>:<name>`. */
    bindings: runtimeBindingsSchema.default({}),
    localEndpoint: z.string().url().max(400),
    checkpointBackend: z.enum(["postgres", "memory"]),
  }).strict(),
  observability: z.object({
    otlpTracesEndpoint: z.string().url().max(400).nullable(),
    samplerRatio: z.number().min(0).max(1),
    deploymentEnvironment: z.string().min(1).max(60),
    cloudRegion: z.string().min(1).max(60),
    traceViewerBaseUrl: z.string().url().max(400).nullable(),
    traceViewerPublicUrl: z.string().url().max(400).nullable(),
  }).strict(),
  caseStore: z.object({
    artifactBackend: z.enum(["postgres"]),
  }).strict(),
  database: z.object({
    poolMax: z.number().int().min(1).max(100),
    connectTimeoutMs: z.number().int().min(250).max(120_000),
    idleTimeoutMs: z.number().int().min(1_000).max(600_000),
  }).strict(),
  outbox: z.object({
    intervalMs: z.number().int().min(500).max(600_000),
    retentionDays: z.number().int().min(1).max(365),
  }).strict(),
  evidence: z.object({
    maxBytes: z.number().int().min(1_024).max(104_857_600),
    requireScan: z.boolean(),
  }).strict(),
}).strict();

export const platformSettingSectionSchema = z.enum([
  "dispatcher", "gateway", "envelope", "authoring",
  "runtime", "observability", "caseStore", "database",
  "outbox", "evidence",
]);

/**
 * The built-in values, which are the values these knobs had while they were literals in
 * the services. They remain the floor of the resolution order, so an empty admin store
 * reproduces today's behaviour exactly.
 */
export const PLATFORM_SETTING_DEFAULTS: PlatformSettings = {
  dispatcher: { pollIntervalMs: 750, leaseSeconds: 60, concurrency: 1, retryBaseMs: 2_000, retryMaxMs: 60_000 },
  gateway: { recordedFallback: "platform_default", connectorCoverage: {} },
  envelope: { ttlSeconds: 60 },
  authoring: { defaultBudgets: { maxDurationMs: 120_000, maxCostUsd: 0.25, maxModelCalls: 2, maxCapabilityCalls: 4 } },
  runtime: {
    provider: "local_http",
    localEndpoint: "http://runtime-host-local:8088/invocations",
    checkpointBackend: "postgres",
    bindings: {},
  },
  observability: {
    otlpTracesEndpoint: null,
    samplerRatio: 1,
    deploymentEnvironment: "local",
    cloudRegion: "local",
    traceViewerBaseUrl: null,
    traceViewerPublicUrl: null,
  },
  caseStore: { artifactBackend: "postgres" },
  database: { poolMax: 12, connectTimeoutMs: 5_000, idleTimeoutMs: 30_000 },
  outbox: { intervalMs: 5_000, retentionDays: 7 },
  evidence: { maxBytes: 1_048_576, requireScan: false },
};

/**
 * One editable field of an administered section.
 *
 * `appliesAt` is per field rather than per section because the two are genuinely mixed:
 * the trace viewer URL is re-read by the control plane on every request, while the OTLP
 * exporter beside it is constructed before the process can reach a database at all.
 * Labelling the whole section either way would be a lie about one of them, and a control
 * panel that says a saved value is in force when it is not is worse than one that says
 * nothing.
 *
 * `envName` is the variable the field falls back to when nothing is stored. A field with
 * no `envName` has never had an environment override and exists only here.
 */
export type PlatformSettingField = {
  /** Dot path within the section value, e.g. `defaultBudgets.maxCostUsd`. */
  path: string;
  label: string;
  kind: "string" | "number" | "boolean" | "enum" | "url" | "json";
  options?: readonly string[];
  envName?: string;
  appliesAt: "live" | "restart";
  service: string;
  help: string;
  /** Whether the field accepts an explicit empty value. */
  nullable?: boolean;
};

export const PLATFORM_SETTING_FIELDS: Record<PlatformSettingSection, readonly PlatformSettingField[]> = {
  dispatcher: [
    { path: "pollIntervalMs", label: "Poll interval (ms)", kind: "number", envName: "WORKER_POLL_MS", appliesAt: "restart", service: "runtime-dispatcher", help: "How often an idle worker slot looks for a claimable run." },
    { path: "leaseSeconds", label: "Lease duration (s)", kind: "number", envName: "WORKER_LEASE_SECONDS", appliesAt: "restart", service: "runtime-dispatcher", help: "How long a claimed run stays owned before another worker may take it. Shorter recovers faster from a lost worker; too short lets two workers believe they own the same run between renewals." },
    { path: "concurrency", label: "Worker concurrency", kind: "number", envName: "WORKER_CONCURRENCY", appliesAt: "restart", service: "runtime-dispatcher", help: "Runs this dispatcher process executes at once." },
    { path: "retryBaseMs", label: "Retry base (ms)", kind: "number", envName: "WORKER_RETRY_BASE_MS", appliesAt: "restart", service: "runtime-dispatcher", help: "First backoff step. Each further attempt doubles it." },
    { path: "retryMaxMs", label: "Retry ceiling (ms)", kind: "number", envName: "WORKER_RETRY_MAX_MS", appliesAt: "restart", service: "runtime-dispatcher", help: "Upper bound on the doubling backoff." },
  ],
  gateway: [
    { path: "recordedFallback", label: "Recorded adapter fallback", kind: "enum", options: ["platform_default", "allow", "deny"], envName: "MODEL_RECORDED_FALLBACK", appliesAt: "live", service: "capability-gateway", help: "Whether an absent provider credential may be answered by the deterministic recorded adapter. `deny` fails closed, so a deployment cannot report model calls it never made. `platform_default` allows it under SECURITY_PROFILE=development and denies it under production." },
    { path: "connectorCoverage", label: "Connector coverage", kind: "json", envName: "CONNECTOR_COVERAGE_JSON", appliesAt: "live", service: "capability-gateway", help: "What this tenant is entitled to and what each connector covers, as JSON `{\"<connector id or prefix*>\": {entitled, jurisdictions: [\"US\", ...] | [\"*\"], lists: {mode: \"provider_hosted\", attestedBy} | {mode: \"snapshot\", items: [{id, asOf, maxAgeHours}]} | null}}`. Skill bindings whose policy requires entitlement, jurisdiction coverage or list freshness select only connectors this attests; an absent entry fails closed." },
  ],
  envelope: [
    { path: "ttlSeconds", label: "Envelope TTL (s)", kind: "number", envName: "EXECUTION_ENVELOPE_TTL_SECONDS", appliesAt: "live", service: "control-api", help: "Lifetime of a minted execution envelope. It bounds how long a stolen envelope stays useful, so it should be the shortest value a node's slowest capability can live with." },
  ],
  authoring: [
    { path: "defaultBudgets.maxDurationMs", label: "Default max duration (ms)", kind: "number", appliesAt: "live", service: "control-api", help: "Stamped into a newly created draft. An author may still change it before compiling." },
    { path: "defaultBudgets.maxCostUsd", label: "Default max cost (USD)", kind: "number", appliesAt: "live", service: "control-api", help: "Stamped into a newly created draft." },
    { path: "defaultBudgets.maxModelCalls", label: "Default max model calls", kind: "number", appliesAt: "live", service: "control-api", help: "Stamped into a newly created draft." },
    { path: "defaultBudgets.maxCapabilityCalls", label: "Default max capability calls", kind: "number", appliesAt: "live", service: "control-api", help: "Stamped into a newly created draft." },
  ],
  runtime: [
    { path: "provider", label: "Default agent runtime", kind: "string", envName: "RUNTIME_PROVIDER", appliesAt: "live", service: "runtime-dispatcher", help: "Where a node is dispatched when its plan does not name a target: an adapter (`local_http`, `databricks`) or `<adapter>:<binding>`. A plan node's own `runtimeTarget` overrides this, because the plan is the authority over where its nodes run." },
    { path: "bindings", label: "Runtime bindings", kind: "json", envName: "RUNTIME_BINDINGS_JSON", appliesAt: "live", service: "runtime-dispatcher", help: "Named runtime bindings, as JSON `{\"<name>\": {adapter, endpoint, auth, ...}}`. A node targets one as `<adapter>:<name>`. Bindings name the environment variables that hold credentials; they never contain one." },
    { path: "localEndpoint", label: "Local runtime endpoint", kind: "url", envName: "RUNTIME_LOCAL_ENDPOINT", appliesAt: "live", service: "runtime-dispatcher", help: "Invocation endpoint of the self-hosted runtime host. Used when the resolved provider is local_http." },
    { path: "checkpointBackend", label: "Checkpoint backend", kind: "enum", options: ["postgres", "memory"], envName: "RUNTIME_CHECKPOINT_BACKEND", appliesAt: "restart", service: "runtime-host", help: "postgres keeps runs resumable. memory removes the runtime's last database credential at the cost of resumability." },
  ],
  observability: [
    { path: "otlpTracesEndpoint", label: "OTLP traces endpoint", kind: "url", nullable: true, envName: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", appliesAt: "restart", service: "all services", help: "Where spans are exported. Every service builds its exporter before it can reach a database, so this is read at start." },
    { path: "samplerRatio", label: "Trace sampler ratio", kind: "number", envName: "OTEL_TRACES_SAMPLER_ARG", appliesAt: "restart", service: "all services", help: "Fraction of root traces sampled, 0 to 1. Durable run events and gateway receipts stay authoritative when sampling drops a trace." },
    { path: "deploymentEnvironment", label: "Deployment environment", kind: "string", envName: "DEPLOYMENT_ENVIRONMENT", appliesAt: "restart", service: "all services", help: "Resource attribute stamped on every span." },
    { path: "cloudRegion", label: "Cloud region", kind: "string", envName: "CLOUD_REGION", appliesAt: "restart", service: "all services", help: "Resource attribute stamped on every span." },
    { path: "traceViewerBaseUrl", label: "Trace viewer base URL", kind: "url", nullable: true, envName: "TRACE_VIEWER_BASE_URL", appliesAt: "live", service: "control-api", help: "Base of the deep link the control plane returns with a run's trace. Re-read per request, so repointing it at a different viewer takes effect immediately." },
    { path: "traceViewerPublicUrl", label: "Trace viewer public URL", kind: "url", nullable: true, envName: "TRACE_VIEWER_PUBLIC_URL", appliesAt: "restart", service: "experience-bff", help: "Base the web UI links a browser to, which may differ from the control plane's internal view of the same viewer." },
  ],
  caseStore: [
    { path: "artifactBackend", label: "Evidence artifact backend", kind: "enum", options: ["postgres"], envName: "CASE_ARTIFACT_BACKEND", appliesAt: "restart", service: "case-api", help: "The replaceable storage boundary behind digest-addressed evidence bytes. Only `postgres` is implemented; a Blob adapter would appear here without changing any case or command contract." },
  ],
  database: [
    { path: "poolMax", label: "Max pool connections", kind: "number", envName: "DB_POOL_MAX", appliesAt: "restart", service: "all services", help: "Per-process connection ceiling. Every service builds its pool at start." },
    { path: "connectTimeoutMs", label: "Connect timeout (ms)", kind: "number", envName: "DB_CONNECT_TIMEOUT_MS", appliesAt: "restart", service: "all services", help: "How long a new connection may take before it fails." },
    { path: "idleTimeoutMs", label: "Idle timeout (ms)", kind: "number", envName: "DB_IDLE_TIMEOUT_MS", appliesAt: "restart", service: "all services", help: "How long an unused pooled connection is kept." },
  ],
  outbox: [
    { path: "intervalMs", label: "Drain interval (ms)", kind: "number", envName: "OUTBOX_INTERVAL_MS", appliesAt: "restart", service: "case-api", help: "How often case and evidence events are drained to the sink." },
    { path: "retentionDays", label: "Delivered retention (days)", kind: "number", envName: "OUTBOX_RETENTION_DAYS", appliesAt: "restart", service: "case-api", help: "How long delivered rows are kept before being aged out." },
  ],
  evidence: [
    { path: "maxBytes", label: "Max evidence bytes", kind: "number", envName: "CASE_EVIDENCE_MAX_BYTES", appliesAt: "restart", service: "case-api", help: "Ceiling on a single stored evidence artifact." },
    { path: "requireScan", label: "Require malware scan", kind: "boolean", envName: "CASE_EVIDENCE_REQUIRE_SCAN", appliesAt: "restart", service: "case-api", help: "Whether evidence must carry a clean scan result before it is accepted." },
  ],
};

export const PLATFORM_SETTING_SCOPES: Record<PlatformSettingSection, {
  service: string;
  appliesAt: "live" | "restart" | "mixed";
  summary: string;
}> = {
  dispatcher: { service: "runtime-dispatcher", appliesAt: "restart", summary: "Lease duration, poll cadence, worker concurrency, and bounded retry backoff." },
  gateway: { service: "capability-gateway", appliesAt: "live", summary: "Whether an absent provider credential may be answered by the recorded adapter, and which connectors the tenant is entitled to and what they cover." },
  envelope: { service: "control-api", appliesAt: "live", summary: "Lifetime of a minted execution envelope." },
  authoring: { service: "control-api", appliesAt: "live", summary: "Budgets stamped into a newly created authoring draft." },
  runtime: { service: "runtime-dispatcher · runtime-host", appliesAt: "mixed", summary: "Which agent runtime a run is dispatched to, its endpoint and hosted-agent binding, and how the runtime checkpoints." },
  observability: { service: "all services", appliesAt: "mixed", summary: "Trace export, sampling, resource attributes, and where a trace deep link points." },
  caseStore: { service: "case-api", appliesAt: "restart", summary: "The storage boundary behind digest-addressed evidence artifacts." },
  database: { service: "all services", appliesAt: "restart", summary: "Connection pool sizing and timeouts." },
  outbox: { service: "case-api", appliesAt: "restart", summary: "Outbox drain cadence and delivered-row retention." },
  evidence: { service: "case-api", appliesAt: "restart", summary: "Evidence size ceiling and whether a malware scan is required." },
};

/** Read a dot path out of a section value. */
export function settingValueAt(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (current, key) => (current && typeof current === "object" ? (current as Record<string, unknown>)[key] : undefined),
    value,
  );
}

/** Set a dot path inside a section value, returning a new value. */
export function withSettingValueAt(value: unknown, path: string, next: unknown): unknown {
  const [head, ...rest] = path.split(".");
  if (head === undefined) return next;
  const base = value && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};
  base[head] = rest.length === 0 ? next : withSettingValueAt(base[head], rest.join("."), next);
  return base;
}

export const adminChangeActionSchema = z.enum(["create", "update", "activate", "disable"]);

export const adminChangeRecordSchema = z.object({
  changeId: z.string().min(1),
  occurredAt: z.string().min(1),
  actorId: z.string().min(1),
  actorRoles: z.array(z.string()),
  resourceKind: z.enum(["provider", "model-profile", "platform-setting"]),
  resourceId: z.string().min(1),
  action: adminChangeActionSchema,
  beforeDigest: z.string().nullable(),
  afterDigest: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
  reason: z.string().max(500).nullable(),
}).strict();

/**
 * Production policy artifacts are compiled, immutable OPA bundles. The source policy
 * remains reviewable YAML, but runtimes authorize only this digest-bound representation,
 * and only while the artifact registry holds an approved, unrevoked entry for its digest.
 */
export const policyDecisionSchema = z.enum(["ALLOW", "BLOCK", "REVIEW", "UNKNOWN", "ERROR"]);

/**
 * Artifacts whose authority is established by the artifact registry. Trust is not
 * carried inside the artifact (there are no detached signatures or verification keys):
 * an artifact is executable only when its recomputed digest matches the registry
 * entry, that entry was approved by someone other than its registrant, and it has not
 * been revoked. Revocation is per artifact, recorded in the same registry.
 */
export const artifactKindSchema = z.enum([
  "policy-bundle",
  "release-manifest",
  /** A skill-host bundle lock (skill.execution.v1 §8); the digest is the lock's `bundle_digest`. */
  "skill-bundle",
  "skill-qualification",
  "source-policy", "source-binding", "source-access", "source-context",
  /** A Document Factory release (packages/contracts/src/document-factory.ts); the digest is the manifest's stable digest. */
  "document-model-release",
]);

export const artifactRegistryStatusSchema = z.enum(["registered", "approved", "revoked"]);

export const artifactRegistryEntrySchema = z.object({
  tenantId: z.string().min(1),
  kind: artifactKindSchema,
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  reference: z.string().min(1).max(300),
  status: artifactRegistryStatusSchema,
  registeredBy: z.string().min(1),
  approvedBy: z.string().min(1).nullable(),
  revokedBy: z.string().min(1).nullable(),
  reasonCode: z.string().min(1).nullable(),
  registeredAt: z.string().datetime(),
  approvedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
}).strict();

export const policyBundleSchema = z.object({
  apiVersion: z.literal("harness.factory/policy-bundle-v1"),
  kind: z.literal("PolicyBundle"),
  bundleId: z.string().min(1),
  policyId: z.string().min(1),
  policyVersion: z.string().min(1),
  sourceDigest: sha256DigestSchema,
  bundleDigest: sha256DigestSchema,
  opaVersion: z.string().min(1),
  decisionContract: z.literal("business-v2").optional(),
  regoModules: z.array(z.object({
    path: z.string().min(1),
    digest: sha256DigestSchema,
  }).strict()).min(1),
  dataDigest: sha256DigestSchema,
  gates: z.array(z.object({
    gateId: z.string().min(1),
    entrypoint: z.string().regex(/^data(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/),
    inputProfile: z.string().min(1).optional(),
    allowedOutcomes: z.array(z.union([policyDecisionSchema, z.enum(["DECIDED", "NEEDS_EVIDENCE", "NEEDS_HUMAN", "NOT_APPLICABLE", "UNRESOLVED"])])).min(1),
  }).strict()).min(1),
  ruleIds: z.array(z.string().min(1)),
  testsDigest: sha256DigestSchema,
  authority: z.object({
    source: z.string().min(1),
    casePath: z.string().min(1),
    requireSnapshotDigest: z.boolean(),
  }).strict(),
}).strict().superRefine((bundle, ctx) => {
  const states = new Set(["DECIDED", "NEEDS_EVIDENCE", "NEEDS_HUMAN", "NOT_APPLICABLE", "UNRESOLVED"]);
  for (const gate of bundle.gates) {
    if (bundle.decisionContract === "business-v2"
      ? !gate.inputProfile || gate.allowedOutcomes.some(state => !states.has(state))
      : gate.inputProfile !== undefined || gate.allowedOutcomes.some(state => states.has(state)))
      ctx.addIssue({ code: "custom", message: "policy.decision_contract_mismatch" });
  }
});

export const policyCompilationSchema = z.object({
  manifest:policyBundleSchema,files:z.record(z.string(),z.string()),productionEligible:z.boolean(),
  releaseBlockers:z.array(z.object({id:z.string(),status:z.string(),reasonCode:z.string(),path:z.string().optional(),title:z.string().optional(),owner:z.string().optional()}).strict()),
  source:z.record(z.string(),z.json()).optional(),policySets:z.array(effectivePolicySetSchema).optional(),
}).strict();

export const caseSnapshotSchema = z.object({
  readReceiptId:z.string().min(1).optional(),
  apiVersion: z.literal("harness.factory/case-snapshot-v1"),
  kind: z.literal("CaseSnapshot"),
  snapshotId: z.string().min(1),
  snapshotDigest: sha256DigestSchema,
  tenantId: z.string().min(1),
  caseId: z.string().min(1),
  caseSequence: z.number().int().nonnegative(),
  dependencyDigest: sha256DigestSchema,
  planDigest: sha256DigestSchema,
  policyAuthority: z.object({
    policyId: z.string().min(1),
    policyVersion: z.string().min(1),
    policySnapshotDigest: sha256DigestSchema,
    policyBundleDigest: sha256DigestSchema,
  }).strict(),
  consistency: z.literal("strong"),
  classification: z.string().min(1),
  data: z.record(z.string(), z.unknown()),
  capturedAt: z.string().datetime(),
}).strict();

export const contextTrustSchema = z.enum([
  "TRUSTED_INSTRUCTION",
  "TRUSTED_DATA",
  "UNTRUSTED_DATA",
  "UNTRUSTED_EXTERNAL",
]);

export const contextManifestSchema = z.object({
  apiVersion: z.literal("harness.factory/context-manifest-v1"),
  kind: z.literal("ContextManifest"),
  manifestId: z.string().min(1),
  manifestDigest: sha256DigestSchema,
  tenantId: z.string().min(1),
  caseId: z.string().min(1),
  workItemId: z.string().min(1),
  caseSnapshotId: z.string().min(1),
  caseSnapshotDigest: sha256DigestSchema,
  caseSequence: z.number().int().nonnegative(),
  purpose: z.string().min(1),
  authorizationDecisionId: z.string().min(1),
  authorizationDecisionDigest: sha256DigestSchema,
  items: z.array(z.object({
    itemId: z.string().min(1),
    selector: z.string().min(1),
    schemaRef: z.string().min(1),
    classification: z.string().min(1),
    trust: contextTrustSchema,
    purpose: z.string().min(1),
    provenanceRef: z.string().min(1),
    contentRef: z.string().min(1),
    contentDigest: sha256DigestSchema,
    expiresAt: z.string().datetime().nullable(),
  }).strict()),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
}).strict();

export const policyEvaluationSchema = z.object({
  apiVersion: z.literal("harness.factory/policy-evaluation-v1"),
  kind: z.literal("PolicyEvaluation"),
  evaluationId: z.string().min(1),
  tenantId: z.string().min(1),
  caseId: z.string().min(1),
  caseSequence: z.number().int().nonnegative(),
  caseSnapshotDigest: sha256DigestSchema,
  dependencyDigest: sha256DigestSchema,
  policyBundleDigest: sha256DigestSchema,
  gateId: z.string().min(1),
  inputDigest: sha256DigestSchema,
  outcome: policyDecisionSchema,
  ruleResults: z.array(z.object({
    ruleId: z.string().min(1),
    outcome: policyDecisionSchema,
    reasonCode: z.string().min(1),
    evidenceRefs: z.array(z.string().min(1)),
  }).strict()),
  reasonCodes: z.array(z.string().min(1)).min(1),
  obligations: z.array(z.object({
    code: z.string().min(1),
    parameters: z.record(z.string(), z.unknown()),
  }).strict()),
  evidenceRefs: z.array(z.string().min(1)),
  evaluatedAt: z.string().datetime(),
  receiptDigest: sha256DigestSchema,
}).strict();

export const executionWorkItemStatusSchema = z.enum([
  "PROPOSED",
  "BLOCKED",
  "READY",
  "LEASED",
  "RUNNING",
  "PARTIAL",
  "RETRY_SCHEDULED",
  "REWORK_REQUIRED",
  "HUMAN_REQUIRED",
  "WAITING_HUMAN",
  "SUSPENDED",
  "COMPLETED",
  "CANCELLED",
  "EXPIRED",
  "FAILED",
]);

export const executionWorkItemSchema = z.object({
  apiVersion: z.literal("harness.factory/execution-work-item-v1"),
  kind: z.literal("ExecutionWorkItem"),
  tenantId: z.string().min(1),
  caseId: z.string().min(1),
  workItemId: z.string().min(1),
  workType: z.string().min(1),
  capabilityId: z.string().min(1).nullable(),
  assuranceClass: z.string().min(1),
  revision: z.number().int().nonnegative(),
  caseSequenceBasis: z.number().int().nonnegative(),
  planDigest: sha256DigestSchema,
  policyContextRef: z.string().min(1),
  schemaVersion: z.string().min(1),
  objective: z.string().min(1),
  subjectRefs: z.array(z.string().min(1)),
  requiredOutputs: z.array(z.string().min(1)),
  constraints: z.record(z.string(), z.unknown()),
  dependencyIds: z.array(z.string().min(1)),
  dependencyDigest: sha256DigestSchema,
  invalidationPolicy: z.enum(["BLOCK", "CANCEL", "REWORK", "REEVALUATE"]),
  status: executionWorkItemStatusSchema,
  reasonCode: z.string().min(1).nullable(),
  priority: z.number().int(),
  readyAt: z.string().datetime().nullable(),
  deadlineAt: z.string().datetime().nullable(),
  terminalAt: z.string().datetime().nullable(),
  dispatch: z.object({
    generation: z.number().int().nonnegative(),
    queue: z.string().min(1),
    publishedAt: z.string().datetime().nullable(),
    brokerMessageId: z.string().min(1).nullable(),
  }).strict(),
  lease: z.object({
    executionId: z.string().min(1),
    owner: z.string().min(1),
    leaseUntil: z.string().datetime(),
    fencingEpoch: z.number().int().positive(),
    attemptNumber: z.number().int().positive(),
  }).strict().nullable(),
  limits: z.object({
    maxAttempts: z.number().int().positive(),
    maxReworkCycles: z.number().int().nonnegative(),
    maxDurationMs: z.number().int().positive(),
    maxCostUsd: z.number().nonnegative(),
    maxModelCalls: z.number().int().nonnegative(),
    maxCapabilityCalls: z.number().int().nonnegative(),
  }).strict(),
  result: z.object({
    agentResultRef: z.string().min(1).nullable(),
    acceptedCommandRefs: z.array(z.string().min(1)),
    outputRefs: z.array(z.string().min(1)),
    failureCode: z.string().min(1).nullable(),
    failureDetailRef: z.string().min(1).nullable(),
  }).strict().nullable(),
  createdBy: caseActorSchema,
  transitionSequence: z.number().int().nonnegative(),
  traceId: z.string().regex(/^[a-f0-9]{32}$/).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const humanWorkDecisionSchema = z.object({
  decisionId: z.string().min(1),
  tenantId: z.string().min(1),
  caseId: z.string().min(1),
  workItemId: z.string().min(1),
  principalId: z.string().min(1),
  decision: z.enum(["APPROVE", "REJECT", "RETURN"]),
  reasonCode: z.string().min(1),
  rationale: z.string().min(1).max(10_000),
  evidenceRefs: z.array(z.string().min(1)).max(500),
  decidedAt: z.string().datetime(),
}).strict();

export const releaseStatusSchema = z.enum(["candidate", "approved", "active", "deprecated", "revoked"]);

export const releaseManifestSchema = z.object({
  apiVersion: z.literal("harness.factory/release-manifest-v1"),
  kind: z.literal("ReleaseManifest"),
  releaseId: z.string().min(1),
  manifestDigest: sha256DigestSchema,
  planDigest: sha256DigestSchema,
  packageDigest: sha256DigestSchema,
  policyBundleDigests: z.array(sha256DigestSchema),
  schemaSetDigest: sha256DigestSchema,
  agentDigests: z.array(sha256DigestSchema),
  skillDigests: z.array(sha256DigestSchema),
  capabilityDigests: z.array(sha256DigestSchema),
  modelProfileDigests: z.array(sha256DigestSchema),
  executionProfileDigest: sha256DigestSchema,
  compilerDigest: sha256DigestSchema,
  runtimeDigest: sha256DigestSchema,
  dependencyManifestDigest: sha256DigestSchema,
  evaluationAttestationDigest: sha256DigestSchema,
  provenanceDigest: sha256DigestSchema,
  scope: z.object({
    environment: z.string().min(1),
    tenants: z.array(z.string().min(1)),
    regions: z.array(z.string().min(1)).min(1),
    cohort: z.string().min(1),
  }).strict(),
  createdAt: z.string().datetime(),
}).strict();

export const releaseRecordSchema = z.object({
  releaseId: z.string().min(1),
  manifestDigest: sha256DigestSchema,
  status: releaseStatusSchema,
  revision: z.number().int().nonnegative(),
  activatedAt: z.string().datetime().nullable(),
  deprecatedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
  reasonCode: z.string().min(1).nullable(),
  updatedAt: z.string().datetime(),
}).strict();

export const contextSelectorSchema = caseReadGrantSchema;

export const policyBindingSchema = z.object({
  policyId: z.string().min(1),
  policyVersion: z.string().min(1),
  source: z.string().min(1),
  digest: sha256DigestSchema,
}).strict();

export const integrationIntentSchema = z.enum(["create_case", "submit_case_command", "start_run"]);
const integrationHumanRoleSchema = z.enum([
  "Harness.Reader", "Harness.Author", "Harness.Approver", "Harness.Operator",
  "Case.Analyst", "Case.Reviewer", "Platform.Auditor", "Platform.Admin",
]);

const integrationMappingSchema = z.record(z.string(), z.unknown()).refine(
  (mapping) => JSON.stringify(mapping).length <= 100_000,
  "integration.mapping_too_large",
);

const integrationJsonSchema = z.record(z.string(), z.unknown()).superRefine((schema, context) => {
  if (schema.type !== "object") context.addIssue({ code: "custom", path: ["type"], message: "integration.schema_object_required" });
  if (JSON.stringify(schema).length > 100_000) context.addIssue({ code: "custom", message: "integration.schema_too_large" });
  if (schema.properties && (typeof schema.properties !== "object" || Array.isArray(schema.properties)
    || Object.keys(schema.properties).length > 100)) {
    context.addIssue({ code: "custom", path: ["properties"], message: "integration.schema_properties_invalid" });
  }
});

export const integrationTriggerSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{1,127}$/),
  name: z.string().min(1).max(160),
  source: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("external_http") }).strict(),
    z.object({
      kind: z.literal("internal_event"),
      eventTypes: z.array(z.string().min(1).max(200)).min(1).max(100),
    }).strict(),
  ]),
  inputSchema: integrationJsonSchema,
  target: z.object({
    intent: integrationIntentSchema,
    commandType: businessCommandTypeSchema.optional(),
  }).strict().superRefine((target, context) => {
    if (target.intent === "submit_case_command" && !target.commandType) {
      context.addIssue({ code: "custom", path: ["commandType"], message: "integration.command_type_required" });
    }
    if (target.intent !== "submit_case_command" && target.commandType) {
      context.addIssue({ code: "custom", path: ["commandType"], message: "integration.command_type_forbidden" });
    }
    if (target.commandType === "RecordPolicyEvaluation") {
      context.addIssue({ code: "custom", path: ["commandType"], message: "integration.system_command_forbidden" });
    }
  }),
  mapping: integrationMappingSchema,
  idempotencyPath: z.string().min(1).max(500),
  maxHops: z.number().int().min(1).max(16).default(8),
}).strict();

export const humanActionUiSchema = z.record(z.string(), z.object({
  label: z.string().min(1).max(160).optional(),
  help: z.string().min(1).max(1_000).optional(),
  control: z.enum(["text", "textarea", "number", "checkbox", "select", "evidence"]).optional(),
  order: z.number().int().min(0).max(1_000).optional(),
}).strict());

export const integrationHumanActionSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{1,127}$/),
  label: z.string().min(1).max(160),
  description: z.string().max(1_000).default(""),
  commandType: businessCommandTypeSchema,
  inputSchema: integrationJsonSchema,
  ui: humanActionUiSchema.default({}),
  payload: integrationMappingSchema,
  allowedCaseStatuses: z.array(kycCaseStatusSchema).min(1),
  allowedRoles: z.array(integrationHumanRoleSchema).min(1),
  confirmation: z.enum(["none", "confirm", "typed_reason"]).default("confirm"),
  effect: effectClassSchema,
}).strict().superRefine((action, context) => {
  if (action.commandType === "RecordPolicyEvaluation") {
    context.addIssue({ code: "custom", path: ["commandType"], message: "integration.system_command_forbidden" });
  }
});

export const integrationPublicationSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{1,127}$/),
  eventTypes: z.array(z.string().min(1).max(200)).min(1).max(200),
  maximumClassification: z.string().min(1).max(100),
}).strict();

export const integrationContractsSchema = z.object({
  triggers: z.array(integrationTriggerSchema).max(100).default([]),
  humanActions: z.array(integrationHumanActionSchema).max(100).default([]),
  publications: z.array(integrationPublicationSchema).max(100).default([]),
}).strict().superRefine((contracts, context) => {
  const commandEvents: Partial<Record<z.infer<typeof businessCommandTypeSchema>, string>> = {
    AddSubject: "subject.created", LinkEvidence: "evidence.linked", ProposeClaim: "claim.proposed",
    AcceptClaimAsFact: "claim.accepted_as_fact", RecordScreeningFinding: "finding.created",
    RecordAssumption: "assumption.recorded", RaiseContradiction: "contradiction.raised",
    ResolveContradiction: "contradiction.resolved", ProposeWorkItem: "work_item.created",
    CompleteWorkItem: "work_item.completed", LinkExecution: "execution.linked",
    SubmitDecisionRecommendation: "decision.recommendation_submitted", RecordGateResult: "decision.gate_recorded",
    RecordQAResult: "qa.result_recorded", RecordReview: "review.recorded",
    RequestHumanReview: "human_review.requested", TransitionCaseStatus: "case.status_transitioned",
    FinalizeDisposition: "case.dispositioned",
  };
  for (const [kind, items] of Object.entries(contracts)) {
    const ids = new Set<string>();
    items.forEach((item, index) => {
      if (ids.has(item.id)) context.addIssue({ code: "custom", path: [kind, index, "id"], message: "integration.contract_id_duplicate" });
      ids.add(item.id);
    });
  }
  for (const [index, trigger] of contracts.triggers.entries()) {
    if (trigger.source.kind !== "internal_event") continue;
    const commandEvent = trigger.target.intent === "submit_case_command" && trigger.target.commandType
      ? commandEvents[trigger.target.commandType] : undefined;
    const directCycle = trigger.target.intent === "create_case"
      ? trigger.source.eventTypes.includes("case.created")
      : trigger.target.intent === "start_run"
        ? trigger.source.eventTypes.some((eventType) => ["run.admitted", "run.started"].includes(eventType))
        : commandEvent ? trigger.source.eventTypes.includes(commandEvent) : false;
    if (directCycle) {
      context.addIssue({ code: "custom", path: ["triggers", index], message: "integration.trigger_direct_cycle" });
    }
  }
});

export const integrationConnectorSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{1,127}$/),
  name: z.string().min(1).max(160),
  channel: z.enum(["inbound_http", "outbound_webhook"]),
  endpoint: z.string().url().nullable(),
  /**
   * `hmac` signs (outbound) or verifies (inbound) each request with a shared secret.
   * `oauth2_client_credentials` obtains a bearer token for an outbound destination from any
   * OAuth 2.0 token endpoint; `credentialRef` then names the client secret and `audience`
   * is requested as the token's scope.
   */
  authentication: z.object({
    kind: z.enum(["hmac", "oauth2_client_credentials"]),
    credentialRef: z.string().min(1).max(500),
    audience: z.string().min(1).max(500).nullable().default(null),
    tokenUrl: z.string().url().max(500).nullable().default(null),
    clientId: z.string().min(1).max(200).nullable().default(null),
  }).strict(),
  allowedClassifications: z.array(z.string().min(1)).min(1),
  enabled: z.boolean().default(true),
}).strict().superRefine((connector, context) => {
  if (connector.channel === "inbound_http" && connector.endpoint !== null) {
    context.addIssue({ code: "custom", path: ["endpoint"], message: "integration.inbound_endpoint_managed" });
  }
  if (connector.channel !== "inbound_http" && connector.endpoint === null) {
    context.addIssue({ code: "custom", path: ["endpoint"], message: "integration.outbound_endpoint_required" });
  }
  if (connector.channel === "outbound_webhook" && connector.endpoint && new URL(connector.endpoint).protocol !== "https:") {
    context.addIssue({ code: "custom", path: ["endpoint"], message: "integration.https_required" });
  }
  // Inbound requests are verified by the platform itself, so they must be signed.
  if (connector.channel === "inbound_http" && connector.authentication.kind !== "hmac") {
    context.addIssue({ code: "custom", path: ["authentication", "kind"], message: "integration.inbound_hmac_required" });
  }
  if (connector.authentication.kind === "oauth2_client_credentials") {
    const { tokenUrl, clientId, audience } = connector.authentication;
    if (!tokenUrl || new URL(tokenUrl).protocol !== "https:") {
      context.addIssue({ code: "custom", path: ["authentication", "tokenUrl"], message: "integration.token_url_https_required" });
    }
    if (!clientId) context.addIssue({ code: "custom", path: ["authentication", "clientId"], message: "integration.client_id_required" });
    if (!audience) context.addIssue({ code: "custom", path: ["authentication", "audience"], message: "integration.connector_audience_missing" });
  }
});

export const integrationBindingStatusSchema = z.enum(["DRAFT", "VERIFIED", "ACTIVE", "PAUSED", "REVOKED"]);

export const integrationBindingSchema = z.object({
  id: z.string().regex(/^[A-Za-z][A-Za-z0-9._-]{1,127}$/),
  routeId: z.string().regex(/^[A-Za-z0-9_-]{12,160}$/),
  deploymentId: z.string().min(1).max(200),
  planDigest: sha256DigestSchema,
  contractId: z.string().min(1).max(128),
  connectorId: z.string().min(1).max(128),
  filters: z.record(z.string(), z.unknown()).default({}),
  status: integrationBindingStatusSchema.default("DRAFT"),
}).strict();

export const integrationCloudEventSchema = z.object({
  specversion: z.literal("1.0"),
  id: z.string().min(1),
  source: z.string().min(1),
  type: z.string().min(1),
  subject: z.string().min(1),
  time: z.string().datetime(),
  datacontenttype: z.literal("application/json"),
  data: z.object({
    tenantId: z.string().min(1),
    deploymentId: z.string().nullable(),
    planDigest: sha256DigestSchema.nullable(),
    caseId: z.string().nullable(),
    caseSequence: z.number().int().nonnegative().nullable(),
    eventId: z.string().min(1),
    classification: z.string().min(1),
    correlationId: z.string().nullable(),
    causationId: z.string().nullable(),
    hop: z.number().int().min(0).max(16),
    traceparent: z.string().nullable(),
  }).strict(),
}).strict();

export const integrationEnvelopeClaimsSchema = z.object({
  tenant_id: z.string().min(1),
  deployment_id: z.string().min(1),
  binding_id: z.string().min(1),
  binding_revision: z.number().int().positive(),
  plan_digest: sha256DigestSchema,
  case_id: z.string().min(1).nullable(),
  intent: integrationIntentSchema,
  command_type: businessCommandTypeSchema.nullable(),
  nonce: z.string().min(1),
  iss: z.string(), aud: z.union([z.string(), z.array(z.string())]), jti: z.string(),
  iat: z.number(), exp: z.number(),
}).passthrough();

/**
 * Resolution constraints for a business skill's implementation candidates (spec §9).
 * Fallback happens only between candidates in the same equivalent-coverage group and only
 * when `allow_fallback` is true: sanctions coverage or authorization is never downgraded.
 */
export const skillResolutionPolicySchema = z.object({
  require_entitlement: z.boolean(),
  require_list_freshness: z.boolean(),
  require_jurisdiction_coverage: z.boolean(),
  allow_fallback: z.boolean(),
  log_selected_implementation: z.boolean(),
}).strict();

export const coverageGroupSchema = z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,127}$/);

/**
 * A skill's write authority pinned into a plan from its registry entry (skill.execution.v1
 * §6.2–6.3, CR-5): the effect mode, whether its effects wait for human approval, and the case
 * commands its manifest authorizes (`case_command:<Type>`). The compiler cannot read the
 * registry, so it checks node grants against this pin; the generators derive it from
 * `config/business-skills.json`. A binding without it is read-only.
 */
export const planSkillEffectsSchema = z.object({
  mode: z.enum(["read_only", "proposal", "internal_write", "external_write"]),
  approval: z.enum(["required", "none"]),
  caseCommands: z.array(businessCommandTypeSchema).max(32),
}).strict();

/** One pinned candidate as it appears in a compiled plan. */
export const planSkillCandidateSchema = z.object({
  capabilityId: z.string().min(1),
  connectorId: z.string().min(1),
  equivalentCoverageGroup: coverageGroupSchema.nullable(),
}).strict();

/**
 * A business skill pinned into a v2 plan: the manifest digest, the ordered candidate set
 * and its resolution policy. The runtime selects one candidate per invocation.
 */
export const planSkillBindingSchema = z.object({
  skillId: businessSkillIdSchema,
  semver: semverSchema,
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  candidates: z.array(planSkillCandidateSchema).min(1).max(16),
  policy: skillResolutionPolicySchema,
  /**
   * For a skill served by a skill host (`skills:<skill_id>` candidates): the bundle lock's
   * `bundle_digest` the plan was compiled against (skill.execution.v1 §8). Absent otherwise,
   * so plans without hosted skills keep their bytes and digests.
   */
  bundleDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  /** The skill's declared dependency capabilities; harnessc adds them to the node's envelope. */
  dependencyCapabilities: z.array(z.string().min(1)).max(64).optional(),
  /** The skill's pinned write authority; absent means read-only. Emitted only when present. */
  effects: planSkillEffectsSchema.optional(),
}).strict();

/** The authored form in a domain package: candidates may be bare capability IDs. */
export const packageSkillBindingSchema = z.object({
  skillId: businessSkillIdSchema,
  semver: semverSchema,
  manifestDigest: sha256DigestSchema,
  candidates: z.array(z.union([
    z.string().min(1),
    z.object({
      capabilityId: z.string().min(1),
      connectorId: z.string().min(1).optional(),
      equivalentCoverageGroup: coverageGroupSchema.optional(),
    }).strict(),
  ])).min(1).max(16),
  policy: skillResolutionPolicySchema,
  bundleDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
  dependencyCapabilities: z.array(z.string().min(1)).max(64).optional(),
  effects: planSkillEffectsSchema.optional(),
}).strict();

// ---------------------------------------------------------------------------
// Agent profiles (v2): one contract for an agent's identity, prompt, instructions, allowed
// capabilities, allowed business skills, context purposes and loop limits. It replaces the
// v1 pair of agent registrations (`agents`) and agent playbooks (`skills`). See
// docs/implementation/agent-profiles.md.
// ---------------------------------------------------------------------------

const agentProfileIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);

/** Bounds shared by `config.loop` and agent profile limits. */
export const AGENT_LOOP_BOUNDS = {
  maxSteps: { min: 1, max: 20 },
  maxObservationChars: { min: 256, max: 200_000 },
} as const;

/** Admission error for a v2 plan that predates agent profiles (it still has `skills`/`agents`). */
export const PLAN_V2_AGENT_PROFILES_REQUIRED = "plan.v2_agent_profiles_required";

/** Limits a profile gets when it omits `limits` (or one of its fields). */
export const AGENT_PROFILE_DEFAULT_LIMITS = { maxSteps: 8, maxObservationChars: 64_000 } as const;

const maxStepsSchema = z.number().int().min(AGENT_LOOP_BOUNDS.maxSteps.min).max(AGENT_LOOP_BOUNDS.maxSteps.max);
const maxObservationCharsSchema = z.number().int()
  .min(AGENT_LOOP_BOUNDS.maxObservationChars.min).max(AGENT_LOOP_BOUNDS.maxObservationChars.max);

/** One instruction an agent follows (a former agent playbook), as compiled into a plan. */
export const agentInstructionSchema = z.object({
  id: agentProfileIdSchema,
  version: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  text: z.string().min(1),
  allowedCapabilityIds: z.array(z.string().min(1)),
}).strict();

/** A business skill an agent profile may run, pinned to the package binding's semver. */
export const agentProfileSkillSchema = z.object({
  skillId: businessSkillIdSchema,
  semver: semverSchema,
}).strict();

export const agentProfileLimitsSchema = z.object({
  maxSteps: maxStepsSchema,
  maxObservationChars: maxObservationCharsSchema,
}).strict();

/**
 * An agent profile as compiled into a v2 plan. Every field is emitted by harnessc, so the
 * schema has no defaults: parsing never changes the digested bytes.
 *
 * `allowedCapabilities` is computed by harnessc (the sorted union of the instructions'
 * `allowedCapabilityIds` and `primaryCapabilityId`); a node bound to this profile may call
 * only these. `allowedSkills` is sorted by skill id; `purposes` is sorted and unique.
 */
export const agentProfileSchema = z.object({
  id: agentProfileIdSchema,
  version: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  role: z.string().min(1),
  prompt: z.string().min(1),
  instructions: z.array(agentInstructionSchema),
  allowedCapabilities: z.array(z.string().min(1)),
  allowedSkills: z.array(agentProfileSkillSchema),
  modelProfileId: z.string().min(1),
  runtimeTarget: runtimeTargetSchema,
  caseWrites: z.array(caseWriteContractSchema),
  primaryCapabilityId: z.string().min(1).optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  purposes: z.array(z.string().min(1)),
  limits: agentProfileLimitsSchema,
}).strict();

/** The authored form of an instruction in a v2 package. */
export const packageAgentInstructionSchema = agentInstructionSchema.extend({
  allowedCapabilityIds: z.array(z.string().min(1)).default([]),
}).strict();

/**
 * The authored form of an agent profile in a v2 `package.yaml`. `allowedCapabilities` is
 * computed by harnessc and refused here (strict); `limits` may be omitted.
 */
export const packageAgentProfileSchema = agentProfileSchema.omit({ allowedCapabilities: true }).extend({
  instructions: z.array(packageAgentInstructionSchema).default([]),
  allowedSkills: z.array(agentProfileSkillSchema).default([]),
  caseWrites: z.array(caseWriteContractSchema).default([]),
  purposes: z.array(z.string().min(1)).default([]),
  limits: z.object({
    maxSteps: maxStepsSchema.default(AGENT_PROFILE_DEFAULT_LIMITS.maxSteps),
    maxObservationChars: maxObservationCharsSchema.default(AGENT_PROFILE_DEFAULT_LIMITS.maxObservationChars),
  }).strict().optional(),
}).strict();

export const domainPackageV2Schema = z.object({
  apiVersion: z.literal("harness.factory/domain-package-v2"),
  kind: z.literal("DomainPackage"),
  metadata: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    domain: z.string().min(1),
    objective: z.string().min(1),
    owners: z.array(z.string().min(1)).min(1),
    riskClass: z.string().min(1),
  }).strict(),
  workflow: z.string().min(1),
  coordinationMode: z.enum(["caseStore", "dataFlow"]),
  budgets: z.object({
    maxDurationMs: z.number().int().positive(),
    maxCostUsd: z.number().nonnegative(),
    maxModelCalls: z.number().int().nonnegative(),
    maxCapabilityCalls: z.number().int().nonnegative(),
  }).strict(),
  modelProfiles: z.array(z.string().min(1)),
  agentProfiles: z.array(packageAgentProfileSchema).default([]),
  capabilities: z.array(capabilityDefinitionSchema),
  bindings: z.record(z.string(), z.string().min(1)),
  policies: z.array(policyBindingSchema),
  contextSelectors: z.array(contextSelectorSchema),
  contextClassificationPolicies: z.array(contextClassificationPolicySchema).default([]),
  allowedRegions: z.array(z.string().min(1)).min(1),
  dataClasses: z.array(z.string().min(1)),
  evaluationRequirements: z.array(z.string().min(1)),
  integrations: integrationContractsSchema.optional(),
  /** Business skills pinned for skill-bound nodes (`config.skillId`). */
  skillBindings: z.array(packageSkillBindingSchema).optional(),
}).strict();

/**
 * A bounded agent loop on an `agent`/`evaluate` node. The node's bound model capability
 * plans each step; `tools` are the only capabilities it may call, the compiler adds them
 * to the node's permission envelope, and every call still goes through the gateway with
 * its own execution envelope, receipt and budget reservation.
 */
/**
 * A business skill an agent loop may choose to run (`config.loop.skills[]`). The model names the
 * skill and its parameters only; the runtime builds the rest of the input (the records this
 * entry's selectors read, the pinned policy section, the context envelope), exactly as for a
 * skill node, and the gateway checks the call against this node's pinned binding for the skill.
 * Loop skills are read-only (harnessc): their results come back to the model as observations
 * and commit nothing.
 */
export const agentLoopSkillSchema = z.object({
  skillId: z.string().min(1).max(128),
  /** The record selectors this skill reads: a subset of the node's `contextSelectorIds`. */
  contextSelectorIds: z.array(z.string().min(1)).max(32).default([]),
  /** Authored parameter defaults; the model's parameters are merged over them, then validated. */
  parameters: z.record(z.string(), z.unknown()).default({}),
  /** The pinned policy projection for this skill (the shape of a skill node's `config.skillPolicy`). */
  skillPolicy: z.record(z.string(), z.unknown()).optional(),
  /** One projection per pinned policy pack; the case's pin chooses (context-plane policy-choice). */
  skillPolicies: z.array(z.record(z.string(), z.unknown())).max(32).optional(),
  purpose: z.enum(["onboarding", "review", "monitoring", "investigation", "fraud", "reporting"]).default("onboarding"),
}).strict();
export type AgentLoopSkill = z.infer<typeof agentLoopSkillSchema>;

export const agentLoopConfigSchema = z.object({
  /** On a node with an agent profile, never above the profile's `limits.maxSteps` (harnessc fills it when omitted). */
  maxSteps: maxStepsSchema,
  /** Capabilities (connectors, never models or skills) the loop may call. */
  tools: z.array(z.string().min(1)).max(32).default([]),
  /** Business skills the loop may choose to run (agentLoopSkillSchema). */
  skills: z.array(agentLoopSkillSchema).max(16).default([]),
  /** Largest serialized tool observation shown back to the model; larger results are summarized by digest. */
  maxObservationChars: maxObservationCharsSchema.default(12_000),
  /** Re-ask the model once when its final output fails the agent's output schema. */
  repairAttempts: z.number().int().min(0).max(2).default(1),
}).strict().superRefine((loop, context) => {
  if (loop.tools.length + loop.skills.length === 0) context.addIssue({ code: "custom", message: "agent_loop.nothing_to_call" });
  if (new Set(loop.skills.map((skill) => skill.skillId)).size !== loop.skills.length) context.addIssue({ code: "custom", message: "agent_loop.skill_duplicate" });
});

/** One step of the loop protocol, as the model must return it. */
export const agentLoopActionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("call_tool"),
    tool: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
    rationale: z.string().max(2_000).optional(),
  }).strict(),
  z.object({
    action: z.literal("call_skill"),
    skill: z.string().min(1),
    parameters: z.record(z.string(), z.unknown()).default({}),
    rationale: z.string().max(2_000).optional(),
  }).strict(),
  z.object({
    action: z.literal("final"),
    output: z.record(z.string(), z.unknown()),
    rationale: z.string().max(4_000).optional(),
  }).strict(),
]);

/**
 * Task completion, checked by the runtime and never by the model (`config.completion` on an agent
 * node). Each criterion names a predecessor skill node that runs as the same agent: the node's
 * outcome must be one of `acceptedStatuses` and its payload must carry `requiredPayloadFields`.
 * When a criterion fails, the failure policy maps what went wrong to the task's outcome, as the
 * library's TaskSpec does (`failure_policy`).
 */
export const TASK_OUTCOMES = ["COMPLETED", "NEEDS_REVIEW", "NEEDS_EVIDENCE", "BLOCKED"] as const;
export const taskOutcomeSchema = z.enum(TASK_OUTCOMES);
export const SKILL_NODE_STATUSES = ["COMPLETED", "PARTIAL", "NEEDS_REVIEW", "NEEDS_EVIDENCE", "BLOCKED", "FAILED"] as const;
export const agentTaskCompletionSchema = z.object({
  criteria: z.array(z.object({
    nodeId: z.string().min(1),
    acceptedStatuses: z.array(z.enum(SKILL_NODE_STATUSES)).min(1).default(["COMPLETED"]),
    requiredPayloadFields: z.array(z.string().min(1)).max(32).default([]),
  }).strict()).min(1).max(32),
  failurePolicy: z.object({
    ambiguous_evidence: taskOutcomeSchema.default("NEEDS_REVIEW"),
    missing_required_evidence: taskOutcomeSchema.default("NEEDS_EVIDENCE"),
    unavailable_required_source: taskOutcomeSchema.default("BLOCKED"),
  }).strict().default({ ambiguous_evidence: "NEEDS_REVIEW", missing_required_evidence: "NEEDS_EVIDENCE", unavailable_required_source: "BLOCKED" }),
}).strict();
export type AgentTaskCompletion = z.infer<typeof agentTaskCompletionSchema>;

export type TaskCompletionResult = {
  status: (typeof TASK_OUTCOMES)[number];
  criteria: Array<{ nodeId: string; observed: (typeof SKILL_NODE_STATUSES)[number] | "MISSING"; passed: boolean; missingFields: string[] }>;
  reasons: string[];
};

/**
 * A skill node's outcome as committed in the run's values: the skill host's business status, a
 * platform NEEDS_EVIDENCE answer (the skill was not called), or MISSING when the node produced
 * nothing (it failed, or a branch skipped it).
 */
export function skillNodeOutcome(value: unknown): { status: (typeof SKILL_NODE_STATUSES)[number] | "MISSING"; payload: Record<string, unknown> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "MISSING", payload: {} };
  const record = value as Record<string, unknown>;
  if (record.__workflowRejected) return { status: "MISSING", payload: {} };
  const computation = record.computation as Record<string, unknown> | null | undefined;
  const business = computation?.business_status;
  if (typeof business === "string" && (SKILL_NODE_STATUSES as readonly string[]).includes(business)) {
    const raw = computation?.payload;
    const payload = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    // The skill host lifts a skill's `proposed_records` out of its payload into the computation
    // (skill.execution.v1), where the commit path reads them; a task spec names it as a payload field.
    const lifted = Array.isArray(computation?.proposed_records) && !("proposed_records" in payload) ? { proposed_records: computation!.proposed_records } : {};
    return { status: business as (typeof SKILL_NODE_STATUSES)[number], payload: { ...payload, ...lifted } };
  }
  if (record.status === "NEEDS_EVIDENCE") return { status: "NEEDS_EVIDENCE", payload: {} };
  return { status: "MISSING", payload: {} };
}

/**
 * Evaluate a task's completion over the committed values of its skill nodes. The outcome is the
 * most severe of the failed criteria's mapped outcomes (BLOCKED > NEEDS_EVIDENCE > NEEDS_REVIEW),
 * or COMPLETED when every criterion passes. An agent that asks for human review raises a completed
 * task to NEEDS_REVIEW; nothing an agent says can lower an outcome.
 */
export function evaluateTaskCompletion(completion: AgentTaskCompletion, values: Record<string, unknown>, agentOutput?: unknown): TaskCompletionResult {
  const severity = { COMPLETED: 0, NEEDS_REVIEW: 1, NEEDS_EVIDENCE: 2, BLOCKED: 3 } as const;
  let status: (typeof TASK_OUTCOMES)[number] = "COMPLETED";
  const reasons: string[] = [];
  const raise = (to: (typeof TASK_OUTCOMES)[number], reason: string) => {
    reasons.push(reason);
    if (severity[to] > severity[status]) status = to;
  };
  const criteria = completion.criteria.map((criterion) => {
    const { status: observed, payload } = skillNodeOutcome(values[criterion.nodeId]);
    const missingFields = observed === "MISSING" ? [] : criterion.requiredPayloadFields.filter((field) => !(field in payload));
    const passed = observed !== "MISSING" && (criterion.acceptedStatuses as string[]).includes(observed) && missingFields.length === 0;
    if (!passed) {
      if (observed === "BLOCKED" || observed === "FAILED" || observed === "MISSING") {
        raise(completion.failurePolicy.unavailable_required_source, `${criterion.nodeId}: ${observed}`);
      } else if (observed === "NEEDS_EVIDENCE" || missingFields.length) {
        raise(completion.failurePolicy.missing_required_evidence, `${criterion.nodeId}: ${missingFields.length ? `missing ${missingFields.join(", ")}` : observed}`);
      } else {
        raise(completion.failurePolicy.ambiguous_evidence, `${criterion.nodeId}: ${observed}`);
      }
    }
    return { nodeId: criterion.nodeId, observed, passed, missingFields };
  });
  if (agentOutput && typeof agentOutput === "object" && (agentOutput as Record<string, unknown>).requiresHumanReview === true) {
    raise("NEEDS_REVIEW", "agent requested human review");
  }
  return { status, criteria, reasons };
}

export const graphNodeV2Schema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    "input", "output", "agent", "tool", "transform", "condition", "evaluate",
    "join", "aggregator", "approval", "loop", "group", "subgraph", "teacher",
    "gate", "fanout",
  ]),
  name: z.string().min(1),
  summary: z.string().optional(),
  prompt: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).nullable().optional(),
  outputSchema: z.record(z.string(), z.unknown()).nullable().optional(),
  contextSelectorIds: z.array(z.string().min(1)),
  config: z.record(z.string(), z.unknown()),
}).strict().superRefine((node, context) => {
  if (node.kind === "gate") {
    if (typeof node.config.policyRef !== "string" || node.config.policyRef.length === 0) {
      context.addIssue({ code: "custom", path: ["config", "policyRef"], message: "Gate nodes require policyRef." });
    }
    if (typeof node.config.gateId !== "string" || node.config.gateId.length === 0) {
      context.addIssue({ code: "custom", path: ["config", "gateId"], message: "Gate nodes require gateId." });
    }
  }
  if (node.config.loop !== undefined) {
    if (node.kind !== "agent" && node.kind !== "evaluate") {
      context.addIssue({ code: "custom", path: ["config", "loop"], message: "Only agent and evaluate nodes may declare a loop." });
    }
    const parsed = agentLoopConfigSchema.safeParse(node.config.loop);
    if (!parsed.success) context.addIssue({ code: "custom", path: ["config", "loop"], message: "Agent loop configuration is invalid." });
  }
  if (node.config.completion !== undefined) {
    if (node.kind !== "agent") context.addIssue({ code: "custom", path: ["config", "completion"], message: "Only agent nodes may declare task completion." });
    if (!agentTaskCompletionSchema.safeParse(node.config.completion).success) {
      context.addIssue({ code: "custom", path: ["config", "completion"], message: "Task completion configuration is invalid." });
    }
  }
  if (node.kind === "fanout") {
    const positiveInteger = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value > 0;
    if (typeof node.config.itemsPath !== "string" || node.config.itemsPath.length === 0) {
      context.addIssue({ code: "custom", path: ["config", "itemsPath"], message: "Fanout nodes require itemsPath." });
    }
    if (typeof node.config.bodyRef !== "string" || node.config.bodyRef.length === 0) {
      context.addIssue({ code: "custom", path: ["config", "bodyRef"], message: "Fanout nodes require bodyRef." });
    }
    if (!positiveInteger(node.config.maxItems)) {
      context.addIssue({ code: "custom", path: ["config", "maxItems"], message: "Fanout nodes require a positive maxItems bound." });
    }
    if (!positiveInteger(node.config.maxConcurrency)) {
      context.addIssue({ code: "custom", path: ["config", "maxConcurrency"], message: "Fanout nodes require a positive maxConcurrency bound." });
    }
    if (!new Set(["all", "allSettled", "first"]).has(String(node.config.joinMode))) {
      context.addIssue({ code: "custom", path: ["config", "joinMode"], message: "Fanout nodes require a supported joinMode." });
    }
  }
});

export const graphEdgeV2Schema = graphEdgeSchema.extend({
  outcome: z.string().min(1).optional(),
});

export const harnessPlanV2Schema = z.object({
  apiVersion: z.literal("harness.factory/plan-v2"),
  kind: z.literal("HarnessPlan"),
  planId: z.string().min(1),
  planDigest: sha256DigestSchema,
  packageDigest: sha256DigestSchema,
  compiler: z.object({
    name: z.literal("harnessc"),
    version: z.string().min(1),
    digest: sha256DigestSchema,
    compatibilityVersion: z.string().min(1),
    lgirCoreRevision: z.string().min(7),
  }).strict(),
  metadata: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    domain: z.string().min(1),
    objective: z.string().min(1),
  }).strict(),
  execution: z.object({
    engine: z.object({
      kind: z.literal("harness-runtime"),
      adapterVersion: z.string().min(1),
      profile: z.string().min(1),
    }).strict(),
    coordinationMode: z.enum(["caseStore", "dataFlow"]),
    maxTransitions: z.number().int().positive().max(100_000),
    maxConcurrency: z.number().int().positive().max(1_000),
    durability: z.literal("durable"),
  }).strict(),
  budgets: z.object({
    maxDurationMs: z.number().int().positive(),
    maxCostUsd: z.number().nonnegative(),
    maxModelCalls: z.number().int().nonnegative(),
    maxCapabilityCalls: z.number().int().nonnegative(),
  }).strict(),
  schemas: z.object({
    input: z.record(z.string(), z.unknown()),
    output: z.record(z.string(), z.unknown()),
    schemaSetDigest: sha256DigestSchema,
  }).strict(),
  modelProfiles: z.array(z.object({ id: z.string().min(1), digest: sha256DigestSchema }).strict()),
  /** Agent profiles (compiler compatibility 4/5); replaced the plan's `skills` and `agents`. */
  agentProfiles: z.array(agentProfileSchema),
  capabilities: z.array(capabilityDefinitionSchema),
  permissionEnvelopes: z.array(permissionEnvelopeSchema),
  policyBundles: z.array(z.object({
    policyId: z.string().min(1),
    bundleDigest: sha256DigestSchema,
  }).strict()),
  sourceAuthorization: planSourceAuthorizationSchema.optional(),
  contextSelectors: z.array(contextSelectorSchema),
  contextClassificationPolicies: z.array(contextClassificationPolicySchema).default([]),
  integrations: integrationContractsSchema.optional(),
  /**
   * Business skills pinned at compile time. Absent (not `[]`) on plans without skill-bound
   * nodes so they keep their existing bytes and digest; read it as `plan.skillBindings ?? []`.
   */
  skillBindings: z.array(planSkillBindingSchema).optional(),
  graph: z.object({
    apiVersion: z.literal("ladder.dev/v1alpha1"),
    name: z.string().min(1),
    nodes: z.array(graphNodeV2Schema),
    edges: z.array(graphEdgeV2Schema),
    nodeOrder: z.array(z.string()),
  }).strict(),
  releaseConstraints: z.object({
    regions: z.array(z.string().min(1)).min(1),
    dataClasses: z.array(z.string().min(1)),
    evaluationRequirementIds: z.array(z.string().min(1)),
  }).strict(),
  dependencyManifest: z.array(z.object({
    kind: z.string().min(1),
    id: z.string().min(1),
    digest: sha256DigestSchema,
  }).strict()),
  dependencyManifestDigest: sha256DigestSchema,
  createdAt: z.string().datetime(),
  buildProvenanceDigest: sha256DigestSchema,
}).strict().refine(
  // A v2 plan compiled before agent profiles carries `skills` and `agents` (and no
  // `agentProfiles`). The strict object already refuses the keys (and strips them from the
  // value a check sees); this check runs exactly then, to say what to do about it.
  () => false,
  {
    message: `${PLAN_V2_AGENT_PROFILES_REQUIRED}: v2 plans carry agentProfiles instead of skills and agents; recompile the package with the current harnessc.`,
    path: ["agentProfiles"],
    when: (payload) => payload.issues.some((issue) => issue.code === "unrecognized_keys"
      && !issue.path?.length && issue.keys.some((key) => key === "skills" || key === "agents")),
  },
).superRefine((plan, context) => {
  plan.graph.nodes.forEach((node, index) => {
    if ("skillRefs" in node.config) {
      context.addIssue({ code: "custom", path: ["graph", "nodes", index, "config", "skillRefs"], message: `${PLAN_V2_AGENT_PROFILES_REQUIRED}: node skillRefs are retired; instructions come from the node's agent profile.` });
    }
    if (node.config.agentRef !== undefined && !plan.agentProfiles.some((profile) => profile.id === node.config.agentRef)) {
      context.addIssue({ code: "custom", path: ["graph", "nodes", index, "config", "agentRef"], message: "plan.agent_profile_missing" });
    }
  });
});

/**
 * Refusal code for a `harness.factory/plan-v1` document. The v1 plan pipeline (and its
 * `langgraph-js` / `harness-langgraph-v1` engine) was removed; only v2 plans compile,
 * admit and run.
 */
export const PLAN_V1_REMOVED = "plan.v1_removed";
const RETIRED_PLAN_API_VERSION = "harness.factory/plan-v1";

/** True for a document that declares the removed v1 plan contract. */
export function isRetiredPlanV1(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
    && (value as { apiVersion?: unknown }).apiVersion === RETIRED_PLAN_API_VERSION;
}

/**
 * Parse an executable plan. A v1 plan is refused with `plan.v1_removed` (rather than a
 * schema error) so an operator holding one knows to recompile it as a v2 package.
 */
export function parseHarnessPlan(value: unknown): HarnessPlanV2 {
  if (isRetiredPlanV1(value)) {
    throw new Error(`${PLAN_V1_REMOVED}: ${RETIRED_PLAN_API_VERSION} plans are no longer supported; recompile the package as harness.factory/domain-package-v2.`);
  }
  return harnessPlanV2Schema.parse(value);
}

/** The runtime invocation envelope. It carries one admitted v2 plan. */
export const runtimeInvocationV2Schema = z.object({
  contractVersion: z.literal("runtime.invocation.v2"),
  invocationId: z.string().min(1),
  runId: z.string().min(1),
  attempt: z.number().int().positive(),
  workerId: z.string().min(1),
  leaseId: z.string().min(1),
  fencingEpoch: z.number().int().positive(),
  deadlineAt: z.string().datetime(),
  planDigest: sha256DigestSchema,
  executionProfileDigest: sha256DigestSchema,
  executionGrant: z.string().min(1),
  plan: harnessPlanV2Schema,
  input: z.unknown(),
  nodeExecution: z.object({
    nodeId: z.string().min(1),
    workItemId: z.string().min(1),
    fencingEpoch: z.number().int().positive(),
    predecessorValues: z.record(z.string(), z.unknown()),
  }).strict().optional(),
}).strict().superRefine((value, context) => {
  if (value.plan.planDigest.replace(/^sha256:/, "") !== value.planDigest.replace(/^sha256:/, "")) {
    context.addIssue({ code: "custom", path: ["plan", "planDigest"], message: "runtime.plan_digest_mismatch" });
  }
});

/**
 * runtime.invocation.v3: a node invocation that also carries the settlements earlier node
 * invocations reported (runtime.result.v2) as `predecessorSettlements`.
 */
export const runtimeInvocationV3Schema=z.object({...runtimeInvocationV2Schema.shape,contractVersion:z.literal('runtime.invocation.v3'),
  nodeExecution:z.object({nodeId:z.string().min(1),workItemId:z.string().min(1),fencingEpoch:z.number().int().positive(),
    predecessorValues:z.record(z.string(),z.unknown()),predecessorSettlements:z.record(z.string(),runtimeSettlementSchema)}).strict(),
}).strict().superRefine((value,context)=>{
  if(value.plan.planDigest.replace(/^sha256:/,'')!==value.planDigest.replace(/^sha256:/,''))context.addIssue({code:'custom',path:['planDigest'],message:'runtime.plan_digest_mismatch'});
});
/** Every runtime invocation envelope a host accepts. Both carry one admitted v2 plan. */
export const runtimeInvocationAnyVersionSchema = z.discriminatedUnion("contractVersion", [
  runtimeInvocationV2Schema,
  runtimeInvocationV3Schema,
]);

export type EffectClass = z.infer<typeof effectClassSchema>;
export type CapabilityDefinition = z.infer<typeof capabilityDefinitionSchema>;
export type PermissionEnvelope = z.infer<typeof permissionEnvelopeSchema>;
export type RunRequest = z.infer<typeof runRequestSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type RunStatus = z.infer<typeof runStatusSchema>;
export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;
export type RuntimeProviderKind = z.infer<typeof runtimeProviderKindSchema>;
export type RuntimeInvocationStatus = z.infer<typeof runtimeInvocationStatusSchema>;
export type RuntimeInvocationResult = z.infer<typeof runtimeInvocationResultSchema>;
export type RuntimeSettlement = z.infer<typeof runtimeSettlementSchema>;
export type KycCaseStatus = z.infer<typeof kycCaseStatusSchema>;
export type CaseActor = z.infer<typeof caseActorSchema>;
export type CaseAuthority = z.infer<typeof caseAuthoritySchema>;
export type CreateKycCaseRequest = z.infer<typeof createKycCaseRequestSchema>;
export type BusinessCommand = z.infer<typeof businessCommandSchema>;
export type BusinessCommandType = z.infer<typeof businessCommandTypeSchema>;
export type CaseReadGrant = z.infer<typeof caseReadGrantSchema>;
export type ContextClassificationPolicy = z.infer<typeof contextClassificationPolicySchema>;
export type RegisterEvidenceRequest = z.infer<typeof registerEvidenceRequestSchema>;
export type CommandOutcome = z.infer<typeof commandOutcomeSchema>;
export type ExecutionEnvelopeClaims = z.infer<typeof executionEnvelopeClaimsSchema>;
export type RuntimeGrantClaims = z.infer<typeof runtimeGrantClaimsSchema>;
export type EnvelopeRequest = z.infer<typeof envelopeRequestSchema>;
export type CapabilityRequest = z.infer<typeof capabilityRequestSchema>;
export type CapabilityResult = z.infer<typeof capabilityResultSchema>;
export type AuthoringStatus = z.infer<typeof authoringStatusSchema>;
export type AuthoringDraftInput = z.infer<typeof authoringDraftInputSchema>;
export type CapabilityRegistration = z.infer<typeof capabilityRegistrationSchema>;
export type ConnectorStatus = z.infer<typeof connectorStatusSchema>;
export type ConnectorRegistration = z.infer<typeof connectorRegistrationSchema>;
export type ConnectorCatalogCapability = z.infer<typeof connectorCatalogCapabilitySchema>;
export type ConnectorCatalog = z.infer<typeof connectorCatalogSchema>;
export type CanonicalCapabilityDefinition = z.infer<typeof canonicalCapabilityDefinitionSchema>;
export type CanonicalConnectorBinding = z.infer<typeof canonicalConnectorBindingSchema>;
export type ConnectorTemplate = z.infer<typeof connectorTemplateSchema>;
export type ConnectorTemplateRegistration = z.infer<typeof connectorTemplateRegistrationSchema>;
export type AuthoringSource = z.infer<typeof authoringSourceSchema>;
export type SkillRegistration = z.infer<typeof skillRegistrationSchema>;
export type AgentRegistration = z.infer<typeof agentRegistrationSchema>;
export type AgentInstruction = z.infer<typeof agentInstructionSchema>;
export type AgentProfile = z.infer<typeof agentProfileSchema>;
export type AgentProfileLimits = z.infer<typeof agentProfileLimitsSchema>;
export type PackageAgentProfile = z.infer<typeof packageAgentProfileSchema>;
export type ModelProfileDocument = z.infer<typeof modelProfileDocumentSchema>;
export type ProviderKind = z.infer<typeof providerKindSchema>;
export type ProviderRecord = z.infer<typeof providerRecordSchema>;
export type PlatformSettings = z.infer<typeof platformSettingsSchema>;
export type PlatformSettingSection = z.infer<typeof platformSettingSectionSchema>;
export type AdminChangeAction = z.infer<typeof adminChangeActionSchema>;
export type AdminChangeRecord = z.infer<typeof adminChangeRecordSchema>;
export type EvaluationReport = z.infer<typeof evaluationReportSchema>;
export type PolicyDecision = z.infer<typeof policyDecisionSchema>;
export type ArtifactKind = z.infer<typeof artifactKindSchema>;
export type ArtifactRegistryEntry = z.infer<typeof artifactRegistryEntrySchema>;
export type PolicyBundle = z.infer<typeof policyBundleSchema>;
export type CaseSnapshot = z.infer<typeof caseSnapshotSchema>;
export type ContextTrust = z.infer<typeof contextTrustSchema>;
export type ContextManifest = z.infer<typeof contextManifestSchema>;
export type AgentLoopConfig = z.infer<typeof agentLoopConfigSchema>;
export type AgentLoopAction = z.infer<typeof agentLoopActionSchema>;
export type PolicyEvaluation = z.infer<typeof policyEvaluationSchema>;
export type ExecutionWorkItemStatus = z.infer<typeof executionWorkItemStatusSchema>;
export type ExecutionWorkItem = z.infer<typeof executionWorkItemSchema>;
export type HumanWorkDecision = z.infer<typeof humanWorkDecisionSchema>;
export type ReleaseStatus = z.infer<typeof releaseStatusSchema>;
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
export type ReleaseRecord = z.infer<typeof releaseRecordSchema>;
export type ContextSelector = z.infer<typeof contextSelectorSchema>;
export type PolicyBinding = z.infer<typeof policyBindingSchema>;
export type IntegrationIntent = z.infer<typeof integrationIntentSchema>;
export type IntegrationTrigger = z.infer<typeof integrationTriggerSchema>;
export type IntegrationHumanAction = z.infer<typeof integrationHumanActionSchema>;
export type IntegrationPublication = z.infer<typeof integrationPublicationSchema>;
export type IntegrationContracts = z.infer<typeof integrationContractsSchema>;
export type IntegrationConnector = z.infer<typeof integrationConnectorSchema>;
export type IntegrationBinding = z.infer<typeof integrationBindingSchema>;
export type IntegrationBindingStatus = z.infer<typeof integrationBindingStatusSchema>;
export type IntegrationCloudEvent = z.infer<typeof integrationCloudEventSchema>;
export type IntegrationEnvelopeClaims = z.infer<typeof integrationEnvelopeClaimsSchema>;
export type DomainPackageV2 = z.infer<typeof domainPackageV2Schema>;
export type GraphNodeV2 = z.infer<typeof graphNodeV2Schema>;
export type GraphEdgeV2 = z.infer<typeof graphEdgeV2Schema>;
export type HarnessPlanV2 = z.infer<typeof harnessPlanV2Schema>;
export type RuntimeInvocationV2 = z.infer<typeof runtimeInvocationV2Schema>;
export type RuntimeInvocationV3 = z.infer<typeof runtimeInvocationV3Schema>;
export type RuntimeInvocationAnyVersion = z.infer<typeof runtimeInvocationAnyVersionSchema>;

/**
 * Content covered by a release manifest digest.
 *
 * The digest field cannot cover itself. Keeping this operation in the shared contract
 * package prevents the registry, CLI and runtime implementations from digesting
 * different byte sequences. A legacy `signature` field, if present on stored data, is
 * excluded so digests recorded before the registry replaced signing still verify.
 */
export function releaseManifestPayload(
  manifest: ReleaseManifest,
): Omit<ReleaseManifest, "manifestDigest"> {
  const { manifestDigest: _manifestDigest, signature: _signature, ...payload } = manifest as ReleaseManifest & { signature?: unknown };
  return payload;
}

export function computeReleaseManifestDigest(manifest: ReleaseManifest): string {
  return stableDigest(releaseManifestPayload(manifest));
}

export function verifyReleaseManifestDigest(manifest: ReleaseManifest): boolean {
  return manifest.manifestDigest.replace(/^sha256:/, "") === computeReleaseManifestDigest(manifest);
}

// The plan compiler (packages/compiler) canonicalizes with keys in UTF-8 byte order.
// JavaScript string comparison orders by UTF-16 code unit, which agrees with UTF-8
// byte order for every Basic Multilingual Plane code point. localeCompare does not: it is ICU- and
// locale-sensitive ("a" sorts before "Z", "aB" after "a_b"), so a plan compiled by
// harnessc and re-digested here would not verify once a key carried a capital letter
// or an underscore. Key ordering is part of the plan trust root; it must not depend
// on the host's collation tables.
function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, nested]) => nested !== undefined)
        .sort(([left], [right]) => byCodeUnit(left, right))
        .map(([key, nested]) => [key, canonicalize(nested)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function stableDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function verifyPlanV2Digest(plan: HarnessPlanV2): boolean {
  const { planDigest: _ignored, planId: _id, ...content } = plan;
  return stableDigest(content) === plan.planDigest.replace(/^sha256:/, "");
}

export function verifyHarnessPlanDigest(plan: HarnessPlanV2): boolean {
  return verifyPlanV2Digest(plan);
}

// ---------------------------------------------------------------------------
// Business skills: the financial-crime canonical skills catalog (spec §3.3, §4, §9).
//
// Field names follow the catalog specification (snake_case) so catalog manifests validate
// without translation. Platform-side records (registry rows, plan bindings, selection
// records) keep the platform's camelCase.
// ---------------------------------------------------------------------------

/** §4.3 standard errors. */
export const SKILL_ERROR_CODES = [
  "INPUT_INVALID", "CONTEXT_MISSING", "CONTEXT_STALE", "ACCESS_DENIED", "POLICY_UNRESOLVED",
  "SOURCE_UNAVAILABLE", "SOURCE_CONFLICT", "LOW_CONFIDENCE", "EVIDENCE_INSUFFICIENT",
  "HUMAN_REVIEW_REQUIRED", "CONTROL_FAILED", "RATE_LIMITED", "TIMEOUT", "INTEGRITY_FAILURE",
  "EXTERNAL_ACTION_UNCONFIRMED",
] as const;
export const skillErrorCodeSchema = z.enum(SKILL_ERROR_CODES);
/** Errors a skill may retry (with bounded backoff) or fall back on; every other code is final. */
export const TRANSIENT_SKILL_ERROR_CODES = ["TIMEOUT", "RATE_LIMITED", "SOURCE_UNAVAILABLE"] as const;

export const skillPurposeSchema = z.enum(["onboarding", "review", "monitoring", "investigation", "fraud", "reporting"]);
/** A stable reference to a canonical object, e.g. `party:P-1` or `entity:E-9@2026-11-07`. */
export const canonicalRefSchema = z.string().min(1).max(512);

const nonEmptyText = z.string().trim().min(1);
const textList = z.array(nonEmptyText);
const jsonObject = z.record(z.string(), z.unknown());
/** A §4 field the catalog may state as prose or as structured configuration. */
const proseOrObject = z.union([nonEmptyText, jsonObject]);

export const businessSkillCompositionTypeSchema = z.enum(["atomic", "composite"]);
export const businessSkillStatusSchema = z.enum(["draft", "active", "deprecated"]);
/**
 * How far a skill has been proven, independent of its lifecycle status. Ordered: a seed never
 * lowers it for identical content. Production requires at least integration verification,
 * active lifecycle and separate current artifact/scope-specific qualification evidence.
 */
export const BUSINESS_SKILL_MATURITY_LEVELS = [
  "catalogued", "designed", "implemented_synthetic", "integration_verified", "production_qualified",
] as const;
export const businessSkillMaturitySchema = z.enum(BUSINESS_SKILL_MATURITY_LEVELS);

/** Evidence for one exact skill implementation, workflow and approved policy scope.
 * Approval/revocation belongs to the artifact registry, never to a caller-supplied flag.
 */
export const skillQualificationSchema = z.object({
  schemaVersion: z.literal("skill.qualification.v1"),
  skillId: businessSkillIdSchema,
  skillVersion: semverSchema,
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  bundleDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  bundleLockDigest: z.string().regex(/^[a-f0-9]{64}$/),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  policySnapshotRef: nonEmptyText.max(512),
  policyContextDigest: z.string().regex(/^[a-f0-9]{64}$/),
  jurisdictions: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(250),
  purpose: skillPurposeSchema,
  validFrom: z.string().datetime(),
  expiresAt: z.string().datetime(),
  independentReviewer: nonEmptyText.max(256),
  evidence: z.object({
    reportRef: nonEmptyText.max(1024),
    reportDigest: z.string().regex(/^[a-f0-9]{64}$/),
    datasetDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sampleCount: z.number().int().positive(),
    scopeDescription: nonEmptyText.max(4000),
    controlsPassed: z.literal(true),
    metrics: z.array(z.object({
      name: nonEmptyText.max(128),
      value: z.number().finite(),
      comparison: z.enum(["at_least", "at_most"]),
      threshold: z.number().finite(),
    }).strict()).min(1).max(100),
  }).strict(),
}).strict().superRefine((q, ctx) => {
  if (Date.parse(q.expiresAt) <= Date.parse(q.validFrom)) ctx.addIssue({ code: "custom", message: "skill_qualification.interval_invalid" });
  if (new Set(q.jurisdictions).size !== q.jurisdictions.length) ctx.addIssue({ code: "custom", message: "skill_qualification.jurisdictions_duplicate" });
  if (new Set(q.evidence.metrics.map((m) => m.name)).size !== q.evidence.metrics.length) ctx.addIssue({ code: "custom", message: "skill_qualification.metrics_duplicate" });
  for (const metric of q.evidence.metrics) {
    if (metric.comparison === "at_least" ? metric.value < metric.threshold : metric.value > metric.threshold) {
      ctx.addIssue({ code: "custom", message: `skill_qualification.threshold_failed:${metric.name}` });
    }
  }
});
export type SkillQualification = z.infer<typeof skillQualificationSchema>;

/**
 * Evidence that one agent, exactly as a plan embeds it, behaves acceptably on its scope
 * (docs/implementation/production-slice-1.md section 6). It binds the profile by digest
 * (`stableDigest` of the plan's `agentProfiles` entry: prompt, instructions, allowed skills and
 * capabilities, limits), the model profile revision by the digest the plan recorded, the exact
 * tool set its loops may call, and the plan. Any change to one of them needs new evidence.
 *
 * An agent proposes; it never decides. The authority counts are therefore literal zeros: a single
 * protected write, cleared alert or final disposition in the evaluation disqualifies the agent,
 * whatever its other metrics. Every injection case must have been resisted. Approval and
 * revocation belong to the artifact registry, as for skills.
 */
export const AGENT_QUALIFICATION_REQUIRED_METRICS = ["proposal_agreement", "citation_validity", "escalation_recall"] as const;
export const agentQualificationSchema = z.object({
  schemaVersion: z.literal("agent.qualification.v1"),
  agentProfileId: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).max(200),
  agentProfileVersion: semverSchema,
  agentProfileDigest: z.string().regex(/^[a-f0-9]{64}$/),
  modelProfileId: nonEmptyText.max(200),
  modelProfileDigest: z.string().regex(/^[a-f0-9]{64}$/),
  tools: z.array(nonEmptyText.max(200)).max(32),
  planDigest: z.string().regex(/^[a-f0-9]{64}$/),
  jurisdictions: z.array(z.string().regex(/^[A-Z]{2}$/)).min(1).max(250),
  purpose: skillPurposeSchema,
  validFrom: z.string().datetime(),
  expiresAt: z.string().datetime(),
  independentReviewer: nonEmptyText.max(256),
  evidence: z.object({
    reportRef: nonEmptyText.max(1024),
    reportDigest: z.string().regex(/^[a-f0-9]{64}$/),
    datasetDigest: z.string().regex(/^[a-f0-9]{64}$/),
    sampleCount: z.number().int().positive(),
    scopeDescription: nonEmptyText.max(4000),
    controlsPassed: z.literal(true),
    authority: z.object({
      protectedWriteViolations: z.literal(0),
      clearingViolations: z.literal(0),
      finalDispositionViolations: z.literal(0),
    }).strict(),
    injection: z.object({
      casesRun: z.number().int().positive(),
      casesResisted: z.number().int().nonnegative(),
    }).strict(),
    metrics: z.array(z.object({
      name: nonEmptyText.max(128),
      value: z.number().finite(),
      comparison: z.enum(["at_least", "at_most"]),
      threshold: z.number().finite(),
    }).strict()).min(1).max(100),
  }).strict(),
}).strict().superRefine((q, ctx) => {
  if (Date.parse(q.expiresAt) <= Date.parse(q.validFrom)) ctx.addIssue({ code: "custom", message: "agent_qualification.interval_invalid" });
  if (new Set(q.jurisdictions).size !== q.jurisdictions.length) ctx.addIssue({ code: "custom", message: "agent_qualification.jurisdictions_duplicate" });
  if (q.tools.some((tool, index) => index > 0 && q.tools[index - 1]! >= tool)) ctx.addIssue({ code: "custom", message: "agent_qualification.tools_not_sorted_unique" });
  if (q.evidence.injection.casesResisted !== q.evidence.injection.casesRun) ctx.addIssue({ code: "custom", message: "agent_qualification.injection_not_resisted" });
  const names = q.evidence.metrics.map((m) => m.name);
  if (new Set(names).size !== names.length) ctx.addIssue({ code: "custom", message: "agent_qualification.metrics_duplicate" });
  for (const required of AGENT_QUALIFICATION_REQUIRED_METRICS) {
    if (!names.includes(required)) ctx.addIssue({ code: "custom", message: `agent_qualification.metric_missing:${required}` });
  }
  for (const metric of q.evidence.metrics) {
    if (metric.comparison === "at_least" ? metric.value < metric.threshold : metric.value > metric.threshold) {
      ctx.addIssue({ code: "custom", message: `agent_qualification.threshold_failed:${metric.name}` });
    }
  }
});
export type AgentQualification = z.infer<typeof agentQualificationSchema>;
/** §6.3 effect modes, as the platform authorizes them (bundle locks and the gateway). */
export const skillEffectModeSchema = z.enum(["read_only", "proposal", "internal_write", "external_write"]);

const libraryId = z.string().min(1).max(512);
const libraryHash = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative();
const positiveCount = z.number().int().positive();

/** A library context requirement: the canonical record type and fields a skill reads. */
export const librarySkillContextRequirementSchema = z.object({
  object_type: libraryId,
  fields: z.array(libraryId),
  nullable_fields: z.array(libraryId).optional(),
  min_count: count,
  max_age_seconds: count.nullable(),
  optional: z.boolean(),
  model_visible: z.boolean(),
}).strict();

/** The library's effect modes; `human_gated` maps to a write mode plus required approval (CR-5). */
export const LIBRARY_SKILL_EFFECTS = ["read_only", "proposal", "internal_write", "external_write", "human_gated"] as const;

/**
 * One entry of the financial-crime skill library's catalog (`catalog/catalog.json`,
 * `SkillManifest` in the library's `schemas/runtime/SkillManifest.schema.json`), ingested
 * verbatim: the registry stores exactly this object and pins it by
 * `businessSkillManifestDigest`. Every field is required and unknown fields are refused, as in
 * the library's schema, so a catalog change that the platform has not reviewed fails ingestion
 * instead of being dropped. Failure codes must be §4.3 codes.
 */
export const librarySkillManifestSchema = z.object({
  id: businessSkillIdSchema,
  semver: semverSchema,
  description: z.string(),
  business_outcome: z.string(),
  input_schema: jsonObject,
  output_schema: jsonObject,
  required_context: z.array(librarySkillContextRequirementSchema),
  optional_context: z.array(librarySkillContextRequirementSchema),
  context_freshness: z.string(),
  policy_context_fields: z.array(libraryId),
  preconditions: z.array(z.string()),
  dependencies: z.object({
    skills: z.array(businessSkillIdSchema),
    capabilities: z.array(libraryId),
    libraries: z.array(libraryId),
  }).strict(),
  composition_type: businessSkillCompositionTypeSchema,
  execution_mode: z.enum(["code", "model", "provider", "composite", "human_task"]),
  entrypoint: libraryId,
  permitted_capabilities: z.array(libraryId),
  provider_policy: z.string(),
  policy_gates: z.array(z.string()),
  authorization: z.array(libraryId),
  effects: z.enum(LIBRARY_SKILL_EFFECTS),
  idempotency: z.string(),
  timeout: positiveCount,
  retry_policy: z.object({ max_attempts: positiveCount, external_uncertain: z.literal("reconcile") }).strict(),
  human_interrupt_conditions: z.array(z.string()),
  failure_codes: z.array(skillErrorCodeSchema).min(1),
  evidence_requirements: z.string(),
  audit_fields: z.array(libraryId),
  evaluation_profile: libraryId,
  cost_latency_budget: z.object({
    timeout_seconds: positiveCount,
    cost_limit: z.string().regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/).optional(),
    cost_currency: libraryId.optional(),
  }).strict(),
  data_classification: libraryId,
  jurisdiction_scope: z.array(libraryId),
  owner: libraryId,
  deprecation_policy: z.string(),
  maturity: z.enum(["implemented_synthetic", "integration_verified", "production_qualified"]),
  limitations: z.array(z.string()),
  code_hash: libraryHash,
  harness_name: libraryId,
  instructions: libraryId,
  instruction_hash: libraryHash,
  bundle_code_hash: libraryHash,
}).strict().superRefine((manifest, ctx) => {
  if (new Set(manifest.failure_codes).size !== manifest.failure_codes.length) {
    ctx.addIssue({ code: "custom", path: ["failure_codes"], message: "business_skill.failure_codes_duplicate" });
  }
  if (manifest.dependencies.skills.includes(manifest.id)) {
    ctx.addIssue({ code: "custom", path: ["dependencies"], message: "business_skill.depends_on_itself" });
  }
});

const fileRefSchema = z.object({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** The `package` block of a platform-authored manifest: implementation, dependencies, effects, permissions. */
export const businessSkillPackageSchema = z.object({
  name: z.string().min(1).optional(),
  implementation: z.object({
    kind: z.enum(["code", "model", "provider", "composite", "human_task"]),
    entrypoint: z.string().min(1).optional(),
  }).passthrough().optional(),
  instructions: fileRefSchema.optional(),
  schemas: z.object({ input: fileRefSchema.optional(), output: fileRefSchema.optional() }).strict().optional(),
  context: fileRefSchema.extend({ value: z.unknown() }).optional(),
  dependencies: z.object({
    skills: z.array(businessSkillIdSchema).default([]),
    capabilities: z.array(z.string().min(1)).default([]),
    libraries: z.array(z.string().min(1)).default([]),
  }).strict().optional(),
  effects: z.object({ mode: skillEffectModeSchema }).passthrough().optional(),
  authorization: z.object({ required_permissions: z.array(z.string().min(1)).default([]) }).passthrough().optional(),
  /** Canonical record object types the skill may propose (`CanonicalRecord` records); absent: any ontology type. */
  produces: z.array(z.string().regex(/^[A-Z][A-Za-z0-9]{0,63}$/)).max(64).optional(),
}).strict();

/**
 * A platform-authored manifest (spec §4 field names plus a `package` block). Only the reference
 * skill host's synthetic samples (`apps/skill-host-reference`) use it; the registry seed holds
 * library manifests only. Unknown keys are rejected so a misspelt field is reported.
 */
export const platformSkillManifestSchema = z.object({
  id: businessSkillIdSchema,
  semver: semverSchema,
  description: nonEmptyText,
  business_outcome: nonEmptyText,
  input_schema: jsonObject,
  output_schema: jsonObject,
  required_context: textList,
  optional_context: textList.optional(),
  context_freshness: proseOrObject.optional(),
  preconditions: textList.optional(),
  dependencies: z.array(businessSkillIdSchema).optional(),
  composition_type: businessSkillCompositionTypeSchema,
  execution_mode: z.enum(["deterministic", "model", "hybrid", "retrieval", "human"]),
  permitted_capabilities: textList.optional(),
  provider_policy: proseOrObject.optional(),
  policy_gates: textList.optional(),
  authorization: proseOrObject.optional(),
  idempotency: proseOrObject.optional(),
  timeout: z.union([z.number().int().positive(), nonEmptyText]).optional(),
  retry_policy: proseOrObject.optional(),
  human_interrupt_conditions: textList.optional(),
  failure_codes: z.array(skillErrorCodeSchema).min(1),
  evidence_requirements: textList.optional(),
  audit_fields: textList.optional(),
  evaluation_profile: proseOrObject.optional(),
  cost_latency_budget: proseOrObject.optional(),
  data_classification: nonEmptyText,
  jurisdiction_scope: textList.optional(),
  owner: nonEmptyText,
  deprecation_policy: proseOrObject.optional(),
  status: businessSkillStatusSchema.optional(),
  maturity: businessSkillMaturitySchema.optional(),
  source: nonEmptyText.optional(),
  package: businessSkillPackageSchema.optional(),
  extensions: jsonObject.optional(),
}).strict().superRefine((manifest, ctx) => {
  if (new Set(manifest.failure_codes).size !== manifest.failure_codes.length) {
    ctx.addIssue({ code: "custom", path: ["failure_codes"], message: "business_skill.failure_codes_duplicate" });
  }
  if (manifest.dependencies?.includes(manifest.id)) {
    ctx.addIssue({ code: "custom", path: ["dependencies"], message: "business_skill.depends_on_itself" });
  }
});

/** A business-skill registry manifest: a library catalog entry or a platform-authored manifest. */
export const businessSkillManifestSchema = z.union([librarySkillManifestSchema, platformSkillManifestSchema]);

/**
 * The manifest digest both sides pin (integration contract §8, change request CR-7): sha256 over
 * the canonical JSON (UTF-8, keys sorted by code unit, no insignificant whitespace, undefined
 * dropped) of the manifest exactly as the registry stores it — for a library skill, its catalog
 * entry verbatim. It equals the library's own `digest()` of the entry (the library's
 * `release-lock.json` `catalog_hash` is the same function over the whole catalog). Bare hex;
 * plans and the registry store it bare, bundle locks as `sha256:<hex>`.
 */
export function businessSkillManifestDigest(manifest: unknown): string {
  return stableDigest(manifest);
}

export function isLibrarySkillManifest(manifest: BusinessSkillManifest): manifest is LibrarySkillManifest {
  return "entrypoint" in manifest && "bundle_code_hash" in manifest;
}

/**
 * Human-gated library skills whose effect leaves the platform (CR-5: a regulatory filing, a
 * retention deletion). Every other human-gated skill writes internally. A human-gated skill not
 * named here maps to `internal_write`, the narrower mode: it cannot request an external action.
 */
export const EXTERNAL_WRITE_HUMAN_GATED_SKILLS: readonly string[] = ["regulatory.filing.submit", "evidence.retention.enforce"];

export const businessSkillEffectsSchema = z.object({
  mode: skillEffectModeSchema,
  /** `required`: the skill's effect is a proposal until an independent human approves it (CR-6). */
  approval: z.enum(["required", "none"]),
}).strict();

/**
 * The effect mode the platform authorizes for a skill (§6.3, CR-5): library `read_only`,
 * `proposal`, `internal_write` and `external_write` map to themselves; `human_gated` maps to
 * `external_write` for the skills in EXTERNAL_WRITE_HUMAN_GATED_SKILLS and `internal_write`
 * otherwise, with approval required. A platform-authored manifest declares its mode in
 * `package.effects.mode`; none declared is read-only, the narrowest authority.
 */
export function businessSkillEffects(manifest: BusinessSkillManifest): BusinessSkillEffects {
  if (!isLibrarySkillManifest(manifest)) return { mode: manifest.package?.effects?.mode ?? "read_only", approval: "none" };
  return librarySkillEffectMode(manifest.id, manifest.effects);
}

/**
 * The CR-5 rule for one library skill, by id and library `effects` value. The one rule both
 * the registry (`businessSkillEffects`) and the library effect-command mapping
 * (`@ehf/library-contracts` `LIBRARY_SKILL_EFFECTS`) use.
 */
export function librarySkillEffectMode(skillId: string, effects: (typeof LIBRARY_SKILL_EFFECTS)[number]): BusinessSkillEffects {
  if (effects !== "human_gated") return { mode: effects, approval: "none" };
  return { mode: EXTERNAL_WRITE_HUMAN_GATED_SKILLS.includes(skillId) ? "external_write" : "internal_write", approval: "required" };
}

export const businessSkillDependenciesSchema = z.object({
  /** Capability names the skill may call through the gateway (declared ∪ permitted, in that order). */
  capabilities: z.array(z.string().min(1)),
  /** Sub-skills by catalog ID. */
  skills: z.array(businessSkillIdSchema),
}).strict();

/**
 * CR-8: the platform capability that serves each library provider capability. A library manifest
 * declares the library's name (`document.fields`); plans, envelopes and connectors use the platform
 * id (`document.fields.extract.v1`). Delegation compares platform ids, so it translates a skill's
 * declared dependencies here. `@ehf/library-contracts` LIBRARY_CAPABILITIES carries the same table
 * with each capability's request and response contracts, and its tests keep the two equal.
 */
export const LIBRARY_PLATFORM_CAPABILITIES: Readonly<Record<string, string>> = Object.freeze({
  "document.entities": "document.entities.extract.v1",
  "document.fields": "document.fields.extract.v1",
  "document.forensics": "document.forensics.assess.v1",
  "document.model": "document.model.extract.v1",
  "document.ocr": "document.ocr.extract.v1",
  "document.translate": "document.translate.v1",
  "fraud.account_takeover": "fraud.account_takeover.v1",
  "fraud.deepfake": "fraud.media.deepfake.v1",
  "fraud.document_tamper": "fraud.document.tamper.v1",
  "fraud.identity_theft": "fraud.identity.theft.v1",
  "fraud.liveness": "identity.biometric.verify.v1",
  "fraud.synthetic_identity": "fraud.identity.synthetic.v1",
});

/** A declared dependency as the platform capability id it reaches (an id passes through). */
export function platformCapabilityId(declared: string): string {
  return LIBRARY_PLATFORM_CAPABILITIES[declared] ?? declared;
}

export function businessSkillDependencies(manifest: BusinessSkillManifest): BusinessSkillDependencies {
  const declared = isLibrarySkillManifest(manifest) ? manifest.dependencies : manifest.package?.dependencies;
  const skills = isLibrarySkillManifest(manifest) ? manifest.dependencies.skills : manifest.package?.dependencies?.skills ?? manifest.dependencies ?? [];
  return {
    capabilities: [...new Set([...(declared?.capabilities ?? []), ...(manifest.permitted_capabilities ?? [])])],
    skills: [...new Set(skills)],
  };
}

/**
 * The permissions a skill declares: a library manifest's `authorization` list (`skill:<id>`,
 * `effect:<mode>`, and `case_command:<Type>` for each case command it may request, CR-5), or a
 * platform manifest's `package.authorization.required_permissions`.
 */
export function businessSkillPermissions(manifest: BusinessSkillManifest): string[] {
  return isLibrarySkillManifest(manifest) ? [...manifest.authorization] : [...(manifest.package?.authorization?.required_permissions ?? [])];
}

/**
 * The canonical record object types a skill declares it produces, or null when its manifest
 * declares none (then any valid ontology type is accepted). Library catalog entries carry no
 * such field yet (change request CR-9).
 */
export function businessSkillProducedObjectTypes(manifest: BusinessSkillManifest): string[] | null {
  if (isLibrarySkillManifest(manifest)) return null;
  return manifest.package?.produces ? [...manifest.package.produces] : null;
}

/**
 * The case commands a skill's manifest authorizes as `case_command` effects: library
 * `authorization` entries `case_command:<Type>`, or a platform manifest's
 * `required_permissions` entries in either form (the gateway accepts both). Names that are not
 * business commands are dropped.
 */
export function businessSkillCaseCommands(manifest: BusinessSkillManifest): z.infer<typeof businessCommandTypeSchema>[] {
  const library = isLibrarySkillManifest(manifest);
  const names = businessSkillPermissions(manifest).map((permission) => {
    if (permission.startsWith("case_command:")) return permission.slice("case_command:".length);
    return library ? "" : permission;
  });
  const commands: z.infer<typeof businessCommandTypeSchema>[] = [];
  for (const name of names) {
    const parsed = businessCommandTypeSchema.safeParse(name);
    if (parsed.success && !commands.includes(parsed.data)) commands.push(parsed.data);
  }
  return commands;
}

/** §4.1 SkillInput.v1. */
export const skillInputV1Schema = z.object({
  execution_id: z.string().uuid(),
  tenant_id: nonEmptyText,
  case_id: nonEmptyText.nullable(),
  subject_refs: z.array(canonicalRefSchema),
  parameters: jsonObject,
  context_manifest_ref: nonEmptyText,
  policy_snapshot_ref: nonEmptyText,
  as_of_time: z.string().datetime({ offset: true }),
  purpose: skillPurposeSchema,
  actor_ref: nonEmptyText,
  idempotency_key: nonEmptyText,
  trace_id: nonEmptyText,
}).strict();

export const skillResultStatusSchema = z.enum(["COMPLETED", "PARTIAL", "NEEDS_EVIDENCE", "NEEDS_REVIEW", "BLOCKED", "FAILED"]);

/**
 * §4.2 SkillResult.v1. `COMPLETED` means execution completed, not compliance approval;
 * missing mandatory evidence must never read as a pass, and `BLOCKED` is not a negative finding.
 */
export const skillResultV1Schema = z.object({
  execution_id: z.string().uuid(),
  skill_id: businessSkillIdSchema,
  skill_version: semverSchema,
  status: skillResultStatusSchema,
  result_refs: z.array(canonicalRefSchema),
  evidence_refs: z.array(canonicalRefSchema),
  finding_refs: z.array(canonicalRefSchema),
  unresolved_items: z.array(z.object({
    code: nonEmptyText,
    subject_ref: z.string(),
    explanation: nonEmptyText,
  }).strict()),
  policy_snapshot_ref: nonEmptyText,
  context_hash: nonEmptyText,
  trace_ref: nonEmptyText,
  metrics: z.object({
    duration_ms: z.number().int().nonnegative(),
    provider_calls: z.number().int().nonnegative(),
    cost_estimate: z.number().nonnegative(),
  }).strict(),
  error: z.object({ code: skillErrorCodeSchema, retryable: z.boolean() }).strict().nullable(),
}).strict().superRefine((result, ctx) => {
  if ((result.status === "FAILED" || result.status === "BLOCKED") && !result.error) {
    ctx.addIssue({ code: "custom", path: ["error"], message: "skill_result.error_required" });
  }
  if (result.status === "COMPLETED" && result.error) {
    ctx.addIssue({ code: "custom", path: ["error"], message: "skill_result.completed_with_error" });
  }
  if ((result.status === "NEEDS_EVIDENCE" || result.status === "NEEDS_REVIEW" || result.status === "PARTIAL") && !result.unresolved_items.length) {
    ctx.addIssue({ code: "custom", path: ["unresolved_items"], message: "skill_result.unresolved_items_required" });
  }
});

/**
 * §3.3 ContextEnvelope.v1: the smallest authorized snapshot a skill receives. Every field is
 * required; a value the context plane could not establish is reported as missing context,
 * never emitted as an empty value. `case_id` is null only for work that has no case, and
 * `graph_scope` only for a skill that reads no graph.
 */
export const contextEnvelopeV1Schema = z.object({
  tenant_id: nonEmptyText,
  case_id: nonEmptyText.nullable(),
  subject_refs: z.array(canonicalRefSchema).min(1),
  jurisdiction: nonEmptyText,
  purpose: nonEmptyText,
  actor: nonEmptyText,
  policy_snapshot_ref: nonEmptyText,
  as_of_time: z.string().datetime({ offset: true }),
  object_refs: z.array(nonEmptyText),
  evidence_refs: z.array(nonEmptyText),
  graph_scope: z.object({
    root_refs: z.array(canonicalRefSchema).min(1),
    max_depth: z.number().int().min(0).max(32),
    edge_types: z.array(nonEmptyText).optional(),
  }).strict().nullable(),
  /** Context object type → maximum age (ISO-8601 duration), e.g. `{ WatchlistEntry: "P1D" }`. */
  freshness_requirements: z.record(z.string(), nonEmptyText),
  /** Connector IDs the skill may reach: the node's pinned candidates, nothing else. */
  permitted_providers: z.array(nonEmptyText),
  redaction_profile: nonEmptyText,
  token_budget: z.number().int().positive(),
  correlation_id: nonEmptyText,
  /** Replay hash of the context this envelope describes (the context pack digest). */
  context_hash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/**
 * One registry entry of `config/business-skills.json` (generated by
 * scripts/sync-business-skills.mjs from the vendored library catalog). `manifest` is the catalog
 * entry verbatim; `manifestDigest`, `effects` and `dependencies` are derived from it by the
 * shared functions above and checked here, so an entry cannot claim a digest, an effect mode or
 * a dependency its manifest does not have.
 */
export const businessSkillCatalogEntrySchema = z.object({
  skillId: businessSkillIdSchema,
  semver: semverSchema,
  status: businessSkillStatusSchema,
  maturity: businessSkillMaturitySchema,
  owner: nonEmptyText,
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  effects: businessSkillEffectsSchema,
  dependencies: businessSkillDependenciesSchema,
  source: z.object({ path: nonEmptyText, revision: nonEmptyText }).strict(),
  manifest: businessSkillManifestSchema,
}).strict().superRefine((entry, ctx) => {
  if (entry.manifest.id !== entry.skillId || entry.manifest.semver !== entry.semver) {
    ctx.addIssue({ code: "custom", path: ["manifest"], message: "business_skill.entry_identity_mismatch" });
  }
  if (businessSkillManifestDigest(entry.manifest) !== entry.manifestDigest) {
    ctx.addIssue({ code: "custom", path: ["manifestDigest"], message: "business_skill.manifest_digest_mismatch" });
  }
  if (canonicalJson(businessSkillEffects(entry.manifest)) !== canonicalJson(entry.effects)) {
    ctx.addIssue({ code: "custom", path: ["effects"], message: "business_skill.effects_mismatch" });
  }
  if (canonicalJson(businessSkillDependencies(entry.manifest)) !== canonicalJson(entry.dependencies)) {
    ctx.addIssue({ code: "custom", path: ["dependencies"], message: "business_skill.dependencies_mismatch" });
  }
});

/** `config/business-skills.json`: the registry seed, generated from one library catalog release. */
export const businessSkillCatalogSchema = z.object({
  apiVersion: z.literal("harness.factory/business-skill-catalog-v2"),
  generatedFrom: z.object({
    /** The vendored catalog the seed was generated from, e.g. `config/skill-library/catalog.json`. */
    source: nonEmptyText,
    library: nonEmptyText,
    /** Catalog `version`, `source_hash`, `bundle_code_hash` and the release lock's `catalog_hash`. */
    version: semverSchema,
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    bundleDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    catalogHash: z.string().regex(/^[a-f0-9]{64}$/),
    /** The commit of an external library checkout the snapshot was taken from. */
    revision: z.string().regex(/^[a-f0-9]{40}$/).optional(),
    /** The repository path of an in-repository library (apps/fincrime-host). */
    path: z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/).optional(),
  }).strict().refine((source) => Boolean(source.revision) !== Boolean(source.path), { message: "business_skill.source_origin_required" }),
  skills: z.array(businessSkillCatalogEntrySchema),
}).strict().superRefine((catalog, ctx) => {
  const keys = catalog.skills.map((skill) => `${skill.skillId}@${skill.semver}`);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: ["skills"], message: "business_skill.duplicate" });
});

/**
 * The bundle-lock entry (§8, CR-7) the platform expects a skill host to serve for a library
 * skill: digests from the catalog entry, effect mode per CR-5, sub-skills pinned as
 * `skill_id@semver` through `versionOf` (throws when a sub-skill is not in the catalog).
 */
export function librarySkillBundleLockEntry(
  manifest: LibrarySkillManifest,
  versionOf: (skillId: string) => string | undefined,
): z.input<typeof skillBundleLockEntrySchema> {
  const dependencies = businessSkillDependencies(manifest);
  return {
    id: manifest.id,
    version: manifest.semver,
    maturity: manifest.maturity,
    manifest_digest: `sha256:${businessSkillManifestDigest(manifest)}`,
    instructions_digest: `sha256:${manifest.instruction_hash}`,
    code_digest: `sha256:${manifest.code_hash}`,
    input_schema_digest: `sha256:${stableDigest(manifest.input_schema)}`,
    output_schema_digest: `sha256:${stableDigest(manifest.output_schema)}`,
    dependencies: {
      capabilities: dependencies.capabilities,
      skills: dependencies.skills.map((skillId) => {
        const version = versionOf(skillId);
        if (!version) throw new Error(`skill_bundle.dependency_unresolved:${manifest.id}:${skillId}`);
        return `${skillId}@${version}`;
      }),
    },
    effects: businessSkillEffects(manifest).mode,
  };
}

/**
 * The bundle lock (§8, CR-7) the platform expects for a library catalog release: bundle id
 * `financial-crime-skills`, version = catalog `version`, `bundle_digest` = `sha256:` +
 * `bundle_code_hash` (what the KYB/KYC packages pin), one librarySkillBundleLockEntry per
 * catalog skill. Image and SBOM digests come from the host's container build.
 */
export function librarySkillBundleLock(
  catalog: { version: string; bundle_code_hash: string; skills: unknown[] },
  build: { imageDigest: string; sbomDigest: string },
): z.infer<typeof skillBundleLockSchema> {
  const skills = catalog.skills.map((skill) => librarySkillManifestSchema.parse(skill));
  const versions = new Map(skills.map((skill) => [skill.id, skill.semver]));
  return skillBundleLockSchema.parse({
    bundle_id: "financial-crime-skills",
    bundle_version: catalog.version,
    bundle_digest: `sha256:${catalog.bundle_code_hash}`,
    image_digest: build.imageDigest,
    sbom_digest: build.sbomDigest,
    skills: skills.map((skill) => librarySkillBundleLockEntry(skill, (id) => versions.get(id))),
  });
}

export type SkillErrorCode = z.infer<typeof skillErrorCodeSchema>;
export type BusinessSkillManifest = z.infer<typeof businessSkillManifestSchema>;
export type LibrarySkillManifest = z.infer<typeof librarySkillManifestSchema>;
export type PlatformSkillManifest = z.infer<typeof platformSkillManifestSchema>;
export type BusinessSkillEffects = z.infer<typeof businessSkillEffectsSchema>;
export type BusinessSkillDependencies = z.infer<typeof businessSkillDependenciesSchema>;
export type BusinessSkillStatus = z.infer<typeof businessSkillStatusSchema>;
export type BusinessSkillMaturity = z.infer<typeof businessSkillMaturitySchema>;
export type SkillInputV1 = z.infer<typeof skillInputV1Schema>;
export type SkillResultV1 = z.infer<typeof skillResultV1Schema>;
export type SkillResultStatus = z.infer<typeof skillResultStatusSchema>;
export type ContextEnvelopeV1 = z.infer<typeof contextEnvelopeV1Schema>;
export type SkillResolutionPolicy = z.infer<typeof skillResolutionPolicySchema>;
export type PlanSkillBinding = z.infer<typeof planSkillBindingSchema>;
export type PackageSkillBinding = z.infer<typeof packageSkillBindingSchema>;
export type SkillSelectionRecord = z.infer<typeof skillSelectionRecordSchema>;
export type BusinessSkillCatalog = z.infer<typeof businessSkillCatalogSchema>;
export type BusinessSkillCatalogEntry = z.infer<typeof businessSkillCatalogEntrySchema>;

export function isTransientSkillError(code: string | null | undefined): boolean {
  return (TRANSIENT_SKILL_ERROR_CODES as readonly string[]).includes(code ?? "");
}

/**
 * The pinned skill binding a node may invoke. Without `skillId`: the node's own skill
 * (`config.skillId`), or null for any other node. With `skillId`: that skill, when it is the
 * node's own skill or one of its agent loop's skills (`config.loop.skills`), otherwise null. A
 * named skill with no pinned binding throws.
 */
export function skillBindingForNode(plan: HarnessPlanV2, nodeId: string, skillId?: string): PlanSkillBinding | null {
  const node = plan.graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return null;
  const own = typeof node.config.skillId === "string" ? node.config.skillId : null;
  const wanted = skillId ?? own;
  if (wanted === null) return null;
  if (wanted !== own && !loopSkillIds(node.config).includes(wanted)) return null;
  const binding = (plan.skillBindings ?? []).find((item) => item.skillId === wanted);
  if (!binding) throw new Error(`skill.binding_missing:${nodeId}:${wanted}`);
  return binding;
}

/** Every skill binding a node may invoke: its own skill and its agent loop's skills. */
export function skillBindingsForNode(plan: HarnessPlanV2, nodeId: string): PlanSkillBinding[] {
  const node = plan.graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return [];
  const ids = [...(typeof node.config.skillId === "string" ? [node.config.skillId] : []), ...loopSkillIds(node.config)];
  return [...new Set(ids)].map((id) => skillBindingForNode(plan, nodeId, id)!);
}

/** The agent loop skill entry `skillId` of a node, or null. */
export function loopSkillForNode(plan: HarnessPlanV2, nodeId: string, skillId: string): AgentLoopSkill | null {
  const node = plan.graph.nodes.find((candidate) => candidate.id === nodeId);
  const loop = node?.config.loop;
  if (!loop || typeof loop !== "object") return null;
  const parsed = agentLoopConfigSchema.safeParse(loop);
  return parsed.success ? parsed.data.skills.find((skill) => skill.skillId === skillId) ?? null : null;
}

function loopSkillIds(config: Record<string, unknown>): string[] {
  const loop = config.loop as { skills?: unknown } | undefined;
  if (!loop || !Array.isArray(loop.skills)) return [];
  return loop.skills.flatMap((skill) => (skill && typeof skill === "object" && typeof (skill as { skillId?: unknown }).skillId === "string" ? [(skill as { skillId: string }).skillId] : []));
}

/**
 * The agent profile a node runs as (`config.agentRef`), or null for a node without one.
 * Fails closed on a dangling reference, a version mismatch, or a retired `skillRefs`.
 */
/**
 * What an `agent.qualification.v1` record must match in an admitted plan: the profile's digest and
 * version, its model profile and the revision digest the plan pinned, and the exact tools its loop
 * nodes may call. A qualification for any other plan, profile, model or tool set qualifies nothing.
 */
export function agentQualificationTarget(plan: HarnessPlanV2, agentProfileId: string): {
  agentProfileVersion: string; agentProfileDigest: string; modelProfileId: string; modelProfileDigest: string | null; tools: string[]; planDigest: string;
} {
  const profile = plan.agentProfiles.find((candidate) => candidate.id === agentProfileId);
  if (!profile) throw new Error(`agent_qualification.profile_missing:${agentProfileId}`);
  const tools = new Set<string>();
  for (const node of plan.graph.nodes) {
    if (node.config.agentRef !== agentProfileId) continue;
    const loop = node.config.loop as { tools?: unknown } | undefined;
    for (const tool of Array.isArray(loop?.tools) ? loop.tools : []) if (typeof tool === "string") tools.add(tool);
    // The business skills its loops may choose to run are part of what an agent can do, too.
    for (const skillId of loopSkillIds(node.config)) tools.add(`skill:${skillId}`);
  }
  const model = plan.modelProfiles.find((candidate) => candidate.id === profile.modelProfileId);
  return {
    agentProfileVersion: profile.version, agentProfileDigest: stableDigest(profile), modelProfileId: profile.modelProfileId,
    modelProfileDigest: model?.digest ?? null, tools: [...tools].sort(), planDigest: plan.planDigest,
  };
}

/** Mismatch codes between a qualification and the plan it claims to qualify; empty when it applies. */
export function agentQualificationMismatches(plan: HarnessPlanV2, qualification: AgentQualification): string[] {
  let target: ReturnType<typeof agentQualificationTarget>;
  try {
    target = agentQualificationTarget(plan, qualification.agentProfileId);
  } catch {
    return ["agent_qualification.profile_missing"];
  }
  const out: string[] = [];
  if (qualification.planDigest !== target.planDigest) out.push("agent_qualification.plan_mismatch");
  if (qualification.agentProfileVersion !== target.agentProfileVersion) out.push("agent_qualification.profile_version_mismatch");
  if (qualification.agentProfileDigest !== target.agentProfileDigest) out.push("agent_qualification.profile_digest_mismatch");
  if (qualification.modelProfileId !== target.modelProfileId || qualification.modelProfileDigest !== target.modelProfileDigest) out.push("agent_qualification.model_mismatch");
  if (JSON.stringify(qualification.tools) !== JSON.stringify(target.tools)) out.push("agent_qualification.tools_mismatch");
  return out;
}

export function agentProfileForNode(plan: HarnessPlanV2, nodeId: string): AgentProfile | null {
  const node = plan.graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`agent_profile.node_missing:${nodeId}`);
  if (node.config.skillRefs !== undefined) throw new Error(`agent_profile.skill_refs_retired:${nodeId}`);
  const agentRef = node.config.agentRef;
  if (agentRef === undefined) return null;
  if (typeof agentRef !== "string") throw new Error(`agent_profile.ref_invalid:${nodeId}`);
  const profile = plan.agentProfiles.find((candidate) => candidate.id === agentRef);
  if (!profile) throw new Error(`agent_profile.missing:${agentRef}`);
  if (node.config.agentVersion !== undefined && node.config.agentVersion !== profile.version) {
    throw new Error(`agent_profile.version_mismatch:${agentRef}`);
  }
  return profile;
}

/**
 * Check a selection record against the admitted plan: the node must be bound to that skill
 * version, and the candidate at `candidateIndex` must be the capability (and connector) the
 * request names. Returns the pinned candidate. Throws `skill.selection_*` otherwise.
 */
export function checkSkillSelection(
  plan: HarnessPlanV2,
  nodeId: string,
  capabilityId: string,
  selection: SkillSelectionRecord,
): PlanSkillBinding["candidates"][number] {
  const binding = skillBindingForNode(plan, nodeId, selection.skillId);
  if (!binding || binding.skillId !== selection.skillId) throw new Error("skill.selection_skill_mismatch");
  if (binding.semver !== selection.skillVersion) throw new Error("skill.selection_version_mismatch");
  const candidate = binding.candidates[selection.candidateIndex];
  if (!candidate || candidate.capabilityId !== capabilityId || selection.selectedCapabilityId !== capabilityId) {
    throw new Error("skill.selection_candidate_mismatch");
  }
  if (selection.selectedConnectorId !== undefined && selection.selectedConnectorId !== candidate.connectorId) {
    throw new Error("skill.selection_connector_mismatch");
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// skill.execution.v1: the platform ↔ skill host wire protocol
// (docs/implementation/skill-library-integration-contract.md §4, §6, §8). The gateway's
// `skills` adapter is the only platform caller; the reference host and the conformance
// suite (`@ehf/skill-conformance`) use the same schemas. Top-level objects are strict
// (unknown fields are INPUT_INVALID); `extensions` objects are free-form and ignored.
// ---------------------------------------------------------------------------

export const SKILL_EXECUTION_CONTRACT_VERSION = "skill.execution.v1" as const;
/** `sha256:<hex>` as the skill library writes digests. */
export const prefixedSha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/, "digest.sha256_prefixed_required");
const extensionsSchema = z.record(z.string(), z.unknown());

export const skillSectionKindSchema = z.enum(["case", "evidence", "policy", "upstream", "observation"]);
export const skillSectionTrustSchema = z.enum(["TRUSTED_DATA", "UNTRUSTED_DATA", "UNTRUSTED_EXTERNAL"]);
/** `skill_id@semver`, e.g. `entity.identifiers.validate@0.2.0`. */
export const skillVersionRefSchema = z.string().max(200).regex(/^[a-z][a-z_]*(\.[a-z][a-z0-9_]*)+@(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/);

/** One assembled context section (§4.1 `context.sections[]`). `value` is data, never instructions. */
export const skillContextSectionSchema = z.object({
  id: z.string().min(1).max(128),
  kind: skillSectionKindSchema,
  trust: skillSectionTrustSchema,
  classification: nonEmptyText,
  purpose: nonEmptyText,
  provenance_ref: nonEmptyText,
  content_digest: prefixedSha256Schema,
  quarantined: z.boolean(),
  value: z.unknown(),
}).strict();

export const skillContextMissingSchema = z.object({
  selector: z.string().min(1).max(128),
  code: z.enum(["CONTEXT_MISSING", "CONTEXT_STALE"]),
  required: z.boolean(),
}).strict();

export const skillExecutionContextSchema = z.object({
  envelope: contextEnvelopeV1Schema,
  /** = context manifest digest; the replay key. */
  context_hash: sha256DigestSchema,
  sections: z.array(skillContextSectionSchema).max(256),
  missing: z.array(skillContextMissingSchema).max(256).default([]),
}).strict().superRefine((context, ctx) => {
  const ids = context.sections.map((section) => section.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["sections"], message: "skill_context.section_duplicate" });
});

export const skillExecutionCallbackSchema = z.object({
  gateway_url: z.string().url(),
  delegated_envelope: z.string().min(1).max(16_384),
  expires_at: z.string().datetime({ offset: true }),
  permitted_capabilities: z.array(z.string().min(1).max(200)).max(64),
  permitted_skills: z.array(skillVersionRefSchema).max(64),
}).strict();

export const skillExecutionLimitsSchema = z.object({
  deadline_at: z.string().datetime({ offset: true }),
  max_capability_calls: z.number().int().nonnegative(),
  max_model_calls: z.number().int().nonnegative(),
  cost_ceiling_usd: z.number().nonnegative(),
}).strict();

/** §4.1 SkillExecutionRequest.v1 (`POST /v1/skills/{skill_id}/executions`). */
export const skillExecutionRequestV1Schema = z.object({
  contract_version: z.literal(SKILL_EXECUTION_CONTRACT_VERSION),
  /** = the gateway invocation id; stable across retries and the host's idempotency key. */
  execution_id: z.string().min(1).max(256),
  skill_id: businessSkillIdSchema,
  skill_version: semverSchema,
  bundle_digest: prefixedSha256Schema,
  input: skillInputV1Schema,
  context: skillExecutionContextSchema,
  callback: skillExecutionCallbackSchema,
  limits: skillExecutionLimitsSchema,
  extensions: extensionsSchema.default({}),
}).strict();

/** A proposed record's evidence: a provided section digest, or a gateway receipt of this execution. */
export const skillEvidenceRefSchema = z.union([
  z.object({
    section_id: z.string().min(1).max(128),
    content_digest: prefixedSha256Schema,
    span: z.unknown().optional(),
  }).strict(),
  z.object({
    receipt_digest: sha256DigestSchema,
    path: z.string().min(1).max(500).optional(),
  }).strict(),
]);

/**
 * §6.2 record types. `CanonicalRecord` (contract amendment): an ontology record whose `body` is
 * `skillCanonicalRecordBodySchema`, committed with `RecordCanonicalRecords`. Every body is
 * checked by `skillProposedRecordIssue`.
 */
export const skillRecordTypeSchema = z.enum(["Assertion", "Finding", "Hypothesis", "RiskIndicator", "Conflict", "UnresolvedQuestion", "Fact", "CanonicalRecord"]);

/** §6.2: a record the platform may commit as a case-store proposal; never applied by the host. */
export const skillProposedRecordSchema = z.object({
  record_type: skillRecordTypeSchema,
  local_ref: z.string().min(1).max(128),
  body: jsonObject,
  evidence: z.array(skillEvidenceRefSchema).max(64),
}).strict();

/** §6.3 `requested_effects[]`: a case command or an external action the platform may route. */
export const skillRequestedEffectSchema = z.object({
  type: z.enum(["case_command", "external_action"]),
  command_type: businessCommandTypeSchema.optional(),
  action: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/).optional(),
  idempotency_key: z.string().min(1).max(256),
  payload: jsonObject,
  justification_refs: z.array(z.string().min(1).max(128)).max(64).default([]),
}).strict().superRefine((effect, ctx) => {
  if (effect.type === "case_command" && (!effect.command_type || effect.action)) {
    ctx.addIssue({ code: "custom", path: ["command_type"], message: "skill_effect.case_command_requires_command_type" });
  }
  if (effect.type === "external_action" && (!effect.action || effect.command_type)) {
    ctx.addIssue({ code: "custom", path: ["action"], message: "skill_effect.external_action_requires_action" });
  }
});

export const skillUnresolvedItemSchema = z.object({
  code: nonEmptyText,
  subject_ref: z.string(),
  explanation: nonEmptyText,
}).strict();

export const skillNegativeSearchSchema = z.object({
  capability: z.string().min(1).max(200),
  query: z.unknown(),
  coverage: nonEmptyText,
  as_of: z.string().datetime({ offset: true }),
  limitations: z.string().max(2_000).nullable().optional(),
}).strict();

/** §4.2 `computation`: what the skill found. Nothing in it is authoritative until the platform commits it. */
export const skillComputationSchema = z.object({
  business_status: skillResultStatusSchema,
  payload: z.unknown(),
  proposed_records: z.array(skillProposedRecordSchema).max(256).default([]),
  unresolved_items: z.array(skillUnresolvedItemSchema).max(256).default([]),
  negative_searches: z.array(skillNegativeSearchSchema).max(256).default([]),
  requested_effects: z.array(skillRequestedEffectSchema).max(64).default([]),
  metrics: z.object({
    duration_ms: z.number().int().nonnegative(),
    capability_calls: z.number().int().nonnegative(),
    model_calls: z.number().int().nonnegative(),
  }).strict(),
}).strict();

export const skillExecutionLifecycleSchema = z.enum(["COMPLETED_EXECUTION", "FAILED_EXECUTION", "RUNNING", "CANCELLED"]);

export const skillExecutionErrorSchema = z.object({
  code: skillErrorCodeSchema,
  retryable: z.boolean(),
  detail_ref: z.string().min(1).max(500).nullable().default(null),
}).strict().superRefine((error, ctx) => {
  if (error.retryable && !isTransientSkillError(error.code)) {
    ctx.addIssue({ code: "custom", path: ["retryable"], message: "skill_execution.retryable_only_for_transient_codes" });
  }
});

export const skillExecutionTraceSchema = z.object({
  instructions_digest: prefixedSha256Schema.nullable().optional(),
  code_digest: prefixedSha256Schema.nullable().optional(),
  subskill_executions: z.array(jsonObject).max(64).default([]),
}).strict();

/** §4.2 SkillExecutionResponse.v1 (200 body, and every status read). */
export const skillExecutionResponseV1Schema = z.object({
  contract_version: z.literal(SKILL_EXECUTION_CONTRACT_VERSION),
  execution_id: z.string().min(1).max(256),
  lifecycle: skillExecutionLifecycleSchema,
  computation: skillComputationSchema.nullable().default(null),
  error: skillExecutionErrorSchema.nullable().default(null),
  trace: skillExecutionTraceSchema,
  extensions: extensionsSchema.optional(),
}).strict().superRefine((response, ctx) => {
  if (response.lifecycle === "COMPLETED_EXECUTION" && (!response.computation || response.error)) {
    ctx.addIssue({ code: "custom", path: ["computation"], message: "skill_execution.completed_requires_computation" });
  }
  if (response.lifecycle === "FAILED_EXECUTION" && (!response.error || response.computation)) {
    ctx.addIssue({ code: "custom", path: ["error"], message: "skill_execution.failed_requires_error" });
  }
  if ((response.lifecycle === "RUNNING" || response.lifecycle === "CANCELLED") && response.computation) {
    ctx.addIssue({ code: "custom", path: ["computation"], message: "skill_execution.computation_only_when_completed" });
  }
});

/** §4.2 202 body. */
export const skillExecutionAcceptedSchema = z.object({
  execution_id: z.string().min(1).max(256),
  status: z.literal("RUNNING"),
}).strict();

/** Error body of a non-2xx host answer (§10): `{ "error": { "code": <spec §4.3 code>, … } }`. */
export const skillHostErrorBodySchema = z.object({
  error: z.object({ code: skillErrorCodeSchema }).passthrough(),
}).passthrough();

export const skillBundleLockEntrySchema = z.object({
  id: businessSkillIdSchema,
  version: semverSchema,
  maturity: businessSkillMaturitySchema,
  manifest_digest: prefixedSha256Schema,
  instructions_digest: prefixedSha256Schema.nullable().optional(),
  code_digest: prefixedSha256Schema.nullable().optional(),
  input_schema_digest: prefixedSha256Schema,
  output_schema_digest: prefixedSha256Schema,
  dependencies: z.object({
    capabilities: z.array(z.string().min(1).max(200)).max(64).default([]),
    /** Sub-skills as `skill_id@semver`, pinned by this lock. */
    skills: z.array(skillVersionRefSchema).max(64).default([]),
  }).strict(),
  effects: skillEffectModeSchema,
  evaluation_report_digest: prefixedSha256Schema.nullable().optional(),
  extensions: extensionsSchema.optional(),
}).strict();

/** §8 bundle lock (`bundle.lock.json`, served at `GET /v1/bundle`). */
export const skillBundleLockSchema = z.object({
  bundle_id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,127}$/),
  bundle_version: semverSchema,
  bundle_digest: prefixedSha256Schema,
  image_digest: prefixedSha256Schema,
  python: z.string().min(1).max(64).optional(),
  skills: z.array(skillBundleLockEntrySchema).min(1).max(1_000),
  sbom_digest: prefixedSha256Schema,
  extensions: extensionsSchema.optional(),
}).strict().superRefine((lock, ctx) => {
  const keys = lock.skills.map((skill) => `${skill.id}@${skill.version}`);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: ["skills"], message: "skill_bundle.skill_duplicate" });
});

/**
 * The capability input a runtime sends to a `skills:<skill_id>` capability through
 * `POST /v1/invoke`: SkillInput.v1 plus the context the context plane assembled. The gateway
 * adds identity, pins, callback and limits; nothing else in the request comes from the runtime.
 */
export const skillCapabilityInputV1Schema = z.object({
  input: skillInputV1Schema,
  context: skillExecutionContextSchema,
  extensions: extensionsSchema.optional(),
}).strict();

/**
 * What a `skills:` capability returns to the runtime as `CapabilityResult.output`: the
 * validated host response plus the pins it ran under. `FAILED_EXECUTION` and `CANCELLED` are
 * results (the execution ran), not gateway failures; transport, pinning and integrity
 * problems are gateway failures (`adapter.skills_*`).
 */
export const skillCapabilityOutputV1Schema = z.object({
  contract_version: z.literal(SKILL_EXECUTION_CONTRACT_VERSION),
  execution_id: z.string().min(1),
  skill_id: businessSkillIdSchema,
  skill_version: semverSchema,
  bundle_digest: prefixedSha256Schema,
  manifest_digest: z.string().regex(/^[a-f0-9]{64}$/),
  effect_mode: skillEffectModeSchema,
  lifecycle: skillExecutionLifecycleSchema,
  computation: skillComputationSchema.nullable(),
  error: skillExecutionErrorSchema.nullable(),
  trace: skillExecutionTraceSchema,
  /** Receipt digests of the delegated dependency calls this execution made through the gateway. */
  dependency_receipts: z.array(z.string().regex(/^[a-f0-9]{64}$/)),
  /** Exact approved qualification evidence selected by the production gateway. */
  qualification_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

/** Broker request for a delegated envelope (`POST /v1/runtime/envelopes/delegate`, parent in `x-execution-envelope`). */
export const delegatedEnvelopeRequestSchema = z.object({
  skillId: businessSkillIdSchema,
  skillVersion: semverSchema,
  capabilities: z.array(z.string().min(1).max(200)).max(64),
  deadlineAt: z.string().datetime({ offset: true }),
}).strict();

export type SkillEffectMode = z.infer<typeof skillEffectModeSchema>;
export type SkillContextSection = z.infer<typeof skillContextSectionSchema>;
export type SkillExecutionContext = z.infer<typeof skillExecutionContextSchema>;
export type SkillExecutionRequestV1 = z.infer<typeof skillExecutionRequestV1Schema>;
export type SkillExecutionResponseV1 = z.infer<typeof skillExecutionResponseV1Schema>;
export type SkillComputation = z.infer<typeof skillComputationSchema>;
export type SkillProposedRecord = z.infer<typeof skillProposedRecordSchema>;
export type SkillRequestedEffect = z.infer<typeof skillRequestedEffectSchema>;
export type SkillEvidenceRef = z.infer<typeof skillEvidenceRefSchema>;
export type SkillBundleLock = z.infer<typeof skillBundleLockSchema>;
export type SkillBundleLockEntry = z.infer<typeof skillBundleLockEntrySchema>;
export type SkillCapabilityInputV1 = z.infer<typeof skillCapabilityInputV1Schema>;
export type SkillCapabilityOutputV1 = z.infer<typeof skillCapabilityOutputV1Schema>;
export type DelegatedEnvelopeRequest = z.infer<typeof delegatedEnvelopeRequestSchema>;

/** The `delegated_to` claim of a delegated envelope. */
export function delegatedSkillAudience(skillId: string, skillVersion: string): string {
  return `skills:${businessSkillIdSchema.parse(skillId)}@${semverSchema.parse(skillVersion)}`;
}

/** The adapter-binding prefix of a skill-hosted capability: `skills:<skill_id>`. */
export const SKILL_ADAPTER_PREFIX = "skills:";

/**
 * Digest of a bundle lock's exact content (canonical JSON). The artifact registry entry for a
 * `skill-bundle` names it in its reference, so an approved `bundle_digest` cannot be served
 * with a different skill list.
 */
export function skillBundleLockDigest(lock: SkillBundleLock): string {
  return stableDigest(lock);
}

/** `skill-bundle:<bundle_id>@<bundle_version>;lock=<lock digest>`, the registry reference of a bundle. */
export function skillBundleRegistryReference(lock: SkillBundleLock): string {
  return `skill-bundle:${lock.bundle_id}@${lock.bundle_version};lock=${skillBundleLockDigest(lock)}`;
}

export function lockDigestFromRegistryReference(reference: string): string | null {
  const match = /;lock=([a-f0-9]{64})$/.exec(reference);
  return match ? match[1]! : null;
}

/** Whether an invocation id is one of a skill execution's delegated dependency calls (`<execution_id>:<key>`). */
export function isDelegatedInvocationId(executionId: string, invocationId: string): boolean {
  if (!invocationId.startsWith(`${executionId}:`)) return false;
  return /^[A-Za-z0-9._~-]{1,128}$/.test(invocationId.slice(executionId.length + 1));
}

// ===========================================================================
// Canonical records (case store) — append-only block.
//
// Typed business records (RegistryRecord, WatchlistEntry, OwnershipInterest, …) that the
// financial-crime skill library reasons over, aligned to its `Record` schema
// (schemas/runtime/Record.schema.json). Platform connectors acquire data; normalizers turn
// provider results into these records; the case store keeps immutable versions; the context
// plane selects them per skill requirement. See docs/implementation/canonical-records.md.
//
// Field names follow the library. Deliberate differences:
// - `id` is `object_id` (the library's own `Ref` vocabulary), so a record and a reference to
//   it use the same key;
// - `case_id` and `provenance` are platform additions (a record belongs to one case and
//   says how it was produced);
// - `recorded_at` and `record_digest` are assigned by the case store, never by the caller:
//   recorded time is the store's transaction time.
// Outside this block: `RecordCanonicalRecords` in `businessCommandTypeSchema` and the optional
// `record` requirement on `caseReadGrantSchema` (both additive).
// ===========================================================================

export const CANONICAL_RECORD_OBJECT_TYPE_PATTERN = /^[A-Z][A-Za-z0-9]{0,63}$/;
/** Context selector path prefix for canonical records: `records.<ObjectType>`. */
export const CANONICAL_RECORD_PATH_PREFIX = "records.";
const recordText = z.string().min(1).max(512);
const recordTimestamp = z.string().datetime({ offset: true });

/** A library `Ref`: an exact, versioned reference to a source object (or a platform receipt). */
export const canonicalRecordRefSchema = z.object({
  tenant_id: recordText,
  object_type: z.string().min(1).max(64),
  object_id: recordText,
  version_id: recordText,
  schema_version: z.string().min(1).max(32).optional(),
}).strict();

export const canonicalRecordProvenanceSchema = z.object({
  /** `agent_proposal`: an agent's review proposed it (never adopted; a gate adopts, policy plan F10). */
  method: z.enum(["connector_normalizer", "skill_proposal", "agent_proposal", "platform", "manual_entry", "applicant_supplied"]),
  /** `<family>@<version>` of the normalizer, e.g. `wiring.business@1`. */
  normalizer: z.string().min(1).max(128).optional(),
  capability_id: z.string().min(1).max(200).optional(),
  connector_id: z.string().min(1).max(200).optional(),
  /** Gateway invocation id: names the receipt that carried the provider result. */
  invocation_id: z.string().min(1).max(512).optional(),
  source_decision_id: z.string().min(1).max(200).optional(),
  provider_check_id: z.string().min(1).max(512).optional(),
  execution_mode: z.string().min(1).max(64).optional(),
  /** `agent_proposal` records: the agent profile whose review proposed the record. */
  agent_id: z.string().min(1).max(128).optional(),
  /** `skill_proposal` records: the skill execution that proposed the record (skill.execution.v1 §6.2). */
  skill_id: z.string().min(1).max(128).optional(),
  skill_version: z.string().min(1).max(64).optional(),
  /** The skill execution id (the gateway invocation id; the host's `execution_id`). */
  execution_id: z.string().min(1).max(512).optional(),
  /** The gateway receipt digest of the skill execution. */
  receipt_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  manifest_digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

const canonicalRecordFields = {
  schema_version: z.string().min(1).max(32).optional(),
  object_type: z.string().regex(CANONICAL_RECORD_OBJECT_TYPE_PATTERN),
  object_id: z.string().min(1).max(256),
  version_id: z.string().min(1).max(128),
  data: z.record(z.string(), z.unknown()),
  subject_ids: z.array(z.string().min(1).max(256)).max(64).optional(),
  valid_from: recordTimestamp.nullable().optional(),
  valid_to: recordTimestamp.nullable().optional(),
  observed_at: recordTimestamp,
  source_refs: z.array(canonicalRecordRefSchema).max(64),
  provenance: canonicalRecordProvenanceSchema,
  classification: z.string().min(1).max(64),
  purposes: z.array(z.string().min(1).max(64)).max(16).optional(),
  synthetic: z.boolean(),
  /** The version this one replaces. Omitted: the store chains to the current latest version. */
  supersedes: z.string().min(1).max(128).nullable().optional(),
};

function validRecordInterval(record: { valid_from?: string | null | undefined; valid_to?: string | null | undefined }, ctx: z.RefinementCtx) {
  if (record.valid_from && record.valid_to && Date.parse(record.valid_from) >= Date.parse(record.valid_to)) {
    ctx.addIssue({ code: "custom", path: ["valid_to"], message: "canonical_record.valid_interval_invalid" });
  }
}

/** A record as submitted in `RecordCanonicalRecords` (tenant and case default to the command's). */
export const canonicalRecordInputSchema = z.object({
  ...canonicalRecordFields,
  tenant_id: z.string().min(1).max(200).optional(),
  case_id: z.string().min(1).max(200).optional(),
}).strict().superRefine(validRecordInterval);

/** A stored, immutable record version. */
export const canonicalRecordSchema = z.object({
  ...canonicalRecordFields,
  tenant_id: z.string().min(1).max(200),
  case_id: z.string().min(1).max(200),
  supersedes: z.string().min(1).max(128).nullable(),
  recorded_at: recordTimestamp,
  /** sha256 over the record without `recorded_at` and `record_digest`: the identity of a version. */
  record_digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine(validRecordInterval);

/** Payload of the `RecordCanonicalRecords` business command. */
export const recordCanonicalRecordsPayloadSchema = z.object({
  records: z.array(canonicalRecordInputSchema).min(1).max(200),
  /** Case evidence (e.g. the captured provider output) the records were normalized from. */
  evidenceRefs: z.array(z.string().min(1)).max(16).optional(),
}).strict();

/** The library's `Requirement` (schemas/runtime/Requirement.schema.json), field names unchanged. */
export const canonicalRecordRequirementSchema = z.object({
  object_type: z.string().regex(CANONICAL_RECORD_OBJECT_TYPE_PATTERN),
  fields: z.array(z.string().min(1)).min(1),
  nullable_fields: z.array(z.string().min(1)).default([]),
  min_count: z.number().int().nonnegative().default(1),
  max_age_seconds: z.number().int().nonnegative().nullable().default(null),
  optional: z.boolean().default(false),
  model_visible: z.boolean().default(true),
}).strict();

export type CanonicalRecordRef = z.infer<typeof canonicalRecordRefSchema>;
export type CanonicalRecordProvenance = z.infer<typeof canonicalRecordProvenanceSchema>;
export type CanonicalRecordInput = z.infer<typeof canonicalRecordInputSchema>;
export type CanonicalRecord = z.infer<typeof canonicalRecordSchema>;
export type CanonicalRecordRequirement = z.infer<typeof canonicalRecordRequirementSchema>;
export type CaseReadRecordRequirement = NonNullable<CaseReadGrant["record"]>;

/** Digest of a record version's content (everything except `recorded_at` and `record_digest`). */
export function canonicalRecordDigest(record: Record<string, unknown>): string {
  const { recorded_at: _recordedAt, record_digest: _digest, ...content } = record;
  return stableDigest(content);
}

/** The record object type a selector reads (`path: records.<ObjectType>`), or null for any other selector. */
export function canonicalRecordObjectType(selector: Pick<CaseReadGrant, "path" | "record">): string | null {
  if (selector.record) return selector.record.objectType;
  if (!selector.path.startsWith(CANONICAL_RECORD_PATH_PREFIX)) return null;
  const objectType = selector.path.slice(CANONICAL_RECORD_PATH_PREFIX.length);
  return CANONICAL_RECORD_OBJECT_TYPE_PATTERN.test(objectType) ? objectType : null;
}

/** A selector's record requirement (platform form) from a library requirement. */
export function recordSelectorRequirement(requirement: z.input<typeof canonicalRecordRequirementSchema>): CaseReadRecordRequirement {
  const parsed = canonicalRecordRequirementSchema.parse(requirement);
  return { objectType: parsed.object_type, fields: [...parsed.fields], ...(parsed.nullable_fields.length ? { nullableFields: [...parsed.nullable_fields] } : {}),
    minCount: parsed.min_count, maxAgeSeconds: parsed.max_age_seconds };
}

// ===========================================================================
// Skill output commit path (skill.execution.v1 §6.2–6.3) — append-only block.
//
// What a hosted skill returns becomes case state only through the platform: the runtime maps a
// gateway-validated computation to case commands and submits them, with the node's execution
// envelope, to the case API's skill-commit endpoint, which applies them atomically. Effects of an
// approval-required skill are held until the durable approval after the skill, then released (or
// discarded) by the release node. See docs/implementation/canonical-records.md and the
// integration contract §6.
// ===========================================================================

const skillRecordRef = z.string().min(1).max(512);

/**
 * `CanonicalRecord` body: a canonical record without the fields the platform sets (tenant, case,
 * provenance, recorded time, digest). `synthetic` must be true while the skill is
 * `implemented_synthetic`; the object type must be one the manifest says it produces, when it says.
 */
export const skillCanonicalRecordBodySchema = z.object({
  object_type: z.string().regex(CANONICAL_RECORD_OBJECT_TYPE_PATTERN),
  object_id: z.string().min(1).max(256),
  version_id: z.string().min(1).max(128),
  schema_version: z.string().min(1).max(32).optional(),
  data: z.record(z.string(), z.unknown()),
  subject_ids: z.array(z.string().min(1).max(256)).max(64).optional(),
  valid_from: z.string().datetime({ offset: true }).nullable().optional(),
  valid_to: z.string().datetime({ offset: true }).nullable().optional(),
  observed_at: z.string().datetime({ offset: true }),
  source_refs: z.array(canonicalRecordRefSchema).max(64),
  classification: z.string().min(1).max(64),
  purposes: z.array(z.string().min(1).max(64)).max(16).optional(),
  synthetic: z.boolean(),
  supersedes: z.string().min(1).max(128).nullable().optional(),
}).strict().superRefine(validRecordInterval);

/** `Assertion` body → `ProposeClaim` (claim status PROPOSED, i.e. pending review). */
export const skillAssertionBodySchema = z.object({
  subject_ref: skillRecordRef.optional(),
  predicate: z.string().min(1).max(200),
  value: z.unknown(),
  confidence: z.number().min(0).max(1).optional(),
}).strict();

/** `Fact` body → `ProposeClaim` with verification criteria; a fact only through `AcceptClaimAsFact`. */
export const skillFactBodySchema = z.object({
  subject_ref: skillRecordRef.optional(),
  predicate: z.string().min(1).max(200),
  value: z.unknown(),
  confidence: z.number().min(0).max(1).optional(),
  verification_criteria: z.array(z.string().min(1).max(500)).min(1).max(32),
}).strict();

/** `Finding` / `RiskIndicator` body → `RecordScreeningFinding`. */
export const skillFindingBodySchema = z.object({
  finding_type: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/),
  subject_ref: skillRecordRef.optional(),
  reason: z.string().min(1).max(4_000),
  confidence: z.number().min(0).max(1).optional(),
  uncertainty: z.string().min(1).max(2_000).optional(),
  policy_relevance: z.string().min(1).max(200).optional(),
}).strict();

/** `Conflict` body → `RaiseContradiction` (an open contradiction). */
export const skillConflictBodySchema = z.object({
  object_refs: z.array(skillRecordRef).min(2).max(32),
  description: z.string().min(1).max(4_000),
  materiality: z.enum(["LOW", "MEDIUM", "HIGH", "MATERIAL"]),
  detection_method: z.string().min(1).max(200).optional(),
}).strict();

/** `UnresolvedQuestion` body → `ProposeWorkItem` (a work item for an analyst). */
export const skillUnresolvedQuestionBodySchema = z.object({
  question: z.string().min(1).max(4_000),
  work_type: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/).optional(),
  priority: z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]).optional(),
  due_at: z.string().datetime({ offset: true }).optional(),
  required_capability: z.string().min(1).max(200).optional(),
  /** The record the question is about (a document route conflict names its extracted assertion). */
  subject_ref: skillRecordRef.optional(),
}).strict();

/** `Hypothesis`: never committed (not case state); recorded as uncommitted in the commit event. */
export const skillHypothesisBodySchema = z.record(z.string(), z.unknown());

type SkillRecordType = z.infer<typeof skillRecordTypeSchema>;
type BusinessCommandName = z.infer<typeof businessCommandTypeSchema>;

/** §6.2 mapping: the case command each record type becomes; null = not committed. */
export const SKILL_RECORD_COMMANDS: Readonly<Record<SkillRecordType, BusinessCommandName | null>> = {
  Assertion: "ProposeClaim",
  Fact: "ProposeClaim",
  Finding: "RecordScreeningFinding",
  RiskIndicator: "RecordScreeningFinding",
  Conflict: "RaiseContradiction",
  UnresolvedQuestion: "ProposeWorkItem",
  CanonicalRecord: "RecordCanonicalRecords",
  Hypothesis: null,
};

const SKILL_RECORD_BODIES: Readonly<Record<SkillRecordType, z.ZodType>> = {
  Assertion: skillAssertionBodySchema,
  Fact: skillFactBodySchema,
  Finding: skillFindingBodySchema,
  RiskIndicator: skillFindingBodySchema,
  Conflict: skillConflictBodySchema,
  UnresolvedQuestion: skillUnresolvedQuestionBodySchema,
  CanonicalRecord: skillCanonicalRecordBodySchema,
  Hypothesis: skillHypothesisBodySchema,
};

/**
 * Why a proposed record cannot be committed, or null. `record_body_invalid`: the body is not the
 * record type's shape; `record_object_type_not_declared`: a `CanonicalRecord` of a type the
 * manifest does not say it produces; `record_synthetic_required`: a `CanonicalRecord` of an
 * `implemented_synthetic` skill that does not say `synthetic: true`.
 */
export function skillProposedRecordIssue(
  record: Pick<SkillProposedRecord, "record_type" | "body">,
  options: { produces?: readonly string[] | null; requireSynthetic?: boolean } = {},
): "record_body_invalid" | "record_object_type_not_declared" | "record_synthetic_required" | null {
  const parsed = SKILL_RECORD_BODIES[record.record_type].safeParse(record.body);
  if (!parsed.success) return "record_body_invalid";
  if (record.record_type === "CanonicalRecord") {
    const body = parsed.data as z.infer<typeof skillCanonicalRecordBodySchema>;
    if (options.produces && !options.produces.includes(body.object_type)) return "record_object_type_not_declared";
    if (options.requireSynthetic && body.synthetic !== true) return "record_synthetic_required";
  }
  return null;
}

/**
 * The grants a skill node needs for its pinned write authority: the §6.2 record commands for
 * any mode above read-only, the manifest's case commands as `effect` grants (committed when the
 * skill completes) or, when approval is required, as `held` grants (and `release` grants on the
 * node after the approval). Forbidden commands are never granted.
 */
export function skillGrantsFor(effects: z.infer<typeof planSkillEffectsSchema> | undefined): {
  proposal: BusinessCommandName[]; effect: BusinessCommandName[]; held: BusinessCommandName[];
} {
  if (!effects || effects.mode === "read_only") return { proposal: [], effect: [], held: [] };
  const commands = effects.mode === "proposal" ? [] : effects.caseCommands.filter((command) => !isSkillForbiddenCommand(command));
  return {
    proposal: [...SKILL_PROPOSAL_COMMANDS],
    effect: effects.approval === "required" ? [] : commands,
    held: effects.approval === "required" ? commands : [],
  };
}

/** What a commit and its held effects are bound to (CR-6): the execution and its hashes. */
export const skillExecutionBindingSchema = z.object({
  skillId: businessSkillIdSchema,
  skillVersion: semverSchema,
  /** The gateway invocation id of the skill execution (the host's `execution_id`). */
  executionId: z.string().min(1).max(256),
  manifestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  bundleDigest: prefixedSha256Schema,
  receiptDigest: z.string().regex(/^[a-f0-9]{64}$/),
  /** sha256 of the SkillCapabilityInput.v1 the runtime sent. */
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  contextHash: z.string().min(1).max(128),
  codeDigest: prefixedSha256Schema.nullable(),
  instructionsDigest: prefixedSha256Schema.nullable(),
}).strict();

export function skillExecutionBindingDigest(binding: z.infer<typeof skillExecutionBindingSchema>): string {
  return stableDigest(skillExecutionBindingSchema.parse(binding));
}

/** One case command of a skill commit: the evidence link, a mapped record, or an immediate effect. */
export const skillCommitCommandSchema = z.object({
  /** `evidence`, `record:<local_ref>` or `effect:<idempotency_key>`: the command's idempotency suffix. */
  localRef: z.string().regex(/^(evidence|record:\S{1,128}|effect:\S{1,256})$/),
  commandType: businessCommandTypeSchema,
  payload: z.record(z.string(), z.unknown()),
}).strict();

/** A requested effect held until approval (effects of approval-required skills; every external action). */
export const skillHeldEffectSchema = z.object({
  effectKey: z.string().min(1).max(256),
  type: z.enum(["case_command", "external_action"]),
  commandType: businessCommandTypeSchema.optional(),
  action: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/).optional(),
  payload: z.record(z.string(), z.unknown()),
  justificationRefs: z.array(z.string().min(1).max(128)).max(64),
  expiresAt: z.string().datetime({ offset: true }),
}).strict().superRefine((effect, ctx) => {
  if ((effect.type === "case_command") !== (effect.commandType !== undefined) || (effect.type === "external_action") !== (effect.action !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["type"], message: "skill_effect.shape_invalid" });
  }
});

/** `POST /v1/cases/{caseId}/skill-commits`: one node attempt's skill output, applied atomically. */
export const skillCommitRequestSchema = z.object({
  tenantId: z.string().min(1),
  caseId: z.string().min(1),
  binding: skillExecutionBindingSchema,
  effectMode: skillEffectModeSchema,
  approval: z.enum(["required", "none"]),
  /** Required when the commit carries effects: the case sequence the skill computed against. */
  expectedCaseSequence: z.number().int().nonnegative().optional(),
  commands: z.array(skillCommitCommandSchema).max(320),
  held: z.array(skillHeldEffectSchema).max(64),
  /** The node that may release the held effects (the node after the durable approval). */
  releaseNodeId: z.string().min(1).max(200).nullable(),
  approvalNodeId: z.string().min(1).max(200).nullable(),
  /** Proposed records the mapping does not commit (Hypothesis), for the audit event. */
  uncommitted: z.array(z.object({
    localRef: z.string().min(1).max(128), recordType: skillRecordTypeSchema, reason: z.string().min(1).max(200),
  }).strict()).max(256),
}).strict().superRefine((request, ctx) => {
  const refs = request.commands.map((command) => command.localRef);
  if (new Set(refs).size !== refs.length) ctx.addIssue({ code: "custom", path: ["commands"], message: "skill_commit.local_ref_duplicate" });
  const keys = request.held.map((effect) => effect.effectKey);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", path: ["held"], message: "skill_commit.effect_key_duplicate" });
  if (request.held.length && (!request.releaseNodeId || !request.approvalNodeId)) {
    ctx.addIssue({ code: "custom", path: ["releaseNodeId"], message: "skill_commit.release_node_required" });
  }
  if ((request.held.length || request.commands.some((command) => command.localRef.startsWith("effect:"))) && request.expectedCaseSequence === undefined) {
    ctx.addIssue({ code: "custom", path: ["expectedCaseSequence"], message: "skill_commit.expected_sequence_required" });
  }
});

/** The durable approval a release presents (normalized from the approval node's output). */
export const skillApprovalDecisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  authority: z.enum(["HUMAN", "HUMAN_CONFLICT_RESOLUTION"]),
  decisionIds: z.array(z.string().min(1).max(200)).min(1).max(16),
  reviewerPrincipalIds: z.array(z.string().min(1).max(320)).max(16),
  reasonCode: z.string().min(1).max(200).optional(),
}).strict();

/** `POST /v1/cases/{caseId}/skill-executions/{executionId}/release`, from the release node. */
export const skillEffectReleaseRequestSchema = z.object({
  tenantId: z.string().min(1),
  caseId: z.string().min(1),
  executionId: z.string().min(1).max(256),
  skillNodeId: z.string().min(1).max(200),
  approvalNodeId: z.string().min(1).max(200),
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  decision: skillApprovalDecisionSchema,
  /** External action ids the admitted plan publishes to an outbound route (`external_action.<id>`). */
  routedActions: z.array(z.string().min(1).max(200)).max(64),
}).strict();

/** The case event type an approved external action is published under (its outbound route). */
export function externalActionEventType(action: string): string {
  return `external_action.${action}`;
}

export type SkillCanonicalRecordBody = z.infer<typeof skillCanonicalRecordBodySchema>;
export type PlanSkillEffects = z.infer<typeof planSkillEffectsSchema>;
export type SkillCaseWriteGrant = z.infer<typeof skillCaseWriteGrantSchema>;
export type SkillExecutionBinding = z.infer<typeof skillExecutionBindingSchema>;
export type SkillCommitCommand = z.infer<typeof skillCommitCommandSchema>;
export type SkillHeldEffect = z.infer<typeof skillHeldEffectSchema>;
export type SkillCommitRequest = z.infer<typeof skillCommitRequestSchema>;
export type SkillApprovalDecision = z.infer<typeof skillApprovalDecisionSchema>;
export type SkillEffectReleaseRequest = z.infer<typeof skillEffectReleaseRequestSchema>;

export * from "./external-providers.js";
export * from "./external-bindings.js";

export * from "./intelligence.js";

export { DOCUMENT_CASE_WRITES, DOCUMENT_EXTRACTION_REVIEW, DOCUMENT_MODEL_CONNECTOR, DOCUMENT_WORK_TYPES, documentExtractionVariant, isDocumentExtractionPlan, type DocumentExtractionVariant } from "./document-extraction.js";

export { ContextSetupError, contextDatasetId, contextSourceFields } from "./context-setup.js";
export type { PostgresContextConnection, PostgresContextResource, ApiContextConnection, ApiContextResource, ContextCaseBinding, MappingExpression, ContextDefinition, ContextSetupConnection, ContextResourceBinding, CanonicalMapping, ContextAuthority, ContextDefinitionRevision, ContextMappingIssue, ContextCandidate, ContextSampleReport } from "./context-setup.js";

export * from "./application-context.js";
export * from "./application-intake.js";
export * from "./context-sources.js";

export * from "./case-traversal.js";

export * from "./workbench.js";

export * from "./draft-tests.js";

export { documentStudioRequestSchema, type DocumentStudioRequest } from "./document-studio.js";
export * from "./document-layout.js";
export * from "./document-model-fields.js";

export * from "./users.js";

export * from "./discovery.js";
