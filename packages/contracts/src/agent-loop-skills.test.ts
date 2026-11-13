import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  agentLoopActionSchema, agentLoopConfigSchema, agentTaskCompletionSchema, checkSkillSelection, evaluateTaskCompletion, harnessPlanV2Schema,
  loopSkillForNode, skillBindingForNode, skillBindingsForNode, type HarnessPlanV2,
} from "./index.js";

// Agent loop skills and task completion (agentic plan phase 1), on production slice 1's plan.
const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(fileURLToPath(new URL("../../../artifacts/kyb-screening.plan.json", import.meta.url)), "utf8"))) as HarnessPlanV2;

describe("skill bindings a node may invoke", () => {
  it("a skill node has its own skill; an agent loop node has exactly its loop skills", () => {
    expect(skillBindingForNode(plan, "screening-sanctions-execute")?.skillId).toBe("screening.sanctions.execute");
    expect(skillBindingForNode(plan, "screening-review")).toBeNull();
    expect(skillBindingForNode(plan, "screening-review", "screening.pep.relationship.resolve")?.skillId).toBe("screening.pep.relationship.resolve");
    // Pinned in the plan, but not one of this node's skills.
    expect(skillBindingForNode(plan, "screening-review", "screening.sanctions.execute")).toBeNull();
    expect(skillBindingForNode(plan, "ownership-review", "screening.pep.relationship.resolve")).toBeNull();
    expect(skillBindingsForNode(plan, "screening-review").map((binding) => binding.skillId)).toEqual(["screening.pep.relationship.resolve", "screening.sanctions.control.evaluate"]);
    expect(loopSkillForNode(plan, "screening-review", "screening.sanctions.control.evaluate")?.contextSelectorIds.length).toBeGreaterThan(0);
  });

  it("the gateway's selection check accepts a loop skill's pinned candidate and refuses a skill the node lacks", () => {
    const binding = skillBindingForNode(plan, "screening-review", "screening.pep.relationship.resolve")!;
    const candidate = binding.candidates[0]!;
    const selection = { skillId: binding.skillId, skillVersion: binding.semver, selectedCapabilityId: candidate.capabilityId, selectedConnectorId: candidate.connectorId, candidateIndex: 0, reason: "agent_selected" };
    expect(checkSkillSelection(plan, "screening-review", candidate.capabilityId, selection as never)).toEqual(candidate);
    const other = skillBindingForNode(plan, "screening-sanctions-execute")!;
    expect(() => checkSkillSelection(plan, "screening-review", other.candidates[0]!.capabilityId, {
      ...selection, skillId: other.skillId, skillVersion: other.semver, selectedCapabilityId: other.candidates[0]!.capabilityId, selectedConnectorId: other.candidates[0]!.connectorId,
    } as never)).toThrow("skill.selection_skill_mismatch");
  });
});

describe("loop configuration and protocol", () => {
  it("a loop must call something and may not list a skill twice; call_skill names a skill and parameters", () => {
    expect(agentLoopConfigSchema.safeParse({ maxSteps: 2 }).success).toBe(false);
    expect(agentLoopConfigSchema.safeParse({ maxSteps: 2, skills: [{ skillId: "a.b" }, { skillId: "a.b" }] }).success).toBe(false);
    expect(agentLoopConfigSchema.parse({ maxSteps: 2, skills: [{ skillId: "a.b" }] })).toMatchObject({ tools: [], skills: [{ skillId: "a.b", parameters: {}, contextSelectorIds: [], purpose: "onboarding" }] });
    expect(agentLoopActionSchema.parse({ action: "call_skill", skill: "a.b" })).toEqual({ action: "call_skill", skill: "a.b", parameters: {} });
    expect(agentLoopActionSchema.safeParse({ action: "call_skill", skill: "a.b", input: {} }).success).toBe(false);
  });
});

