import { describe, expect, it } from "vitest";
import {
  contextConnectionFromDeployment,
  contextConnectionSchema,
} from "./context-sources.js";
import {
  defaultDeploymentProfile,
  deploymentProfileSchema,
} from "./deployment.js";
import fixture from "../test-fixtures/context-source.json" with { type: "json" };

const connection = {
  ...fixture.connection,
  provider: "sqlserver",
  endpoint: "tds://source.example.test:1433/governed",
  sqlServerAuth: "sql_password",
};
describe("SQL Server connection contracts", () => {
  it("accepts SQL login and explicit Entra token references without inline credentials", () => {
    expect(contextConnectionSchema.parse(connection).sqlServerAuth).toBe(
      "sql_password",
    );
    expect(
      contextConnectionSchema.parse({
        ...connection,
        sqlServerAuth: "entra_token",
      }).sqlServerAuth,
    ).toBe("entra_token");
    expect(
      contextConnectionSchema.safeParse({ ...connection, username: "inline" })
        .success,
    ).toBe(false);
    expect(
      contextConnectionSchema.safeParse({
        ...connection,
        credentialRef: "inline",
      }).success,
    ).toBe(false);
  });
  it("rejects untrusted endpoint encodings and non-TDS protocols without throwing", () => {
    for (const endpoint of [
      "not-a-url",
      "https://source.example.test/governed",
      "tds://user:password@source.example.test/governed",
      "tds://source.example.test/governed?password=value",
      "tds://source.example.test/%67overned",
      "tds://source.example.test/governed#fragment",
    ])
      expect(
        contextConnectionSchema.safeParse({ ...connection, endpoint }).success,
      ).toBe(false);
    expect(
      contextConnectionSchema.safeParse({
        ...connection,
        resource: { ...connection.resource, database: "" },
      }).success,
    ).toBe(false);
  });
  it("does not silently reinterpret SQL passwords as delegated tokens or change Fabric auth", () => {
    expect(
      contextConnectionSchema.safeParse({
        ...connection,
        identityMode: "delegated",
      }).success,
    ).toBe(false);
    expect(
      contextConnectionSchema.safeParse({
        ...connection,
        identityMode: "delegated",
        sqlServerAuth: "entra_token",
      }).success,
    ).toBe(true);
    expect(
      contextConnectionSchema.safeParse({ ...connection, provider: "fabric" })
        .success,
    ).toBe(false);
    expect(contextConnectionSchema.safeParse(fixture.connection).success).toBe(
      true,
    );
  });
  it("imports a SQL Server deployment proposal as an unqualified editable connection", () => {
    const proposal = {
      id: "sql-customers",
      name: "SQL customers",
      template: "sqlserver" as const,
      endpoint: connection.endpoint,
      resource: "customers",
      credentialRef: "env:SQL_CUSTOMERS",
      identityMode: "service" as const,
      freshnessMinutes: 60,
    };
    const profile = defaultDeploymentProfile({
      provider: "container",
      scopeId: "local",
      region: "local",
      recipe: "container-bootstrap-v1",
    });
    profile.connections = [proposal];
    expect(deploymentProfileSchema.safeParse(profile).success).toBe(true);
    expect(
      contextConnectionSchema.parse(contextConnectionFromDeployment(proposal)),
    ).toMatchObject({
      provider: "sqlserver",
      endpoint: connection.endpoint,
      sqlServerAuth: "sql_password",
      resource: { database: "governed", schema: "dbo", object: "customers" },
    });
  });
});
