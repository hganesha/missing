import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { harnessPlanV2Schema, recordCanonicalRecordsPayloadSchema } from "@ehf/contracts";
import { CASE_WRITE_FOREACH_LIMIT, executeCaseWrites, type RuntimeContext } from "./index.js";

// Delivery plan wave 2 (W6): an agent's output becomes case proposals and observations, one command
// per item of a list in its output (`forEach`), on the compiled agentic KYB plan.
const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../../artifacts/kyb-agentic.plan.json", import.meta.url), "utf8")));
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

function fakePlatform() {
  const commands: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (path === "/v1/runtime/envelopes") {
      return Response.json({ envelope: "envelope", expiresInSeconds: 60, caseWrites: ["LinkEvidence", "RecordCanonicalRecords", "ProposeClaim", "RaiseContradiction", "SubmitDecisionRecommendation", "LinkExecution"] });
    }
    if (path === "/v1/evidence:register") return Response.json({ created: true, evidence: { evidenceId: `ev_${String(body.type)}` } }, { status: 201 });
    if (path === "/v2/cases/CASE-1/sequence" && init.method === "GET") return Response.json({ caseSequence: 3 });
    if (path === "/v1/cases/CASE-1/commands") { commands.push(body); return Response.json({ createdIdentifiers: {} }); }
    return Response.json({ error: `unexpected ${path}` }, { status: 404 });
  }) as typeof globalThis.fetch;
  return commands;
}

const context: RuntimeContext = {
  state: { nodeStarted: async () => {}, nodeFinished: async () => {}, appendEvent: async () => {}, markCheckpoint: async () => {} },
  plan, runId: "RUN-1", runAttempt: 1, workerId: "worker-1", fencingEpoch: 1,
  gatewayUrl: "http://gateway", envelopeBrokerUrl: "http://control", caseApiUrl: "http://case", executionGrant: "grant", serviceToken: "service-token",
};
const root = { tenantId: "tenant_demo", caseId: "CASE-1", policySnapshotDigest: "d".repeat(64) };
const check = (outcome: string, field: string, documentValue: string | null, recordValue: string | null) =>
  ({ entityRef: "h04.entity.thistlewood-fab", field, outcome, documentValue, recordValue, sourceRefs: [`doc-${field}`, `record-${field}`] });

