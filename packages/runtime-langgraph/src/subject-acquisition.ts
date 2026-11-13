import { z } from "zod";

const configSchema = z.object({ subjectsSelector: z.string(), entitiesSelector: z.string().optional(), maxSubjects: z.number().int().min(1).max(100) }).strict();
type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const rows = (value: unknown): Row[] => Array.isArray(value) ? value.map(object) : [];
const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : undefined;

/** A bounded, stable per-subject acquisition scope; never silently select subjects[0]. */
export function acquisitionSubjects(rawConfig: unknown, selection: Readonly<Record<string, unknown>>): Row[] {
  const config = configSchema.parse(rawConfig);
  const byId = new Map<string, Row>();
  const add = (id: string | undefined, name: string | undefined, attributes: Row, individual: boolean) => {
    if (!id || !name) throw new Error("runtime.subject_scope_identity_missing");
    const candidate = { subjectId: id, name, schema: individual ? "Person" : "Company",
      ...(text(attributes.country) ? { country: attributes.country } : {}),
      ...(text(attributes.dateOfBirth) ? { dateOfBirth: attributes.dateOfBirth } : {}) };
    const prior = byId.get(id);
    if (prior && prior.name !== name) throw new Error("runtime.subject_scope_identity_conflict");
    if (!prior) byId.set(id, candidate);
  };
  for (const subject of rows(selection[config.subjectsSelector])) {
    add(text(subject.subject_id ?? subject.subjectId), text(subject.display_name ?? subject.displayName), object(subject.attributes),
      (subject.subject_type ?? subject.subjectType ?? object(subject.attributes).customerType) === "individual");
  }
  if (config.entitiesSelector) for (const record of rows(selection[config.entitiesSelector])) {
    const data = object(record.data);
    add(text(record.object_id), text(data.name), object(data.attributes), data.entity_type === "individual");
  }
  if (!byId.size) throw new Error("runtime.subject_scope_empty");
  if (byId.size > config.maxSubjects) throw new Error("runtime.subject_scope_budget_exceeded");
  return [...byId.values()].sort((a, b) => String(a.subjectId) < String(b.subjectId) ? -1 : String(a.subjectId) > String(b.subjectId) ? 1 : 0);
}

export async function acquireSubjects(config: unknown, selection: Readonly<Record<string, unknown>>, invoke: (input: Row, index: number) => Promise<unknown>) {
  const subjects = acquisitionSubjects(config, selection);
  const results: Row[] = [];
  const failures: string[] = [];
  for (const [index, subject] of subjects.entries()) {
    try {
      const output = object(await invoke(subject, index));
      results.push({ subjectId: subject.subjectId, output });
      if (output.recordGap || output.status === "ERROR" || output.status === "UNKNOWN") failures.push(String(subject.subjectId));
    } catch {
      // Keep partial successes and an explicit gap; an outage cannot shrink the scope.
      failures.push(String(subject.subjectId));
      results.push({ subjectId: subject.subjectId, output: { status: "ERROR" } });
    }
  }
  const outputs = results.map((r) => object(r.output));
  const records = new Map<string, Row>();
  for (const output of outputs) for (const record of rows(output.records)) {
    records.set(JSON.stringify([record.object_type, record.object_id, record.version_id]), record);
  }
  // Canonical record commands have a bound of 200. Never drop the rest of a large scope.
  if (records.size > 200) throw new Error("runtime.subject_scope_record_budget_exceeded");
  return {
    status: failures.length ? "PARTIAL" : "OK", subjectResults: results,
    records: [...records.values()], alerts: outputs.flatMap((o) => Array.isArray(o.alerts) ? o.alerts : []),
    outcome: failures.length ? "inconclusive" : outputs.some((o) => ["review", "failed"].includes(String(o.outcome)) || rows(o.alerts).length) ? "review" : "passed",
    recordGap: failures.length ? { code: "EVIDENCE_GAP", reason: `Acquisition incomplete for ${failures.length} of ${subjects.length} required subjects.`, outcome: "inconclusive" } : null,
  };
}
