import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { BlobStoreError, retentionDecision, type BlobContainer, type BlobHead } from "@ehf/blob-store";
import { createKycCaseRequestSchema, registerEvidenceRequestSchema, type BusinessCommand } from "@ehf/contracts";
import {
  createCaseStore, createKycCase, getContextReleaseEligibility, governTenantEvidence, listCaseEvents, placeLegalHold,
  reconcileTenantEvidence, registerEvidence, releaseLegalHold, submitBusinessCommand, type CaseStore,
} from "./index.js";

// Retention assignments, storage retention and legal holds (data-stores-plan.md §3.6, phase 5)
// against a real PostgreSQL. Storage is a recording container with version-level immutability,
// so they need no object store. EHF_TEST_DATABASE_URL: a migrated database.

const adminUrl = process.env.EHF_TEST_DATABASE_URL;
const YEAR = 365 * 86_400_000;

type Call = { op: "retention" | "hold"; name: string; until?: string; locked?: boolean; hold?: boolean };

/** An in-memory container that behaves like version-level immutable storage and records each policy call. */
function recordingContainer(options: { failHolds?: boolean } = {}): BlobContainer & { calls: Call[]; heads: Map<string, BlobHead> } {
  const bytes = new Map<string, Buffer>();
  const heads = new Map<string, BlobHead>();
  const calls: Call[] = [];
  return {
    account: "testaccount", container: "evidence", immutability: "object_lock", calls, heads,
    async ensure() {},
    async putImmutable(name, data, { sha256 }) {
      if (!bytes.has(name)) { bytes.set(name, Buffer.from(data)); heads.set(name, { exists: true, length: data.length, sha256, legalHold: false }); }
      return { account: "testaccount", container: "evidence", name, versionId: null, length: data.length, sha256 };
    },
    async get(name) { const value = bytes.get(name); if (!value) throw new BlobStoreError("blob.not_found", 404); return value; },
    async head(name) { return heads.get(name) ?? { exists: false }; },
    async setRetention(name, until, locked) {
      const current = heads.get(name)!;
      const decision = retentionDecision(current, until, locked);
      calls.push({ op: "retention", name, until: decision.until.toISOString(), locked: decision.mode === "Locked" });
      heads.set(name, { ...current, retainUntil: decision.until, retentionMode: decision.mode });
      return { applied: true, state: decision.mode === "Locked" ? "LOCKED" : "APPLIED" };
    },
    async setLegalHold(name, hold) {
      if (options.failHolds) throw new Error("storage unavailable");
      calls.push({ op: "hold", name, hold });
      heads.set(name, { ...heads.get(name)!, legalHold: hold });
      return { applied: true, state: "APPLIED" };
    },
    async delete() { throw new Error("not used"); },
    async *list(prefix) {
      for (const [name, head] of heads) {
        if (name.startsWith(prefix)) yield { name, length: head.length!, sha256: head.sha256 ?? null, retainUntil: head.retainUntil ?? null, retentionMode: head.retentionMode ?? null, legalHold: head.legalHold ?? false };
      }
    },
  };
}

