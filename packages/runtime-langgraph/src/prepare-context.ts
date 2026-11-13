import {
  assembleContextPack,
  buildSkillCapabilityInput,
  chooseSkillPolicy,
  resolveSkillPolicySection,
  type AssembleContextInput,
} from "@ehf/context-plane";
import type { CaseSnapshot as CaseSnapshotV2 } from "@ehf/contracts";
import { skillParametersFor, skillPurposeFor } from "./hosted-skill.js";
/** Shared preparation only. Callers own read authorization, recording and dispatch. */
export function prepareSkillContext(
  input: AssembleContextInput & {
    snapshot: CaseSnapshotV2 | null;
    executionId: string;
    idempotencyKey: string;
    traceId: string;
    predecessors?: Record<string, unknown>;
  },
) {
  const node = input.plan.graph.nodes.find((n) => n.id === input.nodeId);
  if (!node) throw new Error("context.node_missing");
  const pack = assembleContextPack(input);
  const bound = skillParametersFor(
    node,
    input.predecessors ?? {},
    input.selection ?? {},
  );
  const nodePolicy = chooseSkillPolicy(node.config.skillPolicy, node.config.skillPolicies, input.snapshot?.policyAuthority);
  const policy =
    nodePolicy === undefined
      ? undefined
      : resolveSkillPolicySection({
          config: nodePolicy,
          authority: input.snapshot?.policyAuthority,
          selection: input.selection ?? {},
          purpose:
            input.plan.contextSelectors.find((s) =>
              node.contextSelectorIds.includes(s.id),
            )?.purpose ?? "workflow.skill",
          ...(input.envelope?.asOfTime
            ? { asOfTime: input.envelope.asOfTime }
            : {}),
        });
  const built = buildSkillCapabilityInput(pack, {
    executionId: input.executionId,
    parameters: bound.parameters,
    purpose: skillPurposeFor(node),
    idempotencyKey: input.idempotencyKey,
    traceId: input.traceId,
    ...(policy ? { policy } : {}),
    ...(bound.required && bound.unresolvedBindings.length
      ? { unresolvedParameters: bound.unresolvedBindings }
      : {}),
  });
  return { pack, built, policy };
}
