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

// The compiled KYC plan (individual CDD on the skill library): connector node `acquire-sanctions`
// writes canonical records; skill node `screening-sanctions-execute` (library
// screening.sanctions.execute on skills:) reasons over them with the pinned policy as its policy
// context section.
const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../../artifacts/archive/kyc-v2.plan.json", import.meta.url), "utf8")));
const tenantId = "tenant-1";
const caseId = "case-1";
const capturedAt = "2026-11-07T12:00:00.000Z";
const policySnapshotDigest = "d".repeat(64);

function snapshot(target: HarnessPlanV2, records?: Record<string, CanonicalRecord[]>, policyBundleDigest = target.policyBundles[0]!.bundleDigest) {
  const canonical = {
    apiVersion: "harness.factory/case-snapshot-v1" as const, kind: "CaseSnapshot" as const, tenantId, caseId, caseSequence: 4,
    dependencyDigest: "c".repeat(64), planDigest: target.planDigest,
    policyAuthority: { policyId: "policy.kyc.customer-acceptance.v1", policyVersion: "1.0.0", policySnapshotDigest, policyBundleDigest },
    consistency: "strong" as const, classification: "CONFIDENTIAL",
    data: {
      case: { caseId },
      subjects: [{ subject_id: "S-1", display_name: "Ada Lovelace", attributes: { country: "US", dateOfBirth: "1990-12-10", customerType: "individual" } }],
      facts: [],
      ...(records ? { records, recordsAsOf: { asOf: capturedAt, knowledgeCutoff: capturedAt } } : {}),
    },
  };
  const snapshotDigest = stableDigest(canonical);
  return { ...canonical, snapshotId: `snapshot_${snapshotDigest}`, snapshotDigest, capturedAt };
}

