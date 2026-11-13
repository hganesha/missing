import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { ContextPack } from "@ehf/context-plane";
import { createContextStore, packSources, packsDrawingOn, recordContextPack, searchKnowledge, sourcesOfPack, stableProvenanceRef, type ContextStore } from "./index.js";

// The context database (pgvector + Apache AGE), built from scratch on the server
// EHF_TEST_DATABASE_URL points at, as a superuser (the migration preloads AGE for the new
// database). Skipped when the server has no AGE.

const adminUrl = process.env.EHF_TEST_DATABASE_URL;
const repo = fileURLToPath(new URL("../../../", import.meta.url));

function pack(input: { runId: string; nodeId?: string; caseId: string; evidence: string[]; seed: string }): ContextPack {
  return {
    apiVersion: "harness.factory/context-pack-v1",
    packDigest: randomBytes(32).toString("hex"),
    planDigest: "a".repeat(64), nodeId: input.nodeId ?? "screen", runId: input.runId, capabilityId: "model.reasoning", task: "Screen the subject",
    instructions: null,
    sections: [
      { id: "subject", kind: "case", purpose: "kyc.screening", classification: "CONFIDENTIAL", trust: "TRUSTED_DATA",
        provenanceRef: `case:${input.caseId}@3/subjects`, contentDigest: "b".repeat(64), required: true, quarantined: false, value: { name: input.seed } },
      { id: "evidence", kind: "evidence", purpose: "kyc.screening", classification: "CONFIDENTIAL", trust: "UNTRUSTED_EXTERNAL",
        provenanceRef: `case:${input.caseId}@3/evidence`, contentDigest: "c".repeat(64), required: false, quarantined: input.seed === "quarantine",
        value: input.evidence.map((evidenceId) => ({ evidenceId, type: "screening_result" })) },
      { id: "upstream", kind: "upstream", purpose: "workflow.predecessor_output", classification: "INTERNAL", trust: "UNTRUSTED_DATA",
        provenanceRef: `run:${input.runId}/predecessors:screen`, contentDigest: "d".repeat(64), required: false, quarantined: false, value: {} },
    ],
    budget: { maxChars: 60_000, usedChars: 1200, droppedSectionIds: ["upstream"] },
    signals: input.seed === "quarantine" ? [{ sectionId: "evidence", code: "ignore_previous_instructions" }] : [],
    manifest: null,
    contextEnvelope: null,
  } as unknown as ContextPack;
}

