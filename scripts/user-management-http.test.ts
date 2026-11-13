import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { createDatabase } from "../packages/persistence/src/index.js";
import { describe, expect, it } from "vitest";
import { createGuard, DelegatedPrincipalResolver, ServiceTokenPrincipalResolver, type Principal } from "../packages/identity/src/index.js";
import { registerUserRoutes } from "../apps/control-api/src/user-routes.js";
import { buildApp } from "../apps/experience-bff/src/app.js";
import { directoryAccess } from "../apps/experience-bff/src/user-access.js";
import { upstreamFromEnv } from "../apps/experience-bff/src/upstream.js";

const Fastify = createRequire(new URL("../apps/experience-bff/package.json", import.meta.url))("fastify");

describe.skipIf(!process.env.EHF_USERS_TEST_DATABASE_URL)("HTTP user management", () => {
  it("persists a user through the BFF and control service, then applies saved roles on sign-in and later requests", async () => {
    const db = createDatabase(process.env.EHF_USERS_TEST_DATABASE_URL);
    const control = Fastify();
    const tenantId = `http-users-${randomUUID()}`;
    const token = "isolated-users-edge-test-token";
    const edgeResolver = new ServiceTokenPrincipalResolver([{ subjectId: "users-edge", tenantId, roles: ["Edge.Delegate"], token }], {});
    const guard = createGuard({ resolver: new DelegatedPrincipalResolver(edgeResolver) });
    registerUserRoutes(control, db, (request, action) => guard.require(request, action), edgeResolver);
    let actor: Principal = { subjectId: "bootstrap-admin", tenantId, actorType: "human", roles: ["Platform.Admin"], source: "local" };
    let bff: ReturnType<typeof buildApp> | undefined;
    try {
      await db.query("create schema if not exists harness_admin");
      if (!(await db.query("select to_regclass('harness_admin.platform_users') as table_name")).rows[0].table_name) await db.query(readFileSync(new URL("../packages/persistence/migrations/057_platform_users.sql", import.meta.url), "utf8"));
      const origin = await control.listen({ port: 0, host: "127.0.0.1" });
      const env = { CONTROL_API_INTERNAL_URL: origin, EDGE_SERVICE_TOKEN: token, BFF_PUBLIC_ORIGIN: "http://ui.test" };
      const upstream = upstreamFromEnv(env);
      const directoryId = "c3d83044-8cf1-49c0-9a35-116bca61090e";
      const directorySubjectId = `entra:11111111-1111-4111-8111-111111111111:${directoryId}`;
      bff = buildApp({ env, principalResolver: { source: "local", resolve: async () => actor }, resolveUserAccess: directoryAccess(upstream), upstream,
        identityDirectory: { configuration: { provider: "entra", label: "Microsoft Entra ID", configured: true, reason: null }, subjectId: () => directorySubjectId,
          get: async id => ({ id, displayName: "Jamie Chen", email: "jamie@example.com", principalName: "jamie@example.com", enabled: true }), search: async () => ({ items: [], hasMore: false }) } });
      const adminSession = await bff.inject("/api/v1/session");
      expect(adminSession.statusCode, adminSession.body).toBe(200);
      const headers = { cookie: adminSession.headers["set-cookie"]!.toString().split(";")[0]!, origin: "http://ui.test", "x-csrf-token": adminSession.json().csrfToken };
      const input = { directoryUserId: directoryId, roles: ["Case.Analyst"], reason: "Onboard analyst" };
      const created = await bff.inject({ method: "POST", url: "/api/v1/admin/users", payload: input, headers });
      expect(created.statusCode, created.body).toBe(201);
      const user = created.json();
      const list = await bff.inject({ url: "/api/v1/admin/users", headers });
      expect(list.json().items).toContainEqual(user);
      actor = { ...actor, subjectId: "pairwise-sign-in-subject", directorySubjectId, roles: [] };
      const analystSession = await bff.inject("/api/v1/session");
      expect(analystSession.json()).toMatchObject({ roles: ["Case.Analyst"], subject: { subjectId: actor.subjectId, directorySubjectId, displayName: "Jamie Chen", email: "jamie@example.com" } });
      const analystCookie = analystSession.headers["set-cookie"]!.toString().split(";")[0]!;
      expect((await bff.inject({ url: "/api/v1/admin/users", headers: { cookie: analystCookie } })).statusCode).toBe(403);
      const update = { displayName: "Jamie Chen", email: "jamie@example.com", roles: input.roles, reason: "Change role" };
      const updated = await bff.inject({ method: "PUT", url: `/api/v1/admin/users/${user.userId}`, headers, payload: { ...update, roles: ["Case.Reviewer"], expectedRevision: 1 } });
      expect(updated.statusCode, updated.body).toBe(200);
      const refreshed = await bff.inject({ url: "/api/v1/session", headers: { cookie: analystCookie } });
      expect(refreshed.json().roles).toEqual(["Case.Reviewer"]);
      const roleCatalogue = await bff.inject({ url: "/api/v1/admin/roles", headers });
      expect(roleCatalogue.json().items.find((role: { id: string }) => role.id === "Case.Reviewer").actions).toContain("case.review");
    } finally { await bff?.close(); await control.close(); await db.end(); }
  });
});
