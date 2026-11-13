import { describe, it, expect } from "vitest";
import {
  compileMapping,
  executeMapping,
  stableObjectId,
  evaluateExpression,
} from "./index.js";
import type { CanonicalMapping } from "@ehf/contracts";
const field = (path: string) => ({ op: "field" as const, path });
const entity = { op: "id" as const, namespace: "entity", value: field("key") };
const mapping: CanonicalMapping = {
  kind: "mapping",
  id: "customers",
  name: "Customers",
  productId: "party360",
  resourceId: "crm",
  resourceDigest: "a".repeat(64),
  catalogDigest: "b".repeat(64),
  schemaVersion: "2.0.0",
  subject: entity,
  outputs: [
    {
      objectType: "Entity",
      identity: entity,
      fields: {
        name: { op: "trim", value: field("name") },
        identifiers: field("identifiers"),
        entity_type: {
          op: "lookup",
          value: field("type"),
          values: { P: "individual", C: "company" },
        },
      },
    },
    {
      objectType: "Party",
      identity: { op: "id", namespace: "party", value: field("key") },
      fields: {
        entity_id: entity,
        role: { op: "literal", value: "customer" },
        customer_type: field("segment"),
        profile: { op: "literal", value: {} },
      },
    },
  ],
};
const row = {
  key: "42",
  name: " Customer ",
  identifiers: ["customer:42"],
  type: "P",
  segment: "retail",
};
const now = "2026-11-09T12:00:00Z";
describe("bounded deterministic canonical mapping", () => {
  it("uses one plan across visual/code round trips and resolves related identities", () => {
    expect(compileMapping(mapping).issues).toEqual([]);
    const a = executeMapping(mapping, [row], now),
      b = executeMapping(JSON.parse(JSON.stringify(mapping)), [row], now);
    expect(a).toEqual(b);
    expect(a.candidates).toHaveLength(2);
    expect(a.issues).toEqual([]);
    expect(a.candidates[0]!.data.name).toBe("Customer");
    expect(a.candidates[1]!.data.entity_id).toBe(
      stableObjectId("entity", "42"),
    );
    expect(a.lineage.find((l) => l.field === "name")?.sourcePaths).toEqual([
      "name",
    ]);
  });
  it("rejects an entire related row for unmapped enums while retaining a repair issue", () => {
    const out = executeMapping(
      mapping,
      [row, { ...row, key: "43", type: "X" }],
      now,
    );
    expect(out.acceptedRows).toBe(1);
    expect(out.rejectedRows).toBe(1);
    expect(out.candidates).toHaveLength(2);
    expect(out.issues).toContainEqual(
      expect.objectContaining({
        code: "context.enum_unmapped",
        row: 2,
        field: "entity_type",
      }),
    );
  });
  it("distinguishes duplicates from conflicting source keys", () => {
    const out = executeMapping(
      mapping,
      [row, row, { ...row, name: "Conflicting" }],
      now,
    );
    expect(out.duplicateRecords).toBe(2);
    expect(out.candidates).toHaveLength(2);
    expect(out.rejectedRows).toBe(1);
    expect(out.issues.some((i) => i.code === "context.identity_conflict")).toBe(
      true,
    );
  });
  it("does not qualify incomplete or unknown canonical schemas", () => {
    const partial = structuredClone(mapping);
    delete partial.outputs[0]!.fields.identifiers;
    expect(
      compileMapping(partial).issues.some((i) => i.field === "identifiers"),
    ).toBe(true);
    expect(executeMapping(partial, [row], now).candidates).toHaveLength(0);
    expect(
      compileMapping({ ...mapping, schemaVersion: "1.0.0" }).issues.some(
        (i) => i.code === "context.schema_version_mismatch",
      ),
    ).toBe(true);
  });
  it("rejects unbounded inputs, prototype keys and excessive expression nesting", () => {
    expect(() => executeMapping(mapping, Array(101).fill(row), now)).toThrow(
      "context.sample_limit_exceeded",
    );
    expect(() => compileMapping(JSON.parse('{"__proto__":{}}'))).toThrow(
      "context.mapping_path_invalid",
    );
    let value: unknown = field("name");
    for (let i = 0; i < 30; i++) value = { op: "trim", value };
    expect(() => compileMapping({ ...mapping, subject: value })).toThrow(
      "context.mapping_complexity_exceeded",
    );
  });
});

it("requires timezone-aware valid calendar times instead of normalizing invalid source dates", () => {
  expect(() =>
    evaluateExpression(
      { op: "instant", value: { op: "field", path: "at" } },
      { at: "2026-02-31T12:00:00Z" },
    ),
  ).toThrow("context.instant_invalid");
  expect(() =>
    evaluateExpression(
      { op: "instant", value: { op: "field", path: "at" } },
      { at: "2026-11-09T12:00:00" },
    ),
  ).toThrow("context.timezone_required");
  expect(
    evaluateExpression(
      { op: "instant", value: { op: "field", path: "at" } },
      { at: "2026-11-09T06:00:00-06:00" },
    ),
  ).toBe("2026-11-09T12:00:00.000Z");
});

it("canonicalizes field order so a code reordering cannot change output lineage under one compilation digest", () => {
  const reordered = structuredClone(mapping);
  for (const output of reordered.outputs)
    output.fields = Object.fromEntries(Object.entries(output.fields).reverse());
  expect(executeMapping(reordered, [row], now)).toEqual(
    executeMapping(mapping, [row], now),
  );
});
