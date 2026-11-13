import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { harnessPlanV2Schema, skillCapabilityOutputV1Schema, type HarnessPlanV2, type PlanSkillBinding } from "@ehf/contracts";
import { planSkillCommit, routedExternalActions, skillApprovalDecisionFrom, skillReleaseNodeFor } from "./skill-commit.js";

const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../contracts/test-fixtures/skill-commit.plan.json", import.meta.url), "utf8")));
const bindingOf = (skillId: string) => plan.skillBindings!.find((item) => item.skillId === skillId)! as PlanSkillBinding;
const NOW = Date.parse("2026-11-07T12:00:00Z");

function output(skillId: string, computation: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  const binding = bindingOf(skillId);
  return skillCapabilityOutputV1Schema.parse({
    contract_version: "skill.execution.v1", execution_id: "RUN-1:node:abc", skill_id: skillId, skill_version: binding.semver,
    bundle_digest: binding.bundleDigest, manifest_digest: binding.manifestDigest, effect_mode: binding.effects!.mode, lifecycle: "COMPLETED_EXECUTION",
    computation: { business_status: "COMPLETED", payload: {}, proposed_records: [], unresolved_items: [], negative_searches: [], requested_effects: [],
      metrics: { duration_ms: 1, capability_calls: 0, model_calls: 0 }, ...computation },
    error: null, trace: { subskill_executions: [] }, dependency_receipts: [], ...overrides,
  });
}

function planFor(nodeId: string, skillId: string, computation: Record<string, unknown>, extra: { snapshotSequence?: number | null; overrides?: Record<string, unknown>; plan?: HarnessPlanV2 } = {}) {
  return planSkillCommit({
    plan: extra.plan ?? plan, nodeId, binding: bindingOf(skillId), output: output(skillId, computation, extra.overrides), tenantId: "t1", caseId: "c1",
    receiptDigest: "f".repeat(64), requestDigest: "e".repeat(64), contextHash: "d".repeat(64),
    snapshotSequence: extra.snapshotSequence === undefined ? 7 : extra.snapshotSequence, evidenceId: "ev_1", now: NOW,
  });
}

const record = (record_type: string, local_ref: string, body: Record<string, unknown>) => ({ record_type, local_ref, body, evidence: [] });

describe("skill output → case commands (§6.2)", () => {
  it("maps every record type to its command with deterministic ids and the skill-computation evidence", () => {
    const request = planFor("ubo-propose", "sample.ubo.propose", { proposed_records: [
      record("Assertion", "a1", { subject_ref: "entity:E-1", predicate: "registered_name", value: "Meridian", confidence: 0.9 }),
      record("Fact", "fa1", { predicate: "registered", value: true, verification_criteria: ["registry receipt"] }),
      record("Finding", "f1", { finding_type: "UBO_IDENTIFIED", reason: "40% holder", policy_relevance: "KYB-UBO" }),
      record("RiskIndicator", "r1", { finding_type: "HIGH_RISK_JURISDICTION", reason: "listed" }),
      record("Conflict", "c1", { object_refs: ["entity:A", "entity:B"], description: "Names differ", materiality: "HIGH" }),
      record("UnresolvedQuestion", "q1", { question: "Who controls the trust?", priority: "HIGH" }),
      record("Hypothesis", "h1", { guess: "nominee" }),
    ] });
    expect(request.commands.map((command) => [command.localRef, command.commandType])).toEqual([
      ["evidence", "LinkEvidence"], ["record:a1", "ProposeClaim"], ["record:fa1", "ProposeClaim"], ["record:f1", "RecordScreeningFinding"],
      ["record:r1", "RecordScreeningFinding"], ["record:c1", "RaiseContradiction"], ["record:q1", "ProposeWorkItem"],
    ]);
    const payload = (ref: string) => request.commands.find((command) => command.localRef === ref)!.payload;
    expect(payload("evidence")).toEqual({ evidenceId: "ev_1", purpose: "SKILL_COMPUTATION" });
    expect(payload("record:a1")).toMatchObject({ claimId: expect.stringMatching(/^claim_skill_[a-f0-9]{24}$/), subjectRef: "entity:E-1", predicate: "registered_name",
      value: "Meridian", confidence: { value: 0.9, method: "skill:sample.ubo.propose@0.1.0" }, evidenceRefs: ["ev_1"] });
    // A Fact is only a proposal with verification criteria: it becomes a fact through AcceptClaimAsFact.
    expect(payload("record:fa1")).toMatchObject({ value: { asserted: true, verificationCriteria: ["registry receipt"] } });
    expect(payload("record:f1")).toMatchObject({ findingType: "UBO_IDENTIFIED", reason: "40% holder", policyRelevance: "KYB-UBO", evidenceRefs: ["ev_1"], factRefs: [] });
    expect(payload("record:c1")).toMatchObject({ objectRefs: ["entity:A", "entity:B"], materiality: "HIGH", detectionMethod: "skill:sample.ubo.propose@0.1.0" });
    expect(payload("record:q1")).toMatchObject({ workType: "SKILL_UNRESOLVED_QUESTION", description: "Who controls the trust?", priority: "HIGH" });
    expect(request.uncommitted).toEqual([{ localRef: "h1", recordType: "Hypothesis", reason: "record_type_not_committed" }]);
    expect(request.held).toEqual([]);
    expect(request.expectedCaseSequence).toBeUndefined();
    // Same execution, same ids: a replay maps to the same commands.
    expect(planFor("ubo-propose", "sample.ubo.propose", { proposed_records: [record("Assertion", "a1", { predicate: "registered_name", value: "x" })] }).commands[1]!.payload.claimId)
      .toBe(payload("record:a1").claimId);
  });

  it("refuses what the plan does not grant: a read-only skill's records, an effect mode that is not the pin, an unknown body", () => {
    expect(() => planFor("ubo-review", "sample.ubo.review", { proposed_records: [record("Finding", "f1", { finding_type: "X_Y", reason: "r" })] }))
      .toThrow("skill.commit_records_not_granted");
    expect(() => planFor("ubo-propose", "sample.ubo.propose", {}, { overrides: { effect_mode: "internal_write" } })).toThrow("skill.commit_effect_mode_unpinned");
    expect(() => planFor("ubo-propose", "sample.ubo.propose", { proposed_records: [record("Finding", "f1", { finding: "lowercase" })] }))
      .toThrow("skill.commit_record_body_invalid:f1");
  });
});

