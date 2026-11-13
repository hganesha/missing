import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { contextBindingSchema, contextConnectionSchema } from "@ehf/contracts";
import fixture from "../../contracts/test-fixtures/context-source.json" with { type: "json" };
import {
  contextReadQuery,
  normalizeContextRows,
  runContextConnector,
  type ConnectorRuntime,
} from "./index.js";

// Exercise the real connector/credential/query path at the wire-driver boundary.
const driver = vi.hoisted(() => ({
  configs: [] as Record<string, any>[],
  requests: [] as any[],
  clients: [] as any[],
  responses: [] as Record<string, unknown>[][],
  connectError: undefined as Error | undefined,
  queryError: undefined as Error | undefined,
  hangConnect: false,
  hangQueryAt: 0,
  failSocket: false,
}));
vi.mock("tedious", async () => {
  const { EventEmitter } = await import("node:events");
  class Request extends EventEmitter {
    parameters: { name: string; type: unknown; value: unknown }[] = [];
    cancelled = false;
    constructor(
      public text: string,
      public callback: (error?: Error) => void,
    ) {
      super();
    }
    addParameter(name: string, type: unknown, value: unknown) {
      this.parameters.push({ name, type, value });
    }
    cancel() {
      this.cancelled = true;
      this.callback(new Error("cancelled"));
    }
  }
  class Connection extends EventEmitter {
    closed = 0;
    constructor(config: Record<string, unknown>) {
      super();
      driver.configs.push(config);
      driver.clients.push(this);
    }
    connect() {
      if (!driver.hangConnect)
        queueMicrotask(() => this.emit("connect", driver.connectError));
    }
    execSql(request: Request) {
      driver.requests.push(request);
      if (driver.hangQueryAt === driver.requests.length) return;
      const rows = driver.responses.shift() ?? [];
      queueMicrotask(() => {
        if (driver.failSocket) {
          this.emit("error", new Error("private socket diagnostics"));
          return;
        }
        if (driver.queryError) {
          request.callback(driver.queryError);
          return;
        }
        for (const row of rows) {
          if (request.cancelled) break;
          request.emit(
            "row",
            Object.entries(row).map(([name, value]) => ({
              metadata: { colName: name },
              value,
            })),
          );
        }
        request.callback();
      });
    }
    close() {
      this.closed++;
      queueMicrotask(() => this.emit("end"));
    }
  }
  return {
    Connection,
    Request,
    TYPES: { Float: "Float", Bit: "Bit", NVarChar: "NVarChar" },
  };
});

const base = contextConnectionSchema.parse({
  ...fixture.connection,
  provider: "sqlserver",
  endpoint: "tds://source.example.test:1433/governed",
  sqlServerAuth: "sql_password",
  resource: { ...fixture.connection.resource, schema: "dbo" },
});
const binding = contextBindingSchema.parse(fixture.binding);
const fields = ["id", "name", "entity_type", "identifiers", "observed_at"].map(
  (name) => ({
    name,
    type: name === "observed_at" ? "datetime2" : "nvarchar",
    nullable: "NO",
  }),
);
const row = (id = "c1") => ({
  id,
  name: "Customer",
  entity_type: "company",
  identifiers: "[]",
  observed_at: new Date(),
});
function runtime(
  connection = base,
  secret = JSON.stringify({
    username: "context_reader",
    password: randomUUID(),
  }),
): ConnectorRuntime {
  return {
    tenantId: "test-tenant",
    env: {
      CUSTOMER_DB: secret,
      CONTEXT_SOURCE_TARGETS_JSON: JSON.stringify({
        "test-tenant": [
          {
            endpoint: connection.endpoint,
            provider: connection.provider,
            credentialRef: connection.credentialRef,
          },
        ],
      }),
    },
    fetch: vi.fn<typeof fetch>(),
    checkTransport: vi.fn(async () => {}),
  };
}
beforeEach(() => {
  driver.configs.length = 0;
  driver.requests.length = 0;
  driver.clients.length = 0;
  driver.responses = [fields, [row()]];
  driver.connectError = undefined;
  driver.queryError = undefined;
  driver.hangConnect = false;
  driver.hangQueryAt = 0;
  driver.failSocket = false;
});

