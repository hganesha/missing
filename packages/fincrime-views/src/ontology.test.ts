import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { validateResponse } from "@ehf/ui-contracts/validate";
import { contextOntologyView, ontologyNeighborhood, ontologyFields, type OntologyMetadata, type RelationshipCatalog } from "./ontology.js";
import type { ContextCatalogSource } from "./context.js";
const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const ontology = read("../../library-contracts/src/vendor/ontology.schema.json");
const lock = read("../../library-contracts/src/vendor/lock.json");
const relations = read("../../library-contracts/src/vendor/context-relationships.json") as RelationshipCatalog;
const artifact = read("../../../apps/fincrime-host/catalog/ehf-catalog.json");
const source: ContextCatalogSource = { ...JSON.parse(artifact.content), catalogDigest: artifact.sha256 };
const metadata: OntologyMetadata = { schemaVersion: lock.context_schema_version, lock, objectTypes: ontology["x-context-types"], definitions: ontology.$defs };
const sign = (v: RelationshipCatalog) => { const { digest: _, ...payload } = v; const stable = (x: any): any => Array.isArray(x) ? x.map(stable) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().map(k => [k, stable(x[k])])) : x; return { ...payload, digest: createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex") }; };
it("projects the real closed ontology with valid contract, stable pins and no invented links", async () => {
  const view = await contextOntologyView(source, metadata, relations);
  expect(view.nodes).toHaveLength(89);
  expect(view.edges).toHaveLength(34);
  expect(validateResponse("getFincrimeContextOntology", 200, view)).toMatchObject({ valid: true });
  expect(view.nodes.some(n => n.id === "Id" || n.id === "Customer")).toBe(false);
  expect(view.edges.some(e => e.source === "Account" && e.target === "Product")).toBe(false);
  expect(view.edges.some(e => e.source === "Transaction")).toBe(false);
  expect(view.nodes.find(n => n.id === "Transaction")?.fields.find(f => f.path === "amount")?.constraints).toContainEqual(expect.stringContaining("pattern:"));
  expect((await contextOntologyView(source, metadata, relations)).projectionDigest).toBe(view.projectionDigest);
  const focus = ontologyNeighborhood(view, "party360");
  expect(focus.nodes.some(n => n.id === "Entity")).toBe(true);
  expect(focus.seeds.has("Entity")).toBe(false);
  expect(focus.edges.some(e => e.source === "Party" && e.target === "Entity")).toBe(true);
});
it("rejects mismatched versions and tampered or invalid relationship definitions", async () => {
  await expect(contextOntologyView({ ...source, contextSchemaVersion: "0.0.0" }, metadata, relations)).rejects.toThrow("context.ontology_version_mismatch");
  await expect(contextOntologyView(source, metadata, { ...relations, version: "tampered" })).rejects.toThrow("context.relationship_digest_mismatch");
  const broken = structuredClone(relations); broken.relationships[0]!.field = "unknown";
  await expect(contextOntologyView(source, metadata, sign(broken))).rejects.toThrow("context.relationship_invalid");
  const badCatalog = structuredClone(source); badCatalog.contextProducts[0] = { id: "bad", objects: { Entity: ["nonexistent"] } };
  await expect(contextOntologyView(badCatalog, metadata, relations)).rejects.toThrow("context.ontology_catalog_mismatch");
});
it("preserves nested optionality, enums, nullable fields and bounds recursive definitions", () => {
  const fields = ontologyFields({ properties: { value: { anyOf: [{ $ref: "#/$defs/Nested" }, { type: "null" }] }, recursive: { $ref: "#/$defs/Recursive" } }, required: ["value"] }, {
    Nested: { type: "object", properties: { state: { enum: ["A", "B"] } }, required: ["state"] },
    Recursive: { type: "object", properties: { child: { $ref: "#/$defs/Recursive" } } },
  });
  expect(fields.find(f => f.path === "value")).toMatchObject({ required: true, nullable: true });
  expect(fields.find(f => f.path === "value.state")).toMatchObject({ values: ["A", "B"], depth: 1, required: true });
  expect(fields.length).toBeLessThan(10);
});
