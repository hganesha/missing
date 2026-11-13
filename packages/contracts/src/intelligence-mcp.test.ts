import { expect, it } from "vitest";
import fixture from "../test-fixtures/intelligence-mcp.json" with { type: "json" };
import { intelligenceAdapterImplemented, intelligenceConfigurationChecks, intelligenceDefinitionSchema, mcpRegisteredTool } from "./intelligence.js";

it("registers MCP servers and tools without implying executable discovery or activation", () => {
  const definition = intelligenceDefinitionSchema.parse(fixture);
  expect(intelligenceAdapterImplemented(definition)).toBe(false);
  const checks = intelligenceConfigurationChecks(definition, false);
  expect(checks.filter(check => check.status === "failed").map(check => check.id)).toEqual(["adapter"]);
  expect(checks.find(check => check.id === "mcp_discovery")?.status).toBe("unknown");
  expect(checks.find(check => check.id === "activation")?.status).toBe("unknown");
});
it("rejects wildcard/duplicate tools, duplicate mappings, unknown commands and invalid pins", () => {
  const config = fixture.configuration;
  for (const patch of [
    { tools: [{ ...config.tools[0], name: "*" }] },
    { tools: [config.tools[0], config.tools[0]] },
    { tools: [config.tools[0], { ...config.tools[0], name: "other" }] },
    { catalogDigest: "latest" }, { catalogChangeBehavior: "auto_enable" },
    { command: "npx unreviewed-server" }, { maxConcurrency: 0 }, { scopes: ["read", "read"] },
  ]) expect(intelligenceDefinitionSchema.safeParse({ ...fixture, configuration: { ...config, ...patch } }).success).toBe(false);
  expect(intelligenceDefinitionSchema.safeParse({ ...fixture, id: "runtime.tools" }).success).toBe(false);
});
it("requires delegated OAuth scope and resource identity rather than reusing a workload credential", () => {
  const definition = intelligenceDefinitionSchema.parse({ ...fixture, connection: { ...fixture.connection, auth: { ...fixture.connection.auth, mode: "provider_key", credentialRef: "MCP_API_KEY" } } });
  expect(intelligenceConfigurationChecks(definition, false).find(check => check.id === "mcp_identity")?.status).toBe("failed");
  const missingScopes = intelligenceDefinitionSchema.parse({ ...fixture, configuration: { ...fixture.configuration, scopes: [] } });
  expect(intelligenceConfigurationChecks(missingScopes, false).find(check => check.id === "mcp_identity")?.status).toBe("failed");
});
it("requires a private reviewed stdio launch profile, without an HTTP endpoint or shell execution", () => {
  const definition = intelligenceDefinitionSchema.parse({ ...fixture,
    connection: { ...fixture.connection, cloud: "private", adapterId: "mcp_stdio", endpoint: null, auth: { ...fixture.connection.auth, mode: "unconfigured", credentialRef: null, clientIdRef: null } },
    configuration: { ...fixture.configuration, transport: "stdio", identityMode: "workload", launchProfileRef: "deployment:mcp-customer.v1" },
  });
  const checks = intelligenceConfigurationChecks(definition, false);
  expect(checks.find(check => check.id === "endpoint")?.status).toBe("passed");
  expect(checks.find(check => check.id === "identity")?.status).toBe("passed");
  expect(checks.find(check => check.id === "mcp_identity")?.status).toBe("passed");
});
it("denies unregistered tools and catalog drift before downstream capability authorization", () => {
  const definition = intelligenceDefinitionSchema.parse(fixture);
  if (definition.serviceClass !== "mcp") throw new Error("Expected MCP fixture");
  const config = definition.configuration;
  expect(mcpRegisteredTool(config, "customer_lookup", "a".repeat(64)).status).toBe("registered");
  expect(mcpRegisteredTool(config, "delete_customer", "a".repeat(64))).toEqual({ status: "denied", reason: "tool_not_registered" });
  expect(mcpRegisteredTool(config, "customer_lookup", "b".repeat(64))).toEqual({ status: "denied", reason: "catalog_drift" });
  expect(mcpRegisteredTool({ ...config, catalogDigest: null }, "customer_lookup", "a".repeat(64))).toEqual({ status: "denied", reason: "catalog_unpinned" });
});
