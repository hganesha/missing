import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalRecordDigest, createKycCaseRequestSchema, type BusinessCommand, type CanonicalRecord, type CaseReadGrant, type CaseSnapshot } from "@ehf/contracts";
import { requiredRecordFields, validateRecordData } from "@ehf/library-contracts";
import { projectCanonicalRecords, selectCanonicalRecordVersions, recordCanonicalRecords } from "./canonical-records.js";
import { createCaseStore, createKycCase, getCanonicalCaseSnapshot, projectCanonicalCaseSnapshot, submitBusinessCommand } from "./index.js";

function stored(overrides: Partial<CanonicalRecord> & Pick<CanonicalRecord, "object_id" | "version_id" | "recorded_at">): CanonicalRecord {
  const base = {
    schema_version: "1.0.0", tenant_id: "t", case_id: "c", object_type: "RegistryRecord", data: { registration_id: "1", status: "active", coverage: {}, extra: "x" },
    subject_ids: [], valid_from: null, valid_to: null, observed_at: "2026-11-01T00:00:00.000Z", source_refs: [],
    provenance: { method: "connector_normalizer" as const }, classification: "CONFIDENTIAL", purposes: [], synthetic: true, supersedes: null,
    ...overrides,
  };
  return { ...base, record_digest: canonicalRecordDigest(base) } as CanonicalRecord;
}

