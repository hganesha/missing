import { describe, expect, it } from "vitest";
import { defaultDeploymentProfile, deploymentModelName, deploymentProfileSchema } from "./deployment.js";

const initial = () => defaultDeploymentProfile({ provider: "container", scopeId: "local", region: "local", recipe: "container-bootstrap-v1" });
const connection = { id: "source", name: "Source", template: "openapi" as const, endpoint: "https://source.example.com", resource: "customers", credentialRef: "env:SOURCE_TOKEN", identityMode: "service" as const, freshnessMinutes: 60 };

describe("Foundry model bindings", () => {
  it("validates v1 resource endpoints and resolves deployment names without bypassing the curated catalog", () => {
    const profile = initial();
    profile.intelligence.provider = "azure_foundry";
    profile.intelligence.models.low = "curated";
    profile.intelligence.deployments = { low: "test-low" };
    const catalog = { revision: "test", models: [{ id: "curated", name: "Model", publisher: "OpenAI", family: "frontier" as const, providers: { azure_foundry: "gpt-4.1-mini" } }] };
    for (const endpoint of ["https://example.openai.azure.com/openai/v1", "https://example.services.ai.azure.com/openai/v1/"]) {
      profile.intelligence.endpoint = endpoint;
      expect(deploymentProfileSchema.safeParse(profile).success).toBe(true);
    }
    expect(deploymentModelName(profile, catalog, "low")).toBe("test-low");
    profile.intelligence.deployments.low = "";
    expect(deploymentModelName(profile, catalog, "low")).toBe("gpt-4.1-mini");
    profile.intelligence.models.low = "not-curated";
    expect(deploymentModelName(profile, catalog, "low")).toBeUndefined();
    for (const endpoint of ["https://example.openai.azure.com", "https://example.services.ai.azure.com/api/projects/demo", "https://example.openai.azure.com/openai/deployments/test", "https://example.openai.azure.com/openai/v1?api-version=legacy"]) {
      profile.intelligence.endpoint = endpoint;
      expect(deploymentProfileSchema.safeParse(profile).success).toBe(false);
    }
    profile.intelligence.endpoint = "https://example.openai.azure.com/openai/v1";
    profile.intelligence.deployments.low = "deployment/escape";
    expect(deploymentProfileSchema.safeParse(profile).success).toBe(false);
  });
});

describe("deployment profile boundaries", () => {
  it("preserves legacy S3 profiles and validates the selected ADLS filesystem endpoint", () => {
    const profile = initial(); delete profile.foundation.objectStore.provider;
    expect(deploymentProfileSchema.safeParse(profile).success).toBe(true);
    profile.foundation.objectStore = { provider: "adls_gen2", endpoint: "https://testaccount.dfs.core.windows.net", bucket: "evidence", credentialRef: "env:ADLS_CREDENTIAL" };
    expect(deploymentProfileSchema.safeParse(profile).success).toBe(true);
    for (const endpoint of ["https://objects.example.com", "https://testaccount.dfs.core.windows.net/evidence", "https://testaccount.dfs.core.windows.net?sig=secret"]) expect(deploymentProfileSchema.safeParse({ ...profile, foundation: { ...profile.foundation, objectStore: { ...profile.foundation.objectStore, endpoint } } }).success).toBe(false);
    profile.foundation.objectStore.bucket = "invalid--filesystem";
    expect(deploymentProfileSchema.safeParse(profile).success).toBe(false);
  });
  it("accepts older profiles and validates optional document endpoints and secret references", () => {
    const profile = initial(); delete profile.intelligence.documentIntelligence;
    expect(deploymentProfileSchema.safeParse(profile).success).toBe(true);
    profile.intelligence.documentIntelligence = { endpoint: "https://documents.example.com", credentialRef: "env:DOCUMENT_TOKEN" };
    expect(deploymentProfileSchema.safeParse(profile).success).toBe(true);
    for (const endpoint of ["http://documents.example.com", "https://key@documents.example.com", "https://documents.example.com?key=secret", ""]) {
      expect(deploymentProfileSchema.safeParse({ ...profile, intelligence: { ...profile.intelligence, documentIntelligence: { ...profile.intelligence.documentIntelligence, endpoint } } }).success).toBe(false);
    }
    profile.intelligence.documentIntelligence.credentialRef = "literal-token";
    expect(deploymentProfileSchema.safeParse(profile).success).toBe(false);
  });
  it("refuses scheduled execution under an interactive delegated identity", () => {
    const profile = initial();
    profile.connections.push({ ...connection, identityMode: "delegated" });
    profile.schedules.push({ id: "schedule", connectionId: "source", intervalMinutes: 60, timezone: "America/Chicago", overlap: "skip", enabled: false });
    expect(deploymentProfileSchema.safeParse(profile).success).toBe(false);
  });
  it("requires a connector's declared protocol and handles malformed endpoints as validation errors", () => {
    for (const endpoint of ["not a URL", "postgresql://source.example.com", "https://source.example.com?token=secret"]) {
      const profile = initial(); profile.connections.push({ ...connection, endpoint });
      expect(deploymentProfileSchema.safeParse(profile).success).toBe(false);
    }
  });
  it("rejects duplicate source IDs and references to missing sources", () => {
    const profile = initial(); profile.connections.push(connection, connection);
    expect(deploymentProfileSchema.safeParse(profile).success).toBe(false);
    profile.connections = [];
    profile.schedules.push({ id: "schedule", connectionId: "missing", intervalMinutes: 60, timezone: "UTC", overlap: "skip", enabled: false });
    expect(deploymentProfileSchema.safeParse(profile).success).toBe(false);
  });
});
