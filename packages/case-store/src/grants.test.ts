import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createKycCaseRequestSchema, registerEvidenceRequestSchema } from "@ehf/contracts";
import { createCaseStore, createKycCase, getCaseView, getEvidence, listCases, listCaseEvents, registerEvidence, type CaseStore } from "./index.js";
import { drainOutbox, type OutboxRecord } from "./outbox-relay.js";

// The case database's grant matrix (grants.sql), tenant policies and relay functions
// (migration 012), exercised against a real PostgreSQL. EHF_TEST_DATABASE_URL must point
// at a migrated database as a role that can create roles; the test creates one throwaway
// login per service group and drops them afterwards.

const adminUrl = process.env.EHF_TEST_DATABASE_URL;
const MANAGED_SCHEMAS = ["case_core", "case_ledger", "evidence"];
const SERVICE_GROUPS = ["ehf_svc_case_api", "ehf_svc_case_outbox_relay", "ehf_svc_ledger_exporter", "ehf_svc_evidence_retention"];
// Roles that own security-definer functions: a table reached only through those functions
// (the case outbox) is granted to them, not to a service.
const FUNCTION_OWNERS = ["ehf_case_relay_controller", "ehf_ledger_writer"];
const UNUSED_TABLES = new Set(["case_core.schema_migrations"]);

type Service = "caseApi" | "relay" | "retrieval";
const GROUP: Record<Service, string> = { caseApi: "ehf_svc_case_api", relay: "ehf_svc_case_outbox_relay", retrieval: "ehf_svc_case_retrieval" };

