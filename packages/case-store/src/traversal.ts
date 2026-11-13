import { canonicalRecordObjectType, stableDigest, type CaseSnapshot, type CaseReadGrant, type CanonicalRecord } from "@ehf/contracts";
import { CaseStoreError, type CaseStore } from "./index.js";
import { qualify } from "./config.js";
/** A bounded MVCC read for the explorer: no unselected case tables or unlimited record snapshot. */
export async function getCaseTraversalSnapshot(store: CaseStore, tenantId: string, caseId: string, input: {
  purpose: string; selectors: CaseReadGrant[]; classifications: string[]; subjects?: string[];
  asOf: string; knowledgeCutoff: string;
}): Promise<CaseSnapshot | null> {
  const types = [...new Set(input.selectors.map(canonicalRecordObjectType).filter((t): t is string => Boolean(t)))];
  const client = await store.db.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    await client.query("set local statement_timeout = '5000ms'");
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const row = (await client.query<Record<string, unknown>>(`select case_sequence,harness_plan_digest,dependency_digest,policy_id,policy_version,policy_bundle_digest,policy_snapshot_digest from ${qualify(store.schemas.core, "cases")} where tenant_id=$1 and case_id=$2`, [tenantId, caseId])).rows[0];
    if (!row) { await client.query("rollback"); return null; }
    const subjectsResult = await client.query<Record<string, unknown>>(`select subject_id from ${qualify(store.schemas.core, "case_subjects")} where tenant_id=$1 and case_id=$2 limit 1001`, [tenantId, caseId]);
    if (subjectsResult.rows.length > 1000 || Buffer.byteLength(JSON.stringify(subjectsResult.rows.map(s => s.subject_id))) > 64_000) throw new CaseStoreError("context.traversal_scope_too_large", 413);
    const knownSubjects = subjectsResult.rows.map(s => String(s.subject_id ?? s.subjectId ?? "")).filter(Boolean);
    const subjects = input.subjects ?? knownSubjects;
    if (!subjects.length || subjects.some(s => !knownSubjects.includes(s))) throw new CaseStoreError("context.traversal_subject_denied", 403);
    const table = qualify(store.schemas.core, "canonical_records");
    const result = await client.query<{ document: CanonicalRecord; recorded_at: Date | string; record_digest: string }>(`
      with candidates as (
        select r.*, row_number() over (partition by r.object_type,r.object_id order by r.recorded_at desc,r.version_id desc) as rank
        from ${table} r
        where r.tenant_id=$1 and r.case_id=$2 and r.object_type=any($3::text[])
          and r.recorded_at <= $4::timestamptz
          and (r.valid_from is null or r.valid_from <= $5::timestamptz)
          and (r.valid_to is null or r.valid_to > $5::timestamptz)
          and not exists (select 1 from ${table} newer where newer.tenant_id=r.tenant_id and newer.case_id=r.case_id
            and newer.object_type=r.object_type and newer.object_id=r.object_id and newer.supersedes=r.version_id and newer.recorded_at <= $4::timestamptz)
      )
      select document,recorded_at,record_digest from candidates r
      where rank=1 and classification=any($6::text[]) and purposes ? $7
        and (subject_ids='[]'::jsonb and $9::boolean or (subject_ids ?| $8::text[] and not exists
          (select 1 from jsonb_array_elements_text(subject_ids) as subject(value) where not (value=any($8::text[])))))
      order by object_type,object_id,version_id limit 5001
    `, [tenantId, caseId, types, input.knowledgeCutoff, input.asOf, input.classifications, input.purpose, subjects, !input.subjects]);
    if (result.rows.length > 5000 || Buffer.byteLength(JSON.stringify(result.rows)) > 4 * 1024 * 1024) throw new CaseStoreError("context.traversal_scope_too_large", 413);
    const records: Record<string, CanonicalRecord[]> = {};
    for (const r of result.rows) {
      const record = { ...r.document, recorded_at: new Date(r.recorded_at).toISOString(), record_digest: r.record_digest.trim() };
      (records[record.object_type] ??= []).push(record);
    }
    for (const k of ["harness_plan_digest", "dependency_digest", "policy_id", "policy_version", "policy_bundle_digest", "policy_snapshot_digest"])
      if (typeof row[k] !== "string" || !row[k]) throw new CaseStoreError("case.snapshot_authority_incomplete", 409);
    const canonical = { apiVersion: "harness.factory/case-snapshot-v1" as const, kind: "CaseSnapshot" as const,
      tenantId, caseId, caseSequence: Number(row.case_sequence), planDigest: String(row.harness_plan_digest), dependencyDigest: String(row.dependency_digest),
      policyAuthority: { policyId: String(row.policy_id), policyVersion: String(row.policy_version), policyBundleDigest: String(row.policy_bundle_digest), policySnapshotDigest: String(row.policy_snapshot_digest) },
      consistency: "strong" as const, classification: "CONFIDENTIAL", data: { subjects: subjects.map(subject_id => ({ subject_id })), records, recordsAsOf: { asOf: input.asOf, knowledgeCutoff: input.knowledgeCutoff }, purpose: input.purpose } };
    const digest = stableDigest(canonical);
    await client.query("commit");
    return { ...canonical, snapshotId: `snapshot_${digest}`, snapshotDigest: digest, capturedAt: input.knowledgeCutoff };
  } catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
  finally { client.release(); }
}
