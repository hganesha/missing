import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import fixture from "../../contracts/test-fixtures/context-source.json" with { type: "json" };
import { setup } from "./test-support.js";
const env = setup();
beforeAll(() => env.server.listen({ onUnhandledRequest: "error" }));
afterAll(() => env.server.close());
beforeEach(() => {
  env.at("ownership_review");
  env.as("platform_admin");
});
afterEach(() => expect(env.state.violations).toEqual([]));
it("roundtrips lookup field mappings and returned subject/purpose fields without activating a source", async () => {
  await env.call("postContextSourceConnections", {
    body: { definition: fixture.connection, expectedRevision: null },
  });
  const definition = {
    ...fixture.binding,
    subjectField: "canonical_subject_id",
    purposes: ["onboarding", "review"],
    parameters: [
      {
        name: "customer_id",
        type: "string",
        required: true,
        valueFrom: { source: "input", path: "subject.customerId" },
      },
    ],
  };
  const saved = await env.call("postContextSourceBindings", {
    body: { definition, expectedRevision: null },
  });
  expect(saved.status).toBe(201);
  const index = (await env.call("getContextSources")).body;
  expect(index.bindings[0]).toMatchObject({
    activeRevision: null,
    definition: {
      subjectField: "canonical_subject_id",
      purposes: ["onboarding", "review"],
      parameters: definition.parameters,
    },
  });
  expect(index.checks).toEqual([]);
});
it("requires exact-revision qualification and keeps active configuration through a new draft", async () => {
  expect(
    (
      await env.call("postContextSourceConnections", {
        body: { definition: fixture.connection, expectedRevision: null },
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await env.call("postContextSourceBindings", {
        body: { definition: fixture.binding, expectedRevision: null },
      })
    ).status,
  ).toBe(201);
  const transition = {
    path: { bindingId: fixture.binding.id },
    body: {
      expectedRevision: 1,
      revision: 1,
      action: "activate",
      reason: "Verified test source",
    },
  };
  expect(
    (await env.call("postContextSourceActivation", transition)).status,
  ).toBe(409);
  expect(
    (
      await env.call("postContextSourceChecks", {
        path: transition.path,
        body: {
          expectedRevision: 1,
          kind: "qualify",
          parameters: { customer_id: "customer-1" },
        },
      })
    ).body.status,
  ).toBe("passed");
  expect(
    (await env.call("postContextSourceActivation", transition)).body
      .activeRevision,
  ).toBe(1);
  expect(
    (
      await env.call("postContextSourceBindings", {
        body: {
          definition: { ...fixture.binding, name: "Changed draft" },
          expectedRevision: 1,
        },
      })
    ).status,
  ).toBe(201);
  expect((await env.call("getContextSources")).body.bindings[0]).toMatchObject({
    revision: 2,
    activeRevision: 1,
  });
  expect(
    (await env.call("postContextSourceActivation", transition)).status,
  ).toBe(409);
  expect(
    (
      await env.call("postContextSourceConnections", {
        body: { definition: fixture.connection, expectedRevision: null },
      })
    ).status,
  ).toBe(409);
});
it("enforces CSRF and administration and never resolves secret values in the browser", async () => {
  expect(
    (
      await env.call("postContextSourceConnections", {
        body: { definition: fixture.connection, expectedRevision: null },
        csrf: false,
      })
    ).status,
  ).toBe(403);
  env.as("harness_approver");
  expect(
    (
      await env.call("postContextSourceConnections", {
        body: { definition: fixture.connection, expectedRevision: null },
      })
    ).status,
  ).toBe(403);
  env.as("platform_admin");
  expect(
    (
      await env.call("postContextSourceConnections", {
        body: {
          definition: {
            ...fixture.connection,
            credentialRef: "password-value",
          },
          expectedRevision: null,
        },
      })
    ).status,
  ).toBe(400);
});
