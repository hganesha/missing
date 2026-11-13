import { describe, expect, it, vi } from "vitest";
import {
  contextConnectionSchema,
  contextBindingSchema,
  canonicalRecordInputSchema,
} from "@ehf/contracts";
import fixture from "../../contracts/test-fixtures/context-source.json" with { type: "json" };
import {
  assertContextTarget,
  contextReadQuery,
  normalizeContextRows,
  runContextConnector,
  type ConnectorRuntime,
} from "./index.js";
const connection = contextConnectionSchema.parse(fixture.connection),
  binding = contextBindingSchema.parse(fixture.binding);
const httpConnection = contextConnectionSchema.parse({
  ...connection,
  provider: "openapi",
  endpoint: "https://source.example.test",
});
const fields = {
  id: { type: "string" },
  name: { type: "string" },
  entity_type: { type: "string" },
  identifiers: { type: "array" },
  observed_at: { type: "string" },
};
const spec = {
  openapi: "3.0.3",
  paths: {
    "/customers/{customer_id}": {
      get: {
        responses: {
          "200": {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    rows: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: fields,
                        required: Object.keys(fields),
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};
function runtime(
  fetch: typeof globalThis.fetch,
  conn = httpConnection,
): ConnectorRuntime {
  return {
    env: {
      CUSTOMER_DB: "test-only-secret",
      CONTEXT_SOURCE_TARGETS_JSON: JSON.stringify({
        tenant_test: [
          {
            endpoint: conn.endpoint,
            provider: conn.provider,
            credentialRef: conn.credentialRef,
          },
        ],
      }),
    },
    fetch,
    tenantId: "tenant_test",
    checkTransport: async () => {},
  };
}
describe("bounded connector reads", () => {
  it("compiles only a scoped SELECT and binds adversarial parameter values separately", () => {
    const value = "'; DROP TABLE customers; --";
    const query = contextReadQuery(connection, binding, { customer_id: value });
    expect(query.text).toBe(
      'SELECT "id", "name", "entity_type", "identifiers", "observed_at" FROM "public"."customers" WHERE "id" = $1 LIMIT 51',
    );
    expect(query.values).toEqual([value]);
    for (const text of [
      "SELECT pg_sleep(100) FROM customers",
      "SELECT * FROM elsewhere",
      "WITH x AS (DELETE FROM customers) SELECT * FROM customers",
      "SELECT * FROM customers; DELETE FROM customers",
      "SELECT * FROM customers -- comment",
      `select\t*\tfrom\tcustomers\twhere\t${"\t".repeat(15000)}`,
      `select${"\t".repeat(17000)}* from customers`,
    ]) {
      expect(() =>
        contextReadQuery(
          connection,
          { ...binding, query: text },
          { customer_id: "c1" },
        ),
      ).toThrow(/context_source/);
    }
    expect(() =>
      contextReadQuery(connection, binding, { customer_id: 3 }),
    ).toThrow("parameter_invalid");
  });
  it("refuses unapproved targets and delegated execution before any outbound request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(() =>
      assertContextTarget(httpConnection, { env: {}, tenantId: "other" }),
    ).toThrow("target_not_approved");
    await expect(
      runContextConnector(
        httpConnection,
        binding,
        { customer_id: "c1" },
        { ...runtime(fetch), tenantId: "foreign" },
      ),
    ).rejects.toThrow("target_not_approved");
    await expect(
      runContextConnector(
        { ...httpConnection, identityMode: "delegated" },
        binding,
        { customer_id: "c1" },
        runtime(fetch),
      ),
    ).rejects.toThrow("delegation_unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("discovers an OpenAPI GET and preserves source observations and mapping provenance", async () => {
    const at = new Date(Date.now() - 1000).toISOString();
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      Response.json(
        String(url).endsWith("openapi.json")
          ? spec
          : {
              rows: [
                {
                  id: "c1",
                  name: "Customer",
                  entity_type: "company",
                  identifiers: [],
                  observed_at: at,
                },
              ],
            },
      ),
    );
    const checkTransport = vi.fn(async () => {});
    const result = await runContextConnector(
      httpConnection,
      binding,
      { customer_id: "c1" },
      { ...runtime(fetch), checkTransport },
    );
    expect(result.fields.map((f) => f.name)).toEqual([
      "id",
      "name",
      "entity_type",
      "identifiers",
      "observed_at",
    ]);
    expect(checkTransport).toHaveBeenCalledTimes(2);
    const records = normalizeContextRows(binding, result, {
      connectorId: "context-source:test",
      tenantId: "tenant_test",
      invocationId: "invocation-1",
      bindingDigest: "a".repeat(64),
      connectionDigest: "b".repeat(64),
    });
    expect(canonicalRecordInputSchema.parse(records[0])).toMatchObject({
      data: { name: "Customer", entity_type: "company", identifiers: [] },
      observed_at: at,
      synthetic: false,
      provenance: { invocation_id: "invocation-1" },
    });
    expect(fetch.mock.calls[1]![1]?.redirect).toBe("error");
    // Without a subject field the record is about no case subject: no skill admits it.
    expect(records[0]).not.toHaveProperty("subject_ids");
    // With one, each row names its subject and the binding's purposes (delivery plan C1).
    const scoped = normalizeContextRows(contextBindingSchema.parse({ ...binding, subjectField: "id", purposes: ["onboarding", "review"] }), result, {
      connectorId: "context-source:test", tenantId: "tenant_test", invocationId: "invocation-1", bindingDigest: "a".repeat(64), connectionDigest: "b".repeat(64),
    });
    expect(canonicalRecordInputSchema.parse(scoped[0])).toMatchObject({ subject_ids: ["c1"], purposes: ["onboarding", "review"] });
    expect(() => normalizeContextRows(contextBindingSchema.parse({ ...binding, subjectField: "missing_column" }), result, {
      connectorId: "context-source:test", tenantId: "tenant_test", invocationId: "invocation-1", bindingDigest: "a".repeat(64), connectionDigest: "b".repeat(64),
    })).toThrow("record_subject_missing");
  });
  it("blocks external schema references, invalid rows, overlarge streams and timeouts", async () => {
    const external = structuredClone(spec);
    external.paths["/customers/{customer_id}"]!.get.responses["200"]!.content[
      "application/json"
    ]!.schema = { $ref: "https://evil.test/schema" } as never;
    await expect(
      runContextConnector(
        httpConnection,
        binding,
        { customer_id: "c1" },
        runtime(async () => Response.json(external)),
      ),
    ).rejects.toThrow("external_schema_ref_denied");
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      Response.json(
        String(url).endsWith("openapi.json")
          ? spec
          : {
              rows: [
                { id: "c1", name: 7, observed_at: new Date().toISOString() },
              ],
            },
      ),
    );
    await expect(
      runContextConnector(
        httpConnection,
        binding,
        { customer_id: "c1" },
        runtime(fetch),
      ),
    ).rejects.toThrow("response_schema_mismatch");
    await expect(
      runContextConnector(
        httpConnection,
        binding,
        { customer_id: "c1" },
        runtime(async () => new Response("x".repeat(2 * 1024 * 1024 + 1))),
      ),
    ).rejects.toThrow("response_too_large");
    await expect(
      runContextConnector(
        httpConnection,
        binding,
        { customer_id: "c1" },
        { ...runtime(fetch), signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow();
  });
  it("fails missing, stale and future observations rather than fabricating timestamps", () => {
    const base = {
      rows: [
        {
          id: "c1",
          name: "Customer",
          entity_type: "company",
          identifiers: [],
          observed_at: "2001-01-01T00:00:00Z",
        },
      ],
      fields: [],
      truncated: false,
      schemaFingerprint: "a".repeat(64),
    };
    const context = {
      connectorId: "context-source:test",
      tenantId: "tenant_test",
      invocationId: "i",
      bindingDigest: "b".repeat(64),
      connectionDigest: "c".repeat(64),
    };
    expect(() => normalizeContextRows(binding, base, context)).toThrow(
      "record_stale",
    );
    expect(() =>
      normalizeContextRows(
        binding,
        {
          ...base,
          rows: [
            { id: "c1", name: null, observed_at: new Date().toISOString() },
          ],
        },
        context,
      ),
    ).toThrow("required_field_missing");
  });
  it("validates canonical data after transformations and rejects changed schema pins", () => {
    const context = {
      tenantId: "tenant_test",
      connectorId: "context-source:test",
      invocationId: "i",
      bindingDigest: "b".repeat(64),
      connectionDigest: "c".repeat(64),
    };
    const result = {
      rows: [
        {
          id: "c1",
          name: " Customer ",
          entity_type: "COMPANY",
          identifiers: "[]",
          observed_at: new Date(Date.now() - 1000).toISOString(),
        },
      ],
      fields: [],
      truncated: false,
      schemaFingerprint: "a".repeat(64),
    };
    const mapped = contextBindingSchema.parse({
      ...binding,
      mapping: binding.mapping.map((row) => ({
        ...row,
        transform:
          row.target === "name"
            ? "trim"
            : row.target === "entity_type"
              ? "lowercase"
              : "json",
      })),
    });
    expect(normalizeContextRows(mapped, result, context)[0]?.data).toEqual({
      name: "Customer",
      entity_type: "company",
      identifiers: [],
    });
    expect(() =>
      normalizeContextRows(
        { ...mapped, canonicalSchemaVersion: "0.0.1" },
        result,
        context,
      ),
    ).toThrow("canonical_schema_changed");
    expect(() =>
      normalizeContextRows(
        mapped,
        {
          ...result,
          rows: [{ ...result.rows[0]!, entity_type: "invalid-type" }],
        },
        context,
      ),
    ).toThrow("canonical_data_invalid");
    expect(() =>
      normalizeContextRows(
        mapped,
        { ...result, rows: [{ ...result.rows[0]!, identifiers: "not json" }] },
        context,
      ),
    ).toThrow("mapping_transform_invalid");
    const next = normalizeContextRows(mapped, result, {
      ...context,
      invocationId: "next",
    })[0]!;
    expect(next.version_id).not.toBe(
      normalizeContextRows(mapped, result, context)[0]!.version_id,
    );
    expect(next.source_refs[0]?.object_id).toBe("next");
  });
  it("uses native transport authorization before constructing a database connection", async () => {
    const checkTransport = vi.fn(async () => {
      throw new Error("gateway.source_policy_denied:endpoint_denied");
    });
    const rt = runtime(vi.fn(), connection);
    rt.env.CUSTOMER_DB = JSON.stringify({
      username: "source_reader",
      password: "test-password",
    });
    await expect(
      runContextConnector(
        connection,
        binding,
        { customer_id: "c1" },
        { ...rt, checkTransport },
      ),
    ).rejects.toThrow("endpoint_denied");
    expect(checkTransport).toHaveBeenCalledWith(new URL(connection.endpoint));
  });
});
