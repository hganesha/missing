import { canonicalMappingSchema } from "@ehf/contracts/context-setup";
import {
  canonicalRecordInputSchema,
  canonicalJson,
  stableDigest,
  type CanonicalMapping,
  type ContextCandidate,
  type ContextMappingIssue,
  type MappingExpression,
} from "@ehf/contracts";
import {
  canonicalSchemaMetadata,
  canonicalRelationships,
  LIBRARY_CONTEXT_SCHEMA_VERSION,
  validateRecordData,
} from "@ehf/library-contracts";
export const MAPPING_COMPILER_VERSION = "context-mapping.v3";
const unsafe = new Set(["__proto__", "prototype", "constructor"]);
function guard(value: unknown, depth = 0, count = { value: 0 }): void {
  if (depth > 20 || ++count.value > 50000)
    throw new Error("context.mapping_complexity_exceeded");
  if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value)) {
      if (unsafe.has(key)) throw new Error("context.mapping_path_invalid");
      guard(child, depth + 1, count);
    }
}
/** Apply before recursive contract parsing at service boundaries. */
export function assertBoundedContextInput(value: unknown): void {
  guard(value);
}
export function stableObjectId(namespace: string, key: unknown): string {
  if (
    (typeof key !== "string" && typeof key !== "number") ||
    String(key).trim() === ""
  )
    throw new Error("context.identity_missing");
  return `${namespace}:${stableDigest(String(key)).slice(0, 40)}`;
}
function sourcePaths(
  e: MappingExpression,
  row?: Record<string, unknown>,
): string[] {
  if (e.op === "field") return [e.path];
  if (e.op === "object")
    return Object.values(e.fields).flatMap((child) => sourcePaths(child, row));
  if (e.op === "array")
    return e.items.flatMap((child) => sourcePaths(child, row));
  if (e.op === "coalesce" && row) {
    const chosen = e.values.find((child) => {
      const value = evaluateExpression(child, row);
      return value !== undefined && value !== null && value !== "";
    });
    return chosen ? sourcePaths(chosen, row) : [];
  }
  if (e.op === "coalesce" || e.op === "concat")
    return e.values.flatMap((child) => sourcePaths(child, row));
  return e.op === "literal" ? [] : sourcePaths(e.value, row);
}
export function compileMapping(raw: unknown) {
  guard(raw);
  const mapping = JSON.parse(
    canonicalJson(canonicalMappingSchema.parse(raw)),
  ) as CanonicalMapping;
  const issues: ContextMappingIssue[] = [];
  const metadata = canonicalSchemaMetadata();
  const checkCrosswalk = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const e = value as Record<string, unknown>;
    if (e.op === "crosswalk" && stableDigest(e.values) !== e.revision)
      issues.push({
        code: "context.crosswalk_revision_mismatch",
        row: null,
        objectType: null,
        field: null,
        message: "Crosswalk values changed after review.",
        action: "Review and seal the new value map.",
      });
    for (const child of Object.values(e)) checkCrosswalk(child);
  };
  checkCrosswalk(mapping);

  if (mapping.schemaVersion !== LIBRARY_CONTEXT_SCHEMA_VERSION)
    issues.push({
      code: "context.schema_version_mismatch",
      row: null,
      objectType: null,
      field: null,
      message: "Mapping schema differs from the pinned canonical schema.",
      action: "Update the schema pin and re-test.",
    });
  if (!mapping.outputs.length)
    issues.push({
      code: "context.mapping_outputs_missing",
      row: null,
      objectType: null,
      field: null,
      message: "No canonical objects are mapped.",
      action: "Add an output object.",
    });
  for (const output of mapping.outputs) {
    const schema = metadata.definitions[output.objectType];
    if (!metadata.objectTypes.includes(output.objectType) || !schema) {
      issues.push({
        code: "context.object_type_unknown",
        row: null,
        objectType: output.objectType,
        field: null,
        message: "This object is not in the pinned canonical ontology.",
        action: "Choose a canonical object type.",
      });
      continue;
    }
    const fields = schema.properties as Record<string, unknown>;
    for (const field of (schema.required as string[]) ?? [])
      if (!Object.hasOwn(output.fields, field))
        issues.push({
          code: "context.required_field_unmapped",
          row: null,
          objectType: output.objectType,
          field,
          message: `${output.objectType}.${field} is schema required.`,
          action: "Map the required field.",
        });
    for (const field of Object.keys(output.fields))
      if (!Object.hasOwn(fields, field))
        issues.push({
          code: "context.field_unknown",
          row: null,
          objectType: output.objectType,
          field,
          message: "Field is not in the pinned schema.",
          action: "Choose an admitted canonical field.",
        });
  }
  return {
    mapping,
    issues,
    compilerVersion: MAPPING_COMPILER_VERSION,
    digest: stableDigest({
      mapping,
      compiler: MAPPING_COMPILER_VERSION,
      ontology: metadata.lock.files,
      platform: metadata.platformContracts,
      definitions: metadata.definitions,
    }),
  };
}
export function evaluateExpression(
  e: MappingExpression,
  row: Record<string, unknown>,
): unknown {
  if (e.op === "field")
    return e.path
      .split(".")
      .reduce<unknown>(
        (v, key) =>
          v && typeof v === "object" && Object.hasOwn(v, key)
            ? (v as Record<string, unknown>)[key]
            : undefined,
        row,
      );
  if (e.op === "literal") return structuredClone(e.value);
  if (e.op === "coalesce") {
    for (const expr of e.values) {
      const value = evaluateExpression(expr, row);
      if (value !== undefined && value !== null && value !== "") return value;
    }
    return undefined;
  }
  if (e.op === "concat") {
    const values = e.values.map((expr) => evaluateExpression(expr, row));
    if (values.some((v) => typeof v !== "string"))
      throw new Error("context.source_type_invalid");
    const text = values.join(e.separator);
    if (text.length > 16384) throw new Error("context.transform_limit");
    return text;
  }
  if (e.op === "array") return e.items.map((i) => evaluateExpression(i, row));
  if (e.op === "object")
    return Object.fromEntries(
      Object.entries(e.fields).map(([k, v]) => [k, evaluateExpression(v, row)]),
    );
  const v = evaluateExpression(e.value, row);
  if (e.op === "id") return stableObjectId(e.namespace, v);
  if (e.op === "json") {
    if (v === undefined || v === null)
      throw new Error("context.source_value_missing");
    guard(v);
    const text = canonicalJson(v);
    if (text.length > 16384) throw new Error("context.transform_limit");
    return text;
  }
  if (e.op === "percent_fraction") {
    if (typeof v !== "string" || !/^(0|[1-9]\d{0,2})(\.\d{1,12})?$/.test(v))
      throw new Error("context.percent_invalid");
    const [whole, part = ""] = v.split(".");
    if (Number(whole) > 100 || (Number(whole) === 100 && /[1-9]/.test(part)))
      throw new Error("context.percent_invalid");
    if (Number(whole) === 100) return "1";
    const fraction = `${whole!.padStart(2, "0")}${part}`.replace(/0+$/, "");
    return fraction ? `0.${fraction}` : "0";
  }
  if (v === undefined || v === null)
    throw new Error("context.source_value_missing");
  if (e.op === "crosswalk") {
    if (stableDigest(e.values) !== e.revision)
      throw new Error("context.crosswalk_revision_mismatch");
    if (!Object.hasOwn(e.values, String(v)))
      throw new Error("context.crosswalk_unresolved");
    return e.values[String(v)];
  }
  if (e.op === "boolean") {
    if (typeof v === "boolean") return v;
    if (v === "true") return true;
    if (v === "false") return false;
    throw new Error("context.boolean_invalid");
  }
  if (e.op === "integer") {
    if (
      (typeof v !== "string" || !/^-?(0|[1-9]\d*)$/.test(v)) &&
      typeof v !== "number"
    )
      throw new Error("context.integer_invalid");
    const number = Number(v);
    if (!Number.isSafeInteger(number))
      throw new Error("context.integer_invalid");
    return number;
  }
  if (e.op === "lookup") {
    const key = String(v);
    if (!Object.hasOwn(e.values, key)) throw new Error("context.enum_unmapped");
    return e.values[key];
  }
  if (typeof v !== "string") throw new Error("context.source_type_invalid");
  if (e.op === "split") {
    const values = v.split(e.separator).map((s) => s.trim());
    if (values.length > 64) throw new Error("context.transform_limit");
    return values;
  }
  if (e.op === "date") {
    if (!/^\d{4}-\d\d-\d\d$/.test(v)) throw new Error("context.date_invalid");
    const time = evaluateExpression(
      { op: "instant", value: { op: "literal", value: `${v}T00:00:00Z` } },
      row,
    );
    return String(time).slice(0, 10);
  }
  if (e.op === "trim") return v.trim();
  if (e.op === "lower") return v.toLowerCase();
  if (e.op === "upper") return v.toUpperCase();
  if (e.op === "decimal") {
    if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(v.trim()))
      throw new Error("context.decimal_invalid");
    return v.trim();
  }
  if (
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v) ||
    !Number.isFinite(Date.parse(v))
  )
    throw new Error("context.timezone_required");
  const [date, time] = v.split("T");
  const [year, month, day] = date!.split("-").map(Number);
  const [hour, minute, second] = time!.slice(0, 8).split(":").map(Number);
  const days = [
    31,
    year! % 4 === 0 && (year! % 100 !== 0 || year! % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (
    month! < 1 ||
    month! > 12 ||
    day! < 1 ||
    day! > (days[month! - 1] ?? 0) ||
    hour! > 23 ||
    minute! > 59 ||
    second! > 59
  )
    throw new Error("context.instant_invalid");
  return new Date(v).toISOString();
}
export function executeMapping(
  mapping: CanonicalMapping,
  rows: Record<string, unknown>[],
  observedAt: string | ((row: Record<string, unknown>) => string),
) {
  const compiled = compileMapping(mapping);
  mapping = compiled.mapping;
  const issues = [...compiled.issues];
  const candidates: ContextCandidate[] = [];
  const lineage: Array<{
    row: number;
    objectId: string;
    field: string;
    sourcePaths: string[];
  }> = [];
  let acceptedRows = 0,
    rejectedRows = 0,
    duplicateRecords = 0;
  const seen = new Map<string, string>();
  if (rows.length > 100) throw new Error("context.sample_limit_exceeded");
  guard(rows);
  if (compiled.issues.length)
    return {
      candidates,
      issues,
      lineage,
      acceptedRows: 0,
      rejectedRows: rows.length,
      duplicateRecords,
      compilationDigest: compiled.digest,
    };
  rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const pending: ContextCandidate[] = [];
    const pendingLineage: typeof lineage = [];
    const rowIssues: ContextMappingIssue[] = [];
    let subject: unknown;
    try {
      subject = evaluateExpression(mapping.subject, row);
      if (typeof subject !== "string" || !subject.trim())
        throw new Error("context.subject_missing");
    } catch {
      rowIssues.push({
        code: "context.subject_missing",
        row: rowNumber,
        objectType: null,
        field: null,
        message: "Subject identity could not be resolved.",
        action: "Inspect the subject identity rule.",
      });
    }
    for (const output of mapping.outputs) {
      const collection = output.collection
        ? evaluateExpression({ op: "field", path: output.collection }, row)
        : [null];
      if (!Array.isArray(collection) || collection.length > 64) {
        rowIssues.push({
          code: "context.collection_invalid",
          row: rowNumber,
          objectType: output.objectType,
          field: output.collection ?? null,
          message: "Expected a bounded source collection.",
          action: "Check the collection path and expansion limit.",
        });
        continue;
      }
      for (const [itemIndex, item] of collection.entries()) {
        const scopeRow = output.collection ? { ...row, item } : row;
        const data: Record<string, unknown> = {};
        let objectId = "";
        try {
          const key = evaluateExpression(output.identity, scopeRow);
          if (typeof key !== "string" || !key.trim()) throw new Error();
          objectId = key;
        } catch {
          rowIssues.push({
            code: "context.identity_missing",
            row: rowNumber,
            objectType: output.objectType,
            field: "object_id",
            message: "Canonical object identity is missing.",
            action: "Inspect the stable ID rule.",
          });
        }
        for (const [field, expr] of Object.entries(output.fields)) {
          try {
            const v = evaluateExpression(expr, scopeRow);
            if (v !== undefined) data[field] = v;
            pendingLineage.push({
              row: rowNumber,
              objectId,
              field,
              sourcePaths: [
                ...new Set(
                  sourcePaths(expr, scopeRow).map((p) =>
                    output.collection && p.startsWith("item.")
                      ? `${output.collection}.${itemIndex}.${p.slice(5)}`
                      : p,
                  ),
                ),
              ],
            });
          } catch (error) {
            rowIssues.push({
              code:
                error instanceof Error
                  ? error.message
                  : "context.transform_failed",
              row: rowNumber,
              objectType: output.objectType,
              field,
              message: `Cannot transform ${output.objectType}.${field}.`,
              action:
                expr.op === "lookup"
                  ? "Edit the approved value map."
                  : "Inspect the source value and transformation.",
            });
          }
        }
        const result = validateRecordData(output.objectType, data);
        for (const message of result.errors)
          rowIssues.push({
            code: "context.canonical_data_invalid",
            row: rowNumber,
            objectType: output.objectType,
            field: message.split(" ")[0] ?? null,
            message,
            action: "Repair the canonical field mapping.",
          });
        let observation = "";
        try {
          observation =
            typeof observedAt === "string" ? observedAt : observedAt(row);
          if (!Number.isFinite(Date.parse(observation))) throw new Error();
        } catch {
          rowIssues.push({
            code: "context.observation_missing",
            row: rowNumber,
            objectType: output.objectType,
            field: "observed_at",
            message: "A source observation time is required.",
            action: "Map a timestamp with timezone.",
          });
        }
        const content = {
          object_type: output.objectType,
          object_id: objectId,
          schema_version: mapping.schemaVersion,
          data,
          subject_ids: typeof subject === "string" ? [subject] : [],
          observed_at: observation,
        };
        const envelopeCheck = canonicalRecordInputSchema.safeParse({
          ...content,
          version_id: "candidate",
          classification: "CONFIDENTIAL",
          synthetic: true,
          source_refs: [],
          provenance: { method: "platform" },
        });
        if (!envelopeCheck.success)
          rowIssues.push({
            code: "context.candidate_envelope_invalid",
            row: rowNumber,
            objectType: output.objectType,
            field: "object_id/observed_at/subject_ids",
            message:
              "Candidate identity or observation does not meet the canonical record envelope.",
            action: "Repair the identity and observation rules.",
          });
        if (candidates.length + pending.length >= 200) {
          rowIssues.push({
            code: "context.record_limit",
            row: rowNumber,
            objectType: output.objectType,
            field: null,
            message: "Bundle exceeds the canonical commit limit.",
            action: "Reduce the source scope.",
          });
          break;
        }
        pending.push({
          ...content,
          version_id: `v-${stableDigest(content).slice(0, 40)}`,
          row: rowNumber,
        });
      }
    }
    // An input row's related records are atomic: do not leave a dangling Party when Entity fails.
    if (rowIssues.length) {
      issues.push(...rowIssues);
      rejectedRows++;
      return;
    }
    const pendingVersions = new Map<string, string>();
    for (const c of pending) {
      const key = `${c.object_type}:${c.object_id}`;
      const previous = seen.get(key) ?? pendingVersions.get(key);
      pendingVersions.set(key, c.version_id);
      if (previous && previous !== c.version_id) {
        rowIssues.push({
          code: "context.identity_conflict",
          row: rowNumber,
          objectType: c.object_type,
          field: "object_id",
          message: "The same object key has conflicting sample values.",
          action: "Inspect duplicate source keys.",
        });
      }
    }
    if (rowIssues.length) {
      issues.push(...rowIssues);
      rejectedRows++;
      return;
    }
    acceptedRows++;
    for (const c of pending) {
      const key = `${c.object_type}:${c.object_id}`;
      if (seen.has(key)) {
        duplicateRecords++;
        continue;
      }
      seen.set(key, c.version_id);
      candidates.push(c);
    }
    lineage.push(...pendingLineage);
  });
  // Use the same typed semantic edges as the ontology and packet graph.
  const relationships = canonicalRelationships().relationships;
  for (const c of candidates)
    for (const edge of relationships.filter(
      (e) => e.source === c.object_type,
    )) {
      const raw = c.data[edge.field];
      const refs =
        raw === undefined || raw === null
          ? []
          : Array.isArray(raw)
            ? raw
            : [raw];
      for (const value of refs) {
        const resolved =
          typeof value === "string"
            ? candidates.filter(
                (target) =>
                  target.object_type === edge.target &&
                  target.object_id === value,
              ).length === 1
            : value &&
              typeof value === "object" &&
              candidates.some((target) => {
                const ref = value as Record<string, unknown>;
                return (
                  target.object_type === ref.object_type &&
                  target.object_type === edge.target &&
                  target.object_id === ref.object_id &&
                  target.version_id === ref.version_id
                );
              });
        if (!resolved)
          issues.push({
            code: "context.reference_unresolved",
            row: c.row,
            objectType: c.object_type,
            field: edge.field,
            message: `${edge.field} does not resolve to ${edge.target} within this bundle.`,
            action:
              "Include the permitted target record or repair the identity mapping.",
          });
      }
    }
  if (candidates.length > 200)
    issues.push({
      code: "context.record_limit",
      row: null,
      objectType: null,
      field: null,
      message: "Bundle exceeds the canonical commit limit.",
      action: "Reduce the bounded source scope.",
    });
  return {
    candidates,
    issues,
    lineage,
    acceptedRows,
    rejectedRows,
    duplicateRecords,
    compilationDigest: compiled.digest,
  };
}

export * from "./templates.js";
