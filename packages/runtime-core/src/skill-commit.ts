import {
  externalActionEventType,
  isSkillForbiddenCommand,
  SKILL_RECORD_COMMANDS,
  skillApprovalDecisionSchema,
  skillCommitRequestSchema,
  skillGrantsFor,
  skillProposedRecordIssue,
  stableDigest,
  type HarnessPlanV2,
  type PlanSkillBinding,
  type SkillApprovalDecision,
  type SkillCanonicalRecordBody,
  type SkillCapabilityOutputV1,
  type SkillCommitCommand,
  type SkillCommitRequest,
  type SkillExecutionBinding,
  type SkillHeldEffect,
  type SkillProposedRecord,
} from "@ehf/contracts";

/**
 * The runtime half of the skill output commit path (skill.execution.v1 §6.2–6.3): pure mapping
 * from a gateway-validated `SkillCapabilityOutput.v1` to the case API's skill-commit request.
 * The I/O (evidence registration, the commit call, the release call) is in ./index.ts.
 *
 * | Record type | Command | Lands as |
 * | Assertion | ProposeClaim | claim, PROPOSED (pending review) |
 * | Fact | ProposeClaim, value `{ asserted, verificationCriteria }` | claim; a fact only via AcceptClaimAsFact |
 * | Finding, RiskIndicator | RecordScreeningFinding | finding citing the skill-computation evidence |
 * | Conflict | RaiseContradiction | open contradiction |
 * | UnresolvedQuestion | ProposeWorkItem | open work item (the question in its event) |
 * | CanonicalRecord | RecordCanonicalRecords | record version, provenance `skill_proposal` |
 * | Hypothesis | — | not committed; listed as uncommitted |
 *
 * Effects: a `case_command` of a skill without approval is committed with the records (with
 * optimistic concurrency on the case sequence the skill computed against); one of an
 * approval-required skill, and every `external_action`, is held for the release node.
 */

/** Default lifetime of a held effect when the skill names no `expires_at` (CR-6 binding). */
export const SKILL_HELD_EFFECT_TTL_MS = 7 * 86_400_000;
const SKILL_HELD_EFFECT_MAX_TTL_MS = 30 * 86_400_000;

export class SkillCommitError extends Error {
  constructor(readonly code: string) {
    super(`skill.commit_${code}`);
  }
}

export type SkillCommitPlanInput = {
  plan: HarnessPlanV2;
  nodeId: string;
  binding: PlanSkillBinding;
  output: SkillCapabilityOutputV1;
  tenantId: string;
  caseId: string;
  /** Gateway receipt digest of the skill execution. */
  receiptDigest: string;
  /** sha256 of the SkillCapabilityInput.v1 the runtime sent, and its context hash. */
  requestDigest: string;
  contextHash: string;
  /** Case sequence of the snapshot the skill read; required when the skill requested effects. */
  snapshotSequence: number | null;
  /** The registered skill-computation evidence the records cite; null when no record is committed. */
  evidenceId: string | null;
  now: number;
};

/** Whether the output carries anything the platform must commit or hold. */
export function skillOutputNeedsCommit(output: SkillCapabilityOutputV1): boolean {
  const computation = output.computation;
  return output.lifecycle === "COMPLETED_EXECUTION" && Boolean(computation)
    && (computation!.proposed_records.length > 0 || computation!.requested_effects.length > 0);
}

/** Whether any proposed record will become a case command (and so needs the evidence link). */
export function skillOutputCommitsRecords(output: SkillCapabilityOutputV1): boolean {
  return (output.computation?.proposed_records ?? []).some((record) => SKILL_RECORD_COMMANDS[record.record_type] !== null);
}

/** The release node the plan puts after the approval that follows `skillNodeId`, if any. */
export function skillReleaseNodeFor(plan: HarnessPlanV2, skillNodeId: string): { releaseNodeId: string; approvalNodeId: string } | null {
  for (const node of plan.graph.nodes) {
    const release = node.config.skillEffectRelease as { skillNodeId?: unknown; approvalNodeId?: unknown } | undefined;
    if (release && release.skillNodeId === skillNodeId && typeof release.approvalNodeId === "string") {
      return { releaseNodeId: node.id, approvalNodeId: release.approvalNodeId };
    }
  }
  return null;
}

function seed(executionId: string, ref: string): string {
  return stableDigest(`${executionId}:${ref}`).slice(0, 24);
}

