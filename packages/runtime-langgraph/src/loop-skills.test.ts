import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { harnessPlanV2Schema, type HarnessPlanV2 } from "@ehf/contracts";
import { assembleContextPack } from "@ehf/context-plane";
import { runAgentLoop, type LoopSkillResult } from "./index.js";

// Agent loop skills (agentic plan phase 1) on the real production slice 1 plan: the screening
// review agent may choose to run screening.pep.relationship.resolve and
// screening.sanctions.control.evaluate; the model names a skill and parameters, nothing else.
const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../../artifacts/kyb-screening.plan.json", import.meta.url), "utf8"))) as HarnessPlanV2;
const NODE = "screening-review";
const final = { summary: "One candidate reviewed.", proposals: [], gaps: [], requiresHumanReview: true };

const pack = () => assembleContextPack({
  plan, nodeId: NODE, runId: "RUN-loop-skills",
  selection: { kybSubjects: [{ subject_id: "e-1", display_name: "Thistlewood Fabrication Ltd" }] },
  snapshot: { snapshotId: `snapshot_${"a".repeat(64)}`, snapshotDigest: "a".repeat(64), tenantId: "tenant-1", caseId: "case-1", caseSequence: 1 },
  envelope: { tenantId: "tenant-1", caseId: "case-1", jurisdiction: "US", asOfTime: "2026-09-30T00:00:00.000Z" },
});

/** A scripted model: returns the queued actions in order, then the final answer. */
function scripted(actions: unknown[]) {
  const queue = [...actions];
  const prompts: string[] = [];
  return {
    prompts,
    invoke: async (capabilityId: string | undefined, input: unknown) => {
      if (capabilityId !== undefined) throw new Error(`unexpected tool call ${capabilityId}`);
      prompts.push(String((input as { prompt: string }).prompt));
      return { status: "succeeded", output: queue.shift() ?? { action: "final", output: final } };
    },
  };
}

describe("agent loop skills", () => {
  it("lists the node's skills with their parameter schemas and runs a named skill with the model's parameters", async () => {
    const model = scripted([{ action: "call_skill", skill: "screening.sanctions.control.evaluate", parameters: { blocked_ids: ["e-9"] } }]);
    const calls: Array<[string, Record<string, unknown>, number]> = [];
    const result = await runAgentLoop({
      plan, nodeId: NODE, pack: pack(), invoke: model.invoke,
      invokeSkill: async (skillId, parameters, step): Promise<LoopSkillResult> => {
        calls.push([skillId, parameters, step]);
        return { status: "succeeded", output: { skill: skillId, businessStatus: "COMPLETED", payload: { restrictions: [] } }, receiptDigest: "r".repeat(64) };
      },
    });
    expect(calls).toEqual([["screening.sanctions.control.evaluate", { blocked_ids: ["e-9"] }, 1]]);
    expect(model.prompts[0]).toContain("<skills>");
    expect(model.prompts[0]).toContain("screening.pep.relationship.resolve");
    expect(model.prompts[0]).toContain('"action":"call_skill"');
    expect(result.steps.map((step) => [step.action, step.tool, step.status])).toEqual([
      ["call_skill", "skill:screening.sanctions.control.evaluate", "succeeded"],
      ["final", null, "accepted"],
    ]);
    expect(result.observations[0]).toMatchObject({ tool: "skill:screening.sanctions.control.evaluate", status: "succeeded", receiptDigest: "r".repeat(64) });
  });

  it("refuses a skill the node does not have, parameters that fail the skill's schema, and a repeated call, without running them", async () => {
    const model = scripted([
      { action: "call_skill", skill: "screening.sanctions.execute", parameters: {} },
      { action: "call_skill", skill: "screening.sanctions.control.evaluate", parameters: { blocked_ids: "e-9" } },
      { action: "call_skill", skill: "screening.pep.relationship.resolve", parameters: {} },
      { action: "call_skill", skill: "screening.pep.relationship.resolve", parameters: {} },
    ]);
    const ran: string[] = [];
    const result = await runAgentLoop({
      plan, nodeId: NODE, pack: pack(), invoke: model.invoke,
      invokeSkill: async (skillId) => { ran.push(skillId); return { status: "succeeded", output: { businessStatus: "COMPLETED", payload: { relationships: [] } } }; },
    });
    expect(ran).toEqual(["screening.pep.relationship.resolve"]);
    expect(result.steps.slice(0, 4).map((step) => [step.status, step.errorCode])).toEqual([
      ["refused", "agent.skill_not_permitted"],
      ["refused", "agent.skill_parameters_invalid"],
      ["succeeded", null],
      ["refused", "agent.skill_call_repeated"],
    ]);
  });

  it("shows a skill the platform could not run (missing records) as a refused observation, not a result", async () => {
    const model = scripted([{ action: "call_skill", skill: "screening.pep.relationship.resolve", parameters: {} }]);
    const result = await runAgentLoop({
      plan, nodeId: NODE, pack: pack(), invoke: model.invoke,
      invokeSkill: async () => ({ status: "blocked", errorCode: "CONTEXT_MISSING", output: { status: "NEEDS_EVIDENCE", code: "CONTEXT_MISSING", recordGaps: [{ objectType: "PEPRelationship", code: "CONTEXT_MISSING", required: true }] } }),
    });
    expect(result.observations[0]).toMatchObject({ status: "refused", errorCode: "CONTEXT_MISSING", value: { status: "NEEDS_EVIDENCE" } });
    expect(result.steps[0]).toMatchObject({ action: "call_skill", status: "refused" });
  });

  it("will not start a loop with skills and no way to run them", async () => {
    await expect(runAgentLoop({ plan, nodeId: NODE, pack: pack(), invoke: scripted([]).invoke })).rejects.toThrow("runtime.agent_loop_skill_runner_missing");
  });
});
