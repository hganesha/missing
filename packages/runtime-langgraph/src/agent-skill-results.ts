import { agentTaskCompletionSchema, type HarnessPlanV2 } from "@ehf/contracts";

type PlanNode = HarnessPlanV2["graph"]["nodes"][number];

/**
 * What an agent's review sees of its own skills: for each skill node its completion criteria name,
 * the lifecycle and the skill computation (business status, payload, unresolved items) from the run.
 * A skill that has not run is absent, which the agent reports as a gap and the runtime's completion
 * check treats as not done. Runtime-internal fields (held effects, task verdicts) are left out.
 *
 * Skill nodes named in `config.observedSkillNodes` (an agent's optional hydration checks, delivery
 * plan wave 4) are shown the same way, outside completion: their absence is not a failure.
 *
 * Returns the `skillResults` input of assembleContextPack, or undefined for a node without criteria.
 */
export function agentSkillResults(node: PlanNode, values: Readonly<Record<string, unknown>>): { skillResults: Record<string, unknown> } | undefined {
  if (node.kind !== "agent" || node.config.completion === undefined) return undefined;
  const parsed = agentTaskCompletionSchema.safeParse(node.config.completion);
  if (!parsed.success) return undefined;
  const results: Record<string, unknown> = {};
  const observed = Array.isArray(node.config.observedSkillNodes) ? node.config.observedSkillNodes.filter((id): id is string => typeof id === "string") : [];
  for (const nodeId of new Set([...parsed.data.criteria.map((criterion) => criterion.nodeId), ...observed])) {
    const value = values[nodeId];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const { lifecycle, computation } = value as { lifecycle?: unknown; computation?: unknown };
    results[nodeId] = { lifecycle: lifecycle ?? null, computation: computation ?? null };
  }
  return { skillResults: results };
}
