import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { LIBRARY_PLATFORM_CAPABILITIES } from "@ehf/contracts";
import { describe, expect, it } from "vitest";
import {
  caseCommandAuthorizations,
  EffectMappingError,
  LIBRARY_CAPABILITIES,
  LIBRARY_CONTEXT_SCHEMA_VERSION,
  LIBRARY_CONTEXT_TYPES,
  LIBRARY_CONTRACTS_LOCK,
  LIBRARY_SKILL_EFFECTS,
  mapLibraryEffects,
  PROVIDER_SCHEMAS,
  validateProviderPayload,
  validateRecordData,
} from "./index.js";

describe("vendored library contracts", () => {
  it("come from the same library release as the business-skill registry (config/skill-library)", () => {
    // One release, two snapshots: the catalog seeds the registry, the closed schemas validate
    // records, effects and provider payloads. They must never drift apart.
    const catalog = JSON.parse(readFileSync(new URL("../../../config/skill-library/catalog.json", import.meta.url), "utf8")) as { version: string; source_hash: string; bundle_code_hash: string; context_schema_version?: string };
    expect({ version: LIBRARY_CONTRACTS_LOCK.version, source: LIBRARY_CONTRACTS_LOCK.catalog_source_hash, bundle: LIBRARY_CONTRACTS_LOCK.bundle_code_hash })
      .toEqual({ version: catalog.version, source: catalog.source_hash, bundle: catalog.bundle_code_hash });
  });

  it("match their lock byte for byte", () => {
    expect(LIBRARY_CONTRACTS_LOCK).toMatchObject({ library: "financial-crime-skills", version: "0.5.0", context_schema_version: "2.0.0" });
    for (const [file, entry] of Object.entries(LIBRARY_CONTRACTS_LOCK.files)) {
      const digest = createHash("sha256").update(readFileSync(new URL(`./vendor/${file}`, import.meta.url))).digest("hex");
      expect({ file, digest }).toEqual({ file, digest: entry.sha256 });
    }
  });

  it("cover the 89 canonical context types and the twelve provider capabilities", () => {
    expect(LIBRARY_CONTEXT_SCHEMA_VERSION).toBe("2.0.0");
    expect(LIBRARY_CONTEXT_TYPES).toHaveLength(89);
    expect(Object.keys(PROVIDER_SCHEMAS).sort()).toEqual(LIBRARY_CAPABILITIES.map((item) => item.library).sort());
    expect(LIBRARY_CAPABILITIES).toHaveLength(12);
    // The platform's CR-8 table (used by delegation) names the same platform capability for each.
    expect(Object.fromEntries(LIBRARY_CAPABILITIES.map((item) => [item.library, item.capabilityId]))).toEqual(LIBRARY_PLATFORM_CAPABILITIES);
  });
});

describe("record data", () => {
  it("accepts the library's own examples and rejects open or mistyped data", () => {
    expect(validateRecordData("Party", { customer_type: "corporate", entity_id: "acme", industry: "SYN-TECH", profile: { business_purpose: "software", employees: 10, legal_name: "Acme" }, role: "customer" }).valid).toBe(true);
    expect(validateRecordData("ScreeningHit", { entity_id: "alice", entry_id: "watch-1", features: { identifier_conflict: true } }).valid).toBe(true);
    const open = validateRecordData("Entity", { name: "Acme", identifiers: [], entity_type: "company", legal_form: "ltd" });
    expect(open.valid).toBe(false);
    expect(open.errors.join(" ")).toContain("legal_form");
    expect(validateRecordData("ScreeningHit", { entity_id: "a", entry_id: "b", features: { identifier_conflict: false, score: "0.8" } }).valid).toBe(false);
    expect(validateRecordData("AdverseMediaEvent", { subjects: [], title: "t", source: "s", status: "REPORTED", coverage: { complete: false }, event_key: "k" }).valid).toBe(false);
  });

  it("accepts versioned namespaced extensions only", () => {
    const base = { name: "Acme", identifiers: ["1"], entity_type: "company" };
    expect(validateRecordData("Entity", { ...base, extensions: { "ehf.connector": { schema_version: "1.0.0", value: { legal_form: "ltd" } } } }).valid).toBe(true);
    expect(validateRecordData("Entity", { ...base, extensions: { "ehf.connector": { value: {} } } }).valid).toBe(false);
    expect(validateRecordData("Entity", { ...base, extensions: { "EHF Connector": { schema_version: "1.0.0", value: {} } } }).valid).toBe(false);
  });

  it("validates the platform-only NegativeSearchEvidence against its own closed schema", () => {
    const negative = {
      capability: "screening.pep", provider: "opensanctions", subject: null, dataset_versions: ["peps"], scope: ["pep"], truncated: false,
      total_candidates: 0, coverage: { complete: false, as_of: "2026-11-07T10:00:00.000Z" }, query_time: "2026-11-07T10:00:00.000Z", limitations: ["not universal clearance"],
    };
    expect(validateRecordData("NegativeSearchEvidence", negative)).toEqual({ valid: true, contract: "platform", errors: [] });
    expect(validateRecordData("NegativeSearchEvidence", { ...negative, query: {} }).valid).toBe(false);
    expect(LIBRARY_CONTEXT_TYPES).not.toContain("NegativeSearchEvidence");
  });
});

