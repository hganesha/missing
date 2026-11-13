import { qualify } from "./config.js";
import { CaseStoreError, withCaseTenant, type CaseStore } from "./index.js";

/**
 * Case teams and case assignment (docs/implementation/case-access-model.md, step 1).
 * Recorded data only: nothing here decides access. Assignment itself is written by the
 * AssignCase business command, so every change is a case ledger event.
 */
export type CaseTeam = { teamId: string; name: string; members: string[]; updatedAt: string };
export type CaseAssignment = { caseId: string; teamId: string; teamName: string; assignees: string[]; reason: string; assignedBy: unknown; assignedAt: string };

const TEAM_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const iso = (value: unknown): string => (value instanceof Date ? value.toISOString() : String(value));

export async function listCaseTeams(store: CaseStore, tenantId: string): Promise<CaseTeam[]> {
  return withCaseTenant(store, tenantId, async (client) => {
    const result = await client.query<{ team_id: string; name: string; updated_at: Date; members: string[] | null }>(`
      select t.team_id, t.name, t.updated_at,
        (select array_agg(m.subject_id order by m.subject_id) from ${qualify(store.schemas.core, "case_team_members")} m
          where m.tenant_id = t.tenant_id and m.team_id = t.team_id and m.removed_at is null) as members
      from ${qualify(store.schemas.core, "case_teams")} t where t.tenant_id = $1 order by t.name, t.team_id limit 500
    `, [tenantId]);
    return result.rows.map((row) => ({ teamId: row.team_id, name: row.name, members: row.members ?? [], updatedAt: iso(row.updated_at) }));
  }, { readOnly: true });
}

/**
 * Create or update a team and set its membership. Members not in `members` are marked removed;
 * a removed member who is still a named assignee on a case stays named there until the case
 * is reassigned (the assignment is a record of what was decided, not a live join).
 */
export async function upsertCaseTeam(store: CaseStore, tenantId: string, input: { teamId: string; name: string; members: string[] }, actor: unknown): Promise<CaseTeam> {
  const name = input.name.trim();
  const members = [...new Set(input.members.map((member) => member.trim()).filter(Boolean))].sort();
  if (!TEAM_ID.test(input.teamId)) throw new CaseStoreError("case_team.id_invalid", 400);
  if (!name || name.length > 120) throw new CaseStoreError("case_team.name_invalid", 400);
  if (members.length > 500) throw new CaseStoreError("case_team.too_many_members", 400);
  return withCaseTenant(store, tenantId, async (client) => {
    const teams = qualify(store.schemas.core, "case_teams");
    const memberships = qualify(store.schemas.core, "case_team_members");
    await client.query(`
      insert into ${teams}(tenant_id, team_id, name, updated_by, created_at, updated_at) values ($1,$2,$3,$4::jsonb,now(),now())
      on conflict (tenant_id, team_id) do update set name = excluded.name, updated_by = excluded.updated_by, updated_at = excluded.updated_at
    `, [tenantId, input.teamId, name, JSON.stringify(actor)]);
    await client.query(`update ${memberships} set removed_at = now() where tenant_id = $1 and team_id = $2 and removed_at is null and not (subject_id = any($3::text[]))`, [tenantId, input.teamId, members]);
    for (const subjectId of members) {
      await client.query(`
        insert into ${memberships}(tenant_id, team_id, subject_id, added_by, added_at) values ($1,$2,$3,$4::jsonb,now())
        on conflict (tenant_id, team_id, subject_id) do update set removed_at = null, added_by = excluded.added_by, added_at = excluded.added_at
        where ${memberships}.removed_at is not null
      `, [tenantId, input.teamId, subjectId, JSON.stringify(actor)]);
    }
    const updated = (await client.query<{ updated_at: Date }>(`select updated_at from ${teams} where tenant_id = $1 and team_id = $2`, [tenantId, input.teamId])).rows[0]!;
    return { teamId: input.teamId, name, members, updatedAt: iso(updated.updated_at) };
  });
}

