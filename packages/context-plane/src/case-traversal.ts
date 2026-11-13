import { stableDigest, type CanonicalRecord, type CaseTraversalGraph, type CaseTraversalQuery, type CaseTraversalNode } from "@ehf/contracts";
export type TraversalRule = { id: string; source: string; target: string; field: string; label: string; multiple: boolean; representation: string };
const key = (r: CanonicalRecord) => JSON.stringify([r.tenant_id, r.object_type, r.object_id, r.version_id]);
const node = (r: CanonicalRecord): CaseTraversalNode => ({ key: key(r), objectType: r.object_type, objectId: r.object_id, versionId: r.version_id, classification: r.classification,
  subjectIds: r.subject_ids ?? [], observedAt: r.observed_at, recordedAt: r.recorded_at, validFrom: r.valid_from ?? null, validTo: r.valid_to ?? null, data: r.data });
/** Traverse only the authorized projection. No resolver can fetch a hidden endpoint. */
export function traverseCaseRecords(records: CanonicalRecord[], rules: TraversalRule[], query: CaseTraversalQuery, offset = 0) {
  const sorted = [...records].sort((a, b) => key(a).localeCompare(key(b)));
  const root = query.root ? sorted.find(r => r.object_type === query.root!.objectType && r.object_id === query.root!.objectId && (!query.root!.versionId || r.version_id === query.root!.versionId)) : sorted.find(r => r.object_type === "Entity") ?? sorted[0];
  if (query.root && !root) throw new Error("context.traversal_root_unavailable");
  const byTypeId = new Map<string, CanonicalRecord[]>();
  for (const r of sorted) { const k = JSON.stringify([r.object_type, r.object_id]); byTypeId.set(k, [...(byTypeId.get(k) ?? []), r]); }
  const edges: CaseTraversalGraph["edges"] = [], unresolved: CaseTraversalGraph["unresolved"] = [];
  let truncated = false;
  for (const r of sorted) for (const rule of rules) {
    if (r.object_type !== rule.source || !Object.hasOwn(r.data, rule.field)) continue;
    const raw = r.data[rule.field];
    for (const value of rule.multiple && Array.isArray(raw) ? raw : [raw]) {
      if (value == null) continue;
      if (edges.length + unresolved.length >= 10000) { truncated = true; break; }
      let invalid = rule.multiple && !Array.isArray(raw);
      let targets: CanonicalRecord[] = [];
      if (rule.representation === "exact_ref") {
        const ref = value as Record<string, unknown>;
        invalid ||= !ref || typeof ref !== "object" || ref.tenant_id !== r.tenant_id || ref.object_type !== rule.target || typeof ref.object_id !== "string" || typeof ref.version_id !== "string";
        if (!invalid) targets = (byTypeId.get(JSON.stringify([rule.target, ref.object_id])) ?? []).filter(t => t.version_id === ref.version_id && (!ref.schema_version || t.schema_version === ref.schema_version));
      } else {
        invalid ||= typeof value !== "string";
        if (!invalid) targets = byTypeId.get(JSON.stringify([rule.target, value])) ?? [];
      }
      if (!invalid && targets.length === 1) {
        const target = key(targets[0]!); const id = stableDigest([key(r), rule.id, target]);
        if (!edges.some(e => e.id === id)) edges.push({ id, source: key(r), target, relationId: rule.id, label: rule.label, field: rule.field });
      } else unresolved.push({ source: key(r), relationId: rule.id, field: rule.field, reason: invalid ? "invalid_reference" : targets.length > 1 ? "ambiguous" : "not_visible_or_unresolved" });
    }
  }
  const visited = new Map<string, number>(); const queue = root ? [key(root)] : [];
  if (root) visited.set(key(root), 0);
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i]!, depth = visited.get(current)!;
    if (depth >= query.maxDepth) continue;
    const adjacent = edges.flatMap(e => [
      ...(e.source === current && query.direction !== "incoming" ? [e.target] : []),
      ...(e.target === current && query.direction !== "outgoing" ? [e.source] : []),
    ]).sort();
    for (const next of adjacent) if (!visited.has(next)) {
      if (queue.length >= 500) { truncated = true; break; }
      visited.set(next, depth + 1); queue.push(next);
    }
  }
  const end = Math.min(queue.length, offset + query.pageSize);
  const map = new Map(sorted.map(r => [key(r), r]));
  let pageNodes = queue.slice(offset, end).map(k => node(map.get(k)!));
  // Bound response bytes as well as count; an oversized single record needs narrower fields.
  while (Buffer.byteLength(JSON.stringify(pageNodes)) > 200_000 && pageNodes.length > 1) pageNodes.pop();
  if (Buffer.byteLength(JSON.stringify(pageNodes)) > 200_000) throw new Error("context.traversal_record_too_large");
  const actualEnd = offset + pageNodes.length; const actualPage = new Set(pageNodes.map(n => n.key));
  const actualAdmitted = new Set(queue.slice(0, actualEnd));
  const pageEdges = edges.filter(e => actualAdmitted.has(e.source) && actualAdmitted.has(e.target) && (actualPage.has(e.source) || actualPage.has(e.target)));
  if (pageEdges.length > 1000) { pageEdges.length = 1000; truncated = true; }
  const pageUnresolved = unresolved.filter(u => actualPage.has(u.source)).slice(0, 500);
  if (unresolved.filter(u => actualPage.has(u.source)).length > 500) truncated = true;
  // IDs and labels are data too; count limits alone do not bound the wire size.
  while (Buffer.byteLength(JSON.stringify(pageEdges)) > 150_000) { pageEdges.pop(); truncated = true; }
  while (Buffer.byteLength(JSON.stringify(pageUnresolved)) > 50_000) { pageUnresolved.pop(); truncated = true; }
  return { root: root ? node(root) : null, nodes: pageNodes, edges: pageEdges, unresolved: pageUnresolved, offset: actualEnd, hasMore: actualEnd < queue.length, truncated };
}
