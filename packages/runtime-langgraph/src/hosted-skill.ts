import { SKILL_ADAPTER_PREFIX, skillPurposeSchema, skillResultV1Schema, type HarnessPlanV2, type SkillResultV1 } from "@ehf/contracts";
import type { RecordContextGap, SkillInvocationInput } from "@ehf/context-plane";
import { getPath, skillPlanForNode } from "@ehf/runtime-core";

/**
 * Runtime side of a skill served by the skill host (`skills:<skill_id>`, skill.execution.v1):
 * which nodes take that path, the parameters they send, and the SkillResult.v1 the platform
 * answers with when required context is missing (§3 step 2: the skill is not called).
 */

type Node = HarnessPlanV2["graph"]["nodes"][number];

/** The node's first permitted candidate when it is skill-hosted, else null. */
export function hostedSkillCandidate(plan: HarnessPlanV2, nodeId: string) {
  const skill = skillPlanForNode(plan, nodeId);
  const candidate = skill?.permitted[0];
  return skill && candidate?.connectorId?.startsWith(SKILL_ADAPTER_PREFIX) ? { binding: skill.binding, candidate } : null;
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".").filter(Boolean);
  if (!parts.length || parts.some((part) => ["__proto__", "constructor", "prototype"].includes(part))) throw new Error("runtime.skill_parameter_path_invalid");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts.at(-1)!] = structuredClone(value);
}

function removePath(target: Record<string, unknown>, path: string): void {
  const parts = path.split(".");
  if (parts.some((part) => ["__proto__", "prototype", "constructor"].includes(part))) throw new Error("runtime.skill_parameter_path_invalid");
  let cursor = target;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    cursor = next as Record<string, unknown>;
  }
  delete cursor[parts.at(-1)!];
}

/**
 * `config.skillParameters`, with `config.skillParameterBindings` (`{"facts.tier":
 * "risk-customer-assess.payload.tier"}`, the library workflow's `bindings`) applied from
 * predecessor values. A predecessor's `payload` is its skill computation's payload. A binding
 * whose source is absent removes any authored fallback and is reported.
 *
 * `config.skillContextBindings` (`{"name": "subjectName"}`, a platform overlay) set parameters
 * from the node's own purpose-bound context selection (selector ids the node reads). A null
 * value counts as absent. With `config.requireBoundParameters: true` the caller must not call
 * the skill while any binding is unresolved (fail closed instead of running on a default).
 */
/**
 * The value a binding source names: `<node>.<path>` into a predecessor's value (`payload` means
 * its skill computation's payload). One `[*]` projects a list, `<node>.payload.hits[*].entity_id`
 * giving every hit's `entity_id`, without duplicates and in first-seen order: the list exists
 * (possibly empty) only when the part before `[*]` is an array, so an absent predecessor is still
 * unresolved rather than an empty list. Items without the projected field are skipped.
 */