describe("provider payloads (CR-8)", () => {
  // Shapes of the library's request-bound recordings (financial_crime.synthetic.router()).
  const detector = { score: "0.25", assessment: "INCONCLUSIVE", model_version: "synthetic-recording-v1", limitations: ["Synthetic control-flow fixture; no real detector executed."] };

  it("accept the recorded request and response shapes", () => {
    expect(validateProviderPayload("document.entities", "request", { pages: [{ id: "page-1", text: "Certificate of incorporation\nName: Acme" }] }).valid).toBe(true);
    expect(validateProviderPayload("document.entities", "response", { entities: [{ page_id: "page-1", text: "Acme", start: 35, end: 39 }] }).valid).toBe(true);
    expect(validateProviderPayload("fraud.liveness", "request", { records: [{ id: "session-1", artifact_hash: "a".repeat(64), challenge_id: "challenge-1" }] }).valid).toBe(true);
    expect(validateProviderPayload("fraud.liveness", "response", detector).valid).toBe(true);
    expect(validateProviderPayload("fraud.deepfake", "response", detector).valid).toBe(true);
  });

  it("refuse unknown capabilities, open responses and out-of-range scores", () => {
    expect(validateProviderPayload("fraud.unknown", "response", detector)).toMatchObject({ valid: false });
    expect(validateProviderPayload("fraud.liveness", "response", { ...detector, passed: true }).valid).toBe(false);
    expect(validateProviderPayload("fraud.liveness", "response", { ...detector, score: "1.5" }).valid).toBe(false);
  });

  it("map each library capability to a canonical platform capability id", () => {
    for (const capability of LIBRARY_CAPABILITIES) expect(capability.capabilityId).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$/);
    expect(LIBRARY_CAPABILITIES.find((item) => item.library === "fraud.liveness")!.capabilityId).toBe("identity.biometric.verify.v1");
    expect(LIBRARY_CAPABILITIES.filter((item) => item.kind === "model").map((item) => item.library).sort()).toEqual(["document.entities", "document.fields", "document.translate"]);
  });
});

