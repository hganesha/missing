import { describe, expect, it } from "vitest";
import { businessDecisionResultSchema, CONTROL_PLANE_COMMANDS, SUPERVISORY_COMMANDS, humanChoiceSatisfied, humanRequirementSchema, isProtectedBusinessCommand, PROTECTED_BUSINESS_COMMANDS, roleQuorumsMet } from "./business-decisions.js";
import { businessCommandTypeSchema } from "./index.js";

describe("business authority boundaries", () => {
  it("requires an explicit authority classification for every case command",()=>{
    const observations=["AddSubject","LinkEvidence","ProposeClaim","RecordScreeningFinding","RecordAssumption","RaiseContradiction",
      "LinkExecution","SubmitDecisionRecommendation","RecordPolicyEvaluation","RecordCanonicalRecords","RecordFinancialCrimeOutcome"];
    expect([...PROTECTED_BUSINESS_COMMANDS,...CONTROL_PLANE_COMMANDS,...SUPERVISORY_COMMANDS,...observations].sort()).toEqual([...businessCommandTypeSchema.options].sort());
    expect(new Set([...PROTECTED_BUSINESS_COMMANDS,...CONTROL_PLANE_COMMANDS,...SUPERVISORY_COMMANDS,...observations]).size).toBe(businessCommandTypeSchema.options.length);
    expect(isProtectedBusinessCommand("ReplanCase")).toBe(false);
    expect(isProtectedBusinessCommand("AssignCase")).toBe(false);
  });
  it("treats activated work as protected while observations and recommendations remain proposals", () => {
    for (const action of ["ProposeWorkItem", "FinalizeDisposition", "AcceptClaimAsFact", "RequestHumanReview", "RecordReview"]) expect(isProtectedBusinessCommand(action)).toBe(true);
    for (const action of ["SubmitDecisionRecommendation", "RecordScreeningFinding", "ProposeClaim", "RaiseContradiction", "LinkEvidence"]) expect(isProtectedBusinessCommand(action)).toBe(false);
  });
  it("a needs-human/evidence/unresolved state cannot authorize a disposition", () => {
    for (const state of ["NEEDS_HUMAN", "NEEDS_EVIDENCE", "UNRESOLVED", "NOT_APPLICABLE"]) {
      expect(businessDecisionResultSchema.safeParse({ state, reasonCodes: ["GAP"], ruleIds: [], gaps: [], humanRequirement: null,
        actions: [{ kind: "case_command", commandType: "FinalizeDisposition", payload: { outcome: "APPROVED" } }] }).success).toBe(false);
    }
  });
  it("unknown commands and duplicate reason references cannot silently widen authority", () => {
    expect(businessDecisionResultSchema.safeParse({ state: "DECIDED", reasonCodes: ["OK", "OK"], ruleIds: [], gaps: [], humanRequirement: null,
      actions: [{ kind: "case_command", commandType: "ExecuteAnything", payload: {} }] }).success).toBe(false);
  });
  it("only a decided result carries derived outputs", () => {
    const outputs = { diligence: { level: "EDD", baseLevel: "CDD", partyType: "trust", products: ["payments"], requirements: ["EVD-SOURCE-OF-FUNDS"],
      contributors: [{ kind: "cell", id: "diligence.cell.trust.payments", level: "CDD" }, { kind: "overlay", id: "overlay.pep", level: "EDD" }] } };
    const base = { reasonCodes: ["DILIGENCE_LEVEL_EDD"], ruleIds: [], actions: [], humanRequirement: null, gaps: [], outputs };
    expect(businessDecisionResultSchema.safeParse({ state: "DECIDED", ...base }).success).toBe(true);
    expect(businessDecisionResultSchema.safeParse({ state: "UNRESOLVED", ...base }).success).toBe(false);
    expect(businessDecisionResultSchema.safeParse({ state: "DECIDED", ...base, outputs: { diligence: { ...outputs.diligence, contributors: [] } } }).success).toBe(false);
  });
});

describe("approvals by several roles", () => {
  const voter = (principalId: string, roles: string[], choice = "APPROVE") => ({ principalId, roles, choice });
  it("fills each role's slots with distinct people", () => {
    const quorums = { "Case.Reviewer": 2, "Compliance.Officer": 1 };
    expect(roleQuorumsMet(quorums, [voter("a", ["Case.Reviewer"]), voter("b", ["Case.Reviewer"]), voter("c", ["Compliance.Officer"])])).toBe(true);
    // One person holding both roles counts once.
    expect(roleQuorumsMet(quorums, [voter("a", ["Case.Reviewer", "Compliance.Officer"]), voter("b", ["Case.Reviewer"])])).toBe(false);
    // A person with both roles goes where they are needed.
    expect(roleQuorumsMet(quorums, [voter("a", ["Case.Reviewer", "Compliance.Officer"]), voter("b", ["Case.Reviewer"]), voter("c", ["Case.Reviewer"])])).toBe(true);
    expect(roleQuorumsMet(quorums, [voter("a", ["Case.Reviewer"]), voter("a", ["Case.Reviewer"]), voter("c", ["Compliance.Officer"])])).toBe(false);
  });

  it("satisfies a choice only with its own votes, the total and every role's quorum", () => {
    const requirement = { quorum: 3, roleQuorums: { "Case.Reviewer": 2, "Compliance.Officer": 1 } };
    const votes = [voter("a", ["Case.Reviewer"]), voter("b", ["Case.Reviewer"]), voter("c", ["Compliance.Officer"]), voter("d", ["Case.Reviewer"], "REJECT")];
    expect(humanChoiceSatisfied(requirement, votes, "APPROVE")).toBe(true);
    expect(humanChoiceSatisfied(requirement, votes, "REJECT")).toBe(false);
    expect(humanChoiceSatisfied({ quorum: 2 }, [voter("a", []), voter("b", [])], "APPROVE")).toBe(true);
  });

  it("refuses role quorums for roles the requirement does not name, or above its total", () => {
    const base = { roles: ["Case.Reviewer"], quorum: 2, independentOfProposer: true, allowedChoices: ["APPROVE"], actionIntents: { APPROVE: [] }, ttlSeconds: 60 };
    expect(humanRequirementSchema.safeParse({ ...base, roleQuorums: { "Case.Reviewer": 2 } }).success).toBe(true);
    expect(humanRequirementSchema.safeParse({ ...base, roleQuorums: { "Compliance.Officer": 1 } }).success).toBe(false);
    expect(humanRequirementSchema.safeParse({ ...base, roleQuorums: { "Case.Reviewer": 3 } }).success).toBe(false);
  });
});