export function bindingValue(source: string, values: Record<string, unknown>): unknown {
  const [nodeId, ...rest] = source.split(".");
  const path = rest[0] === "payload" ? ["computation", ...rest].join(".") : rest.join(".");
  const star = path.indexOf("[*]");
  if (star < 0) return getPath(values[nodeId!], path);
  const suffix = path.slice(star + 3).replace(/^\./, "");
  if (suffix.includes("[*]")) throw new Error("runtime.skill_binding_projection_nested");
  const items = getPath(values[nodeId!], path.slice(0, star));
  if (!Array.isArray(items)) return undefined;
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of items) {
    const value = suffix ? getPath(item, suffix) : item;
    if (value === undefined || value === null) continue;
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * A context binding's value from the node's own selection. Either a selector id (its value as is),
 * or a projection over a selector's list, optionally filtered by another selector's value:
 *
 *   `subjectIdentifiers[*].data.value | data.entity_id == subjectId`
 *
 * gives `data.value` of every item of `subjectIdentifiers` whose `data.entity_id` equals the value of
 * `subjectId` (the case subject's identifier values), without duplicates and in order. Every selector
 * named must be one the node reads; a projection over an absent list is unresolved, a filter that
 * matches nothing is an empty list.
 */
export function contextBindingValue(binding: string, nodeSelectors: readonly string[], selection: Readonly<Record<string, unknown>>): unknown {
  const [projection, filter] = binding.split("|").map((part) => part.trim());
  const star = projection!.indexOf("[*]");
  if (star < 0) return nodeSelectors.includes(projection!) ? selection[projection!] : undefined;
  const selectorId = projection!.slice(0, star);
  const field = projection!.slice(star + 3).replace(/^\./, "");
  if (!nodeSelectors.includes(selectorId)) return undefined;
  const items = selection[selectorId];
  if (!Array.isArray(items)) return undefined;
  let keep = (_item: unknown) => true;
  if (filter) {
    const match = /^([\w.]+)\s*==\s*(\w+)$/.exec(filter);
    if (!match || !nodeSelectors.includes(match[2]!)) return undefined;
    const expected = selection[match[2]!];
    if (expected === undefined || expected === null) return undefined;
    keep = (item) => getPath(item, match[1]!) === expected;
  }
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of items.filter(keep)) {
    const value = field ? getPath(item, field) : item;
    if (value === undefined || value === null) continue;
    const key = JSON.stringify(value);
    if (!seen.has(key)) { seen.add(key); out.push(value); }
  }
  return out;
}

export function skillParametersFor(node: Node, values: Record<string, unknown>, selection: Readonly<Record<string, unknown>> = {}): {
  parameters: Record<string, unknown>; unresolvedBindings: string[]; required: boolean;
} {
  const authored = node.config.skillParameters;
  const parameters = authored && typeof authored === "object" && !Array.isArray(authored) ? structuredClone(authored as Record<string, unknown>) : {};
  const bindings = node.config.skillParameterBindings;
  const unresolvedBindings: string[] = [];
  // Bindings a skill reads as optional facts (an absent fact evaluates UNKNOWN in the skill, never a
  // pass): left absent when unresolved instead of failing the node closed.
  const optional = new Set(Array.isArray(node.config.optionalParameterBindings) ? node.config.optionalParameterBindings.filter((item): item is string => typeof item === "string") : []);
  if (bindings && typeof bindings === "object" && !Array.isArray(bindings)) {
    for (const [target, source] of Object.entries(bindings as Record<string, unknown>)) {
      if (typeof source !== "string") continue;
      const value = bindingValue(source, values);
      if ((value === undefined || value === null) && optional.has(target)) removePath(parameters, target);
      else if (value === undefined || value === null) { removePath(parameters, target); unresolvedBindings.push(target); }
      else setPath(parameters, target, value);
    }
  }
  const contextBindings = node.config.skillContextBindings;
  if (contextBindings && typeof contextBindings === "object" && !Array.isArray(contextBindings)) {
    for (const [target, binding] of Object.entries(contextBindings as Record<string, unknown>)) {
      const value = typeof binding === "string" ? contextBindingValue(binding, node.contextSelectorIds, selection) : undefined;
      if (value === undefined || value === null || value === "") { removePath(parameters, target); unresolvedBindings.push(target); }
      else setPath(parameters, target, value);
    }
  }
  return { parameters, unresolvedBindings, required: node.config.requireBoundParameters === true };
}

export function skillPurposeFor(node: Node): SkillInvocationInput["purpose"] {
  const parsed = skillPurposeSchema.safeParse(node.config.skillPurpose);
  return parsed.success ? parsed.data : "onboarding";
}

/**
 * NEEDS_EVIDENCE without calling the skill: required records were missing or stale, a bound
 * parameter resolved to nothing, or the pinned policy did not resolve the skill's policy fields.
 */
export function contextGapSkillResult(input: {
  skillId: string;
  skillVersion: string;
  executionId: string;
  code: "CONTEXT_MISSING" | "CONTEXT_STALE" | "POLICY_UNRESOLVED";
  recordGaps: RecordContextGap[];
  envelopeGaps: string[];
  policyGaps?: string[];
  /** Why the pinned policy did not resolve (policy.ts), e.g. the case is pinned to another policy. */
  policyExplanation?: string;
  parameterGaps?: string[];
  explanation: string;
  subjectRef?: string;
  policySnapshotRef: string;
  contextHash: string;
  traceRef: string;
}): SkillResultV1 {
  const subject = input.subjectRef ?? "";
  const unresolved = [
    ...input.recordGaps.filter((gap) => gap.required).map((gap) => ({ code: gap.code, subject_ref: subject, explanation: gap.explanation })),
    ...(input.envelopeGaps.length ? [{ code: "CONTEXT_MISSING", subject_ref: subject, explanation: `Context envelope fields not established: ${input.envelopeGaps.join(", ")}.` }] : []),
    ...(input.parameterGaps?.length ? [{ code: "CONTEXT_MISSING", subject_ref: subject, explanation: `Bound parameters resolved to nothing: ${input.parameterGaps.join(", ")}.` }] : []),
    ...(input.policyGaps?.length ? [{ code: "POLICY_UNRESOLVED", subject_ref: subject, explanation: `Pinned policy does not resolve: ${input.policyGaps.join(", ")}.${input.policyExplanation ? ` ${input.policyExplanation}` : ""}` }] : []),
  ];
  return skillResultV1Schema.parse({
    execution_id: input.executionId,
    skill_id: input.skillId,
    skill_version: input.skillVersion,
    status: "NEEDS_EVIDENCE",
    result_refs: [],
    evidence_refs: [],
    finding_refs: [],
    unresolved_items: unresolved.length ? unresolved : [{ code: input.code, subject_ref: subject, explanation: input.explanation || "Required context is missing." }],
    policy_snapshot_ref: input.policySnapshotRef,
    context_hash: input.contextHash,
    trace_ref: input.traceRef,
    metrics: { duration_ms: 0, provider_calls: 0, cost_estimate: 0 },
    error: { code: input.code, retryable: false },
  });
}
