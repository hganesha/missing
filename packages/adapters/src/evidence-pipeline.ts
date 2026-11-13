import type { AdapterResult } from "./index.js";
import { kycServiceUrl } from "./kyc-wiring.js";
import { validateProviderPayload } from "@ehf/library-contracts";
import { normalizeEvidencePackage } from "./canonical-records.js";
import { documentLayoutSchema } from "@ehf/contracts";

/**
 * Client for the KYC evidence pipeline's HTTP API (apps/evidence-pipeline,
 * `kyc-evidence-server`).
 *
 * The pipeline prepares document evidence for a human reviewer: every fact it returns is
 * provisional (`PENDING_HUMAN`) and it never decides a case. The adapter forwards one of
 * four operations, validates identifiers before they reach a URL, and returns the
 * pipeline's response unchanged under `data`, labelled `bankDecision: not_evaluated`.
 */

export const EVIDENCE_PIPELINE_OPERATIONS = ["ingest", "prepare", "package", "ownership", "resume", "pages"] as const;
export type EvidencePipelineOperation = typeof EVIDENCE_PIPELINE_OPERATIONS[number];

export type EvidencePipelineInvocation = {
  tenantId?: string;
  invocationId?: string;
  operation: string;
  input: unknown;
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  requireHttps?: boolean;
  fetch?: typeof globalThis.fetch;
};

const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const RUN_ID = /^run_[0-9a-f]{32}$/;
/** `document.ocr` requests name the pipeline's document as `kyc-evidence-pipeline:<document_id>`. */
const PIPELINE_ARTIFACT = /^kyc-evidence-pipeline:(doc_[a-f0-9]{8,64})$/;
const SHA256 = /^[a-f0-9]{64}$/;
const PROFILE_ID = /^[a-z0-9_]{1,80}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_DOCUMENT_BASE64 = 16 * 1024 * 1024;

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function operationInput(input: unknown): Json {
  const envelope = record(input);
  const nested = record(envelope.input);
  return Object.keys(nested).length ? nested : envelope;
}

function caseId(input: Json): string {
  const value = input.caseId;
  if (typeof value !== "string" || !CASE_ID.test(value) || value.includes("..")) throw new Error("adapter.evidence_pipeline_case_id_invalid");
  return value;
}

/** A supplied canonical layout (document.layout.v1), checked and bound to the document's bytes before it is sent. */
function preparedLayout(value: unknown, documentVersion: unknown): { layout?: unknown } {
  if (value === undefined || value === null) return {};
  const checked = documentLayoutSchema.safeParse(value);
  if (!checked.success || checked.data.source_sha256 !== documentVersion) throw new Error("adapter.evidence_pipeline_layout_invalid");
  return { layout: checked.data };
}

function request(operation: EvidencePipelineOperation, input: Json): { path: string; init: RequestInit; caseId: string | null; runId: string | null } {
  if (operation === "pages") {
    // The skill library's document.ocr request (`@ehf/library-contracts` PROVIDER_SCHEMAS["document.ocr"]).
    const checked = validateProviderPayload("document.ocr", "request", input);
    if (!checked.valid) throw new Error("adapter.evidence_pipeline_ocr_request_invalid");
    const artifact = PIPELINE_ARTIFACT.exec(String(input.artifact_ref));
    if (!artifact || !SHA256.test(String(input.artifact_hash))) throw new Error("adapter.evidence_pipeline_artifact_unsupported");
    return { path: `v1/documents/${artifact[1]}/pages?sha256=${String(input.artifact_hash)}`, init: { method: "GET" }, caseId: null, runId: null };
  }
  if (operation === "package" || operation === "ownership") {
    const id = caseId(input);
    return { path: `v1/cases/${id}/${operation}`, init: { method: "GET" }, caseId: id, runId: null };
  }
  if (operation === "ingest" || operation === "prepare") {
    const id = caseId(input);
    const filename = input.filename;
    const content = input.contentBase64;
    const profile = input.profile;
    if (typeof filename !== "string" || !filename.trim() || filename.length > 255) throw new Error("adapter.evidence_pipeline_filename_invalid");
    if (typeof content !== "string" || !content || content.length > MAX_DOCUMENT_BASE64 || !BASE64.test(content)) {
      throw new Error("adapter.evidence_pipeline_content_invalid");
    }
    if (profile !== undefined && (typeof profile !== "string" || !PROFILE_ID.test(profile))) throw new Error("adapter.evidence_pipeline_profile_invalid");
    if (operation === "prepare" && (typeof input.evidenceId !== "string" || !input.evidenceId || typeof input.documentId !== "string" || !/^doc_[a-f0-9]{8,64}$/.test(input.documentId) || !SHA256.test(String(input.documentVersion)))) throw new Error("adapter.evidence_pipeline_document_scope_invalid");
    return {
      path: `v1/cases/${id}/documents${operation === "prepare" ? "/prepare" : ""}`,
      init: { method: "POST", body: JSON.stringify({ filename, content_base64: content, ...(profile ? { profile } : {}),
        ...(operation === "prepare" ? { document_id: input.documentId, document_version: input.documentVersion, ...preparedLayout(input.layout, input.documentVersion) } : {}) }) },
      caseId: id,
      runId: null,
    };
  }
  const runId = input.runId;
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new Error("adapter.evidence_pipeline_run_id_invalid");
  const decision = record(input.decision);
  if (typeof decision.reviewer_id !== "string" || !Array.isArray(decision.decisions)) throw new Error("adapter.evidence_pipeline_decision_invalid");
  return { path: `v1/runs/${runId}/resume`, init: { method: "POST", body: JSON.stringify(decision) }, caseId: null, runId };
}

