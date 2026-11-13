import { expect, it } from "vitest";
import type { CanonicalRecord } from "@ehf/contracts";
import { traverseCaseRecords, type TraversalRule } from "./case-traversal.js";
const row = (type: string, id: string, data: Record<string, unknown>, version = "v1") => ({ tenant_id: "tenant", case_id: "case", object_type: type, object_id: id, version_id: version, schema_version: "2.0.0", data,
  classification: "CONFIDENTIAL", subject_ids: ["subject"], purposes: ["review"], observed_at: "2026-11-09T12:00:00Z", recorded_at: "2026-11-09T12:00:00Z", source_refs: [], synthetic: false, provenance: { method: "manual_entry" } } as unknown as CanonicalRecord);
const rules: TraversalRule[] = [{ id: "party.entity", source: "Party", target: "Entity", field: "entity_id", label: "represents", representation: "id", multiple: false }, { id: "fact.evidence", source: "Fact", target: "Evidence", field: "refs", label: "supports", representation: "exact_ref", multiple: true }];
const query = { direction: "both" as const, pageSize: 1, maxDepth: 2, root: { objectType: "Entity", objectId: "entity" } };
it("walks incoming/outgoing relationships with deterministic cursor pages and no duplicate nodes", () => {
  const records = [row("Entity", "entity", {}), row("Party", "party", { entity_id: "entity" })];
  const first = traverseCaseRecords(records, rules, query); const next = traverseCaseRecords(records, rules, query, first.offset);
  expect(first.nodes.map(n => n.objectId)).toEqual(["entity"]); expect(first.hasMore).toBe(true);
  expect(next.nodes.map(n => n.objectId)).toEqual(["party"]); expect(next.edges).toHaveLength(1); expect(next.hasMore).toBe(false);
  expect(traverseCaseRecords(records, rules, { ...query, direction: "outgoing" }).hasMore).toBe(false);
  expect(traverseCaseRecords(records, rules, { ...query, maxDepth: 0 }).nodes).toHaveLength(1);
});
it("does not manufacture invisible endpoints or substitute an exact version", () => {
  const records = [row("Party", "p", { entity_id: "private-id" }), row("Fact", "fact", { refs: [{ tenant_id: "tenant", object_type: "Evidence", object_id: "ev", version_id: "old" }] }), row("Evidence", "ev", {})];
  const graph = traverseCaseRecords(records, rules, { ...query, root: { objectType: "Party", objectId: "p" } });
  expect(graph.edges).toEqual([]); expect(graph.unresolved[0]?.reason).toBe("not_visible_or_unresolved");
  expect(JSON.stringify(graph.unresolved)).not.toContain("private-id");
  const fact = traverseCaseRecords(records, rules, { ...query, root: { objectType: "Fact", objectId: "fact" } });
  expect(fact.edges).toEqual([]);
  expect(() => traverseCaseRecords(records, rules, { ...query, root: { objectType: "Entity", objectId: "hidden" } })).toThrow("context.traversal_root_unavailable");
});
it("bounds cycles, node count and malformed/foreign references", () => {
  const many = Array.from({ length: 550 }, (_, i) => row("Party", String(i), { entity_id: "entity" }));
  const graph = traverseCaseRecords([row("Entity", "entity", {}), ...many], rules, { ...query, pageSize: 50 });
  expect(graph.truncated).toBe(true);
  const invalid = traverseCaseRecords([row("Fact", "f", { refs: [{ tenant_id: "foreign", object_type: "Evidence", object_id: "e", version_id: "v1" }] }), row("Evidence", "e", {})], rules, { ...query, root: { objectType: "Fact", objectId: "f" } });
  expect(invalid.unresolved[0]?.reason).toBe("invalid_reference");
});
it("bounds payload bytes and marks relationship loss explicitly", () => {
  const largeRules = [{ ...rules[0]!, label: "r".repeat(10000) }];
  const graph = traverseCaseRecords([row("Entity", "entity", {}), ...Array.from({ length: 49 }, (_, i) => row("Party", `p${i}`, { entity_id: "entity" }))], largeRules, { ...query, pageSize: 50 });
  expect(graph.truncated).toBe(true); expect(Buffer.byteLength(JSON.stringify(graph.edges))).toBeLessThanOrEqual(150000);
  expect(() => traverseCaseRecords([row("Entity", "entity", { content: "x".repeat(210000) })], rules, query)).toThrow("context.traversal_record_too_large");
});
