import { createHash } from "node:crypto";
import {
  coverageDenialSkillCode,
  coverageReasonFromError,
  isTransientSkillError,
  skillBindingForNode,
  skillResultV1Schema,
  type CapabilityResult,
  type HarnessPlanV2,
  type PlanSkillBinding,
  type SkillErrorCode,
  type SkillResultV1,
  type SkillSelectionRecord,
} from "@ehf/contracts";

/**
 * Business skills at run time: "pin at compile, select at run".
 *
 * The compiler pinned, per skill-bound node, an ordered candidate set (capability +
 * connector, with equivalent-coverage groups) and a resolution policy. Here the runtime
 * selects the first candidate the node's permission envelope allows and, only when the
 * policy allows fallback and only after a transient failure (TIMEOUT, RATE_LIMITED,
 * SOURCE_UNAVAILABLE), moves to the next candidate in the *same* coverage group. It never
 * falls back across coverage groups: sanctions coverage is never downgraded to save cost.
 */

export type PinnedCandidate = PlanSkillBinding["candidates"][number] & { index: number };

export type SkillPlan = {
  binding: PlanSkillBinding;
  /** Pinned candidates the node's envelope permits, in pinned order. */
  permitted: PinnedCandidate[];
};

/**
 * The skill plan of a node, or null when the node is not skill-bound. With `skillId`, the plan
 * of that skill when the node may invoke it (its own skill or one of its agent loop's skills).
 */
export function skillPlanForNode(plan: HarnessPlanV2, nodeId: string, skillId?: string): SkillPlan | null {
  const binding = skillBindingForNode(plan, nodeId, skillId);
  if (!binding) return null;
  const envelope = plan.permissionEnvelopes.find((item) => item.nodeId === nodeId);
  const declared = new Set(plan.capabilities.map((capability) => capability.id));
  const permitted = binding.candidates
    .map((candidate, index) => ({ ...candidate, index }))
    .filter((candidate) => declared.has(candidate.capabilityId) && envelope?.capabilities.includes(candidate.capabilityId));
  return { binding, permitted };
}

/**
 * Admission checks for skill bindings: every skill-bound node has a pinned binding, every
 * candidate is a capability of the plan inside the node's envelope, the node's bound
 * capability is a candidate or its planning model, and bindings are unique.
 */
export function admitSkillBindings(plan: HarnessPlanV2): void {
  const bindings = plan.skillBindings ?? [];
  if (new Set(bindings.map((binding) => binding.skillId)).size !== bindings.length) {
    throw new Error("runtime.v2.skill_binding_duplicate");
  }
  const capabilities = new Map(plan.capabilities.map((capability) => [capability.id, capability]));
  for (const node of plan.graph.nodes) {
    // Agent loop skills: each pinned, every candidate inside the node's envelope, read-only.
    for (const loopSkill of loopSkillsOf(node.config)) {
      const binding = bindings.find((item) => item.skillId === loopSkill);
      if (!binding) throw new Error(`runtime.v2.skill_binding_missing:${node.id}`);
      if ((binding.effects?.mode ?? "read_only") !== "read_only") throw new Error(`runtime.v2.loop_skill_not_read_only:${node.id}:${loopSkill}`);
      const envelope = plan.permissionEnvelopes.find((item) => item.nodeId === node.id);
      for (const candidate of binding.candidates) {
        if (!capabilities.has(candidate.capabilityId) || !envelope?.capabilities.includes(candidate.capabilityId)) {
          throw new Error(`runtime.v2.skill_candidate_not_permitted:${node.id}:${candidate.capabilityId}`);
        }
      }
    }
    if (node.config.skillId === undefined) continue;
    if (typeof node.config.skillId !== "string") throw new Error(`runtime.v2.skill_id_invalid:${node.id}`);
    const binding = bindings.find((item) => item.skillId === node.config.skillId);
    if (!binding) throw new Error(`runtime.v2.skill_binding_missing:${node.id}`);
    const envelope = plan.permissionEnvelopes.find((item) => item.nodeId === node.id);
    for (const candidate of binding.candidates) {
      if (!capabilities.has(candidate.capabilityId) || !envelope?.capabilities.includes(candidate.capabilityId)) {
        throw new Error(`runtime.v2.skill_candidate_not_permitted:${node.id}:${candidate.capabilityId}`);
      }
    }
    const bound = typeof node.config.capabilityId === "string" ? node.config.capabilityId : null;
    if (!bound || (!binding.candidates.some((candidate) => candidate.capabilityId === bound) && capabilities.get(bound)?.kind !== "model")) {
      throw new Error(`runtime.v2.skill_binding_conflict:${node.id}`);
    }
  }
}

