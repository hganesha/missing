import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalRecordDigest,
  canonicalRecordInputSchema,
  harnessPlanV2Schema,
  recordCanonicalRecordsPayloadSchema,
  skillCapabilityInputV1Schema,
  stableDigest,
  type CanonicalRecord,
  type HarnessPlanV2,
} from "@ehf/contracts";
import type { RuntimeContext } from "@ehf/runtime-core";
import { lowerHarnessPlanV2, type V2ExecutionAdapters } from "./index.js";

// The compiled KYB plan: connector node `acquire-registry` writes canonical records; skill node
// `registry-company-verify` (library registry.company.verify, skills:) reasons over them.
const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../../artifacts/archive/kyb.plan.json", import.meta.url), "utf8")));
const tenantId = "tenant-1";
const caseId = "case-1";
const capturedAt = "2026-11-07T12:00:00.000Z";
// The skill node's pinned projection of the library's synthetic policy pack (config.skillPolicy,
// packages/context-plane/src/policy.ts). A KYB case is opened under that policy and bundle.
type PinnedPolicy = { policyRef: string; policyVersion: string; bundleDigest: string; fields: string[]; values: Record<string, unknown>; unresolved: string[] };
const pinned = plan.graph.nodes.find((node) => node.id === "registry-company-verify")!.config.skillPolicy as PinnedPolicy;

function snapshot(target: HarnessPlanV2, records?: Record<string, CanonicalRecord[]>, policyId = "policy.synthetic.neutral", policyBundleDigest = pinned.bundleDigest) {
  const canonical = {
    apiVersion: "harness.factory/case-snapshot-v1" as const, kind: "CaseSnapshot" as const, tenantId, caseId, caseSequence: 4,
    dependencyDigest: "c".repeat(64), planDigest: target.planDigest,
    policyAuthority: { policyId, policyVersion: "0.1.0", policySnapshotDigest: "d".repeat(64), policyBundleDigest },
    consistency: "strong" as const, classification: "CONFIDENTIAL",
    data: {
      case: { caseId },
      subjects: [{ subject_id: "S-1", display_name: "Meridian Trade Holdings Ltd", attributes: { country: "GB", registrationNumber: "01234567" } }],
      ...(records ? { records, recordsAsOf: { asOf: capturedAt, knowledgeCutoff: capturedAt } } : {}),
    },
  };
  const snapshotDigest = stableDigest(canonical);
  return { ...canonical, snapshotId: `snapshot_${snapshotDigest}`, snapshotDigest, capturedAt };
}

// What the wiring adapter returns for a completed registry lookup: the provider result plus the
// normalized records (packages/adapters canonical-records.ts) the case write commits.
const registryRecord = canonicalRecordInputSchema.parse({
  object_type: "RegistryRecord", object_id: "registry:companies-house:01234567", version_id: "v-1",
  data: { registration_id: "01234567", status: "ACTIVE", coverage: { complete: true, jurisdictions: ["GB"] }, name: "Meridian Trade Holdings Ltd" },
  observed_at: "2026-11-07T11:00:00.000Z",
  source_refs: [{ tenant_id: tenantId, object_type: "GatewayInvocation", object_id: "RUN-K:acquire-registry", version_id: "check-1" }],
  provenance: { method: "connector_normalizer", normalizer: "wiring.business@1", connector_id: "wiring:companies-house:business.registry.lookup" },
  classification: "CONFIDENTIAL", synthetic: true,
});

function harness(snapshotFor: () => unknown, gateway: (capabilityId: string, body: Record<string, unknown>) => Record<string, unknown>) {
  const events: Array<{ code: string; values: Record<string, unknown> }> = [];
  const commands: Array<Record<string, unknown>> = [];
  const invocations: Array<Record<string, unknown>> = [];
  const context: RuntimeContext = {
    state: { nodeStarted: async () => {}, nodeFinished: async () => {}, appendEvent: async (_run, event) => { events.push(event); }, markCheckpoint: async () => {} },
    plan, runId: "RUN-K", runAttempt: 1, workerId: "worker-1", fencingEpoch: 1,
    gatewayUrl: "http://gateway", caseApiUrl: "http://case", envelopeBrokerUrl: "http://control", executionGrant: "grant", serviceToken: "service-token",
  };
  const adapters: V2ExecutionAdapters = {
    loadCaseSnapshot: async () => snapshotFor(),
    evaluateGate: async () => { throw new Error("unused"); },
  };
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const target = String(url);
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (target.includes("/v1/runtime/envelopes")) return Response.json({ envelope: "envelope", expiresInSeconds: 60, caseWrites: [] });
    if (target.includes("/v1/evidence:register")) return Response.json({ evidence: { evidenceId: "ev_registry_1" } });
    if (target.endsWith(`/v2/cases/${caseId}/sequence`)) return Response.json({ caseSequence: 4 + commands.length });
    if (target.endsWith("/commands")) {
      commands.push(body);
      return Response.json({ outcome: "ACCEPTED", caseSequence: 5 + commands.length, createdIdentifiers: {} });
    }
    invocations.push(body);
    return Response.json({
      invocationId: body.invocationId, capabilityId: body.capabilityId, errorCode: null, provider: "test", model: null, providerRequestId: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: null }, latencyMs: 1, receiptDigest: "f".repeat(64), status: "succeeded",
      ...gateway(String(body.capabilityId), body),
    });
  }) as typeof globalThis.fetch;
  const run = (nodeId: string, values: Record<string, unknown> = {}) =>
    lowerHarnessPlanV2(plan, context, adapters, undefined, nodeId).invoke({ input: { tenantId, caseId }, values }) as Promise<{ values: Record<string, unknown> }>;
  return { events, commands, invocations, run };
}

