import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { contextBindingSchema, contextConnectionSchema } from "@ehf/contracts";
import fixture from "../../contracts/test-fixtures/context-source.json" with { type: "json" };
import { runContextConnector, type ConnectorRuntime } from "./index.js";

const binding = contextBindingSchema.parse(fixture.binding);
function setup(provider: "databricks" | "snowflake", payload: unknown) {
  const connection = contextConnectionSchema.parse({
    ...fixture.connection,
    provider,
    endpoint: "https://warehouse.example.test",
    resource: {
      ...fixture.connection.resource,
      catalog: "governed",
      warehouse: "context-warehouse",
    },
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json(payload),
  );
  const checkTransport = vi.fn(async () => {});
  const runtime: ConnectorRuntime = {
    tenantId: "test-tenant",
    fetch,
    checkTransport,
    env: {
      CUSTOMER_DB: randomUUID(),
      CONTEXT_SOURCE_TARGETS_JSON: JSON.stringify({
        "test-tenant": [
          {
            endpoint: connection.endpoint,
            provider,
            credentialRef: connection.credentialRef,
          },
        ],
      }),
    },
  };
  return { connection, fetch, checkTransport, runtime };
}

describe("existing warehouse provider paths", () => {
  it("discovers the scoped Databricks Unity Catalog resource without reading rows", async () => {
    const test = setup("databricks", {
      columns: [{ name: "id", type_name: "STRING", nullable: false }],
    });
    const result = await runContextConnector(
      test.connection,
      binding,
      { customer_id: "c1" },
      test.runtime,
      true,
    );
    expect(result.rows).toEqual([]);
    expect(result.fields).toEqual([
      { name: "id", type: "STRING", nullable: false },
    ]);
    expect(String(test.fetch.mock.calls[0]![0])).toBe(
      "https://warehouse.example.test/api/2.1/unity-catalog/tables/governed.public.customers",
    );
    expect(test.checkTransport).toHaveBeenCalledOnce();
  });
  it("uses the Databricks warehouse and parameter API with a bounded inline response", async () => {
    const test = setup("databricks", {
      status: { state: "SUCCEEDED" },
      manifest: {
        schema: { columns: [{ name: "id", type_name: "STRING" }] },
        total_row_count: 1,
      },
      result: { data_array: [["c1"]] },
    });
    const value = "'; DELETE FROM customers; --";
    const result = await runContextConnector(
      test.connection,
      binding,
      { customer_id: value },
      test.runtime,
    );
    const body = JSON.parse(String(test.fetch.mock.calls[0]![1]?.body));
    expect(body).toMatchObject({
      warehouse_id: "context-warehouse",
      row_limit: 51,
      on_wait_timeout: "CANCEL",
      disposition: "INLINE",
      parameters: [{ name: "customer_id", value }],
    });
    expect(body.statement).toContain("FROM `governed`.`public`.`customers`");
    expect(body.statement).not.toContain(value);
    expect(result.rows).toEqual([{ id: "c1" }]);
    expect(test.fetch.mock.calls[0]![1]?.redirect).toBe("error");
  });
  it("binds Snowflake parameters separately and refuses incomplete statements", async () => {
    const test = setup("snowflake", {
      resultSetMetaData: {
        rowType: [{ name: "id", type: "text", nullable: false }],
      },
      data: [["c1"]],
    });
    const result = await runContextConnector(
      test.connection,
      binding,
      { customer_id: "c1" },
      test.runtime,
    );
    const body = JSON.parse(String(test.fetch.mock.calls[0]![1]?.body));
    expect(body).toMatchObject({
      warehouse: "context-warehouse",
      database: "governed",
      schema: "public",
      bindings: { "1": { type: "TEXT", value: "c1" } },
    });
    expect(body.statement).toContain('WHERE "id" = ? LIMIT 51');
    expect(result.rows).toEqual([{ id: "c1" }]);
    test.fetch.mockImplementation(async () =>
      Response.json({ statementStatusUrl: "/api/v2/statements/pending" }),
    );
    await expect(
      runContextConnector(
        test.connection,
        binding,
        { customer_id: "c1" },
        test.runtime,
      ),
    ).rejects.toThrow("query_not_complete");
  });
});