describe.skipIf(!adminUrl)("case database grant matrix and tenant isolation", () => {
  let admin: pg.Pool;
  const logins: string[] = [];
  const as = {} as Record<Service, CaseStore>;
  let canRun = false;

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    const self = await admin.query<{ rolsuper: boolean; rolcreaterole: boolean }>("select rolsuper, rolcreaterole from pg_roles where rolname = current_user");
    canRun = Boolean(self.rows[0]?.rolsuper || self.rows[0]?.rolcreaterole);
    if (!canRun) return;
    const suffix = randomBytes(4).toString("hex");
    for (const [service, group] of Object.entries(GROUP) as [Service, string][]) {
      const login = `ehf_test_${service.toLowerCase()}_${suffix}`;
      const password = randomBytes(18).toString("hex");
      await admin.query(`create role ${login} login password '${password}' nosuperuser nobypassrls`);
      await admin.query(`grant ${group} to ${login}`);
      logins.push(login);
      const url = new URL(adminUrl!);
      url.username = login; url.password = password;
      as[service] = createCaseStore({ connectionString: url.toString() });
    }
  });

  afterAll(async () => {
    await Promise.all(Object.values(as).map((store) => store.db.end()));
    for (const login of logins) await admin.query(`drop role if exists ${login}`);
    await admin?.end();
  });

  const denied = async (store: CaseStore, sql: string, values: unknown[] = []) =>
    expect(store.db.query(sql, values)).rejects.toThrow(/permission denied/);

  const newCase = async (tenantId: string) => (await createKycCase(as.caseApi, createKycCaseRequestSchema.parse({
    tenantId, policySnapshotDigest: "a".repeat(64), harnessPlanDigest: "b".repeat(64),
    actor: { type: "HUMAN", principalId: "requester@example.test", roles: [] },
  }), randomUUID())).case.caseId;

  it("lists every table in the grant matrix and forces a tenant policy on each", async ({ skip }) => {
    if (!canRun) skip();
    const result = await admin.query<{ name: string; granted: boolean; forced: boolean; tenant: boolean }>(`
      select n.nspname || '.' || c.relname as name,
             bool_or(has_table_privilege(r.rolname, c.oid, 'select,insert,update,delete')) as granted,
             c.relrowsecurity and c.relforcerowsecurity as forced,
             exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped) as tenant
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      cross join unnest($2::text[]) as r(rolname)
      where c.relkind in ('r', 'p') and n.nspname = any($1::text[])
      group by n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity, c.oid order by 1
    `, [MANAGED_SCHEMAS, [...SERVICE_GROUPS, ...FUNCTION_OWNERS]]);
    expect(result.rows.filter((row) => !row.granted && !UNUSED_TABLES.has(row.name)).map((row) => row.name)).toEqual([]);
    expect(result.rows.filter((row) => row.tenant && !row.forced).map((row) => row.name)).toEqual([]);
  });

  it("keeps each tenant's cases, ledger and evidence invisible to every other tenant", async ({ skip }) => {
    if (!canRun) skip();
    const tenantA = `iso_a_${randomUUID()}`;
    const tenantB = `iso_b_${randomUUID()}`;
    const caseId = await newCase(tenantA);
    const registered = await registerEvidence(as.caseApi, registerEvidenceRequestSchema.parse({
      tenantId: tenantA, caseId, type: "registry_extract", mediaType: "application/json",
      contentBase64: Buffer.from(JSON.stringify({ registry: "x" })).toString("base64"),
      source: { type: "TOOL", capability: "registry.lookup", retrievedAt: "2026-11-08T00:00:00Z" },
      trust: { tier: "LICENSED_PROVIDER", instructionTrust: "UNTRUSTED_DATA" },
      createdBy: { type: "SYSTEM", principalId: "grants-test", roles: [] },
    }), randomUUID());
    const evidenceId = String(registered.evidence.evidenceId);

    expect((await listCases(as.caseApi, { tenantId: tenantA })).map((item) => item.caseId)).toEqual([caseId]);
    expect((await getCaseView(as.caseApi, tenantA, caseId))?.case.caseId).toBe(caseId);
    expect(await getEvidence(as.caseApi, tenantA, evidenceId)).not.toBeNull();
    expect((await listCaseEvents(as.caseApi, tenantA, caseId)).length).toBeGreaterThan(0);

    // Asking as tenant B for tenant A's identifiers finds nothing.
    expect(await listCases(as.caseApi, { tenantId: tenantB })).toEqual([]);
    expect(await getCaseView(as.caseApi, tenantB, caseId)).toBeNull();
    expect(await getEvidence(as.caseApi, tenantB, evidenceId)).toBeNull();
    expect(await listCaseEvents(as.caseApi, tenantB, caseId)).toEqual([]);

    // Even a hand-written query that names tenant A sees nothing unless the transaction is
    // bound to tenant A: no binding, no rows.
    for (const table of ["case_core.cases", "case_ledger.case_events", "evidence.evidence_objects", "evidence.artifacts"]) {
      const unbound = await as.caseApi.db.query(`select count(*)::int as n from ${table} where tenant_id = $1`, [tenantA]);
      expect(unbound.rows[0].n, table).toBe(0);
    }
    // And a transaction bound to tenant B cannot write a row for tenant A.
    const client = await as.caseApi.db.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantB]);
      await expect(client.query("update case_core.cases set status = 'CLOSED' where tenant_id = $1 and case_id = $2 returning 1", [tenantA, caseId]))
        .resolves.toMatchObject({ rowCount: 0 });
      await expect(client.query(`insert into case_core.case_risk(tenant_id, case_id) values ($1, $2)`, [tenantA, caseId]))
        .rejects.toThrow(/row-level security|null value/);
      await client.query("rollback");
    } finally { client.release(); }
  });

  it("lets case-api append to the ledger but never change or delete history", async ({ skip }) => {
    if (!canRun) skip();
    const tenantId = `ledger_${randomUUID()}`;
    await newCase(tenantId);
    await denied(as.caseApi, "update case_ledger.case_events set payload = '{}'");
    await denied(as.caseApi, "delete from case_ledger.case_events");
    await denied(as.caseApi, "delete from case_ledger.command_receipts");
    await denied(as.caseApi, "delete from case_core.cases");
    await denied(as.caseApi, "update evidence.evidence_objects set classification = 'PUBLIC'");
    await denied(as.caseApi, "delete from evidence.artifacts");
    // It writes outbox rows but reads none: delivery is the relay's job.
    await denied(as.caseApi, "select * from case_ledger.outbox");
    await denied(as.caseApi, "create table case_core.intruder(id int)");
  });

  it("relays every tenant's events through the relay functions only", async ({ skip }) => {
    if (!canRun) skip();
    const tenantA = `relay_a_${randomUUID()}`;
    const tenantB = `relay_b_${randomUUID()}`;
    const caseA = await newCase(tenantA);
    const caseB = await newCase(tenantB);
    const published: OutboxRecord[] = [];
    // Drain until both new cases' events are out (other tests' rows may be queued too).
    for (let round = 0; round < 20 && !(published.some((r) => r.caseId === caseA) && published.some((r) => r.caseId === caseB)); round++) {
      await drainOutbox(as.relay, { name: "test", publish: async (records) => { published.push(...records); } }, { batchSize: 500 });
    }
    expect(published.find((record) => record.caseId === caseA)).toMatchObject({ tenantId: tenantA, planDigest: "b".repeat(64) });
    expect(published.find((record) => record.caseId === caseB)).toMatchObject({ tenantId: tenantB });
    const marked = await admin.query("select count(*)::int as n from case_ledger.outbox where case_id = any($1) and published_at is null", [[caseA, caseB]]);
    expect(marked.rows[0].n).toBe(0);
    // The relay reads no table directly, so it can never see a payload or case content.
    await denied(as.relay, "select * from case_ledger.outbox");
    await denied(as.relay, "select * from case_core.cases");
    await denied(as.relay, "select * from case_ledger.case_events");
    await denied(as.relay, "delete from case_ledger.outbox");
  });

  it("leaves the former retrieval role no access at all: the index moved to the context database", async ({ skip }) => {
    if (!canRun) skip();
    expect((await admin.query("select to_regclass('case_core.knowledge_chunks') as t")).rows[0].t).toBeNull();
    await expect(as.retrieval.db.query("select 1")).rejects.toThrow(/permission denied for database/);
  });
});
