import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { institutionCatalogSchema, type InstitutionCatalog } from "@ehf/contracts";
import {
  approveInstitutionCatalogRevision, createInstitutionCatalogRevision, getInstitutionCatalogRevision, listInstitutionCatalogRevisions,
  listInstitutionCatalogs, publishInstitutionCatalogRevision,
} from "./institution-catalogs.js";

// Institution catalogs as administered configuration (Product Policy Studio phase B), against a
// real PostgreSQL as a login that cannot bypass row-level security.
const url = process.env.EHF_TEST_DATABASE_URL;
const seeds = JSON.parse(readFileSync(new URL("../../../artifacts/products/institutions.json", import.meta.url), "utf8")) as { catalogs: unknown[] };
const seed = (id: string): InstitutionCatalog => institutionCatalogSchema.parse(structuredClone(seeds.catalogs.find((entry) => (entry as { institution: { id: string } }).institution.id === id)));

describe.skipIf(!url)("institution catalog revisions", () => {
  const admin = new pg.Pool({ connectionString: url });
  const login = `catalog_test_${randomUUID().replaceAll("-", "")}`;
  const loginUrl = new URL(url ?? "postgresql://localhost/postgres");
  loginUrl.username = login;
  const db = new pg.Pool({ connectionString: loginUrl.toString() });
  const tenantId = `catalogs-${randomUUID()}`;
  const bank = seed("bank.synthetic");
  const base = { tenantId, institutionId: bank.institution.id };
  beforeAll(async () => {
    await admin.query("create schema if not exists harness_admin");
    if (!(await admin.query("select to_regclass('harness_admin.institution_catalog_revisions') as table_name")).rows[0].table_name) await admin.query(readFileSync(new URL("../migrations/058_institution_catalogs.sql", import.meta.url), "utf8"));
    await admin.query(`create role ${login} login nosuperuser nobypassrls`);
    const database = (await admin.query<{ name: string }>("select current_database() as name")).rows[0]!.name;
    await admin.query(`grant connect on database "${database}" to ${login}`);
    await admin.query(`grant usage on schema harness_admin to ${login}`);
    await admin.query(`grant select,insert,update on harness_admin.institution_catalog_revisions to ${login}`);
    await admin.query(`grant select,insert on harness_admin.institution_catalog_events to ${login}`);
  });
  afterAll(async () => { await db.end(); await admin.query("delete from harness_admin.institution_catalog_events where tenant_id=$1", [tenantId]); await admin.query("delete from harness_admin.institution_catalog_revisions where tenant_id=$1", [tenantId]); await admin.query(`drop owned by ${login}`); await admin.query(`drop role ${login}`); await admin.end(); });

  it("saves drafts against the revision the author started from and refuses a stale save", async () => {
    const first = await createInstitutionCatalogRevision(db, { tenantId, actor: "author", catalog: bank, expectedRevision: 0, reason: "Seed the bank catalog", problems: [] });
    expect(first).toMatchObject({ institutionId: "bank.synthetic", revision: 1, status: "DRAFT", authoredBy: "author", approvedBy: null, problems: [] });
    expect(first.catalog).toEqual(bank);
    await expect(createInstitutionCatalogRevision(db, { tenantId, actor: "other", catalog: bank, expectedRevision: 0, reason: "Concurrent seed", problems: [] })).rejects.toThrow("institution.revision_conflict");
    const renamed = { ...bank, offerings: bank.offerings.map((offering, index) => index ? offering : { ...offering, name: "Everyday Checking Plus" }) };
    const second = await createInstitutionCatalogRevision(db, { tenantId, actor: "author", catalog: renamed, expectedRevision: 1, reason: "Rename checking", problems: [] });
    expect(second.revision).toBe(2);
    expect(second.digest).not.toBe(first.digest);
    expect((await listInstitutionCatalogRevisions(db, tenantId, bank.institution.id)).map((entry) => [entry.revision, entry.status])).toEqual([[2, "DRAFT"], [1, "SUPERSEDED"]]);
  });

  it("needs a second person and no problems to approve, and a second person to publish", async () => {
    await expect(approveInstitutionCatalogRevision(db, { ...base, actor: "author", revision: 2, reason: "Self approval", problems: [] })).rejects.toThrow("institution.approver_is_author");
    await expect(approveInstitutionCatalogRevision(db, { ...base, actor: "approver", revision: 2, reason: "Taxonomy moved", problems: ["institution.taxonomy_outdated:1.0.0"] })).rejects.toThrow("institution.problems_unresolved");
    await expect(approveInstitutionCatalogRevision(db, { ...base, actor: "approver", revision: 1, reason: "Old revision", problems: [] })).rejects.toThrow("institution.revision_not_draft");
    await expect(publishInstitutionCatalogRevision(db, { ...base, actor: "publisher", revision: 2, reason: "Too early" })).rejects.toThrow("institution.revision_not_approved");
    const approved = await approveInstitutionCatalogRevision(db, { ...base, actor: "approver", revision: 2, reason: "Reviewed offerings", problems: [] });
    expect(approved).toMatchObject({ status: "APPROVED", approvedBy: "approver" });
    await expect(publishInstitutionCatalogRevision(db, { ...base, actor: "author", revision: 2, reason: "Self publish" })).rejects.toThrow("institution.publisher_is_author");
    const published = await publishInstitutionCatalogRevision(db, { ...base, actor: "approver", revision: 2, reason: "Go live" });
    expect(published).toMatchObject({ status: "PUBLISHED", publishedBy: "approver" });
    expect((await getInstitutionCatalogRevision(db, tenantId, bank.institution.id, "published"))?.revision).toBe(2);
  });

  it("supersedes the published revision only when the next one publishes", async () => {
    const third = await createInstitutionCatalogRevision(db, { tenantId, actor: "author", catalog: bank, expectedRevision: 2, reason: "Restore name", problems: [] });
    expect((await getInstitutionCatalogRevision(db, tenantId, bank.institution.id, "published"))?.revision).toBe(2);
    await approveInstitutionCatalogRevision(db, { ...base, actor: "approver", revision: third.revision, reason: "Reviewed", problems: [] });
    await publishInstitutionCatalogRevision(db, { ...base, actor: "publisher", revision: third.revision, reason: "Go live" });
    expect((await listInstitutionCatalogRevisions(db, tenantId, bank.institution.id)).map((entry) => [entry.revision, entry.status])).toEqual([[3, "PUBLISHED"], [2, "SUPERSEDED"], [1, "SUPERSEDED"]]);
    expect(await listInstitutionCatalogs(db, tenantId)).toEqual([expect.objectContaining({ institutionId: "bank.synthetic", latest: expect.objectContaining({ revision: 3 }), published: expect.objectContaining({ revision: 3 }) })]);
    const events = await admin.query("select revision,event_type,actor_id from harness_admin.institution_catalog_events where tenant_id=$1 order by created_at, event_type", [tenantId]);
    expect(events.rows.filter((row) => row.event_type === "PUBLISHED")).toHaveLength(2);
    expect(events.rows.filter((row) => row.event_type === "SUPERSEDED").map((row) => row.revision).sort()).toEqual([1, 2]);
  });

  it("keeps every tenant's catalogs to itself", async () => {
    expect(await listInstitutionCatalogs(db, `other-${randomUUID()}`)).toEqual([]);
    expect(await getInstitutionCatalogRevision(db, "other", bank.institution.id, "latest")).toBeNull();
    await expect(approveInstitutionCatalogRevision(db, { ...base, tenantId: "other", actor: "approver", revision: 3, reason: "Cross tenant", problems: [] })).rejects.toThrow("institution.revision_not_found");
    expect((await db.query("select * from harness_admin.institution_catalog_revisions")).rows).toEqual([]);
    await expect(admin.query("update harness_admin.institution_catalog_revisions set approved_by=authored_by where tenant_id=$1 and revision=3", [tenantId])).rejects.toThrow(/check/);
  });
});
