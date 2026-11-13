import { readFileSync } from "node:fs";
import { Validator } from "@cfworker/json-schema";
import { describe, expect, it } from "vitest";
import { agentTaskCompletionSchema, evaluateTaskCompletion, harnessPlanV2Schema, type HarnessPlanV2 } from "@ehf/contracts";
import { assembleContextPack } from "@ehf/context-plane";
import { runAgentLoop, type LoopSkillResult } from "./index.js";

// The ten business agents (agentic plan phase 3), each run once with a scripted model on the roster
// plan harnessc compiled (artifacts/agent-roster.plan.json, from domains/agents).
type RosterAgent = {
  id: string; modelProfileId: string; tools: string[]; outputSchema: Record<string, unknown>; example: Record<string, unknown>;
  skills: { required: string[]; optional: string[]; human: string[] }; allowedSkills: Array<{ skillId: string; semver: string }>;
};
const roster = JSON.parse(readFileSync(new URL("../../../domains/agents/roster.json", import.meta.url), "utf8")) as { agents: RosterAgent[] };
const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../../artifacts/agent-roster.plan.json", import.meta.url), "utf8"))) as HarnessPlanV2;
const reviewNode = (agent: RosterAgent) => `${agent.id.replace(/^agent\./, "").replaceAll("_", "-")}-review`;
const valid = (schema: Record<string, unknown>, value: unknown) => new Validator(schema as never, "2020-12", false).validate(value).valid;

/** A value that satisfies a simple JSON schema, for scripted skill parameters. */
function sample(schema: Record<string, any>): unknown {
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum)) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "object") return Object.fromEntries((schema.required ?? []).map((key: string) => [key, sample(schema.properties?.[key] ?? { type: "string" })]));
  if (type === "array") return [];
  if (type === "number" || type === "integer") return 0;
  if (type === "boolean") return false;
  if (type === "null") return null;
  return "e-1";
}

function pack(nodeId: string) {
  return assembleContextPack({
    plan, nodeId, runId: "RUN-roster",
    selection: { caseSubjects: [{ subject_id: "e-1", display_name: "Thistlewood Fabrication Ltd" }] },
    snapshot: { snapshotId: `snapshot_${"a".repeat(64)}`, snapshotDigest: "a".repeat(64), tenantId: "tenant-1", caseId: "case-1", caseSequence: 1 },
    envelope: { tenantId: "tenant-1", caseId: "case-1", jurisdiction: "US", asOfTime: "2026-09-30T00:00:00.000Z" },
  });
}

/** Values for an agent's completion criteria: each named skill node completed with its required fields. */
function completedValues(nodeId: string) {
  const node = plan.graph.nodes.find((item) => item.id === nodeId)!;
  const completion = agentTaskCompletionSchema.parse(node.config.completion);
  return { completion, values: Object.fromEntries(completion.criteria.map((criterion) => [criterion.nodeId, {
    lifecycle: "COMPLETED_EXECUTION", computation: { business_status: "COMPLETED", payload: Object.fromEntries(criterion.requiredPayloadFields.map((field) => [field, []])) },
  }])) };
}

describe("the agent roster", () => {
  it("has ten agents, each compiled as authored", () => {
    expect(roster.agents.map((agent) => agent.id)).toEqual([
      "agent.intake_profile", "agent.document_intelligence", "agent.identity_verification", "agent.identity_ownership", "agent.screening",
      "agent.investigation", "agent.risk_edd", "agent.relationship_product", "agent.decision_support", "agent.qa_assurance",
    ]);
    for (const agent of roster.agents) {
      const profile = plan.agentProfiles.find((item) => item.id === agent.id)!;
      expect(profile.allowedSkills, agent.id).toEqual(agent.allowedSkills);
      expect(profile.modelProfileId).toBe(agent.modelProfileId);
      // Every required skill runs as this agent; nothing else runs as it but its review loop.
      for (const skillId of [...agent.skills.required, ...agent.skills.human]) {
        expect(plan.graph.nodes.find((node) => node.config.skillId === skillId)?.config.agentRef, skillId).toBe(agent.id);
      }
    }
  });

  it("gives every loop read-only skills and read-only tools only", () => {
    for (const agent of roster.agents) {
      for (const skillId of agent.skills.optional) expect(plan.skillBindings!.find((binding) => binding.skillId === skillId)!.effects?.mode ?? "read_only", skillId).toBe("read_only");
      for (const tool of agent.tools) expect(plan.capabilities.find((capability) => capability.id === tool)!.effect, tool).toBe("read");
    }
  });

  it("reviews with an independent model: QA runs on the judge profile, which no other agent uses", () => {
    const qa = roster.agents.find((agent) => agent.id === "agent.qa_assurance")!;
    expect(qa.modelProfileId).toBe("model.judge.v1");
    expect(roster.agents.filter((agent) => agent.modelProfileId === qa.modelProfileId)).toHaveLength(1);
  });
});

