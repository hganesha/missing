import mcpFixture from "../../contracts/test-fixtures/intelligence-mcp.json" with { type: "json" };
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import fixture from "../../contracts/test-fixtures/intelligence-binding.json" with { type: "json" };
import documentFixture from "../../contracts/test-fixtures/intelligence-document.json" with { type: "json" };
import decisionFixture from "../../contracts/test-fixtures/intelligence-decision.json" with { type: "json" };
import { setup } from "./test-support.js";

const env = setup();
beforeAll(() => env.server.listen({ onUnhandledRequest: "error" }));
afterAll(() => env.server.close());
beforeEach(() => { env.at("ownership_review"); env.as("platform_admin"); });
afterEach(() => expect(env.state.violations).toEqual([]));
const save = (expectedRevision: number | null, description = fixture.description) => env.call("postIntelligenceCandidates", { body: { definition: { ...fixture, description }, expectedRevision, reason: "Synthetic test" } });
it.each([documentFixture, decisionFixture, mcpFixture])("round-trips $serviceClass revisions and exact-revision checks through generated API contracts", async definition => {
  const created = await env.call("postIntelligenceCandidates", { body: { definition, expectedRevision: null, reason: "New category" } });
  expect(created.status).toBe(200);
  expect(created.body.definition).toEqual(definition);
  const check = await env.call("postIntelligenceBindingsBindingIdChecks", { path: { bindingId: definition.id }, body: { expectedRevision: 1 } });
  expect(check.body.executionVerified).toBe(false);
  // System 1 adapters pass the shared decision conformance suite; the others are not installed yet.
  expect(check.body.checks.find((item: { id: string }) => item.id === "adapter").status).toBe(definition.serviceClass === "decision" ? "passed" : "failed");
  const inventory = (await env.call("getIntelligence")).body;
  expect(inventory.candidates.some((row: { definition: { id: string } }) => row.definition.id === definition.id)).toBe(true);
  expect(inventory.adapters.find((adapter: { id: string }) => adapter.id === definition.connection.adapterId).commonAdapterId).toMatch(/^(document.analysis|decision.system1|mcp.tools).v1$/);
});
it("round-trips proposals, matches response contracts and leaves runtime and profiles unchanged", async () => {
  const before = (await env.call("getIntelligence")).body;
  expect(before.candidates).toEqual([]);
  expect((await save(null)).body.revision).toBe(1);
  expect((await save(null)).status).toBe(409);
  expect((await save(1, "New revision")).body.revision).toBe(2);
  expect((await save(1)).status).toBe(409);
  const check = await env.call("postIntelligenceBindingsBindingIdChecks", { path: { bindingId: fixture.id }, body: { expectedRevision: 2 } });
  expect(check.body.executionVerified).toBe(false);
  expect(check.body.checks.some((item: { status: string }) => item.status === "unknown")).toBe(true);
  const after = (await env.call("getIntelligence")).body;
  expect(after.runtimes).toEqual(before.runtimes);
  expect(after.profiles).toEqual(before.profiles);
  expect(after.history).toHaveLength(2);
  expect(after.activity).toHaveLength(3);
  expect((await save(2)).body.revision).toBe(3);
  const current = (await env.call("getIntelligence")).body;
  expect(current.reports[0].revision).not.toBe(current.candidates[0].revision);
});
it("requires admin and CSRF authority and rejects secret values", async () => {
  expect((await env.call("postIntelligenceCandidates", { body: { definition: fixture, expectedRevision: null, reason: "test" }, csrf: false })).status).toBe(403);
  env.as("harness_approver");
  expect((await env.call("getIntelligence")).status).toBe(403);
  expect((await save(null)).status).toBe(403);
  env.as("auditor");
  expect((await env.call("getIntelligence")).status).toBe(200);
  expect((await save(null)).status).toBe(403);
  env.as("platform_admin");
  expect((await env.call("postIntelligenceCandidates", { body: { definition: { ...fixture, connection: { ...fixture.connection, auth: { ...fixture.connection.auth, credentialRef: "secret-key" } } }, expectedRevision: null, reason: "test" } })).status).toBe(400);
});