/** What the case store would select for the snapshot after the RecordCanonicalRecords command. */
function storedFrom(command: Record<string, unknown>): Record<string, CanonicalRecord[]> {
  const payload = recordCanonicalRecordsPayloadSchema.parse(command.payload);
  const grouped: Record<string, CanonicalRecord[]> = {};
  for (const item of payload.records) {
    const record = { schema_version: "2.0.0", subject_ids: [], valid_from: null, valid_to: null, purposes: [], ...item, tenant_id: tenantId, case_id: caseId, supersedes: null };
    (grouped[item.object_type] ??= []).push({ ...record, recorded_at: capturedAt, record_digest: canonicalRecordDigest(record) } as CanonicalRecord);
  }
  return grouped;
}

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

describe("KYB connector → canonical records → library skill", () => {
  it("commits the connector's records and hands them to the skill as its context, then journals the skill result", async () => {
    // 1. Connector node: the gateway output carries `records`; the case write commits them.
    const connector = harness(() => snapshot(plan), () => ({ output: {
      operationId: "companies-house:business.registry.lookup", providerCheckId: "check-1", outcome: "passed", reasonCodes: [], bankDecision: "not_evaluated",
      coverage: { status: "complete_for_requested_scope" }, evidenceRefs: [], warnings: [], records: [registryRecord], recordGap: null,
    } }));
    await connector.run("acquire-registry");
    expect(connector.invocations[0]).toMatchObject({ capabilityId: "business.registry.lookup.v1", input: { name: "Meridian Trade Holdings Ltd", country: "GB", registrationNumber: "01234567" } });
    expect(connector.commands.map((command) => command.commandType)).toEqual(["LinkEvidence", "RecordCanonicalRecords"]);
    const recordCommand = connector.commands[1]!;
    expect(recordCommand.payload).toEqual({ records: [registryRecord], evidenceRefs: ["ev_registry_1"] });
    // A system-marked step writes as the runtime workload: the only actor type the case service accepts from it.
    expect(recordCommand.actor).toMatchObject({ type: "AGENT", principalId: "kyb-connector-normalizer", roles: [] });
    expect((recordCommand.actor as { executionId?: string }).executionId).toBeTruthy();

    // 2. Skill node: the snapshot now holds the record; the skill receives it as a section.
    const records = storedFrom(recordCommand);
    const skill = harness(() => snapshot(plan, records), (capabilityId, body) => {
      const input = skillCapabilityInputV1Schema.parse(body.input);
      const section = input.context.sections.find((item) => item.id === "recRegistryRecord-registry-company-verify")!;
      const verifications = (section.value as Array<{ data: { registration_id: string; status: string } }>).map((record) => ({ id: record.data.registration_id, verified: true, status: record.data.status }));
      return { output: {
        contract_version: "skill.execution.v1", execution_id: String(body.invocationId), skill_id: "registry.company.verify", skill_version: plan.skillBindings!.find((binding) => binding.skillId === "registry.company.verify")!.semver,
        bundle_digest: plan.skillBindings!.find((item) => item.skillId === "registry.company.verify")!.bundleDigest,
        manifest_digest: plan.skillBindings!.find((item) => item.skillId === "registry.company.verify")!.manifestDigest.replace(/^sha256:/, ""),
        effect_mode: "read_only", lifecycle: "COMPLETED_EXECUTION",
        computation: { business_status: "COMPLETED", payload: { verifications }, proposed_records: [], unresolved_items: [], negative_searches: [], requested_effects: [], metrics: { duration_ms: 3, capability_calls: 0, model_calls: 0 } },
        error: null, trace: { subskill_executions: [] }, dependency_receipts: [], capabilityId,
      } };
    });
    const result = await skill.run("registry-company-verify");
    expect(skill.invocations).toHaveLength(1);
    const sent = skillCapabilityInputV1Schema.parse(skill.invocations[0]!.input);
    expect(skill.invocations[0]).toMatchObject({ capabilityId: "skill.registry.company.verify.v0", skill: { skillId: "registry.company.verify", selectedConnectorId: "skills:registry.company.verify" } });
    const section = sent.context.sections.find((item) => item.id === "recRegistryRecord-registry-company-verify")!;
    expect(section).toMatchObject({ kind: "case", trust: "UNTRUSTED_EXTERNAL", provenance_ref: `case:${caseId}@4/case:records.RegistryRecord` });
    expect(section.value).toEqual([expect.objectContaining({ object_id: "registry:companies-house:01234567", data: registryRecord.data, synthetic: true })]);
    expect(sent.context.missing).toEqual([]);
    // The pinned projection of the library policy pack (the skill's policy_context_fields) is the
    // `policy` section: exactly those fields, permissions scoped to this execution's own grants.
    const policy = sent.context.sections.find((item) => item.id === "policy")!;
    expect(policy).toMatchObject({ kind: "policy", trust: "TRUSTED_DATA", provenance_ref: `policy-snapshot:${"d".repeat(64)}` });
    expect(policy.value).toEqual(pinned.values);
    expect(pinned).toMatchObject({ policyRef: "policy.synthetic.neutral", policyVersion: "0.1.0", unresolved: [] });
    expect(pinned.bundleDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(pinned.values).sort()).toEqual(["active_registry_statuses", "freshness_seconds", "jurisdiction", "permissions", "version"]);
    expect(pinned.values.permissions).toEqual(["skill:registry.company.verify"]);
    expect(sent.input).toMatchObject({ tenant_id: tenantId, case_id: caseId, subject_refs: ["subject:S-1"], parameters: {}, purpose: "onboarding" });
    expect(result.values["registry-company-verify"]).toMatchObject({ computation: { payload: { verifications: [{ id: "01234567", verified: true, status: "ACTIVE" }] } } });
    const skillEvent = skill.events.find((event) => event.code.startsWith("skill.result."))!;
    expect(skillEvent.code).toBe("skill.result.completed");
    expect(skillEvent.values).toMatchObject({ skillId: "registry.company.verify", skillVersion: plan.skillBindings!.find((binding) => binding.skillId === "registry.company.verify")!.semver, status: "COMPLETED" });
  });

  it("writes an evidence gap instead of records when the connector established nothing", async () => {
    const connector = harness(() => snapshot(plan), () => ({ output: {
      operationId: "companies-house:business.registry.lookup", providerCheckId: "check-2", outcome: "unknown", reasonCodes: [], bankDecision: "not_evaluated",
      coverage: { status: "unknown" }, evidenceRefs: [], warnings: [], records: [], recordGap: { code: "EVIDENCE_GAP", reason: "The business.registry.lookup check did not complete (wiring.check_dead_letter).", outcome: "unknown" },
    } }));
    await connector.run("acquire-registry");
    expect(connector.commands.map((command) => command.commandType)).toEqual(["LinkEvidence", "RecordScreeningFinding"]);
    expect(connector.commands[1]!.payload).toMatchObject({ findingType: "EVIDENCE_GAP", classification: "REVIEW", reason: expect.stringContaining("did not complete") });
  });

  it.each([
    ["a policy other than the pinned one", "policy.kyb.other", pinned.bundleDigest, "pinned to policy.kyb.other"],
    ["another bundle of the pinned policy", "policy.synthetic.neutral", "e".repeat(64), "pinned to policy.synthetic.neutral (bundle eeeeeeeeeeee)"],
  ])("does not call the skill when the case is governed by %s", async (_label, policyId, bundleDigest, explanation) => {
    const records = { RegistryRecord: storedFrom({ payload: { records: [registryRecord] } }).RegistryRecord! };
    const skill = harness(() => snapshot(plan, records, policyId, bundleDigest), () => { throw new Error("the skill must not be called"); });
    const result = await skill.run("registry-company-verify");
    expect(skill.invocations).toEqual([]);
    expect(result.values["registry-company-verify"]).toMatchObject({ status: "NEEDS_EVIDENCE", code: "POLICY_UNRESOLVED" });
    const unresolved = (result.values["registry-company-verify"] as { skillResult: { unresolved_items: Array<{ code: string; explanation: string }> } }).skillResult.unresolved_items;
    expect(unresolved.map((item) => item.code)).toContain("POLICY_UNRESOLVED");
    expect((result.values["registry-company-verify"] as { skillResult: { error: { message?: string } | null }; policyGaps: string[] }).policyGaps).toEqual(pinned.fields);
    expect(JSON.stringify(result.values["registry-company-verify"])).toContain(explanation);
  });

  it("does not call the skill without its required records and answers NEEDS_EVIDENCE with CONTEXT_MISSING", async () => {
    const skill = harness(() => snapshot(plan, { Entity: [] }), () => { throw new Error("the skill must not be called"); });
    const result = await skill.run("registry-company-verify");
    expect(skill.invocations).toEqual([]);
    expect(result.values["registry-company-verify"]).toMatchObject({ status: "NEEDS_EVIDENCE", code: "CONTEXT_MISSING", recordGaps: [expect.objectContaining({ objectType: "RegistryRecord", found: 0 })] });
    const skillEvent = skill.events.find((event) => event.code.startsWith("skill.result."))!;
    expect(skillEvent).toMatchObject({ code: "skill.result.needs_evidence", values: { status: "NEEDS_EVIDENCE", errorCode: "CONTEXT_MISSING", skillCalled: false } });
  });
});
