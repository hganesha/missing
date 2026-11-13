import { createHash, randomUUID } from "node:crypto";
import { sourceEvidenceObservationSchema } from "@ehf/contracts";
import type { AdapterResult } from "./index.js";
import { normalizeWiringResult, type RecordSourceContext } from "./canonical-records.js";

/**
 * Client for the KYC API wiring service (apps/kyc-wiring).
 *
 * The wiring service owns every vendor connection: it accepts a canonical host request,
 * queues a check, and returns a canonical host result. This adapter only builds the
 * request from gateway input, polls the check within one bounded deadline, and maps the
 * result back. It never turns a provider result into a decision: `bankDecision` is
 * always `not_evaluated`, and anything other than a completed, well-formed result is
 * reported as outcome `unknown` with an error, never as `passed`.
 */

export const KYC_WIRING_OPERATION_PATTERN = /^[a-z0-9-]+:[a-z_.]+$/;

/**
 * Wiring operations the v2 canonical capability model (data-adapters
 * docs/CANONICAL_EXTERNAL_CAPABILITY_MODEL.md, section 5.2) does not let a platform capability
 * bind: `migration_required` operations were catalogued under a capability their source does not
 * provide (e.g. FinCEN BOI under business-registry lookup), and `quarantined` ones must not be
 * connected. Mirrors the `canonical.runtimeDisposition` of config/connector-catalog.json; the
 * gateway tests fail if the two drift.
 */
export const KYC_WIRING_BLOCKED_BINDINGS: Readonly<Record<string, "migration_required" | "quarantined">> = {
  "argentina-arca:business.registry.lookup": "migration_required",
  "bahrain-benefit-ekyc:business.registry.lookup": "migration_required",
  "brazil-receita-federal:business.registry.lookup": "migration_required",
  "cersai-ckycr:identity.person.verify": "migration_required",
  "digilocker:identity.digital_id.verify": "migration_required",
  "finantier:account.ownership.verify": "quarantined",
  "finantier:financial.evidence.retrieve": "quarantined",
  "fincen-boi:business.registry.lookup": "migration_required",
  "gleif-vlei-ecosystem:reference.identifier.lookup": "migration_required",
  "gstn:business.registry.lookup": "migration_required",
  "mexico-renapo:business.registry.lookup": "migration_required",
  "mexico-sat:business.registry.lookup": "migration_required",
  "protean-egov:identity.person.verify": "migration_required",
  "saudi-elm:business.registry.lookup": "migration_required",
  "wolfsberg-group:questionnaire.collect": "migration_required",
};

/**
 * Why a capability must not be bound to a wiring operation, or null. A wiring operation
 * `<provider>:<capability>` serves only the platform capability of that name (`<capability>.v<n>`):
 * the wiring service executes that legacy contract, so binding it to another capability would
 * substitute non-equivalent semantics (an account profile for an ownership check, a list download
 * for screening).
 */
export function kycWiringBindingProblem(capabilityId: string, bindingName: string): string | null {
  const legacyCapability = bindingName.slice(bindingName.indexOf(":") + 1);
  if (capabilityId.replace(/\.v[0-9]+$/, "") !== legacyCapability) return "gateway.wiring_capability_mismatch";
  const blocked = KYC_WIRING_BLOCKED_BINDINGS[bindingName];
  if (blocked === "migration_required") return "gateway.wiring_binding_migration_required";
  if (blocked === "quarantined") return "gateway.wiring_binding_quarantined";
  return null;
}

