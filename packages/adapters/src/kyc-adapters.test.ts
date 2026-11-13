import { describe, expect, it } from "vitest";
import { buildKycWiringRequest, invokeEvidencePipeline, invokeKycWiring, mapKycWiringResult } from "./index.js";

type Call = { url: string; init: RequestInit };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function scripted(responses: Array<Response | ((call: Call) => Response)>) {
  const calls: Call[] = [];
  const fetch = (async (url: URL | string, init: RequestInit = {}) => {
    const call = { url: url.toString(), init };
    calls.push(call);
    const next = responses.shift();
    if (!next) throw new Error("unexpected fetch");
    return typeof next === "function" ? next(call) : next;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const hostResult = {
  result_id: "res_1",
  assessment: { outcome: "review", reason_codes: ["POSSIBLE_PEP_MATCH"], bank_decision: "not_evaluated" },
  execution: { status: "completed", received_at: "2026-11-07T00:00:00Z" },
  coverage: { status: "complete_for_requested_scope", requested_scope: ["pep"], checked_scope: ["pep"], not_checked_scope: [] },
  assertions: [{ assertion_id: "a1", entity_id: "subject", field_path: "names", value: "Jane", verification: "unknown", evidence_ids: ["ev1"] }],
  evidence: [{ evidence_id: "ev1", provider_id: "opensanctions", source_url: "https://example.test/e/1", authority: "commercial", raw: "dropped" }],
  result: { kind: "screening", matches: [] },
  errors: [],
  warnings: ["DEMO_ONLY_NO_VENDOR_CALL"],
  extensions: { execution_mode: "simulation" },
};

const base = {
  baseUrl: "http://kyc-wiring:8000",
  token: "demo-token-local-only",
  wiringTenantId: "demo-tenant",
  tenantId: "tenant_demo",
  invocationId: "inv_1",
  sleep: async () => {},
};

describe("KYC wiring adapter", () => {
  it("builds a schema-shaped canonical host request from subject input", () => {
    const { providerId, request } = buildKycWiringRequest({
      operationId: "companies-house:business.registry.lookup",
      input: { subject: { name: "Example Workshop Ltd", country: "gb", registrationNumber: "00000001" }, caseId: "case-1", jurisdictions: ["GB"] },
      wiringTenantId: "demo-tenant",
      idempotencyKey: "ehf-key",
    });
    expect(providerId).toBe("companies-house");
    expect(request).toMatchObject({
      schema_version: "1.0.0",
      tenant_id: "demo-tenant",
      idempotency_key: "ehf-key",
      request_id: "ehf-key",
      capability: "business.registry.lookup",
      subject_entity_id: "subject",
      entities: [{ entity_id: "subject", entity_type: "organization", jurisdiction: "GB", names: [{ full: "Example Workshop Ltd", kind: "legal" }], identifiers: [{ scheme: "company_registration_number", value: "00000001", jurisdiction: "GB" }] }],
      policy: { jurisdictions: ["GB"], data_residency_allowlist: ["GB"] },
      routing: { provider_allowlist: ["companies-house"], required_datasets: [], allow_fallback: false },
      input: { provider_record_id: "00000001" },
      extensions: { case_id: "case-1" },
    });
  });

  it("accepts the flat screening input and marks a person with a partial birth date", () => {
    const { request } = buildKycWiringRequest({ operationId: "opensanctions:screening.pep", input: { input: { name: "Jane Doe", dateOfBirth: "1970-05", country: "US" } }, wiringTenantId: "t", idempotencyKey: "k" });
    expect(request.entities).toEqual([{ entity_id: "subject", entity_type: "person", names: [{ full: "Jane Doe", kind: "legal" }], identifiers: [], addresses: [{ kind: "unknown", country: "US" }], birth_date: { value: "1970-05", precision: "month" } }]);
  });

  it.each([
    ["opensanctions", { name: "x" }, "adapter.kyc_wiring_operation_invalid"],
    ["Opensanctions:screening.pep", { name: "x" }, "adapter.kyc_wiring_operation_invalid"],
    ["opensanctions:screening.pep", {}, "adapter.kyc_wiring_subject_missing"],
    ["gleif:reference.identifier.lookup", { lei: "not-an-lei" }, "adapter.kyc_wiring_lei_invalid"],
    ["opensanctions:screening.pep", { name: "x", country: "USA" }, "adapter.kyc_wiring_country_invalid"],
    ["opensanctions:screening.pep", { name: "x", dateOfBirth: "05/1970" }, "adapter.kyc_wiring_dob_invalid"],
  ])("rejects invalid input for %s", (operationId, input, error) => {
    expect(() => buildKycWiringRequest({ operationId, input, wiringTenantId: "t", idempotencyKey: "k" })).toThrow(error);
  });

  it("submits with a stable idempotency key, polls to completion and maps the result", async () => {
    const { fetch, calls } = scripted([
      json({ check: { id: "chk_1", status: "queued" } }, 202),
      json({ id: "chk_1", status: "running" }),
      json({ id: "chk_1", status: "completed" }),
      json({ check_id: "chk_1", status: "completed", items: [hostResult] }),
    ]);
    const result = await invokeKycWiring({ ...base, operationId: "opensanctions:screening.pep", input: { name: "Jane Doe" }, fetch });
    expect(calls.map((call) => `${call.init.method ?? "GET"} ${call.url}`)).toEqual([
      "POST http://kyc-wiring:8000/v1/checks",
      "GET http://kyc-wiring:8000/v1/checks/chk_1",
      "GET http://kyc-wiring:8000/v1/checks/chk_1",
      "GET http://kyc-wiring:8000/v1/checks/chk_1/results?limit=1",
    ]);
    const submit = calls[0]!;
    const headers = submit.init.headers as Record<string, string>;
    const body = JSON.parse(String(submit.init.body)) as { provider_id: string; request: { idempotency_key: string } };
    expect(headers.Authorization).toBe("Bearer demo-token-local-only");
    expect(headers["Idempotency-Key"]).toBe(body.request.idempotency_key);
    expect(body.provider_id).toBe("opensanctions");
    expect(calls.every((call) => call.init.redirect === "error")).toBe(true);
    const again = scripted([json({ check: { id: "chk_1", status: "completed" } }, 202), json({ items: [hostResult] })]);
    await invokeKycWiring({ ...base, operationId: "opensanctions:screening.pep", input: { name: "Jane Doe" }, fetch: again.fetch });
    expect((again.calls[0]!.init.headers as Record<string, string>)["Idempotency-Key"]).toBe(headers["Idempotency-Key"]);

    expect(result).toMatchObject({ provider: "kyc-wiring", model: "opensanctions:screening.pep", providerRequestId: "chk_1", costUsd: null });
    expect(result.output).toMatchObject({
      status: "OK",
      outcome: "review",
      reasonCodes: ["POSSIBLE_PEP_MATCH"],
      bankDecision: "not_evaluated",
      providerCheckId: "chk_1",
      executionMode: "simulation",
      coverage: { status: "complete_for_requested_scope" },
      result: { kind: "screening" },
      warnings: ["DEMO_ONLY_NO_VENDOR_CALL"],
      error: null,
    });
    expect((result.output as { evidenceRefs: unknown[] }).evidenceRefs).toEqual([{ evidenceId: "ev1", providerId: "opensanctions", sourceRecordId: null, sourceUrl: "https://example.test/e/1", sourceTitle: null, retrievedAt: null, contentSha256: null, authority: "commercial" }]);
  });

  it("fails closed when the check fails or the result is unusable", async () => {
    const failed = scripted([json({ check: { id: "chk_2", status: "queued" } }, 202), json({ id: "chk_2", status: "dead_letter", error: "PROVIDER_TIMEOUT" })]);
    const output = (await invokeKycWiring({ ...base, operationId: "opensanctions:screening.pep", input: { name: "Jane" }, fetch: failed.fetch })).output;
    expect(failed.calls).toHaveLength(2);
    expect(output).toMatchObject({ status: "UNKNOWN", outcome: "unknown", bankDecision: "not_evaluated", error: { code: "wiring.check_dead_letter", message: "PROVIDER_TIMEOUT" } });

    const map = (result: unknown, checkStatus = "completed") => mapKycWiringResult({ operationId: "p:screening.pep", checkId: "c", checkStatus, result });
    expect(map(null)).toMatchObject({ outcome: "unknown", error: { code: "wiring.result_missing" } });
    expect(map({ ...hostResult, assessment: { outcome: "cleared", reason_codes: [] } })).toMatchObject({ outcome: "unknown", error: { code: "wiring.outcome_unrecognized" } });
    expect(map({ ...hostResult, assessment: { ...hostResult.assessment, outcome: "passed" }, execution: { status: "failed" } })).toMatchObject({ outcome: "unknown", error: { code: "wiring.execution_not_completed" } });
    expect(map({ ...hostResult, assessment: { ...hostResult.assessment, outcome: "passed" } }, "reconciliation_required")).toMatchObject({ outcome: "unknown" });
    const decided = map({ ...hostResult, assessment: { outcome: "passed", reason_codes: [], bank_decision: "approve" } });
    expect(decided).toMatchObject({ outcome: "passed", bankDecision: "not_evaluated" });
    expect(decided.warnings.some((warning) => warning.startsWith("BANK_DECISION_IGNORED"))).toBe(true);
  });

  it("surfaces submission errors, bounds the total time and refuses insecure or missing configuration", async () => {
    const rejected = scripted([json({ code: "ROUTING_DENIED", message: "no" }, 403)]);
    await expect(invokeKycWiring({ ...base, operationId: "opensanctions:screening.pep", input: { name: "Jane" }, fetch: rejected.fetch }))
      .rejects.toThrow("adapter.kyc_wiring_http_403:ROUTING_DENIED");

    let clock = 0;
    const slow = scripted([json({ check: { id: "chk_3", status: "queued" } }, 202), () => json({ id: "chk_3", status: "running" }), () => json({ id: "chk_3", status: "running" })]);
    await expect(invokeKycWiring({ ...base, operationId: "opensanctions:screening.pep", input: { name: "Jane" }, fetch: slow.fetch, timeoutMs: 1_500, pollIntervalMs: 500, now: () => clock, sleep: async (ms) => { clock += ms; } }))
      .rejects.toThrow("adapter.kyc_wiring_timeout");
    expect(slow.calls.length).toBeLessThanOrEqual(3);

    await expect(invokeKycWiring({ ...base, operationId: "opensanctions:screening.pep", input: { name: "Jane" }, requireHttps: true, fetch: scripted([]).fetch }))
      .rejects.toThrow("adapter.kyc_wiring_url_insecure");
    await expect(invokeKycWiring({ ...base, token: " ", operationId: "opensanctions:screening.pep", input: { name: "Jane" }, fetch: scripted([]).fetch }))
      .rejects.toThrow("adapter.kyc_wiring_credential_missing");
    await expect(invokeKycWiring({ ...base, baseUrl: "http://user:pw@kyc-wiring:8000", operationId: "opensanctions:screening.pep", input: { name: "Jane" }, fetch: scripted([]).fetch }))
      .rejects.toThrow("adapter.kyc_wiring_url_invalid");
    const unreachable = (async () => { throw new TypeError("fetch failed"); }) as typeof globalThis.fetch;
    await expect(invokeKycWiring({ ...base, operationId: "opensanctions:screening.pep", input: { name: "Jane" }, fetch: unreachable }))
      .rejects.toThrow("adapter.kyc_wiring_unreachable");
  });
});

describe("evidence pipeline adapter: document.ocr pages", () => {
  const pipeline = { baseUrl: "http://evidence-pipeline:8080/", token: "evidence-demo-token-local-only" };
  const hash = "a".repeat(64);

  it("serves the library's document.ocr contract from the pipeline's decoded pages, bound to the artifact hash", async () => {
    const calls: string[] = [];
    const fetch = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ pages: [{ page: 1, text: "Passport\nSurname: SMITH" }], parser: { name: "kyc-evidence-pipeline:native", version: "0.1.0" } }), { status: 200 });
    }) as typeof globalThis.fetch;
    const result = await invokeEvidencePipeline({ ...pipeline, operation: "pages", input: { artifact_ref: "kyc-evidence-pipeline:doc_0123456789abcdef", artifact_hash: hash, media_type: "text/plain" }, fetch });
    expect(calls).toEqual([`http://evidence-pipeline:8080/v1/documents/doc_0123456789abcdef/pages?sha256=${hash}`]);
    expect(result.output).toEqual({ pages: [{ page: 1, text: "Passport\nSurname: SMITH" }], parser: { name: "kyc-evidence-pipeline:native", version: "0.1.0" } });
  });

  it("refuses an artifact the pipeline did not parse and an answer outside the contract", async () => {
    const bad = (async () => new Response(JSON.stringify({ pages: "nope" }), { status: 200 })) as typeof globalThis.fetch;
    await expect(invokeEvidencePipeline({ ...pipeline, operation: "pages", input: { artifact_ref: "artifact://postgres/x", artifact_hash: hash, media_type: "application/pdf" }, fetch: bad }))
      .rejects.toThrow("adapter.evidence_pipeline_artifact_unsupported");
    await expect(invokeEvidencePipeline({ ...pipeline, operation: "pages", input: { artifact_ref: "kyc-evidence-pipeline:doc_0123456789abcdef", artifact_hash: hash, media_type: "text/plain" }, fetch: bad }))
      .rejects.toThrow("adapter.evidence_pipeline_response_invalid");
  });
});

