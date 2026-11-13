import type { PoolClient } from "pg";
import {
  canonicalRecordDigest,
  applicationContextReferences,
  validateApplicationContext,
  canonicalRecordObjectType,
  recordCanonicalRecordsPayloadSchema,
  type BusinessCommand,
  type CanonicalRecord,
  type CaseReadGrant,
} from "@ehf/contracts";
import { requiredRecordFields } from "@ehf/library-contracts";
import { qualify, type CaseStoreSchemas } from "./config.js";

/**
 * Canonical record store (docs/implementation/canonical-records.md).
 *
 * Records are immutable versions keyed by (tenant, case, object_type, object_id, version_id).
 * A version is written once; replaying it with identical content is a no-op and different
 * content under the same version is a conflict. Supersession is only ever a new version that
 * names (or, when omitted, is chained to) the object's current latest version.
 */

export class CanonicalRecordError extends Error {
  constructor(public readonly code: string, public readonly httpStatus: number, public readonly details: Record<string, unknown> = {}) {
    super(code);
    this.name = "CanonicalRecordError";
  }
}

type Reader = Pick<PoolClient, "query">;

type StoredVersion = { version_id: string; supersedes: string | null; record_digest: string; recorded_at: Date | string };

export type RecordedVersion = {
  objectType: string;
  objectId: string;
  versionId: string;
  recordDigest: string;
  supersedes: string | null;
  outcome: "RECORDED" | "UNCHANGED";
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function compareVersion(a: { recorded_at: string | Date; version_id: string }, b: { recorded_at: string | Date; version_id: string }): number {
  const time = Date.parse(iso(a.recorded_at)) - Date.parse(iso(b.recorded_at));
  return time !== 0 ? time : a.version_id < b.version_id ? -1 : a.version_id > b.version_id ? 1 : 0;
}

/** The object's current head: the latest version no other version supersedes. */
function headVersion(versions: StoredVersion[]): StoredVersion | null {
  const superseded = new Set(versions.map((version) => version.supersedes).filter((value): value is string => Boolean(value)));
  const heads = versions.filter((version) => !superseded.has(version.version_id));
  return [...(heads.length ? heads : versions)].sort(compareVersion).at(-1) ?? null;
}

/** Bind the transaction to one tenant for the table's row-level security policy. */
export async function bindRecordTenant(client: Reader, tenantId: string): Promise<void> {
  await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
}

/**
 * Apply a `RecordCanonicalRecords` command inside the caller's case transaction. Returns the
 * versions it recorded (or found unchanged) for the ledger event.
 */
export async function recordCanonicalRecords(
  client: Reader,
  schemas: CaseStoreSchemas,
  command: BusinessCommand,
  input: { recordedAt: string; caseSequence: number; observationsOnly?: boolean },
): Promise<{ versions: RecordedVersion[]; evidenceRefs: string[] }> {
  const payload = recordCanonicalRecordsPayloadSchema.parse(command.payload);
  const table = qualify(schemas.core, "canonical_records");
  await bindRecordTenant(client, command.tenantId);
  const versions: RecordedVersion[] = [];
  const batch = new Map<string, string>();
  for (const [index, item] of payload.records.entries()) {
    if (item.object_type === "ControlAssessment") {
      // In v2 a system computation is an observation until an OPA adoption action names
      // this exact immutable version. Origin attribution can never be self-promoted to HUMAN.
      const humanOrigin = command.actor.type === "HUMAN" && item.data.authority === "HUMAN" && item.data.assessedBy === command.actor.principalId;
      const systemObservation = input.observationsOnly === true && command.actor.type !== "HUMAN"
        && item.data.authority === "SYSTEM" && item.data.assessedBy === command.actor.principalId && item.provenance.method === "skill_proposal";
      if (!humanOrigin && !systemObservation) {
        throw new CanonicalRecordError("record.control_assessment_authority_invalid", 403, { index });
      }
    }
    if (item.tenant_id !== undefined && item.tenant_id !== command.tenantId) {
      throw new CanonicalRecordError("record.tenant_mismatch", 403, { index });
    }
    if (item.case_id !== undefined && item.case_id !== command.caseId) {
      throw new CanonicalRecordError("record.case_mismatch", 403, { index });
    }
    const applicationErrors=validateApplicationContext(item.object_type,item.data);
    if(applicationErrors.length)throw new CanonicalRecordError('record.application_data_invalid',400,{index,issues:applicationErrors});
    if(item.object_type==='Application'&&(item.data.previous_application_ref as {object_id?:string}|undefined)?.object_id===item.object_id)throw new CanonicalRecordError('record.application_resubmission_identity_invalid',409,{index});
    for(const ref of applicationContextReferences(item.object_type,item.data)){
      if(ref.tenant_id!==command.tenantId)throw new CanonicalRecordError('record.reference_tenant_mismatch',403,{index});
      const inBatch=payload.records.some(r=>r.object_type===ref.object_type&&r.object_id===ref.object_id&&r.version_id===ref.version_id);
      if(!inBatch){
        const resolved=await client.query(`select 1 from ${table} where tenant_id=$1 and case_id=$2 and object_type=$3 and object_id=$4 and version_id=$5`,[command.tenantId,command.caseId,ref.object_type,ref.object_id,ref.version_id]);
        if(!resolved.rows.length)throw new CanonicalRecordError('record.reference_unresolved',409,{index,objectType:ref.object_type,objectId:ref.object_id});
      }
    }
    const existing = await client.query<StoredVersion>(`
      select version_id, supersedes, record_digest, recorded_at from ${table}
      where tenant_id = $1 and case_id = $2 and object_type = $3 and object_id = $4
    `, [command.tenantId, command.caseId, item.object_type, item.object_id]);
    const same = existing.rows.find((row) => row.version_id === item.version_id);
    const head = headVersion(existing.rows.filter((row) => row.version_id !== item.version_id));
    let supersedes: string | null;
    if (same) {
      supersedes = item.supersedes === undefined ? same.supersedes : item.supersedes;
    } else {
      const expected = head?.version_id ?? null;
      if (item.supersedes !== undefined && item.supersedes !== expected) {
        throw new CanonicalRecordError("record.supersession_conflict", 409, {
          index, objectType: item.object_type, objectId: item.object_id, expected, supplied: item.supersedes,
        });
      }
      supersedes = expected;
    }
    const record = {
      schema_version: item.schema_version ?? "1.0.0",
      tenant_id: command.tenantId,
      case_id: command.caseId,
      object_type: item.object_type,
      object_id: item.object_id,
      version_id: item.version_id,
      data: item.data,
      subject_ids: item.subject_ids ?? [],
      valid_from: item.valid_from ?? null,
      valid_to: item.valid_to ?? null,
      observed_at: item.observed_at,
      source_refs: item.source_refs,
      provenance: item.provenance,
      classification: item.classification,
      purposes: item.purposes ?? [],
      synthetic: item.synthetic,
      supersedes,
    };
    const recordDigest = canonicalRecordDigest(record);
    const key = `${item.object_type}\u0000${item.object_id}\u0000${item.version_id}`;
    const inBatch = batch.get(key);
    if (inBatch !== undefined) {
      if (inBatch !== recordDigest) throw new CanonicalRecordError("record.version_conflict", 409, { index });
      continue;
    }
    batch.set(key, recordDigest);
    if (same) {
      if (same.record_digest.trim() !== recordDigest) {
        throw new CanonicalRecordError("record.version_conflict", 409, { index, objectType: item.object_type, objectId: item.object_id, versionId: item.version_id });
      }
      versions.push({ objectType: item.object_type, objectId: item.object_id, versionId: item.version_id, recordDigest, supersedes, outcome: "UNCHANGED" });
      continue;
    }
    await client.query(`
      insert into ${table}(
        tenant_id, case_id, object_type, object_id, version_id, schema_version, data, subject_ids,
        valid_from, valid_to, observed_at, recorded_at, source_refs, provenance, classification,
        purposes, synthetic, supersedes, record_digest, document, case_sequence
      ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16::jsonb,$17,$18,$19,$20::jsonb,$21)
    `, [
      record.tenant_id, record.case_id, record.object_type, record.object_id, record.version_id, record.schema_version,
      JSON.stringify(record.data), JSON.stringify(record.subject_ids), record.valid_from, record.valid_to, record.observed_at,
      input.recordedAt, JSON.stringify(record.source_refs), JSON.stringify(record.provenance), record.classification,
      JSON.stringify(record.purposes), record.synthetic, record.supersedes, recordDigest, JSON.stringify(record), input.caseSequence,
    ]);
    versions.push({ objectType: item.object_type, objectId: item.object_id, versionId: item.version_id, recordDigest, supersedes, outcome: "RECORDED" });
  }
  return { versions, evidenceRefs: payload.evidenceRefs ?? [] };
}

export type RecordSelectionTime = { asOf: string; knowledgeCutoff: string };

/**
 * Bitemporal selection, as the library's context compiler does it: versions recorded by the
 * knowledge cutoff, minus versions a known later version supersedes, valid at `asOf`
 * (`[valid_from, valid_to)`), then the latest per object by (recorded_at, version_id).
 * Grouped by object type, ordered by object id.
 */
export function selectCanonicalRecordVersions(
  records: readonly CanonicalRecord[],
  time: RecordSelectionTime,
): Record<string, CanonicalRecord[]> {
  const asOf = Date.parse(time.asOf);
  const cutoff = Date.parse(time.knowledgeCutoff);
  if (!Number.isFinite(asOf) || !Number.isFinite(cutoff)) throw new CanonicalRecordError("record.selection_time_invalid", 400);
  const objectKey = (record: Pick<CanonicalRecord, "object_type" | "object_id">) => `${record.object_type}\u0000${record.object_id}`;
  const known = records.filter((record) => Date.parse(record.recorded_at) <= cutoff);
  const superseded = new Set(known.filter((record) => record.supersedes).map((record) => `${objectKey(record)}\u0000${record.supersedes}`));
  const latest = new Map<string, CanonicalRecord>();
  for (const record of known) {
    if (superseded.has(`${objectKey(record)}\u0000${record.version_id}`)) continue;
    if (record.valid_from && Date.parse(record.valid_from) > asOf) continue;
    if (record.valid_to && Date.parse(record.valid_to) <= asOf) continue;
    const prior = latest.get(objectKey(record));
    if (!prior || compareVersion(record, prior) > 0) latest.set(objectKey(record), record);
  }
  const grouped: Record<string, CanonicalRecord[]> = {};
  for (const record of [...latest.values()].sort((a, b) => (a.object_type + "\u0000" + a.object_id < b.object_type + "\u0000" + b.object_id ? -1 : 1))) {
    (grouped[record.object_type] ??= []).push(record);
  }
  return grouped;
}

/** Read and select a case's records for a snapshot (inside the snapshot's transaction). */
export async function readCanonicalRecords(
  client: Reader,
  schemas: CaseStoreSchemas,
  tenantId: string,
  caseId: string,
  time: RecordSelectionTime,
): Promise<Record<string, CanonicalRecord[]>> {
  await bindRecordTenant(client, tenantId);
  const result = await client.query<{ document: Omit<CanonicalRecord, "recorded_at" | "record_digest">; recorded_at: Date | string; record_digest: string }>(`
    select document, recorded_at, record_digest from ${qualify(schemas.core, "canonical_records")}
    where tenant_id = $1 and case_id = $2 and recorded_at <= $3
    order by object_type, object_id, recorded_at, version_id
  `, [tenantId, caseId, time.knowledgeCutoff]);
  const rows = (result.rows ?? []).map((row) => ({ ...row.document, recorded_at: iso(row.recorded_at), record_digest: String(row.record_digest).trim() }) as CanonicalRecord);
  return selectCanonicalRecordVersions(rows, time);
}

/**
 * Project the record selectors of a node: only the object types it names and, per type, only
 * the union of the fields its selectors ask for (envelope fields — ids, times, sources,
 * provenance, synthetic — always stay). A type with no selected records projects as `[]`, so
 * the context plane can report CONTEXT_MISSING instead of the store failing the read.
 *
 * The fields a library context type's contract requires always stay too. The skill library
 * validates every record it receives against that type's closed schema, so a record trimmed to a
 * skill's declared fields alone is rejected there and the skill never runs. Optional fields are
 * still withheld unless a selector asks for them.
 */
export function projectCanonicalRecords(
  records: unknown,
  selectors: readonly CaseReadGrant[],
): Map<string, CanonicalRecord[]> {
  const available = records && typeof records === "object" && !Array.isArray(records) ? records as Record<string, CanonicalRecord[]> : {};
  const fieldsByType = new Map<string, Set<string> | null>();
  for (const selector of selectors) {
    const objectType = canonicalRecordObjectType(selector);
    if (!objectType) continue;
    const prior = fieldsByType.get(objectType);
    if (prior === null) continue;
    if (!selector.record) {
      fieldsByType.set(objectType, null);
      continue;
    }
    fieldsByType.set(objectType, new Set([...(prior ?? requiredRecordFields(objectType)), ...selector.record.fields]));
  }
  const projected = new Map<string, CanonicalRecord[]>();
  for (const [objectType, fields] of fieldsByType) {
    const list = Array.isArray(available[objectType]) ? available[objectType]! : [];
    projected.set(objectType, list.map((record) => fields === null ? structuredClone(record) : {
      ...structuredClone(record),
      data: Object.fromEntries(Object.entries(record.data).filter(([field]) => fields.has(field)).map(([field, value]) => [field, structuredClone(value)])),
    }));
  }
  return projected;
}

export function isRecordSelector(selector: CaseReadGrant): boolean {
  return canonicalRecordObjectType(selector) !== null;
}

export { iso as recordTimestamp };
