/** A bounded graph over already-authorized packet records. It never retrieves targets. */
export type RecordRelationshipRule = { id: string; source: string; field: string; target: string; label: string; representation: string; multiple: boolean };
export type ContextRecordGraph = {
  scope: "context_packet"; packDigest: string; snapshotDigest: string; asOfTime: string | null; complete: false; truncated: boolean;
  nodes: Array<{ key: string; objectType: string; objectId: string; versionId: string; observedAt: string; fields: string[] }>;
  edges: Array<{ id: string; source: string; target: string; relationId: string; label: string; field: string }>;
  unresolved: Array<{ source: string; relationId: string; field: string; reason: "not_in_packet" | "ambiguous" | "invalid_reference" }>;
};
type InputRecord = { object_type: string; object_id: string; version_id: string; data: Record<string, unknown>; observed_at: string; tenant_id?: unknown };
export function packetRecordGraph(input: { records: InputRecord[]; rules: RecordRelationshipRule[]; tenantId: string; packDigest: string; snapshotDigest: string; asOfTime: string | null }): ContextRecordGraph {
  const key = (r: InputRecord) => JSON.stringify([input.tenantId, r.object_type, r.object_id, r.version_id]);
  const unique = new Map<string, InputRecord>();
  for (const r of input.records) {
    if (r.tenant_id !== undefined && r.tenant_id !== input.tenantId) continue;
    const k = key(r), old = unique.get(k);
    unique.set(k, old ? { ...old, data: { ...old.data, ...r.data } } : r);
  }
  const records = [...unique.values()].slice(0, 200);
  const graph: ContextRecordGraph = { scope: "context_packet", packDigest: input.packDigest, snapshotDigest: input.snapshotDigest, asOfTime: input.asOfTime, complete: false,
    truncated: unique.size > 200, nodes: records.map(r => ({ key: key(r), objectType: r.object_type, objectId: r.object_id, versionId: r.version_id, observedAt: r.observed_at, fields: Object.keys(r.data).sort() })), edges: [], unresolved: [] };
  for (const record of records) for (const rule of input.rules) {
    if (rule.source !== record.object_type || !Object.hasOwn(record.data, rule.field)) continue;
    const raw = record.data[rule.field];
    const values = rule.multiple && Array.isArray(raw) ? raw : [raw];
    for (const value of values) {
      if (graph.edges.length + graph.unresolved.length >= 500) { graph.truncated = true; return graph; }
      if (value === null || value === undefined) continue;
      let matches: InputRecord[] = [];
      let invalid = false;
      if (rule.representation === "exact_ref") {
        const ref = value as Record<string, unknown>;
        invalid = typeof ref !== "object" || !ref || ref.tenant_id !== input.tenantId || ref.object_type !== rule.target || typeof ref.object_id !== "string" || typeof ref.version_id !== "string";
        if (!invalid) matches = records.filter(r => r.object_type === ref.object_type && r.object_id === ref.object_id && r.version_id === ref.version_id);
      } else {
        invalid = typeof value !== "string" || !value;
        if (!invalid) matches = records.filter(r => r.object_type === rule.target && r.object_id === value);
      }
      if (matches.length === 1 && !invalid) {
        const target = key(matches[0]!); const id = JSON.stringify([key(record), rule.id, target]);
        if (!graph.edges.some(e => e.id === id)) graph.edges.push({ id, source: key(record), target, relationId: rule.id, label: rule.label, field: rule.field });
      } else graph.unresolved.push({ source: key(record), relationId: rule.id, field: rule.field, reason: invalid ? "invalid_reference" : matches.length > 1 ? "ambiguous" : "not_in_packet" });
    }
  }
  return graph;
}
