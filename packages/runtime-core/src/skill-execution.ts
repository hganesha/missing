import {
  isTransientSkillError,
  SKILL_ERROR_CODES,
  skillCapabilityOutputV1Schema,
  skillResultV1Schema,
  type CapabilityResult,
  type SkillCapabilityOutputV1,
  type SkillErrorCode,
  type SkillResultV1,
} from "@ehf/contracts";

/**
 * SkillResult.v1 from a `skills:<skill_id>` capability result (skill.execution.v1 §3 step 5).
 *
 * The gateway has already validated the host's response (schema, output schema, effect modes,
 * evidence attribution) and returns it as `SkillCapabilityOutput.v1`. Lifecycle and business
 * status stay independent: a completed execution carries the skill's own business status; a
 * failed one becomes FAILED (or BLOCKED for authority and context codes) with its §4.3 code; a
 * cancelled one is FAILED/CONTROL_FAILED. `committedRefs` are the case-store references of the
 * proposed records the platform committed (§6.2): the result is built only after that commit,
 * so it never cites a record that does not exist.
 *
 * Not yet re-exported from ./index.ts (the worker wiring owns that file).
 */
export type SkillExecutionResultInput = {
  result: CapabilityResult;
  executionId: string;
  policySnapshotRef: string;
  contextHash: string;
  traceRef: string;
  subjectRef?: string;
  committedRefs?: { findings?: string[]; evidence?: string[] };
};

const CODES = new Set<string>(SKILL_ERROR_CODES);
const BLOCKING: ReadonlySet<SkillErrorCode> = new Set(["ACCESS_DENIED", "POLICY_UNRESOLVED", "CONTEXT_MISSING"]);

export function skillCapabilityOutput(result: CapabilityResult): SkillCapabilityOutputV1 | null {
  const parsed = skillCapabilityOutputV1Schema.safeParse(result.output);
  return parsed.success ? parsed.data : null;
}

export function skillResultFromExecution(input: SkillExecutionResultInput): SkillResultV1 {
  const output = skillCapabilityOutput(input.result);
  if (!output) throw new Error("runtime.skill_output_invalid");
  const subject = input.subjectRef ?? "";
  const computation = output.computation;
  const base = {
    execution_id: input.executionId,
    skill_id: output.skill_id,
    skill_version: output.skill_version,
    policy_snapshot_ref: input.policySnapshotRef,
    context_hash: input.contextHash,
    trace_ref: input.traceRef,
    result_refs: [`receipt:${input.result.receiptDigest}`],
    evidence_refs: [...output.dependency_receipts.map((digest) => `receipt:${digest}`), ...(input.committedRefs?.evidence ?? [])],
    finding_refs: input.committedRefs?.findings ?? [],
    metrics: {
      duration_ms: computation?.metrics.duration_ms ?? input.result.latencyMs,
      provider_calls: (computation?.metrics.capability_calls ?? 0) + (computation?.metrics.model_calls ?? 0),
      cost_estimate: input.result.usage.costUsd ?? 0,
    },
  };
  if (output.lifecycle !== "COMPLETED_EXECUTION" || !computation) {
    const code: SkillErrorCode = output.error?.code ?? "CONTROL_FAILED";
    const explanation = output.lifecycle === "CANCELLED" ? "The skill execution was cancelled." : `The skill execution failed with ${code}.`;
    return skillResultV1Schema.parse({
      ...base,
      status: BLOCKING.has(code) ? "BLOCKED" : "FAILED",
      unresolved_items: [{ code, subject_ref: subject, explanation }],
      error: { code, retryable: output.error?.retryable === true && isTransientSkillError(code) },
    });
  }
  const status = computation.business_status;
  const unresolved = [...computation.unresolved_items];
  if ((status === "NEEDS_EVIDENCE" || status === "NEEDS_REVIEW" || status === "PARTIAL") && unresolved.length === 0) {
    unresolved.push({
      code: status === "NEEDS_REVIEW" ? "HUMAN_REVIEW_REQUIRED" : "EVIDENCE_INSUFFICIENT",
      subject_ref: subject,
      explanation: `The skill reported ${status} without naming what is missing.`,
    });
  }
  let error: SkillResultV1["error"] = null;
  if (status === "FAILED" || status === "BLOCKED") {
    const named = unresolved.find((item) => CODES.has(item.code))?.code as SkillErrorCode | undefined;
    const code: SkillErrorCode = named ?? (status === "BLOCKED" ? "POLICY_UNRESOLVED" : "CONTROL_FAILED");
    error = { code, retryable: false };
    if (!unresolved.length) unresolved.push({ code, subject_ref: subject, explanation: `The skill reported ${status}.` });
  }
  return skillResultV1Schema.parse({ ...base, status, unresolved_items: unresolved, error });
}
