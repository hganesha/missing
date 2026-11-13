import { describe, expect, it, vi } from "vitest";
import {
  apiContextConnectionSchema,
  apiContextResourceSchema,
} from "@ehf/contracts/context-setup";
import {
  discoverContextResource,
  fetchContextSample,
  assertContextSourceDestination,
  contextSourceCredential,
} from "./index.js";

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "content-type": "application/json" },
  });
const c = apiContextConnectionSchema.parse({
  kind: "connection",
  id: "crm",
  name: "Bank CRM",
  connectorId: "context-salesforce:identity",
  credentialRef: "CONTEXT_SOURCE_TEST",
  credentialGeneration: "v1",
  identityMode: "service",
  api: {
    kind: "salesforce",
    baseUrl: "https://bank.my.salesforce.com/",
    tokenUrl: "https://bank.my.salesforce.com/services/oauth2/token",
    instanceId: "bank",
    apiVersion: "v61.0",
  },
  resources: [
    {
      datasetId: "salesforce.Account",
      fields: ["Id", "Name", "LastModifiedDate"],
    },
  ],
});
const r = apiContextResourceSchema.parse({
  kind: "resource",
  id: "account",
  connectionId: c.id,
  connectionDigest: "a".repeat(64),
  datasetId: "salesforce.Account",
  columns: ["key", "name", "observed_at"],
  subjectColumn: "key",
  observedAtColumn: "observed_at",
  schemaFingerprint: null,
  maxRows: 100,
  api: {
    kind: "salesforce",
    object: "Account",
    subjectField: "Id",
    fields: { key: "Id", name: "Name", observed_at: "LastModifiedDate" },
  },
});
const env = {
  CONTEXT_SOURCE_TEST: JSON.stringify({
    tenantId: "tenant",
    connectorId: c.connectorId,
    generation: "v1",
    instanceId: "bank",
    baseUrl: c.api.baseUrl,
    tokenUrl: c.api.tokenUrl,
    clientId: "test-client",
    clientSecret: "test-secret",
  }),
};
const meta = {
  queryable: true,
  fields: ["Id", "Name", "LastModifiedDate"].map((name) => ({
    name,
    type: "string",
    nillable: false,
  })),
};
function mockSource(pages: unknown[]) {
  return vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    expect(init?.redirect).toBe("error");
    if (String(url) === c.api.tokenUrl)
      return json({
        access_token: "scoped-token",
        instance_url: c.api.baseUrl,
      });
    if (String(url).endsWith("/describe/")) return json(meta);
    if (!pages.length) throw new Error("Unexpected query");
    return json(pages.shift());
  });
}
describe("bounded on-demand API source driver", () => {
  it("discovers and pins selected fields, follows scoped Salesforce pages, and projects away extra payload", async () => {
    const fetcher = mockSource([
      {
        records: [
          {
            Id: "001",
            Name: "One",
            LastModifiedDate: "2026-11-09T12:00:00Z",
            Secret: "excluded",
          },
        ],
        totalSize: 2,
        done: false,
        nextRecordsUrl: "/services/data/v61.0/query/locator-1",
      },
      {
        records: [
          { Id: "002", Name: "Two", LastModifiedDate: "2026-11-09T12:00:00Z" },
        ],
        totalSize: 2,
        done: true,
      },
    ]);
    const schema = await discoverContextResource(c, r, "tenant", env, fetcher);
    const result = await fetchContextSample(
      c,
      { ...r, schemaFingerprint: schema.fingerprint },
      ["001", "002"],
      "tenant",
      env,
      fetcher,
    );
    expect(result.rows).toEqual([
      { key: "001", name: "One", observed_at: "2026-11-09T12:00:00Z" },
      { key: "002", name: "Two", observed_at: "2026-11-09T12:00:00Z" },
    ]);
    expect(result.truncated).toBe(false);
    expect(
      fetcher.mock.calls.some(([url]) =>
        decodeURIComponent(String(url)).includes(
          "WHERE Id IN ('001','002') LIMIT 101",
        ),
      ),
    ).toBe(true);
  });
  it("rejects changed schema, missing subjects, foreign records, foreign continuation hosts and oversized rows", async () => {
    const good = mockSource([]),
      { fingerprint } = await discoverContextResource(
        c,
        r,
        "tenant",
        env,
        good,
      ),
      pin = { ...r, schemaFingerprint: fingerprint };
    await expect(
      fetchContextSample(
        c,
        { ...pin, schemaFingerprint: "f".repeat(64) },
        ["001"],
        "tenant",
        env,
        mockSource([]),
      ),
    ).rejects.toThrow("source_schema_changed");
    for (const [page, error] of [
      [{ records: [], totalSize: 0, done: true }, "requested_subject_missing"],
      [
        {
          records: [
            { Id: "foreign", LastModifiedDate: "2026-11-09T12:00:00Z" },
          ],
          totalSize: 1,
          done: true,
        },
        "source_subject_scope_denied",
      ],
      [
        {
          records: [],
          totalSize: 1,
          done: false,
          nextRecordsUrl: "https://evil.example/query",
        },
        "source_pagination_invalid",
      ],
      [{ records: [], totalSize: 101, done: true }, "source_row_limit"],
      [
        {
          records: [
            {
              Id: "001",
              Name: "x".repeat(520000),
              LastModifiedDate: "2026-11-09T12:00:00Z",
            },
          ],
          totalSize: 1,
          done: true,
        },
        "sample_byte_limit",
      ],
    ] as const)
      await expect(
        fetchContextSample(c, pin, ["001"], "tenant", env, mockSource([page])),
      ).rejects.toThrow(error);
  });
  it("binds mounted credentials to tenant, connector, instance, generation and approved API/token destinations", () => {
    expect(() => contextSourceCredential(c, "other", env)).toThrow(
      "credential_scope_denied",
    );
    expect(() =>
      contextSourceCredential(
        { ...c, credentialGeneration: "v2" },
        "tenant",
        env,
      ),
    ).toThrow("credential_scope_denied");
    expect(() =>
      assertContextSourceDestination(c, "tenant", env, {
        transport: "network",
        approvedEndpoints: [c.api.baseUrl],
      }),
    ).toThrow("source_destination_denied");
    expect(() =>
      assertContextSourceDestination(c, "tenant", env, {
        transport: "network",
        approvedEndpoints: [c.api.baseUrl, c.api.tokenUrl],
      }),
    ).not.toThrow();
  });
  it("uses a pinned Fenergo GET operation and records path; never calls command or event APIs", async () => {
    const fc = apiContextConnectionSchema.parse({
      ...c,
      connectorId: "context-fenergo:identity",
      api: {
        kind: "fenergo",
        baseUrl: "https://api.bank.fenergox.com/",
        tokenUrl: "https://identity.bank.fenergox.com/connect/token",
        instanceId: "bank",
      },
      resources: [
        { datasetId: "fenergo.entity", fields: ["id", "name", "updatedAt"] },
      ],
    });
    const fr = apiContextResourceSchema.parse({
      ...r,
      datasetId: "fenergo.entity",
      api: {
        kind: "fenergo",
        path: "/entitydataquery/api/entity/{subject}",
        schemaPath: "/entitydataquery/swagger/1.0/swagger.json",
        recordsPath: "data",
        fields: { key: "id", name: "name", observed_at: "updatedAt" },
      },
    });
    const fe = {
      CONTEXT_SOURCE_TEST: JSON.stringify({
        tenantId: "tenant",
        connectorId: fc.connectorId,
        generation: "v1",
        instanceId: "bank",
        baseUrl: fc.api.baseUrl,
        tokenUrl: fc.api.tokenUrl,
        clientId: "test",
        clientSecret: "secret",
      }),
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(async (url, init) => {
        if (String(url) === fc.api.tokenUrl)
          return json({ access_token: "token" });
        expect(init?.method ?? "GET").toBe("GET");
        if (String(url).endsWith(".json"))
          return json({
            openapi: "3.0.0",
            paths: { "/api/entity/{id}": { get: {} } },
          });
        expect(String(url)).toBe(
          "https://api.bank.fenergox.com/entitydataquery/api/entity/001",
        );
        return json({
          data: {
            id: "001",
            name: "Verified name",
            updatedAt: "2026-11-09T12:00:00Z",
            unused: "private",
          },
        });
      });
    const { fingerprint } = await discoverContextResource(
      fc,
      fr,
      "tenant",
      fe,
      fetcher,
    );
    expect(
      (
        await fetchContextSample(
          fc,
          { ...fr, schemaFingerprint: fingerprint },
          ["001"],
          "tenant",
          fe,
          fetcher,
        )
      ).rows[0],
    ).toEqual({
      key: "001",
      name: "Verified name",
      observed_at: "2026-11-09T12:00:00Z",
    });
    expect(() =>
      apiContextResourceSchema.parse({
        ...fr,
        api: { ...fr.api, path: "/journeycommand/api/entity/{subject}" },
      }),
    ).toThrow();
  });
});
it("preserves API decimal lexemes before JavaScript can round ownership or money fields", async () => {
  const connection = {
    ...c,
    resources: [
      {
        datasetId: "salesforce.Account",
        fields: [...c.resources[0]!.fields, "Amount"],
      },
    ],
  };
  const resource = apiContextResourceSchema.parse({
    ...r,
    columns: [...r.columns, "amount"],
    api: { ...r.api, fields: { ...r.api.fields, amount: "Amount" } },
  });
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    if (String(url) === c.api.tokenUrl) return json({ access_token: "token" });
    if (String(url).endsWith("/describe/"))
      return json({
        ...meta,
        fields: [
          ...meta.fields,
          { name: "Amount", type: "currency", nillable: false },
        ],
      });
    return new Response(
      '{"totalSize":1,"done":true,"records":[{"Id":"001","Name":"One","LastModifiedDate":"2026-11-09T12:00:00Z","Amount":123456789012345678.123456789}]}',
    );
  });
  const { fingerprint } = await discoverContextResource(
    connection,
    resource,
    "tenant",
    env,
    fetcher,
  );
  const result = await fetchContextSample(
    connection,
    { ...resource, schemaFingerprint: fingerprint },
    ["001"],
    "tenant",
    env,
    fetcher,
  );
  expect(result.rows[0]?.amount).toBe("123456789012345678.123456789");
});
