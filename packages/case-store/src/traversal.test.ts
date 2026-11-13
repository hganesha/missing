import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import type { CaseReadGrant } from "@ehf/contracts";
import { getCaseTraversalSnapshot, createCaseStore } from "./index.js";
import { renderMigration } from "./config.js";
const selector: CaseReadGrant = { id: "entity", source: "case", path: "records.Entity", purpose: "KYB_ONBOARDING", classification: "CONFIDENTIAL", required: false, record: { objectType: "Entity", fields: ["name"], minCount: 0, maxAgeSeconds: null } };
const scope = { purpose: selector.purpose, selectors: [selector], classifications: ["CONFIDENTIAL"], asOf: "2026-11-05T12:00:00Z", knowledgeCutoff: "2026-11-05T12:00:00Z" };
describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("bounded case traversal in PostgreSQL", () => {
  it("selects known valid versions without falling back past denied versions, purpose or subject boundaries", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const schemas = { core: `trav_${suffix}`, ledger: `trav_l_${suffix}`, evidence: `trav_e_${suffix}` };
    const pool = new pg.Pool({ connectionString: process.env.EHF_TEST_DATABASE_URL! });
    const store = createCaseStore({ db: pool, schemas });
    try {
      for (const name of ["001_case_store.sql", "006_policy_evaluations.sql", "010_canonical_records.sql"]) {
        await pool.query(renderMigration(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"), schemas));
      }
      await pool.query(`insert into "${schemas.core}".cases(tenant_id,case_id,case_type,schema_version,jurisdiction,status,policy_snapshot_digest,harness_plan_digest,classification,created_by,created_at,updated_at,policy_id,policy_version,policy_bundle_digest,dependency_digest)
        values('tenant','case','kyc','1','US','INTAKE',$1,$1,'CONFIDENTIAL','{}',now(),now(),'p','1',$1,$1)`, ["a".repeat(64)]);
      for (const subject of ["subject", "other"]) await pool.query(`insert into "${schemas.core}".case_subjects(tenant_id,case_id,subject_id,subject_type,schema_version,classification,created_by,created_at,updated_at) values('tenant','case',$1,'LEGAL_ENTITY','1','CONFIDENTIAL','{}',now(),now())`, [subject]);
      const insert = async (id: string, version: string, overrides: Record<string, unknown> = {}) => {
        const r = { tenant_id: "tenant", case_id: "case", object_type: "Entity", object_id: id, version_id: version, schema_version: "2.0.0", data: { name: id }, subject_ids: ["subject"], purposes: [scope.purpose], classification: "CONFIDENTIAL", observed_at: "2026-11-01T00:00:00Z", recorded_at: "2026-11-01T00:00:00Z", valid_from: null, valid_to: null, supersedes: null, provenance: { method: "manual_entry" }, source_refs: [], synthetic: false, ...overrides };
        await pool.query(`insert into "${schemas.core}".canonical_records(tenant_id,case_id,object_type,object_id,version_id,schema_version,data,subject_ids,purposes,classification,observed_at,recorded_at,valid_from,valid_to,supersedes,provenance,source_refs,synthetic,record_digest,document,case_sequence)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,1)`,
          [r.tenant_id,r.case_id,r.object_type,r.object_id,r.version_id,r.schema_version,r.data,JSON.stringify(r.subject_ids),JSON.stringify(r.purposes),r.classification,r.observed_at,r.recorded_at,r.valid_from,r.valid_to,r.supersedes,r.provenance,JSON.stringify(r.source_refs),r.synthetic,"b".repeat(64),r]);
      };
      await insert("current", "v1");
      await insert("current", "v2", { recorded_at: "2026-11-03T00:00:00Z", supersedes: "v1" });
      await insert("future", "v1", { valid_from: "2026-12-01T00:00:00Z" });
      await insert("expired", "v1", { valid_to: "2026-11-02T00:00:00Z" });
      await insert("hidden-latest", "v1");
      await insert("hidden-latest", "v2", { recorded_at: "2026-11-03T00:00:00Z", classification: "PII" });
      await insert("wrong-purpose", "v1", { purposes: ["OTHER"] });
      await insert("other-subject", "v1", { subject_ids: ["other"] });
      await insert("mixed-subject", "v1", { subject_ids: ["subject", "other"] });
      await insert("unscoped", "v1", { subject_ids: [] });
      const ids = (s: Awaited<ReturnType<typeof getCaseTraversalSnapshot>>) => (s?.data.records as Record<string, Array<{object_id: string;version_id: string}>>).Entity?.map(r => `${r.object_id}@${r.version_id}`);
      const first = await getCaseTraversalSnapshot(store, "tenant", "case", { ...scope, subjects: ["subject"] });
      expect(ids(first)).toEqual(["current@v2"]);
      expect((await getCaseTraversalSnapshot(store, "tenant", "case", { ...scope, subjects: ["subject"] }))?.snapshotDigest).toBe(first?.snapshotDigest);
      const past = await getCaseTraversalSnapshot(store, "tenant", "case", { ...scope, subjects: ["subject"], asOf: "2026-11-01T12:00:00Z", knowledgeCutoff: "2026-11-02T00:00:00Z" });
      expect(ids(past)).toEqual(["current@v1", "expired@v1", "hidden-latest@v1"]);
      expect(ids(await getCaseTraversalSnapshot(store, "tenant", "case", scope))).toContain("unscoped@v1");
      await expect(getCaseTraversalSnapshot(store, "tenant", "case", { ...scope, subjects: ["foreign"] })).rejects.toThrow("context.traversal_subject_denied");
      expect(await getCaseTraversalSnapshot(store, "foreign", "case", scope)).toBeNull();
    } finally {
      for (const schema of Object.values(schemas)) await pool.query(`drop schema if exists "${schema}" cascade`);
      await pool.end();
    }
  });
});
