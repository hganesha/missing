import { describe, expect, it } from "vitest";
import { acquisitionSubjects, acquireSubjects } from "./subject-acquisition.js";

const config = { subjectsSelector: "subjects", entitiesSelector: "entities", maxSubjects: 5 };
const selection = { subjects: [{ subject_id: "customer", display_name: "Company", subject_type: "organization" }, { subject_id: "joint", display_name: "Joint holder", subject_type: "individual" }],
  entities: [{ object_id: "ubo", data: { name: "Owner", entity_type: "individual" } }] };

describe("per-party acquisition", () => {
  it("includes joint holders and discovered owners in stable subject order", () => {
    expect(acquisitionSubjects(config, selection).map((s) => [s.subjectId, s.schema])).toEqual([["customer", "Company"], ["joint", "Person"], ["ubo", "Person"]]);
  });
  it("does not merge different parties with the same name", () => {
    expect(acquisitionSubjects(config, { subjects: [{ subject_id: "a", display_name: "Same" }, { subject_id: "b", display_name: "Same" }] })).toHaveLength(2);
  });
  it("rejects ambiguous identities and over-budget scopes without truncation", () => {
    expect(() => acquisitionSubjects({ ...config, maxSubjects: 1 }, selection)).toThrow("budget_exceeded");
    expect(() => acquisitionSubjects(config, { subjects: [{ subject_id: "a", display_name: "A" }, { subject_id: "a", display_name: "B" }] })).toThrow("identity_conflict");
  });
  it("retains an outage as an explicit gap while retaining completed negative searches", async () => {
    const calls: unknown[] = [];
    const result = await acquireSubjects(config, selection, async (input) => {
      calls.push(input);
      if (input.subjectId === "ubo") throw new Error("unavailable");
      return { status: "OK", records: [], alerts: [] };
    });
    expect(calls).toHaveLength(3);
    expect(result).toMatchObject({ status: "PARTIAL", outcome: "inconclusive", recordGap: { code: "EVIDENCE_GAP" } });
    expect(result.subjectResults).toHaveLength(3);
  });
});
