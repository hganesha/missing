import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalCapabilityIdSchema, capabilityRegistrationSchema, stableDigest } from "@ehf/contracts";

describe("capability placeholder migration", () => {
  it("seeds all planned integration families as digest-valid drafts", () => {
    const migration = readFileSync(new URL("../migrations/015_capability_contract_placeholders.sql", import.meta.url), "utf8");
    const definitions = [...migration.matchAll(/'(\{"id":[^']+\})'::jsonb,\s*'([a-f0-9]{64})'/g)]
      .map((match) => ({ capability: capabilityRegistrationSchema.parse(JSON.parse(match[1]!)), digest: match[2]! }));

    expect(definitions.map((item) => item.capability.id)).toEqual([
      "identity.document.verify.v1",
      "identity.ocr.extract.v1",
      "screening.adverse-media.search.v1",
      "customer.internal.search.v1",
      "knowledge.vector.search.v1",
      "integration.apim.approved-operation.v1",
    ]);
    definitions.forEach(({ capability, digest }) => {
      expect(capability.status).toBe("draft");
      expect(capability.adapterBindingId).toMatch(/^unconfigured:/);
      expect(stableDigest(capability)).toBe(digest);
    });
  });
});

describe("cloud-neutral migration", () => {
  it("replaces vendor-named contracts with digest-valid neutral ones and drops removed adapters", () => {
    const migration = readFileSync(new URL("../migrations/041_cloud_neutral.sql", import.meta.url), "utf8");
    const definitions = [...migration.matchAll(/'(\{"id":[^']+\})'::jsonb,\s*(?:definition_digest = )?'([a-f0-9]{64})'/g)]
      .map((match) => ({ capability: capabilityRegistrationSchema.parse(JSON.parse(match[1]!)), digest: match[2]! }));
    expect(definitions.map((item) => [item.capability.id, item.capability.status])).toEqual([
      ["knowledge.vector.search.v1", "active"],
      ["integration.apim.operation.v1", "deprecated"],
      ["integration.http.operation.v1", "draft"],
    ]);
    definitions.forEach(({ capability, digest }) => expect(stableDigest(capability)).toBe(digest));
    expect(definitions[0]!.capability.description).not.toMatch(/azure/i);
    expect(migration).toMatch(/delete from harness_gateway\.connector_registry\s+where adapter_id in \('azure-openai', 'foundry-agent', 'azure-search', 'apim'\)/);
  });
});

describe("connector registry migration", () => {
  it("deprecates the non-canonical placeholders and seeds digest-valid canonical equivalents", () => {
    const migration = readFileSync(new URL("../migrations/030_connector_registry.sql", import.meta.url), "utf8");
    const definitions = [...migration.matchAll(/'(\{"id":[^']+\})'::jsonb,\s*(?:definition_digest = )?'([a-f0-9]{64})'/g)]
      .map((match) => ({ capability: capabilityRegistrationSchema.parse(JSON.parse(match[1]!)), digest: match[2]! }));

    expect(definitions.map((item) => [item.capability.id, item.capability.status])).toEqual([
      ["screening.adverse_media.v1", "draft"],
      ["integration.apim.operation.v1", "draft"],
      ["screening.adverse-media.search.v1", "deprecated"],
      ["integration.apim.approved-operation.v1", "deprecated"],
    ]);
    definitions.forEach(({ capability, digest }) => {
      expect(stableDigest(capability)).toBe(digest);
      expect(canonicalCapabilityIdSchema.safeParse(capability.id).success).toBe(capability.status === "draft");
    });
  });
});
