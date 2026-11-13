import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { compilePackage } from "./compiler.js";
import { CompilerError } from "./errors.js";
import { modelProfilesPath, repositoryRoot, writeFixture } from "./test-support.js";

// harnessc rules for agent loop skills and task completion (agentic plan phase 1), exercised on a
// scratch copy of production slice 1 with one thing changed at a time.
const source = join(repositoryRoot, "domains/kyb-screening");
type Node = { id: string; config: Record<string, any>; contextSelectorIds: string[] };
type Workflow = { spec: { nodes: Node[] } };

function compileWith(mutate: (workflow: Workflow) => void): string {
  const workflow = parse(readFileSync(join(source, "workflow.yaml"), "utf8")) as Workflow;
  mutate(workflow);
  const directory = writeFixture("loop-skills", {
    "package.yaml": readFileSync(join(source, "package.yaml"), "utf8"),
    "workflow.yaml": stringify(workflow),
  });
  try {
    compilePackage(directory, { modelProfiles: modelProfilesPath });
    return "compiled";
  } catch (error) {
    if (error instanceof CompilerError) return error.message;
    throw error;
  }
}
const node = (workflow: Workflow, id: string) => workflow.spec.nodes.find((item) => item.id === id)!;
const firstLoopSkill = (workflow: Workflow) => node(workflow, "screening-review").config.loop.skills[0];

describe("agent loop skills", () => {
  it("the slice compiles as committed", () => {
    expect(compileWith(() => {})).toBe("compiled");
  });

  it("refuses a skill the package does not bind", () => {
    expect(compileWith((w) => { firstLoopSkill(w).skillId = "not.a.skill"; })).toContain("workflow.loop_skill_undeclared:screening-review:not.a.skill");
  });

  it("refuses a skill with write effects: a loop skill's result is an observation and commits nothing", () => {
    expect(compileWith((w) => { firstLoopSkill(w).skillId = "decision.human.review"; })).toContain("workflow.loop_skill_not_read_only:screening-review:decision.human.review");
  });

  it("refuses a skill outside the agent profile, even when the package binds it", () => {
    expect(compileWith((w) => { firstLoopSkill(w).skillId = "ownership.circular.detect"; }))
      .toContain("workflow.loop_skill_not_allowed_by_agent_profile:screening-review:ownership.circular.detect");
  });

  it("refuses a skill that reads a selector the node does not read", () => {
    expect(compileWith((w) => { firstLoopSkill(w).contextSelectorIds = ["recOwnershipInterest-ownership-graph-build"]; }))
      .toContain("workflow.loop_skill_selector_not_on_node:screening-review:screening.pep.relationship.resolve");
  });

  it("refuses an unknown loop skill field and a duplicate skill", () => {
    expect(compileWith((w) => { firstLoopSkill(w).input = {}; })).toContain("workflow.loop_skill_field_unknown:screening-review:screening.pep.relationship.resolve:input");
    expect(compileWith((w) => { const loop = node(w, "screening-review").config.loop; loop.skills.push({ ...loop.skills[0] }); }))
      .toContain("workflow.loop_skill_duplicate:screening-review:screening.pep.relationship.resolve");
  });
});

describe("task completion", () => {
  const criteria = (w: Workflow) => node(w, "screening-review").config.completion.criteria;

  it("refuses a criterion on a node that is not a skill node", () => {
    expect(compileWith((w) => { criteria(w)[0].nodeId = "acquire-sanctions"; })).toContain("workflow.completion_target_not_skill_node:screening-review:acquire-sanctions");
  });

  it("refuses a criterion on another agent's skill node", () => {
    expect(compileWith((w) => { criteria(w)[0].nodeId = "entity-resolve"; })).toContain("workflow.completion_target_other_agent:screening-review:entity-resolve");
  });

  it("refuses completion on a node without a loop, and on a node that is not an agent", () => {
    expect(compileWith((w) => {
      const tool = node(w, "screening-pep-execute");
      tool.config.completion = node(w, "screening-review").config.completion;
    })).toContain("workflow.completion_node_kind_invalid:screening-pep-execute");
  });
});