describe("agent outputs as case proposals", () => {
  it("raises a contradiction per conflicting document check and a claim per non-informational finding", async () => {
    const commands = fakePlatform();
    const output = {
      summary: "s", gaps: [], requiresHumanReview: true, verifications: [],
      findings: [
        { type: "REGISTERED_OFFICE_CONFLICT", severity: "BLOCKING", reason: "Unit 9 against Unit 7.", sourceRefs: ["doc-1", "reg-1"] },
        { type: "NAME_MATCH", severity: "INFO", reason: "Names agree.", sourceRefs: ["doc-1"] },
      ],
      documentChecks: [
        check("CONFLICT", "registered_office", "Unit 9, Calder Works", "Unit 7, Calder Works"),
        check("MATCH", "entity_name", "Thistlewood Fabrication Ltd", "Thistlewood Fabrication Ltd"),
        check("CONFLICT", "date_of_birth", "1984-11-02", "1984-02-11"),
      ],
    };
    await executeCaseWrites(context, "identity-verification-review", root, {}, output, {});
    const types = commands.map((command) => command.commandType);
    expect(types).toEqual(["LinkEvidence", "RecordCanonicalRecords", "ProposeClaim", "RaiseContradiction", "RaiseContradiction"]);
    // The finding as an UNVERIFIED canonical Finding record, attributed to the agent, that later skills read.
    const records = recordCanonicalRecordsPayloadSchema.parse(commands[1]!.payload);
    expect(records.records[0]).toMatchObject({ object_type: "Finding", object_id: "finding:RUN-1:identity-verification-review:0",
      data: { claim: "REGISTERED_OFFICE_CONFLICT: Unit 9 against Unit 7.", evidence_ids: ["ev_kyb_agentic_identity_verification_review"], status: "UNVERIFIED" },
      provenance: { method: "agent_proposal", agent_id: "agent.identity_verification" }, synthetic: false });
    const claim = commands[2]!;
    expect(claim).toMatchObject({ actor: { type: "AGENT" }, payload: { predicate: "finding:REGISTERED_OFFICE_CONFLICT",
      value: { severity: "BLOCKING", sourceRefs: ["doc-1", "reg-1"], proposedBy: "agent:agent.identity_verification" }, evidenceRefs: ["ev_kyb_agentic_identity_verification_review"] } });
    expect(commands[3]!.payload).toMatchObject({ objectRefs: ["doc-registered_office", "record-registered_office"], materiality: "REVIEW",
      description: "h04.entity.thistlewood-fab registered_office: the document states Unit 9, Calder Works; the record holds Unit 7, Calder Works." });
    // Each item is its own idempotent command.
    expect(new Set(commands.map((command) => command.idempotencyKey)).size).toBe(commands.length);
    // Nothing protected: no fact adoption, review, disposition, status change or human-work request.
    for (const type of types) expect(["AcceptClaimAsFact", "RecordReview", "FinalizeDisposition", "TransitionCaseStatus", "RequestHumanReview", "RecordGateResult"]).not.toContain(type);
  });

  it("proposes decision support's recommendation, never an approval", async () => {
    for (const [recommendation, outcome] of [["RECOMMEND_DECLINE", "DECLINE"], ["REVIEW_FOR_ACCEPTANCE", "REVIEW"], ["COLLECT_EVIDENCE", "REVIEW"]] as const) {
      const commands = fakePlatform();
      await executeCaseWrites(context, "decision-support-review", root, {}, { summary: "s", findings: [], gaps: [], requiresHumanReview: true, recommendation, rationale: "Because.", citedRecords: ["r"], final: false }, {});
      const recommendations = commands.filter((command) => command.commandType === "SubmitDecisionRecommendation");
      expect(recommendations).toHaveLength(1);
      expect(recommendations[0]!.payload).toMatchObject({ outcome, rationale: "Because.", requiresHumanReview: true });
    }
  });

  it("writes nothing for a missing list and refuses an oversized one", async () => {
    const commands = fakePlatform();
    await executeCaseWrites(context, "identity-verification-review", root, {}, { summary: "s", gaps: [], requiresHumanReview: false, verifications: [] }, {});
    expect(commands.map((command) => command.commandType)).toEqual(["LinkEvidence"]);
    fakePlatform();
    const many = Array.from({ length: CASE_WRITE_FOREACH_LIMIT + 1 }, (_, index) => ({ type: `F${index}`, severity: "REVIEW", reason: "r", sourceRefs: ["x"] }));
    await expect(executeCaseWrites(context, "identity-verification-review", root, {}, { findings: many }, {})).rejects.toThrow("runtime.case_write_foreach_too_many");
  });

  it("records an informative tamper answer as a FraudSignal citing the detector output, and an inconclusive one as nothing (wave 4)", async () => {
    const tamper = (assessment: string) => ({ lifecycle: "COMPLETED_EXECUTION", computation: { business_status: "COMPLETED",
      payload: { assessment: { assessment, score: "0.82", model_version: "vendor-v3", limitations: [] }, provider_id: "vendor", synthetic: false, final_decision: false } } });
    const snapshot = { snapshotId: "s", snapshotDigest: "a".repeat(64), tenantId: "tenant_demo", caseId: "CASE-1", caseSequence: 3, capturedAt: "2026-11-01T00:00:00.000Z",
      policyAuthority: { policySnapshotDigest: "d".repeat(64) }, data: { subjects: [{ subject_id: "h04.entity.thistlewood-fab" }], records: {} } } as never;
    let commands = fakePlatform();
    await executeCaseWrites(context, "fraud-document-tamper-detect", root, {}, tamper("TAMPER_INDICATED"), {}, snapshot);
    expect(commands.map((command) => command.commandType)).toEqual(["RecordCanonicalRecords"]);
    const signal = recordCanonicalRecordsPayloadSchema.parse(commands[0]!.payload).records[0]!;
    expect(signal).toMatchObject({ object_type: "FraudSignal", subject_ids: ["h04.entity.thistlewood-fab"],
      data: { score: "0.82", kind: "document_tamper", model_version: "vendor-v3", evidence_ids: ["ev_authenticity_document_tamper"] },
      provenance: { method: "platform", capability_id: "fraud.document.tamper.v1" } });
    commands = fakePlatform();
    await executeCaseWrites(context, "fraud-document-tamper-detect", root, {}, tamper("INCONCLUSIVE"), {}, snapshot);
    expect(commands).toEqual([]);
  });

  it("records a checkpoint stop as evidence and links the run, without asking for human work", async () => {
    const commands = fakePlatform();
    await executeCaseWrites(context, "stopped", root, {}, { gateId: "decision-ready", outcome: "REVIEW", reasonCodes: ["SCREENING_INCOMPLETE"] }, {});
    expect(commands.map((command) => command.commandType)).toEqual(["LinkEvidence", "LinkExecution"]);
    expect(commands[0]!.payload).toMatchObject({ evidenceId: "ev_kyb_agentic_checkpoint_stop", purpose: "CHECKPOINT_STOP" });
  });
});
