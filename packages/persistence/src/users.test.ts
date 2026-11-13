import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Principal } from "@ehf/identity";
import { listPlatformUsers, platformUserForSubject, savePlatformUser } from "./users.js";

const url = process.env.EHF_USERS_TEST_DATABASE_URL;
describe.skipIf(!url)("durable user directory", () => {
  const admin = new pg.Pool({ connectionString: url });
  const login = `users_test_${randomUUID().replaceAll("-", "")}`;
  const loginUrl = new URL(url ?? "postgresql://localhost/postgres");
  loginUrl.username = login;
  const db = new pg.Pool({ connectionString: loginUrl.toString() });
  const actor: Principal = { subjectId: "bootstrap-admin", tenantId: `users-${randomUUID()}`, roles: ["Platform.Admin"], actorType: "human", source: "local" };
  const input = { subjectId: "idp-subject", displayName: "Jamie Chen", email: "jamie@example.com", roles: ["Case.Analyst", "Harness.Reader"] };
  beforeAll(async () => {
    await admin.query("create schema if not exists harness_admin");
    if (!(await admin.query("select to_regclass('harness_admin.platform_users') as table_name")).rows[0].table_name) await admin.query(readFileSync(new URL("../migrations/057_platform_users.sql", import.meta.url), "utf8"));
    await admin.query(`create role ${login} login nosuperuser nobypassrls`);
    await admin.query(`grant usage on schema harness_admin to ${login}`);
    await admin.query(`grant select,insert,update on harness_admin.platform_users to ${login}`);
    await admin.query(`grant select,insert on harness_admin.user_changes to ${login}`);
  });
  afterAll(async () => { await db.end(); await admin.query(`drop owned by ${login}`); await admin.query(`drop role ${login}`); await admin.end(); });

  it("saves users, scopes lookups by tenant, and commits a before/after audit alongside edits", async () => {
    const user = await savePlatformUser(db, actor, input, "Add analyst");
    expect(user).toMatchObject({ ...input, revision: 1, updatedBy: actor.subjectId });
    expect(await platformUserForSubject(db, "other-tenant", input.subjectId)).toBeNull();
    expect(await listPlatformUsers(db, actor.tenantId)).toContainEqual(user);
    const changed = await savePlatformUser(db, actor, { ...input, roles: ["Case.Reviewer"] }, "Assign reviewer", { userId: user.userId, expectedRevision: 1 });
    expect(changed).toMatchObject({ revision: 2, roles: ["Case.Reviewer"] });
    const audits = await admin.query("select reason,before_value,after_value from harness_admin.user_changes where tenant_id=$1 order by created_at", [actor.tenantId]);
    expect(audits.rows).toHaveLength(2);
    expect(audits.rows[1]).toMatchObject({ reason: "Assign reviewer", before_value: { revision: 1 }, after_value: { revision: 2 } });
    await expect(savePlatformUser(db, actor, input, "Stale edit", { userId: user.userId, expectedRevision: 1 })).rejects.toThrow("users.revision_conflict");
    expect((await platformUserForSubject(db, actor.tenantId, input.subjectId))?.revision).toBe(2);
  });
  it("rejects duplicates, workload roles and cross-tenant edits without adding audit records", async () => {
    await expect(savePlatformUser(db, actor, input, "Duplicate identity")).rejects.toThrow("users.already_exists");
    await expect(savePlatformUser(db, actor, { ...input, subjectId: "second-subject" }, "Duplicate email")).rejects.toThrow("users.already_exists");
    await expect(savePlatformUser(db, actor, { ...input, roles: ["Edge.Delegate"] }, "Workload role")).rejects.toThrow("users.role_invalid");
    const user = (await listPlatformUsers(db, actor.tenantId))[0]!;
    await expect(savePlatformUser(db, { ...actor, tenantId: "other" }, input, "Other tenant", { userId: user.userId, expectedRevision: 2 })).rejects.toThrow("users.not_found");
    expect((await admin.query("select * from harness_admin.user_changes where tenant_id=$1", [actor.tenantId])).rowCount).toBe(2);
    expect((await db.query("select * from harness_admin.platform_users")).rows).toEqual([]);
  });
  it("keeps self administration, preserves the last admin and rechecks a managed actor's roles", async () => {
    await expect(savePlatformUser(db, actor, { ...input, subjectId: actor.subjectId }, "Lose own admin")).rejects.toThrow("users.self_admin_required");
    const admin = await savePlatformUser(db, actor, { ...input, subjectId: "managed-admin", email: "admin@example.com", roles: ["Platform.Admin"] }, "Add admin");
    await expect(savePlatformUser(db, actor, { ...input, subjectId: admin.subjectId, email: admin.email }, "Remove last admin", { userId: admin.userId, expectedRevision: 1 })).rejects.toThrow("users.last_admin_required");
    await expect(savePlatformUser(db, { ...actor, subjectId: input.subjectId }, { ...input, subjectId: "new-person", email: "new@example.com" }, "Stale admin session")).rejects.toThrow("authorization.role_missing");
  });
  it("uses the verified directory identity for self protection and revocation checks", async () => {
    const directorySubjectId = "entra:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
    const managed = await savePlatformUser(db, actor, { ...input, subjectId: directorySubjectId, email: "directory-admin@example.com", roles: ["Platform.Admin"] }, "Add directory admin");
    const directoryActor = { ...actor, subjectId: "pairwise-sign-in-subject", directorySubjectId };
    await expect(savePlatformUser(db, directoryActor, { ...input, subjectId: directorySubjectId, email: managed.email }, "Lose own admin", { userId: managed.userId, expectedRevision: 1 })).rejects.toThrow("users.self_admin_required");
    await savePlatformUser(db, actor, { ...input, subjectId: directorySubjectId, email: managed.email, roles: ["Case.Analyst"] }, "Revoke directory admin", { userId: managed.userId, expectedRevision: 1 });
    await expect(savePlatformUser(db, directoryActor, { ...input, subjectId: "another-person", email: "another@example.com" }, "Stale directory admin session")).rejects.toThrow("authorization.role_missing");
  });
});
