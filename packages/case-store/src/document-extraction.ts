import { z } from "zod";
import type { PoolClient } from "pg";
import { DOCUMENT_CASE_WRITES, DOCUMENT_EXTRACTION_REVIEW, DOCUMENT_WORK_TYPES, isDocumentExtractionPlan, stableDigest, type CaseSnapshot, type HarnessPlanV2 } from "@ehf/contracts";
import { CaseStoreError, withCaseTenant, type CaseExecutionAuthority, type CaseStore } from "./index.js";
import { qualify } from "./config.js";
const object = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
export const documentAuthorizationSchema = z.object({ documentId: z.string().min(1), documentVersion: z.string().regex(/^[a-f0-9]{64}$/), evidenceId: z.string().min(1), planDigest: z.string().regex(/^[a-f0-9]{64}$/), requestKey: z.string().min(1).max(300) }).strict();
export type DocumentRunScope = z.infer<typeof documentAuthorizationSchema>;

export async function assertDocumentPlan(store: CaseStore, tenantId: string, digest: string, executionReader: Pick<PoolClient, "query"> = store.executionDb ?? store.db): Promise<void> {
  const result = await executionReader.query<{ plan: HarnessPlanV2 }>("select harness_runtime.document_extraction_plan($1,$2) as plan", [tenantId, digest]);
  if (!result.rows[0]?.plan || !isDocumentExtractionPlan(result.rows[0].plan)) throw new CaseStoreError("document.extraction_plan_invalid", 409);
}
export async function assertDocumentSource(reader: Pick<PoolClient, "query">, store: CaseStore, tenantId: string, caseId: string, scope: DocumentRunScope) {
  const result = await reader.query(`select raw_digest from ${qualify(store.schemas.evidence, "evidence_objects")} where tenant_id=$1 and case_id=$2 and evidence_id=$3 and evidence_type='DOCUMENT'`, [tenantId, caseId, scope.evidenceId]);
  if (String(result.rows[0]?.raw_digest).replace(/^sha256:/, "") !== scope.documentVersion) throw new CaseStoreError("document.version_conflict", 409);
}
/** Resolve the authorization against the immutable run input and its retry key. */
export async function documentRunScope(store: CaseStore, authority: CaseExecutionAuthority, reader?: Pick<PoolClient, "query">, executionReader?: Pick<PoolClient, "query">): Promise<DocumentRunScope> {
  if (!authority.case_id) throw new CaseStoreError("document.execution_not_authorized", 403);
  // Without a caller's transaction, read under the run's tenant: the case API's login role is subject to row-level
  // security, so an unbound read would see no authorization review at all.
  if (!reader) return withCaseTenant(store, authority.tenant_id, client => documentRunScope(store, authority, client, executionReader ?? store.executionDb ?? client), { readOnly: true });
  executionReader ??= store.executionDb ?? reader;
  const result = await executionReader.query("select * from harness_runtime.document_extraction_run($1,$2,$3,$4)", [authority.tenant_id, authority.case_id, authority.run_id, authority.plan_digest]);
  const run = result.rows[0], input = object(run?.input);
  if (input.caseId !== authority.case_id || input.tenantId !== authority.tenant_id) throw new CaseStoreError("document.execution_not_authorized", 403);
  const reviews = await reader.query(`select details from ${qualify(store.schemas.core, "case_reviews")} where tenant_id=$1 and case_id=$2 and review_type=$3 and details->>'requestKey'=$4 order by created_at desc`, [authority.tenant_id, authority.case_id, DOCUMENT_EXTRACTION_REVIEW, run.idempotency_key]);
  const parsed = documentAuthorizationSchema.safeParse(reviews.rows[0]?.details?.authorization);
  if (!parsed.success || parsed.data.planDigest !== authority.plan_digest || parsed.data.documentId !== input.documentId || parsed.data.documentVersion !== input.documentVersion || parsed.data.evidenceId !== input.evidenceId || parsed.data.requestKey !== run.idempotency_key) throw new CaseStoreError("document.execution_not_authorized", 403);
  await assertDocumentSource(reader, store, authority.tenant_id, authority.case_id, parsed.data);
  return parsed.data;
}
export function assertDocumentCommands(scope: DocumentRunScope, commands: Array<{ commandType: string; payload: Record<string, unknown> }>) {
  for (const command of commands) {
    if (!DOCUMENT_CASE_WRITES.has(command.commandType)) throw new CaseStoreError("document.command_not_permitted", 403);
    if (command.commandType === "ProposeWorkItem" && (!DOCUMENT_WORK_TYPES.has(String(command.payload.workType)) || command.payload.requiredCapability || command.payload.assignedTo || command.payload.dueAt)) throw new CaseStoreError("document.work_item_outside_scope", 403);
    // A route conflict names the selected version's extracted assertion it is about; no other work item names anything.
    if (command.commandType === "ProposeWorkItem" && (command.payload.workType === "DOCUMENT_FIELD_CONFLICT"
      ? typeof command.payload.subjectRef !== "string" || !command.payload.subjectRef.startsWith(`extraction:${scope.documentVersion.slice(0, 24)}:`)
      : command.payload.subjectRef !== undefined)) throw new CaseStoreError("document.work_item_outside_scope", 403);
    if (command.commandType !== "RecordCanonicalRecords") continue;
    const records = command.payload.records;
    if (!Array.isArray(records) || records.some(raw => {
      const record = object(raw), data = object(record.data);
      return record.object_type === "DocumentVersion" ? data.document_id !== scope.documentId || data.artifact_hash !== scope.documentVersion : !["DocumentPage", "ExtractedAssertion"].includes(record.object_type) || data.document_version !== scope.documentVersion;
    })) throw new CaseStoreError("document.record_outside_scope", 403);
  }
}
export function scopeDocumentSnapshot(snapshot: CaseSnapshot, scope: DocumentRunScope): CaseSnapshot {
  const selected: Record<string, unknown> = {};
  for (const [type, values] of Object.entries(object(snapshot.data.records))) if (["DocumentVersion", "DocumentPage", "ExtractedAssertion"].includes(type) && Array.isArray(values)) selected[type] = values.filter(raw => { const data = object(object(raw).data); return type === "DocumentVersion" ? data.document_id === scope.documentId && data.artifact_hash === scope.documentVersion : data.document_version === scope.documentVersion; });
  const { snapshotId: _id, snapshotDigest: _digest, capturedAt, ...basis } = snapshot;
  const scoped = { ...basis, planDigest: scope.planDigest, data: { case: snapshot.data.case, subjects: snapshot.data.subjects, records: selected, ...(snapshot.data.recordsAsOf !== undefined ? { recordsAsOf: snapshot.data.recordsAsOf } : {}) } };
  const digest = stableDigest(scoped);
  return { ...scoped, capturedAt, snapshotId: `snapshot_${digest}`, snapshotDigest: digest };
}
/** A selected document may not supersede an object that belongs to another source version. */
export async function assertDocumentRecordIdentities(reader: Pick<PoolClient, "query">, store: CaseStore, tenantId: string, caseId: string, scope: DocumentRunScope, commands: Array<{ commandType: string; payload: Record<string, unknown> }>) {
  const records = commands.filter(command => command.commandType === "RecordCanonicalRecords").flatMap(command => Array.isArray(command.payload.records) ? command.payload.records.map(object) : []);
  if (!records.length) return;
  const result = await reader.query(`select distinct on (r.object_type,r.object_id) r.object_type,r.object_id,r.data from ${qualify(store.schemas.core, "canonical_records")} r
    join jsonb_to_recordset($3::jsonb) as ids(object_type text,object_id text) on ids.object_type=r.object_type and ids.object_id=r.object_id
    where r.tenant_id=$1 and r.case_id=$2 order by r.object_type,r.object_id,r.recorded_at desc,r.version_id desc`, [tenantId, caseId, JSON.stringify(records.map(record => ({ object_type: record.object_type, object_id: record.object_id })))]);
  if (result.rows.some(row => (row.object_type === "DocumentVersion" ? row.data.artifact_hash : row.data.document_version) !== scope.documentVersion)) throw new CaseStoreError("document.record_outside_scope", 403);
}