describe.each(roster.agents.map((agent) => [agent.id, agent] as const))("%s, scripted", (_id, agent) => {
  const nodeId = reviewNode(agent);

  it("has a worked example that its output schema accepts", () => {
    expect(valid(agent.outputSchema, agent.example)).toBe(true);
  });

  it("runs a loop skill with runtime-built input, then answers within its schema", async () => {
    const candidates = plan.graph.nodes.find((node) => node.id === nodeId)!;
    const loopSkills = (candidates.config.loop as { skills: Array<{ skillId: string }> }).skills;
    const actions: unknown[] = [];
    const ran: string[] = [];
    if (loopSkills.length) {
      const binding = plan.skillBindings!.find((item) => item.skillId === loopSkills[0]!.skillId)!;
      const capability = plan.capabilities.find((item) => item.id === binding.candidates[0]!.capabilityId)!;
      const parametersSchema = (capability.inputSchema as any).properties.input.properties.parameters;
      actions.push({ action: "call_skill", skill: binding.skillId, parameters: sample(parametersSchema) });
    }
    actions.push({ action: "final", output: agent.example });
    const result = await runAgentLoop({
      plan, nodeId, pack: pack(nodeId),
      invoke: async () => ({ status: "succeeded", output: actions.shift() }),
      invokeSkill: async (skillId): Promise<LoopSkillResult> => { ran.push(skillId); return { status: "succeeded", output: { businessStatus: "COMPLETED", payload: {} } }; },
    });
    expect(ran).toEqual(loopSkills.slice(0, 1).map((skill) => skill.skillId));
    expect(result.steps.at(-1)).toMatchObject({ action: "final", status: "accepted" });
    expect(result.output).toEqual(agent.example);
  });

  it("is refused when it leaves out a field its schema requires, even after a repair", async () => {
    const field = (agent.outputSchema.required as string[]).at(-1)!;
    const { [field]: _dropped, ...broken } = agent.example;
    await expect(runAgentLoop({
      plan, nodeId, pack: pack(nodeId),
      invoke: async () => ({ status: "succeeded", output: { action: "final", output: broken } }),
      invokeSkill: async () => ({ status: "succeeded", output: {} }),
    })).rejects.toThrow("runtime.agent_output_invalid");
  });

  it("has its task judged by the runtime over its own skills", () => {
    const { completion, values } = completedValues(nodeId);
    const outcome = evaluateTaskCompletion(completion, values, agent.example);
    expect(outcome.status).toBe(agent.example.requiresHumanReview === true ? "NEEDS_REVIEW" : "COMPLETED");
    // A missing skill result is never completion, whatever the agent says.
    const [first] = completion.criteria;
    const { [first!.nodeId]: _missing, ...partial } = values;
    expect(evaluateTaskCompletion(completion, partial, { ...agent.example, requiresHumanReview: false }).status).toBe("BLOCKED");
  });
});

describe("agents propose; people decide", () => {
  const schemaOf = (id: string) => roster.agents.find((agent) => agent.id === id)!;
  it("decision support can only recommend, always for human review, never final", () => {
    const decision = schemaOf("agent.decision_support");
    expect(valid(decision.outputSchema, { ...decision.example, final: true })).toBe(false);
    expect(valid(decision.outputSchema, { ...decision.example, recommendation: "APPROVE" })).toBe(false);
    expect(valid(decision.outputSchema, { ...decision.example, requiresHumanReview: false })).toBe(false);
    expect(valid(decision.outputSchema, { ...decision.example, disposition: "ACCEPT" })).toBe(false);
  });

  it("screening proposals are never final and always cited", () => {
    const screening = schemaOf("agent.screening");
    const proposal = (screening.example.proposals as Array<Record<string, unknown>>)[0]!;
    expect(valid(screening.outputSchema, { ...screening.example, proposals: [{ ...proposal, final: true }] })).toBe(false);
    expect(valid(screening.outputSchema, { ...screening.example, proposals: [{ ...proposal, sourceRefs: [] }] })).toBe(false);
  });

  it("every agent's findings must cite at least one record", () => {
    for (const agent of roster.agents) {
      const finding = (agent.example.findings as Array<Record<string, unknown>>)[0]!;
      expect(valid(agent.outputSchema, { ...agent.example, findings: [{ ...finding, sourceRefs: [] }] }), agent.id).toBe(false);
    }
  });
});
