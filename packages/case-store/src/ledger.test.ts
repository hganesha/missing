import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createKycCaseRequestSchema, type BusinessCommand } from "@ehf/contracts";
import { createCaseStore, createKycCase, submitBusinessCommand, verifyCaseLedger, type CaseStore } from "./index.js";
import { createMemoryBlobContainer } from "@ehf/blob-store/testing";
import { createBlobSegmentStore, createFileSegmentStore, createPemSegmentSigner, exportLedgerSegment, segmentStoreFromEnv } from "./ledger-export.js";
import { verifyLedgerContainer, verifyLedgerDirectory } from "./ledger-verify.js";

// Phase 3 (docs/implementation/data-stores-plan.md §3.5): events enter the ledger only
// through append_event, nobody can change history, and exported segments verify offline.
// EHF_TEST_DATABASE_URL must point at a migrated database as a role that can create roles.

const adminUrl = process.env.EHF_TEST_DATABASE_URL;

describe.skipIf(!adminUrl)("hardened case ledger", () => {
  let admin: pg.Pool;
  let canRun = false;
  const suffix = randomBytes(4).toString("hex");
  const password = randomBytes(18).toString("hex");
  const logins = { caseApi: `ehf_ledger_caseapi_${suffix}`, exporter: `ehf_ledger_exporter_${suffix}` };
  let caseApi: CaseStore;
  let exporter: CaseStore;
  let exportDir: string;
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const signer = createPemSegmentSigner(privatePem, "test-ledger-key");

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    const self = await admin.query<{ rolsuper: boolean; rolcreaterole: boolean }>("select rolsuper, rolcreaterole from pg_roles where rolname = current_user");
    canRun = Boolean(self.rows[0]?.rolsuper || self.rows[0]?.rolcreaterole);
    if (!canRun) return;
    const url = (login: string) => { const value = new URL(adminUrl!); value.username = login; value.password = password; return value.toString(); };
    await admin.query(`create role ${logins.caseApi} login password '${password}' nosuperuser nobypassrls`);
    await admin.query(`grant ehf_svc_case_api to ${logins.caseApi}`);
    await admin.query(`create role ${logins.exporter} login password '${password}' nosuperuser nobypassrls`);
    await admin.query(`grant ehf_svc_ledger_exporter to ${logins.exporter}`);
    caseApi = createCaseStore({ connectionString: url(logins.caseApi) });
    exporter = createCaseStore({ connectionString: url(logins.exporter) });
    exportDir = await mkdtemp(join(tmpdir(), "ehf-ledger-"));
  });

  afterAll(async () => {
    await caseApi?.db.end();
    await exporter?.db.end();
    if (canRun) for (const login of Object.values(logins)) await admin.query(`drop role if exists ${login}`);
    await admin?.end();
    if (exportDir) await rm(exportDir, { recursive: true, force: true });
  });

  const newCase = async (tenantId: string) => String((await createKycCase(caseApi, createKycCaseRequestSchema.parse({
    tenantId, policySnapshotDigest: "a".repeat(64), harnessPlanDigest: "b".repeat(64),
    actor: { type: "HUMAN", principalId: "requester@example.test", roles: [] },
  }), randomUUID())).case.caseId);

  const addSubject = (tenantId: string, caseId: string, caseSequence: number, extra: Partial<BusinessCommand> = {}) =>
    submitBusinessCommand(caseApi, {
      commandId: randomUUID(), commandType: "AddSubject", commandVersion: "v1", tenantId, caseId,
      actor: { type: "HUMAN", principalId: "analyst@example.test", roles: [] },
      authority: { planDigest: "b".repeat(64), policySnapshotDigest: "a".repeat(64), permissionEnvelopeDigest: "c".repeat(64) },
      payload: { subjectType: "individual", displayName: "Test Subject" }, preconditions: { caseSequence },
      idempotencyKey: randomUUID(), ...extra,
    } as BusinessCommand);

  /** Run SQL as a login inside a transaction bound to `tenantId`, always rolling back. */
  const asTenant = async (store: CaseStore, tenantId: string, sql: string, values: unknown[] = []) => {
    const client = await store.db.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      return await client.query(sql, values);
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  };

  it("lets no runtime role write the ledger except through append_event", async ({ skip }) => {
    if (!canRun) skip();
    const tenantId = `ledger_${randomUUID()}`;
    const caseId = await newCase(tenantId);
    for (const store of [caseApi, exporter]) {
      await expect(asTenant(store, tenantId, `insert into case_ledger.case_events(tenant_id, case_id, case_sequence, event_id, event_type, event_schema,
        occurred_at, recorded_at, actor, command_id, authority, payload, event_digest)
        values ($1, $2, 99, 'forged', 'x', 'x', now(), now(), '{}', 'x', '{}', '{}', $3)`, [tenantId, caseId, "f".repeat(64)])).rejects.toThrow(/permission denied/);
      await expect(asTenant(store, tenantId, "update case_ledger.case_events set payload = '{}' where tenant_id = $1", [tenantId])).rejects.toThrow(/permission denied/);
      await expect(asTenant(store, tenantId, "delete from case_ledger.case_events where tenant_id = $1", [tenantId])).rejects.toThrow(/permission denied/);
      await expect(asTenant(store, tenantId, "update case_ledger.event_chain_heads set case_sequence = 0 where tenant_id = $1", [tenantId])).rejects.toThrow(/permission denied/);
      await expect(asTenant(store, tenantId, "insert into case_ledger.outbox(outbox_id) values ('forged')")).rejects.toThrow(/permission denied/);
    }
  });

  it("refuses to change or remove history even for the table owner", async ({ skip }) => {
    if (!canRun) skip();
    const tenantId = `ledger_${randomUUID()}`;
    const caseId = await newCase(tenantId);
    await expect(addSubject(tenantId, caseId, 99)).rejects.toThrow("command.case_sequence_conflict");
    for (const table of ["case_events", "command_receipts", "rejected_commands"]) {
      await expect(admin.query(`update case_ledger.${table} set tenant_id = tenant_id where tenant_id = $1`, [tenantId])).rejects.toThrow(/case_ledger\.immutable/);
      await expect(admin.query(`delete from case_ledger.${table} where tenant_id = $1`, [tenantId])).rejects.toThrow(/case_ledger\.immutable/);
    }
    await expect(admin.query("truncate case_ledger.case_events cascade")).rejects.toThrow(/case_ledger\.immutable/);
  });

  it("refuses a forked or replayed chain and records the refused command", async ({ skip }) => {
    if (!canRun) skip();
    const tenantId = `ledger_${randomUUID()}`;
    const caseId = await newCase(tenantId);
    const append = (sequence: number, previous: string | null, boundTenant = tenantId) => asTenant(caseApi, boundTenant, `
      select case_ledger.append_event($1, $2, $3, $4, 'forged', 'v1', now(), now(), '{}', 'cmd', '{}', '{}', '[]', $5, $6, $7, 'CONFIDENTIAL', '{}')
    `, [tenantId, caseId, sequence, `evt_${randomUUID()}`, previous, randomBytes(32).toString("hex"), `outbox_${randomUUID()}`]);
    const head = (await asTenant(caseApi, tenantId, "select event_digest from case_ledger.event_chain_heads where tenant_id = $1 and case_id = $2", [tenantId, caseId])).rows[0].event_digest as string;
    await expect(append(1, null)).rejects.toThrow(/chain_broken/);                 // replaying sequence 1
    await expect(append(2, "0".repeat(64))).rejects.toThrow(/chain_broken/);       // forking from a made-up head
    await expect(append(3, head)).rejects.toThrow(/chain_broken/);                 // skipping a sequence
    await expect(append(2, head, `other_${randomUUID()}`)).rejects.toThrow(/tenant_unbound/);

    await expect(addSubject(tenantId, caseId, 7)).rejects.toThrow("command.case_sequence_conflict");
    const refused = await asTenant(caseApi, tenantId, "select reason_code, http_status from case_ledger.rejected_commands where tenant_id = $1 and case_id = $2", [tenantId, caseId]);
    expect(refused.rows).toEqual([{ reason_code: "command.case_sequence_conflict", http_status: 409 }]);

    await addSubject(tenantId, caseId, 1, { occurredAt: "2026-11-07T12:00:00Z" } as Partial<BusinessCommand>);
    // A caller's timestamp without milliseconds still verifies: it is digested as it reads back.
    expect(await verifyCaseLedger(caseApi, tenantId, caseId)).toMatchObject({ valid: true, checkedEvents: 2 });
  });

  it("exports signed segments that verify offline and expose any tampering", async ({ skip }) => {
    if (!canRun) skip();
    const tenantId = `export_${randomUUID()}`;
    const sink = createFileSegmentStore(exportDir);
    const caseA = await newCase(tenantId);
    const caseB = await newCase(tenantId);
    await addSubject(tenantId, caseA, 1);

    const first = await exportLedgerSegment(exporter, { tenantId, signer, sink });
    expect(first?.manifest).toMatchObject({ segmentNumber: 1, previousSegmentId: null, eventCount: 3 });
    expect(await exportLedgerSegment(exporter, { tenantId, signer, sink })).toBeNull();
    await addSubject(tenantId, caseB, 1);
    const second = await exportLedgerSegment(exporter, { tenantId, signer, sink });
    expect(second?.manifest).toMatchObject({ segmentNumber: 2, previousSegmentId: first!.manifest.segmentId, eventCount: 1 });
    expect(second?.manifest.caseRanges).toEqual([expect.objectContaining({ caseId: caseB, fromSequence: 2, toSequence: 2 })]);

    const directory = join(exportDir, encodeURIComponent(tenantId));
    const verified = await verifyLedgerDirectory(directory, publicPem);
    expect(verified).toMatchObject({ valid: true, errors: [], segments: 2 });
    expect(verified.heads.get(caseA)?.sequence).toBe(2);

    // Another key: the signatures fail.
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    expect((await verifyLedgerDirectory(directory, other)).errors.some((error) => error.includes("signature"))).toBe(true);

    // One altered byte in an exported event: caught by the events digest and the event digest.
    const files = (await readdir(directory)).sort();
    const firstEvents = join(directory, files.find((name) => name.endsWith(".ndjson"))!);
    const original = await readFile(firstEvents, "utf8");
    const altered = original.replace('"eventType":"', '"eventType":"x');
    expect(altered).not.toBe(original);
    await writeFile(firstEvents, altered);
    const tampered = await verifyLedgerDirectory(directory, publicPem);
    expect(tampered.valid).toBe(false);
    expect(tampered.errors.join("\n")).toMatch(/events digest/);
    expect(tampered.errors.join("\n")).toMatch(/digest does not match its content/);
    await writeFile(firstEvents, original);

    // A missing segment breaks the series.
    await rm(join(directory, files.find((name) => name.endsWith(".manifest.json"))!));
    const gap = await verifyLedgerDirectory(directory, publicPem);
    expect(gap.valid).toBe(false);
    expect(gap.errors.join("\n")).toMatch(/must be segment 1/);

    // The recorded segment is part of the ledger: immutable like the events.
    await expect(admin.query("delete from case_ledger.ledger_segments where tenant_id = $1", [tenantId])).rejects.toThrow(/case_ledger\.immutable/);
  });

  it("exports segments to the ledger export container and verifies them from there", async ({ skip }) => {
    if (!canRun) skip();
    expect(() => segmentStoreFromEnv({ SECURITY_PROFILE: "production", LEDGER_EXPORT_DIR: "/tmp/x" })).toThrow("ledger_export.blob_required_in_production");
    {
      const blobs = createMemoryBlobContainer({ container: "ledger-export", immutability: "none" });
      await blobs.ensure();
      const sink = createBlobSegmentStore(blobs);
      const tenantId = `export_${randomUUID()}`;
      await addSubject(tenantId, await newCase(tenantId), 1);
      const segment = await exportLedgerSegment(exporter, { tenantId, signer, sink });
      expect(segment?.manifestRef).toBe(`artifact://object-store/${blobs.account}/ledger-export/${encodeURIComponent(tenantId)}/00000001-${segment!.manifest.segmentId}.manifest.json`);
      expect(await verifyLedgerContainer(blobs, tenantId, publicPem)).toMatchObject({ valid: true, errors: [], segments: 1 });
      // A segment name is never written twice with other bytes.
      await expect(sink.write(segment!.manifestRef.split("/ledger-export/")[1]!, Buffer.from("{}"))).rejects.toThrow("blob.content_conflict");
    }
  }, 60_000);
});