describe.skipIf(!adminUrl)("context store (pgvector + Apache AGE)", () => {
  let admin: pg.Pool;
  let canRun = false;
  const suffix = randomBytes(4).toString("hex");
  const database = `ehf_context_test_${suffix}`;
  const password = randomBytes(18).toString("hex");
  const logins = { writer: `ehf_ctx_writer_${suffix}`, retrieval: `ehf_ctx_retrieval_${suffix}`, other: `ehf_ctx_other_${suffix}` };
  const as = {} as Record<keyof typeof logins, ContextStore>;
  const url = (login?: string) => {
    const value = new URL(adminUrl!);
    value.pathname = `/${database}`;
    if (login) { value.username = login; value.password = password; }
    return value.toString();
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: adminUrl, max: 2 });
    const ready = await admin.query<{ superuser: boolean; age: boolean }>(`
      select (select rolsuper from pg_roles where rolname = current_user) as superuser,
             exists (select 1 from pg_available_extensions where name = 'age') as age`);
    const row = ready.rows[0]!;
    canRun = row.superuser && row.age;
    if (!canRun) return;
    await admin.query(`create database ${database}`);
    execFileSync(`${repo}packages/context-store/node_modules/.bin/tsx`, [`${repo}packages/context-store/src/migrate.ts`],
      { env: { ...process.env, CONTEXT_DATABASE_URL: url() }, cwd: repo, stdio: "pipe" });
    const groups = { writer: "ehf_svc_context_writer", retrieval: "ehf_svc_context_retrieval", other: "ehf_svc_context_release" };
    for (const [name, login] of Object.entries(logins) as [keyof typeof logins, string][]) {
      await admin.query(`create role ${login} login password '${password}' nosuperuser nobypassrls`);
      await admin.query(`grant ${groups[name]} to ${login}`);
      as[name] = createContextStore({ connectionString: url(login) });
      as[name].db.on("error", () => undefined);
    }
  }, 120_000);

  afterAll(async () => {
    await Promise.all(Object.values(as).map((store) => store.db.end()));
    if (canRun) {
      await admin.query(`drop database if exists ${database} with (force)`);
      for (const login of Object.values(logins)) await admin.query(`drop role if exists ${login}`);
    }
    await admin?.end();
  });

  const denied = (store: ContextStore, sql: string) => expect(store.db.query(sql)).rejects.toThrow(/permission denied/);

  it("records a pack once, with its sections, signals and graph links, invisible to other tenants", async ({ skip }) => {
    if (!canRun) skip();
    const tenantId = `ctx_${randomUUID()}`;
    const first = pack({ runId: "run-1", caseId: "case-1", evidence: ["ev_1", "ev_2"], seed: "quarantine" });
    expect(await recordContextPack(as.writer, { tenantId, caseId: "case-1", runId: "run-1", nodeId: "screen", attempt: 1, pack: first })).toEqual({ recorded: true });
    expect(await recordContextPack(as.writer, { tenantId, caseId: "case-1", runId: "run-1", nodeId: "screen", attempt: 1, pack: first })).toEqual({ recorded: false });

    const client = await as.writer.db.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      expect((await client.query("select section_id, disposition from context.pack_sections order by section_id")).rows).toEqual([
        { section_id: "evidence", disposition: "QUARANTINED" }, { section_id: "subject", disposition: "INCLUDED" }, { section_id: "upstream", disposition: "DROPPED_BUDGET" },
      ]);
      expect((await client.query("select signal from context.quarantine_signals")).rows).toEqual([{ signal: "ignore_previous_instructions" }]);
      await client.query("select set_config('app.tenant_id', $1, true)", [`other_${randomUUID()}`]);
      expect((await client.query("select count(*)::int as n from context.packs")).rows[0].n).toBe(0);
      await client.query("rollback");
    } finally { client.release(); }

    expect((await sourcesOfPack(as.writer, tenantId, first.packDigest)).map((source) => [source.ref, source.disposition])).toEqual([
      ["case:case-1/evidence", "QUARANTINED"], ["case:case-1/subjects", "INCLUDED"],
      ["evidence:ev_1", "QUARANTINED"], ["evidence:ev_2", "QUARANTINED"], ["run:run-1/predecessors:screen", "DROPPED_BUDGET"],
    ]);
    expect(await sourcesOfPack(as.writer, `other_${randomUUID()}`, first.packDigest)).toEqual([]);
  });

  it("answers which packs, in which cases, drew on a piece of evidence", async ({ skip }) => {
    if (!canRun) skip();
    const tenantId = `ctx_${randomUUID()}`;
    const a = pack({ runId: "run-a", caseId: "case-a", evidence: ["ev_shared", "ev_a"], seed: "a" });
    const b = pack({ runId: "run-b", caseId: "case-b", evidence: ["ev_shared"], seed: "b" });
    for (const [item, caseId] of [[a, "case-a"], [b, "case-b"]] as const) {
      await recordContextPack(as.writer, { tenantId, caseId, runId: item.runId, nodeId: "screen", attempt: 1, pack: item });
    }
    const shared = await packsDrawingOn(as.writer, tenantId, "evidence:ev_shared");
    expect(shared.map((row) => row.caseId).sort()).toEqual(["case-a", "case-b"]);
    expect((await packsDrawingOn(as.writer, tenantId, "evidence:ev_a")).map((row) => row.packDigest)).toEqual([a.packDigest]);
    // Another tenant with the same evidence id sees only its own graph.
    expect(await packsDrawingOn(as.writer, `other_${randomUUID()}`, "evidence:ev_shared")).toEqual([]);
  });

  it("keeps the graph behind its functions and each role inside its row", async ({ skip }) => {
    if (!canRun) skip();
    for (const store of Object.values(as)) {
      await denied(store, 'select * from context_graph."Pack"');
      await denied(store, "select * from ag_catalog.cypher('context_graph', $$ MATCH (n) RETURN n $$) as (n ag_catalog.agtype)");
      await denied(store, "create table context.intruder(id int)");
    }
    await denied(as.writer, "update context.packs set quarantined = false");
    await denied(as.writer, "delete from context.packs");
    await denied(as.writer, "select * from context.knowledge_chunks");
    await denied(as.retrieval, "select * from context.packs");
    await denied(as.retrieval, "select context.graph_link_pack('x', null, '[]')");
    // Without a bound tenant the graph functions refuse rather than read everything.
    await expect(as.writer.db.query("select * from context.graph_packs_drawing_on('evidence:ev_1')")).rejects.toThrow(/context\.tenant_unbound/);
  });

  it("serves similarity search over the tenant's own chunks only", async ({ skip }) => {
    if (!canRun) skip();
    const tenantId = `ctx_${randomUUID()}`;
    const vector = (hot: number) => JSON.stringify(Array.from({ length: 1536 }, (_, index) => (index === hot ? 1 : 0)));
    const client = new pg.Client({ connectionString: url() });
    await client.connect();
    try {
      for (const [tenant, chunk, hot] of [[tenantId, "policy-1", 0], [tenantId, "policy-2", 1], [`other_${randomUUID()}`, "foreign", 0]] as const) {
        await client.query(`insert into context.knowledge_chunks(tenant_id, chunk_id, source_kind, source_ref, title, content, embedding_model, embedding)
          values ($1, $2, 'policy', $3, $2, 'text', 'test', $4::vector)`, [tenant, chunk, `policy:${chunk}`, vector(hot)]);
      }
    } finally { await client.end(); }
    const matches = await searchKnowledge(as.retrieval, tenantId, JSON.parse(vector(0)) as number[], 5);
    expect(matches.map((match) => match.chunkId)).toEqual(["policy-1", "policy-2"]);
    expect(matches[0]?.similarity).toBeCloseTo(1);
  });

  it("lists every context table in the grant matrix", async ({ skip }) => {
    if (!canRun) skip();
    const client = new pg.Client({ connectionString: url() });
    await client.connect();
    try {
      const result = await client.query<{ name: string; granted: boolean; forced: boolean }>(`
        select c.relname as name,
               bool_or(has_table_privilege(r.rolname, c.oid, 'select,insert,update,delete')) as granted,
               c.relrowsecurity and c.relforcerowsecurity as forced
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        cross join unnest(array['ehf_svc_context_writer', 'ehf_svc_context_retrieval', 'ehf_svc_context_release']) as r(rolname)
        where c.relkind in ('r', 'p') and n.nspname = 'context' and c.relname <> 'schema_migrations'
        group by c.relname, c.relrowsecurity, c.relforcerowsecurity order by 1`);
      expect(result.rows.filter((row) => !row.granted).map((row) => row.name)).toEqual([]);
      expect(result.rows.filter((row) => !row.forced).map((row) => row.name)).toEqual([]);
    } finally { await client.end(); }
  });
});

it("links the stable part of a case read and every evidence object", () => {
  expect(stableProvenanceRef("case:case_1@42/evidence:$.items")).toBe("case:case_1/evidence:$.items");
  expect(stableProvenanceRef("run:r/predecessors:n")).toBe("run:r/predecessors:n");
  const sources = packSources(pack({ runId: "r", caseId: "c", evidence: ["ev_9"], seed: "x" }));
  expect(sources.filter((source) => source.kind === "evidence_object").map((source) => source.ref)).toEqual(["evidence:ev_9"]);
  expect(sources.find((source) => source.sectionId === "upstream")?.disposition).toBe("DROPPED_BUDGET");
});
