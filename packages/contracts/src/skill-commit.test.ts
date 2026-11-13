import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  businessSkillCaseCommands,
  businessSkillProducedObjectTypes,
  caseWriteEntrySchema,
  isHeldSkillGrant,
  librarySkillManifestSchema,
  SKILL_PROPOSAL_COMMANDS,
  skillCommitRequestSchema,
  skillComputationSchema,
  skillGrantsFor,
  skillProposedRecordIssue,
} from "./index.js";

const canonical = (body: Record<string, unknown> = {}) => ({
  record_type: "CanonicalRecord" as const, local_ref: "r1", evidence: [],
  body: {
    object_type: "BeneficialOwner", object_id: "ubo:1", version_id: "v1", data: { entity_id: "p-1" },
    observed_at: "2026-11-07T12:00:00Z", source_refs: [], classification: "CONFIDENTIAL", synthetic: true, ...body,
  },
});

describe("CanonicalRecord proposals (contract amendment to §6.2)", () => {
  it("is a record type the computation schema accepts, with a checked body", () => {
    expect(skillComputationSchema.parse({ business_status: "COMPLETED", payload: {}, metrics: { duration_ms: 1, capability_calls: 0, model_calls: 0 }, proposed_records: [canonical()] })
      .proposed_records[0]!.record_type).toBe("CanonicalRecord");
    expect(skillProposedRecordIssue(canonical())).toBeNull();
    expect(skillProposedRecordIssue(canonical({ provenance: { method: "platform" } }))).toBe("record_body_invalid");
    expect(skillProposedRecordIssue(canonical(), { produces: ["RegistryRecord"] })).toBe("record_object_type_not_declared");
    expect(skillProposedRecordIssue(canonical(), { produces: null })).toBeNull();
    expect(skillProposedRecordIssue(canonical({ synthetic: false }), { requireSynthetic: true })).toBe("record_synthetic_required");
    expect(skillProposedRecordIssue(canonical({ synthetic: false }))).toBeNull();
  });

  it("reads what a manifest says it produces and which case commands it authorizes", () => {
    const catalog = JSON.parse(readFileSync(new URL("../../../config/business-skills.json", import.meta.url), "utf8")) as { skills: Array<{ manifest: unknown }> };
    const library = librarySkillManifestSchema.parse(catalog.skills[0]!.manifest);
    expect(businessSkillProducedObjectTypes(library)).toBeNull();
    expect(businessSkillCaseCommands({ ...library, authorization: ["skill:x.y", "effect:internal_write", "case_command:TransitionCaseStatus", "case_command:Nope", "RequestHumanReview"] }))
      .toEqual(["TransitionCaseStatus"]);
  });
});

describe("skill grants", () => {
  it("follow the pinned effects: records above read-only, effects without approval, held effects with it, never a forbidden command", () => {
    expect(skillGrantsFor(undefined)).toEqual({ proposal: [], effect: [], held: [] });
    expect(skillGrantsFor({ mode: "read_only", approval: "none", caseCommands: [] })).toEqual({ proposal: [], effect: [], held: [] });
    expect(skillGrantsFor({ mode: "proposal", approval: "none", caseCommands: [] })).toEqual({ proposal: [...SKILL_PROPOSAL_COMMANDS], effect: [], held: [] });
    expect(skillGrantsFor({ mode: "internal_write", approval: "none", caseCommands: ["ProposeWorkItem", "RecordReview"] }).effect).toEqual(["ProposeWorkItem"]);
    expect(skillGrantsFor({ mode: "internal_write", approval: "required", caseCommands: ["TransitionCaseStatus"] })).toMatchObject({ effect: [], held: ["TransitionCaseStatus"] });
    expect(caseWriteEntrySchema.safeParse({ commandType: "ProposeClaim", skillGrant: "proposal" }).success).toBe(true);
    expect(caseWriteEntrySchema.safeParse({ commandType: "ProposeClaim", skillGrant: "anything" }).success).toBe(false);
    expect(isHeldSkillGrant({ commandType: "TransitionCaseStatus", skillGrant: "release" })).toBe(true);
    expect(isHeldSkillGrant({ commandType: "ProposeClaim", skillGrant: "proposal" })).toBe(false);
  });

  it("a commit with effects names the case sequence, and held effects name their release node", () => {
    const base = {
      tenantId: "t", caseId: "c", effectMode: "internal_write", approval: "required", commands: [], uncommitted: [], releaseNodeId: null, approvalNodeId: null,
      binding: { skillId: "case.close", skillVersion: "0.2.0", executionId: "e", manifestDigest: "a".repeat(64), bundleDigest: `sha256:${"b".repeat(64)}`,
        receiptDigest: "c".repeat(64), requestDigest: "d".repeat(64), contextHash: "e", codeDigest: null, instructionsDigest: null },
    };
    const held = [{ effectKey: "k", type: "case_command", commandType: "TransitionCaseStatus", payload: {}, justificationRefs: [], expiresAt: "2026-11-08T00:00:00Z" }];
    expect(skillCommitRequestSchema.safeParse({ ...base, held }).error?.issues.map((issue) => issue.message)).toEqual(
      expect.arrayContaining(["skill_commit.release_node_required", "skill_commit.expected_sequence_required"]));
    expect(skillCommitRequestSchema.safeParse({ ...base, held, expectedCaseSequence: 3, releaseNodeId: "x-effects", approvalNodeId: "x-approval" }).success).toBe(true);
    expect(skillCommitRequestSchema.safeParse({ ...base, held: [{ ...held[0], action: "regulatory.filing.submit" }], expectedCaseSequence: 3, releaseNodeId: "r", approvalNodeId: "a" }).success).toBe(false);
  });
});