describe("evidence pipeline adapter", () => {
  const pipeline = { baseUrl: "http://evidence-pipeline:8080/", token: "evidence-demo-token-local-only" };

  it("prepares exactly one selected version and normalizes full pages without facts", async () => {
    const version = "a".repeat(64), documentId = `doc_${version.slice(0,24)}`;
    const { fetch, calls } = scripted([json({ case_id: "case-1", documents: [{ document_id: documentId, sha256: version, filename: "selected.txt", format: "txt", page_count: 1 }], pages: [{ document_id: documentId, page: 1, text: "Full selected source", segments: [] }], evidence: [] })]);
    const result = await invokeEvidencePipeline({ ...pipeline, operation: "prepare", input: { caseId: "case-1", documentId, documentVersion: version, evidenceId: "ev_original", filename: "selected.txt", contentBase64: "c291cmNl" }, fetch });
    expect(calls[0]!.url).toBe("http://evidence-pipeline:8080/v1/cases/case-1/documents/prepare");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({ document_id: documentId, document_version: version });
    const output = result.output as { records: Array<{ object_type: string; data: Record<string, unknown> }>; bankDecision: string };
    expect(output.records.map(record => record.object_type)).toEqual(["DocumentVersion", "DocumentPage"]);
    expect(output.records[0]!.data.artifact_ref).toBe("ehf:case-evidence:ev_original");
    expect(output.records[1]!.data).toMatchObject({ text: "Full selected source", document_version: version });
    expect(output.bankDecision).toBe("not_evaluated");
  });

  it("ingests a document and reports a paused review without deciding anything", async () => {
    const { fetch, calls } = scripted([json({ status: "PAUSED_FOR_REVIEW", run_id: `run_${"a".repeat(32)}`, case_id: "case-1", review_request: { issues: [] } })]);
    const result = await invokeEvidencePipeline({ ...pipeline, operation: "ingest", input: { caseId: "case-1", filename: "annual.txt", contentBase64: "aGVsbG8=", profile: "financial_annual_report" }, fetch });
    expect(calls[0]!.url).toBe("http://evidence-pipeline:8080/v1/cases/case-1/documents");
    expect(calls[0]!.init).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ filename: "annual.txt", content_base64: "aGVsbG8=", profile: "financial_annual_report" });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer evidence-demo-token-local-only");
    expect(result).toMatchObject({ provider: "kyc-evidence-pipeline", model: "ingest", providerRequestId: `run_${"a".repeat(32)}` });
    expect(result.output).toMatchObject({ operation: "ingest", caseId: "case-1", status: "PAUSED_FOR_REVIEW", reviewRequired: true, bankDecision: "not_evaluated" });
  });

  it("reads packages and ownership and resumes runs", async () => {
    const { fetch, calls } = scripted([
      json({ case_id: "case-1", status: "REVIEW_REQUIRED", facts: [] }),
      json({ case_id: "case-1", status: "REVIEW_REQUIRED", ownership_graph: {} }),
      json({ status: "PERSISTED", run_id: `run_${"b".repeat(32)}`, case_id: "case-1" }),
    ]);
    const report = await invokeEvidencePipeline({ ...pipeline, operation: "package", input: { input: { caseId: "case-1" } }, fetch });
    expect(report.output).toMatchObject({ operation: "package", caseId: "case-1", reviewRequired: false, data: { facts: [] } });
    await invokeEvidencePipeline({ ...pipeline, operation: "ownership", input: { caseId: "case-1" }, fetch });
    const decision = { reviewer_id: "analyst-1", decisions: [{ issue_id: "i1", action: "defer", reason: "needs evidence" }] };
    const resumed = await invokeEvidencePipeline({ ...pipeline, operation: "resume", input: { runId: `run_${"b".repeat(32)}`, decision }, fetch });
    expect(calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      "GET http://evidence-pipeline:8080/v1/cases/case-1/package",
      "GET http://evidence-pipeline:8080/v1/cases/case-1/ownership",
      `POST http://evidence-pipeline:8080/v1/runs/run_${"b".repeat(32)}/resume`,
    ]);
    expect(JSON.parse(String(calls[2]!.init.body))).toEqual(decision);
    expect(resumed.output).toMatchObject({ status: "PERSISTED", runId: `run_${"b".repeat(32)}` });
  });

  it.each([
    ["erase", { caseId: "case-1" }, "adapter.evidence_pipeline_operation_unsupported"],
    ["package", { caseId: "../etc" }, "adapter.evidence_pipeline_case_id_invalid"],
    ["package", { caseId: "a/b" }, "adapter.evidence_pipeline_case_id_invalid"],
    ["ingest", { caseId: "c", filename: "x.txt", contentBase64: "not base64!" }, "adapter.evidence_pipeline_content_invalid"],
    ["ingest", { caseId: "c", filename: "x.txt", contentBase64: "aGk=", profile: "../x" }, "adapter.evidence_pipeline_profile_invalid"],
    ["resume", { runId: "run_x", decision: {} }, "adapter.evidence_pipeline_run_id_invalid"],
    ["resume", { runId: `run_${"c".repeat(32)}`, decision: { decisions: [] } }, "adapter.evidence_pipeline_decision_invalid"],
  ])("rejects %s with invalid input before any request", async (operation, input, error) => {
    const { fetch, calls } = scripted([]);
    await expect(invokeEvidencePipeline({ ...pipeline, operation, input, fetch })).rejects.toThrow(error);
    expect(calls).toHaveLength(0);
  });

  it("maps pipeline errors to adapter errors", async () => {
    const { fetch } = scripted([json({ status: "ERROR", code: "NOT_FOUND", message: "Case not found" }, 404)]);
    await expect(invokeEvidencePipeline({ ...pipeline, operation: "package", input: { caseId: "missing" }, fetch }))
      .rejects.toThrow("adapter.evidence_pipeline_http_404:NOT_FOUND");
    await expect(invokeEvidencePipeline({ ...pipeline, token: "", operation: "package", input: { caseId: "c" }, fetch }))
      .rejects.toThrow("adapter.evidence_pipeline_credential_missing");
    await expect(invokeEvidencePipeline({ ...pipeline, requireHttps: true, operation: "package", input: { caseId: "c" }, fetch }))
      .rejects.toThrow("adapter.evidence_pipeline_url_insecure");
  });
});
