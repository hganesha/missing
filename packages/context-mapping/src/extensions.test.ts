import { describe, it, expect } from "vitest";
import { stableDigest } from "@ehf/contracts";
import {
  compileMapping,
  evaluateExpression,
  createContextMappingTemplate,
  CONTEXT_MAPPING_TEMPLATES,
} from "./index.js";
import {
  canonicalSchemaMetadata,
  validateRecordData,
  LIBRARY_CONTEXT_TYPES,
} from "@ehf/library-contracts";
const f = (path: string) => ({ op: "field" as const, path });
describe("mapping extensions", () => {
  it("handles fallbacks, composition and strict typed conversions deterministically", () => {
    expect(
      evaluateExpression(
        { op: "coalesce", values: [f("missing"), f("empty"), f("name")] },
        { empty: "", name: "Acme" },
      ),
    ).toBe("Acme");
    expect(
      evaluateExpression(
        { op: "concat", values: [f("first"), f("last")], separator: " " },
        { first: "A", last: "B" },
      ),
    ).toBe("A B");
    expect(
      evaluateExpression({ op: "boolean", value: f("v") }, { v: "false" }),
    ).toBe(false);
    expect(() =>
      evaluateExpression({ op: "boolean", value: f("v") }, { v: "yes" }),
    ).toThrow("boolean_invalid");
    expect(() =>
      evaluateExpression(
        { op: "integer", value: f("v") },
        { v: "9007199254740993" },
      ),
    ).toThrow("integer_invalid");
    expect(
      evaluateExpression({ op: "date", value: f("v") }, { v: "2024-02-29" }),
    ).toBe("2024-02-29");
    expect(() =>
      evaluateExpression({ op: "date", value: f("v") }, { v: "2025-02-29" }),
    ).toThrow("instant_invalid");
    expect(
      evaluateExpression(
        { op: "split", value: f("v"), separator: "," },
        { v: "a, b" },
      ),
    ).toEqual(["a", "b"]);
  });
  it("pins reviewed crosswalk values and rejects absent or changed keys", () => {
    const values = { crm42: "canonical:customer42" },
      rule = {
        op: "crosswalk" as const,
        value: f("key"),
        values,
        reviewedBy: "reviewer",
        revision: stableDigest(values),
      };
    expect(evaluateExpression(rule, { key: "crm42" })).toBe(
      "canonical:customer42",
    );
    expect(() => evaluateExpression(rule, { key: "unknown" })).toThrow(
      "crosswalk_unresolved",
    );
    expect(() =>
      evaluateExpression(
        { ...rule, values: { crm42: "other" } },
        { key: "crm42" },
      ),
    ).toThrow("crosswalk_revision_mismatch");
  });
  it("exposes platform application contracts and templates without granting library consumption", () => {
    const base = {
      kind: "mapping" as const,
      id: "test",
      name: "Template",
      productId: "test",
      resourceId: "r",
      resourceDigest: "a".repeat(64),
      catalogDigest: "b".repeat(64),
      schemaVersion: canonicalSchemaMetadata().schemaVersion,
    };
    for (const template of CONTEXT_MAPPING_TEMPLATES)
      expect(
        compileMapping(
          createContextMappingTemplate(template, base, "source", "key"),
        ).issues,
      ).toEqual([]);
    expect(canonicalSchemaMetadata().objectTypes).toContain("Application");
    expect(LIBRARY_CONTEXT_TYPES).not.toContain("Application");
    expect(validateRecordData("Application", {})).toMatchObject({
      valid: false,
      contract: "platform",
    });
  });
});