function recordCommand(record: SkillProposedRecord, binding: SkillExecutionBinding, evidenceId: string): SkillCommitCommand | null {
  const commandType = SKILL_RECORD_COMMANDS[record.record_type];
  if (!commandType) return null;
  const body = record.body as Record<string, unknown>;
  const id = seed(binding.executionId, record.local_ref);
  const skill = `skill:${binding.skillId}@${binding.skillVersion}`;
  const localRef = `record:${record.local_ref}`;
  const optional = (key: string, value: unknown) => (value === undefined ? {} : { [key]: value });
  switch (record.record_type) {
    case "Assertion":
    case "Fact":
      return {
        localRef, commandType, payload: {
          claimId: `claim_skill_${id}`,
          ...optional("subjectRef", body.subject_ref),
          predicate: body.predicate,
          value: record.record_type === "Fact" ? { asserted: body.value ?? null, verificationCriteria: body.verification_criteria } : body.value ?? null,
          ...optional("confidence", typeof body.confidence === "number" ? { value: body.confidence, method: skill } : undefined),
          evidenceRefs: [evidenceId],
        },
      };
    case "Finding":
    case "RiskIndicator":
      return {
        localRef, commandType, payload: {
          findingId: `finding_skill_${id}`,
          findingType: body.finding_type,
          ...optional("subjectRef", body.subject_ref),
          reason: body.reason,
          ...optional("confidence", typeof body.confidence === "number" ? { value: body.confidence, method: skill } : undefined),
          ...optional("uncertainty", body.uncertainty),
          ...optional("policyRelevance", body.policy_relevance),
          evidenceRefs: [evidenceId],
          factRefs: [],
        },
      };
    case "Conflict":
      return {
        localRef, commandType, payload: {
          contradictionId: `contradiction_skill_${id}`,
          objectRefs: body.object_refs,
          description: body.description,
          materiality: body.materiality,
          detectionMethod: body.detection_method ?? skill,
        },
      };
    case "UnresolvedQuestion":
      return {
        localRef, commandType, payload: {
          workItemId: `work_skill_${id}`,
          workType: body.work_type ?? "SKILL_UNRESOLVED_QUESTION",
          description: body.question,
          ...optional("priority", body.priority),
          ...optional("dueAt", body.due_at),
          ...optional("requiredCapability", body.required_capability),
          ...optional("subjectRef", body.subject_ref),
        },
      };
    case "CanonicalRecord": {
      const canonical = body as SkillCanonicalRecordBody;
      return {
        localRef, commandType, payload: {
          records: [{
            ...canonical,
            provenance: {
              method: "skill_proposal",
              skill_id: binding.skillId,
              skill_version: binding.skillVersion,
              execution_id: binding.executionId,
              receipt_digest: binding.receiptDigest,
              manifest_digest: binding.manifestDigest,
              connector_id: `skills:${binding.skillId}`,
            },
          }],
          evidenceRefs: [evidenceId],
        },
      };
    }
    default:
      return null;
  }
}

function strippedPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const { expected_case_sequence: _sequence, expires_at: _expires, ...rest } = payload;
  return rest;
}

/**
 * The skill-commit request for one node attempt, or throws `SkillCommitError` (the node fails
 * closed): an output that does not match the plan's pin, a record the mapping cannot commit, an
 * effect the binding does not grant, an effect without a known case sequence, or a held effect
 * without a release node after the approval.
 */
