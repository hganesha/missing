import { describe, expect, it } from "vitest";
import { bindingValue, skillParametersFor } from "./hosted-skill.js";

const node = (config: Record<string, unknown>) => ({ id: "n", kind: "tool", name: "n", contextSelectorIds: [], config }) as never;
const screened = { "screening-sanctions-execute": { computation: { payload: { hits: [
  { entity_id: "e-b1", entry_id: "w1" }, { entity_id: "e-b2", entry_id: "w2" }, { entity_id: "e-b1", entry_id: "w3" }, { entry_id: "w4" },
] } } } };

describe("skill parameter bindings", () => {
  it("project a list with [*], without duplicates and skipping items that lack the field", () => {
    expect(bindingValue("screening-sanctions-execute.payload.hits[*].entity_id", screened)).toEqual(["e-b1", "e-b2"]);
    expect(bindingValue("screening-sanctions-execute.payload.hits[*]", screened)).toHaveLength(4);
  });

  it("give an empty list for an empty array but stay unresolved when the predecessor or array is absent", () => {
    expect(bindingValue("s.payload.hits[*].entity_id", { s: { computation: { payload: { hits: [] } } } })).toEqual([]);
    expect(bindingValue("s.payload.hits[*].entity_id", {})).toBeUndefined();
    expect(bindingValue("s.payload.hits[*].entity_id", { s: { computation: { payload: { hits: "x" } } } })).toBeUndefined();
    expect(() => bindingValue("s.payload.a[*].b[*].c", {})).toThrow("runtime.skill_binding_projection_nested");
  });

  it("bind a projected list as a parameter; an absent source is reported unresolved", () => {
    const config = { skillParameters: { blocked_ids: ["authored-fallback"] }, skillParameterBindings: { blocked_ids: "screening-sanctions-execute.payload.hits[*].entity_id" }, requireBoundParameters: true };
    expect(skillParametersFor(node(config), screened)).toEqual({ parameters: { blocked_ids: ["e-b1", "e-b2"] }, unresolvedBindings: [], required: true });
    expect(skillParametersFor(node(config), {})).toEqual({ parameters: {}, unresolvedBindings: ["blocked_ids"], required: true });
  });

  it("leave an optional fact absent instead of failing the node, while required bindings still fail it", () => {
    const config = {
      skillParameters: { facts: { due_diligence: "standard" } }, requireBoundParameters: true,
      skillParameterBindings: { "facts.sanctions_hits": "screening-sanctions-execute.payload.hits[*].entity_id", "facts.tier": "risk-tier-assign.payload.tier", target: "missing.payload.id" },
      optionalParameterBindings: ["facts.sanctions_hits", "facts.tier"],
    };
    expect(skillParametersFor(node(config), screened)).toEqual({
      parameters: { facts: { due_diligence: "standard", sanctions_hits: ["e-b1", "e-b2"] } }, unresolvedBindings: ["target"], required: true,
    });
  });

  it("resolve plain paths as before", () => {
    expect(bindingValue("r.payload.tier", { r: { computation: { payload: { tier: "HIGH" } } } })).toBe("HIGH");
    expect(bindingValue("acquire-ownership.subjectEntityId", { "acquire-ownership": { subjectEntityId: "e-1" } })).toBe("e-1");
  });
});