describe("effect commands (CR-5)", () => {
  const justificationRefs = ["execution:e-1"];

  it("declares every library write or gated skill exactly once, with the registry's mode and approval", () => {
    expect(Object.keys(LIBRARY_SKILL_EFFECTS)).toHaveLength(15);
    const registry = JSON.parse(readFileSync(new URL("../../../config/business-skills.json", import.meta.url), "utf8")) as { skills: Array<{ skillId: string; manifest: { effects: string }; effects: { mode: string; approval: string } }> };
    // Proposal skills (the EHF document extraction wrapper) return §6.2 records, never effect commands.
    const writing = registry.skills.filter((entry) => !["read_only", "proposal"].includes(entry.manifest.effects));
    expect(Object.keys(LIBRARY_SKILL_EFFECTS).sort()).toEqual(writing.map((entry) => entry.skillId).sort());
    for (const entry of writing) {
      const declared = LIBRARY_SKILL_EFFECTS[entry.skillId]!;
      expect({ skill: entry.skillId, libraryEffects: declared.libraryEffects, mode: declared.mode, approval: declared.approval })
        .toEqual({ skill: entry.skillId, libraryEffects: entry.manifest.effects, mode: entry.effects.mode, approval: entry.effects.approval });
    }
    expect(Object.values(LIBRARY_SKILL_EFFECTS).filter((item) => item.libraryEffects === "human_gated").every((item) => item.approval === "required")).toBe(true);
    expect(caseCommandAuthorizations("decision.disposition.record")).toEqual(["case_command:RecordReview"]);
    expect(caseCommandAuthorizations("ownership.interest.calculate")).toEqual([]);
  });

  it("absorbs case creation: the platform created the case before the run", () => {
    const mapped = mapLibraryEffects({ skillId: "case.create", commands: [{ kind: "state", type: "case", id: "case-1", expected_revision: 0, data: { state: "OPEN", case_type: "KYB" } }] });
    expect(mapped).toMatchObject({ effects: [], absorbed: [{ id: "case-1" }], approval: "none" });
  });

  it("maps a schedule to a work item with a due date, never a queued skill", () => {
    const command = { kind: "state", type: "schedule", id: "sched-1", expected_revision: 0, data: { due_at: "2027-11-07T00:00:00+00:00", action: "review" } };
    const mapped = mapLibraryEffects({ skillId: "monitor.customer.schedule", commands: [command], justificationRefs });
    expect(mapped.effects).toEqual([{
      type: "case_command", command_type: "ProposeWorkItem", idempotency_key: expect.stringMatching(/^lib:monitor\.customer\.schedule:[a-f0-9]{40}$/),
      payload: { workItemId: "sched-1", workType: "scheduled_review", dueAt: "2027-11-07T00:00:00+00:00" }, justification_refs: justificationRefs,
    }]);
    // Same command, same key: a retried execution re-requests the same effect.
    expect(mapLibraryEffects({ skillId: "monitor.customer.schedule", commands: [command] }).effects[0]!.idempotency_key).toBe(mapped.effects[0]!.idempotency_key);
  });

  it("maps a gated disposition to RecordReview carrying the expected case sequence, pending approval", () => {
    const mapped = mapLibraryEffects({ skillId: "decision.disposition.record", commands: [{ kind: "state", type: "case", id: "case-1", expected_revision: 3, data: { state: "OPEN", case_type: "KYB", disposition: "ACCEPT" } }] });
    expect(mapped.approval).toBe("required");
    expect(mapped.effects[0]).toMatchObject({ command_type: "RecordReview", payload: { reviewType: "disposition", outcome: "ACCEPT", objectRef: "case:case-1", expected_case_sequence: 3 } });
  });

  it("maps case transitions, escalation, feedback and screening dispositions to typed case commands", () => {
    const map = (skillId: string, command: Record<string, unknown>) => mapLibraryEffects({ skillId, commands: [command] }).effects[0]!;
    expect(map("case.close", { kind: "state", type: "case", id: "c", expected_revision: 2, data: { state: "CLOSED", case_type: "KYB" } })).toMatchObject({ command_type: "TransitionCaseStatus", payload: { toStatus: "CLOSED", expected_case_sequence: 2 } });
    expect(map("case.state.transition", { kind: "state", type: "case", id: "c", expected_revision: 1, data: { state: "REVIEW", case_type: "KYB" } })).toMatchObject({ command_type: "RequestHumanReview", payload: { objectRef: "case:c" } });
    expect(map("case.escalate", { kind: "state", type: "escalation", id: "esc-1", expected_revision: 0, data: { reason: "Synthetic test", role: "compliance" } })).toMatchObject({ command_type: "RequestHumanReview", payload: { priority: "HIGH" } });
    expect(map("alert.feedback.capture", { kind: "state", type: "feedback", id: "fb-1", expected_revision: 0, data: { alert_id: "alert-1", label: "reviewed", reason: "Synthetic test", actor: "analyst" } })).toMatchObject({ command_type: "RecordReview", payload: { reviewType: "alert_feedback", objectRef: "alert:alert-1" } });
    expect(map("screening.alert.disposition", { kind: "state", type: "screening_disposition", id: "case-1", expected_revision: 0, data: { disposition: "FALSE_MATCH", hit_ids: ["hit-1"] } })).toMatchObject({ command_type: "RecordReview", payload: { viewedEvidenceRefs: ["ScreeningHit:hit-1"] } });
    expect(map("monitor.review.execute", { kind: "outbox", id: "q-1", action: "execute_skill", skill_id: "entity.resolve", parameters: {}, parent_execution_id: "e-1" })).toMatchObject({ command_type: "ProposeWorkItem", payload: { workType: "skill_execution", requiredCapability: "skill.entity.resolve" } });
  });

  it("maps filing and retention to named external actions", () => {
    const filing = mapLibraryEffects({ skillId: "regulatory.filing.submit", commands: [{ kind: "outbox", id: "sub-1", action: "submit_filing", synthetic: true, filing: { report_type: "SAR", subject_id: "acme", narrative: "Synthetic finding [evidence-1]", citations: ["evidence-1"] } }] });
    expect(filing).toMatchObject({ approval: "required", effects: [{ type: "external_action", action: "regulatory.filing.submit", payload: { submissionId: "sub-1", synthetic: true } }] });
    expect(mapLibraryEffects({ skillId: "evidence.retention.enforce", commands: [{ kind: "outbox", id: "r-1", action: "delete_artifact", object_id: "doc-1" }] }).effects[0]).toMatchObject({ action: "evidence.retention.delete", payload: { objectId: "doc-1" } });
  });

  it("refuses invalid commands, commands a skill may not emit and writes from read-only skills", () => {
    const code = (fn: () => unknown) => { try { fn(); return null; } catch (error) { return error instanceof EffectMappingError ? error.code : String(error); } };
    expect(code(() => mapLibraryEffects({ skillId: "case.close", commands: [{ kind: "state", type: "case", id: "c", expected_revision: 1, data: { state: "CLOSED" } }] }))).toBe("effect.command_invalid");
    expect(code(() => mapLibraryEffects({ skillId: "case.close", commands: [{ kind: "outbox", id: "r-1", action: "delete_artifact", object_id: "doc-1" }] }))).toBe("effect.skill_not_permitted");
    expect(code(() => mapLibraryEffects({ skillId: "case.close", commands: [{ kind: "state", type: "case", id: "c", expected_revision: 1, data: { state: "OPEN", case_type: "KYB" } }] }))).toBe("effect.command_unmapped");
    expect(code(() => mapLibraryEffects({ skillId: "entity.resolve", commands: [{ kind: "outbox", id: "r-1", action: "delete_artifact", object_id: "doc-1" }] }))).toBe("effect.skill_not_permitted");
    expect(mapLibraryEffects({ skillId: "entity.resolve", commands: [] })).toEqual({ effects: [], absorbed: [], approval: "none" });
  });
});
