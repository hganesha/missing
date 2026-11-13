import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { createKycCaseRequestSchema, registerEvidenceRequestSchema } from "@ehf/contracts";
import { createCaseStore, createKycCase, registerEvidence, type CaseExecutionAuthority, type CaseStore } from "./index.js";

// Phase 2 of docs/implementation/data-stores-plan.md: the control and case databases are
// separate. This test builds both from scratch on the server EHF_TEST_DATABASE_URL points
// at (as a role that can create databases and roles), migrates each with its own runner,
// and checks that case-api works across them while no control-plane identity can open the
// case database.

const adminUrl = process.env.EHF_TEST_DATABASE_URL;
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const tsx = `${repo}packages/persistence/node_modules/.bin/tsx`;

describe.skipIf(!adminUrl)("separate control and case databases", () => {
  let admin: pg.Pool;
  let canRun = false;
  const suffix = randomBytes(4).toString("hex");
  const controlDb = `ehf_split_control_${suffix}`;
  const caseDb = `ehf_split_case_${suffix}`;
  const password = randomBytes(18).toString("hex");
  const logins: Record<string, string[]> = {
    [`ehf_split_caseapi_${suffix}`]: ["ehf_svc_case_api", "ehf_svc_case_outbox_relay", "ehf_svc_case_execution"],
    [`ehf_split_dispatcher_${suffix}`]: ["ehf_svc_runtime_dispatcher"],
    [`ehf_split_control_${suffix}`]: ["ehf_svc_control_api"],
    [`ehf_split_gateway_${suffix}`]: ["ehf_svc_capability_gateway"],
  };
  const pools: pg.Pool[] = [];
  let store: CaseStore;

  const url = (database: string, login?: string) => {
    const value = new URL(adminUrl!);
    value.pathname = `/${database}`;
    if (login) { value.username = login; value.password = password; }
    return value.toString();
  };
  const pool = (database: string, login: string) => {
    const created = new pg.Pool({ connectionString: url(database, login), max: 2 });
    // Dropping the databases at the end terminates idle connections still closing.
    created.on("error", () => undefined);
    pools.push(created);
    return created;
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    const self = await admin.query<{ rolsuper: boolean }>("select rolsuper from pg_roles where rolname = current_user");
    canRun = Boolean(self.rows[0]?.rolsuper);
    if (!canRun) return;
    const env = { ...process.env, SECURITY_PROFILE: "development", DATABASE_BOOTSTRAP_URL: adminUrl!,
      DATABASE_URL: url(controlDb), CASE_DATABASE_URL: url(caseDb) };
    // The same three steps the migrate job runs, each against its own database.
    for (const script of ["packages/persistence/src/ensure-databases.ts", "packages/persistence/src/migrate.ts", "packages/case-store/src/migrate.ts"]) {
      execFileSync(tsx, [`${repo}${script}`], { env, cwd: repo, stdio: "pipe" });
    }
    for (const [login, groups] of Object.entries(logins)) {
      await admin.query(`create role ${login} login password '${password}' nosuperuser nobypassrls`);
      await admin.query(`grant ${groups.join(", ")} to ${login}`);
    }
    const caseApi = Object.keys(logins)[0]!;
    store = createCaseStore({ connectionString: url(caseDb, caseApi) });
    store.db.on("error", () => undefined);
    store.executionDb = pool(controlDb, caseApi);
  }, 120_000);

  afterAll(async () => {
    await store?.db.end();
    await Promise.all(pools.map((item) => item.end()));
    if (canRun) {
      for (const database of [controlDb, caseDb]) await admin.query(`drop database if exists ${database} with (force)`);
      for (const login of Object.keys(logins)) await admin.query(`drop role if exists ${login}`);
    }
    await admin?.end();
  });

  it("keeps each schema set in its own database", async ({ skip }) => {
    if (!canRun) skip();
    const schemas = async (database: string) => {
      const client = new pg.Client({ connectionString: url(database) });
      await client.connect();
      try {
        return (await client.query<{ nspname: string }>("select nspname from pg_namespace where nspname in ('case_core','case_ledger','evidence','harness_control','harness_runtime','workflow','integration') order by 1")).rows.map((row) => row.nspname);
      } finally { await client.end(); }
    };
    expect(await schemas(controlDb)).toEqual(["harness_control", "harness_runtime", "integration", "workflow"]);
    expect(await schemas(caseDb)).toEqual(["case_core", "case_ledger", "evidence"]);
  });

  it("refuses the case database to every control-plane identity", async ({ skip }) => {
    if (!canRun) skip();
    const [caseApi, dispatcher, control, gateway] = Object.keys(logins) as [string, string, string, string];
    // The gateway too: its retrieval index lives in the context database.
    for (const login of [dispatcher, control, gateway]) {
      await expect(pool(caseDb, login).query("select 1")).rejects.toThrow(/permission denied for database/);
      await expect(pool(controlDb, login).query("select 1")).resolves.toBeDefined();
    }
    // case-api reaches the control database for execution authority only.
    await expect(pool(controlDb, caseApi).query("select * from harness_runtime.runs")).rejects.toThrow(/permission denied/);
    await expect(pool(controlDb, caseApi).query("select * from workflow.work_items")).rejects.toThrow(/permission denied/);
  });

  it("checks execution authority in the control database while writing the case database", async ({ skip }) => {
    if (!canRun) skip();
    const tenantId = `split_${randomUUID()}`;
    const planDigest = randomBytes(32).toString("hex");
    const control = new pg.Client({ connectionString: url(controlDb) });
    await control.connect();
    try {
      const runId = `run_${randomUUID()}`;
      // Case creation resolves the admitted plan before choosing the decision contract.
      await control.query("insert into harness_control.plans(plan_digest, plan_id, name, domain, version, plan, tenant_id) values ($1, $2, 'split', 'kyc', '1', '{}', $3)",
        [planDigest, `plan-${runId}`, tenantId]);
    const caseId = String((await createKycCase(store, createKycCaseRequestSchema.parse({
      tenantId, policySnapshotDigest: "a".repeat(64), harnessPlanDigest: planDigest,
      actor: { type: "HUMAN", principalId: "requester@example.test", roles: [] },
    }), randomUUID())).case.caseId);
      await control.query(`insert into harness_runtime.runs(run_id, idempotency_key, plan_digest, status, input, attempt, fencing_epoch, lease_expires_at, tenant_id, request_digest)
        values ($1, $1, $2, 'running', $3, 1, 1, now() + interval '5 minutes', $4, 'split')`, [runId, planDigest, { caseId }, tenantId]);
      const execution: CaseExecutionAuthority = { tenant_id: tenantId, case_id: caseId, run_id: runId, plan_digest: planDigest, attempt: 1, fencing_epoch: 1 };
      const evidence = (key: string) => registerEvidence(store, registerEvidenceRequestSchema.parse({
        tenantId, caseId, type: "registry_extract", mediaType: "application/json",
        contentBase64: Buffer.from(JSON.stringify({ key })).toString("base64"),
        source: { type: "TOOL", capability: "registry.lookup", retrievedAt: "2026-11-08T00:00:00Z" },
        trust: { tier: "LICENSED_PROVIDER", instructionTrust: "UNTRUSTED_DATA" },
        createdBy: { type: "AGENT", principalId: "agent:registry", roles: [] },
      }), key, execution);

      // A live run in the control database lets the agent's evidence into the case database.
      expect((await evidence(`live-${runId}`)).created).toBe(true);
      // Cancelling the run in the control database stops the next write in the case database.
      await control.query("update harness_runtime.runs set cancellation_requested_at = now() where run_id = $1", [runId]);
      await expect(evidence(`cancelled-${runId}`)).rejects.toThrow("authorization.execution_inactive");
    } finally { await control.end(); }
  });
});
