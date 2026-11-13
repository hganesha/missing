import { contextPullRunScope, assertContextPullCommands } from "./context-pull.js";
import { blobContainerFromEnv, type BlobContainer } from "@ehf/blob-store";
import { verifyContextPackDigest, type ContextPack } from "@ehf/context-plane";
import { createHash, randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { z } from "zod";
import { bridgeOutcomeSchema } from "@ehf/fincrime-integration";
import { databaseAuth, isProductionProfile } from "@ehf/identity";
import {
  isProtectedBusinessCommand,
  canonicalRecordObjectType,
  caseSnapshotSchema,
  policyEvaluationSchema,
  stableDigest,
  type BusinessCommand,
  type ExecutionEnvelopeClaims,
  type CaseReadGrant,
  type ContextClassificationPolicy,
  type CaseActor,
  type CaseSnapshot,
  type CreateKycCaseRequest,
  type KycCaseStatus,
  type RegisterEvidenceRequest,
} from "@ehf/contracts";
import { caseStoreSchemas, qualify, type CaseStoreSchemas } from "./config.js";
import { documentFeedback, documentReviewSchema, validateDocumentReview, type DocumentFeedbackRow } from "./document-review.js";
import { DOCUMENT_EXTRACTION_REVIEW } from "@ehf/contracts";
import { documentAuthorizationSchema, assertDocumentPlan, assertDocumentSource, documentRunScope, assertDocumentCommands, assertDocumentRecordIdentities, type DocumentRunScope } from "./document-extraction.js";
import {
  CanonicalRecordError,
  isRecordSelector,
  projectCanonicalRecords,
  readCanonicalRecords,
  recordCanonicalRecords,
} from "./canonical-records.js";

import { isPolicyAuthorizedCommand, resolveCasePolicyContract } from "./business-decisions.js";
export { getBusinessPolicyHumanInput, getLatestDiligenceOutcome, getPublishedInstitutionCatalog, getStoredBusinessDecision, listBusinessDecisionReceipts, recordBusinessHumanResponse } from "./business-human.js";
export { dispatchBusinessEffect } from "./business-effects.js";
export { recordPolicySnapshotRead, verifyPolicySnapshotRead } from "./policy-snapshot-reads.js";
export { applyEvaluatedBusinessDecision } from "./business-decisions.js";

const { Pool } = pg;
export type CaseStoreDatabase = InstanceType<typeof Pool>;
export type Page<T> = { items: T[]; nextCursor: string | null };

function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(cursor: string | undefined): { at: string; id: string } | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { at?: unknown; id?: unknown };
    if (typeof value.at !== "string" || !Number.isFinite(Date.parse(value.at)) || typeof value.id !== "string" || !value.id) throw new Error();
    return { at: value.at, id: value.id };
  } catch {
    throw new CaseStoreError("pagination.cursor_invalid", 400);
  }
}

function pageLimit(value: number | undefined, maximum = 200): number {
  const limit = value ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximum) {
    throw new CaseStoreError("pagination.limit_invalid", 400);
  }
  return limit;
}

export type CaseStore = {
  db: CaseStoreDatabase;
  executionDb?: CaseStoreDatabase;
  schemas: CaseStoreSchemas;
  /** Where evidence bytes live: the database (development) or the evidence blob container. */
  artifactBackend: "postgres" | "object_store";
  evidenceBlobs?: BlobContainer;
  evidenceRequireScan: boolean;
  evidenceMaxBytes: number;
  ownsDatabase: boolean;
};

export class CaseStoreError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = "CaseStoreError";
  }
}

export function createCaseStore(options: {
  db?: CaseStoreDatabase;
  connectionString?: string;
  schemas?: CaseStoreSchemas;
  artifactBackend?: string;
  evidenceBlobs?: BlobContainer;
} = {}): CaseStore {
  const connectionString = options.connectionString ?? process.env.CASE_DATABASE_URL ?? process.env.DATABASE_URL;
  const artifactBackend = options.artifactBackend ?? process.env.CASE_ARTIFACT_BACKEND ?? "postgres";
  const evidenceMaxBytes = Number(process.env.CASE_EVIDENCE_MAX_BYTES ?? "1048576");
  if (artifactBackend !== "postgres" && artifactBackend !== "object_store") throw new Error(`case_store.artifact_backend_unsupported:${artifactBackend}`);
  // Regulated evidence needs immutable storage; the database backend is for development.
  if (artifactBackend === "postgres" && isProductionProfile()) throw new Error("case_store.evidence_blob_required_in_production");
  const evidenceBlobs = artifactBackend === "object_store" ? options.evidenceBlobs ?? blobContainerFromEnv("EVIDENCE") ?? undefined : undefined;
  if (artifactBackend === "object_store" && !evidenceBlobs) throw new Error("case_store.evidence_blob_missing");
  databaseAuth();
  if (isProductionProfile() && !process.env.EXECUTION_DATABASE_URL) throw new Error("policy.control_connection_required");
  if (!options.db && !connectionString) throw new Error("case_store.database_url_missing");
  if (!Number.isInteger(evidenceMaxBytes) || evidenceMaxBytes < 1) throw new Error("case_store.evidence_max_bytes_invalid");
  const poolMax = Number(process.env.DB_POOL_MAX ?? 5);
  if (!Number.isInteger(poolMax) || poolMax < 1 || poolMax > 100) throw new Error("database.pool_max_invalid");
  const connectionTimeoutMillis = Number(process.env.DB_CONNECT_TIMEOUT_MS ?? 5_000);
  const idleTimeoutMillis = Number(process.env.DB_IDLE_TIMEOUT_MS ?? 30_000);
  if (!Number.isInteger(connectionTimeoutMillis) || connectionTimeoutMillis < 100 || connectionTimeoutMillis > 120_000) {
    throw new Error("database.connect_timeout_invalid");
  }
  if (!Number.isInteger(idleTimeoutMillis) || idleTimeoutMillis < 1_000 || idleTimeoutMillis > 3_600_000) {
    throw new Error("database.idle_timeout_invalid");
  }
  return {
    db: options.db ?? new Pool({
      connectionString,
      max: poolMax,
      connectionTimeoutMillis,
      idleTimeoutMillis,
    }),
    ...(process.env.EXECUTION_DATABASE_URL ? { executionDb: new Pool({ connectionString: process.env.EXECUTION_DATABASE_URL,
      max: poolMax, connectionTimeoutMillis, idleTimeoutMillis }) } : {}),
    schemas: options.schemas ?? caseStoreSchemas(),
    artifactBackend: artifactBackend as CaseStore["artifactBackend"],
    ...(evidenceBlobs ? { evidenceBlobs } : {}),
    evidenceRequireScan: process.env.CASE_EVIDENCE_REQUIRE_SCAN === "true",
    evidenceMaxBytes,
    ownsDatabase: !options.db,
  };
}

function opaqueId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function normalizeDigest(value: string): string {
  return value.startsWith("sha256:") ? value.slice(7) : value;
}

function contentDigest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredString(value: unknown, field: string): string {
  return z.string().min(1).parse(value, { error: () => `${field}.required` });
}

function optionalString(value: unknown): string | null {
  return value === undefined || value === null ? null : z.string().min(1).parse(value);
}

function stringArray(value: unknown, field: string, minimum = 0): string[] {
  return z.array(z.string().min(1)).min(minimum).parse(value, { error: () => `${field}.invalid` });
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  return z.record(z.string(), z.unknown()).parse(value, { error: () => `${field}.invalid` });
}

function nowIso(): string {
  return new Date().toISOString();
}