const watchlistEntry = canonicalRecordInputSchema.parse({
  object_type: "WatchlistEntry", object_id: "watchlist:opensanctions:Q1", version_id: "v-1",
  data: { name: "Ada Lovelace", identifiers: ["Q1"], list_type: "sanctions", list_version: "2026-11-07", coverage: { complete: false, list_version: "2026-11-07" } },
  observed_at: "2026-11-07T11:00:00.000Z",
  source_refs: [{ tenant_id: tenantId, object_type: "GatewayInvocation", object_id: "RUN-K:acquire-sanctions", version_id: "check-1" }],
  provenance: { method: "connector_normalizer", normalizer: "opensanctions.match@1", connector_id: "opensanctions:sanctions" },
  classification: "CONFIDENTIAL", synthetic: true,
});
const entity = canonicalRecordInputSchema.parse({
  object_type: "Entity", object_id: "entity:opensanctions:Q1", version_id: "v-1",
  data: { name: "Ada Lovelace", identifiers: ["Q1"], entity_type: "individual" },
  observed_at: "2026-11-07T11:00:00.000Z", source_refs: [],
  provenance: { method: "connector_normalizer", normalizer: "opensanctions.match@1", connector_id: "opensanctions:sanctions" },
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
    if (target.includes("/v1/evidence:register")) return Response.json({ evidence: { evidenceId: "ev_sanctions_1" } });
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

function storedFrom(command: Record<string, unknown>): Record<string, CanonicalRecord[]> {
  const payload = recordCanonicalRecordsPayloadSchema.parse(command.payload);
  const grouped: Record<string, CanonicalRecord[]> = {};
  for (const item of payload.records) {
    const record = { schema_version: "1.0.0", subject_ids: [], valid_from: null, valid_to: null, purposes: [], ...item, tenant_id: tenantId, case_id: caseId, supersedes: null };
    (grouped[item.object_type] ??= []).push({ ...record, recorded_at: capturedAt, record_digest: canonicalRecordDigest(record) } as CanonicalRecord);
  }
  return grouped;
}

const skillOutput = (skillId: string, body: Record<string, unknown>, capabilityId: string, payload: Record<string, unknown>) => {
  const binding = plan.skillBindings!.find((item) => item.skillId === skillId)!;
  return { output: {
    contract_version: "skill.execution.v1", execution_id: String(body.invocationId), skill_id: skillId, skill_version: binding.semver,
    bundle_digest: binding.bundleDigest, manifest_digest: binding.manifestDigest.replace(/^sha256:/, ""), effect_mode: "read_only", lifecycle: "COMPLETED_EXECUTION",
    computation: { business_status: "COMPLETED", payload, proposed_records: [], unresolved_items: [], negative_searches: [], requested_effects: [], metrics: { duration_ms: 3, capability_calls: 0, model_calls: 0 } },
    error: null, trace: { subskill_executions: [] }, dependency_receipts: [], capabilityId,
  } };
};

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

describe("KYC connector → canonical records → library skill with the pinned policy section", () => {
  it("links the screen under the policy evidence purpose, commits the records and raises the provider alert as a REVIEW finding", async () => {
    const connector = harness(() => snapshot(plan), () => ({ output: {
      status: "COMPLETED", provider: "opensanctions", screeningType: "SANCTIONS", screenedAt: capturedAt,
      alerts: [{ entityId: "Q1", score: 0.91 }], records: [watchlistEntry, entity], recordGap: null,
    } }));
    await connector.run("acquire-sanctions");
    expect(connector.invocations[0]).toMatchObject({ capabilityId: "screening.sanctions.v1", input: { name: "Ada Lovelace", country: "US", dateOfBirth: "1990-12-10" } });
    expect(connector.commands.map((command) => command.commandType)).toEqual(["LinkEvidence", "RecordCanonicalRecords", "RecordScreeningFinding"]);
    expect(connector.commands[0]!.payload).toEqual({ evidenceId: "ev_sanctions_1", purpose: "KYC_SANCTIONS_SCREENING" });
    // A system-marked step writes as the runtime workload: the only actor type the case service accepts from it.
    expect(connector.commands[1]!.actor).toMatchObject({ type: "AGENT", principalId: "kyc-connector-normalizer", roles: [] });
    expect((connector.commands[1]!.actor as { executionId?: string }).executionId).toBeTruthy();
    expect(connector.commands[2]!.payload).toMatchObject({ findingType: "POSSIBLE_SANCTIONS_MATCH", classification: "REVIEW" });
  });

  it("records an incomplete screen (never clear) when the provider established nothing", async () => {
    const connector = harness(() => snapshot(plan), () => ({ output: {
      status: "FAILED", provider: "opensanctions", screeningType: "SANCTIONS", screenedAt: capturedAt, alerts: [], records: [],
      recordGap: { code: "EVIDENCE_GAP", reason: "The OpenSanctions match did not complete.", outcome: "unknown" },
    } }));
    await connector.run("acquire-sanctions");
    expect(connector.commands.map((command) => [command.commandType, (command.payload as { findingType?: string }).findingType])).toEqual([
      ["LinkEvidence", undefined], ["RecordScreeningFinding", "SANCTIONS_SCREEN_INCOMPLETE"],
    ]);
  });

  it("hands the records and the pinned policy section to the skill", async () => {
    const connector = harness(() => snapshot(plan), () => ({ output: {
      status: "COMPLETED", provider: "opensanctions", screeningType: "SANCTIONS", screenedAt: capturedAt, alerts: [], records: [watchlistEntry, entity], recordGap: null,
    } }));
    await connector.run("acquire-sanctions");
    const records = storedFrom(connector.commands.find((command) => command.commandType === "RecordCanonicalRecords")!);

    const skill = harness(() => snapshot(plan, records), (capabilityId, body) => skillOutput("screening.sanctions.execute", body, capabilityId, { hits: [], coverage: [], universal_clearance: false }));
    const result = await skill.run("screening-sanctions-execute");
    expect(skill.invocations).toHaveLength(1);
    expect(skill.invocations[0]).toMatchObject({ capabilityId: "skill.screening.sanctions.execute.v0", skill: { skillId: "screening.sanctions.execute", selectedConnectorId: "skills:screening.sanctions.execute" } });
    const sent = skillCapabilityInputV1Schema.parse(skill.invocations[0]!.input);
    expect(sent.context.sections.find((item) => item.id === "recWatchlistEntry-screening-sanctions-execute")!.value)
      .toEqual([expect.objectContaining({ object_id: "watchlist:opensanctions:Q1", synthetic: true })]);
    const policy = sent.context.sections.find((item) => item.id === "policy")!;
    expect(policy).toMatchObject({
      kind: "policy", trust: "TRUSTED_DATA", provenance_ref: `policy-snapshot:${policySnapshotDigest}`, purpose: "KYC_ONBOARDING",
      value: { version: "1.0.0", jurisdiction: "US", screening_threshold: 0.85, freshness_seconds: { WatchlistEntry: 86_400 } },
    });
    expect(Object.keys(policy.value as object).sort()).toEqual(["freshness_seconds", "jurisdiction", "permissions", "screening_threshold", "version"]);
    expect(sent.context.missing).toEqual([]);
    expect(result.values["screening-sanctions-execute"]).toMatchObject({ lifecycle: "COMPLETED_EXECUTION", computation: { payload: { universal_clearance: false } } });
    expect(skill.events.find((event) => event.code.startsWith("skill.result."))!.code).toBe("skill.result.completed");
  });

  it("binds a library parameter from the case subject", async () => {
    const skill = harness(() => snapshot(plan, { Entity: storedFrom({ payload: { records: [entity] } }).Entity! }),
      (capabilityId, body) => skillOutput("entity.resolve", body, capabilityId, { candidates: [], entity_id: "entity:opensanctions:Q1" }));
    await skill.run("entity-resolve");
    expect(skillCapabilityInputV1Schema.parse(skill.invocations[0]!.input).input.parameters).toEqual({ name: "Ada Lovelace", identifiers: [] });
  });

  it("does not call a skill whose policy fields the pinned bundle cannot resolve: NEEDS_EVIDENCE / POLICY_UNRESOLVED", async () => {
    const skill = harness(() => snapshot(plan), () => { throw new Error("the skill must not be called"); });
    const result = await skill.run("risk-factor-evaluate");
    expect(skill.invocations).toEqual([]);
    expect(result.values["risk-factor-evaluate"]).toMatchObject({ status: "NEEDS_EVIDENCE", code: "POLICY_UNRESOLVED", policyGaps: ["risk_factor_maps"] });
    expect(skill.events.find((event) => event.code.startsWith("skill.result."))).toMatchObject({
      code: "skill.result.needs_evidence", values: { errorCode: "POLICY_UNRESOLVED", unresolvedCodes: ["POLICY_UNRESOLVED"], skillCalled: false },
    });
  });

  it("refuses the policy section for a case pinned to another bundle", async () => {
    const skill = harness(() => snapshot(plan, undefined, "e".repeat(64)), () => { throw new Error("the skill must not be called"); });
    const result = await skill.run("decision-policy-resolve");
    expect(result.values["decision-policy-resolve"]).toMatchObject({ status: "NEEDS_EVIDENCE", code: "POLICY_UNRESOLVED" });
  });

  it("does not run on an authored default when a bound predecessor payload is missing", async () => {
    // risk-tier-assign binds `score` from risk-customer-assess; without it the skill is not called.
    const skill = harness(() => snapshot(plan), () => { throw new Error("the skill must not be called"); });
    const result = await skill.run("risk-tier-assign", { "risk-customer-assess": { status: "NEEDS_EVIDENCE" } });
    expect(result.values["risk-tier-assign"]).toMatchObject({ status: "NEEDS_EVIDENCE", code: "CONTEXT_MISSING", parameterGaps: ["score"] });
  });
});
