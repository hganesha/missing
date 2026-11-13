import { expect, it } from "vitest";
import fixture from "../test-fixtures/intelligence-binding.json" with { type: "json" };
import documentFixture from "../test-fixtures/intelligence-document.json" with { type: "json" };
import decisionFixture from "../test-fixtures/intelligence-decision.json" with { type: "json" };
import { intelligenceAdapterImplemented, intelligenceConfigurationChecks, intelligenceDefinitionSchema, intelligenceSaveSchema } from "./intelligence.js";
import { modelProfileDocumentSchema, stableDigest } from "./index.js";

it("keeps tier intent and proposals separate from strict legacy profile digests", () => {
  const definition = intelligenceDefinitionSchema.parse(fixture);
  expect(definition.serviceClass).toBe("reasoning");
  const profile = { id: "model.standard.v1", provider: "openrouter", model: "test", maxOutputTokens: 2400, timeoutMs: 45000, maxConcurrency: 4 };
  expect(modelProfileDocumentSchema.parse(profile)).toEqual(profile);
  expect(modelProfileDocumentSchema.safeParse({ ...profile, nativeEffort: "medium" }).success).toBe(false);
  expect(stableDigest(profile)).toBe(stableDigest(modelProfileDocumentSchema.parse(profile)));
  expect(intelligenceDefinitionSchema.safeParse({ ...fixture, id: "reasoning.high" }).success).toBe(false);
});
it("rejects embedded secrets, unbounded parameters, unknown fields and unsafe URLs", () => {
  for (const endpoint of ["http://models.example.com", "https://user:secret@models.example.com", "https://models.example.com?key=secret", "https://models.example.com#secret"]) {
    expect(intelligenceDefinitionSchema.safeParse({ ...fixture, connection: { ...fixture.connection, endpoint } }).success).toBe(false);
  }
  expect(intelligenceDefinitionSchema.safeParse({ ...fixture, connection: { ...fixture.connection, auth: { ...fixture.connection.auth, credentialRef: "sk-secret-value" } } }).success).toBe(false);
  expect(intelligenceDefinitionSchema.safeParse({ ...fixture, configuration: { ...fixture.configuration, timeoutMs: 600001 } }).success).toBe(false);
  expect(intelligenceSaveSchema.safeParse({ definition: fixture, expectedRevision: null, reason: "" }).success).toBe(false);
  expect(intelligenceSaveSchema.safeParse({ definition: fixture, expectedRevision: null, reason: "test", environment: "production" }).success).toBe(false);
});
it("never treats a complete configuration or native effort as verified execution", () => {
  const definition = intelligenceDefinitionSchema.parse(fixture);
  const checks = intelligenceConfigurationChecks(definition, intelligenceAdapterImplemented(definition));
  expect(checks.filter(check => check.status === "failed")).toEqual([]);
  expect(checks.find(check => check.id === "effort")?.status).toBe("unknown");
  expect(checks.filter(check => check.status === "unknown").map(check => check.id)).toEqual(expect.arrayContaining(["workload_identity", "network", "contract", "activation"]));
  const unsupported = intelligenceDefinitionSchema.parse({ ...fixture, connection: { ...fixture.connection, cloud: "aws", adapterId: "aws_bedrock" } });
  expect(intelligenceAdapterImplemented(unsupported)).toBe(false);
  expect(intelligenceConfigurationChecks(unsupported, false)[0]?.status).toBe("failed");
});
it("requires versioned predictive capability semantics and rejects zero-width score ranges", () => {
  const configuration = { capabilityId: "risk.customer.assess.v1", modelVersion: "7", featureSchemaRef: "features:v2", outputSchemaRef: "score:v1", preprocessingVersion: "2", calibrationVersion: "3", targetDefinition: "Defined event", predictionHorizon: "90 days", scoreMin: 0, scoreMax: 1, scoreDirection: "higher_risk", maxFeatureAgeSeconds: 3600, timeoutMs: 30000, unavailableBehavior: "abstain", validationRef: "validation:7" };
  const inference = { ...fixture, id: "ml.customer_risk", serviceClass: "inference", configuration };
  expect(intelligenceDefinitionSchema.safeParse(inference).success).toBe(true);
  for (const patch of [{ capabilityId: "ml.customer-risk" }, { scoreMax: 0 }, { unavailableBehavior: "zero" }, { maxFeatureAgeSeconds: 0 }]) expect(intelligenceDefinitionSchema.safeParse({ ...inference, configuration: { ...configuration, ...patch } }).success).toBe(false);
});
it("checks transport-specific identity and runtime dispatch authentication without inventing live evidence", () => {
  const missingAudience = intelligenceDefinitionSchema.parse({ ...fixture, connection: { ...fixture.connection, auth: { ...fixture.connection.auth, audience: "" } } });
  expect(intelligenceConfigurationChecks(missingAudience, true).find(check => check.id === "identity")?.status).toBe("failed");
  const configuration = { target: "hosted_http:investigation", agentName: "", agentVersion: "", imageDigest: null, lifecycleEndpoint: null, lifecycleAudience: "", maxConcurrency: 4, timeoutMs: 120000, callbackNetwork: "" };
  const runtime = intelligenceDefinitionSchema.parse({ ...fixture, id: "runtime.investigation", serviceClass: "runtime",
    connection: { ...fixture.connection, cloud: "private", adapterId: "hosted_http", endpoint: "https://runtime.example.com/invocations" }, configuration,
  });
  expect(intelligenceAdapterImplemented(runtime)).toBe(true);
  const checks = intelligenceConfigurationChecks(runtime, true);
  expect(checks.find(check => check.id === "target")?.status).toBe("passed");
  expect(checks.find(check => check.id === "dispatch_auth")?.status).toBe("passed");
  expect(checks.find(check => check.id === "callbacks")?.status).toBe("failed");
  expect(checks.find(check => check.id === "contract")?.status).toBe("unknown");
  expect(checks.map(check => check.id)).not.toEqual(expect.arrayContaining(["revision"]));
  const databricks = intelligenceDefinitionSchema.parse({ ...runtime, connection: { ...runtime.connection, cloud: "databricks", adapterId: "databricks" }, configuration: { ...configuration, target: "databricks:investigation" } });
  expect(intelligenceConfigurationChecks(databricks, true).find(check => check.id === "dispatch_auth")?.status).toBe("failed");
  expect(intelligenceDefinitionSchema.safeParse({ ...fixture, connection: { ...fixture.connection, cloud: "azure" } }).success).toBe(true);
  expect(intelligenceDefinitionSchema.safeParse({ ...fixture, connection: { ...fixture.connection, auth: { ...fixture.connection.auth, mode: "azure_msi" } } }).success).toBe(false);
});
it("checks document provenance and asynchronous provider requirements without claiming execution", () => {
  const definition = intelligenceDefinitionSchema.parse(documentFixture);
  expect(intelligenceAdapterImplemented(definition)).toBe(false);
  const checks = intelligenceConfigurationChecks(definition, false);
  expect(checks.find(check => check.id === "document_contract")?.status).toBe("passed");
  expect(checks.find(check => check.id === "activation")?.status).toBe("unknown");
  const textract = intelligenceDefinitionSchema.parse({ ...documentFixture, connection: { ...documentFixture.connection, cloud: "aws", adapterId: "aws_textract" }, configuration: { ...documentFixture.configuration, executionMode: "synchronous" } });
  expect(intelligenceConfigurationChecks(textract, false).find(check => check.id === "textract_mode")?.status).toBe("failed");
  for (const patch of [{ maxPages: 0 }, { minConfidence: 1.1 }, { provenanceRequired: false }, { unavailableBehavior: "accept" }]) expect(intelligenceDefinitionSchema.safeParse({ ...documentFixture, configuration: { ...documentFixture.configuration, ...patch } }).success).toBe(false);
  expect(intelligenceDefinitionSchema.safeParse({ ...documentFixture, id: "ml.identity" }).success).toBe(false);
});
it("requires bounded System 1 choices and separates structured output from confidence evidence", () => {
  const definition = intelligenceDefinitionSchema.parse(decisionFixture);
  expect(intelligenceConfigurationChecks(definition, false).find(check => check.id === "decision_confidence")?.status).toBe("passed");
  for (const patch of [{ options: ["match"] }, { options: ["match", "match"] }, { confidenceMode: "none" }, { minConfidence: -1 }, { unavailableBehavior: "approve" }]) expect(intelligenceDefinitionSchema.safeParse({ ...decisionFixture, configuration: { ...decisionFixture.configuration, ...patch } }).success).toBe(false);
  const llm = intelligenceDefinitionSchema.parse({ ...decisionFixture, connection: { ...decisionFixture.connection, adapterId: "openai_decision" } });
  expect(intelligenceConfigurationChecks(llm, false).find(check => check.id === "decision_confidence")?.status).toBe("failed");
  expect(intelligenceDefinitionSchema.safeParse({ ...decisionFixture, id: "runtime.routing" }).success).toBe(false);
});

it("supports Foundry models through the installed OpenAI v1 transport without claiming agent-runtime support", () => {
  const azure = intelligenceDefinitionSchema.parse({ ...fixture, connection: { ...fixture.connection, cloud: "azure", adapterId: "azure_foundry", endpoint: "https://models.openai.azure.com/openai/v1/", auth: { ...fixture.connection.auth, mode: "provider_key", credentialRef: "AZURE_MODEL_KEY" } } });
  expect(intelligenceAdapterImplemented(azure)).toBe(true);
  const checks = intelligenceConfigurationChecks(azure, true);
  expect(checks.find(check => check.id === "azure_endpoint")?.status).toBe("passed");
  expect(checks.find(check => check.id === "azure_auth")?.status).toBe("passed");
  expect(checks.find(check => check.id === "activation")?.status).toBe("unknown");
  const project = { ...azure, connection: { ...azure.connection, endpoint: "https://models.services.ai.azure.com/api/projects/example", auth: { ...azure.connection.auth, mode: "workload_identity" as const } } };
  expect(intelligenceConfigurationChecks(project, true).filter(check => ["azure_endpoint", "azure_auth"].includes(check.id)).every(check => check.status === "failed")).toBe(true);
});