export function planSkillCommit(input: SkillCommitPlanInput): SkillCommitRequest {
  const { output, binding: plan } = input;
  const computation = output.computation;
  if (output.lifecycle !== "COMPLETED_EXECUTION" || !computation) throw new SkillCommitError("not_completed");
  if (output.skill_id !== plan.skillId || output.skill_version !== plan.semver) throw new SkillCommitError("binding_mismatch");
  const effects = plan.effects;
  // The registry mode the gateway enforced must be the mode the plan pinned; anything else is stale.
  if (output.effect_mode !== (effects?.mode ?? "read_only")) throw new SkillCommitError("effect_mode_unpinned");
  const grants = skillGrantsFor(effects);
  const binding: SkillExecutionBinding = {
    skillId: output.skill_id,
    skillVersion: output.skill_version,
    executionId: output.execution_id,
    manifestDigest: output.manifest_digest,
    bundleDigest: output.bundle_digest,
    receiptDigest: input.receiptDigest.replace(/^sha256:/, ""),
    requestDigest: input.requestDigest,
    contextHash: input.contextHash,
    codeDigest: output.trace.code_digest ?? null,
    instructionsDigest: output.trace.instructions_digest ?? null,
  };
  const commands: SkillCommitCommand[] = [];
  const uncommitted: SkillCommitRequest["uncommitted"] = [];
  const records = computation.proposed_records;
  if (records.length && !grants.proposal.length) throw new SkillCommitError("records_not_granted");
  if (skillOutputCommitsRecords(output)) {
    if (!input.evidenceId) throw new SkillCommitError("evidence_missing");
    commands.push({ localRef: "evidence", commandType: "LinkEvidence", payload: { evidenceId: input.evidenceId, purpose: "SKILL_COMPUTATION" } });
  }
  for (const record of records) {
    // The gateway checked the bodies against the registry manifest; the commit checks again.
    if (skillProposedRecordIssue(record) === "record_body_invalid") throw new SkillCommitError(`record_body_invalid:${record.local_ref}`);
    const command = recordCommand(record, binding, input.evidenceId ?? "");
    if (command) commands.push(command);
    else uncommitted.push({ localRef: record.local_ref, recordType: record.record_type, reason: "record_type_not_committed" });
  }
  const held: SkillHeldEffect[] = [];
  const declaredSequences = new Set<number>();
  for (const effect of computation.requested_effects) {
    const declared = effect.payload.expected_case_sequence;
    if (declared !== undefined) {
      if (typeof declared !== "number" || !Number.isInteger(declared) || declared < 0) throw new SkillCommitError(`effect_case_sequence_invalid:${effect.idempotency_key}`);
      declaredSequences.add(declared);
    }
    if (effect.type === "case_command") {
      const commandType = effect.command_type!;
      if (isSkillForbiddenCommand(commandType)) throw new SkillCommitError(`effect_forbidden:${commandType}`);
      if (effects?.approval === "required") {
        if (!grants.held.includes(commandType)) throw new SkillCommitError(`effect_not_granted:${commandType}`);
      } else if (!grants.effect.includes(commandType)) {
        throw new SkillCommitError(`effect_not_granted:${commandType}`);
      } else {
        commands.push({ localRef: `effect:${effect.idempotency_key}`, commandType, payload: strippedPayload(effect.payload) });
        continue;
      }
    } else if (effects?.approval !== "required") {
      // An external action is always approval-gated (§6.3); without an approval there is no release.
      throw new SkillCommitError("external_action_requires_approval");
    }
    const requested = effect.payload.expires_at;
    let expiresAt = input.now + SKILL_HELD_EFFECT_TTL_MS;
    if (requested !== undefined) {
      const at = typeof requested === "string" ? Date.parse(requested) : Number.NaN;
      if (!Number.isFinite(at) || at <= input.now || at > input.now + SKILL_HELD_EFFECT_MAX_TTL_MS) throw new SkillCommitError(`effect_expiry_invalid:${effect.idempotency_key}`);
      expiresAt = at;
    }
    held.push({
      effectKey: effect.idempotency_key,
      type: effect.type,
      ...(effect.type === "case_command" ? { commandType: effect.command_type! } : { action: effect.action! }),
      payload: strippedPayload(effect.payload),
      justificationRefs: effect.justification_refs,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }
  const hasEffects = held.length > 0 || commands.some((command) => command.localRef.startsWith("effect:"));
  let expectedCaseSequence: number | undefined;
  if (hasEffects) {
    if (declaredSequences.size > 1) throw new SkillCommitError("effect_case_sequence_inconsistent");
    expectedCaseSequence = declaredSequences.size ? [...declaredSequences][0]! : input.snapshotSequence ?? undefined;
    if (expectedCaseSequence === undefined) throw new SkillCommitError("effect_case_sequence_unknown");
  }
  const release = held.length ? skillReleaseNodeFor(input.plan, input.nodeId) : null;
  if (held.length && !release) throw new SkillCommitError("release_node_missing");
  return skillCommitRequestSchema.parse({
    tenantId: input.tenantId,
    caseId: input.caseId,
    binding,
    effectMode: output.effect_mode,
    approval: effects?.approval ?? "none",
    ...(expectedCaseSequence !== undefined ? { expectedCaseSequence } : {}),
    commands,
    held,
    releaseNodeId: release?.releaseNodeId ?? null,
    approvalNodeId: release?.approvalNodeId ?? null,
    uncommitted,
  });
}

/**
 * The approval decision a release node presents, from the approval node's output: the durable
 * human work queue's (`decision`, `authority`, `decisionIds`, `reviewerPrincipalId(s)`) or the
 * local kernel's (`decisionId`, `principalId`). Anything else is refused.
 */
export function skillApprovalDecisionFrom(value: unknown): SkillApprovalDecision {
  const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const strings = (items: unknown) => (Array.isArray(items) ? items.filter((item): item is string => typeof item === "string" && item.length > 0) : []);
  const decisionIds = strings(record.decisionIds).length ? strings(record.decisionIds) : strings([record.decisionId, record.resolutionId]);
  const reviewers = strings(record.reviewerPrincipalIds).length
    ? strings(record.reviewerPrincipalIds)
    : strings([record.reviewerPrincipalId ?? record.principalId]);
  const parsed = skillApprovalDecisionSchema.safeParse({
    decision: record.decision,
    authority: record.authority,
    decisionIds,
    reviewerPrincipalIds: [...new Set(reviewers)],
    ...(typeof record.reasonCode === "string" && record.reasonCode ? { reasonCode: record.reasonCode } : {}),
  });
  if (!parsed.success) throw new Error("skill.release_approval_invalid");
  return parsed.data;
}

/** External actions among `actions` that the admitted plan publishes to an outbound route. */
export function routedExternalActions(plan: HarnessPlanV2, actions: readonly string[]): string[] {
  const published = new Set((plan.integrations?.publications ?? []).flatMap((publication) => publication.eventTypes));
  return [...new Set(actions)].filter((action) => published.has(externalActionEventType(action)));
}
