import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AGENT_PROFILE_DEFAULT_LIMITS,
  PLAN_V2_AGENT_PROFILES_REQUIRED,
  agentProfileForNode,
  harnessPlanV2Schema,
  packageAgentProfileSchema,
  verifyPlanV2Digest,
} from "./index.js";

const kycPlanJson = () => JSON.parse(readFileSync(new URL("../test-fixtures/agent-profiles.plan.json", import.meta.url), "utf8")) as Record<string, unknown>;

describe("agent profiles", () => {
  it("admits a compiled v2 plan whose agents are agent profiles", () => {
    const plan = harnessPlanV2Schema.parse(kycPlanJson());
    expect(verifyPlanV2Digest(plan)).toBe(true);
    expect(plan.compiler.compatibilityVersion).toBe("4");
    const investigation = agentProfileForNode(plan, "kyc-investigation")!;
    expect(investigation.id).toBe("agent.kyc.investigation.v1");
    expect(investigation.allowedCapabilities).toContain("model.kyc.investigation.v1");
    expect(investigation.instructions.map((instruction) => instruction.id)).toEqual(["skill.kyc.investigation.v1"]);
    expect(investigation.limits).toEqual({ maxSteps: 8, maxObservationChars: 12_000 });
    expect(agentProfileForNode(plan, "sanctions-screen")).toBeNull();
  });

  it("refuses a v2 plan that still carries skills and agents, naming the fix", () => {
    const { agentProfiles: _profiles, ...rest } = kycPlanJson();
    const legacy = { ...rest, skills: [], agents: [] };
    const result = harnessPlanV2Schema.safeParse(legacy);
    expect(result.success).toBe(false);
    const messages = result.error!.issues.map((issue) => issue.message);
    expect(messages.some((message) => message.startsWith(PLAN_V2_AGENT_PROFILES_REQUIRED))).toBe(true);
    expect(messages.join("\n")).toContain("recompile");
    expect(PLAN_V2_AGENT_PROFILES_REQUIRED).toBe("plan.v2_agent_profiles_required");
  });

  it("refuses retired node skillRefs and dangling agent references", () => {
    const withSkillRefs = kycPlanJson();
    const nodes = (withSkillRefs.graph as { nodes: Array<{ id: string; config: Record<string, unknown> }> }).nodes;
    nodes.find((node) => node.id === "case-assessment")!.config.skillRefs = ["skill.kyc.case-assessment.v2"];
    expect(harnessPlanV2Schema.safeParse(withSkillRefs).error?.issues.map((issue) => issue.message).join("\n"))
      .toContain(PLAN_V2_AGENT_PROFILES_REQUIRED);

    const dangling = kycPlanJson();
    (dangling.graph as { nodes: Array<{ id: string; config: Record<string, unknown> }> }).nodes
      .find((node) => node.id === "case-assessment")!.config.agentRef = "agent.kyc.missing.v1";
    expect(harnessPlanV2Schema.safeParse(dangling).error?.issues.map((issue) => issue.message)).toContain("plan.agent_profile_missing");
  });

  it("resolves a node's profile only at the pinned version", () => {
    const plan = harnessPlanV2Schema.parse(kycPlanJson());
    const node = plan.graph.nodes.find((candidate) => candidate.id === "case-assessment")!;
    node.config.agentVersion = "9.9.9";
    expect(() => agentProfileForNode(plan, "case-assessment")).toThrow("agent_profile.version_mismatch");
  });

  it("parses the authored form with defaults and refuses an authored allowedCapabilities", () => {
    const authored = {
      id: "agent.test.v1", version: "1.0.0", name: "Test", description: "Test agent", role: "Tester", prompt: "Test.",
      modelProfileId: "model.standard.v1", runtimeTarget: "hosted_http", inputSchema: { type: "object" }, outputSchema: { type: "object" },
      instructions: [{ id: "instruction.test.v1", version: "1.0.0", name: "Test", description: "Test", text: "Do the test." }],
    };
    const parsed = packageAgentProfileSchema.parse({ ...authored, limits: {} });
    expect(parsed.instructions[0]!.allowedCapabilityIds).toEqual([]);
    expect(parsed.allowedSkills).toEqual([]);
    expect(parsed.purposes).toEqual([]);
    expect(parsed.limits).toEqual(AGENT_PROFILE_DEFAULT_LIMITS);
    expect(packageAgentProfileSchema.safeParse({ ...authored, allowedCapabilities: ["model.x"] }).success).toBe(false);
    expect(packageAgentProfileSchema.safeParse({ ...authored, instructions: [{ ...authored.instructions[0], text: "" }] }).success).toBe(false);
    expect(packageAgentProfileSchema.safeParse({ ...authored, limits: { maxSteps: 21 } }).success).toBe(false);
  });
});