export type KycWiringInvocation = {
  /** Gateway-derived scope; caller input never supplies this authority. */
  authorizedScope?: {
    purpose: string; legalBasis: string; policyId: string; policyVersion: string; jurisdictions: string[];
    processingRegions: string[]; datasetIds: string[]; signRequest: (body: string) => Promise<string>;
  };
  /** `<provider_id>:<capability>`, e.g. `opensanctions:screening.pep`. */
  operationId: string;
  input: unknown;
  baseUrl: string;
  token: string;
  /** The tenant the wiring service binds to `token`; requests must carry it. */
  wiringTenantId: string;
  /** Platform tenant and invocation, used only to derive a stable idempotency key. */
  tenantId?: string;
  invocationId?: string;
  /** Total budget for submit, polling and result retrieval. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  requireHttps?: boolean;
  fetch?: typeof globalThis.fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export type KycWiringOutcome = "passed" | "failed" | "review" | "resubmit" | "inconclusive" | "not_checked" | "not_applicable" | "unknown";

const outcomes = new Set<KycWiringOutcome>(["passed", "failed", "review", "resubmit", "inconclusive", "not_checked", "not_applicable", "unknown"]);
const terminalStatuses = new Set(["completed", "partial", "failed", "dead_letter", "reconciliation_required", "authorization_required"]);
const successfulStatuses = new Set(["completed", "partial"]);
const organizationCapabilityPrefixes = ["business.", "reference.", "entity."];

type Json = Record<string, unknown>;

function record(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
}

function text(source: Json, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = source[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function strings(value: unknown, pattern?: RegExp): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim())
    .filter((item) => !pattern || pattern.test(item)))];
}

function bounded(value: string | undefined, max: number, code: string): string | undefined {
  if (value !== undefined && value.length > max) throw new Error(code);
  return value;
}

/** Resolve a service path, refusing credentials, fragments and (when required) plain HTTP. */
export function kycServiceUrl(baseUrl: string, path: string, requireHttps: boolean, errorPrefix: string): URL {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error(`${errorPrefix}_url_invalid`);
  }
  if (!["https:", "http:"].includes(base.protocol) || base.username || base.password || base.hash || base.search) {
    throw new Error(`${errorPrefix}_url_invalid`);
  }
  if (requireHttps && base.protocol !== "https:") throw new Error(`${errorPrefix}_url_insecure`);
  return new URL(path.replace(/^\//, ""), `${base.toString().replace(/\/$/, "")}/`);
}

function partialDate(value: string): { value: string; precision: "year" | "month" | "day" } {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return { value, precision: "day" };
  if (/^\d{4}-\d{2}$/.test(value)) return { value, precision: "month" };
  if (/^\d{4}$/.test(value)) return { value, precision: "year" };
  throw new Error("adapter.kyc_wiring_dob_invalid");
}

/**
 * Build a CanonicalHostRequest (vendor/atlas/schemas/request.schema.json) for one subject.
 *
 * Gateway input is either `{ subject: {...}, caseId, purpose, jurisdictions }` or the flat
 * `{ name, country, dateOfBirth }` shape the existing screening capabilities receive.
 */
export function buildKycWiringRequest(options: {
  operationId: string;
  input: unknown;
  wiringTenantId: string;
  idempotencyKey: string;
}): { providerId: string; request: Json } {
  if (!KYC_WIRING_OPERATION_PATTERN.test(options.operationId)) throw new Error("adapter.kyc_wiring_operation_invalid");
  const separator = options.operationId.indexOf(":");
  const providerId = options.operationId.slice(0, separator);
  const capability = options.operationId.slice(separator + 1);
  const envelope = record(options.input);
  // Accept the `{ input: {...} }` envelope the other adapters accept as well as bare input.
  const nested = record(envelope.input);
  const outer = Object.keys(nested).length ? nested : envelope;
  const subject = Object.keys(record(outer.subject)).length ? record(outer.subject) : outer;

  const name = bounded(text(subject, "name", "legalName", "fullName", "subject"), 500, "adapter.kyc_wiring_name_invalid");
  const declaredType = text(subject, "type", "entityType", "schema")?.toLowerCase();
  const entityType = declaredType === "organization" || declaredType === "company" || declaredType === "organisation"
    ? "organization"
    : declaredType === "person" || declaredType === "individual"
      ? "person"
      : organizationCapabilityPrefixes.some((prefix) => capability.startsWith(prefix)) ? "organization" : "person";
  const country = text(subject, "country", "jurisdiction")?.toUpperCase();
  if (country !== undefined && !/^[A-Z]{2}$/.test(country)) throw new Error("adapter.kyc_wiring_country_invalid");
  const dob = text(subject, "dob", "dateOfBirth", "birthDate");
  const registrationNumber = bounded(text(subject, "registrationNumber", "companyNumber"), 64, "adapter.kyc_wiring_registration_invalid");
  const lei = text(subject, "lei")?.toUpperCase();
  if (lei !== undefined && !/^[A-Z0-9]{18}[0-9]{2}$/.test(lei)) throw new Error("adapter.kyc_wiring_lei_invalid");
  const providerRecordId = bounded(
    text(subject, "providerRecordId") ?? text(outer, "providerRecordId")
      ?? (providerId === "gleif" ? lei : undefined)
      ?? (providerId === "companies-house" ? registrationNumber : undefined),
    200,
    "adapter.kyc_wiring_record_invalid",
  );
  if (!name && !lei && !registrationNumber && !providerRecordId) throw new Error("adapter.kyc_wiring_subject_missing");

  const identifiers = [
    ...(registrationNumber ? [{ scheme: "company_registration_number", value: registrationNumber, ...(country ? { jurisdiction: country } : {}) }] : []),
    ...(lei ? [{ scheme: "lei", value: lei }] : []),
  ];
  const entity: Json = {
    entity_id: "subject",
    entity_type: entityType,
    names: name ? [{ full: name, kind: "legal" }] : [],
    identifiers,
  };
  if (country) {
    if (entityType === "organization") entity.jurisdiction = country;
    else entity.addresses = [{ kind: "unknown", country }];
  }
  if (dob && entityType === "person") entity.birth_date = partialDate(dob);

  const jurisdictions = strings(outer.jurisdictions, /^[A-Z]{2}$/);
  const effectiveJurisdictions = jurisdictions.length ? jurisdictions : country ? [country] : [];
  const residency = strings(outer.dataResidency, /^[A-Z]{2}$/);
  const caseId = bounded(text(outer, "caseId"), 200, "adapter.kyc_wiring_case_invalid");
  const query = bounded(text(outer, "query"), 1000, "adapter.kyc_wiring_query_invalid");
  const documentRefs = strings(outer.documentRefs);
  const input: Json = {
    ...(providerRecordId ? { provider_record_id: providerRecordId } : {}),
    ...(query ? { query } : {}),
    ...(documentRefs.length ? { document_vault_refs: documentRefs } : {}),
  };
  return {
    providerId,
    request: {
      schema_version: "1.0.0",
      request_id: options.idempotencyKey,
      tenant_id: options.wiringTenantId,
      idempotency_key: options.idempotencyKey,
      capability,
      subject_entity_id: "subject",
      entities: [entity],
      purpose: bounded(text(outer, "purpose"), 200, "adapter.kyc_wiring_purpose_invalid") ?? "customer_due_diligence",
      legal_basis: bounded(text(outer, "legalBasis"), 200, "adapter.kyc_wiring_legal_basis_invalid") ?? "regulatory_obligation_customer_due_diligence",
      policy: {
        policy_id: bounded(text(outer, "policyId"), 200, "adapter.kyc_wiring_policy_invalid") ?? "ehf-kyc",
        policy_version: bounded(text(outer, "policyVersion"), 100, "adapter.kyc_wiring_policy_invalid") ?? "1",
        jurisdictions: effectiveJurisdictions,
        data_residency_allowlist: residency.length ? residency : effectiveJurisdictions,
      },
      routing: { provider_allowlist: [providerId], required_datasets: [], allow_fallback: false },
      input,
      extensions: { source: "ehf-capability-gateway", ...(caseId ? { case_id: caseId } : {}) },
    },
  };
}

function idempotencyKeyFor(invocation: KycWiringInvocation): string {
  if (!invocation.invocationId) return `ehf-${randomUUID()}`;
  const digest = createHash("sha256")
    .update(`${invocation.tenantId ?? ""}\n${invocation.invocationId}\n${invocation.operationId}`)
    .digest("hex");
  return `ehf-${digest.slice(0, 40)}`;
}

function evidenceRef(value: unknown) {
  const item = record(value);
  return {
    evidenceId: typeof item.evidence_id === "string" ? item.evidence_id : null,
    providerId: typeof item.provider_id === "string" ? item.provider_id : null,
    sourceRecordId: typeof item.source_record_id === "string" ? item.source_record_id : null,
    sourceUrl: typeof item.source_url === "string" ? item.source_url : null,
    sourceTitle: typeof item.source_title === "string" ? item.source_title : null,
    retrievedAt: typeof item.retrieved_at === "string" ? item.retrieved_at : null,
    contentSha256: typeof item.content_sha256 === "string" ? item.content_sha256 : null,
    authority: typeof item.authority === "string" ? item.authority : "unknown",
  };
}

type ErrorDetail = { code: string; message: string };

/**
 * Map a CanonicalHostResult (or its absence) to the gateway output.
 *
 * Fail closed: the provider's outcome passes through only for a completed or partial
 * check whose result has a recognized outcome and a non-failed execution status.
 */
export function mapKycWiringResult(options: {
  operationId: string;
  checkId: string;
  checkStatus: string;
  checkError?: string | null;
  result: unknown;
  /** Where the records came from; the output always carries `records` and `recordGap`. */
  recordSource?: Omit<RecordSourceContext, "connectorId">;
}) {
  const host = record(options.result);
  const assessment = record(host.assessment);
  const execution = record(host.execution);
  const extensions = record(host.extensions);
  const warnings = strings(host.warnings);
  const errors = Array.isArray(host.errors) ? host.errors.filter((item) => item && typeof item === "object") : [];
  let error: ErrorDetail | null = null;
  let outcome: KycWiringOutcome = "unknown";
  const declared = typeof assessment.outcome === "string" ? assessment.outcome : undefined;
  if (!successfulStatuses.has(options.checkStatus)) {
    error = { code: `wiring.check_${options.checkStatus}`, message: options.checkError ?? `The wiring check ended ${options.checkStatus}.` };
  } else if (!options.result || typeof options.result !== "object") {
    error = { code: "wiring.result_missing", message: "The wiring check completed without a result." };
  } else if (!declared || !outcomes.has(declared as KycWiringOutcome)) {
    error = { code: "wiring.outcome_unrecognized", message: "The result carried no recognized assessment outcome." };
  } else if (execution.status !== "completed" && execution.status !== "partial") {
    error = { code: "wiring.execution_not_completed", message: `The provider execution status is ${String(execution.status ?? "missing")}.` };
  } else {
    outcome = declared as KycWiringOutcome;
  }
  if (typeof assessment.bank_decision === "string" && assessment.bank_decision !== "not_evaluated") {
    warnings.push("BANK_DECISION_IGNORED: the wiring result carried a bank decision; the platform never accepts one from a provider");
  }
  const [providerId] = options.operationId.split(":");
  const executionMode = typeof extensions.execution_mode === "string" ? extensions.execution_mode : "unknown";
  // Canonical records for the case store (canonical-records.ts): none unless the check
  // established something; a gap otherwise.
  const normalized = normalizeWiringResult({
    operationId: options.operationId, outcome, error, providerCheckId: options.checkId, executionMode, warnings, host: options.result,
  }, { ...options.recordSource, connectorId: `wiring:${options.operationId}` });
  return {
    status: error ? "UNKNOWN" : "OK",
    provider: "KYC_WIRING",
    operationId: options.operationId,
    providerId,
    capability: options.operationId.slice(options.operationId.indexOf(":") + 1),
    providerCheckId: options.checkId,
    checkStatus: options.checkStatus,
    executionMode,
    resultId: typeof host.result_id === "string" ? host.result_id : null,
    outcome,
    reasonCodes: strings(assessment.reason_codes),
    bankDecision: "not_evaluated" as const,
    coverage: host.coverage && typeof host.coverage === "object" ? host.coverage : { status: "unknown" },
    result: host.result && typeof host.result === "object" ? host.result : null,
    assertions: Array.isArray(host.assertions) ? host.assertions : [],
    evidenceRefs: Array.isArray(host.evidence) ? host.evidence.map(evidenceRef) : [],
    warnings,
    errors,
    error,
    records: normalized.records,
    recordGap: normalized.recordGap,
    ...(normalized.subjectEntityId ? { subjectEntityId: normalized.subjectEntityId } : {}),
    canonical: canonicalProvenance(extensions.canonical),
  };
}

const CANONICAL_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*\.intelligence\.([a-z]{2}(_[a-z0-9]+)?|global|unresolved)$/;

/**
 * The v2 canonical provenance the wiring service echoes in `extensions.canonical`: which v2
 * binding, canonical capability and jurisdiction served the check. Kept only when well formed;
 * an `approved` jurisdiction is the operator's reference, never a platform finding.
 */
export function canonicalProvenance(value: unknown): {
  bindingId: string;
  capabilityId: string;
  capabilityDefinitionRef: string | null;
  modelVersion: string | null;
  jurisdiction: { code: string; basis: string | null; resolutionStatus: string; approvalRef: string | null };
} | null {
  const source = record(value);
  const jurisdiction = record(source.jurisdiction);
  const bindingId = text(source, "binding_id");
  const capabilityId = text(source, "capability_id");
  const code = text(jurisdiction, "code");
  const resolutionStatus = text(jurisdiction, "resolution_status");
  if (!bindingId || !capabilityId || !CANONICAL_KEY.test(capabilityId) || !code || !resolutionStatus) return null;
  if (!capabilityId.endsWith(`.intelligence.${code}`)) return null;
  return {
    bindingId,
    capabilityId,
    capabilityDefinitionRef: text(source, "capability_definition_ref") ?? null,
    modelVersion: text(source, "model_version") ?? null,
    jurisdiction: { code, basis: text(jurisdiction, "basis") ?? null, resolutionStatus, approvalRef: text(jurisdiction, "approval_ref") ?? null },
  };
}

async function readJson(response: Response, errorPrefix: string): Promise<Json> {
  try {
    return record(await response.json());
  } catch {
    throw new Error(`${errorPrefix}_response_invalid`);
  }
}

export async function invokeKycWiring(invocation: KycWiringInvocation): Promise<AdapterResult> {
  if (!invocation.token.trim()) throw new Error("adapter.kyc_wiring_credential_missing");
  if (!invocation.wiringTenantId.trim()) throw new Error("adapter.kyc_wiring_tenant_missing");
  const now = invocation.now ?? Date.now;
  const sleep = invocation.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const fetcher = invocation.fetch ?? globalThis.fetch;
  const requireHttps = invocation.requireHttps ?? false;
  const deadline = now() + Math.max(1_000, invocation.timeoutMs ?? 30_000);
  const idempotencyKey = idempotencyKeyFor(invocation);
  const { providerId, request } = buildKycWiringRequest({
    operationId: invocation.operationId,
    input: invocation.input,
    wiringTenantId: invocation.wiringTenantId,
    idempotencyKey,
  });
  if (invocation.authorizedScope) {
    const scope = invocation.authorizedScope;
    request.purpose = scope.purpose;
    request.legal_basis = scope.legalBasis;
    request.policy = { policy_id: scope.policyId, policy_version: scope.policyVersion, jurisdictions: scope.jurisdictions,
      data_residency_allowlist: scope.processingRegions };
    request.routing = { provider_allowlist: [providerId], required_datasets: scope.datasetIds, allow_fallback: false };
  }
  const headers = { Authorization: `Bearer ${invocation.token}`, Accept: "application/json" };
  const call = async (path: string, init: RequestInit = {}) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error("adapter.kyc_wiring_timeout");
    try {
      return await fetcher(kycServiceUrl(invocation.baseUrl, path, requireHttps, "adapter.kyc_wiring"), {
        ...init,
        headers: { ...headers, ...(init.headers as Record<string, string> | undefined) },
        redirect: "error",
        signal: AbortSignal.timeout(Math.min(remaining, 15_000)),
      });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("gateway.source_policy_denied:")) throw error;
      if (error instanceof Error && error.message.startsWith("adapter.")) throw error;
      if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) throw new Error("adapter.kyc_wiring_timeout");
      throw new Error("adapter.kyc_wiring_unreachable");
    }
  };

  const requestBody = JSON.stringify({ provider_id: providerId, request });
  const proof = await invocation.authorizedScope?.signRequest(requestBody);
  const submitted = await call("v1/checks", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey, ...(proof ? { "X-Source-Authorization": proof } : {}) },
    body: requestBody,
  });
  if (!submitted.ok) {
    const body = await submitted.json().catch(() => ({})) as Json;
    const code = typeof body.code === "string" && /^[A-Z_]{1,64}$/.test(body.code) ? `:${body.code}` : "";
    throw new Error(`adapter.kyc_wiring_http_${submitted.status}${code}`);
  }
  const accepted = record((await readJson(submitted, "adapter.kyc_wiring")).check);
  const checkId = accepted.id;
  if (typeof checkId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(checkId)) throw new Error("adapter.kyc_wiring_response_invalid");
  let status = typeof accepted.status === "string" ? accepted.status : "queued";
  let checkError = typeof accepted.error === "string" ? accepted.error : null;

  let interval = Math.max(50, invocation.pollIntervalMs ?? 500);
  while (!terminalStatuses.has(status) || status === "authorization_required" && invocation.authorizedScope) {
    if (deadline - now() <= interval) throw new Error("adapter.kyc_wiring_timeout");
    await sleep(interval);
    interval = Math.min(interval * 2, 2_000);
    if (invocation.authorizedScope) {
      const renewed = await invocation.authorizedScope.signRequest(requestBody);
      const refreshed = await call("v1/checks", { method: "POST", body: requestBody,
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey, "X-Source-Authorization": renewed } });
      if (!refreshed.ok) throw new Error(`adapter.kyc_wiring_http_${refreshed.status}:SOURCE_AUTHORIZATION_DENIED`);
    }
    const polled = await call(`v1/checks/${encodeURIComponent(checkId)}`);
    if (!polled.ok) throw new Error(`adapter.kyc_wiring_http_${polled.status}`);
    const check = await readJson(polled, "adapter.kyc_wiring");
    if (typeof check.status !== "string") throw new Error("adapter.kyc_wiring_response_invalid");
    status = check.status;
    checkError = typeof check.error === "string" ? check.error : null;
  }

  let result: unknown = null;
  if (successfulStatuses.has(status)) {
    const fetched = await call(`v1/checks/${encodeURIComponent(checkId)}/results?limit=1`);
    if (!fetched.ok) throw new Error(`adapter.kyc_wiring_http_${fetched.status}`);
    const body = await readJson(fetched, "adapter.kyc_wiring");
    result = Array.isArray(body.items) ? body.items[0] ?? null : null;
  }
  const output = mapKycWiringResult({
    operationId: invocation.operationId, checkId, checkStatus: status, checkError, result,
    recordSource: {
      ...(text(record(invocation.input), "subjectId") ? { subjectId: text(record(invocation.input), "subjectId")! } : {}),
      ...(invocation.tenantId ? { tenantId: invocation.tenantId } : {}),
      ...(invocation.invocationId ? { invocationId: invocation.invocationId } : {}),
    },
  });
  const observation = sourceEvidenceObservationSchema.safeParse(record(record(result).extensions).source_evidence);
  return {
    output,
    ...(observation.success && status === "completed" && output.executionMode === "live" && !output.error ? { sourceEvidence: observation.data } : {}),
    provider: "kyc-wiring",
    model: invocation.operationId,
    providerRequestId: checkId,
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };
}
