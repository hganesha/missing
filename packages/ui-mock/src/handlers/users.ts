import { createPlatformUserSchema, updatePlatformUserSchema } from "@ehf/contracts/users";
import { PERSONAS, ROLE_ACTIONS, clone, type Rec } from "../fixtures.js";
import { fail, ok, page, type Ctx, type Impl } from "../http.js";
import { notify } from "../state.js";

const roleNames: Record<string, [string, string]> = {
  "Harness.Reader": ["Process flow reader", "View process flows, runs, cases and releases."],
  "Harness.Author": ["Process flow author", "Create and test drafts, agents and release candidates."],
  "Harness.Approver": ["Process flow approver", "Review and approve process flows and releases."],
  "Harness.Operator": ["Process flow operator", "Operate runs, activate releases and manage integrations."],
  "Case.Analyst": ["Case analyst", "Work on cases and collect supporting evidence."],
  "Case.Reviewer": ["Case reviewer", "Review cases and make human work decisions."],
  "Case.Manager": ["Case manager", "Oversee case work and assign cases to teams and people."],
  "Platform.Auditor": ["Platform auditor", "Inspect activity, configuration and change history."],
  "Platform.Admin": ["Platform administrator", "Manage users, roles and platform configuration."],
  "Legal.HoldOfficer": ["Legal hold officer", "Place and release legal holds on case evidence."],
};
const DIRECTORY_TENANT = "11111111-1111-4111-8111-111111111111";
const directoryPeople = [
  ...PERSONAS.map(({ session }, index) => ({ id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, displayName: session.subject.displayName as string, email: (session.subject.email ?? `${session.subject.subjectId}@example.com`) as string, principalName: `${session.subject.subjectId}@example.com`, enabled: true })),
  { id: "c3d83044-8cf1-49c0-9a35-116bca61090e", displayName: "Jamie Chen", email: "jamie.chen@example.com", principalName: "jamie.chen@example.com", enabled: true },
  { id: "718621b8-1c5f-4f21-9eb5-c861dc0cf079", displayName: "Robin Stone", email: "robin.stone@example.com", principalName: "robin.stone@example.com", enabled: false },
];
const directorySubject = (id: string) => `entra:${DIRECTORY_TENANT}:${id}`;
function rows(ctx: Ctx): Rec[] {
  const platform = ctx.state.platform;
  if (!platform.users) platform.users = PERSONAS.map(({ session }) => ({
    userId: crypto.randomUUID(), subjectId: session.subject.subjectId, displayName: session.subject.displayName,
    email: session.subject.email ?? `${session.subject.subjectId}@example.com`, roles: [...session.roles], revision: 1,
    createdAt: "2026-11-01T14:00:00.000Z", updatedAt: "2026-11-01T14:00:00.000Z", updatedBy: "platform.admin",
  }));
  return platform.users as Rec[];
}
function save(ctx: Ctx, updating: boolean): Response {
  const parsed = (updating ? updatePlatformUserSchema : createPlatformUserSchema).safeParse(ctx.body);
  if (!parsed.success) return fail(ctx, 400, "users.input_invalid", "Select a directory user, at least one role and a reason.");
  const input = parsed.data;
  const person = !updating ? directoryPeople.find(person => person.id === (input as Rec).directoryUserId) : undefined;
  if (!updating && !person) return fail(ctx, 404, "identity_directory.user_not_found", "This person is no longer available in the directory.");
  if (person && !person.enabled) return fail(ctx, 409, "identity_directory.user_disabled", "This account is disabled in the identity provider.");
  const profile = person ? { displayName: person.displayName, email: person.email } : input as Rec;
  if (input.roles.some(role => !roleNames[role])) return fail(ctx, 400, "users.role_invalid", "Select a role from the role catalogue.");
  const users = rows(ctx);
  const existing = updating ? users.find(user => user.userId === ctx.params.userId) : undefined;
  if (updating && !existing) return fail(ctx, 404, "users.not_found", "This user no longer exists.");
  if (existing && existing.revision !== (input as Rec).expectedRevision) return fail(ctx, 409, "users.revision_conflict", "This user changed. Close and reopen the editor to load the latest roles.");
  const subjectId = existing?.subjectId ?? directorySubject(person!.id);
  if (users.some(user => user !== existing && (user.subjectId === subjectId || user.email === profile.email))) return fail(ctx, 409, "users.already_exists", "This person already has workspace access.");
  if (subjectId === ctx.subject && !input.roles.includes("Platform.Admin")) return fail(ctx, 409, "users.self_admin_required", "Keep your administrator role to retain access to user management.");
  if (existing?.roles.includes("Platform.Admin") && !input.roles.includes("Platform.Admin") && !users.some(user => user !== existing && user.roles.includes("Platform.Admin"))) return fail(ctx, 409, "users.last_admin_required", "Assign another administrator before removing this role.");
  const user = { userId: existing?.userId ?? crypto.randomUUID(), subjectId, displayName: profile.displayName, email: profile.email,
    roles: input.roles, revision: (existing?.revision ?? 0) + 1, createdAt: existing?.createdAt ?? new Date().toISOString(), updatedAt: new Date().toISOString(), updatedBy: ctx.subject };
  if (existing) users[users.indexOf(existing)] = user;
  else users.push(user);
  const changes = (ctx.state.platform.userChanges ??= []) as Rec[];
  changes.push({ actor: ctx.subject, reason: input.reason, before: existing ? clone(existing) : null, after: clone(user) });
  notify(ctx.state, "users");
  return ok(ctx, clone(user), updating ? 200 : 201);
}
export const users: Record<string, Impl> = {
  getAdminIdentityProvider: ctx => ok(ctx, { provider: "entra", label: "Microsoft Entra ID", configured: true, reason: null }),
  getAdminIdentityProviderUsers: ctx => {
    const query = (ctx.url.searchParams.get("query") ?? "").trim().toLowerCase();
    if (query.length < 2 || query.length > 100) return fail(ctx, 400, "identity_directory.query_invalid", "Enter between 2 and 100 characters.");
    const existing = rows(ctx);
    return ok(ctx, { items: directoryPeople.filter(person => `${person.displayName} ${person.email} ${person.principalName}`.toLowerCase().includes(query)).map(person => ({ ...person, alreadyAdded: existing.some(user => user.subjectId === directorySubject(person.id) || user.email === person.email) })), hasMore: false });
  },
  getAdminUsers: ctx => ok(ctx, page(ctx, clone(rows(ctx)))),
  getAdminRoles: ctx => ok(ctx, page(ctx, Object.entries(roleNames).map(([id, [name, description]]) => ({ id, name, description, actions: [...ROLE_ACTIONS[id] ?? []].sort() })))),
  postAdminUsers: ctx => save(ctx, false),
  putAdminUsersUserId: ctx => save(ctx, true),
};
