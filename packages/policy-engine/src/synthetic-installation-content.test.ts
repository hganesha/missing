import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { INSTALLATION_CONTENT_SCHEMA_VERSION, validateInstallationContent } from "./installation-content.js";

// The skill-policy fields the agentic KYC/KYB effective packs leave UNRESOLVED, except
// permitted_providers: provider permission stays an installation owner's decision.
const FIELDS = ["risk_weights", "risk_tiers", "edd_triggers", "review_interval_seconds", "requirements", "rules", "recommendations",
  "required_document_types", "identifier_rules", "risk_factor_maps", "risk_model_version", "customer_types", "profile_fields",
  "industries", "extensions"] as const;
const CUSTOMER_TYPES = ["individual", "corporate"] as const;
const JURISDICTIONS = ["US", "GB", "AU"] as const;

type Entry = { value: unknown; basis: string };
type Fields = Record<string, Entry>;
type Content = {
  apiVersion: string; kind: string; label: string; owner: string;
  customerTypes: Record<string, { fields: Fields }>;
  jurisdictionOverrides?: Record<string, Record<string, { fields: Fields }>>;
};

const path = fileURLToPath(new URL("../../../domains/policy/synthetic-installation-content.yaml", import.meta.url));
const content = parse(readFileSync(path, "utf8")) as Content;

function effective(customerType: string, jurisdiction: string): Fields {
  return { ...content.customerTypes[customerType]!.fields, ...content.jurisdictionOverrides?.[jurisdiction]?.[customerType]?.fields };
}

describe("synthetic installation content", () => {
  it("is labelled synthetic", () => {
    expect(content.apiVersion).toBe("harness.factory/synthetic-installation-content-v1");
    expect(content.kind).toBe("SyntheticInstallationContent");
    expect(content.label).toBe("SYNTHETIC");
    expect(content.owner).toBe("synthetic.policy.placeholder");
  });

  for (const customerType of CUSTOMER_TYPES) for (const jurisdiction of JURISDICTIONS) {
    it(`resolves every field against the closed Policy contract: ${customerType} ${jurisdiction}`, () => {
      const fields = effective(customerType, jurisdiction);
      expect(Object.keys(fields).sort()).toEqual([...FIELDS].sort());
      const raw = {
        apiVersion: "harness.factory/installation-policy-content-v2",
        requiredFields: [...FIELDS],
        fields: Object.fromEntries(FIELDS.map(field => [field, {
          status: "RESOLVED", owner: content.owner, basis: fields[field]!.basis,
          schemaVersion: INSTALLATION_CONTENT_SCHEMA_VERSION, value: fields[field]!.value,
        }])),
      };
      expect(validateInstallationContent(raw, jurisdiction).unresolved).toEqual([]);
    });
  }

  it("states a SYNTHETIC basis for every value, overrides included", () => {
    const all = [
      ...Object.values(content.customerTypes).flatMap(type => Object.values(type.fields)),
      ...Object.values(content.jurisdictionOverrides ?? {}).flatMap(byType => Object.values(byType).flatMap(type => Object.values(type.fields))),
    ];
    expect(all.length).toBeGreaterThan(0);
    for (const entry of all) expect(entry.basis).toMatch(/^SYNTHETIC/);
  });
});
