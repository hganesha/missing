import { randomUUID } from "node:crypto";
import type { PlatformUser, PlatformUserInput } from "@ehf/contracts";
import { HUMAN_ROLES, type Principal } from "@ehf/identity";
import { contextTransaction } from "./context-setup.js";
import type { Database } from "./index.js";

export class UserDirectoryError extends Error {
  constructor(message: string, readonly httpStatus: number) { super(message); }
}
type Row = { user_id: string; subject_id: string; display_name: string; email: string; roles: string[]; revision: number; created_at: Date; updated_at: Date; updated_by: string };
const view = (row: Row): PlatformUser => ({ userId: row.user_id, subjectId: row.subject_id, displayName: row.display_name, email: row.email, roles: row.roles, revision: row.revision, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), updatedBy: row.updated_by });
const scope = (tenantId: string) => ({ tenantId, environment: "platform" });

export async function listPlatformUsers(db: Database, tenantId: string): Promise<PlatformUser[]> {
  return contextTransaction(db, scope(tenantId), async client => (await client.query<Row>(
    "select * from harness_admin.platform_users where tenant_id=$1 order by lower(display_name), user_id", [tenantId],
  )).rows.map(view));
}
export async function platformUserForSubject(db: Database, tenantId: string, subjectId: string): Promise<PlatformUser | null> {
  return contextTransaction(db, scope(tenantId), async client => {
    const row = (await client.query<Row>("select * from harness_admin.platform_users where tenant_id=$1 and subject_id=$2", [tenantId, subjectId])).rows[0];
    return row ? view(row) : null;
  });
}

/** Serialize directory writes per tenant, recheck the actor, and audit atomically. */
export async function savePlatformUser(db: Database, actor: Principal, input: PlatformUserInput, reason: string, existing?: { userId: string; expectedRevision: number }): Promise<PlatformUser> {
  if (input.roles.some(role => !HUMAN_ROLES.some(allowed => allowed.id === role))) throw new UserDirectoryError("users.role_invalid", 400);
  try {
    return await contextTransaction(db, scope(actor.tenantId), async client => {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`users:${actor.tenantId}`]);
      const identities = [actor.directorySubjectId ?? actor.subjectId, actor.subjectId];
      const actorRow = (await client.query<Row>("select * from harness_admin.platform_users where tenant_id=$1 and subject_id=any($2::text[]) order by case when subject_id=$3 then 0 else 1 end limit 1", [actor.tenantId, identities, identities[0]])).rows[0];
      const actorRoles = actorRow?.roles ?? actor.roles;
      if (actor.actorType !== "human" || !actorRoles.includes("Platform.Admin")) throw new UserDirectoryError("authorization.role_missing", 403);
      const before = existing ? (await client.query<Row>("select * from harness_admin.platform_users where tenant_id=$1 and user_id=$2", [actor.tenantId, existing.userId])).rows[0] : undefined;
      if (existing && !before) throw new UserDirectoryError("users.not_found", 404);
      if (before && before.revision !== existing!.expectedRevision) throw new UserDirectoryError("users.revision_conflict", 409);
      if (before && before.subject_id !== input.subjectId) throw new UserDirectoryError("users.subject_immutable", 400);
      if (identities.includes(input.subjectId) && !input.roles.includes("Platform.Admin")) throw new UserDirectoryError("users.self_admin_required", 409);
      if (before?.roles.includes("Platform.Admin") && !input.roles.includes("Platform.Admin")) {
        const others = await client.query("select 1 from harness_admin.platform_users where tenant_id=$1 and user_id<>$2 and 'Platform.Admin'=any(roles) limit 1", [actor.tenantId, before.user_id]);
        if (!others.rows.length) throw new UserDirectoryError("users.last_admin_required", 409);
      }
      const userId = existing?.userId ?? randomUUID();
      const values = [actor.tenantId, userId, input.subjectId, input.displayName, input.email, input.roles, actor.subjectId];
      const result = before
        ? await client.query<Row>("update harness_admin.platform_users set display_name=$4,email=$5,roles=$6,updated_by=$7,revision=revision+1,updated_at=now() where tenant_id=$1 and user_id=$2 and subject_id=$3 returning *", values)
        : await client.query<Row>("insert into harness_admin.platform_users(tenant_id,user_id,subject_id,display_name,email,roles,updated_by) values($1,$2,$3,$4,$5,$6,$7) returning *", values);
      const user = view(result.rows[0]!);
      await client.query("insert into harness_admin.user_changes(tenant_id,change_id,user_id,actor_id,actor_roles,reason,before_value,after_value) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)", [actor.tenantId, randomUUID(), userId, actor.subjectId, actorRoles, reason, before ? JSON.stringify(view(before)) : null, JSON.stringify(user)]);
      return user;
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "23505") throw new UserDirectoryError("users.already_exists", 409);
    throw error;
  }
}
