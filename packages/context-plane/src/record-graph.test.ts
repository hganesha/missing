import { expect, it } from "vitest";
import { packetRecordGraph, type RecordRelationshipRule } from "./record-graph.js";
const rules: RecordRelationshipRule[] = [
  { id: "party.entity", source: "Party", field: "entity_id", target: "Entity", label: "represents", representation: "id", multiple: false },
  { id: "fact.evidence", source: "Fact", field: "evidence_refs", target: "Evidence", label: "supported by", representation: "exact_ref", multiple: true },
];
const record = (type: string, id: string, data: Record<string, unknown>, version = "v1") => ({ object_type: type, object_id: id, version_id: version, data, observed_at: "2026-11-09T12:00:00Z" });
const project = (records: ReturnType<typeof record>[]) => packetRecordGraph({ records, rules, tenantId: "tenant_a", packDigest: "p", snapshotDigest: "s", asOfTime: "2026-11-09T12:00:00Z" });
it("resolves only admitted records with typed IDs and exact tenant/version references", () => {
  const graph = project([record("Party", "p1", { entity_id: "e1" }), record("Entity", "e1", { name: "Acme" }),
    record("Evidence", "evidence", {}), record("Fact", "fact", { evidence_refs: [{ tenant_id: "tenant_a", object_type: "Evidence", object_id: "evidence", version_id: "v1" }] })]);
  expect(graph.edges).toHaveLength(2); expect(graph.complete).toBe(false);
  expect(graph.edges.map(e => e.relationId)).toEqual(["party.entity", "fact.evidence"]);
  expect(graph.nodes[0]?.fields).toEqual(["entity_id"]);
});
it("does not fabricate targets or disclose out-of-packet reference identifiers", () => {
  const graph = project([record("Party", "p", { entity_id: "not-visible" }), record("Fact", "f", { evidence_refs: [
    { tenant_id: "foreign", object_type: "Evidence", object_id: "secret-target", version_id: "v1" },
    { tenant_id: "tenant_a", object_type: "Evidence", object_id: "missing-version", version_id: "v2" },
  ] }), record("Evidence", "missing-version", {}, "v1")]);
  expect(graph.edges).toHaveLength(0);
  expect(graph.unresolved.map(u => u.reason)).toEqual(["not_in_packet", "invalid_reference", "not_in_packet"]);
  expect(JSON.stringify(graph)).not.toContain("secret-target");
  expect(JSON.stringify(graph)).not.toContain("not-visible");
});
it("retains version ambiguity, deduplicates projections, and limits graph size", () => {
  const graph = project([record("Party", "p", { entity_id: "entity" }), record("Entity", "entity", { name: "A" }, "v1"), record("Entity", "entity", { name: "B" }, "v2"), record("Party", "p", { role: "customer" })]);
  expect(graph.nodes).toHaveLength(3); expect(graph.edges).toHaveLength(0); expect(graph.unresolved[0]?.reason).toBe("ambiguous");
  const bounded = project(Array.from({ length: 250 }, (_, i) => record("Entity", String(i), {})));
  expect(bounded.nodes).toHaveLength(200); expect(bounded.truncated).toBe(true);
});
