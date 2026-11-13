import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { setup } from "./test-support.js";

const env = setup();
beforeAll(() => env.server.listen({ onUnhandledRequest: "error" }));
afterAll(() => env.server.close());
beforeEach(() => { env.at("ownership_review"); env.as("platform_admin"); });
afterEach(() => expect(env.state.violations).toEqual([]));
const provider = { id: "acme", name: "Acme", description: "Synthetic test provider" };
const connection = { id: "sandbox", name: "Acme sandbox", environment: "sandbox", adapterId: null, binding: null, endpoint: null, authentication: "workload_identity", credentialRef: null, capabilityIds: [], jurisdiction: "unresolved", coverageNote: "" };
const save = (expectedRevision: number | null, name = connection.name) => env.call("postExternalProvidersProviderIdConnections", { path: { providerId: "acme" }, body: { connection: { ...connection, name }, expectedRevision } });

it("creates and revises a provider draft without granting runtime readiness", async () => {
  const baseline = (await env.call("getExternalProviders")).body;
  expect((await env.call("postExternalProviders", { body: provider })).status).toBe(201);
  expect((await env.call("postExternalProviders", { body: provider })).status).toBe(409);
  expect((await save(null)).status).toBe(201);
  expect((await save(null)).status).toBe(409);
  expect((await save(1, "Edited sandbox")).body.revision).toBe(2);
  expect((await save(1, "Stale edit")).status).toBe(409);
  const current = (await env.call("getExternalProviders")).body;
  const record = current.items.find((item: { id: string }) => item.id === "acme");
  expect(record.connections[0].connection.name).toBe("Edited sandbox");
  expect(record.gatewayBindings).toEqual([]);
  expect(current.items.flatMap((item: { gatewayBindings: unknown[] }) => item.gatewayBindings)).toEqual(baseline.items.flatMap((item: { gatewayBindings: unknown[] }) => item.gatewayBindings));
  expect(record.activity).toHaveLength(3);
});
it("rejects credential values, incompatible capabilities, missing CSRF and unauthorized changes", async () => {
  expect((await env.call("postExternalProviders", { body: provider, csrf: false })).status).toBe(403);
  expect((await env.call("postExternalProviders", { body: provider })).status).toBe(201);
  const invalid = { ...connection, adapterId: "databricks-vector", binding: "main.cases.case_index", capabilityIds: ["identity.person.verify.v1"], credentialRef: "secret-value" };
  expect((await env.call("postExternalProvidersProviderIdConnections", { path: { providerId: "acme" }, body: { connection: invalid, expectedRevision: null } })).status).toBe(400);
  env.as("harness_approver");
  expect((await save(null)).status).toBe(403);
  env.as("platform_admin");
  expect((await env.call("getExternalProviders")).body.items.find((item: { id: string }) => item.id === "acme").connections).toEqual([]);
});