export async function invokeEvidencePipeline(invocation: EvidencePipelineInvocation): Promise<AdapterResult> {
  if (!invocation.token.trim()) throw new Error("adapter.evidence_pipeline_credential_missing");
  if (!(EVIDENCE_PIPELINE_OPERATIONS as readonly string[]).includes(invocation.operation)) {
    throw new Error("adapter.evidence_pipeline_operation_unsupported");
  }
  const operation = invocation.operation as EvidencePipelineOperation;
  const input = operationInput(invocation.input);
  const planned = request(operation, input);
  const fetcher = invocation.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetcher(kycServiceUrl(invocation.baseUrl, planned.path, invocation.requireHttps ?? false, "adapter.evidence_pipeline"), {
      ...planned.init,
      headers: {
        Authorization: `Bearer ${invocation.token}`,
        Accept: "application/json",
        ...(planned.init.body ? { "Content-Type": "application/json" } : {}),
      },
      redirect: "error",
      signal: AbortSignal.timeout(invocation.timeoutMs ?? 120_000),
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("gateway.source_policy_denied:")) throw error;
    if (error instanceof Error && error.message.startsWith("adapter.")) throw error;
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new Error("adapter.evidence_pipeline_timeout");
    throw new Error("adapter.evidence_pipeline_unreachable");
  }
  if (!response.ok) {
    const body = record(await response.json().catch(() => ({})));
    const code = typeof body.code === "string" && /^[A-Z_]{1,64}$/.test(body.code) ? `:${body.code}` : "";
    throw new Error(`adapter.evidence_pipeline_http_${response.status}${code}`);
  }
  let data: Json;
  try {
    data = record(await response.json());
  } catch {
    throw new Error("adapter.evidence_pipeline_response_invalid");
  }
  if (operation === "pages") {
    // A library provider capability answers in the library's own response contract, unwrapped.
    const checked = validateProviderPayload("document.ocr", "response", data);
    if (!checked.valid) throw new Error("adapter.evidence_pipeline_response_invalid");
    return { output: data, provider: "kyc-evidence-pipeline", model: "pages", providerRequestId: null, inputTokens: null, outputTokens: null, costUsd: null };
  }
  const run = record(data.run);
  const runId = typeof data.run_id === "string" ? data.run_id : typeof run.run_id === "string" ? run.run_id : planned.runId;
  const resolvedCase = typeof data.case_id === "string" ? data.case_id : planned.caseId;
  const output: Record<string, unknown> = {
    provider: "KYC_EVIDENCE_PIPELINE",
    operation,
    caseId: resolvedCase,
    runId,
    status: typeof data.status === "string" ? data.status : "UNKNOWN",
    reviewRequired: data.status === "PAUSED_FOR_REVIEW",
    bankDecision: "not_evaluated",
    data,
  };
  // A package is read evidence; its cited spans become DocumentPage/Evidence records.
  if (operation === "package" || operation === "prepare") {
    // Pure preparation does not retain a pipeline artifact. Its original remains in EHF.
    const normalizedData = operation === "prepare" ? { ...data, documents: Array.isArray(data.documents) ? data.documents.map(document => ({ ...record(document), artifact_ref: `ehf:case-evidence:${String(input.evidenceId)}` })) : [] } : data;
    const normalized = normalizeEvidencePackage({ ...output, data: normalizedData, operation: "package" }, { connectorId: "evidence:package",
      ...(invocation.tenantId ? { tenantId: invocation.tenantId } : {}),
      ...(invocation.invocationId ? { invocationId: invocation.invocationId } : {}) });
    output.records = normalized.records;
    output.recordGap = normalized.recordGap;
  }
  return {
    output,
    provider: "kyc-evidence-pipeline",
    model: operation,
    providerRequestId: runId ?? null,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };
}
