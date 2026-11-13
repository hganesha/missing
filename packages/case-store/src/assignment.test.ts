import { describe, expect, it } from "vitest";
import { standingFrom } from "./assignment.js";

describe("case standing", () => {
  const assignment = { teamId: "kyb", assignees: ["r.okafor"] };
  it("names the person assigned, then the team, and nobody else", () => {
    expect(standingFrom(assignment, new Set(["kyb"]), "r.okafor")).toBe("assigned");
    expect(standingFrom(assignment, new Set(["kyb"]), "l.nakamura")).toBe("team");
    expect(standingFrom(assignment, new Set(["other"]), "s.varga")).toBe("none");
    expect(standingFrom(assignment, new Set(), "s.varga")).toBe("none");
  });
  it("keeps a named person's standing even when they are no longer in the team", () => {
    expect(standingFrom(assignment, new Set(), "r.okafor")).toBe("assigned");
  });
  it("treats a case with no assignment as open, not as closed", () => {
    expect(standingFrom(null, new Set(), "anyone")).toBe("unassigned");
    expect(standingFrom(undefined, new Set(["kyb"]), "anyone")).toBe("unassigned");
  });
});