describe("canonical record selection", () => {
  it("refuses a skill that labels its own record as a human control assessment", async () => {
    const record = stored({ object_type: "ControlAssessment", object_id: "control", version_id: "v1", recorded_at: "2026-11-01T00:00:00Z", data: { authority: "HUMAN", assessedBy: "reviewer" } });
    const { recorded_at: _recorded, record_digest: _digest, ...inputRecord } = record;
    const command: BusinessCommand = { commandId: "control-test", commandType: "RecordCanonicalRecords", commandVersion: "v1", tenantId: "t", caseId: "c",
      actor: { type: "AGENT", principalId: "skills:example", roles: [] }, payload: { records: [inputRecord] },
      authority: { planDigest: "a".repeat(64), policySnapshotDigest: "b".repeat(64), permissionEnvelopeDigest: "c".repeat(64) },
      preconditions: { caseSequence: 1 }, idempotencyKey: "control-test" };
    const client = { query: async () => ({ rows: [] }) } as unknown as Parameters<typeof recordCanonicalRecords>[0];
    await expect(recordCanonicalRecords(client, { core: "case_core", ledger: "case_ledger", evidence: "evidence" }, command,
      { recordedAt: "2026-11-08T00:00:00Z", caseSequence: 1 })).rejects.toThrow("record.control_assessment_authority_invalid");
  });
  const v1 = stored({ object_id: "a", version_id: "v1", recorded_at: "2026-11-01T00:00:00.000Z" });
  const v2 = stored({ object_id: "a", version_id: "v2", supersedes: "v1", recorded_at: "2026-11-03T00:00:00.000Z", data: { registration_id: "1", status: "dissolved", coverage: {} } });
  const future = stored({ object_id: "b", version_id: "v1", recorded_at: "2026-11-01T00:00:00.000Z", valid_from: "2026-12-01T00:00:00.000Z" });
  const expired = stored({ object_id: "c", version_id: "v1", recorded_at: "2026-11-01T00:00:00.000Z", valid_to: "2026-11-02T00:00:00.000Z" });

  it("select the latest known, valid, unsuperseded version per object", () => {
    const now = selectCanonicalRecordVersions([v1, v2, future, expired], { asOf: "2026-11-05T00:00:00Z", knowledgeCutoff: "2026-11-05T00:00:00Z" });
    expect(now.RegistryRecord!.map((record) => `${record.object_id}@${record.version_id}`)).toEqual(["a@v2"]);
    // What was known on 11-02: v2 had not been recorded, and c was still valid.
    const before = selectCanonicalRecordVersions([v1, v2, future, expired], { asOf: "2026-11-01T12:00:00Z", knowledgeCutoff: "2026-11-02T00:00:00Z" });
    expect(before.RegistryRecord!.map((record) => `${record.object_id}@${record.version_id}`)).toEqual(["a@v1", "c@v1"]);
    // Valid time moves independently of knowledge.
    const december = selectCanonicalRecordVersions([future], { asOf: "2026-12-02T00:00:00Z", knowledgeCutoff: "2026-11-05T00:00:00Z" });
    expect(december.RegistryRecord).toHaveLength(1);
  });

  it("project only the requested types and fields, and an empty list for a type with no records", () => {
    const selectors: CaseReadGrant[] = [
      { id: "r", source: "case", path: "records.RegistryRecord", purpose: "P", classification: "CONFIDENTIAL", required: true,
        record: { objectType: "RegistryRecord", fields: ["registration_id", "status"], minCount: 1, maxAgeSeconds: null } },
      { id: "w", source: "case", path: "records.WatchlistEntry", purpose: "P", classification: "CONFIDENTIAL", required: true,
        record: { objectType: "WatchlistEntry", fields: ["name"], minCount: 1, maxAgeSeconds: null } },
    ];
    const projected = projectCanonicalRecords({ RegistryRecord: [v1], Entity: [stored({ object_type: "Entity", object_id: "e", version_id: "v1", recorded_at: v1.recorded_at })] }, selectors);
    expect([...projected.keys()]).toEqual(["RegistryRecord", "WatchlistEntry"]);
    // `coverage` is required by the RegistryRecord contract, so it stays; `extra` was not asked for.
    expect(projected.get("RegistryRecord")![0]!.data).toEqual({ registration_id: "1", status: "active", coverage: {} });
    expect(projected.get("RegistryRecord")![0]!.record_digest).toBe(v1.record_digest);
    expect(projected.get("WatchlistEntry")).toEqual([]);
  });

  it("keep the fields a library type's contract requires, and withhold its other fields", () => {
    // The library validates each record against its type's closed schema: Party requires
    // entity_id, role, customer_type and profile. A skill that declares only customer_type must
    // still receive a record the library accepts, without the optional fields nobody asked for.
    const party = stored({ object_type: "Party", object_id: "p", version_id: "v1", recorded_at: v1.recorded_at,
      data: { entity_id: "e", role: "customer", customer_type: "individual", profile: { legal_name: "A" }, industry: "retail" } });
    const selectors: CaseReadGrant[] = [
      { id: "p", source: "case", path: "records.Party", purpose: "P", classification: "CONFIDENTIAL", required: true,
        record: { objectType: "Party", fields: ["customer_type"], minCount: 1, maxAgeSeconds: null } },
    ];
    const data = projectCanonicalRecords({ Party: [party] }, selectors).get("Party")![0]!.data;
    expect(data).toEqual({ entity_id: "e", role: "customer", customer_type: "individual", profile: { legal_name: "A" } });
    expect(validateRecordData("Party", data).valid).toBe(true);
    expect(requiredRecordFields("Party")).toEqual(["entity_id", "role", "customer_type", "profile"]);
    // Platform-only and unknown types are never sent to the library: nothing is added for them.
    expect(requiredRecordFields("BankingRelationship")).toEqual([]);
    expect(requiredRecordFields("NotAType")).toEqual([]);
  });

  it("project record selectors from a canonical snapshot without failing a required selector", () => {
    const snapshot = {
      apiVersion: "harness.factory/case-snapshot-v1", kind: "CaseSnapshot", snapshotId: "snapshot_x", snapshotDigest: "a".repeat(64),
      tenantId: "t", caseId: "c", caseSequence: 3, dependencyDigest: "b".repeat(64), planDigest: "c".repeat(64),
      policyAuthority: { policyId: "p", policyVersion: "1", policySnapshotDigest: "d".repeat(64), policyBundleDigest: "e".repeat(64) },
      consistency: "strong", classification: "CONFIDENTIAL", capturedAt: "2026-11-05T00:00:00.000Z",
      data: { subjects: [{ display_name: "Acme" }], records: { RegistryRecord: [v2] }, recordsAsOf: { asOf: "2026-11-05T00:00:00.000Z", knowledgeCutoff: "2026-11-05T00:00:00.000Z" } },
    } as CaseSnapshot;
    const projected = projectCanonicalCaseSnapshot(snapshot, [
      { id: "r", source: "case", path: "records.RegistryRecord", purpose: "P", classification: "CONFIDENTIAL", required: true,
        record: { objectType: "RegistryRecord", fields: ["status"], minCount: 1, maxAgeSeconds: null } },
      { id: "o", source: "case", path: "records.OwnershipInterest", purpose: "P", classification: "CONFIDENTIAL", required: true,
        record: { objectType: "OwnershipInterest", fields: ["owner"], minCount: 1, maxAgeSeconds: null } },
    ], [{ classification: "CONFIDENTIAL", action: "allow" }]);
    expect(projected.data).toEqual({
      // The asked-for field plus the fields the RegistryRecord contract requires.
      records: { RegistryRecord: [{ ...v2, data: { registration_id: v2.data.registration_id, status: "dissolved", coverage: v2.data.coverage } }], OwnershipInterest: [] },
      recordsAsOf: snapshot.data.recordsAsOf,
    });
    expect(projected.data).not.toHaveProperty("subjects");
  });
});

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("canonical records in PostgreSQL", () => {
  it("record immutable versions with ledger events, replay identical ones, refuse conflicts and select them into snapshots", async () => {
    const store = createCaseStore({ connectionString: process.env.EHF_TEST_DATABASE_URL! });
    const tenantId = `records_${randomUUID()}`;
    const actor = { type: "SYSTEM" as const, principalId: "kyb-connector-normalizer", roles: ["workflow.executor"] };
    try {
      const created = await createKycCase(store, createKycCaseRequestSchema.parse({ tenantId, policySnapshotDigest: "a".repeat(64), harnessPlanDigest: "b".repeat(64),
        policyAuthority: { policyId: "p", policyVersion: "1", policyBundleDigest: "c".repeat(64), dependencyDigest: "d".repeat(64) },
        actor: { type: "HUMAN", principalId: "test", roles: [] } }), randomUUID());
      const caseId = created.case.caseId;
      const record = (versionId: string, status: string, extra: Record<string, unknown> = {}) => ({
        object_type: "RegistryRecord", object_id: "registry:gb:01234567", version_id: versionId,
        data: { registration_id: "01234567", status, coverage: { status: "complete_for_requested_scope" } },
        observed_at: "2026-11-07T10:00:00Z",
        source_refs: [{ tenant_id: tenantId, object_type: "GatewayInvocation", object_id: "inv-1", version_id: "check-1" }],
        provenance: { method: "connector_normalizer", normalizer: "wiring.business@1" }, classification: "CONFIDENTIAL", synthetic: true, ...extra,
      });
      let sequence = 1;
      const submit = async (records: unknown[], key = randomUUID()) => {
        const command: BusinessCommand = { commandId: randomUUID(), commandType: "RecordCanonicalRecords", commandVersion: "v1", tenantId, caseId, actor,
          authority: { planDigest: "b".repeat(64), policySnapshotDigest: "a".repeat(64), permissionEnvelopeDigest: "e".repeat(64) },
          payload: { records }, preconditions: { caseSequence: sequence }, idempotencyKey: key } as BusinessCommand;
        const response = await submitBusinessCommand(store, command);
        sequence = Number(response.caseSequence);
        return response;
      };
      await submit([record("v1", "active")]);
      // The same version again is unchanged, not a second row.
      await submit([record("v1", "active")]);
      await expect(submit([record("v1", "dissolved")])).rejects.toThrow("record.version_conflict");
      await expect(submit([record("v2", "dissolved", { supersedes: "v0" })])).rejects.toThrow("record.supersession_conflict");
      await submit([record("v2", "dissolved")]);
      const events = await store.db.query("select event_type, payload from case_ledger.case_events where tenant_id=$1 and case_id=$2 and event_type='records.recorded' order by case_sequence", [tenantId, caseId]);
      expect(events.rows.map((row) => [row.payload.recordedCount, row.payload.unchangedCount])).toEqual([[1, 0], [0, 1], [1, 0]]);
      expect(events.rows[2].payload.records[0]).toMatchObject({ versionId: "v2", supersedes: "v1", outcome: "RECORDED" });

      const snapshot = await getCanonicalCaseSnapshot(store, tenantId, caseId, "KYB_ONBOARDING");
      const selected = (snapshot!.data.records as Record<string, CanonicalRecord[]>).RegistryRecord!;
      expect(selected.map((item) => [item.version_id, item.data.status, item.supersedes])).toEqual([["v2", "dissolved", "v1"]]);
      expect(selected[0]!.record_digest).toBe(canonicalRecordDigest(selected[0]!));
      const past = await getCanonicalCaseSnapshot(store, tenantId, caseId, "KYB_ONBOARDING", { knowledgeCutoff: "2000-01-01T00:00:00Z" });
      expect(past!.data).not.toHaveProperty("records");

      // Versions are immutable, and rows are invisible without the tenant binding.
      const client = await store.db.connect();
      try {
        await client.query("begin");
        await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
        await expect(client.query("update case_core.canonical_records set classification='PUBLIC' where tenant_id=$1", [tenantId])).rejects.toThrow(/immutable/);
        await client.query("rollback");
        const superuser = await client.query<{ rolsuper: boolean; rolbypassrls: boolean }>("select rolsuper, rolbypassrls from pg_roles where rolname = current_user");
        if (!superuser.rows[0]?.rolsuper && !superuser.rows[0]?.rolbypassrls) {
          const unbound = await client.query("select count(*)::int as n from case_core.canonical_records where tenant_id=$1", [tenantId]);
          expect(unbound.rows[0].n).toBe(0);
        }
      } finally { client.release(); }
    } finally { await store.db.end(); }
  });
});