describe("document extraction proposals (EHF wrapper document.fields.contract_extract)", () => {
  // Emitted by apps/fincrime-host for the synthetic certificate (tests/test_skill_host.py exercises the host side).
  const proposals = JSON.parse(readFileSync(new URL("../test-fixtures/document-extraction-proposals.json", import.meta.url), "utf8")) as Array<Record<string, unknown>>;

  it("commit an extracted value as an ExtractedAssertion record version and its review as a work item, never as a fact", () => {
    const request = planFor("ubo-propose", "sample.ubo.propose", { proposed_records: proposals });
    expect(request.commands.map((command) => [command.localRef, command.commandType])).toEqual([
      ["evidence", "LinkEvidence"], ["record:assertion-entity_name", "RecordCanonicalRecords"], ["record:review-entity_name", "ProposeWorkItem"],
    ]);
    const recorded = request.commands[1]!.payload as { records: Array<Record<string, unknown>> };
    expect(recorded.records[0]).toMatchObject({ object_type: "ExtractedAssertion", object_id: "extraction:doc-v1:entity_name",
      data: { field: "entity_name", value: "Acme", document_version: "doc-v1",
        extensions: { "ehf.document": { value: { verification: "UNVERIFIED", review_state: "PENDING_REVIEW", source_spans: [{ quote: "Acme" }] } } } } });
    expect(request.commands[2]!.payload).toMatchObject({ workType: "DOCUMENT_FIELD_REVIEW", description: expect.stringContaining("Review the extracted entity_name") });
    expect(request.commands.map((command) => command.commandType)).not.toContain("AcceptClaimAsFact");
  });
});