function mapDate(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type CaseRow = {
  tenant_id: string;
  case_id: string;
  case_type: string;
  schema_version: string;
  jurisdiction: string;
  status: KycCaseStatus;
  case_sequence: string | number;
  decision_contract_version?: number;
  external_ref: string | null;
  policy_snapshot_digest: string;
  harness_plan_digest: string;
  dependency_digest?: string | null;
  policy_id?: string | null;
  policy_version?: string | null;
  policy_bundle_digest?: string | null;
  classification: string;
  created_by: CaseActor;
  created_at: Date;
  updated_at: Date;
};

function mapCase(row: CaseRow) {
  return {
    tenantId: row.tenant_id,
    caseId: row.case_id,
    caseType: row.case_type,
    schemaVersion: row.schema_version,
    jurisdiction: row.jurisdiction,
    status: row.status,
    caseSequence: Number(row.case_sequence),
    externalRef: row.external_ref,
    policySnapshotDigest: row.policy_snapshot_digest,
    harnessPlanDigest: row.harness_plan_digest,
    classification: row.classification,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

type EventInput = {
  tenantId: string;
  caseId: string;
  sequence: number;
  eventType: string;
  eventSchema: string;
  occurredAt: string;
  recordedAt: string;
  actor: CaseActor;
  commandId: string;
  authority: Record<string, unknown>;
  payload: Record<string, unknown>;
  evidenceRefs: string[];
  previousEventDigest: string | null;
  classification: string;
};

function canonicalInstant(value: string): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw new CaseStoreError("event.timestamp_invalid", 400);
  return instant.toISOString();
}

async function appendCaseEvent(
  client: PoolClient,
  store: CaseStore,
  input: EventInput,
): Promise<{ eventId: string; eventDigest: string }> {
  const eventId = opaqueId("evt");
  // The digest covers the timestamps as text, but PostgreSQL stores instants and every
  // reader (verifyCaseLedger, audit and segment exports) renders them back with
  // toISOString(). A caller's "2026-11-07T12:00:00Z" would read back as "…00.000Z" and the
  // event would look tampered with, so digest exactly the form that is read back.
  input = { ...input, occurredAt: canonicalInstant(input.occurredAt), recordedAt: canonicalInstant(input.recordedAt) };
  const envelope = {
    eventId,
    tenantId: input.tenantId,
    caseId: input.caseId,
    caseSequence: input.sequence,
    eventType: input.eventType,
    eventSchema: input.eventSchema,
    occurredAt: input.occurredAt,
    recordedAt: input.recordedAt,
    actor: input.actor,
    commandRef: input.commandId,
    authority: input.authority,
    payload: input.payload,
    evidenceRefs: input.evidenceRefs,
    previousEventDigest: input.previousEventDigest,
  };
  const eventDigest = stableDigest(envelope);
  // The only way into the ledger: append_event checks the chain (next sequence, linked to
  // the current head), then writes the event, the outbox row and the new head together.
  await client.query(`
    select ${qualify(store.schemas.ledger, "append_event")}(
      $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15,
      $16, $17, $18::jsonb)
  `, [
    input.tenantId, input.caseId, input.sequence, eventId, input.eventType, input.eventSchema,
    input.occurredAt, input.recordedAt, JSON.stringify(input.actor), input.commandId,
    JSON.stringify(input.authority), JSON.stringify(input.payload), JSON.stringify(input.evidenceRefs),
    input.previousEventDigest, eventDigest,
    opaqueId("outbox"), input.classification, JSON.stringify({
      eventId,
      tenantId: input.tenantId,
      caseId: input.caseId,
      caseSequence: input.sequence,
      eventType: input.eventType,
      recordedAt: input.recordedAt,
      evidenceRefs: input.evidenceRefs,
    }),
  ]);
  return { eventId, eventDigest };
}

export async function writeReceipt(
  client: PoolClient,
  store: CaseStore,
  input: {
    tenantId: string;
    caseId: string;
    commandId: string;
    commandType: string;
    idempotencyKey: string;
    requestDigest: string;
    sequence: number;
    identifiers: Record<string, string>;
    response: Record<string, unknown>;
    createdAt: string;
  },
): Promise<void> {
  const receipts = qualify(store.schemas.ledger, "command_receipts");
  await client.query(`
    insert into ${receipts}(
      tenant_id, case_id, command_id, command_type, idempotency_key, request_digest,
      outcome, accepted_sequence_from, accepted_sequence_to, created_identifiers,
      response, response_digest, created_at
    ) values ($1,$2,$3,$4,$5,$6,'ACCEPTED',$7,$7,$8::jsonb,$9::jsonb,$10,$11)
  `, [
    input.tenantId, input.caseId, input.commandId, input.commandType, input.idempotencyKey,
    input.requestDigest, input.sequence, JSON.stringify(input.identifiers), JSON.stringify(input.response),
    stableDigest(input.response), input.createdAt,
  ]);
}

export async function createKycCase(
  store: CaseStore,
  request: CreateKycCaseRequest,
  idempotencyKey: string,
): Promise<{ created: boolean; case: ReturnType<typeof mapCase>; eventId: string }> {
  if (!idempotencyKey) throw new CaseStoreError("case.idempotency_key_required", 400);
  const caseId = `case_${stableDigest({ tenantId: request.tenantId, idempotencyKey }).slice(0, 32)}`;
  const commandId = `cmd_${stableDigest({ caseId, idempotencyKey }).slice(0, 32)}`;
  const requestDigest = stableDigest(request);
  const cases = qualify(store.schemas.core, "cases");
  const receipts = qualify(store.schemas.ledger, "command_receipts");
  const client = await store.db.connect();
  try {
    await client.query("begin");
    await bindCaseTenant(client, request.tenantId);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`${request.tenantId}:${idempotencyKey}`]);
    const existingReceipt = await client.query<{ request_digest: string; response: { eventId: string } }>(`
      select request_digest, response from ${receipts}
      where tenant_id = $1 and case_id = $2 and idempotency_key = $3
    `, [request.tenantId, caseId, idempotencyKey]);
    if (existingReceipt.rows[0]) {
      if (existingReceipt.rows[0].request_digest !== requestDigest) {
        throw new CaseStoreError("case.idempotency_conflict", 409);
      }
      const row = await client.query<CaseRow>(`select * from ${cases} where tenant_id = $1 and case_id = $2`, [request.tenantId, caseId]);
      await client.query("commit");
      return { created: false, case: mapCase(row.rows[0]!), eventId: existingReceipt.rows[0].response.eventId };
    }

    const decisionContractVersion = await resolveCasePolicyContract(store, request.tenantId, request.harnessPlanDigest);
    if (isProductionProfile() && decisionContractVersion !== 2) throw new CaseStoreError("policy.business_contract_required", 403);
    const timestamp = nowIso();
    const inserted = await client.query<CaseRow>(`
      insert into ${cases}(
        tenant_id, case_id, case_type, schema_version, jurisdiction, status, case_sequence,
        external_ref, policy_snapshot_digest, harness_plan_digest, classification,
        created_by, created_at, updated_at, policy_id, policy_version, policy_bundle_digest, dependency_digest, decision_contract_version
      ) values ($1,$2,$3,$4,$5,'INTAKE',1,$6,$7,$8,$9,$10::jsonb,$11,$11,$12,$13,$14,$15,$16)
      returning *
    `, [
      request.tenantId, caseId, request.caseType, request.schemaVersion, request.jurisdiction,
      request.externalRef ?? null, normalizeDigest(request.policySnapshotDigest),
      normalizeDigest(request.harnessPlanDigest), request.classification, JSON.stringify(request.actor), timestamp,
      request.policyAuthority?.policyId ?? null, request.policyAuthority?.policyVersion ?? null,
      request.policyAuthority?.policyBundleDigest ?? null, request.policyAuthority?.dependencyDigest ?? null, decisionContractVersion,
    ]);
    const authority = {
      planDigest: normalizeDigest(request.harnessPlanDigest),
      policySnapshotDigest: normalizeDigest(request.policySnapshotDigest),
      permissionEnvelopeDigest: stableDigest({ action: "CreateCase", actor: request.actor }),
    };
    const event = await appendCaseEvent(client, store, {
      tenantId: request.tenantId,
      caseId,
      sequence: 1,
      eventType: "case.created",
      eventSchema: "kyc.case.created.v1",
      occurredAt: timestamp,
      recordedAt: timestamp,
      actor: request.actor,
      commandId,
      authority,
      payload: { caseType: request.caseType, jurisdiction: request.jurisdiction, status: "INTAKE" },
      evidenceRefs: [],
      previousEventDigest: null,
      classification: request.classification,
    });
    const response = { outcome: "ACCEPTED", caseId, caseSequence: 1, eventId: event.eventId };
    await writeReceipt(client, store, {
      tenantId: request.tenantId,
      caseId,
      commandId,
      commandType: "CreateCase",
      idempotencyKey,
      requestDigest,
      sequence: 1,
      identifiers: { caseId, eventId: event.eventId },
      response,
      createdAt: timestamp,
    });
    await client.query("commit");
    return { created: true, case: mapCase(inserted.rows[0]!), eventId: event.eventId };
  } catch (error) {
    await client.query("rollback");
    if (error instanceof CaseStoreError) throw error;
    if (error instanceof Error && "code" in error && error.code === "23505") {
      throw new CaseStoreError("case.conflict", 409, { constraint: String((error as { constraint?: string }).constraint ?? "unique") });
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Where an artifact's bytes go: a per-tenant, content-addressed name in the evidence container, or the database. */
/** The blob name prefix every artifact of a tenant lives under in the evidence container. */
export function tenantEvidencePrefix(tenantId: string): string {
  return `tenants/${stableDigest(tenantId).slice(0, 16)}/`;
}

function artifactPlacement(store: CaseStore, tenantId: string, digest: string): { artifactRef: string; blobName: string | null } {
  const tenantPartition = stableDigest(tenantId).slice(0, 16);
  const path = `${tenantPartition}/sha256/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
  if (store.artifactBackend !== "object_store") return { artifactRef: `artifact://postgres/${path}`, blobName: null };
  const blobName = `tenants/${path}`;
  return { artifactRef: `artifact://object-store/${store.evidenceBlobs!.account}/${store.evidenceBlobs!.container}/${blobName}`, blobName };
}

/**
 * An artifact's bytes, from wherever they live, checked against the digest the artifact was
 * registered with. A blob in another account or container than this store's is refused.
 */
export async function artifactBytes(store: CaseStore, row: {
  backend: string; content: Buffer | null; storage_account?: string | null; container?: string | null; blob_name?: string | null; digest: string;
}): Promise<Buffer> {
  let bytes: Buffer;
  if (row.backend === "postgres") {
    if (!row.content) throw new CaseStoreError("evidence.content_unavailable", 409);
    bytes = row.content;
  } else if (row.backend === "object_store") {
    const blobs = store.evidenceBlobs;
    if (!blobs || !row.blob_name || row.storage_account !== blobs.account || row.container !== blobs.container) {
      throw new CaseStoreError("evidence.content_unavailable", 409);
    }
    bytes = await blobs.get(row.blob_name).catch((error: unknown) => {
      if (error instanceof Error && error.message === "blob.not_found") throw new CaseStoreError("evidence.content_unavailable", 409);
      throw error;
    });
  } else {
    throw new CaseStoreError("evidence.content_unavailable", 409);
  }
  if (contentDigest(bytes) !== normalizeDigest(row.digest)) throw new CaseStoreError("evidence.integrity_failed", 500);
  return bytes;
}

export async function registerEvidence(
  store: CaseStore,
  request: RegisterEvidenceRequest,
  idempotencyKey: string,
  execution?: CaseExecutionAuthority,
): Promise<{ created: boolean; evidence: Record<string, unknown> }> {
  assertModelContextPromotion(request, execution);
  if (!idempotencyKey) throw new CaseStoreError("evidence.idempotency_key_required", 400);
  const cases = qualify(store.schemas.core, "cases");
  const artifacts = qualify(store.schemas.evidence, "artifacts");
  const evidenceObjects = qualify(store.schemas.evidence, "evidence_objects");
  const receipts = qualify(store.schemas.evidence, "registration_receipts");
  const evidenceOutbox = qualify(store.schemas.evidence, "outbox");
  const requestDigest = stableDigest(request);
  if (request.contentBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(request.contentBase64)) {
    throw new CaseStoreError("evidence.content_invalid", 400);
  }
  const content = Buffer.from(request.contentBase64, "base64");
  if (content.length === 0) throw new CaseStoreError("evidence.content_invalid", 400);
  if (content.length > store.evidenceMaxBytes) {
    throw new CaseStoreError("evidence.content_too_large", 413, { maxBytes: store.evidenceMaxBytes });
  }
  const digest = contentDigest(content);
  if (request.declaredDigest && normalizeDigest(request.declaredDigest) !== digest) {
    throw new CaseStoreError("evidence.digest_mismatch", 400, { computedDigest: digest });
  }
  const evidenceId = opaqueId("ev");
  const placement = artifactPlacement(store, request.tenantId, digest);
  const artifactRef = placement.artifactRef;
  // Bytes first, record second: content-addressed and never overwritten, so a retry or a crash
  // in between leaves at most an unreferenced blob, which reconciliation reports.
  const stored = placement.blobName
    ? await store.evidenceBlobs!.putImmutable(placement.blobName, content, { contentType: request.mediaType, sha256: digest })
    : null;
  const timestamp = nowIso();
  const client = await store.db.connect();
  let executionClient: PoolClient | undefined;
  try {
    if (execution && store.executionDb) {
      executionClient = await store.executionDb.connect();
      await executionClient.query("begin");
    }
    await client.query("begin");
    if (execution) await assertActiveCaseExecution(executionClient ?? client, execution, request.tenantId, request.caseId);
    await bindCaseTenant(client, request.tenantId);
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`${request.tenantId}:${idempotencyKey}`]);
    const prior = await client.query<{ request_digest: string; response: { evidence: Record<string, unknown> } }>(`
      select request_digest, response from ${receipts} where tenant_id = $1 and idempotency_key = $2
    `, [request.tenantId, idempotencyKey]);
    if (prior.rows[0]) {
      if (prior.rows[0].request_digest !== requestDigest) throw new CaseStoreError("evidence.idempotency_conflict", 409);
      await client.query("commit");
      return { created: false, evidence: prior.rows[0].response.evidence };
    }
    const caseResult = await client.query(`select harness_plan_digest from ${cases} where tenant_id = $1 and case_id = $2 for share`, [request.tenantId, request.caseId]);
    if (!caseResult.rows[0]) throw new CaseStoreError("case.not_found", 404);
    if (execution && normalizeDigest(caseResult.rows[0].harness_plan_digest) !== normalizeDigest(execution.plan_digest)) await documentRunScope(store, execution, client, executionClient ?? client);
    await client.query(`
      insert into ${artifacts}(
        tenant_id, artifact_digest, artifact_ref, backend, media_type, byte_length,
        content, encryption_metadata, immutability_state, storage_account, container, blob_name, blob_version_id, verified_at, created_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15)
      on conflict (tenant_id, artifact_digest) do nothing
    `, [
      request.tenantId, digest, artifactRef, store.artifactBackend, request.mediaType, content.length,
      stored ? null : content,
      JSON.stringify({ atRest: stored ? "storage-service-managed" : "database-managed" }),
      stored ? "PENDING_RETENTION" : "POC_CONTENT_ADDRESSED",
      stored?.account ?? null, stored?.container ?? null, stored?.name ?? null, stored?.versionId ?? null,
      stored ? timestamp : null, timestamp,
    ]);
    await client.query(`
      insert into ${evidenceObjects}(
        tenant_id, case_id, evidence_id, schema_version, evidence_type, source,
        subject_refs, trust, raw_digest, artifact_ref, classification, retention_class,
        residency, scan_status, verification_status, created_by, created_at
      ) values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,'POC_NOT_SCANNED','DIGEST_VERIFIED',$14::jsonb,$15)
    `, [
      request.tenantId, request.caseId, evidenceId, request.schemaVersion, request.type,
      JSON.stringify(request.source), JSON.stringify(request.subjectRefs), JSON.stringify(request.trust),
      digest, artifactRef, request.classification, request.retentionClass, request.residency,
      JSON.stringify(request.createdBy), timestamp,
    ]);
    const response = {
      created: true,
      evidence: {
        evidenceId,
        tenantId: request.tenantId,
        caseId: request.caseId,
        schemaVersion: request.schemaVersion,
        type: request.type,
        source: request.source,
        subjectRefs: request.subjectRefs,
        trust: request.trust,
        integrity: { rawDigest: digest, normalizedDigest: null, artifactRef },
        classification: request.classification,
        retentionClass: request.retentionClass,
        residency: request.residency,
        scanStatus: "POC_NOT_SCANNED",
        verificationStatus: "DIGEST_VERIFIED",
        createdBy: request.createdBy,
        createdAt: timestamp,
      },
    };
    await client.query(`
      insert into ${receipts}(
        tenant_id, idempotency_key, request_digest, evidence_id, response, response_digest, created_at
      ) values ($1,$2,$3,$4,$5::jsonb,$6,$7)
    `, [request.tenantId, idempotencyKey, requestDigest, evidenceId, JSON.stringify(response), stableDigest(response), timestamp]);
    await client.query(`
      insert into ${evidenceOutbox}(
        outbox_id, tenant_id, case_id, evidence_id, event_type, classification, payload, created_at
      ) values ($1,$2,$3,$4,'evidence.registered',$5,$6::jsonb,$7)
    `, [
      opaqueId("outbox"), request.tenantId, request.caseId, evidenceId, request.classification,
      JSON.stringify({ evidenceId, caseId: request.caseId, rawDigest: digest, artifactRef, verificationStatus: "DIGEST_VERIFIED" }), timestamp,
    ]);
    await client.query("commit");
    return response;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    if (executionClient) {
      try { await executionClient.query("rollback"); } finally { executionClient.release(); }
    }
  }
}

type MutationResult = {
  eventType: string;
  eventSchema: string;
  payload: Record<string, unknown>;
  evidenceRefs: string[];
  identifiers: Record<string, string>;
  nextStatus?: KycCaseStatus;
  lineage?: Array<{ sourceType: string; sourceId: string; predicate: string; targetType: string; targetId: string }>;
};

const allowedTransitions: Record<KycCaseStatus, KycCaseStatus[]> = {
  INTAKE: ["VALIDATING", "NEEDS_INFORMATION", "SUSPENDED"],
  VALIDATING: ["SCREENING", "NEEDS_INFORMATION", "SUSPENDED"],
  SCREENING: ["INVESTIGATING", "READY_FOR_DECISION", "NEEDS_INFORMATION", "SUSPENDED"],
  INVESTIGATING: ["SCREENING", "READY_FOR_DECISION", "NEEDS_INFORMATION", "HUMAN_REVIEW", "SUSPENDED"],
  READY_FOR_DECISION: ["QA_REVIEW", "HUMAN_REVIEW", "INVESTIGATING", "SUSPENDED"],
  QA_REVIEW: ["HUMAN_REVIEW", "READY_FOR_DECISION", "INVESTIGATING", "SUSPENDED"],
  HUMAN_REVIEW: ["APPROVED", "DECLINED", "INVESTIGATING", "NEEDS_INFORMATION", "SUSPENDED"],
  NEEDS_INFORMATION: ["VALIDATING", "SCREENING", "INVESTIGATING", "SUSPENDED"],
  SUSPENDED: ["VALIDATING", "SCREENING", "INVESTIGATING", "HUMAN_REVIEW", "CLOSED"],
  APPROVED: ["CLOSED"],
  DECLINED: ["CLOSED"],
  CLOSED: [],
};

async function applyMutation(
  client: PoolClient,
  store: CaseStore,
  command: BusinessCommand,
  current: CaseRow,
): Promise<MutationResult> {
  const core = store.schemas.core;
  const evidenceSchema = store.schemas.evidence;
  const p = command.payload;
  const timestamp = nowIso();
  const classification = optionalString(p.classification) ?? current.classification;

  switch (command.commandType) {
    case "RecordCanonicalRecords": {
      await ensureLinkedEvidence(client, store, command, Array.isArray(p.evidenceRefs) ? p.evidenceRefs.map(String) : []);
      const { versions, evidenceRefs } = await recordCanonicalRecords(client, store.schemas, command, {
        recordedAt: timestamp,
        caseSequence: Number(current.case_sequence) + 1,
        observationsOnly: current.decision_contract_version === 2,
      });
      const recorded = versions.filter((version) => version.outcome === "RECORDED");
      return {
        eventType: "records.recorded",
        eventSchema: "harness.canonical_records.recorded.v1",
        payload: { records: versions, recordedCount: recorded.length, unchangedCount: versions.length - recorded.length },
        evidenceRefs,
        identifiers: { recordCount: String(versions.length) },
        lineage: evidenceRefs.flatMap((evidenceId) => recorded.map((version) => ({
          sourceType: "Evidence", sourceId: evidenceId, predicate: "NORMALIZED_INTO",
          targetType: "CanonicalRecord", targetId: `${version.objectType}:${version.objectId}@${version.versionId}`,
        }))),
      };
    }
    case 'RecordFinancialCrimeOutcome': {
      const outcome=bridgeOutcomeSchema.parse(p.outcome), scope=outcome.scope;
      if(scope.tenant_id!==command.tenantId || scope.case_id!==command.caseId
        || normalizeDigest(scope.plan_digest)!==normalizeDigest(command.authority.planDigest)
        || scope.case_sequence>Number(current.case_sequence)) throw new CaseStoreError('fincrime.outcome_basis_invalid',409);
      const outcomeDigest=stableDigest(outcome),table=qualify(core,'financial_crime_outcomes');
      await client.query(`insert into ${table}(tenant_id,case_id,work_item_id,execution_id,skill_id,skill_version,basis_case_sequence,
        outcome,outcome_digest,context_digest,recorded_by,recorded_at) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb,$12)
        on conflict do nothing`,[command.tenantId,command.caseId,scope.work_item_id,scope.execution_id,scope.skill_id,scope.skill_version,
        scope.case_sequence,JSON.stringify(outcome),outcomeDigest,outcome.context_hash,JSON.stringify(command.actor),timestamp]);
      const prior=(await client.query(`select outcome_digest from ${table} where tenant_id=$1 and case_id=$2 and work_item_id=$3 and execution_id=$4`,
        [command.tenantId,command.caseId,scope.work_item_id,scope.execution_id])).rows[0];
      if(prior?.outcome_digest!==outcomeDigest) throw new CaseStoreError('fincrime.outcome_conflict',409);
      return {eventType:'fincrime.outcome.recorded',eventSchema:'fincrime.ehf.outcome.v1',evidenceRefs:[],
        identifiers:{workItemId:scope.work_item_id,executionId:scope.execution_id},
        payload:{skillId:scope.skill_id,skillVersion:scope.skill_version,outcomeDigest,status:outcome.status,
          basisCaseSequence:scope.case_sequence,contextDigest:outcome.context_hash,effectsCommitted:false}};
    }
    case "RecordPolicyEvaluation": {
      if (command.actor.type !== "SYSTEM" || command.actor.principalId !== "policy-evaluator") {
        throw new CaseStoreError("policy.evaluator_authority_required", 403);
      }
      const evaluation = policyEvaluationSchema.parse(p.evaluation);
      const { receiptDigest, ...unsigned } = evaluation;
      if (stableDigest(unsigned) !== normalizeDigest(receiptDigest)
        || evaluation.tenantId !== command.tenantId || evaluation.caseId !== command.caseId
        || evaluation.caseSequence !== Number(current.case_sequence)
        || normalizeDigest(evaluation.policyBundleDigest) !== normalizeDigest(current.policy_bundle_digest ?? "")) {
        throw new CaseStoreError("policy.evaluation_authority_mismatch", 409);
      }
      await client.query(`insert into ${qualify(core, "policy_evaluations")}
        (tenant_id,case_id,evaluation_id,receipt_digest,case_sequence,document)
        values ($1,$2,$3,$4,$5,$6::jsonb)`, [command.tenantId, command.caseId, evaluation.evaluationId,
        receiptDigest, evaluation.caseSequence, JSON.stringify(evaluation)]);
      return { eventType: "policy.evaluated", eventSchema: "harness.policy.evaluated.v1",
        payload: { evaluationId: evaluation.evaluationId, receiptDigest, gateId: evaluation.gateId, outcome: evaluation.outcome },
        evidenceRefs: evaluation.evidenceRefs, identifiers: { evaluationId: evaluation.evaluationId } };
    }
    case "AddSubject": {
      const subjectId = optionalString(p.subjectId) ?? opaqueId("subject");
      const subjectType = z.enum(["individual", "legal_entity"]).parse(p.subjectType);
      const attributes = objectValue(p.attributes ?? {}, "attributes");
      const identifiers = z.array(z.object({
        identifierType: z.string().min(1),
        value: z.string().min(1),
        maskedValue: z.string().optional(),
        source: z.string().min(1),
        classification: z.string().min(1).optional(),
      }).strict()).default([]).parse(p.identifiers);
      await client.query(`
        insert into ${qualify(core, "case_subjects")}(
          tenant_id, case_id, subject_id, subject_type, schema_version, display_name,
          attributes, classification, created_by, created_at, updated_at
        ) values ($1,$2,$3,$4,'kyc.subject.v1',$5,$6::jsonb,$7,$8::jsonb,$9,$9)
      `, [command.tenantId, command.caseId, subjectId, subjectType, optionalString(p.displayName), JSON.stringify(attributes), classification, JSON.stringify(command.actor), timestamp]);
      for (const identifier of identifiers) {
        await client.query(`
          insert into ${qualify(core, "case_subject_identifiers")}(
            tenant_id, case_id, subject_id, identifier_id, identifier_type, value_digest,
            masked_value, source, classification, created_by, created_at
          ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11)
        `, [
          command.tenantId, command.caseId, subjectId, opaqueId("identifier"), identifier.identifierType,
          stableDigest(identifier.value), identifier.maskedValue ?? null, identifier.source,
          identifier.classification ?? classification, JSON.stringify(command.actor), timestamp,
        ]);
      }
      return {
        eventType: "subject.created",
        eventSchema: "kyc.subject.created.v1",
        payload: { subjectId, subjectType, revision: 1, identifierCount: identifiers.length },
        evidenceRefs: [],
        identifiers: { subjectId },
      };
    }
    case "LinkEvidence": {
      const evidenceId = requiredString(p.evidenceId, "evidenceId");
      const evidence = await client.query<{ verification_status: string; scan_status: string }>(`
        select verification_status, scan_status from ${qualify(evidenceSchema, "evidence_objects")}
        where tenant_id = $1 and case_id = $2 and evidence_id = $3
      `, [command.tenantId, command.caseId, evidenceId]);
      if (!evidence.rows[0]) throw new CaseStoreError("evidence.not_found", 404);
      if (evidence.rows[0].verification_status !== "DIGEST_VERIFIED") throw new CaseStoreError("evidence.not_verified", 409);
      if (store.evidenceRequireScan && evidence.rows[0].scan_status !== "VERIFIED_CLEAN") {
        throw new CaseStoreError("evidence.scan_required", 409);
      }
      await client.query(`
        insert into ${qualify(core, "case_evidence_refs")}(
          tenant_id, case_id, evidence_id, purpose, status, linked_by, linked_at, policy_snapshot_digest
        ) values ($1,$2,$3,$4,'ACCEPTED',$5::jsonb,$6,$7)
        on conflict (tenant_id, case_id, evidence_id) do nothing
      `, [command.tenantId, command.caseId, evidenceId, requiredString(p.purpose, "purpose"), JSON.stringify(command.actor), timestamp, normalizeDigest(command.authority.policySnapshotDigest)]);
      return {
        eventType: "evidence.linked",
        eventSchema: "kyc.evidence.linked.v1",
        payload: { evidenceId, purpose: p.purpose, status: "ACCEPTED" },
        evidenceRefs: [evidenceId],
        identifiers: { evidenceId },
      };
    }
    case "ProposeClaim": {
      const claimId = optionalString(p.claimId) ?? opaqueId("claim");
      const evidenceRefs = stringArray(p.evidenceRefs ?? [], "evidenceRefs", 1);
      await ensureLinkedEvidence(client, store, command, evidenceRefs);
      await client.query(`
        insert into ${qualify(core, "case_claims")}(
          tenant_id, case_id, claim_id, schema_version, subject_ref, predicate, value,
          asserted_by, evidence_refs, confidence, status, classification, created_at, updated_at
        ) values ($1,$2,$3,'harness.claim.v1',$4,$5,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,'PROPOSED',$10,$11,$11)
      `, [
        command.tenantId, command.caseId, claimId, optionalString(p.subjectRef), requiredString(p.predicate, "predicate"),
        JSON.stringify(p.value), JSON.stringify(command.actor), JSON.stringify(evidenceRefs),
        JSON.stringify(p.confidence ?? null), classification, timestamp,
      ]);
      return {
        eventType: "claim.proposed",
        eventSchema: "kyc.claim.proposed.v1",
        payload: { claimId, predicate: p.predicate, subjectRef: p.subjectRef ?? null },
        evidenceRefs,
        identifiers: { claimId },
        lineage: evidenceRefs.map((evidenceId) => ({
          sourceType: "Evidence", sourceId: evidenceId, predicate: "ASSERTS", targetType: "Claim", targetId: claimId,
        })),
      };
    }
    case "AcceptClaimAsFact": {
      const claimRefs = stringArray(p.claimRefs, "claimRefs", 1);
      const claims = await client.query<{ claim_id: string; subject_ref: string | null; predicate: string; value: unknown }>(`
        select claim_id, subject_ref, predicate, value from ${qualify(core, "case_claims")}
        where tenant_id = $1 and case_id = $2 and claim_id = any($3::text[])
      `, [command.tenantId, command.caseId, claimRefs]);
      if (claims.rowCount !== claimRefs.length) throw new CaseStoreError("claim.not_found", 404);
      const source = claims.rows[0]!;
      const factId = optionalString(p.factId) ?? opaqueId("fact");
      await client.query(`
        insert into ${qualify(core, "case_facts")}(
          tenant_id, case_id, fact_id, schema_version, subject_ref, predicate, value,
          basis_claim_refs, acceptance_policy_ref, purpose, valid_from, valid_to,
          recorded_at, status, classification, created_by
        ) values ($1,$2,$3,'harness.fact.v1',$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12,'ACTIVE',$13,$14::jsonb)
      `, [
        command.tenantId, command.caseId, factId, optionalString(p.subjectRef) ?? source.subject_ref,
        optionalString(p.predicate) ?? source.predicate, JSON.stringify(p.value ?? source.value), JSON.stringify(claimRefs),
        requiredString(p.acceptancePolicyRef, "acceptancePolicyRef"), requiredString(p.purpose, "purpose"),
        optionalString(p.validFrom), optionalString(p.validTo), timestamp, classification, JSON.stringify(command.actor),
      ]);
      await client.query(`
        update ${qualify(core, "case_claims")} set status = 'ACCEPTED', updated_at = $4
        where tenant_id = $1 and case_id = $2 and claim_id = any($3::text[])
      `, [command.tenantId, command.caseId, claimRefs, timestamp]);
      return {
        eventType: "claim.accepted_as_fact",
        eventSchema: "kyc.claim.accepted_as_fact.v1",
        payload: { factId, claimRefs, predicate: optionalString(p.predicate) ?? source.predicate },
        evidenceRefs: [],
        identifiers: { factId },
        lineage: claimRefs.map((claimId) => ({
          sourceType: "Claim", sourceId: claimId, predicate: "ACCEPTED_AS", targetType: "Fact", targetId: factId,
        })),
      };
    }
    case "RecordScreeningFinding": {
      const evidenceRefs = stringArray(p.evidenceRefs ?? [], "evidenceRefs");
      const factRefs = stringArray(p.factRefs ?? [], "factRefs");
      if (evidenceRefs.length + factRefs.length === 0) throw new CaseStoreError("finding.basis_required", 400);
      await ensureLinkedEvidence(client, store, command, evidenceRefs);
      const findingId = optionalString(p.findingId) ?? opaqueId("finding");
      await client.query(`
        insert into ${qualify(core, "case_findings")}(
          tenant_id, case_id, finding_id, schema_version, finding_type, subject_ref,
          classification, confidence, uncertainty, reason, evidence_refs, fact_refs,
          policy_relevance, status, created_by, created_at, updated_at
        ) values ($1,$2,$3,'kyc.finding.v1',$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10::jsonb,$11::jsonb,$12,'ACTIVE',$13::jsonb,$14,$14)
      `, [
        command.tenantId, command.caseId, findingId, requiredString(p.findingType, "findingType"),
        optionalString(p.subjectRef), classification, JSON.stringify(p.confidence ?? null),
        JSON.stringify(p.uncertainty ?? null), requiredString(p.reason, "reason"), JSON.stringify(evidenceRefs),
        JSON.stringify(factRefs), optionalString(p.policyRelevance), JSON.stringify(command.actor), timestamp,
      ]);
      return {
        eventType: "finding.created",
        eventSchema: "kyc.finding.created.v1",
        payload: { findingId, classification: p.findingType, subjectRef: p.subjectRef ?? null },
        evidenceRefs,
        identifiers: { findingId },
        lineage: [
          ...evidenceRefs.map((evidenceId) => ({
            sourceType: "Evidence", sourceId: evidenceId, predicate: "SUPPORTS", targetType: "Finding", targetId: findingId,
          })),
          ...factRefs.map((factId) => ({
            sourceType: "Fact", sourceId: factId, predicate: "SUPPORTS", targetType: "Finding", targetId: findingId,
          })),
        ],
      };
    }
    case "RecordAssumption": {
      const assumptionId = optionalString(p.assumptionId) ?? opaqueId("assumption");
      await client.query(`
        insert into ${qualify(core, "case_assumptions")}(
          tenant_id, case_id, assumption_id, proposition, materiality, basis_refs,
          status, classification, created_by, created_at, updated_at
        ) values ($1,$2,$3,$4,$5,$6::jsonb,'UNVERIFIED',$7,$8::jsonb,$9,$9)
      `, [
        command.tenantId, command.caseId, assumptionId, requiredString(p.proposition, "proposition"),
        requiredString(p.materiality, "materiality"), JSON.stringify(stringArray(p.basisRefs ?? [], "basisRefs")),
        classification, JSON.stringify(command.actor), timestamp,
      ]);
      return {
        eventType: "assumption.recorded",
        eventSchema: "kyc.assumption.recorded.v1",
        payload: { assumptionId, materiality: p.materiality },
        evidenceRefs: [],
        identifiers: { assumptionId },
      };
    }
    case "RaiseContradiction": {
      const contradictionId = optionalString(p.contradictionId) ?? opaqueId("contradiction");
      const objectRefs = stringArray(p.objectRefs, "objectRefs", 2);
      await client.query(`
        insert into ${qualify(core, "case_contradictions")}(
          tenant_id, case_id, contradiction_id, object_refs, description, materiality,
          detection_method, status, classification, created_by, created_at, updated_at
        ) values ($1,$2,$3,$4::jsonb,$5,$6,$7,'OPEN',$8,$9::jsonb,$10,$10)
      `, [
        command.tenantId, command.caseId, contradictionId, JSON.stringify(objectRefs),
        requiredString(p.description, "description"), requiredString(p.materiality, "materiality"),
        requiredString(p.detectionMethod, "detectionMethod"), classification, JSON.stringify(command.actor), timestamp,
      ]);
      return {
        eventType: "contradiction.raised",
        eventSchema: "kyc.contradiction.raised.v1",
        payload: { contradictionId, objectRefs, materiality: p.materiality },
        evidenceRefs: [],
        identifiers: { contradictionId },
      };
    }
    case "ResolveContradiction": {
      const contradictionId = requiredString(p.contradictionId, "contradictionId");
      const status = z.enum(["RESOLVED", "ACCEPTED_RISK", "SUPERSEDED"]).parse(p.status);
      const result = await client.query(`
        update ${qualify(core, "case_contradictions")}
        set status = $4, resolution = $5::jsonb, updated_at = $6
        where tenant_id = $1 and case_id = $2 and contradiction_id = $3 and status in ('OPEN','UNDER_INVESTIGATION')
      `, [command.tenantId, command.caseId, contradictionId, status, JSON.stringify(objectValue(p.resolution, "resolution")), timestamp]);
      if (result.rowCount !== 1) throw new CaseStoreError("contradiction.not_open", 409);
      return {
        eventType: "contradiction.resolved",
        eventSchema: "kyc.contradiction.resolved.v1",
        payload: { contradictionId, status },
        evidenceRefs: stringArray(p.evidenceRefs ?? [], "evidenceRefs"),
        identifiers: { contradictionId },
      };
    }
    case "ProposeWorkItem": {
      const workItemId = optionalString(p.workItemId) ?? opaqueId("work");
      await client.query(`
        insert into ${qualify(core, "case_work_items")}(
          tenant_id, case_id, work_item_id, work_type, status, priority, assigned_to,
          required_capability, due_at, classification, created_by, created_at, updated_at, description, subject_ref
        ) values ($1,$2,$3,$4,'OPEN',$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11,$11,$12,$13)
      `, [
        command.tenantId, command.caseId, workItemId, requiredString(p.workType, "workType"),
        optionalString(p.priority) ?? "NORMAL", JSON.stringify(p.assignedTo ?? null), optionalString(p.requiredCapability),
        optionalString(p.dueAt), classification, JSON.stringify(command.actor), timestamp,
        optionalString(p.description) ?? null, optionalString(p.subjectRef) ?? null,
      ]);
      return {
        eventType: "work_item.created",
        eventSchema: "harness.work_item.created.v1",
        // A skill's unresolved question (skill.execution.v1 §6.2) carries its text as the description.
        payload: { workItemId, workType: p.workType, status: "OPEN", ...(optionalString(p.description) ? { description: optionalString(p.description) } : {}),
          ...(optionalString(p.subjectRef) ? { subjectRef: optionalString(p.subjectRef) } : {}) },
        evidenceRefs: [],
        identifiers: { workItemId },
      };
    }
    case "CompleteWorkItem": {
      const workItemId = requiredString(p.workItemId, "workItemId");
      const resultRefs = stringArray(p.resultRefs ?? [], "resultRefs");
      const result = await client.query(`
        update ${qualify(core, "case_work_items")}
        set status = 'COMPLETED', result_refs = $4::jsonb, updated_at = $5
        where tenant_id = $1 and case_id = $2 and work_item_id = $3 and status = 'OPEN'
      `, [command.tenantId, command.caseId, workItemId, JSON.stringify(resultRefs), timestamp]);
      if (result.rowCount !== 1) throw new CaseStoreError("work_item.not_open", 409);
      return {
        eventType: "work_item.completed",
        eventSchema: "harness.work_item.completed.v1",
        payload: { workItemId, resultRefs },
        evidenceRefs: [],
        identifiers: { workItemId },
      };
    }
    case "ReplanCase": {
      // The control plane moves the case onto the process its policy escalated it to: only while the
      // escalation's work item is open, which this completes in the same transaction. Nothing else in
      // the case changes; later work runs under the new pin.
      const replan = z.object({
        harnessPlanDigest: z.string().regex(/^(sha256:)?[a-f0-9]{64}$/),
        policySnapshotDigest: z.string().regex(/^(sha256:)?[a-f0-9]{64}$/),
        policyAuthority: z.object({ policyId: z.string().min(1).max(200), policyVersion: z.string().min(1).max(100),
          policyBundleDigest: z.string().regex(/^(sha256:)?[a-f0-9]{64}$/), dependencyDigest: z.string().regex(/^(sha256:)?[a-f0-9]{64}$/) }).strict(),
        workItemId: z.string().min(1).max(200),
        reason: z.string().min(1).max(500),
        requestedBy: z.string().min(1).max(200),
      }).strict().parse(p);
      if (["APPROVED", "DECLINED", "CLOSED"].includes(current.status)) throw new CaseStoreError("replan.case_final", 409);
      const from = normalizeDigest(current.harness_plan_digest);
      const to = normalizeDigest(replan.harnessPlanDigest);
      if (from === to) throw new CaseStoreError("replan.same_plan", 409);
      const escalation = await client.query(`
        update ${qualify(core, "case_work_items")} set status = 'COMPLETED', result_refs = $4::jsonb, updated_at = $5
        where tenant_id = $1 and case_id = $2 and work_item_id = $3 and status = 'OPEN' and work_type = 'EDD_ESCALATION'
      `, [command.tenantId, command.caseId, replan.workItemId, JSON.stringify([`plan:${to}`]), timestamp]);
      if (escalation.rowCount !== 1) throw new CaseStoreError("replan.escalation_not_open", 409);
      const decisionContractVersion = await resolveCasePolicyContract(store, command.tenantId, to);
      if (isProductionProfile() && decisionContractVersion !== 2) throw new CaseStoreError("policy.business_contract_required", 403);
      await client.query(`
        update ${qualify(core, "cases")} set harness_plan_digest = $3, policy_snapshot_digest = $4, policy_id = $5, policy_version = $6,
          policy_bundle_digest = $7, dependency_digest = $8, decision_contract_version = $9, updated_at = $10
        where tenant_id = $1 and case_id = $2
      `, [command.tenantId, command.caseId, to, normalizeDigest(replan.policySnapshotDigest), replan.policyAuthority.policyId,
        replan.policyAuthority.policyVersion, replan.policyAuthority.policyBundleDigest, replan.policyAuthority.dependencyDigest,
        decisionContractVersion, timestamp]);
      return {
        eventType: "case.replanned",
        eventSchema: "harness.case.replanned.v1",
        payload: { fromPlanDigest: from, toPlanDigest: to, fromPolicySnapshotDigest: normalizeDigest(current.policy_snapshot_digest),
          toPolicySnapshotDigest: normalizeDigest(replan.policySnapshotDigest), policyAuthority: replan.policyAuthority,
          workItemId: replan.workItemId, reason: replan.reason, requestedBy: replan.requestedBy },
        evidenceRefs: [],
        identifiers: { workItemId: replan.workItemId, planDigest: to },
      };
    }
    case "LinkExecution": {
      const runId = requiredString(p.runId, "runId");
      await client.query(`
        insert into ${qualify(core, "case_execution_refs")}(
          tenant_id, case_id, run_id, plan_digest, trace_id, purpose, linked_by, linked_at
        ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
        on conflict (tenant_id, case_id, run_id) do nothing
      `, [
        command.tenantId, command.caseId, runId, normalizeDigest(requiredString(p.planDigest, "planDigest")),
        optionalString(p.traceId), requiredString(p.purpose, "purpose"), JSON.stringify(command.actor), timestamp,
      ]);
      return {
        eventType: "execution.linked",
        eventSchema: "harness.execution.linked.v1",
        payload: { runId, traceId: p.traceId ?? null, purpose: p.purpose },
        evidenceRefs: [],
        identifiers: { runId },
      };
    }
    case "SubmitDecisionRecommendation": {
      const recommendationId = optionalString(p.recommendationId) ?? opaqueId("recommendation");
      const findingRefs = stringArray(p.findingRefs ?? [], "findingRefs");
      const evidenceRefs = stringArray(p.evidenceRefs ?? [], "evidenceRefs");
      if (findingRefs.length + evidenceRefs.length === 0) throw new CaseStoreError("recommendation.basis_required", 400);
      await client.query(`
        insert into ${qualify(core, "case_decision_recommendations")}(
          tenant_id, case_id, recommendation_id, outcome, case_sequence, rationale,
          finding_refs, evidence_refs, policy_rule_refs, confidence, requires_human_review,
          policy_snapshot_digest, status, classification, created_by, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12,'PROPOSED',$13,$14::jsonb,$15)
      `, [
        command.tenantId, command.caseId, recommendationId, z.enum(["APPROVE", "DECLINE", "REVIEW"]).parse(p.outcome),
        Number(current.case_sequence), requiredString(p.rationale, "rationale"), JSON.stringify(findingRefs),
        JSON.stringify(evidenceRefs), JSON.stringify(stringArray(p.policyRuleRefs ?? [], "policyRuleRefs")),
        p.confidence === undefined ? null : z.number().min(0).max(1).parse(p.confidence),
        p.requiresHumanReview === undefined ? null : z.boolean().parse(p.requiresHumanReview),
        normalizeDigest(command.authority.policySnapshotDigest), classification, JSON.stringify(command.actor), timestamp,
      ]);
      return {
        eventType: "decision.recommendation_submitted",
        eventSchema: "kyc.decision.recommendation_submitted.v1",
        payload: { recommendationId, outcome: p.outcome, basedOnSequence: Number(current.case_sequence) },
        evidenceRefs,
        identifiers: { recommendationId },
        lineage: findingRefs.map((findingId) => ({
          sourceType: "Finding", sourceId: findingId, predicate: "SUPPORTS", targetType: "DecisionRecommendation", targetId: recommendationId,
        })),
      };
    }
    case "RecordGateResult": {
      const gateResultId = optionalString(p.gateResultId) ?? opaqueId("gate");
      const recommendationRef = requiredString(p.recommendationRef, "recommendationRef");
      const recommendation = await client.query(`
        select 1 from ${qualify(core, "case_decision_recommendations")}
        where tenant_id = $1 and case_id = $2 and recommendation_id = $3
      `, [command.tenantId, command.caseId, recommendationRef]);
      if (!recommendation.rows[0]) throw new CaseStoreError("recommendation.not_found", 404);
      const decision = z.enum(["AUTHORIZED", "DENIED"]).parse(p.decision);
      await client.query(`
        insert into ${qualify(core, "case_gate_results")}(
          tenant_id, case_id, gate_result_id, recommendation_ref, decision, case_sequence,
          rule_results, policy_snapshot_digest, created_by, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9::jsonb,$10)
      `, [
        command.tenantId, command.caseId, gateResultId, recommendationRef, decision, Number(current.case_sequence),
        JSON.stringify(z.array(z.record(z.string(), z.unknown())).min(1).parse(p.ruleResults)),
        normalizeDigest(command.authority.policySnapshotDigest), JSON.stringify(command.actor), timestamp,
      ]);
      return {
        eventType: "decision.gate_recorded",
        eventSchema: "kyc.decision.gate_recorded.v1",
        payload: { gateResultId, recommendationRef, decision, basedOnSequence: Number(current.case_sequence) },
        evidenceRefs: [],
        identifiers: { gateResultId },
        lineage: [{
          sourceType: "DecisionRecommendation", sourceId: recommendationRef, predicate: "EVALUATED_BY",
          targetType: "DecisionGateResult", targetId: gateResultId,
        }],
      };
    }
    case "RecordQAResult": {
      const qaResultId = optionalString(p.qaResultId) ?? opaqueId("qa");
      const recommendationRef = requiredString(p.recommendationRef, "recommendationRef");
      const recommendation = await client.query<{ created_by: CaseActor }>(`
        select created_by from ${qualify(core, "case_decision_recommendations")}
        where tenant_id = $1 and case_id = $2 and recommendation_id = $3
      `, [command.tenantId, command.caseId, recommendationRef]);
      if (!recommendation.rows[0]) throw new CaseStoreError("recommendation.not_found", 404);
      if (recommendation.rows[0].created_by.principalId === command.actor.principalId) {
        throw new CaseStoreError("qa.separation_of_duties_required", 403);
      }
      const outcome = z.enum(["PASS", "FAIL", "UNKNOWN", "ERROR"]).parse(p.outcome);
      await client.query(`
        insert into ${qualify(core, "case_reviews")}(
          tenant_id, case_id, review_id, review_type, outcome, object_ref, rationale,
          viewed_evidence_refs, reviewer, created_at
        ) values ($1,$2,$3,'SEMANTIC_QA',$4,$5,$6,$7::jsonb,$8::jsonb,$9)
      `, [
        command.tenantId, command.caseId, qaResultId, outcome, recommendationRef,
        requiredString(p.rationale, "rationale"), JSON.stringify(stringArray(p.evidenceRefs ?? [], "evidenceRefs")),
        JSON.stringify(command.actor), timestamp,
      ]);
      return {
        eventType: "qa.result_recorded",
        eventSchema: "kyc.qa.result_recorded.v1",
        payload: { qaResultId, recommendationRef, outcome },
        evidenceRefs: stringArray(p.evidenceRefs ?? [], "evidenceRefs"),
        identifiers: { qaResultId },
      };
    }
    case "RecordReview": {
      const reviewId = optionalString(p.reviewId) ?? opaqueId("review");
      let documentReview;
      let feedback: DocumentFeedbackRow[] = [];
      let documentAuthorization: DocumentRunScope | undefined;
      if (p.reviewType === DOCUMENT_EXTRACTION_REVIEW) {
        const parsed = documentAuthorizationSchema.safeParse(p.documentRunAuthorization);
        if (!parsed.success || command.actor.type !== "HUMAN" || p.objectRef !== parsed.data.documentId) throw new CaseStoreError("document.authorization_invalid", 400);
        documentAuthorization = parsed.data;
        await assertDocumentPlan(store, command.tenantId, documentAuthorization.planDigest, store.executionDb ?? client);
        await assertDocumentSource(client, store, command.tenantId, command.caseId, documentAuthorization);
        const records = await readCanonicalRecords(client, store.schemas, command.tenantId, command.caseId, { asOf: timestamp, knowledgeCutoff: timestamp });
        const matching = (records.DocumentVersion ?? []).some(record => record.data.document_id === parsed.data.documentId && record.data.artifact_hash === parsed.data.documentVersion);
        if (!matching && documentAuthorization.documentId !== `doc_${documentAuthorization.documentVersion.slice(0,24)}`) throw new CaseStoreError("document.version_conflict", 409);
      }
      if (p.reviewType === "DOCUMENT_EXTRACTION") {
        const parsedReview = documentReviewSchema.safeParse(p.documentReview);
        if (!parsedReview.success) throw new CaseStoreError("document.review_invalid", 400);
        documentReview = parsedReview.data;
        if (command.actor.type !== "HUMAN") throw new CaseStoreError("authorization.interactive_user_required", 403);
        if (p.objectRef !== documentReview.documentId) throw new CaseStoreError("document.review_invalid", 400);
        const records = await readCanonicalRecords(client, store.schemas, command.tenantId, command.caseId, { asOf: timestamp, knowledgeCutoff: timestamp });
        let assertions;
        try { assertions = validateDocumentReview(documentReview, records); }
        catch (error) { throw new CaseStoreError(error instanceof Error ? error.message : "document.review_invalid", 409); }
        if (documentReview.entries.some(entry => entry.assertionId === null && entry.outcome === "CHECKED")) {
          const prior = await client.query<{ details: { documentVersion: string; entries: Array<{ assertionId: string; assertionVersion: string; outcome: string }> } }>(
            `select details from ${qualify(core, "case_reviews")} where tenant_id=$1 and case_id=$2 and review_type='DOCUMENT_EXTRACTION' and object_ref=$3 order by coalesce((details->>'recordedSequence')::bigint,0), created_at, review_id`,
            [command.tenantId, command.caseId, documentReview.documentId]);
          const checked = new Map<string, { assertionVersion: string | null; outcome: string }>();
          for (const row of prior.rows) if (row.details?.documentVersion === documentReview.documentVersion) for (const entry of row.details.entries) checked.set(entry.assertionId, entry);
          for (const entry of documentReview.entries) if (entry.assertionId) checked.set(entry.assertionId, entry);
          if (!assertions.length || assertions.some(assertion => { const entry = checked.get(assertion.object_id); return !entry || entry.assertionVersion !== assertion.version_id || !["CHECKED", "CORRECTED"].includes(entry.outcome); })) throw new CaseStoreError("document.review_incomplete", 409);
        }
        // A route conflict is resolved by a decision on its assertion in this review (factory plan Phase 4).
        const conflicts = new Map<string, string[]>();
        for (const workItemId of documentReview.resolvedWorkItems ?? []) {
          const item = (await client.query<{ work_type: string; status: string; subject_ref: string | null }>(
            `select work_type, status, subject_ref from ${qualify(core, "case_work_items")} where tenant_id=$1 and case_id=$2 and work_item_id=$3 for update`,
            [command.tenantId, command.caseId, workItemId])).rows[0];
          if (!item || item.status !== "OPEN") throw new CaseStoreError("work_item.not_open", 409);
          const entry = documentReview.entries.find(candidate => candidate.assertionId !== null && candidate.assertionId === item.subject_ref);
          if (item.work_type !== "DOCUMENT_FIELD_CONFLICT" || !entry || entry.outcome === "RESET") throw new CaseStoreError("document.conflict_resolution_invalid", 409);
          conflicts.set(entry.assertionId!, [...(conflicts.get(entry.assertionId!) ?? []), workItemId]);
          await client.query(`update ${qualify(core, "case_work_items")} set status='COMPLETED', result_refs=$4::jsonb, updated_at=$5 where tenant_id=$1 and case_id=$2 and work_item_id=$3`,
            [command.tenantId, command.caseId, workItemId, JSON.stringify([reviewId]), timestamp]);
        }
        feedback = documentFeedback(documentReview, assertions, reviewId, conflicts);
      }
      await client.query(`
        insert into ${qualify(core, "case_reviews")}(
          tenant_id, case_id, review_id, review_type, outcome, object_ref, rationale,
          viewed_evidence_refs, reviewer, created_at, details
        ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11::jsonb)
      `, [
        command.tenantId, command.caseId, reviewId, requiredString(p.reviewType, "reviewType"),
        requiredString(p.outcome, "outcome"), requiredString(p.objectRef, "objectRef"),
        requiredString(p.rationale, "rationale"), JSON.stringify(stringArray(p.viewedEvidenceRefs ?? [], "viewedEvidenceRefs")),
        JSON.stringify(command.actor), timestamp, documentReview ? JSON.stringify({ ...documentReview, recordedSequence: Number(current.case_sequence) + 1 }) : documentAuthorization ? JSON.stringify({ authorization: documentAuthorization, requestKey: documentAuthorization.requestKey, recordedSequence: Number(current.case_sequence) + 1 }) : null,
      ]);
      for (const row of feedback) {
        await client.query(`
          insert into ${qualify(core, "document_feedback")}(tenant_id, case_id, feedback_id, review_id, document_id, document_version, assertion_id,
            assertion_version, field, kind, outcome, proposed_value, final_value, proposed_route, adjudication, resolved_work_items, reviewer, created_at)
          values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14,$15::jsonb,$16::jsonb,$17::jsonb,$18)
        `, [command.tenantId, command.caseId, row.feedbackId, reviewId, documentReview!.documentId, documentReview!.documentVersion, row.assertionId,
          row.assertionVersion, row.field, row.kind, row.outcome, JSON.stringify(row.proposedValue), JSON.stringify(row.finalValue), row.proposedRoute,
          JSON.stringify(row.adjudication), JSON.stringify(row.resolvedWorkItems), JSON.stringify(command.actor), timestamp]);
      }
      return {
        eventType: "review.recorded",
        eventSchema: "kyc.review.recorded.v1",
        payload: { reviewId, reviewType: p.reviewType, outcome: p.outcome, objectRef: p.objectRef, ...(documentReview ? { documentReview } : {}),
          ...(feedback.length ? { feedback: feedback.map(row => ({ feedbackId: row.feedbackId, kind: row.kind, assertionId: row.assertionId })) } : {}), ...(documentAuthorization ? { documentRunAuthorization: documentAuthorization } : {}) },
        evidenceRefs: stringArray(p.viewedEvidenceRefs ?? [], "viewedEvidenceRefs"),
        identifiers: { reviewId },
      };
    }
    case "RequestHumanReview": {
      if (!isPolicyAuthorizedCommand(command) && !allowedTransitions[current.status].includes("HUMAN_REVIEW")) {
        throw new CaseStoreError("case.transition_not_allowed", 409, { from: current.status, to: "HUMAN_REVIEW" });
      }
      const reviewRequestId = opaqueId("review_request");
      return {
        eventType: "human_review.requested",
        eventSchema: "kyc.human_review.requested.v1",
        payload: {
          reviewRequestId,
          objectRef: requiredString(p.objectRef, "objectRef"),
          reason: requiredString(p.reason, "reason"),
          priority: optionalString(p.priority) ?? "NORMAL",
        },
        evidenceRefs: stringArray(p.evidenceRefs ?? [], "evidenceRefs"),
        identifiers: { reviewRequestId },
        nextStatus: "HUMAN_REVIEW",
      };
    }
    case "TransitionCaseStatus": {
      const toStatus = z.enum([
        "INTAKE", "VALIDATING", "SCREENING", "INVESTIGATING", "READY_FOR_DECISION", "QA_REVIEW",
        "HUMAN_REVIEW", "NEEDS_INFORMATION", "SUSPENDED", "APPROVED", "DECLINED", "CLOSED",
      ]).parse(p.toStatus);
      if (!isPolicyAuthorizedCommand(command) && !allowedTransitions[current.status].includes(toStatus)) {
        throw new CaseStoreError("case.transition_not_allowed", 409, { from: current.status, to: toStatus });
      }
      if (toStatus === "APPROVED" || toStatus === "DECLINED") {
        throw new CaseStoreError("case.disposition_command_required", 409);
      }
      return {
        eventType: "case.status_transitioned",
        eventSchema: "kyc.case.status_transitioned.v1",
        payload: { from: current.status, to: toStatus, reason: requiredString(p.reason, "reason") },
        evidenceRefs: [],
        identifiers: {},
        nextStatus: toStatus,
      };
    }
    case "AssignCase": {
      // Who works a case is a person's decision, recorded with its reason (case-access-model.md).
      if (command.actor.type !== "HUMAN") throw new CaseStoreError("assignment.human_authority_required", 403);
      const teamId = requiredString(p.teamId, "teamId");
      const assignees = [...new Set(stringArray(p.assignees ?? [], "assignees"))].sort();
      const reason = requiredString(p.reason, "reason");
      const team = (await client.query<{ members: string[] | null }>(`
        select (select array_agg(m.subject_id) from ${qualify(core, "case_team_members")} m
          where m.tenant_id = t.tenant_id and m.team_id = t.team_id and m.removed_at is null) as members
        from ${qualify(core, "case_teams")} t where t.tenant_id = $1 and t.team_id = $2
      `, [command.tenantId, teamId])).rows[0];
      if (!team) throw new CaseStoreError("assignment.team_not_found", 409);
      const members = new Set(team.members ?? []);
      const outside = assignees.filter((subjectId) => !members.has(subjectId));
      if (outside.length) throw new CaseStoreError("assignment.assignee_not_in_team", 409, { subjects: outside });
      const previous = (await client.query<{ team_id: string; assignees: string[] }>(`
        select team_id, assignees from ${qualify(core, "case_assignments")} where tenant_id = $1 and case_id = $2
      `, [command.tenantId, command.caseId])).rows[0];
      await client.query(`
        insert into ${qualify(core, "case_assignments")}(tenant_id, case_id, team_id, assignees, reason, assigned_by, assigned_at)
        values ($1,$2,$3,$4::jsonb,$5,$6::jsonb,$7)
        on conflict (tenant_id, case_id) do update set team_id = excluded.team_id, assignees = excluded.assignees,
          reason = excluded.reason, assigned_by = excluded.assigned_by, assigned_at = excluded.assigned_at
      `, [command.tenantId, command.caseId, teamId, JSON.stringify(assignees), reason, JSON.stringify(command.actor), timestamp]);
      return {
        eventType: "case.assigned",
        eventSchema: "kyc.case.assigned.v1",
        payload: { teamId, assignees, reason, previousTeamId: previous?.team_id ?? null, previousAssignees: previous?.assignees ?? [] },
        evidenceRefs: [],
        identifiers: {},
      };
    }
    case "FinalizeDisposition": {
      if (!isPolicyAuthorizedCommand(command) && (command.actor.type !== "HUMAN" || !command.actor.roles.some((role) => role === "KYC.SeniorReviewer"))) {
        throw new CaseStoreError("disposition.human_authority_required", 403);
      }
      if (!isPolicyAuthorizedCommand(command) && current.status !== "HUMAN_REVIEW") throw new CaseStoreError("disposition.case_not_under_review", 409);
      const recommendationRef = isPolicyAuthorizedCommand(command) ? optionalString(p.recommendationRef) ?? command.commandId : requiredString(p.recommendationRef, "recommendationRef");
      const gateResultRef = isPolicyAuthorizedCommand(command) ? command.commandId : requiredString(p.gateResultRef, "gateResultRef");
      const outcome = z.enum(["APPROVED", "DECLINED"]).parse(p.outcome);
      const gate = await client.query<{ decision: string; recommendation_ref: string }>(`
        select decision, recommendation_ref from ${qualify(core, "case_gate_results")}
        where tenant_id = $1 and case_id = $2 and gate_result_id = $3
      `, [command.tenantId, command.caseId, gateResultRef]);
      if (!isPolicyAuthorizedCommand(command) && (!gate.rows[0] || gate.rows[0].decision !== "AUTHORIZED" || gate.rows[0].recommendation_ref !== recommendationRef)) {
        throw new CaseStoreError("disposition.gate_not_authorized", 409);
      }
      const openMaterial = await client.query(`
        select 1 from ${qualify(core, "case_contradictions")}
        where tenant_id = $1 and case_id = $2 and status in ('OPEN','UNDER_INVESTIGATION') and materiality in ('HIGH','MATERIAL') limit 1
      `, [command.tenantId, command.caseId]);
      // An open material contradiction blocks every approval, whoever authorizes it: a
      // policy-authorized approval (automatic or after human review) meets the same check as a
      // direct human one. A decline never needs the contradiction resolved first, except as before
      // on the direct human path.
      if (openMaterial.rows[0] && (!isPolicyAuthorizedCommand(command) || outcome === "APPROVED")) {
        throw new CaseStoreError("disposition.material_contradiction_open", 409);
      }
      if (["APPROVED", "DECLINED", "CLOSED"].includes(current.status)) throw new CaseStoreError("disposition.already_final", 409);
      const dispositionId = optionalString(p.dispositionId) ?? opaqueId("disposition");
      await client.query(`
        insert into ${qualify(core, "case_final_dispositions")}(
          tenant_id, case_id, disposition_id, outcome, recommendation_ref, gate_result_ref,
          review_ref, policy_snapshot_digest, rationale, follow_up_obligations, status,
          effective_at, authorized_actor, created_at
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,'EFFECTIVE',$11,$12::jsonb,$11)
      `, [
        command.tenantId, command.caseId, dispositionId, outcome, recommendationRef, gateResultRef,
        optionalString(p.reviewRef), normalizeDigest(command.authority.policySnapshotDigest),
        requiredString(p.rationale, "rationale"), JSON.stringify(p.followUpObligations ?? []), timestamp,
        JSON.stringify(command.actor),
      ]);
      return {
        eventType: "case.dispositioned",
        eventSchema: "kyc.case.dispositioned.v1",
        payload: { dispositionId, outcome, recommendationRef, gateResultRef, effectiveAt: timestamp },
        evidenceRefs: stringArray(p.evidenceRefs ?? [], "evidenceRefs"),
        identifiers: { dispositionId },
        nextStatus: outcome,
        lineage: [{
          sourceType: isPolicyAuthorizedCommand(command) ? "BusinessDecision" : "DecisionGateResult",
          sourceId: command.authority.businessActionGrant?.decisionId ?? gateResultRef, predicate: "AUTHORIZES",
          targetType: "FinalDisposition", targetId: dispositionId,
        }],
      };
    }
  }
}

async function ensureLinkedEvidence(
  client: PoolClient,
  store: CaseStore,
  command: BusinessCommand,
  evidenceRefs: string[],
): Promise<void> {
  if (evidenceRefs.length === 0) return;
  const result = await client.query<{ evidence_id: string }>(`
    select evidence_id from ${qualify(store.schemas.core, "case_evidence_refs")}
    where tenant_id = $1 and case_id = $2 and evidence_id = any($3::text[]) and status = 'ACCEPTED'
  `, [command.tenantId, command.caseId, evidenceRefs]);
  if (result.rowCount !== evidenceRefs.length) throw new CaseStoreError("evidence.not_linked", 409);
}

/** Held through commit so cancellation / lease replacement serialize with case effects. */
export type CaseExecutionAuthority = Pick<ExecutionEnvelopeClaims,
  "tenant_id" | "case_id" | "run_id" | "plan_digest" | "attempt" | "fencing_epoch" | "work_item_id" | "work_fencing_epoch">
  & Partial<Pick<ExecutionEnvelopeClaims, "node_id" | "context_required">>;

/**
 * An agent's proposal must cite what its model was shown (data-stores-plan.md §3.3). Under an
 * envelope marked `context_required`, an AGENT command without a citation is refused. A
 * citation, whenever present, must name `model_context` evidence of this case whose content
 * is a context pack that recomputes to the cited digest and was assembled for this run and
 * node. Checked inside the command's transaction, so the proposal and its basis commit
 * together.
 */
/**
 * The rule for registering `model_context` evidence (the context pack a model answered from).
 * Only the runtime promotes one, under the node's own envelope marked `context_required`, and
 * only a pack that recomputes and was assembled for that run and node. No person and no other
 * node can place something that a later citation would accept as "what the model saw".
 */
export function assertModelContextPromotion(
  request: { type: string; contentBase64: string },
  execution: CaseExecutionAuthority | undefined,
): void {
  if (request.type !== "model_context") return;
  if (!execution || execution.context_required !== true) throw new CaseStoreError("context.promotion_not_permitted", 403);
  let pack: ContextPack;
  try { pack = JSON.parse(Buffer.from(request.contentBase64, "base64").toString("utf8")) as ContextPack; }
  catch { throw new CaseStoreError("context.promotion_unreadable", 400); }
  if (!verifyContextPackDigest(pack)) throw new CaseStoreError("context.promotion_digest_invalid", 400);
  if (pack.runId !== execution.run_id || (execution.node_id !== undefined && pack.nodeId !== execution.node_id)) {
    throw new CaseStoreError("context.promotion_scope_mismatch", 403);
  }
}

async function requireContextCitation(
  client: PoolClient, store: CaseStore, command: BusinessCommand, execution?: CaseExecutionAuthority,
): Promise<void> {
  const { contextEvidenceId, contextPackDigest } = command.authority;
  if (!contextEvidenceId || !contextPackDigest) {
    if (execution?.context_required === true && command.actor.type === "AGENT") throw new CaseStoreError("context.citation_required", 403);
    return;
  }
  const cited = await client.query<{ evidence_type: string; created_by: { type?: string }; content: Buffer | null; backend: string;
    storage_account: string | null; container: string | null; blob_name: string | null; raw_digest: string }>(`
    select e.evidence_type, e.created_by, e.raw_digest, a.content, a.backend, a.storage_account, a.container, a.blob_name
    from ${qualify(store.schemas.evidence, "evidence_objects")} e
    join ${qualify(store.schemas.evidence, "artifacts")} a on a.tenant_id = e.tenant_id and a.artifact_ref = e.artifact_ref
    where e.tenant_id = $1 and e.case_id = $2 and e.evidence_id = $3
  `, [command.tenantId, command.caseId, contextEvidenceId]);
  const row = cited.rows[0];
  if (!row || row.evidence_type !== "model_context" || row.created_by?.type !== "AGENT") throw new CaseStoreError("context.citation_not_model_context", 403);
  const bytes = await artifactBytes(store, { ...row, digest: row.raw_digest }).catch((error: unknown) => {
    if (error instanceof CaseStoreError && error.code === "evidence.content_unavailable") throw new CaseStoreError("context.citation_content_unavailable", 409);
    throw error;
  });
  let pack: ContextPack;
  try { pack = JSON.parse(bytes.toString("utf8")) as ContextPack; } catch { throw new CaseStoreError("context.citation_unreadable", 403); }
  if (pack.packDigest !== contextPackDigest || !verifyContextPackDigest(pack)) throw new CaseStoreError("context.citation_digest_mismatch", 403);
  if (execution && (pack.runId !== execution.run_id || (execution.node_id !== undefined && pack.nodeId !== execution.node_id))) {
    throw new CaseStoreError("context.citation_scope_mismatch", 403);
  }
}

export async function assertActiveCaseExecution(
  db: Pick<PoolClient, "query">, authority: CaseExecutionAuthority, tenantId: string, caseId: string,
): Promise<void> {
  if (authority.tenant_id !== tenantId || authority.case_id !== caseId) {
    throw new CaseStoreError("authorization.execution_scope_mismatch", 403);
  }
  const result = await db.query<{ allowed: boolean }>(
    "select harness_runtime.lock_case_execution($1,$2,$3,$4,$5,$6,$7,$8) as allowed",
    [authority.run_id, tenantId, caseId, authority.plan_digest, authority.attempt, authority.fencing_epoch,
      authority.work_item_id ?? null, authority.work_fencing_epoch ?? null],
  );
  if (result.rows[0]?.allowed !== true) throw new CaseStoreError("authorization.execution_inactive", 403);
}


/** The case row as a locked transaction sees it; `appendLockedCaseEvent` keeps it current. */
export type LockedCase = CaseRow;

/**
 * Append one event to a case whose row the caller holds `for update`: hash-chained ledger event,
 * outbox row, lineage, and the case's new sequence and status. Mutates `current` to match.
 */
export async function appendLockedCaseEvent(
  client: PoolClient,
  store: CaseStore,
  current: LockedCase,
  input: {
    eventType: string;
    eventSchema: string;
    payload: Record<string, unknown>;
    evidenceRefs: string[];
    actor: CaseActor;
    commandId: string;
    authority: Record<string, unknown>;
    occurredAt?: string;
    nextStatus?: KycCaseStatus;
    lineage?: MutationResult["lineage"];
  },
): Promise<{ sequence: number; eventId: string; eventDigest: string; recordedAt: string }> {
  const heads = qualify(store.schemas.ledger, "event_chain_heads");
  const cases = qualify(store.schemas.core, "cases");
  const sequence = Number(current.case_sequence) + 1;
  const recordedAt = nowIso();
  const head = await client.query<{ event_digest: string }>(`
    select event_digest from ${heads} where tenant_id = $1 and case_id = $2
  `, [current.tenant_id, current.case_id]);
  const event = await appendCaseEvent(client, store, {
    tenantId: current.tenant_id,
    caseId: current.case_id,
    sequence,
    eventType: input.eventType,
    eventSchema: input.eventSchema,
    occurredAt: input.occurredAt ?? recordedAt,
    recordedAt,
    actor: input.actor,
    commandId: input.commandId,
    authority: input.authority,
    payload: input.payload,
    evidenceRefs: input.evidenceRefs,
    previousEventDigest: head.rows[0]?.event_digest ?? null,
    classification: current.classification,
  });
  for (const edge of input.lineage ?? []) {
    await client.query(`
      insert into ${qualify(store.schemas.evidence, "lineage_edges")}(
        tenant_id, case_id, edge_id, source_type, source_id, predicate, predicate_version,
        target_type, target_id, creation_event_id, created_by, created_at
      ) values ($1,$2,$3,$4,$5,$6,'v1',$7,$8,$9,$10::jsonb,$11)
    `, [
      current.tenant_id, current.case_id, opaqueId("edge"), edge.sourceType, edge.sourceId,
      edge.predicate, edge.targetType, edge.targetId, event.eventId, JSON.stringify(input.actor), recordedAt,
    ]);
  }
  await client.query(`
    update ${cases} set case_sequence = $3, status = coalesce($4, status), updated_at = $5
    where tenant_id = $1 and case_id = $2
  `, [current.tenant_id, current.case_id, sequence, input.nextStatus ?? null, recordedAt]);
  current.case_sequence = sequence;
  if (input.nextStatus) current.status = input.nextStatus;
  return { sequence, eventId: event.eventId, eventDigest: event.eventDigest, recordedAt };
}

/**
 * Apply one business command to a locked case (plan/policy authority and sequence already
 * checked by the caller): the mutation, its ledger event and its command receipt.
 */
export async function applyLockedCommand(
  client: PoolClient,
  store: CaseStore,
  command: BusinessCommand,
  current: LockedCase,
  requestDigest: string,
): Promise<{ response: Record<string, unknown>; identifiers: Record<string, string>; eventType: string }> {
  let mutation: MutationResult;
  try {
    if (command.authority.businessActionGrant && !isPolicyAuthorizedCommand(command)) throw new CaseStoreError("policy.grant_import_forbidden",403);
    if (isProtectedBusinessCommand(command.commandType) && !isPolicyAuthorizedCommand(command)
      && (isProductionProfile() || current.decision_contract_version === 2 || await resolveCasePolicyContract(store, current.tenant_id, current.harness_plan_digest) === 2)) {
      throw new CaseStoreError("policy.action_grant_required", 403);
    }
    mutation = await applyMutation(client, store, command, current);
  } catch (error) {
    if (error instanceof CaseStoreError) throw error;
    if (error instanceof CanonicalRecordError) throw new CaseStoreError(error.code, error.httpStatus, error.details);
    if (error instanceof z.ZodError) throw new CaseStoreError("command.payload_invalid", 400, { issues: error.issues });
    throw error;
  }
  const event = await appendLockedCaseEvent(client, store, current, {
    eventType: mutation.eventType,
    eventSchema: mutation.eventSchema,
    payload: mutation.payload,
    evidenceRefs: mutation.evidenceRefs,
    actor: command.actor,
    commandId: command.commandId,
    authority: command.authority,
    ...(command.occurredAt ? { occurredAt: command.occurredAt } : {}),
    ...(mutation.nextStatus ? { nextStatus: mutation.nextStatus } : {}),
    ...(mutation.lineage ? { lineage: mutation.lineage } : {}),
  });
  const response = {
    outcome: "ACCEPTED",
    caseId: command.caseId,
    caseSequence: event.sequence,
    eventId: event.eventId,
    eventDigest: event.eventDigest,
    createdIdentifiers: mutation.identifiers,
  };
  await writeReceipt(client, store, {
    tenantId: command.tenantId,
    caseId: command.caseId,
    commandId: command.commandId,
    commandType: command.commandType,
    idempotencyKey: command.idempotencyKey,
    requestDigest,
    sequence: event.sequence,
    identifiers: mutation.identifiers,
    response,
    createdAt: event.recordedAt,
  });
  return { response, identifiers: mutation.identifiers, eventType: mutation.eventType };
}

export async function submitBusinessCommand(
  store: CaseStore,
  command: BusinessCommand,
  execution?: CaseExecutionAuthority,
): Promise<Record<string, unknown>> {
  try {
    return await applyBusinessCommand(store, command, execution);
  } catch (error) {
    // Recorded only once both transactions have ended, so the execution lease is never held
    // for the audit write.
    if (error instanceof CaseStoreError && error.httpStatus >= 400 && error.httpStatus < 500) {
      await recordRejectedCommand(store, command, stableDigest(command), error);
    }
    throw error;
  }
}

async function applyBusinessCommand(
  store: CaseStore,
  command: BusinessCommand,
  execution?: CaseExecutionAuthority,
): Promise<Record<string, unknown>> {
  const cases = qualify(store.schemas.core, "cases");
  const receipts = qualify(store.schemas.ledger, "command_receipts");
  const requestDigest = stableDigest(command);
  const client = await store.db.connect();
  let executionClient: PoolClient | undefined;
  try {
    if (execution && store.executionDb) {
      executionClient = await store.executionDb.connect();
      await executionClient.query("begin");
    }
    await client.query("begin");
    if (execution) await assertActiveCaseExecution(executionClient ?? client, execution, command.tenantId, command.caseId);
    await bindCaseTenant(client, command.tenantId);
    await requireContextCitation(client, store, command, execution);
    if(command.commandType==='RecordFinancialCrimeOutcome') {
      const scope=bridgeOutcomeSchema.parse(command.payload.outcome).scope;
      if(!execution || scope.run_id!==execution.run_id || scope.work_item_id!==execution.work_item_id
        || scope.work_fencing_epoch!==execution.work_fencing_epoch || scope.run_fencing_epoch!==execution.fencing_epoch) {
        throw new CaseStoreError('fincrime.execution_authority_required',403);
      }
      const observation=await (executionClient??client).query('select harness_runtime.matches_fincrime_outcome($1,$2,$3,$4,$5::jsonb) as matches',
        [command.tenantId,scope.work_item_id,scope.execution_id,scope.work_fencing_epoch,JSON.stringify(command.payload.outcome)]);
      if(observation.rows[0]?.matches!==true) throw new CaseStoreError('fincrime.unrecorded_outcome',403);
    }
    const currentResult = await client.query<CaseRow>(`
      select * from ${cases} where tenant_id = $1 and case_id = $2 for update
    `, [command.tenantId, command.caseId]);
    const current = currentResult.rows[0];
    if (!current) throw new CaseStoreError("case.not_found", 404);

    const prior = await client.query<{ request_digest: string; response: Record<string, unknown> }>(`
      select request_digest, response from ${receipts}
      where tenant_id = $1 and case_id = $2 and idempotency_key = $3
    `, [command.tenantId, command.caseId, command.idempotencyKey]);
    if (prior.rows[0]) {
      if (prior.rows[0].request_digest !== requestDigest) throw new CaseStoreError("command.idempotency_conflict", 409);
      await client.query("commit");
      return { ...prior.rows[0].response, replayed: true };
    }
    if (command.preconditions.caseSequence !== Number(current.case_sequence)) {
      throw new CaseStoreError("command.case_sequence_conflict", 409, {
        expected: command.preconditions.caseSequence,
        current: Number(current.case_sequence),
      });
    }
    if (normalizeDigest(command.authority.planDigest) !== normalizeDigest(current.harness_plan_digest)) {
      if (!execution) throw new CaseStoreError("command.plan_authority_mismatch", 403);
      const pull = await contextPullRunScope(store, execution, executionClient ?? client);
      if (pull) assertContextPullCommands(pull, [command]);
      else {
        const scope = await documentRunScope(store, execution, client, executionClient ?? client);
        assertDocumentCommands(scope, [command]);
        await assertDocumentRecordIdentities(client, store, command.tenantId, command.caseId, scope, [command]);
      }
    }
    if (normalizeDigest(command.authority.policySnapshotDigest) !== normalizeDigest(current.policy_snapshot_digest)) {
      throw new CaseStoreError("command.policy_authority_mismatch", 403);
    }

    const { response } = await applyLockedCommand(client, store, command, current, requestDigest);
    await client.query("commit");
    return response;
  } catch (error) {
    await client.query("rollback");
    if (error instanceof CaseStoreError) throw error;
    if (error instanceof Error && "code" in error && error.code === "23505") {
      throw new CaseStoreError("command.conflict", 409, { constraint: String((error as { constraint?: string }).constraint ?? "unique") });
    }
    throw error;
  } finally {
    client.release();
    if (executionClient) {
      try { await executionClient.query("rollback"); } finally { executionClient.release(); }
    }
  }
}

/**
 * Command audit for a refused command. Nothing changed, so it is not a ledger event, but who
 * tried what and why it was refused is kept (immutable, like the ledger). Best effort: a
 * failure to record never masks the refusal itself.
 */
async function recordRejectedCommand(store: CaseStore, command: BusinessCommand, requestDigest: string, error: CaseStoreError): Promise<void> {
  await withCaseTenant(store, command.tenantId, (client) => client.query(`
    insert into ${qualify(store.schemas.ledger, "rejected_commands")}(
      tenant_id, case_id, command_id, command_type, request_digest, reason_code, http_status, actor)
    values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
    on conflict do nothing
  `, [command.tenantId, command.caseId, command.commandId, command.commandType, requestDigest, error.code,
    error.httpStatus, JSON.stringify(command.actor)])).catch(() => undefined);
}

export async function listCases(
  store: CaseStore,
  input: { tenantId: string; status?: KycCaseStatus; harnessPlanDigest?: string; limit?: number; cursor?: string },
) {
  return (await listCasesPage(store, input)).items;
}

export async function listCasesPage(
  store: CaseStore,
  input: { tenantId: string; status?: KycCaseStatus; harnessPlanDigest?: string; limit?: number; cursor?: string },
): Promise<Page<ReturnType<typeof mapCase>>> {
  const limit = pageLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  const result = await tenantReader(store, input.tenantId).query<CaseRow>(`
    select * from ${qualify(store.schemas.core, "cases")}
    where tenant_id = $1 and ($2::text is null or status = $2)
      and ($3::text is null or harness_plan_digest = $3)
      and ($4::timestamptz is null or (updated_at, case_id) < ($4::timestamptz, $5))
    order by updated_at desc, case_id desc limit $6
  `, [
    input.tenantId,
    input.status ?? null,
    input.harnessPlanDigest ? normalizeDigest(input.harnessPlanDigest) : null,
    cursor?.at ?? null,
    cursor?.id ?? "",
    limit + 1,
  ]);
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const last = rows.at(-1);
  return {
    items: rows.map(mapCase),
    nextCursor: hasMore && last ? encodeCursor({ at: mapDate(last.updated_at)!, id: last.case_id }) : null,
  };
}

type CaseReader = Pick<CaseStoreDatabase, "query"> | Pick<PoolClient, "query">;

/**
 * Bind the current transaction to one tenant. Every case, ledger and evidence table has a
 * forced row-level security policy on `app.tenant_id` (case-store migration 012), so a
 * query on a connection that has not called this sees no rows at all. The setting is
 * transaction-local, which keeps it from leaking to the next user of a pooled connection.
 */
export async function bindCaseTenant(client: Pick<PoolClient, "query">, tenantId: string): Promise<void> {
  if (!tenantId) throw new CaseStoreError("case.tenant_required", 400);
  await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
}

/** Run `work` in one transaction bound to `tenantId`, committing on success. */
export async function withCaseTenant<T>(
  store: Pick<CaseStore, "db">,
  tenantId: string,
  work: (client: PoolClient) => Promise<T>,
  options: { readOnly?: boolean; repeatableRead?: boolean } = {},
): Promise<T> {
  const client = await store.db.connect();
  try {
    await client.query(`begin${options.repeatableRead ? " isolation level repeatable read" : ""}${options.readOnly ? " read only" : ""}`);
    await bindCaseTenant(client, tenantId);
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** A reader whose every query runs in its own read-only transaction bound to `tenantId`. */
function tenantReader(store: CaseStore, tenantId: string): Pick<PoolClient, "query"> {
  return {
    query: ((text: string, values?: unknown[]) =>
      withCaseTenant(store, tenantId, (client) => client.query(text, values), { readOnly: true })) as PoolClient["query"],
  };
}

async function selectRows(
  reader: CaseReader,
  schema: string,
  table: string,
  tenantId: string,
  caseId: string,
): Promise<Record<string, unknown>[]> {
  const result = await reader.query<Record<string, unknown>>(`
    select * from ${qualify(schema, table)} item where tenant_id = $1 and case_id = $2 order by to_jsonb(item)::text
  `, [tenantId, caseId]);
  if (table === "case_decision_recommendations") {
    return result.rows.map((row): Record<string, unknown> => ({
      ...row,
      confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    }));
  }
  return result.rows;
}

/**
 * Snapshots are what models are shown. A `model_context` record (an earlier model's prompt)
 * is never part of one: the operational view shows it to people, a snapshot does not.
 */
function modelVisibleEvidence(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.filter((row) => row.evidence_type !== "model_context");
}

/** Current command precondition without releasing the case's business data. */
export async function getCaseSequence(store: CaseStore, tenantId: string, caseId: string): Promise<number | null> {
  const result = await tenantReader(store, tenantId).query<{ case_sequence: string | number }>(
    `select case_sequence from ${qualify(store.schemas.core, "cases")} where tenant_id=$1 and case_id=$2`,
    [tenantId, caseId],
  );
  return result.rows[0] ? Number(result.rows[0].case_sequence) : null;
}

export async function getCaseView(store: CaseStore, tenantId: string, caseId: string) {
  // Independent reads keep the operational view fast; each binds the tenant itself.
  const reader = tenantReader(store, tenantId);
  const caseResult = await reader.query<CaseRow>(`
    select * from ${qualify(store.schemas.core, "cases")} where tenant_id = $1 and case_id = $2
  `, [tenantId, caseId]);
  const caseRow = caseResult.rows[0];
  if (!caseRow) return null;
  const [subjects, evidence, claims, facts, findings, assumptions, contradictions, workItems, recommendations, gateResults, reviews, dispositions, executionRefs, lineageEdges] = await Promise.all([
    selectRows(reader, store.schemas.core, "case_subjects", tenantId, caseId),
    selectRows(reader, store.schemas.evidence, "evidence_objects", tenantId, caseId),
    selectRows(reader, store.schemas.core, "case_claims", tenantId, caseId),
    selectRows(reader, store.schemas.core, "case_facts", tenantId, caseId),
    selectRows(reader, store.schemas.core, "case_findings", tenantId, caseId),
    selectRows(reader, store.schemas.core, "case_assumptions", tenantId, caseId),
    selectRows(reader, store.schemas.core, "case_contradictions", tenantId, caseId),
    selectRows(reader, store.schemas.core, "case_work_items", tenantId, caseId),
    selectRows(reader, store.schemas.core, "case_decision_recommendations", tenantId, caseId),
    selectRows(reader, store.schemas.core, "case_gate_results", tenantId, caseId),
    selectRows(reader, store.schemas.core, "case_reviews", tenantId, caseId),
    selectRows(reader, store.schemas.core, "case_final_dispositions", tenantId, caseId),
    selectRows(reader, store.schemas.core, "case_execution_refs", tenantId, caseId),
    selectRows(reader, store.schemas.evidence, "lineage_edges", tenantId, caseId),
  ]);
  return {
    viewSchema: "kyc.case.operational-view.v1",
    generatedAt: nowIso(),
    etag: `W/\"${caseRow.case_id}:${caseRow.case_sequence}\"`,
    case: mapCase(caseRow),
    subjects,
    evidence: evidence.map(({ content: _content, ...item }) => item),
    claims,
    facts,
    findings,
    assumptions,
    contradictions,
    workItems,
    decisionRecommendations: recommendations,
    gateResults,
    reviews,
    finalDispositions: dispositions,
    executionRefs,
    lineageEdges,
  };
}

/**
 * Read one internally consistent case snapshot for policy and context assembly.
 *
 * The operational view intentionally favors UI latency and issues independent reads.
 * Authority-bearing evaluation needs a stronger boundary: every row below is observed
 * from one repeatable-read transaction and the returned digest excludes wall-clock data.
 */
export async function getCaseSnapshot(store: CaseStore, tenantId: string, caseId: string, purpose: string) {
  if (!purpose.trim()) throw new CaseStoreError("case.snapshot_purpose_required", 400);
  const client = await store.db.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    await bindCaseTenant(client, tenantId);
    const caseResult = await client.query<CaseRow>(`
      select * from ${qualify(store.schemas.core, "cases")} where tenant_id = $1 and case_id = $2
    `, [tenantId, caseId]);
    const caseRow = caseResult.rows[0];
    if (!caseRow) {
      await client.query("rollback");
      return null;
    }
    const tables = [
      ["subjects", store.schemas.core, "case_subjects"],
      ["evidence", store.schemas.evidence, "evidence_objects"],
      ["claims", store.schemas.core, "case_claims"],
      ["facts", store.schemas.core, "case_facts"],
      ["findings", store.schemas.core, "case_findings"],
      ["assumptions", store.schemas.core, "case_assumptions"],
      ["contradictions", store.schemas.core, "case_contradictions"],
      ["workItems", store.schemas.core, "case_work_items"],
      ["decisionRecommendations", store.schemas.core, "case_decision_recommendations"],
      ["gateResults", store.schemas.core, "case_gate_results"],
      ["reviews", store.schemas.core, "case_reviews"],
      ["finalDispositions", store.schemas.core, "case_final_dispositions"],
      ["executionRefs", store.schemas.core, "case_execution_refs"],
      ["lineageEdges", store.schemas.evidence, "lineage_edges"],
    ] as const;
    const data: Record<string, unknown> = {};
    // A pg client serializes these queries on one transaction. Keeping the loop explicit
    // also avoids implying that consistency comes from Promise.all rather than MVCC.
    for (const [key, schema, table] of tables) {
      const rows = await selectRows(client, schema, table, tenantId, caseId);
      data[key] = key === "evidence" ? modelVisibleEvidence(rows).map(({ content: _content, ...item }) => item) : rows;
    }
    const caseRecord = mapCase(caseRow);
    const canonical = {
      contractVersion: "case.snapshot.v1" as const,
      tenantId,
      caseId,
      caseSequence: caseRecord.caseSequence,
      policySnapshotDigest: caseRecord.policySnapshotDigest,
      purpose,
      case: caseRecord,
      data,
    };
    await client.query("commit");
    return { ...canonical, snapshotDigest: stableDigest(canonical), generatedAt: nowIso() };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Build the canonical authority-bearing snapshot contract from one MVCC view.
 *
 * This is intentionally separate from getCaseSnapshot: the v1 runtime endpoint has
 * existing consumers, while the canonical contract requires authority columns the
 * original case table did not capture. Deployments without those columns fail closed
 * instead of deriving or inventing policy/dependency identity.
 */
export async function getCanonicalCaseSnapshot(
  store: CaseStore,
  tenantId: string,
  caseId: string,
  purpose: string,
  /**
   * Bitemporal selection of canonical records: business-valid time and recorded-time cutoff.
   * Both default to the capture time, so a snapshot shows what was known and valid when read.
   */
  recordTime: { asOf?: string; knowledgeCutoff?: string } = {},
): Promise<CaseSnapshot | null> {
  if (!purpose.trim()) throw new CaseStoreError("case.snapshot_purpose_required", 400);
  const client = await store.db.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    await bindCaseTenant(client, tenantId);
    const caseResult = await client.query<CaseRow>(`
      select * from ${qualify(store.schemas.core, "cases")} where tenant_id = $1 and case_id = $2
    `, [tenantId, caseId]);
    const caseRow = caseResult.rows[0];
    if (!caseRow) {
      await client.query("rollback");
      return null;
    }

    const authority = {
      dependencyDigest: caseRow.dependency_digest,
      planDigest: caseRow.harness_plan_digest,
      policyId: caseRow.policy_id,
      policyVersion: caseRow.policy_version,
      policySnapshotDigest: caseRow.policy_snapshot_digest,
      policyBundleDigest: caseRow.policy_bundle_digest,
    };
    const missingAuthorityFields = Object.entries(authority)
      .filter(([, value]) => typeof value !== "string" || value.trim().length === 0)
      .map(([field]) => field);
    if (missingAuthorityFields.length > 0) {
      throw new CaseStoreError("case.snapshot_authority_incomplete", 409, { missingAuthorityFields });
    }

    const tables = [
      ["subjects", store.schemas.core, "case_subjects"],
      ["evidence", store.schemas.evidence, "evidence_objects"],
      ["claims", store.schemas.core, "case_claims"],
      ["facts", store.schemas.core, "case_facts"],
      ["findings", store.schemas.core, "case_findings"],
      ["assumptions", store.schemas.core, "case_assumptions"],
      ["contradictions", store.schemas.core, "case_contradictions"],
      ["workItems", store.schemas.core, "case_work_items"],
      ["decisionRecommendations", store.schemas.core, "case_decision_recommendations"],
      ["gateResults", store.schemas.core, "case_gate_results"],
      ["reviews", store.schemas.core, "case_reviews"],
      ["finalDispositions", store.schemas.core, "case_final_dispositions"],
      ["executionRefs", store.schemas.core, "case_execution_refs"],
      ["lineageEdges", store.schemas.evidence, "lineage_edges"],
    ] as const;
    const data: Record<string, unknown> = { purpose, case: mapCase(caseRow) };
    data.evidenceLinks = await selectRows(client, store.schemas.core, "case_evidence_refs", tenantId, caseId);
    for (const [key, schema, table] of tables) {
      const rows = await selectRows(client, schema, table, tenantId, caseId);
      // Evidence content is never part of a snapshot. Consumers receive metadata and
      // content-addressed references and must use the separately authorized evidence API.
      data[key] = key === "evidence" ? modelVisibleEvidence(rows).map(({ content: _content, ...metadata }) => metadata) : rows;
    }

    if (caseRow.decision_contract_version === 2) {
      data.adoptedAssessments = await selectRows(client, store.schemas.core, "adopted_assessments", tenantId, caseId);
    }
    const capturedAt = nowIso();
    const selectionTime = { asOf: recordTime.asOf ?? capturedAt, knowledgeCutoff: recordTime.knowledgeCutoff ?? capturedAt };
    const records = await readCanonicalRecords(client, store.schemas, tenantId, caseId, selectionTime);
    // Absent rather than empty, so snapshots of cases without records keep their digests.
    if (Object.keys(records).length) {
      data.records = records;
      data.recordsAsOf = selectionTime;
    }
    const digestInput = {
      apiVersion: "harness.factory/case-snapshot-v1" as const,
      kind: "CaseSnapshot" as const,
      tenantId,
      caseId,
      caseSequence: Number(caseRow.case_sequence),
      dependencyDigest: authority.dependencyDigest!,
      planDigest: authority.planDigest!,
      policyAuthority: {
        policyId: authority.policyId!,
        policyVersion: authority.policyVersion!,
        policySnapshotDigest: authority.policySnapshotDigest!,
        policyBundleDigest: authority.policyBundleDigest!,
      },
      consistency: "strong" as const,
      classification: caseRow.classification,
      // PostgreSQL timestamps must have the same representation before and after HTTP transport.
      data: JSON.parse(JSON.stringify(data)) as Record<string, unknown>,
    };
    const snapshotDigest = stableDigest(digestInput);
    const parsed = caseSnapshotSchema.safeParse({
      ...digestInput,
      snapshotId: `snapshot_${snapshotDigest}`,
      snapshotDigest,
      capturedAt,
    });
    if (!parsed.success) {
      throw new CaseStoreError("case.snapshot_authority_invalid", 409, {
        issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })),
      });
    }
    await client.query("commit");
    return parsed.data;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function contextPathSegments(path: string): string[] {
  if (path === "$" || path === "/") return [];
  const segments = path.replace(/^\$\.?/, "").split(/[./]/).filter(Boolean);
  if (segments.some((segment) => ["__proto__", "constructor", "prototype"].includes(segment))) {
    throw new CaseStoreError("case.context_path_invalid", 400);
  }
  return segments;
}

function contextValue(value: unknown, path: string): unknown {
  return contextPathSegments(path).reduce<unknown>((current, segment) => current && typeof current === "object"
    ? Object.hasOwn(current, segment) ? (current as Record<string, unknown>)[segment] : undefined
    : undefined, value);
}

function assignContextValue(target: Record<string, unknown>, path: string[], value: unknown): void {
  if (path.length === 0) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new CaseStoreError("case.context_root_invalid", 409);
    }
    for (const [key, item] of Object.entries(structuredClone(value as Record<string, unknown>))) {
      Object.defineProperty(target, key, { value: item, enumerable: true, writable: true, configurable: true });
    }
    return;
  }
  let cursor = target;
  for (const [index, segment] of path.slice(0, -1).entries()) {
    if (segment === "__proto__" || segment === "constructor" || segment === "prototype") throw new CaseStoreError("case.context_path_invalid", 400);
    const existing = Object.hasOwn(cursor, segment) ? cursor[segment] : undefined;
    // A selector below an array another selector already projected (`subjects` and `subjects.0.subject_id`)
    // descends into it by index; replacing the array with an object would hide every element from the reader.
    const intoArray = Array.isArray(existing) && /^(0|[1-9]\d*)$/.test(path[index + 1]!);
    if (!existing || typeof existing !== "object" || (Array.isArray(existing) && !intoArray)) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  const last = path.at(-1)!;
  if (last === "__proto__" || last === "constructor" || last === "prototype") throw new CaseStoreError("case.context_path_invalid", 400);
  cursor[last] = structuredClone(value);
}

function maskContextValue(value: unknown, policy: ContextClassificationPolicy): unknown {
  const transform = policy.transform;
  // The contract requires this, but retain the boundary check here because this is the
  // last trusted function before context is serialized.
  if (!transform) throw new CaseStoreError("case.context_transform_required", 403, { classification: policy.classification });
  if (transform.kind === "replace") return transform.replacement;
  if (transform.kind === "hash") return `${transform.prefix}${stableDigest(value)}`;
  if (typeof value !== "string") {
    throw new CaseStoreError("case.context_transform_type_invalid", 409, { classification: policy.classification, transform: transform.kind });
  }
  const prefix = value.slice(0, transform.visiblePrefix);
  const suffix = transform.visibleSuffix === 0 ? "" : value.slice(-transform.visibleSuffix);
  const hiddenLength = Math.max(1, value.length - prefix.length - suffix.length);
  return `${prefix}${transform.replacement.repeat(hiddenLength)}${suffix}`;
}

function applyContextClassificationPolicy(
  value: unknown,
  selector: CaseReadGrant,
  policies: readonly ContextClassificationPolicy[],
): unknown {
  const policy = policies.find((candidate) => candidate.classification === selector.classification);
  if (!policy) {
    throw new CaseStoreError("case.context_classification_policy_missing", 403, { classification: selector.classification, selectorId: selector.id });
  }
  if (policy.action === "deny") {
    throw new CaseStoreError("case.context_classification_denied", 403, { classification: selector.classification, selectorId: selector.id });
  }
  return policy.action === "mask" ? maskContextValue(value, policy) : structuredClone(value);
}

/**
 * Materialize only the signed selectors for a runtime context. The complete canonical
 * snapshot may exist inside this trusted store function, but it is never serialized to
 * the caller. The returned snapshot receives its own digest because `data` is a new,
 * smaller authority-bearing representation.
 */
export function projectCanonicalCaseSnapshot(
  snapshot: CaseSnapshot,
  selectors: readonly CaseReadGrant[],
  policies: readonly ContextClassificationPolicy[],
): CaseSnapshot {
  if (selectors.length === 0) throw new CaseStoreError("case.context_selectors_required", 403);
  const data: Record<string, unknown> = {};
  // Canonical-record selectors project only the record types and fields they name; an empty
  // list is a real answer ("nothing selected"), which the context plane reports as a gap.
  const recordSelectors = selectors.filter(isRecordSelector);
  if (recordSelectors.length) {
    for (const [objectType, records] of projectCanonicalRecords(snapshot.data.records, recordSelectors)) {
      const selector = recordSelectors.find((candidate) => canonicalRecordObjectType(candidate) === objectType)!;
      assignContextValue(data, ["records", objectType], applyContextClassificationPolicy(records, selector, policies));
    }
    if (snapshot.data.recordsAsOf) data.recordsAsOf = structuredClone(snapshot.data.recordsAsOf);
  }
  for (const selector of selectors) {
    if (isRecordSelector(selector)) continue;
    const direct = contextValue(snapshot.data, selector.path);
    const value = direct === undefined ? contextValue(snapshot.data[selector.source], selector.path) : direct;
    if (value === undefined) {
      if (selector.required) {
        throw new CaseStoreError("case.context_required_missing", 409, { selectorId: selector.id });
      }
      continue;
    }
    // Paths that resolve at the snapshot root remain root-relative. Other paths are
    // expressed below their declared source, matching runtime-core's selector lookup.
    const directPath = contextPathSegments(selector.path);
    const targetPath = direct !== undefined || directPath.length === 0
      ? directPath
      : [selector.source, ...directPath];
    assignContextValue(data, targetPath, applyContextClassificationPolicy(value, selector, policies));
  }

  const { snapshotId: _snapshotId, snapshotDigest: _snapshotDigest, capturedAt, readReceiptId:_readReceiptId, ...canonical } = snapshot;
  const projectedCanonical = { ...canonical, data };
  const snapshotDigest = stableDigest(projectedCanonical);
  return caseSnapshotSchema.parse({
    ...projectedCanonical,
    snapshotId: `snapshot_${snapshotDigest}`,
    snapshotDigest,
    capturedAt,
  });
}

export async function listCaseEvents(store: CaseStore, tenantId: string, caseId: string, afterSequence = 0) {
  return (await listCaseEventsPage(store, tenantId, caseId, { afterSequence })).items;
}

export async function listCaseEventsPage(
  store: CaseStore,
  tenantId: string,
  caseId: string,
  options: { afterSequence?: number; limit?: number } = {},
): Promise<Page<{
  tenantId: string; caseId: string; caseSequence: number; eventId: string; eventType: string;
  eventSchema: string; occurredAt: string | null; recordedAt: string | null; actor: unknown;
  commandRef: string; authority: unknown; payload: unknown; evidenceRefs: string[];
  previousEventDigest: string | null; eventDigest: string;
}>> {
  const limit = pageLimit(options.limit, 1_000);
  const afterSequence = options.afterSequence ?? 0;
  if (!Number.isInteger(afterSequence) || afterSequence < 0) throw new CaseStoreError("pagination.cursor_invalid", 400);
  const result = await tenantReader(store, tenantId).query<{
    tenant_id: string; case_id: string; case_sequence: string | number; event_id: string; event_type: string;
    event_schema: string; occurred_at: Date; recorded_at: Date; actor: unknown; command_id: string;
    authority: unknown; payload: unknown; evidence_refs: string[]; previous_event_digest: string | null; event_digest: string;
  }>(`
    select * from ${qualify(store.schemas.ledger, "case_events")}
    where tenant_id = $1 and case_id = $2 and case_sequence > $3
    order by case_sequence limit $4
  `, [tenantId, caseId, afterSequence, limit + 1]);
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const items = rows.map((row) => ({
    tenantId: row.tenant_id,
    caseId: row.case_id,
    caseSequence: Number(row.case_sequence),
    eventId: row.event_id,
    eventType: row.event_type,
    eventSchema: row.event_schema,
    occurredAt: mapDate(row.occurred_at),
    recordedAt: mapDate(row.recorded_at),
    actor: row.actor,
    commandRef: row.command_id,
    authority: row.authority,
    payload: row.payload,
    evidenceRefs: row.evidence_refs,
    previousEventDigest: row.previous_event_digest,
    eventDigest: row.event_digest,
  }));
  return { items, nextCursor: hasMore ? String(items.at(-1)?.caseSequence ?? afterSequence) : null };
}

export async function getEvidence(store: CaseStore, tenantId: string, evidenceId: string) {
  const result = await tenantReader(store, tenantId).query<Record<string, unknown>>(`
    select e.*, a.media_type, a.byte_length, a.backend, a.immutability_state
    from ${qualify(store.schemas.evidence, "evidence_objects")} e
    join ${qualify(store.schemas.evidence, "artifacts")} a
      on a.tenant_id = e.tenant_id and a.artifact_ref = e.artifact_ref
    where e.tenant_id = $1 and e.evidence_id = $2
  `, [tenantId, evidenceId]);
  return result.rows[0] ?? null;
}

/** The response an earlier evidence registration under this idempotency key returned, if any. */
export async function findEvidenceRegistration(store: CaseStore, tenantId: string, idempotencyKey: string): Promise<{ evidence: Record<string, unknown> } | null> {
  const result = await tenantReader(store, tenantId).query<{ response: { evidence: Record<string, unknown> } }>(`
    select response from ${qualify(store.schemas.evidence, "registration_receipts")} where tenant_id = $1 and idempotency_key = $2
  `, [tenantId, idempotencyKey]);
  return result.rows[0]?.response ?? null;
}

/**
 * The stored bytes of one evidence artifact, with its media type and digest. The content is
 * re-hashed on read and refused when it no longer matches the recorded digest.
 */
export async function getEvidenceContent(store: CaseStore, tenantId: string, evidenceId: string): Promise<{
  evidenceId: string; caseId: string; mediaType: string; rawDigest: string; content: Buffer;
} | null> {
  const result = await tenantReader(store, tenantId).query<{ evidence_id: string; case_id: string; media_type: string; raw_digest: string; content: Buffer | null;
    backend: string; storage_account: string | null; container: string | null; blob_name: string | null }>(`
    select e.evidence_id, e.case_id, a.media_type, e.raw_digest, a.content, a.backend, a.storage_account, a.container, a.blob_name
    from ${qualify(store.schemas.evidence, "evidence_objects")} e
    join ${qualify(store.schemas.evidence, "artifacts")} a
      on a.tenant_id = e.tenant_id and a.artifact_ref = e.artifact_ref
    where e.tenant_id = $1 and e.evidence_id = $2
  `, [tenantId, evidenceId]);
  const row = result.rows[0];
  if (!row) return null;
  const content = await artifactBytes(store, { ...row, digest: row.raw_digest });
  return { evidenceId: row.evidence_id, caseId: row.case_id, mediaType: row.media_type, rawDigest: row.raw_digest, content };
}

export async function verifyCaseLedger(store: CaseStore, tenantId: string, caseId: string) {
  const events = await listCaseEvents(store, tenantId, caseId);
  let previous: string | null = null;
  for (const event of events) {
    const envelope = {
      eventId: event.eventId,
      tenantId: event.tenantId,
      caseId: event.caseId,
      caseSequence: event.caseSequence,
      eventType: event.eventType,
      eventSchema: event.eventSchema,
      occurredAt: event.occurredAt,
      recordedAt: event.recordedAt,
      actor: event.actor,
      commandRef: event.commandRef,
      authority: event.authority,
      payload: event.payload,
      evidenceRefs: event.evidenceRefs,
      previousEventDigest: event.previousEventDigest,
    };
    const expected = stableDigest(envelope);
    if (event.previousEventDigest !== previous || event.eventDigest !== expected) {
      return { valid: false, caseId, checkedEvents: events.length, failedSequence: event.caseSequence };
    }
    previous = event.eventDigest;
  }
  return { valid: true, caseId, checkedEvents: events.length, headDigest: previous };
}

export { caseStoreSchemas, type CaseStoreSchemas } from "./config.js";
export {
  CanonicalRecordError,
  projectCanonicalRecords,
  readCanonicalRecords,
  recordCanonicalRecords,
  selectCanonicalRecordVersions,
  type RecordedVersion,
  type RecordSelectionTime,
} from "./canonical-records.js";
export { createAuditExport, getAuditExport, renderAuditExport } from "./audit-export.js";
export { caseStanding, getCaseAssignment, listCaseAssignments, listCaseTeams, standingFrom, upsertCaseTeam, type CaseAssignment, type CaseStanding, type CaseTeam } from "./assignment.js";
export {
  caseUnderLegalHold, getLegalHold, governTenantEvidence, listLegalHolds, placeLegalHold, reconcileTenantEvidence, releaseLegalHold,
  type GovernanceOutcome, type LegalHold, type ReconciliationFinding, type ReconciliationReport,
} from "./governance.js";
import { caseUnderLegalHold } from "./governance.js";
export { assertSkillCommitWithinEnvelope, commitSkillExecution, listSkillEffects, releaseSkillEffects, type SkillCommitAuthority, type SkillReleaseResult } from "./skill-commits.js";

/**
 * Whether a closed case's working context may be released (data-stores-plan.md §3.3): when
 * it closed, whether that close was already released, what its records cite, and whether
 * every citation names promoted `model_context` evidence, and whether an active legal hold
 * covers it.
 */
export async function getContextReleaseEligibility(store: CaseStore, tenantId: string, caseId: string): Promise<{
  caseId: string;
  status: string;
  closed: { sequence: number; at: string } | null;
  released: { sequence: number; closedSequence: number } | null;
  citedContext: Array<{ evidenceId: string; packDigest: string }>;
  unpromotedCitations: string[];
  legalHold: boolean;
} | null> {
  return withCaseTenant(store, tenantId, async (client) => {
    const caseRow = (await client.query<{ status: string }>(`select status from ${qualify(store.schemas.core, "cases")} where tenant_id = $1 and case_id = $2`, [tenantId, caseId])).rows[0];
    if (!caseRow) return null;
    const events = qualify(store.schemas.ledger, "case_events");
    const closed = (await client.query<{ case_sequence: string; recorded_at: Date }>(`
      select case_sequence, recorded_at from ${events}
      where tenant_id = $1 and case_id = $2 and event_type = 'case.status_transitioned' and payload->>'to' = 'CLOSED'
      order by case_sequence desc limit 1
    `, [tenantId, caseId])).rows[0];
    const released = closed ? (await client.query<{ case_sequence: string }>(`
      select case_sequence from ${events}
      where tenant_id = $1 and case_id = $2 and event_type = 'context.released' and (payload->>'closedSequence')::bigint = $3
      order by case_sequence desc limit 1
    `, [tenantId, caseId, Number(closed.case_sequence)])).rows[0] : undefined;
    const cited = (await client.query<{ evidence_id: string; pack_digest: string; promoted: boolean }>(`
      select distinct c.authority->>'contextEvidenceId' as evidence_id, c.authority->>'contextPackDigest' as pack_digest,
             exists (select 1 from ${qualify(store.schemas.evidence, "evidence_objects")} e
                     where e.tenant_id = c.tenant_id and e.case_id = c.case_id
                       and e.evidence_id = c.authority->>'contextEvidenceId' and e.evidence_type = 'model_context') as promoted
      from ${events} c
      where c.tenant_id = $1 and c.case_id = $2 and c.authority ? 'contextEvidenceId'
      order by 1
    `, [tenantId, caseId])).rows;
    return {
      caseId,
      status: caseRow.status,
      closed: caseRow.status === "CLOSED" && closed ? { sequence: Number(closed.case_sequence), at: closed.recorded_at.toISOString() } : null,
      released: released && closed ? { sequence: Number(released.case_sequence), closedSequence: Number(closed.case_sequence) } : null,
      citedContext: cited.map((row) => ({ evidenceId: row.evidence_id, packDigest: row.pack_digest })),
      unpromotedCitations: cited.filter((row) => !row.promoted).map((row) => row.evidence_id),
      legalHold: await caseUnderLegalHold(client, store, tenantId, caseId),
    };
  }, { readOnly: true });
}

/**
 * Record in the case's ledger that its working context was released after it closed. A
 * post-close event that changes no case state; only allowed while the case is still closed
 * at the close it names, and once per close (a replay returns the earlier event).
 */
export async function recordContextReleased(store: CaseStore, tenantId: string, caseId: string, input: {
  closedSequence: number;
  releasedAt: string;
  counts: Record<string, number | null>;
  promotedEvidenceIds: string[];
  releasedBy: string;
}): Promise<{ eventId: string; caseSequence: number; replayed: boolean }> {
  return withCaseTenant(store, tenantId, async (client) => {
    const current = (await client.query<CaseRow>(`select * from ${qualify(store.schemas.core, "cases")} where tenant_id = $1 and case_id = $2 for update`, [tenantId, caseId])).rows[0];
    if (!current) throw new CaseStoreError("case.not_found", 404);
    if (current.status !== "CLOSED") throw new CaseStoreError("context_release.case_not_closed", 409);
    const events = qualify(store.schemas.ledger, "case_events");
    const closed = (await client.query<{ case_sequence: string }>(`
      select case_sequence from ${events}
      where tenant_id = $1 and case_id = $2 and event_type = 'case.status_transitioned' and payload->>'to' = 'CLOSED'
      order by case_sequence desc limit 1
    `, [tenantId, caseId])).rows[0];
    if (!closed || Number(closed.case_sequence) !== input.closedSequence) throw new CaseStoreError("context_release.close_mismatch", 409);
    const prior = (await client.query<{ event_id: string; case_sequence: string }>(`
      select event_id, case_sequence from ${events}
      where tenant_id = $1 and case_id = $2 and event_type = 'context.released' and (payload->>'closedSequence')::bigint = $3
    `, [tenantId, caseId, input.closedSequence])).rows[0];
    if (prior) return { eventId: prior.event_id, caseSequence: Number(prior.case_sequence), replayed: true };
    const event = await appendLockedCaseEvent(client, store, current, {
      eventType: "context.released",
      eventSchema: "harness.context.released.v1",
      payload: {
        closedSequence: input.closedSequence, releasedAt: input.releasedAt, counts: input.counts,
        promotedEvidenceIds: [...input.promotedEvidenceIds].sort(),
      },
      evidenceRefs: [...input.promotedEvidenceIds].sort(),
      actor: { type: "SYSTEM", principalId: input.releasedBy, roles: ["context.release"] },
      commandId: `ctxrel_${stableDigest({ tenantId, caseId, closedSequence: input.closedSequence }).slice(0, 32)}`,
      authority: { process: "context.release", closedSequence: input.closedSequence },
    });
    return { eventId: event.eventId, caseSequence: event.sequence, replayed: false };
  });
}

export { documentRunScope, scopeDocumentSnapshot } from "./document-extraction.js";

export * from "./traversal.js";
export { contextPullRunScope, scopeContextPullSnapshot } from "./context-pull.js";
