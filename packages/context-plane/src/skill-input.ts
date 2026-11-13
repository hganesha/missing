import { skillCapabilityInputV1Schema, type SkillCapabilityInputV1 } from "@ehf/contracts";
import { blockingRecordGaps, recordGapsAsMissing, type RecordContextGap } from "./records.js";
import type { ContextPack } from "./index.js";
import type { SkillPolicyResolution } from "./policy.js";

/**
 * The body a runtime sends to a `skills:<skill_id>` capability (`SkillCapabilityInput.v1`,
 * skill.execution.v1 §4.1 `input` + `context`), built from an assembled context pack.
 *
 * Returns `blocked` instead of an input when the skill must not run: a required record
 * requirement is unmet (CONTEXT_MISSING / CONTEXT_STALE), the ContextEnvelope could not be
 * established, a parameter the node binds from a predecessor or the case resolved to nothing
 * (CONTEXT_MISSING), or the node declares a policy projection that does not resolve against the
 * case's pinned policy (POLICY_UNRESOLVED, policy.ts). The caller answers NEEDS_EVIDENCE with
 * those gaps without calling the gateway.
 */
export type SkillInvocationInput = {
  /** SkillInput.v1 `execution_id` (a UUID, deterministic per node attempt). */
  executionId: string;
  parameters: Record<string, unknown>;
  purpose: "onboarding" | "review" | "monitoring" | "investigation" | "fraud" | "reporting";
  idempotencyKey: string;
  traceId: string;
  /**
   * The resolved `policy` section (policy.ts), when the node declares a policy projection. A
   * `ready` section is sent as `context.sections[]` kind `policy`; `unresolved` blocks the skill.
   */
  policy?: SkillPolicyResolution;
  /** Parameters the node binds that resolved to nothing; any one blocks the skill. */
  unresolvedParameters?: string[];
};

export type SkillInputBlockCode = "CONTEXT_MISSING" | "CONTEXT_STALE" | "POLICY_UNRESOLVED";

export type SkillInputBuild =
  | { status: "ready"; input: SkillCapabilityInputV1; recordGaps: RecordContextGap[] }
  | {
      status: "blocked"; code: SkillInputBlockCode; recordGaps: RecordContextGap[]; envelopeGaps: string[];
      /** Policy fields the pinned policy did not resolve (POLICY_UNRESOLVED). */
      policyGaps: string[];
      /** Bound parameters that resolved to nothing. */
      parameterGaps: string[];
      explanation: string;
    };

export function buildSkillCapabilityInput(pack: ContextPack, invocation: SkillInvocationInput): SkillInputBuild {
  const recordGaps = pack.recordGaps ?? [];
  const blocking = blockingRecordGaps(recordGaps);
  const envelope = pack.contextEnvelope;
  const parameterGaps = invocation.unresolvedParameters ?? [];
  const policy = invocation.policy;
  const policyGaps = policy?.status === "unresolved" ? policy.missing : [];
  if (blocking.length || !envelope || parameterGaps.length || policyGaps.length) {
    // As the library's compiler: any stale mandatory record makes the whole gap CONTEXT_STALE.
    // Missing evidence outranks an unresolved policy: both block, the first names the code.
    const code: SkillInputBlockCode = blocking.some((gap) => gap.code === "CONTEXT_STALE") ? "CONTEXT_STALE"
      : blocking.length || !envelope || parameterGaps.length ? "CONTEXT_MISSING" : "POLICY_UNRESOLVED";
    const envelopeGaps = envelope ? [] : pack.contextGaps.map((gap) => gap.field);
    return {
      status: "blocked", code, recordGaps, envelopeGaps, policyGaps, parameterGaps,
      explanation: [
        ...blocking.map((gap) => gap.explanation),
        ...(envelopeGaps.length ? [`Context envelope fields not established: ${envelopeGaps.join(", ")}.`] : []),
        ...(parameterGaps.length ? [`Bound parameters resolved to nothing: ${parameterGaps.join(", ")}.`] : []),
        ...(policy?.status === "unresolved" ? [policy.explanation] : []),
      ].join(" "),
    };
  }
  const sections = [...pack.sections, ...(policy?.status === "ready" ? [policy.section] : [])];
  const input = skillCapabilityInputV1Schema.parse({
    input: {
      execution_id: invocation.executionId,
      tenant_id: envelope.tenant_id,
      case_id: envelope.case_id,
      subject_refs: envelope.subject_refs,
      parameters: invocation.parameters,
      context_manifest_ref: pack.manifest?.manifestId ?? `context-pack:${pack.packDigest}`,
      policy_snapshot_ref: envelope.policy_snapshot_ref,
      as_of_time: envelope.as_of_time,
      purpose: invocation.purpose,
      actor_ref: envelope.actor,
      idempotency_key: invocation.idempotencyKey,
      trace_id: invocation.traceId,
    },
    context: {
      envelope,
      context_hash: pack.contextHash,
      sections: sections.map((section) => ({
        id: section.id,
        kind: section.kind,
        trust: section.trust,
        classification: section.classification,
        purpose: section.purpose,
        provenance_ref: section.provenanceRef,
        content_digest: `sha256:${section.contentDigest.replace(/^sha256:/, "")}`,
        quarantined: section.quarantined,
        value: section.value,
      })),
      missing: [
        ...recordGapsAsMissing(recordGaps),
        ...pack.budget.droppedSectionIds.map((selector) => ({ selector, code: "CONTEXT_MISSING" as const, required: false })),
      ],
    },
  });
  return { status: "ready", input, recordGaps };
}