describe.skipIf(!adminUrl)("evidence retention and legal holds", () => {
  let admin: pg.Pool;
  let blobs: ReturnType<typeof recordingContainer>;
  let store: CaseStore;
  beforeAll(() => {
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    blobs = recordingContainer();
    store = createCaseStore({ connectionString: adminUrl!, artifactBackend: "object_store", evidenceBlobs: blobs });
  });
  afterAll(async () => { await store?.db.end(); await admin?.end(); });

  const PLAN = "b".repeat(64);
  const newCase = async (tenantId: string) => String((await createKycCase(store, createKycCaseRequestSchema.parse({
    tenantId, policySnapshotDigest: "a".repeat(64), harnessPlanDigest: PLAN, actor: { type: "HUMAN", principalId: "requester", roles: [] },
  }), randomUUID())).case.caseId);
  const register = async (tenantId: string, caseId: string, text: string, retentionClass = "KYC_REGULATED") => {
    const result = await registerEvidence(store, registerEvidenceRequestSchema.parse({
      tenantId, caseId, type: "registry_extract", mediaType: "text/plain", contentBase64: Buffer.from(text).toString("base64"),
      source: { type: "TOOL", retrievedAt: new Date().toISOString() }, trust: { tier: "LICENSED_PROVIDER", instructionTrust: "UNTRUSTED_DATA" },
      retentionClass, createdBy: { type: "HUMAN", principalId: "analyst", roles: [] },
    }), randomUUID());
    const evidenceId = String(result.evidence.evidenceId);
    const row = (await admin.query(`select a.blob_name, a.artifact_digest from evidence.artifacts a
      join evidence.evidence_objects e on e.tenant_id = a.tenant_id and e.artifact_ref = a.artifact_ref where e.evidence_id = $1`, [evidenceId])).rows[0];
    return { evidenceId, blobName: row.blob_name as string, digest: row.artifact_digest as string };
  };
  const transition = async (tenantId: string, caseId: string, toStatus: string) => submitBusinessCommand(store, {
    commandId: randomUUID(), commandType: "TransitionCaseStatus", commandVersion: "v1", tenantId, caseId,
    actor: { type: "HUMAN", principalId: "analyst", roles: [] },
    authority: { planDigest: PLAN, policySnapshotDigest: "a".repeat(64), permissionEnvelopeDigest: "c".repeat(64) } as BusinessCommand["authority"],
    payload: { toStatus, reason: "test" }, preconditions: { caseSequence: (await listCaseEvents(store, tenantId, caseId)).length }, idempotencyKey: randomUUID(),
  });

  it("assigns retention at registration, keeps a floor while the case is open, and dates it from closure", async () => {
    const tenantId = `gov_${randomUUID()}`;
    const caseId = await newCase(tenantId);
    const kyc = await register(tenantId, caseId, "passport scan");
    const upload = await register(tenantId, caseId, "scratch upload", "TRANSIENT_UPLOAD");
    const assignments = (await admin.query(`select evidence_id, basis, retain_until, assigned_at from evidence.retention_assignments where tenant_id = $1`, [tenantId])).rows;
    const of = (id: string) => assignments.find((row) => row.evidence_id === id)!;
    expect(of(kyc.evidenceId)).toMatchObject({ basis: "CASE_CLOSED", retain_until: null });
    expect(of(upload.evidenceId).basis).toBe("REGISTERED");
    // A day from registration (the evidence's own timestamp, a moment before the assignment row's).
    expect(Math.abs(of(upload.evidenceId).retain_until.getTime() - of(upload.evidenceId).assigned_at.getTime() - 86_400_000)).toBeLessThan(1000);

    // Open case: KYC evidence is kept, locked, at least seven years from registration.
    expect(await governTenantEvidence(store, tenantId)).toMatchObject({ datesSet: 0, retention: { locked: 1, applied: 1, failed: 0 } });
    const floor = blobs.calls.find((call) => call.name === kyc.blobName && call.op === "retention")!;
    expect(floor.locked).toBe(true);
    expect(Date.parse(floor.until!) - of(kyc.evidenceId).assigned_at.getTime()).toBeGreaterThanOrEqual(7 * YEAR);
    expect(blobs.calls.find((call) => call.name === upload.blobName)).toMatchObject({ locked: false });
    // Nothing changed, nothing to do.
    const before = blobs.calls.length;
    expect(await governTenantEvidence(store, tenantId)).toMatchObject({ retention: { locked: 0, applied: 0 } });
    expect(blobs.calls.length).toBe(before);

    // Closed: the date runs from the close, and storage is extended to it.
    await transition(tenantId, caseId, "SUSPENDED");
    await transition(tenantId, caseId, "CLOSED");
    const closedAt = Date.parse((await getContextReleaseEligibility(store, tenantId, caseId))!.closed!.at);
    expect(await governTenantEvidence(store, tenantId)).toMatchObject({ datesSet: 1, retention: { locked: 1 } });
    const dated = (await admin.query(`select retain_until from evidence.retention_assignments where tenant_id = $1 and evidence_id = $2`, [tenantId, kyc.evidenceId])).rows[0].retain_until as Date;
    expect(dated.getTime()).toBeGreaterThanOrEqual(closedAt + 7 * YEAR - 2 * 86_400_000);
    expect(blobs.heads.get(kyc.blobName)!.retainUntil!.getTime()).toBe(dated.getTime());
    expect((await admin.query(`select retention_state, retain_until from evidence.artifacts where tenant_id = $1 and artifact_digest = $2`, [tenantId, kyc.digest])).rows[0])
      .toMatchObject({ retention_state: "LOCKED", retain_until: dated });

    // Nobody shortens a date, not even the table owner.
    await expect(admin.query(`update evidence.retention_assignments set retain_until = retain_until - interval '1 day' where tenant_id = $1 and evidence_id = $2`, [tenantId, kyc.evidenceId]))
      .rejects.toThrow(/retention_shortened/);
    await expect(admin.query(`delete from evidence.retention_assignments where tenant_id = $1`, [tenantId])).rejects.toThrow(/retention_immutable/);
  });

  it("refuses evidence with an unknown retention class", async () => {
    const tenantId = `gov_${randomUUID()}`;
    const caseId = await newCase(tenantId);
    expect(() => registerEvidenceRequestSchema.parse({
      tenantId, caseId, type: "x", mediaType: "text/plain", contentBase64: "eA==", retentionClass: "FOREVER",
      source: { type: "TOOL", retrievedAt: new Date().toISOString() }, trust: { tier: "T", instructionTrust: "UNTRUSTED_DATA" },
      createdBy: { type: "HUMAN", principalId: "analyst", roles: [] },
    })).toThrow();
  });

  it("holds a case's evidence, including evidence added under the hold, until a second officer releases it", async () => {
    const tenantId = `gov_${randomUUID()}`;
    const caseId = await newCase(tenantId);
    const otherCase = await newCase(tenantId);
    const first = await register(tenantId, caseId, "board minutes");
    const outside = await register(tenantId, otherCase, "unrelated filing");

    const placed = await placeLegalHold(store, tenantId, "matter-key-1", {
      matterRef: "MATTER-2026-0042", caseIds: [caseId], authority: { basis: "litigation_hold_notice" }, placedBy: "officer.a",
    });
    expect(placed.created).toBe(true);
    expect(placed.hold).toMatchObject({ caseIds: [caseId], placedBy: "officer.a", releasedBy: null, targets: { pending: 1 } });
    // The same request again is the same hold; a different one under the key is refused.
    expect((await placeLegalHold(store, tenantId, "matter-key-1", {
      matterRef: "MATTER-2026-0042", caseIds: [caseId], authority: { basis: "litigation_hold_notice" }, placedBy: "officer.a",
    })).created).toBe(false);
    await expect(placeLegalHold(store, tenantId, "matter-key-1", {
      matterRef: "MATTER-OTHER", caseIds: [caseId], authority: { basis: "x" }, placedBy: "officer.a",
    })).rejects.toThrow("legal_hold.idempotency_conflict");

    // Evidence registered while the hold is active joins it.
    const added = await register(tenantId, caseId, "later disclosure");
    expect((await admin.query(`select artifact_digest from evidence.legal_hold_targets where tenant_id = $1 order by 1`, [tenantId])).rows.map((row) => row.artifact_digest))
      .toEqual([first.digest, added.digest].sort());

    // The ledger records the hold without the matter.
    const events = await listCaseEvents(store, tenantId, caseId);
    const holdEvent = events.find((event) => event.eventType === "legal_hold.placed")!;
    expect(holdEvent.payload).toEqual({ holdId: placed.hold.holdId, caseCount: 1 });
    expect(JSON.stringify(events)).not.toContain("MATTER-2026-0042");
    expect((await getContextReleaseEligibility(store, tenantId, caseId))!.legalHold).toBe(true);
    expect((await getContextReleaseEligibility(store, tenantId, otherCase))!.legalHold).toBe(false);

    const governed = await governTenantEvidence(store, tenantId);
    expect(governed.holds).toMatchObject({ applied: 2, failed: 0 });
    expect(blobs.heads.get(first.blobName)!.legalHold).toBe(true);
    expect(blobs.heads.get(added.blobName)!.legalHold).toBe(true);
    expect(blobs.heads.get(outside.blobName)!.legalHold).toBe(false);

    // A hold record does not change except by its release, and is never deleted.
    await expect(admin.query(`update evidence.legal_holds set matter_ref = 'x' where tenant_id = $1`, [tenantId])).rejects.toThrow(/legal_hold_immutable/);
    await expect(admin.query(`delete from evidence.legal_holds where tenant_id = $1`, [tenantId])).rejects.toThrow(/legal_hold_immutable/);

    // Whoever placed it cannot release it.
    await expect(releaseLegalHold(store, tenantId, placed.hold.holdId, { releasedBy: "officer.a", authority: { basis: "matter_closed" } }))
      .rejects.toThrow("legal_hold.release_requires_second_person");
    // A second hold over the same case keeps the blobs held when the first is released.
    const second = await placeLegalHold(store, tenantId, "matter-key-2", {
      matterRef: "MATTER-2026-0099", caseIds: [caseId], authority: { basis: "regulator_request" }, placedBy: "officer.b",
    });
    const released = await releaseLegalHold(store, tenantId, placed.hold.holdId, { releasedBy: "officer.b", authority: { basis: "matter_closed" } });
    expect(released.hold).toMatchObject({ releasedBy: "officer.b" });
    expect((await listCaseEvents(store, tenantId, caseId)).some((event) => event.eventType === "legal_hold.released")).toBe(true);
    expect(await governTenantEvidence(store, tenantId)).toMatchObject({ holds: { released: 2 } });
    expect(blobs.heads.get(first.blobName)!.legalHold).toBe(true);
    expect((await getContextReleaseEligibility(store, tenantId, caseId))!.legalHold).toBe(true);

    await releaseLegalHold(store, tenantId, second.hold.holdId, { releasedBy: "officer.c", authority: { basis: "request_withdrawn" } });
    expect(await governTenantEvidence(store, tenantId)).toMatchObject({ holds: { released: 2 } });
    expect(blobs.heads.get(first.blobName)!.legalHold).toBe(false);
    expect(blobs.heads.get(added.blobName)!.legalHold).toBe(false);
    expect((await getContextReleaseEligibility(store, tenantId, caseId))!.legalHold).toBe(false);
    expect((await admin.query(`select distinct legal_hold_state from evidence.artifacts where tenant_id = $1`, [tenantId])).rows.map((row) => row.legal_hold_state)).toEqual(["NONE"]);
  });

  it("marks a hold that storage refused as failed and retries it next run", async () => {
    const tenantId = `gov_${randomUUID()}`;
    const failing = recordingContainer({ failHolds: true });
    const failingStore = createCaseStore({ connectionString: adminUrl!, artifactBackend: "object_store", evidenceBlobs: failing });
    try {
      const caseId = await newCase(tenantId);
      await registerEvidence(failingStore, registerEvidenceRequestSchema.parse({
        tenantId, caseId, type: "x", mediaType: "text/plain", contentBase64: Buffer.from("held bytes").toString("base64"),
        source: { type: "TOOL", retrievedAt: new Date().toISOString() }, trust: { tier: "T", instructionTrust: "UNTRUSTED_DATA" },
        createdBy: { type: "HUMAN", principalId: "analyst", roles: [] },
      }), randomUUID());
      await placeLegalHold(failingStore, tenantId, "k", { matterRef: "M", caseIds: [caseId], authority: { basis: "b" }, placedBy: "officer.a" });
      expect((await governTenantEvidence(failingStore, tenantId)).holds).toMatchObject({ applied: 0, failed: 1 });
      expect((await admin.query(`select storage_state from evidence.legal_hold_targets where tenant_id = $1`, [tenantId])).rows[0].storage_state).toBe("FAILED");
      // Storage back: the next run applies it.
      expect((await governTenantEvidence(store, tenantId)).holds).toMatchObject({ applied: 1, failed: 0 });
    } finally { await failingStore.db.end(); }
  });

  it("reports storage that does not carry the retention or hold its row records", async () => {
    const tenantId = `gov_${randomUUID()}`;
    const caseId = await newCase(tenantId);
    const kept = await register(tenantId, caseId, "kept bytes");
    const held = await register(tenantId, caseId, "held bytes");
    await placeLegalHold(store, tenantId, "k", { matterRef: "M", caseIds: [caseId], authority: { basis: "b" }, placedBy: "officer.a" });
    await governTenantEvidence(store, tenantId);
    expect(await reconcileTenantEvidence(store, tenantId)).toMatchObject({ checked: 2, verified: 2, policyMismatch: 0 });
    // Someone with storage access clears a hold and an unlocked retention behind the platform's back.
    blobs.heads.set(held.blobName, { ...blobs.heads.get(held.blobName)!, legalHold: false });
    blobs.heads.set(kept.blobName, { ...blobs.heads.get(kept.blobName)!, retentionMode: "Unlocked" });
    const report = await reconcileTenantEvidence(store, tenantId);
    expect(report.policyMismatch).toBe(2);
    expect(report.findings.map((finding) => finding.detail).sort()).toEqual(["legal hold missing", "retention not locked"]);
  });

  it("keeps the retention job and case-api to their own parts", async () => {
    const self = (await admin.query<{ ok: boolean }>("select rolsuper or rolcreaterole as ok from pg_roles where rolname = current_user")).rows[0];
    if (!self?.ok) return;
    const suffix = randomBytes(4).toString("hex");
    const logins: Record<string, string> = {};
    for (const [key, group] of [["job", "ehf_svc_evidence_retention"], ["api", "ehf_svc_case_api"]] as const) {
      const login = `ehf_test_${key}_${suffix}`;
      const password = randomBytes(18).toString("hex");
      await admin.query(`create role ${login} login password '${password}' nosuperuser nobypassrls`);
      await admin.query(`grant ${group} to ${login}`);
      const url = new URL(adminUrl!); url.username = login; url.password = password;
      logins[key] = url.toString();
    }
    const job = new pg.Pool({ connectionString: logins.job, max: 1 });
    const api = new pg.Pool({ connectionString: logins.api, max: 1 });
    try {
      const denied = (pool: pg.Pool, sql: string) => expect(pool.query(sql)).rejects.toThrow(/permission denied/);
      await denied(job, "insert into evidence.legal_holds(tenant_id, hold_id, matter_ref, case_ids, authority, placed_by) values ('t','h','m','{c}','{}','x')");
      await denied(job, "update evidence.legal_holds set released_by = 'x'");
      await denied(job, "update evidence.artifacts set content = null");
      await denied(job, "insert into case_ledger.case_events(tenant_id) values ('t')");
      await denied(job, "delete from evidence.reconciliation_runs");
      await denied(api, "insert into evidence.reconciliation_runs(tenant_id, run_id, container) values ('t', 'r', 'c')");
      await denied(api, "update evidence.artifacts set retention_state = 'LOCKED'");
      await denied(api, "update evidence.legal_hold_targets set storage_state = 'APPLIED'");
      await denied(api, "update evidence.retention_assignments set retain_until = now()");
      await denied(api, "update evidence.legal_holds set matter_ref = 'x'");
    } finally {
      await Promise.all([job.end(), api.end()]);
      for (const key of ["job", "api"]) await admin.query(`drop role if exists ehf_test_${key}_${suffix}`);
    }
  });
});