describe("SQL Server bounded TDS adapter", () => {
  it("binds values outside SQL and discovers only the selected database/schema/table", async () => {
    const context = runtime();
    const value = "'; DROP TABLE customers; --";
    const result = await runContextConnector(
      base,
      binding,
      { customer_id: value },
      context,
    );
    expect(driver.requests[0].text).toContain(
      "TABLE_CATALOG=@database AND TABLE_SCHEMA=@schema AND TABLE_NAME=@object",
    );
    expect(
      driver.requests[0].parameters.map((p: any) => [p.name, p.value]),
    ).toEqual([
      ["database", "governed"],
      ["schema", "dbo"],
      ["object", "customers"],
    ]);
    expect(driver.requests[1].text).toBe(
      "SELECT TOP (51) [id], [name], [entity_type], [identifiers], [observed_at] FROM [dbo].[customers] WHERE [id] = @customer_id",
    );
    expect(driver.requests[1].text).not.toContain(value);
    expect(driver.requests[1].parameters).toEqual([
      { name: "customer_id", type: "NVarChar", value },
    ]);
    expect(result).toMatchObject({ truncated: false, rows: [{ id: "c1" }] });
    expect(result.fields).toContainEqual({
      name: "id",
      type: "nvarchar",
      nullable: false,
    });
    expect(result.schemaFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(context.checkTransport).toHaveBeenCalledWith(new URL(base.endpoint));
    expect(context.fetch).not.toHaveBeenCalled();
    expect(driver.clients[0].closed).toBe(1);
  });
  it("uses SQL login credentials from the reference and requires validated TLS", async () => {
    const context = runtime();
    context.env.CONTEXT_SOURCE_CA_PEM = "test-ca";
    await runContextConnector(base, binding, { customer_id: "c1" }, context);
    const auth = JSON.parse(context.env.CUSTOMER_DB!);
    expect(driver.configs[0]).toMatchObject({
      authentication: {
        type: "default",
        options: { userName: auth.username, password: auth.password },
      },
      options: {
        encrypt: true,
        trustServerCertificate: false,
        cryptoCredentialsDetails: { minVersion: "TLSv1.2", ca: "test-ca" },
        database: "governed",
        port: 1433,
        readOnlyIntent: true,
        useUTC: true,
        requestTimeout: binding.timeoutMs,
      },
    });
  });
  it("maps SQL JSON text and UTC driver dates into validated canonical records with lineage", async () => {
    const mapped = contextBindingSchema.parse({
      ...binding,
      subjectField: "id",
      purposes: ["review"],
      mapping: binding.mapping.map((m) => ({
        ...m,
        transform: m.source === "identifiers" ? "json" : m.transform,
      })),
    });
    const result = await runContextConnector(
      base,
      mapped,
      { customer_id: "c1" },
      runtime(),
    );
    const records = normalizeContextRows(mapped, result, {
      tenantId: "test-tenant",
      connectorId: "context-source:sql",
      invocationId: "sql-invocation",
      bindingDigest: "a".repeat(64),
      connectionDigest: "b".repeat(64),
    });
    expect(records[0]).toMatchObject({
      data: { name: "Customer", entity_type: "company", identifiers: [] },
      subject_ids: ["c1"],
      purposes: ["review"],
      source_refs: [{ object_id: "sql-invocation" }],
      provenance: { invocation_id: "sql-invocation" },
    });
    expect(records[0]?.observed_at).toBe(
      (result.rows[0]?.observed_at as Date).toISOString(),
    );
  });
  it("honors transport denial before constructing a native driver", async () => {
    const context = runtime();
    context.checkTransport = async () => {
      throw new Error("gateway.source_policy_denied:endpoint_denied");
    };
    await expect(
      runContextConnector(base, binding, { customer_id: "c1" }, context),
    ).rejects.toThrow("endpoint_denied");
    expect(driver.configs).toHaveLength(0);
  });
  it.each(["sqlserver", "fabric"] as const)(
    "uses Entra tokens for %s without a SQL credential fallback",
    async (provider) => {
      const connection = contextConnectionSchema.parse({
        ...base,
        provider,
        sqlServerAuth: provider === "sqlserver" ? "entra_token" : undefined,
      });
      const token = randomUUID();
      await runContextConnector(
        connection,
        binding,
        { customer_id: "c1" },
        runtime(connection, token),
      );
      expect(driver.configs[0]?.authentication).toEqual({
        type: "azure-active-directory-access-token",
        options: { token },
      });
    },
  );
  it("uses only the delegated token when a token exchange is explicitly supplied", async () => {
    const connection = contextConnectionSchema.parse({
      ...base,
      identityMode: "delegated",
      sqlServerAuth: "entra_token",
    });
    const context = runtime(connection);
    const token = randomUUID();
    context.delegatedCredential = vi.fn(async () => token);
    await runContextConnector(
      connection,
      binding,
      { customer_id: "c1" },
      context,
    );
    expect(driver.configs[0]?.authentication.options.token).toBe(token);
    expect(context.delegatedCredential).toHaveBeenCalledOnce();
  });
  it("does not read rows during schema discovery", async () => {
    const result = await runContextConnector(
      base,
      binding,
      { customer_id: "c1" },
      runtime(),
      true,
    );
    expect(result.rows).toEqual([]);
    expect(result.fields).toHaveLength(5);
    expect(driver.requests).toHaveLength(1);
  });
  it("detects truncation with one bounded sentinel row", async () => {
    driver.responses = [fields, [row("1"), row("2"), row("3")]];
    const result = await runContextConnector(
      base,
      { ...binding, maximumRows: 2 },
      { customer_id: "c1" },
      runtime(),
    );
    expect(driver.requests[1].text).toContain("TOP (3)");
    expect(result.truncated).toBe(true);
    expect(result.rows).toHaveLength(2);
  });
  it("cancels oversized results while streaming and closes the connection", async () => {
    driver.responses = [
      fields,
      [{ ...row(), name: "x".repeat(2 * 1024 * 1024) }],
    ];
    await expect(
      runContextConnector(base, binding, { customer_id: "c1" }, runtime()),
    ).rejects.toThrow("context_source.response_too_large");
    expect(driver.requests[1].cancelled).toBe(true);
    expect(driver.clients[0].closed).toBe(1);
  });
  it("rejects undeclared resources, statements, credentials, and foreign tenants before a socket opens", async () => {
    for (const secret of [
      "not-json",
      "{}",
      JSON.stringify({ username: "reader" }),
      JSON.stringify({ username: "", password: randomUUID() }),
    ])
      await expect(
        runContextConnector(
          base,
          binding,
          { customer_id: "c1" },
          runtime(base, secret),
        ),
      ).rejects.toThrow("context_source.credential_invalid");
    await expect(
      runContextConnector(
        base,
        { ...binding, query: "SELECT * FROM another_table" },
        { customer_id: "c1" },
        runtime(),
      ),
    ).rejects.toThrow("query_scope_denied");
    await expect(
      runContextConnector(
        base,
        { ...binding, query: "SELECT * FROM customers; DELETE FROM customers" },
        { customer_id: "c1" },
        runtime(),
      ),
    ).rejects.toThrow("query_not_read_only");
    await expect(
      runContextConnector(
        base,
        binding,
        { customer_id: "c1" },
        { ...runtime(), tenantId: "other" },
      ),
    ).rejects.toThrow("target_not_approved");
    const mismatched = {
      ...base,
      resource: { ...base.resource, database: "other" },
    };
    await expect(
      runContextConnector(
        mismatched,
        binding,
        { customer_id: "c1" },
        runtime(mismatched),
      ),
    ).rejects.toThrow("database_scope_denied");
    expect(driver.configs).toHaveLength(0);
  });
  it("keeps exact numeric values as text in the generated projection", async () => {
    driver.responses = [
      [...fields, { name: "amount", type: "decimal", nullable: "YES" }],
      [{ ...row(), amount: "12345678901234567890.1234" }],
    ];
    const result = await runContextConnector(
      base,
      {
        ...binding,
        query: "SELECT id, amount FROM customers WHERE id = :customer_id",
      },
      { customer_id: "c1" },
      runtime(),
    );
    expect(driver.requests[1].text).toContain(
      "CONVERT(nvarchar(128), [amount], 2) AS [amount]",
    );
    expect(result.rows[0]?.amount).toBe("12345678901234567890.1234");
    expect(result.fields.find((f) => f.name === "amount")?.type).toBe(
      "decimal",
    );
  });
  it("projects the declared subject field and binds repeated named parameters only once", async () => {
    driver.responses = [
      [...fields, { name: "subject_id", type: "nvarchar", nullable: "NO" }],
      [{ ...row(), subject_id: "c1" }],
    ];
    const wildcard = {
      ...binding,
      subjectField: "subject_id",
      query:
        "SELECT * FROM customers WHERE id = :customer_id AND subject_id = :customer_id",
    };
    await runContextConnector(base, wildcard, { customer_id: "c1" }, runtime());
    expect(driver.requests[1].text).toContain("[subject_id]");
    expect(driver.requests[1].parameters).toHaveLength(1);
  });
  it("rejects unknown columns and mismatched case before a row query can bypass exact numeric conversion", async () => {
    for (const query of [
      "SELECT amount FROM customers WHERE id = :customer_id",
      "SELECT id FROM customers WHERE missing = :customer_id",
    ]) {
      driver.responses = [
        [...fields, { name: "Amount", type: "decimal", nullable: "YES" }],
      ];
      const before = driver.requests.length;
      await expect(
        runContextConnector(
          base,
          { ...binding, query },
          { customer_id: "c1" },
          runtime(),
        ),
      ).rejects.toThrow("context_source.column_unknown");
      expect(driver.requests).toHaveLength(before + 1);
    }
  });
  it("rejects absent and invalid schemas", async () => {
    for (const metadata of [
      [],
      [{ name: "bad.name", type: "nvarchar", nullable: "NO" }],
      Array.from({ length: 501 }, (_, i) => ({
        name: `c${i}`,
        type: "nvarchar",
        nullable: "NO",
      })),
    ]) {
      driver.responses = [metadata];
      await expect(
        runContextConnector(
          base,
          binding,
          { customer_id: "c1" },
          runtime(),
          true,
        ),
      ).rejects.toThrow(/resource_not_found|schema_invalid/);
    }
  });
  it.each(["connect", "query", "socket"])(
    "sanitizes %s failures and closes the driver",
    async (phase) => {
      if (phase === "connect")
        driver.connectError = new Error("private login diagnostics");
      if (phase === "query")
        driver.queryError = new Error("private query diagnostics");
      if (phase === "socket") driver.failSocket = true;
      await expect(
        runContextConnector(base, binding, { customer_id: "c1" }, runtime()),
      ).rejects.toThrow(
        phase === "query"
          ? "context_source.query_failed"
          : "context_source.connection_failed",
      );
      expect(driver.clients[0].closed).toBe(1);
      // A subsequent late driver error is still handled after the operation settles.
      expect(() =>
        driver.clients[0].emit("error", new Error("late diagnostics")),
      ).not.toThrow();
    },
  );
  it.each(["connect", "metadata", "read"])(
    "cancels an in-flight %s",
    async (phase) => {
      driver.hangConnect = phase === "connect";
      driver.hangQueryAt = phase === "metadata" ? 1 : phase === "read" ? 2 : 0;
      const controller = new AbortController();
      const context = { ...runtime(), signal: controller.signal };
      const outcome = expect(
        runContextConnector(base, binding, { customer_id: "c1" }, context),
      ).rejects.toThrow("context_source.timeout");
      await vi.waitFor(() =>
        expect(
          phase === "connect" ? driver.clients.length : driver.requests.length,
        ).toBe(phase === "read" ? 2 : 1),
      );
      controller.abort();
      await outcome;
      expect(driver.clients[0].closed).toBe(1);
    },
  );
  it("rejects already cancelled work before constructing a driver", async () => {
    await expect(
      runContextConnector(
        base,
        binding,
        { customer_id: "c1" },
        { ...runtime(), signal: AbortSignal.abort() },
      ),
    ).rejects.toThrow();
    expect(driver.configs).toHaveLength(0);
  });
  it("enforces the binding timeout without relying on a provider callback", async () => {
    driver.hangQueryAt = 2;
    await expect(
      runContextConnector(
        base,
        { ...binding, timeoutMs: 100 },
        { customer_id: "c1" },
        runtime(),
      ),
    ).rejects.toThrow("context_source.timeout");
    expect(driver.clients[0].closed).toBe(1);
  });
  it("compiles a SQL Server SELECT with no PostgreSQL LIMIT clause", () => {
    const query = contextReadQuery(base, binding, { customer_id: "c1" });
    expect(query.text).toContain("TOP (51)");
    expect(query.text).not.toContain("LIMIT");
  });
});