describe("requested effects (§6.3)", () => {
  const effect = (command_type: string, payload: Record<string, unknown> = {}, key = "k1") => ({ type: "case_command", command_type, idempotency_key: key, payload, justification_refs: ["f1"] });

  it("holds an approval-required skill's case command for its release node, at the snapshot's case sequence", () => {
    const request = planFor("case-close", "sample.case.close", { requested_effects: [effect("TransitionCaseStatus", { toStatus: "SUSPENDED", reason: "r", expected_case_sequence: 7 })] });
    expect(request).toMatchObject({ approval: "required", expectedCaseSequence: 7, releaseNodeId: "case-close-effects", approvalNodeId: "case-close-approval", commands: [] });
    expect(request.held).toEqual([{ effectKey: "k1", type: "case_command", commandType: "TransitionCaseStatus", payload: { toStatus: "SUSPENDED", reason: "r" },
      justificationRefs: ["f1"], expiresAt: new Date(NOW + 7 * 86_400_000).toISOString() }]);
    expect(planFor("case-close", "sample.case.close", { requested_effects: [effect("TransitionCaseStatus", { expires_at: "2026-11-08T12:00:00Z" })] }).held[0]!.expiresAt)
      .toBe("2026-11-08T12:00:00.000Z");
    expect(() => planFor("case-close", "sample.case.close", { requested_effects: [effect("TransitionCaseStatus", { expires_at: "2027-06-01T00:00:00Z" })] }))
      .toThrow("skill.commit_effect_expiry_invalid:k1");
  });

  it("refuses forbidden or ungranted commands, inconsistent or unknown case sequences, and a held effect without a release node", () => {
    expect(() => planFor("case-close", "sample.case.close", { requested_effects: [effect("FinalizeDisposition")] })).toThrow("skill.commit_effect_forbidden:FinalizeDisposition");
    expect(() => planFor("case-close", "sample.case.close", { requested_effects: [effect("RequestHumanReview")] })).toThrow("skill.commit_effect_not_granted:RequestHumanReview");
    expect(() => planFor("case-close", "sample.case.close", { requested_effects: [
      effect("TransitionCaseStatus", { expected_case_sequence: 7 }, "a"), effect("TransitionCaseStatus", { expected_case_sequence: 8 }, "b")] }))
      .toThrow("skill.commit_effect_case_sequence_inconsistent");
    expect(() => planFor("case-close", "sample.case.close", { requested_effects: [effect("TransitionCaseStatus")] }, { snapshotSequence: null }))
      .toThrow("skill.commit_effect_case_sequence_unknown");
    const withoutRelease = { ...plan, graph: { ...plan.graph, nodes: plan.graph.nodes.filter((node) => node.id !== "case-close-effects") } } as HarnessPlanV2;
    expect(() => planFor("case-close", "sample.case.close", { requested_effects: [effect("TransitionCaseStatus")] }, { plan: withoutRelease }))
      .toThrow("skill.commit_release_node_missing");
    expect(skillReleaseNodeFor(plan, "case-close")).toEqual({ releaseNodeId: "case-close-effects", approvalNodeId: "case-close-approval" });
  });

  it("routes an external action only to an outbound route the plan publishes", () => {
    const published = { ...plan, integrations: { triggers: [], humanActions: [], publications: [{ id: "filings", eventTypes: ["external_action.regulatory.filing.submit"], maximumClassification: "CONFIDENTIAL" }] } } as HarnessPlanV2;
    expect(routedExternalActions(published, ["regulatory.filing.submit", "evidence.retention.delete"])).toEqual(["regulatory.filing.submit"]);
    expect(routedExternalActions(plan, ["regulatory.filing.submit"])).toEqual([]);
  });
});

describe("approval decisions a release presents", () => {
  it("normalizes the durable queue's and the local kernel's outputs, and refuses anything without human authority", () => {
    expect(skillApprovalDecisionFrom({ decision: "APPROVE", authority: "HUMAN", decisionIds: ["d1", "d2"], reviewerPrincipalId: "r1", reviewerPrincipalIds: ["r1", "r2"], reasonCode: "ok", rationale: "fine" }))
      .toEqual({ decision: "APPROVE", authority: "HUMAN", decisionIds: ["d1", "d2"], reviewerPrincipalIds: ["r1", "r2"], reasonCode: "ok" });
    expect(skillApprovalDecisionFrom({ decision: "REJECT", authority: "HUMAN", decisionId: "d1", principalId: "r1", decidedAt: "2026-11-07T12:00:00Z" }))
      .toEqual({ decision: "REJECT", authority: "HUMAN", decisionIds: ["d1"], reviewerPrincipalIds: ["r1"] });
    // A conflict resolution names no reviewer: the case API refuses to release on it (approval_unverifiable).
    expect(skillApprovalDecisionFrom({ decision: "APPROVE", authority: "HUMAN_CONFLICT_RESOLUTION", decisionIds: ["d1", "d2"], resolutionId: "res" }).reviewerPrincipalIds).toEqual([]);
    for (const invalid of [null, {}, { decision: "APPROVE", authority: "AGENT", decisionIds: ["d"] }, { decision: "MAYBE", authority: "HUMAN", decisionIds: ["d"] }, { decision: "APPROVE", authority: "HUMAN" }]) {
      expect(() => skillApprovalDecisionFrom(invalid)).toThrow("skill.release_approval_invalid");
    }
  });
});