/** The case's current assignment, or null when it has never been assigned. */
export async function getCaseAssignment(store: CaseStore, tenantId: string, caseId: string): Promise<CaseAssignment | null> {
  return withCaseTenant(store, tenantId, async (client) => {
    const row = (await client.query<{ team_id: string; name: string; assignees: string[]; reason: string; assigned_by: unknown; assigned_at: Date }>(`
      select a.team_id, t.name, a.assignees, a.reason, a.assigned_by, a.assigned_at
      from ${qualify(store.schemas.core, "case_assignments")} a
      join ${qualify(store.schemas.core, "case_teams")} t on t.tenant_id = a.tenant_id and t.team_id = a.team_id
      where a.tenant_id = $1 and a.case_id = $2
    `, [tenantId, caseId])).rows[0];
    return row ? { caseId, teamId: row.team_id, teamName: row.name, assignees: row.assignees, reason: row.reason, assignedBy: row.assigned_by, assignedAt: iso(row.assigned_at) } : null;
  }, { readOnly: true });
}

/** Current assignments for several cases at once (the work queue shows team and assignees per case). */
export async function listCaseAssignments(store: CaseStore, tenantId: string, caseIds: string[]): Promise<CaseAssignment[]> {
  const ids = [...new Set(caseIds)].slice(0, 1_000);
  if (!ids.length) return [];
  return withCaseTenant(store, tenantId, async (client) => {
    const result = await client.query<{ case_id: string; team_id: string; name: string; assignees: string[]; reason: string; assigned_by: unknown; assigned_at: Date }>(`
      select a.case_id, a.team_id, t.name, a.assignees, a.reason, a.assigned_by, a.assigned_at
      from ${qualify(store.schemas.core, "case_assignments")} a
      join ${qualify(store.schemas.core, "case_teams")} t on t.tenant_id = a.tenant_id and t.team_id = a.team_id
      where a.tenant_id = $1 and a.case_id = any($2::text[]) order by a.case_id
    `, [tenantId, ids]);
    return result.rows.map((row) => ({ caseId: row.case_id, teamId: row.team_id, teamName: row.name, assignees: row.assignees, reason: row.reason, assignedBy: row.assigned_by, assignedAt: iso(row.assigned_at) }));
  }, { readOnly: true });
}

/**
 * A person's standing on a case (case-access-model.md): `assigned` when named on it, `team`
 * when a current member of its team, `none` when it is assigned and they are neither.
 * `unassigned` means the case has no assignment at all; such a case is open to everyone with
 * the role until it is given a team, so existing cases keep working.
 */
export type CaseStanding = "assigned" | "team" | "unassigned" | "none";

export function standingFrom(assignment: { teamId: string; assignees: readonly string[] } | null | undefined, memberOf: ReadonlySet<string>, subjectId: string): CaseStanding {
  if (!assignment) return "unassigned";
  if (assignment.assignees.includes(subjectId)) return "assigned";
  return memberOf.has(assignment.teamId) ? "team" : "none";
}

export async function caseStanding(store: CaseStore, tenantId: string, caseId: string, subjectId: string): Promise<CaseStanding> {
  return withCaseTenant(store, tenantId, async (client) => {
    const row = (await client.query<{ team_id: string; assignees: string[]; member: boolean }>(`
      select a.team_id, a.assignees,
        exists (select 1 from ${qualify(store.schemas.core, "case_team_members")} m
          where m.tenant_id = a.tenant_id and m.team_id = a.team_id and m.subject_id = $3 and m.removed_at is null) as member
      from ${qualify(store.schemas.core, "case_assignments")} a where a.tenant_id = $1 and a.case_id = $2
    `, [tenantId, caseId, subjectId])).rows[0];
    return standingFrom(row ? { teamId: row.team_id, assignees: row.assignees } : null, new Set(row?.member ? [row.team_id] : []), subjectId);
  }, { readOnly: true });
}
