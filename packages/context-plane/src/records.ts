import { canonicalRecordObjectType, type ContextSelector, type HarnessPlanV2 } from "@ehf/contracts";

/**
 * Canonical-record sections (docs/implementation/canonical-records.md).
 *
 * A record selector (`path: records.<ObjectType>` with a `record` requirement) is the
 * skill library's `Requirement`: object type, fields, minimum count and maximum age. The case
 * store has already applied bitemporal selection and field projection; this applies the
 * library's admission rules to what came back, exactly as its context compiler does:
 *
 * - a record missing a required field (absent or null) is excluded and reported
 *   (`CONTEXT_MISSING`, per object);
 * - a record older than `maxAgeSeconds` at the as-of time (or observed after it) is excluded
 *   and reported (`CONTEXT_STALE`, per object);
 * - fewer included records than `minCount` is `CONTEXT_MISSING` for the selector.
 *
 * A gap on a required selector means the skill is not called: the platform answers
 * NEEDS_EVIDENCE with the gap instead (skill.execution.v1 §3 step 2).
 */

export type RecordContextGap = {
  selector: string;
  objectType: string;
  code: "CONTEXT_MISSING" | "CONTEXT_STALE";
  required: boolean;
  /** The record (object id) the gap is about; absent for a selector-level gap. */
  objectId?: string;
  subjectId?: string;
  fields?: string[];
  found?: number;
  minCount?: number;
  explanation: string;
};

export type SelectedRecord = {
  object_type: string;
  object_id: string;
  version_id: string;
  data: Record<string, unknown>;
  observed_at: string;
  [key: string]: unknown;
};

export type RecordSectionSelection = { records: SelectedRecord[]; gaps: RecordContextGap[] };

function asRecords(value: unknown): SelectedRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is SelectedRecord => Boolean(item) && typeof item === "object"
    && typeof (item as SelectedRecord).object_id === "string" && typeof (item as SelectedRecord).observed_at === "string"
    && Boolean((item as SelectedRecord).data) && typeof (item as SelectedRecord).data === "object");
}

export function isRecordSelector(selector: Pick<ContextSelector, "path" | "record">): boolean {
  return canonicalRecordObjectType(selector) !== null;
}

/** Apply one record selector's requirement to the projected records it returned. */
export function selectRecordSection(selector: ContextSelector, value: unknown, asOfTime: string, subjectIds: readonly string[] = []): RecordSectionSelection {
  const objectType = canonicalRecordObjectType(selector);
  if (!objectType) throw new Error(`context.record_selector_invalid:${selector.id}`);
  const requirement = selector.record ?? { objectType, fields: [], minCount: selector.required ? 1 : 0, maxAgeSeconds: null };
  const asOf = Date.parse(asOfTime);
  if (!Number.isFinite(asOf)) throw new Error("context.record_as_of_invalid");
  const gaps: RecordContextGap[] = [];
  const records: SelectedRecord[] = [];
  for (const record of asRecords(value)) {
    if (record.object_type !== objectType) continue;
    const nullable = new Set("nullableFields" in requirement ? requirement.nullableFields ?? [] : []);
    const missing = requirement.fields.filter((field) => !nullable.has(field) && (record.data[field] === undefined || record.data[field] === null));
    if (missing.length) {
      gaps.push({ selector: selector.id, objectType, code: "CONTEXT_MISSING", required: selector.required, objectId: record.object_id, fields: missing,
        explanation: `${objectType} ${record.object_id} lacks ${missing.join(", ")}.` });
      continue;
    }
    if (requirement.maxAgeSeconds !== null) {
      const age = (asOf - Date.parse(record.observed_at)) / 1000;
      if (!Number.isFinite(age) || age > requirement.maxAgeSeconds || age < 0) {
        gaps.push({ selector: selector.id, objectType, code: "CONTEXT_STALE", required: selector.required, objectId: record.object_id,
          explanation: `${objectType} ${record.object_id} was observed ${Number.isFinite(age) ? `${Math.round(age)}s` : "at an unknown time"} before the as-of time; the limit is ${requirement.maxAgeSeconds}s.` });
        continue;
      }
    }
    records.push(record);
  }
  if (records.length < requirement.minCount) {
    gaps.push({ selector: selector.id, objectType, code: "CONTEXT_MISSING", required: selector.required, found: records.length, minCount: requirement.minCount,
      explanation: `${records.length} usable ${objectType} record(s); at least ${requirement.minCount} required.` });
  }
  for (const subjectId of new Set(subjectIds)) {
    const found = records.filter(record => Array.isArray(record.subject_ids) && record.subject_ids.includes(subjectId)).length;
    if (found < requirement.minCount) gaps.push({ selector: selector.id, objectType, code: "CONTEXT_MISSING", required: selector.required, subjectId, found, minCount: requirement.minCount,
      explanation: `${subjectId} has ${found} usable ${objectType} record(s); at least ${requirement.minCount} required for this subject.` });
  }
  return { records, gaps };
}

/**
 * Record sections and gaps for every record selector of a node, keyed by selector id. Only
 * selectors present in `selection` are evaluated; an absent one is reported as missing.
 */
export function selectNodeRecords(
  plan: HarnessPlanV2,
  nodeId: string,
  selection: Readonly<Record<string, unknown>> | undefined,
  asOfTime: string,
): { sections: Map<string, SelectedRecord[]>; gaps: RecordContextGap[] } {
  const node = plan.graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`context.node_missing:${nodeId}`);
  const selectors = new Map(plan.contextSelectors.map((selector) => [selector.id, selector]));
  const sections = new Map<string, SelectedRecord[]>();
  const gaps: RecordContextGap[] = [];
  for (const selectorId of node.contextSelectorIds) {
    const selector = selectors.get(selectorId);
    if (!selector || !isRecordSelector(selector)) continue;
    const result = selectRecordSection(selector, selection?.[selectorId], asOfTime);
    sections.set(selectorId, result.records);
    gaps.push(...result.gaps);
  }
  return { sections, gaps };
}

/** Whether any required record selector of the node has a gap (the skill must not run). */
export function blockingRecordGaps(gaps: readonly RecordContextGap[]): RecordContextGap[] {
  return gaps.filter((gap) => gap.required);
}

/** `skill.execution.v1` `context.missing` entries: one per selector and code. */
export function recordGapsAsMissing(gaps: readonly RecordContextGap[]): Array<{ selector: string; code: "CONTEXT_MISSING" | "CONTEXT_STALE"; required: boolean }> {
  const seen = new Map<string, { selector: string; code: "CONTEXT_MISSING" | "CONTEXT_STALE"; required: boolean }>();
  for (const gap of gaps) {
    const key = `${gap.selector}\u0000${gap.code}`;
    if (!seen.has(key)) seen.set(key, { selector: gap.selector, code: gap.code, required: gap.required });
  }
  return [...seen.values()];
}
