import { expect, it } from "vitest";
import { stableDigest, type CanonicalMapping } from "@ehf/contracts";
import { canonicalSchemaMetadata } from "@ehf/library-contracts";
import { compileMapping, executeMapping, evaluateExpression } from "./index.js";
const f = (path: string) => ({ op: "field" as const, path });
const id = (path: string) => ({
  op: "id" as const,
  namespace: "bank.entity",
  value: f(path),
});
const mapping: CanonicalMapping = {
  kind: "mapping",
  id: "ownership",
  name: "Bounded ownership",
  resourceId: "entity",
  resourceDigest: "a".repeat(64),
  catalogDigest: "b".repeat(64),
  schemaVersion: canonicalSchemaMetadata().schemaVersion,
  productId: "ownership.intelligence",
  subject: id("key"),
  outputs: [
    {
      objectType: "Entity",
      identity: id("key"),
      fields: {
        name: f("name"),
        identifiers: { op: "array", items: [f("key")] },
        entity_type: { op: "literal", value: "company" },
      },
    },
    {
      objectType: "Entity",
      collection: "owners",
      identity: id("item.id"),
      fields: {
        name: f("item.name"),
        identifiers: { op: "array", items: [f("item.id")] },
        entity_type: { op: "literal", value: "individual" },
      },
    },
    {
      objectType: "OwnershipInterest",
      collection: "owners",
      identity: { op: "id", namespace: "bank.ownership", value: f("item.id") },
      fields: {
        owner: id("item.id"),
        owned: id("key"),
        interest: { op: "percent_fraction", value: f("item.percent") },
      },
    },
  ],
};
it("expands bounded collections atomically with exact fractions and canonical relationship resolution", () => {
  expect(compileMapping(mapping).issues).toEqual([]);
  const result = executeMapping(
    mapping,
    [
      {
        key: "company",
        name: "Company",
        owners: [{ id: "owner", name: "Person", percent: "25.125" }],
      },
    ],
    "2026-11-09T12:00:00Z",
  );
  expect(result.issues).toEqual([]);
  expect(result.candidates).toHaveLength(3);
  expect(
    result.candidates.find((c) => c.object_type === "OwnershipInterest")?.data
      .interest,
  ).toBe("0.25125");
  expect(
    result.lineage.find((l) => l.field === "interest")?.sourcePaths,
  ).toEqual(["owners.0.percent"]);
  const failed = executeMapping(
    mapping,
    [
      {
        key: "company",
        name: "Company",
        owners: [{ id: "owner", name: "Person", percent: "101" }],
      },
    ],
    "2026-11-09T12:00:00Z",
  );
  expect(failed.candidates).toEqual([]);
  expect(failed.rejectedRows).toBe(1);
  expect(failed.issues.some((i) => i.code === "context.percent_invalid")).toBe(
    true,
  );
});
it("rejects out-of-bundle ownership targets and oversized collections rather than inventing edges", () => {
  const noOwners = {
    ...mapping,
    outputs: mapping.outputs.filter(
      (o) => !(o.objectType === "Entity" && o.collection),
    ),
  };
  expect(
    executeMapping(
      noOwners,
      [
        {
          key: "company",
          name: "Company",
          owners: [{ id: "owner", name: "Person", percent: "25" }],
        },
      ],
      "2026-11-09T12:00:00Z",
    ).issues.some((i) => i.code === "context.reference_unresolved"),
  ).toBe(true);
  expect(
    executeMapping(
      mapping,
      [
        {
          key: "company",
          name: "Company",
          owners: Array(65).fill({ id: "o", name: "Owner", percent: "1" }),
        },
      ],
      "2026-11-09T12:00:00Z",
    ).issues.some((i) => i.code === "context.collection_invalid"),
  ).toBe(true);
});
it("preserves selected source summaries as canonical JSON evidence without qualifying an assessment", () => {
  const summary = { risk: "High", review: "Complete" };
  expect(
    evaluateExpression(
      { op: "json", value: { op: "object", fields: { risk: f("risk") } } },
      summary,
    ),
  ).toBe('{"risk":"High"}');
  for (const [input, expected] of [
    ["0", "0"],
    ["100", "1"],
    ["0.001", "0.00001"],
    ["25.00", "0.25"],
  ])
    expect(
      evaluateExpression(
        { op: "percent_fraction", value: f("v") },
        { v: input },
      ),
    ).toBe(expected);
  expect(stableDigest(summary)).toHaveLength(64);
});
