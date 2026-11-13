import { describe, it, expect } from "vitest";
import pg from "pg";
import {
  assertContextSourceDestination,
  contextSourceCredential,
  discoverContextResource,
  fetchContextSample,
} from "./index.js";
import type { ContextSetupConnection, ContextResourceBinding } from "@ehf/contracts";
const connection: ContextSetupConnection = {
  kind: "connection",
  id: "test",
  name: "Test",
  connectorId: "context-postgres:customers",
  credentialRef: "CONTEXT_SOURCE_TEST",
  credentialGeneration: "v1",
  identityMode: "service",
  resources: [
    {
      schema: "public",
      table: "context_source_test",
      columns: ["key", "observed_at"],
    },
  ],
};
const resource: ContextResourceBinding = {
  kind: "resource",
  id: "view",
  connectionId: "test",
  connectionDigest: "a".repeat(64),
  schema: "public",
  table: "context_source_test",
  columns: ["key", "observed_at"],
  subjectColumn: "key",
  observedAtColumn: "observed_at",
  schemaFingerprint: null,
  maxRows: 2,
};
it("does not allow credentials to cross tenants, generations or approved destinations", () => {
  const env = {
    CONTEXT_SOURCE_TEST: JSON.stringify({
      tenantId: "tenant",
      generation: "v1",
      connectorId: connection.connectorId,
      connectionString: "postgresql://user:secret@db.example:5432/customers",
    }),
  };
  expect(() => contextSourceCredential(connection, "other", env)).toThrow(
    "context.credential_scope_denied",
  );
  expect(() =>
    contextSourceCredential(
      { ...connection, credentialGeneration: "v2" },
      "tenant",
      env,
    ),
  ).toThrow("context.credential_scope_denied");
  expect(() =>
    contextSourceCredential(connection, "tenant", {
      CONTEXT_SOURCE_TEST: "null",
    }),
  ).toThrow("context.credential_invalid");
  expect(() =>
    contextSourceCredential(connection, "tenant", {
      CONTEXT_SOURCE_TEST: JSON.stringify({
        tenantId: "tenant",
        generation: "v1",
        connectorId: connection.connectorId,
        connectionString: "postgresql://user:secret@approved/db?host=other",
      }),
    }),
  ).toThrow("context.credential_invalid");
  expect(() =>
    assertContextSourceDestination(connection, "tenant", env, {
      transport: "local",
      approvedEndpoints: [],
    }),
  ).toThrow("context.source_destination_denied");
  expect(() =>
    assertContextSourceDestination(connection, "tenant", env, {
      transport: "network",
      approvedEndpoints: ["postgresql://db.example:5432/customers"],
    }),
  ).not.toThrow();
});
describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)(
  "bounded native PostgreSQL source",
  () => {
    it("fingerprints source types, binds values and enforces schema, subject, row and resource bounds", async () => {
      const admin = new pg.Client({
        connectionString: process.env.EHF_TEST_DATABASE_URL,
      });
      await admin.connect();
      const env = {
        CONTEXT_SOURCE_TEST: JSON.stringify({
          tenantId: "tenant",
          generation: "v1",
          connectorId: connection.connectorId,
          connectionString: process.env.EHF_TEST_DATABASE_URL,
        }),
      };
      try {
        await admin.query(
          "create table if not exists public.context_source_test(key text,observed_at timestamptz)",
        );
        await admin.query("truncate public.context_source_test");
        await admin.query(
          "insert into public.context_source_test values ('a','2026-11-09T12:00:00Z'),('b','2026-11-09T12:00:00Z'),('c','2026-11-09T12:00:00Z')",
        );
        const schema = await discoverContextResource(
          connection,
          resource,
          "tenant",
          env,
        );
        const fetch = await fetchContextSample(
          connection,
          { ...resource, schemaFingerprint: schema.fingerprint },
          ["a", "b", "c"],
          "tenant",
          env,
        );
        expect(fetch.rows).toHaveLength(2);
        expect(fetch.truncated).toBe(true);
        expect(typeof fetch.rows[0]!.observed_at).toBe("string");
        expect(
          (
            await fetchContextSample(
              connection,
              { ...resource, schemaFingerprint: schema.fingerprint },
              ["a' OR true --"],
              "tenant",
              env,
            )
          ).rows,
        ).toEqual([]);
        await expect(
          fetchContextSample(connection, resource, ["a"], "tenant", env),
        ).rejects.toThrow("context.source_schema_changed");
        await expect(
          fetchContextSample(
            connection,
            { ...resource, table: "other" },
            ["a"],
            "tenant",
            env,
          ),
        ).rejects.toThrow("context.resource_scope_denied");
        await admin.query(
          "alter table public.context_source_test add column amount numeric",
        );
        await admin.query(
          "update public.context_source_test set amount=0.12345678901234567890 where key='a'",
        );
        const exactConnection = {
          ...connection,
          resources: [
            {
              ...connection.resources[0]!,
              columns: ["key", "observed_at", "amount"],
            },
          ],
        };
        const exactResource = {
          ...resource,
          columns: ["key", "observed_at", "amount"],
        };
        const exactSchema = await discoverContextResource(
          exactConnection,
          exactResource,
          "tenant",
          env,
        );
        const exact = await fetchContextSample(
          exactConnection,
          { ...exactResource, schemaFingerprint: exactSchema.fingerprint },
          ["a"],
          "tenant",
          env,
        );
        expect(exact.rows[0]!.amount).toBe("0.12345678901234567890");
        expect(
          (
            await admin.query(
              "select count(*)::int as count from context_source_test",
            )
          ).rows[0].count,
        ).toBe(3);
      } finally {
        await admin.query("drop table public.context_source_test");
        await admin.end();
      }
    });
  },
);