function loopSkillsOf(config: Record<string, unknown>): string[] {
  const loop = config.loop as { skills?: unknown } | undefined;
  if (!loop || !Array.isArray(loop.skills)) return [];
  return loop.skills.map((skill) => (skill && typeof skill === "object" ? (skill as { skillId?: unknown }).skillId : undefined))
    .map((skillId) => {
      if (typeof skillId !== "string") throw new Error("runtime.v2.loop_skill_invalid");
      return skillId;
    });
}

/**
 * Map a gateway/runtime failure code to a §4.3 standard error. Unknown failures are
 * `CONTROL_FAILED`, which is not transient: an unrecognised error never triggers fallback.
 */
export function skillErrorCodeFor(code: string | null | undefined): SkillErrorCode {
  const coverage = coverageReasonFromError(code ?? "");
  if (coverage) return coverageDenialSkillCode(coverage);
  const value = (code ?? "").toLowerCase();
  if (value.startsWith("gateway.source_policy_denied:")) return "ACCESS_DENIED";
  if (!value) return "CONTROL_FAILED";
  if (value.includes("in_progress") || value.includes("budget")) return "CONTROL_FAILED";
  if (/timeout|timed_out|deadline/.test(value)) return "TIMEOUT";
  if (/http_429|rate_limit|too_many_requests/.test(value)) return "RATE_LIMITED";
  if (/unreachable|unavailable|http_5\d\d|dead_letter|connection|fetch failed|econn/.test(value)) return "SOURCE_UNAVAILABLE";
  if (/denied|not_permitted|forbidden|authorization|stale_fence|http_401|http_403|credential_missing/.test(value)) return "ACCESS_DENIED";
  if (/digest|integrity|mismatch|idempotency_conflict|tamper/.test(value)) return "INTEGRITY_FAILURE";
  if (/stale/.test(value)) return "CONTEXT_STALE";
  if (/_invalid|_missing|_required|malformed|input/.test(value)) return "INPUT_INVALID";
  return "CONTROL_FAILED";
}

/**
 * The next candidate a transient failure of `current` may fall back to: a later permitted
 * candidate in the primary's equivalent-coverage group, only when the policy allows it.
 */
export function nextEquivalentCandidate(plan: SkillPlan, primary: PinnedCandidate, current: PinnedCandidate, code: SkillErrorCode): PinnedCandidate | null {
  if (!plan.binding.policy.allow_fallback || !isTransientSkillError(code)) return null;
  if (primary.equivalentCoverageGroup === null) return null;
  return plan.permitted.find((candidate) => candidate.index > current.index
    && candidate.equivalentCoverageGroup === primary.equivalentCoverageGroup) ?? null;
}

/**
 * The next candidate to try after the gateway refused `current` for coverage (entitlement,
 * jurisdiction or list freshness). A refused candidate never served the call, so this is
 * selection, not fallback: any later permitted candidate may be tried, whatever its coverage
 * group and whatever `allow_fallback` says. The gateway checks each one against the same
 * policy, so a skipped requirement cannot be skipped again.
 */
export function nextEligibleCandidate(plan: SkillPlan, current: PinnedCandidate): PinnedCandidate | null {
  return plan.permitted.find((candidate) => candidate.index > current.index) ?? null;
}

/** Source policy can skip only a bounded coverage/access failure, within an approved equivalent group. */
export function nextSourcePolicyCandidate(plan: SkillPlan, primary: PinnedCandidate, current: PinnedCandidate, message: string): PinnedCandidate | null {
  if (!plan.binding.policy.allow_fallback || primary.equivalentCoverageGroup === null) return null;
  if (!/^gateway\.source_policy_denied:source_policy\.(subject_not_covered|required_scope_not_supported|access_scope_denied|source_scope_unresolved)$/.test(message)) return null;
  return plan.permitted.find((candidate) => candidate.index > current.index && candidate.equivalentCoverageGroup === primary.equivalentCoverageGroup) ?? null;
}

export function selectionRecord(binding: PlanSkillBinding, candidate: PinnedCandidate, reason: string, jurisdiction?: string | null): SkillSelectionRecord {
  return {
    skillId: binding.skillId,
    skillVersion: binding.semver,
    selectedCapabilityId: candidate.capabilityId,
    selectedConnectorId: candidate.connectorId,
    candidateIndex: candidate.index,
    reason,
    ...(jurisdiction ? { jurisdiction } : {}),
  };
}