describe("task completion", () => {
  const completion = agentTaskCompletionSchema.parse({
    criteria: [
      { nodeId: "sanctions", acceptedStatuses: ["COMPLETED"], requiredPayloadFields: ["hits", "coverage"] },
      { nodeId: "pep", acceptedStatuses: ["COMPLETED"], requiredPayloadFields: ["hits"] },
    ],
  });
  const skill = (status: string, payload: Record<string, unknown> = { hits: [], coverage: [] }) => ({ lifecycle: "COMPLETED_EXECUTION", computation: { business_status: status, payload } });

  it("is COMPLETED only when every criterion's status and fields hold", () => {
    expect(evaluateTaskCompletion(completion, { sanctions: skill("COMPLETED"), pep: skill("COMPLETED") }).status).toBe("COMPLETED");
  });

  it("maps failures through the failure policy and keeps the most severe outcome", () => {
    expect(evaluateTaskCompletion(completion, { sanctions: skill("NEEDS_REVIEW"), pep: skill("COMPLETED") }).status).toBe("NEEDS_REVIEW");
    expect(evaluateTaskCompletion(completion, { sanctions: skill("COMPLETED", { hits: [] }), pep: skill("COMPLETED") })).toMatchObject({
      status: "NEEDS_EVIDENCE", criteria: [{ nodeId: "sanctions", passed: false, missingFields: ["coverage"] }, { nodeId: "pep", passed: true }] });
    // The platform answered NEEDS_EVIDENCE without calling the skill.
    expect(evaluateTaskCompletion(completion, { sanctions: { status: "NEEDS_EVIDENCE" }, pep: skill("NEEDS_REVIEW") }).status).toBe("NEEDS_EVIDENCE");
    // A missing or failed node is an unavailable source, and outranks everything else.
    expect(evaluateTaskCompletion(completion, { sanctions: skill("NEEDS_REVIEW") }).status).toBe("BLOCKED");
    expect(evaluateTaskCompletion(completion, { sanctions: { __workflowRejected: true }, pep: skill("COMPLETED") }).status).toBe("BLOCKED");
  });

  it("lets an agent raise a completed task to review, never lower an outcome", () => {
    const values = { sanctions: skill("COMPLETED"), pep: skill("COMPLETED") };
    expect(evaluateTaskCompletion(completion, values, { requiresHumanReview: true }).status).toBe("NEEDS_REVIEW");
    expect(evaluateTaskCompletion(completion, { sanctions: skill("NEEDS_EVIDENCE"), pep: skill("COMPLETED") }, { requiresHumanReview: false, status: "COMPLETED" }).status).toBe("NEEDS_EVIDENCE");
  });

  it("reads proposed records where the skill host puts them, beside the payload", () => {
    const extraction = agentTaskCompletionSchema.parse({ criteria: [{ nodeId: "extract", acceptedStatuses: ["COMPLETED"], requiredPayloadFields: ["extractions", "proposed_records"] }],
      failurePolicy: { ambiguous_evidence: "NEEDS_REVIEW", missing_required_evidence: "NEEDS_EVIDENCE", unavailable_required_source: "BLOCKED" } });
    // skill.execution.v1 as the host returns it: proposed_records lifted out of the payload.
    const hosted = { lifecycle: "COMPLETED_EXECUTION", computation: { business_status: "COMPLETED", payload: { extractions: [] }, proposed_records: [] } };
    expect(evaluateTaskCompletion(extraction, { extract: hosted }).status).toBe("COMPLETED");
    // Absent from both places is still missing.
    expect(evaluateTaskCompletion(extraction, { extract: { ...hosted, computation: { business_status: "COMPLETED", payload: { extractions: [] } } } }).criteria[0]!.missingFields).toEqual(["proposed_records"]);
  });

  it("uses the slice's completion criteria from the library task specs", () => {
    const node = plan.graph.nodes.find((item) => item.id === "screening-review")!;
    const parsed = agentTaskCompletionSchema.parse(node.config.completion);
    expect(parsed.criteria.map((criterion) => criterion.nodeId)).toEqual(["screening-sanctions-execute", "screening-pep-execute", "screening-match-disambiguate"]);
    expect(parsed.failurePolicy).toEqual({ ambiguous_evidence: "NEEDS_REVIEW", missing_required_evidence: "NEEDS_EVIDENCE", unavailable_required_source: "BLOCKED" });
  });
});