/** A stable RFC 4122 (version 8, name-based) UUID for a skill execution, derived from its invocation. */
export function skillExecutionId(seed: string): string {
  const hex = createHash("sha256").update(seed).digest("hex");
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const MISSING_EVIDENCE_OUTCOMES = new Set(["unknown", "not_checked", "inconclusive", "resubmit"]);
const UNCERTAIN_STATUSES = new Set(["UNKNOWN", "INCONCLUSIVE", "NOT_CHECKED", "ERROR"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export type SkillResultInput = {
  skillId: string;
  skillVersion: string;
  /** The capability result, or the error the invocation failed with. */
  outcome: { result: CapabilityResult } | { error: unknown };
  executionId?: string;
  subjectRef?: string;
  policySnapshotRef: string;
  contextHash: string;
  traceRef: string;
  durationMs: number;
  providerCalls: number;
};

/**
 * Wrap one implementation outcome as SkillResult.v1.
 *
 * `COMPLETED` only when the implementation completed with a usable result. Wiring outcomes
 * `unknown | not_checked | inconclusive | resubmit`, an UNKNOWN/ERROR result status or an
 * empty output are `NEEDS_EVIDENCE`; a provider asking for review is `NEEDS_REVIEW`; a
 * partial check is `PARTIAL`; a denial is `BLOCKED`; every failure is `FAILED` with a §4.3
 * code. Missing evidence never reads as a pass.
 */
export function toSkillResult(input: SkillResultInput): SkillResultV1 {
  const subject = input.subjectRef ?? "";
  const base = {
    execution_id: input.executionId ?? skillExecutionId(`${input.traceRef}:${input.skillId}`),
    skill_id: input.skillId,
    skill_version: input.skillVersion,
    policy_snapshot_ref: input.policySnapshotRef,
    context_hash: input.contextHash,
    trace_ref: input.traceRef,
  };
  const failed = (code: SkillErrorCode, explanation: string) => skillResultV1Schema.parse({
    ...base,
    status: code === "ACCESS_DENIED" || code === "POLICY_UNRESOLVED" || code === "CONTEXT_MISSING" ? "BLOCKED" : "FAILED",
    result_refs: [], evidence_refs: [], finding_refs: [],
    unresolved_items: [{ code, subject_ref: subject, explanation }],
    metrics: { duration_ms: Math.max(0, Math.round(input.durationMs)), provider_calls: input.providerCalls, cost_estimate: 0 },
    error: { code, retryable: isTransientSkillError(code) },
  });
  if ("error" in input.outcome) {
    const message = input.outcome.error instanceof Error ? input.outcome.error.message : String(input.outcome.error);
    return failed(skillErrorCodeFor(message), `The implementation failed: ${message.slice(0, 300)}`);
  }
  const result = input.outcome.result;
  if (result.status === "denied") return failed("ACCESS_DENIED", `The gateway denied ${result.capabilityId}.`);
  if (result.status === "failed") {
    return failed(skillErrorCodeFor(result.errorCode), `The implementation failed with ${result.errorCode ?? "an unreported error"}.`);
  }
  const output = record(result.output);
  const evidenceRefs = (Array.isArray(output?.evidenceRefs) ? output.evidenceRefs : [])
    .map((item) => record(item)?.evidenceId)
    .filter((id): id is string => typeof id === "string" && id.length > 0)
    .map((id) => `evidence:${id}`);
  const unresolved: SkillResultV1["unresolved_items"] = [];
  let status: SkillResultV1["status"] = "COMPLETED";
  const outcome = typeof output?.outcome === "string" ? output.outcome : null;
  const resultStatus = typeof output?.status === "string" ? output.status.toUpperCase() : null;
  const wiringError = record(output?.error);
  if (result.output === null || result.output === undefined) {
    status = "NEEDS_EVIDENCE";
    unresolved.push({ code: "EVIDENCE_INSUFFICIENT", subject_ref: subject, explanation: "The implementation returned no result." });
  } else if ((resultStatus && UNCERTAIN_STATUSES.has(resultStatus)) || wiringError || (outcome && MISSING_EVIDENCE_OUTCOMES.has(outcome))) {
    status = "NEEDS_EVIDENCE";
    const why = typeof wiringError?.code === "string" ? wiringError.code : outcome ?? resultStatus ?? "unknown";
    unresolved.push({ code: "EVIDENCE_INSUFFICIENT", subject_ref: subject, explanation: `The source did not establish a result (${why}).` });
  } else if (outcome === "review") {
    status = "NEEDS_REVIEW";
    unresolved.push({ code: "HUMAN_REVIEW_REQUIRED", subject_ref: subject, explanation: "The source returned potential matches that need human review." });
  } else if (output?.checkStatus === "partial") {
    status = "PARTIAL";
    unresolved.push({ code: "EVIDENCE_INSUFFICIENT", subject_ref: subject, explanation: "The source completed only part of the check." });
  }
  return skillResultV1Schema.parse({
    ...base,
    status,
    result_refs: [`receipt:${result.receiptDigest}`],
    evidence_refs: evidenceRefs,
    finding_refs: [],
    unresolved_items: unresolved,
    metrics: {
      duration_ms: Math.max(0, Math.round(input.durationMs)),
      provider_calls: input.providerCalls,
      cost_estimate: result.usage.costUsd ?? 0,
    },
    error: null,
  });
}
