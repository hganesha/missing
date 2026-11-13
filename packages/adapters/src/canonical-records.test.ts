import { describe, expect, it } from "vitest";
import { canonicalRecordInputSchema, recordCanonicalRecordsPayloadSchema, type CanonicalRecordInput } from "@ehf/contracts";
import { LIBRARY_CONTEXT_TYPES, validateRecordData } from "@ehf/library-contracts";
import { normalizeEvidencePackage, normalizeOpenSanctionsResult, normalizeWiringResult, type WiringResultInput } from "./canonical-records.js";
import { mapKycWiringResult } from "./kyc-wiring.js";

/** Source fields kept beside the canonical ones (`data.extensions["ehf.connector"].value`). */
const ext = (record: CanonicalRecordInput) => ((record.data.extensions as Record<string, { value: Record<string, unknown> }> | undefined)?.["ehf.connector"]?.value ?? {});

const context = { tenantId: "tenant-1", invocationId: "RUN-1:company-lookup:1", connectorId: "wiring:companies-house:business.registry.lookup" };

function host(kind: string, overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1.0.0", result_id: "res-1", request_id: "req-1", tenant_id: "demo", subject_entity_id: "subject",
    execution: { status: "completed", received_at: "2026-11-07T10:00:00Z", provider_observed_at: "2026-11-07T09:59:00Z" },
    assessment: { outcome: "passed", reason_codes: [], bank_decision: "not_evaluated" },
    coverage: { status: "complete_for_requested_scope", requested_scope: ["GB"], checked_scope: ["GB"], not_checked_scope: [] },
    entities: [
      { entity_id: "subject", entity_type: "organization", names: [{ full: "Meridian Trade Holdings Ltd", kind: "legal" }, { full: "Meridian", kind: "trading" }],
        identifiers: [{ scheme: "company_registration_number", value: "01234567", jurisdiction: "GB" }], jurisdiction: "GB", legal_form: "ltd",
        status: "active", status_original: "Active", incorporation_date: { value: "2010-04-01", precision: "day" }, source_record_ids: ["01234567"] },
      { entity_id: "p1", entity_type: "person", names: [{ full: "Alice Example", kind: "legal" }], identifiers: [], source_record_ids: ["officer-abc"] },
    ],
    relationships: [],
    evidence: [{ evidence_id: "ev-1", provider_id: "companies-house", retrieved_at: "2026-11-07T09:59:00Z", authority: "official", access_classification: "public", source_title: "Register entry" }],
    result: { kind },
    warnings: [],
    ...overrides,
  };
}

function wiring(operationId: string, hostResult: unknown, overrides: Partial<WiringResultInput> = {}): WiringResultInput {
  return { operationId, outcome: "passed", error: null, providerCheckId: "check-1", executionMode: "live", warnings: [], host: hostResult, ...overrides };
}

function byType(records: Array<{ object_type: string }>) {
  return records.reduce<Record<string, number>>((counts, item) => ({ ...counts, [item.object_type]: (counts[item.object_type] ?? 0) + 1 }), {});
}

describe("wiring business results", () => {
  it("become RegistryRecord, Entity, Party and OfficerRole records citing the gateway invocation and provider ids", () => {
    const result = normalizeWiringResult(wiring("companies-house:business.registry.lookup", host("business", {
      result: { kind: "business", organization_entity_id: "subject", checks: [{ check_id: "c1", name: "status", outcome: "passed", evidence_ids: [] }], assertion_ids: [] },
      relationships: [{ relationship_id: "r1", from_entity_id: "p1", to_entity_id: "subject", type: "director_of", direction: "directed", assertion_status: "asserted", valid_from: { value: "2015-01-01", precision: "day" } }],
    })), context);
    expect(result.recordGap).toBeNull();
    expect(byType(result.records)).toEqual({ Entity: 2, RegistryRecord: 1, Party: 1, OfficerRole: 1 });
    const registry = result.records.find((item) => item.object_type === "RegistryRecord")!;
    expect(registry).toMatchObject({
      object_id: "registry:companies-house:01234567",
      schema_version: "2.0.0",
      data: { registration_id: "01234567", status: "ACTIVE", name: "Meridian Trade Holdings Ltd", coverage: { complete: true, jurisdictions: ["GB"], provider: "companies-house" } },
      observed_at: "2026-11-07T09:59:00.000Z", valid_from: "2010-04-01T00:00:00.000Z", synthetic: false,
      provenance: { method: "connector_normalizer", normalizer: "wiring.business@3", connector_id: context.connectorId, invocation_id: context.invocationId, provider_check_id: "check-1" },
    });
    expect(registry.source_refs).toEqual([
      { tenant_id: "tenant-1", object_type: "GatewayInvocation", object_id: context.invocationId, version_id: "check-1" },
      { tenant_id: "tenant-1", object_type: "ProviderRecord", object_id: "companies-house:01234567", version_id: "res-1" },
    ]);
    const entity = result.records.find((item) => item.object_type === "Entity" && item.data.name === "Meridian Trade Holdings Ltd")!;
    expect(entity.data).toMatchObject({ identifiers: ["01234567"], entity_type: "company" });
    expect(ext(entity)).toMatchObject({ aliases: ["Meridian"] });
    expect(result.records.find((item) => item.object_type === "Party")!.data).toMatchObject({ role: "customer", customer_type: "corporate", profile: { legal_name: "Meridian Trade Holdings Ltd" } });
    expect(result.records.find((item) => item.object_type === "OfficerRole")!.data).toMatchObject({ role: "director", organization_id: entity.object_id });
    // Every record is a valid command payload.
    expect(recordCanonicalRecordsPayloadSchema.parse({ records: result.records }).records).toHaveLength(5);
  });

  it("produce the same versions for a replayed result and new versions for a new observation", () => {
    const first = normalizeWiringResult(wiring("companies-house:business.registry.lookup", host("business", { result: { kind: "business", organization_entity_id: "subject", checks: [], assertion_ids: [] } })), context);
    const replay = normalizeWiringResult(wiring("companies-house:business.registry.lookup", host("business", { result: { kind: "business", organization_entity_id: "subject", checks: [], assertion_ids: [] } })), context);
    const later = normalizeWiringResult(wiring("companies-house:business.registry.lookup", host("business", {
      result: { kind: "business", organization_entity_id: "subject", checks: [], assertion_ids: [] },
      execution: { status: "completed", received_at: "2026-12-01T00:00:00Z" },
    })), context);
    expect(replay.records.map((item) => item.version_id)).toEqual(first.records.map((item) => item.version_id));
    expect(later.records.map((item) => item.object_id)).toEqual(first.records.map((item) => item.object_id));
    expect(later.records[0]!.version_id).not.toBe(first.records[0]!.version_id);
  });

  it("mark simulated or DEMO_ONLY results synthetic", () => {
    const demo = normalizeWiringResult(wiring("companies-house:business.registry.lookup", host("business", { result: { kind: "business", organization_entity_id: "subject", checks: [], assertion_ids: [] } }),
      { executionMode: "simulation", warnings: ["DEMO_ONLY_NO_VENDOR_CALL"] }), context);
    expect(demo.records.every((item) => item.synthetic)).toBe(true);
  });
});

describe("outcomes that established nothing", () => {
  it.each(["unknown", "not_checked", "inconclusive", "resubmit", "not_applicable"])("yield no records and an evidence gap for %s", (outcome) => {
    const result = normalizeWiringResult(wiring("opensanctions:screening.sanctions", host("screening", { result: { kind: "screening", matches: [], dataset_versions: ["2026-11"], scope: ["sanctions"], truncated: false, total_candidates: 0 } }), { outcome }), context);
    expect(result.records).toEqual([]);
    expect(result.recordGap).toMatchObject({ code: "EVIDENCE_GAP", outcome });
  });

  it("yield a gap for a failed check, an unknown family and a missing organization", () => {
    expect(normalizeWiringResult(wiring("companies-house:business.registry.lookup", null, { outcome: "unknown", error: { code: "wiring.check_failed" } }), context).recordGap?.reason).toContain("wiring.check_failed");
    expect(normalizeWiringResult(wiring("x:risk.device", host("risk")), context).recordGap?.reason).toContain("risk");
    expect(normalizeWiringResult(wiring("companies-house:business.registry.lookup", host("business", { entities: [], result: { kind: "business", organization_entity_id: "subject", checks: [], assertion_ids: [] } })), context).records).toEqual([]);
  });

  it("are carried on the gateway output: records for a completed check, none for an incomplete one", () => {
    const completed = mapKycWiringResult({ operationId: "companies-house:business.registry.lookup", checkId: "check-1", checkStatus: "completed",
      result: host("business", { result: { kind: "business", organization_entity_id: "subject", checks: [], assertion_ids: [] } }), recordSource: { tenantId: "tenant-1", invocationId: "inv-1" } });
    expect(completed.records.length).toBeGreaterThan(0);
    expect(completed.recordGap).toBeNull();
    const failed = mapKycWiringResult({ operationId: "companies-house:business.registry.lookup", checkId: "check-2", checkStatus: "dead_letter", result: null });
    expect(failed).toMatchObject({ outcome: "unknown", records: [], recordGap: { code: "EVIDENCE_GAP" } });
    expect(failed.canonical).toBeNull();
  });

  it("carry the v2 canonical provenance the wiring service echoes, and drop a malformed one", () => {
    const canonical = {
      model_version: "2.0.0", binding_id: "binding:companies-house:business.registry.intelligence.gb:v1", capability_id: "business.registry.intelligence.gb",
      capability_definition_ref: "business.registry@1.0.0", jurisdiction: { code: "gb", basis: "registry_authority", resolution_status: "proposed", approval_ref: null, source: "registry" },
    };
    const result = (extensions: Record<string, unknown>) => mapKycWiringResult({ operationId: "companies-house:business.registry.lookup", checkId: "check-1", checkStatus: "completed",
      result: host("business", { result: { kind: "business", organization_entity_id: "subject", checks: [], assertion_ids: [] }, extensions }) });
    expect(result({ canonical }).canonical).toEqual({
      bindingId: canonical.binding_id, capabilityId: "business.registry.intelligence.gb", capabilityDefinitionRef: "business.registry@1.0.0", modelVersion: "2.0.0",
      jurisdiction: { code: "gb", basis: "registry_authority", resolutionStatus: "proposed", approvalRef: null },
    });
    expect(result({ canonical: { ...canonical, capability_id: "business.registry.lookup" } }).canonical).toBeNull();
    expect(result({ canonical: { ...canonical, jurisdiction: { ...canonical.jurisdiction, code: "us" } } }).canonical).toBeNull();
    expect(result({}).canonical).toBeNull();
  });
});

describe("wiring ownership results", () => {
  it("become OwnershipInterest (fractional decimal) and ControlRight records between entity records", () => {
    const result = normalizeWiringResult(wiring("opencorporates:business.ownership.discover", host("ownership", {
      result: { kind: "ownership", root_entity_id: "subject", relationship_ids: ["o1", "o2"], completeness: "partial", legal_test_policy_ref: "x", unresolved_reasons: [] },
      relationships: [
        { relationship_id: "o1", from_entity_id: "p1", to_entity_id: "subject", type: "owns", direction: "directed", assertion_status: "asserted", ownership: { kind: "equity", exact_percent: 62.5, directness: "direct" } },
        { relationship_id: "o2", from_entity_id: "p1", to_entity_id: "subject", type: "controls", direction: "directed", assertion_status: "confirmed", ownership: { kind: "control", directness: "direct" } },
      ],
    })), { ...context, connectorId: "wiring:opencorporates:business.ownership.discover" });
    expect(byType(result.records)).toEqual({ Entity: 2, OwnershipInterest: 1, ControlRight: 1 });
    const interest = result.records.find((item) => item.object_type === "OwnershipInterest")!;
    expect(interest.data).toMatchObject({ owner: "entity:opencorporates:officer-abc", owned: "entity:opencorporates:01234567", interest: "0.625" });
    expect(ext(interest)).toMatchObject({ interest_basis: "exact", completeness: "partial" });
    expect(result.records.find((item) => item.object_type === "ControlRight")!.data).toMatchObject({ basis: "control", verified: true });
  });

  it("is a gap when no ownership edge was established", () => {
    const result = normalizeWiringResult(wiring("opencorporates:business.ownership.discover", host("ownership", {
      result: { kind: "ownership", root_entity_id: "subject", relationship_ids: [], completeness: "unknown", legal_test_policy_ref: "x", unresolved_reasons: ["opaque"] },
    })), context);
    expect(result).toMatchObject({ records: [], recordGap: { code: "EVIDENCE_GAP" } });
  });
});

describe("wiring screening results", () => {
  const screening = (matches: unknown[], entities: unknown[] = []) => host("screening", {
    entities: [host("x").entities[0], ...entities],
    result: { kind: "screening", matches, dataset_versions: ["opensanctions-2026-11-07"], scope: ["sanctions"], truncated: false, total_candidates: matches.length },
  });

  it("become WatchlistEntry and ScreeningHit records for each attributable candidate", () => {
    const result = normalizeWiringResult(wiring("opensanctions:screening.sanctions", screening(
      [{ match_id: "m1", subject_entity_id: "subject", candidate_entity_id: "c1", categories: ["sanction"], list_ids: ["us_ofac_sdn"], programs: ["SDGT"], disposition: "unresolved", evidence_ids: [] }],
      [{ entity_id: "c1", entity_type: "organization", names: [{ full: "Meridian Trading LLC", kind: "legal" }], identifiers: [{ scheme: "ofac", value: "OFAC-1" }], source_record_ids: ["NK-123"] }],
    )), context);
    expect(byType(result.records)).toEqual({ Entity: 1, WatchlistEntry: 1, ScreeningHit: 1, ScreeningExecution: 1 });
    expect(result.records.find((item) => item.object_type === "WatchlistEntry")!.data).toMatchObject({
      name: "Meridian Trading LLC", identifiers: ["OFAC-1"], list_type: "sanctions", list_version: "opensanctions-2026-11-07", coverage: { complete: true },
    });
    // No identifier comparison was reported: no conflict established, so the library recommends REVIEW.
    expect(result.records.find((item) => item.object_type === "ScreeningHit")!.data).toMatchObject({ entry_id: "watchlist:opensanctions:NK-123", features: { identifier_conflict: false } });
  });

  it("mark a hit as an identifier conflict only on a like-for-like contradiction", () => {
    const person = (id: string, identifiers: unknown[], birth?: unknown) => ({ entity_id: id, entity_type: "person", names: [{ full: `Person ${id}`, kind: "legal" }], identifiers, source_record_ids: [`src-${id}`], ...(birth ? { birth_date: birth } : {}) });
    const hit = (subject: unknown, candidate: unknown) => {
      const payload = host("screening", {
        entities: [subject, candidate],
        result: { kind: "screening", matches: [{ match_id: "m1", subject_entity_id: "subject", candidate_entity_id: "c1", categories: [], disposition: "unresolved", evidence_ids: [] }], dataset_versions: ["v1"], scope: ["sanctions"], truncated: false, total_candidates: 1 },
      });
      const record = normalizeWiringResult(wiring("opensanctions:screening.sanctions", payload), context).records.find((r) => r.object_type === "ScreeningHit")!;
      return { conflict: (record.data.features as { identifier_conflict: boolean }).identifier_conflict, basis: ext(record).identifier_conflict_basis };
    };
    const subject = (identifiers: unknown[], birth?: unknown) => person("subject", identifiers, birth);
    const candidate = (identifiers: unknown[], birth?: unknown) => person("c1", identifiers, birth);
    // Same scheme, different value: a contradiction.
    expect(hit(subject([{ scheme: "passport", value: "P-1", jurisdiction: "ES" }]), candidate([{ scheme: "passport", value: "P 9", jurisdiction: "ES" }])))
      .toEqual({ conflict: true, basis: ["scheme:passport:ES"] });
    // Same scheme, one shared value (formatting ignored): no contradiction.
    expect(hit(subject([{ scheme: "passport", value: "P-1" }, { scheme: "passport", value: "P-2" }]), candidate([{ scheme: "passport", value: "p 2" }])).conflict).toBe(false);
    // Different schemes, or a generic list number, prove nothing.
    expect(hit(subject([{ scheme: "national_id", value: "N-1" }]), candidate([{ scheme: "list_document", value: "N-2" }])).conflict).toBe(false);
    // Day-precision birth dates that differ contradict; a year-only date is not compared.
    expect(hit(subject([], { value: "1983-06-21", precision: "day" }), candidate([], { value: "1969-12-04", precision: "day" })))
      .toEqual({ conflict: true, basis: ["birth_date"] });
    expect(hit(subject([], { value: "1983-06-21", precision: "day" }), candidate([], { value: "1969", precision: "year" })).conflict).toBe(false);
    expect(hit(subject([], { value: "1969-12-04", precision: "day" }), candidate([], { value: "1969-12-04", precision: "day" })).conflict).toBe(false);
  });

  it("honour a provider-reported identifier or birth-date conflict, and ignore other conflicting fields", () => {
    const run = (conflicting: string[]) => {
      const payload = host("screening", {
        entities: [host("x").entities[0], { entity_id: "c1", entity_type: "organization", names: [{ full: "Meridian Trading LLC", kind: "legal" }], identifiers: [], source_record_ids: ["NK-1"] }],
        result: { kind: "screening", matches: [{ match_id: "m1", subject_entity_id: "subject", candidate_entity_id: "c1", categories: [], conflicting_fields: conflicting, disposition: "unresolved", evidence_ids: [] }], dataset_versions: ["v1"], scope: ["sanctions"], truncated: false, total_candidates: 1 },
      });
      const record = normalizeWiringResult(wiring("opensanctions:screening.sanctions", payload), context).records.find((r) => r.object_type === "ScreeningHit")!;
      return [(record.data.features as { identifier_conflict: boolean }).identifier_conflict, ext(record).identifier_conflict_basis];
    };
    expect(run(["registration_number"])).toEqual([true, ["provider:registration_number"]]);
    expect(run(["birth_date"])).toEqual([true, ["provider:birth_date"]]);
    expect(run(["address"])).toEqual([false, undefined]);
  });

  it("record a completed screen without candidates as NegativeSearchEvidence, never as a clear WatchlistEntry", () => {
    const result = normalizeWiringResult(wiring("opensanctions:screening.pep", screening([])), context);
    expect(result.records.map((item) => item.object_type)).toEqual(["ScreeningExecution", "Entity", "NegativeSearchEvidence"]);
    expect(result.records.find((r) => r.object_type === "NegativeSearchEvidence")!.data).toMatchObject({ capability: "screening.pep", total_candidates: 0, limitations: [expect.stringContaining("not universal clearance")] });
  });

  it("become AdverseMediaEvent records for adverse media matches", () => {
    const result = normalizeWiringResult(wiring("complyadvantage:screening.adverse_media", host("screening", {
      evidence: [{ evidence_id: "ev-9", provider_id: "complyadvantage", retrieved_at: "2026-11-07T09:00:00Z", authority: "commercial", access_classification: "internal",
        source_title: "Meridian director charged", source_url: "https://news.example/meridian", published_at: "2026-10-01T00:00:00Z" }],
      result: { kind: "screening", matches: [{ match_id: "am1", subject_entity_id: "subject", candidate_entity_id: "subject", categories: ["financial_crime"], disposition: "unresolved", evidence_ids: ["ev-9"] }],
        dataset_versions: [], scope: ["adverse_media"], truncated: false, total_candidates: 1 },
    })), { ...context, connectorId: "wiring:complyadvantage:screening.adverse_media" });
    expect(result.records).toHaveLength(2);
    expect(result.records.find((r) => r.object_type === "AdverseMediaEvent")).toMatchObject({ object_type: "AdverseMediaEvent", data: {
      subjects: ["Meridian Trade Holdings Ltd"], title: "Meridian director charged", source: "https://news.example/meridian", status: "ALLEGATION", coverage: { complete: true },
    } });
  });
});

describe("wiring verification and reference results", () => {
  it("become a VerificationRecord and identifier Entity records", () => {
    const verification = normalizeWiringResult(wiring("persona:identity.document.verify", host("verification", {
      result: { kind: "verification", checks: [{ check_id: "doc", name: "document", outcome: "passed", evidence_ids: ["ev-1"] }], assertion_ids: [] },
    })), context);
    expect(verification.records.map((item) => [item.object_type, item.data.status, item.data.method])).toEqual([["VerificationRecord", "VERIFIED", "persona:identity.document.verify"]]);
    expect(verification.records[0]!.data.evidence_ids).toEqual(["ev-1"]);
    const reference = normalizeWiringResult(wiring("gleif:reference.identifier.lookup", host("reference", { result: { kind: "reference", record_entity_ids: ["subject"] } })), context);
    expect(reference.records.every((item) => item.object_type === "Entity")).toBe(true);
  });
});

describe("OpenSanctions direct results", () => {
  const output = (alerts: unknown[]) => ({
    status: "OK", provider: "OPENSANCTIONS", screeningType: "SANCTIONS", dataset: "default", screenedAt: "2026-11-07T10:00:00.000Z", threshold: 0.7,
    query: { schema: "Company", properties: { name: ["Meridian Trade Holdings Ltd"] } }, alerts, topics: ["sanction"],
  });

  it("become incomplete-coverage WatchlistEntry and ScreeningHit records per candidate", () => {
    const result = normalizeOpenSanctionsResult(output([{ alertId: "opensanctions:NK-1", listRecordId: "NK-1", matchedName: "Meridian Trading", entitySchema: "Company", score: 0.82,
      scoreMeaning: "IDENTITY_MATCH_CONFIDENCE", acceptedByMatcher: true, matchedFields: ["name"], conflictingFields: [], programs: [], topics: ["sanction"], datasets: ["us_ofac_sdn"], lastSeen: "2026-11-06" }]),
    { tenantId: "tenant-1", invocationId: "inv-2", connectorId: "opensanctions:sanctions" });
    expect(byType(result.records)).toEqual({ Entity: 1, ScreeningExecution: 1, WatchlistEntry: 1, ScreeningHit: 1 });
    expect(result.records.find((r) => r.object_type === "WatchlistEntry")!.data).toMatchObject({ name: "Meridian Trading", list_type: "sanctions", coverage: { complete: false }, list_version: "opensanctions:default@2026-11-06" });
    expect(result.records.find((r) => r.object_type === "WatchlistEntry")!.source_refs.map((ref) => ref.object_type)).toEqual(["GatewayInvocation", "ProviderRecord"]);
    expect(result.records.find((r) => r.object_type === "ScreeningHit")!.data).toMatchObject({ features: { score: 0.82, identifier_conflict: false } });
    expect(ext(result.records.find((r) => r.object_type === "ScreeningHit")!)).toMatchObject({ accepted_by_matcher: true });
  });

  it("record no candidates as NegativeSearchEvidence and a provider error as a gap", () => {
    expect(normalizeOpenSanctionsResult(output([]), { connectorId: "opensanctions:sanctions" }).records.map((item) => item.object_type)).toEqual(["Entity", "ScreeningExecution", "NegativeSearchEvidence"]);
    expect(normalizeOpenSanctionsResult({ status: "ERROR" }, { connectorId: "opensanctions:sanctions" })).toMatchObject({ records: [], recordGap: { code: "EVIDENCE_GAP" } });
  });
});

describe("evidence pipeline packages", () => {
  it("become a DocumentVersion and Evidence records per span, never pages stitched from quotes", () => {
    const result = normalizeEvidencePackage({ operation: "package", data: {
      disclaimer: "Synthetic evaluation package; not for production decisions.",
      documents: [{ document_id: "doc-1", sha256: "a".repeat(64), family: "incorporation" }],
      runs: [{ finished_at: "2026-11-07T08:00:00Z" }],
      evidence: [
        { evidence_id: "e1", document_id: "doc-1", document_sha256: "a".repeat(64), page: 1, quote: "Name: Meridian Trade Holdings Ltd", section_path: ["Certificate"] },
        { evidence_id: "e2", document_id: "doc-1", document_sha256: "a".repeat(64), page: 1, quote: "Registration: 01234567", section_path: ["Certificate"] },
      ],
    } }, { connectorId: "evidence:package" });
    // Without the server's full page text there is no DocumentPage: quotes are not a page.
    expect(byType(result.records)).toEqual({ DocumentVersion: 1, Evidence: 2 });
    const version = result.records.find((item) => item.object_type === "DocumentVersion")!;
    expect(version.data).toMatchObject({ document_id: "doc-1", artifact_hash: "a".repeat(64), media_type: "application/octet-stream", page_count: 1 });
    expect(ext(version)).toMatchObject({ document_family: "incorporation", page_count_basis: "cited_pages_lower_bound" });
    const evidence = result.records.find((item) => item.object_type === "Evidence")!;
    expect(evidence.source_refs.at(-1)).toMatchObject({ object_type: "DocumentVersion", object_id: "doc-1", version_id: version.version_id });
    // Cited quotes satisfy no requirement and are not independently verified.
    expect(evidence.data).toMatchObject({ requirement_ids: [], verified: false, content_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(evidence.synthetic).toBe(true);
    expect(result.records.every((item) => canonicalRecordInputSchema.safeParse(item).success)).toBe(true);
  });

  it("carry the full page text when the package has it, with evidence spans mapped onto the page", () => {
    const page = "# Certificate\n\nName: Meridian Trade Holdings Ltd\nRegistration: 01234567";
    const result = normalizeEvidencePackage({ operation: "package", data: {
      documents: [{ document_id: "doc-1", sha256: "b".repeat(64), format: "txt", filename: "cert.txt", page_count: null }],
      evidence: [{ evidence_id: "e1", document_id: "doc-1", document_sha256: "b".repeat(64), page: null, segment_id: "s2", start: 34, end: 56, quote: "Registration: 01234567" }],
      pages: [{ document_id: "doc-1", page: 1, text: page, text_sha256: "c".repeat(64), segments: [{ segment_id: "s1", start: 0, end: 13 }, { segment_id: "s2", start: 15, end: page.length }] }],
    } }, { connectorId: "evidence:package" });
    expect(byType(result.records)).toEqual({ DocumentVersion: 1, Evidence: 1, DocumentPage: 1 });
    const version = result.records.find((item) => item.object_type === "DocumentVersion")!;
    expect(version.data).toMatchObject({ media_type: "text/plain", page_count: 1 });
    expect(ext(version)).toMatchObject({ page_count_basis: "decoded_pages", filename: "cert.txt" });
    const documentPage = result.records.find((item) => item.object_type === "DocumentPage")!;
    expect(documentPage.data).toMatchObject({ text: page, page: 1, document_version: "b".repeat(64) });
    expect(ext(documentPage)).toMatchObject({ text_basis: "full_text", offset_basis: "unicode_code_points", evidence_ids: ["e1"] });
    const span = ext(result.records.find((item) => item.object_type === "Evidence")!) as { page_start: number; page_end: number };
    expect(page.slice(span.page_start, span.page_end)).toBe("Registration: 01234567");
    for (const item of result.records) expect(validateRecordData(item.object_type, item.data).errors).toEqual([]);
  });

  it("is a gap without cited spans", () => {
    expect(normalizeEvidencePackage({ operation: "package", data: { evidence: [] } }, { connectorId: "evidence:package" }).recordGap).not.toBeNull();
    expect(normalizeEvidencePackage({ operation: "ingest", data: {} }, { connectorId: "evidence:ingest" }).recordGap).not.toBeNull();
  });
});

describe("library context contract (financial-crime-skills context 2.0.0)", () => {
  const screeningHost = (matches: unknown[], entities: unknown[] = [], scope = "sanctions") => host("screening", {
    entities: [host("x").entities[0], ...entities],
    result: { kind: "screening", matches, dataset_versions: ["2026-11"], scope: [scope], truncated: false, total_candidates: matches.length },
  });
  const candidate = { entity_id: "c1", entity_type: "vessel", names: [{ full: "Meridian Trading LLC", kind: "legal" }], identifiers: [{ scheme: "ofac", value: "OFAC-1" }], source_record_ids: ["NK-123"] };

  function everyFamily() {
    return [
      normalizeWiringResult(wiring("companies-house:business.registry.lookup", host("business", {
        result: { kind: "business", organization_entity_id: "subject", checks: [{ check_id: "c1", name: "status", outcome: "passed" }], assertion_ids: [] },
        relationships: [{ relationship_id: "r1", from_entity_id: "p1", to_entity_id: "subject", type: "officer_of", assertion_status: "asserted" }],
      })), context),
      normalizeWiringResult(wiring("opencorporates:business.ownership.discover", host("ownership", {
        result: { kind: "ownership", root_entity_id: "subject", completeness: "complete" },
        relationships: [
          { relationship_id: "o1", from_entity_id: "p1", to_entity_id: "subject", type: "owns", assertion_status: "confirmed", ownership: { kind: "equity", lower_percent: 25, upper_percent: 50 } },
          { relationship_id: "o2", from_entity_id: "p1", to_entity_id: "subject", type: "owns", ownership: { kind: "equity", exact_percent: 140 } },
          { relationship_id: "o3", from_entity_id: "p1", to_entity_id: "subject", type: "controls", ownership: { kind: "voting", exact_percent: 30 } },
          { relationship_id: "o4", from_entity_id: "p1", to_entity_id: "subject", type: "owns", ownership: { kind: "equity", exact_percent: 30 } },
        ],
      })), context),
      normalizeWiringResult(wiring("refinitiv:screening.enforcement", screeningHost([{ match_id: "m1", candidate_entity_id: "c1", categories: ["enforcement"], scores: [{ name: "name", value: 0.9 }] }], [candidate], "enforcement")), context),
      normalizeWiringResult(wiring("opensanctions:screening.pep", screeningHost([], [], "pep")), context),
      normalizeWiringResult(wiring("complyadvantage:screening.adverse_media", host("screening", {
        evidence: [{ evidence_id: "ev-9", provider_id: "complyadvantage", source_title: "Meridian director charged", published_at: "not a date" }],
        result: { kind: "screening", matches: [{ match_id: "am1", candidate_entity_id: "subject", categories: ["financial_crime"], evidence_ids: ["ev-9"] }], dataset_versions: [], scope: ["adverse_media"], truncated: false, total_candidates: 1 },
      })), context),
      normalizeWiringResult(wiring("persona:identity.document.verify", host("verification", { result: { kind: "verification", checks: [] } }), { outcome: "review" }), context),
      normalizeWiringResult(wiring("gleif:reference.identifier.lookup", host("reference", { entities: [host("x").entities[0], candidate], result: { kind: "reference" } })), context),
      normalizeOpenSanctionsResult({ status: "OK", screeningType: "SANCTIONS", dataset: "default", screenedAt: "2026-11-07T10:00:00Z", query: { properties: { name: ["Meridian"] } },
        alerts: [{ listRecordId: "NK-2", matchedName: "Meridian Trading", score: 0.71, conflictingFields: ["registrationNumber"], matchedFields: ["name"] }] }, { connectorId: "opensanctions:sanctions" }),
      normalizeOpenSanctionsResult({ status: "OK", screeningType: "PEP", dataset: "peps", screenedAt: "2026-11-07T10:00:00Z", query: { properties: { name: ["Meridian"] } }, alerts: [] }, { connectorId: "opensanctions:pep" }),
      normalizeEvidencePackage({ operation: "package", data: { documents: [{ document_id: "doc-1", sha256: "a".repeat(64) }], evidence: [
        { evidence_id: "e1", document_id: "doc-1", page: 2, quote: "Registration: 01234567", locator: "page:2/line:4" },
        { evidence_id: "e0", document_id: "doc-1", page: 0, quote: "unpaged" },
      ], pages: [{ document_id: "doc-1", page: 2, text: "Registration: 01234567", segments: [] }] } }, { connectorId: "evidence:package" }),
    ].flatMap((result) => result.records);
  }

  it("every record a normalizer emits validates against the vendored closed schema of its type", () => {
    const records = everyFamily();
    expect(new Set(records.map((item) => item.object_type))).toEqual(new Set([
      "Entity", "RegistryRecord", "Party", "OfficerRole", "OwnershipInterest", "OwnershipRange", "ScreeningExecution", "ControlRight", "WatchlistEntry", "ScreeningHit",
      "AdverseMediaEvent", "VerificationRecord", "DocumentPage", "DocumentVersion", "Evidence", "NegativeSearchEvidence",
    ]));
    for (const item of records) {
      const result = validateRecordData(item.object_type, item.data);
      expect({ type: item.object_type, errors: result.errors }).toEqual({ type: item.object_type, errors: [] });
      expect(result.contract).toBe(item.object_type === "NegativeSearchEvidence" ? "platform" : "library");
      expect(item.schema_version).toBe("2.0.0");
      expect(LIBRARY_CONTEXT_TYPES.includes(item.object_type)).toBe(item.object_type !== "NegativeSearchEvidence");
    }
  });

  it("maps source values onto the library vocabulary without overstating them", () => {
    const records = everyFamily();
    const one = (type: string, where: (item: CanonicalRecordInput) => boolean = () => true) => records.find((item) => item.object_type === type && where(item))!;
    // An unknown provider entity type is `unknown`, the original kept as an extension.
    const vessel = one("Entity", (item) => item.data.name === "Meridian Trading LLC");
    expect(vessel.data.entity_type).toBe("unknown");
    expect(ext(vessel)).toMatchObject({ entity_type: "vessel" });
    // Other lists are `watchlist`; a review outcome is UNVERIFIED; media is an allegation.
    expect(one("WatchlistEntry", (item) => ext(item).screening_capability === "screening.enforcement").data.list_type).toBe("watchlist");
    expect(one("VerificationRecord").data.status).toBe("UNVERIFIED");
    expect(one("AdverseMediaEvent").data.status).toBe("ALLEGATION");
    // A conflicting identifier field makes an OpenSanctions hit a false-match candidate.
    expect(one("ScreeningHit", (item) => item.data.entry_id === "watchlist:opensanctions:NK-2").data.features).toEqual({ identifier_conflict: true, score: 0.71 });
    // A range never becomes an exact interest; a percentage above 100 is unusable.
    const interests = records.filter((item) => item.object_type === "OwnershipInterest");
    expect(interests.map((item) => item.data.interest).sort()).toEqual(["0.3"]);
    expect(one("OwnershipRange").data).toMatchObject({ lower: "0.25", upper: "0.5", lower_inclusive: false, upper_inclusive: false });
    // Pages are 1-based; an unpaged or page-0 span is not a DocumentPage.
    expect(records.filter((item) => item.object_type === "DocumentPage").map((item) => item.data.page)).toEqual([2]);
  });

  it("refuses data outside the closed contract before it reaches the case store", () => {
    expect(validateRecordData("RegistryRecord", { name: "x", registration_id: "1", status: "ACTIVE", coverage: { complete: true }, registry: "y" })).toMatchObject({ valid: false, contract: "library" });
    expect(validateRecordData("Party", { entity_id: "e", role: "customer", profile: {} })).toMatchObject({ valid: false });
    expect(validateRecordData("ProviderCandidate", {})).toMatchObject({ valid: false, contract: "unknown" });
  });
});

describe("PEP relatives and close associates", () => {
  const person = (id: string, name: string) => ({ entity_id: id, entity_type: "person", names: [{ full: name, kind: "legal" }], identifiers: [], source_record_ids: [id] });
  const relationship = (id: string, from: string, to: string, type: string, assertion_status: string) => ({ relationship_id: id, from_entity_id: from, to_entity_id: to, type, direction: "undirected", assertion_status });
  const pepHost = (relationships: unknown[]) => host("screening", {
    entities: [person("subject", "Adaeze Okonkwo-Bell"), person("brother", "Chidi Okonkwo"), person("partner", "Tomas Reyes"), person("stranger", "Someone Else")],
    relationships,
    result: { kind: "screening", matches: [], dataset_versions: ["peps-2026-11"], scope: ["peps"], truncated: false, total_candidates: 0 },
  });

  it("records the screened subject's relatives and associates, verified only when the provider confirms them", () => {
    const result = normalizeWiringResult(wiring("opensanctions:screening.pep", pepHost([
      relationship("r1", "subject", "brother", "family_of", "confirmed"),
      relationship("r2", "partner", "subject", "close_associate_of", "asserted"),
      relationship("r3", "subject", "stranger", "family_of", "rejected"),
      relationship("r4", "brother", "stranger", "family_of", "confirmed"),
      relationship("r5", "subject", "stranger", "shares_address", "confirmed"),
    ])), { ...context, subjectId: "entity-adaeze" });
    const pep = result.records.filter((record) => record.object_type === "PEPRelationship");
    expect(pep.map((record) => ({ relation: record.data.relation, verified: record.data.verified, source: record.data.source }))).toEqual([
      // The screened subject's entity record, as its screening hits name it.
      { relation: "family", verified: true, source: "entity:opensanctions:subject" },
      { relation: "close_associate", verified: false, source: "entity:opensanctions:subject" },
    ]);
    for (const record of pep) {
      expect(validateRecordData(record.object_type, record.data).errors).toEqual([]);
      expect(canonicalRecordInputSchema.safeParse(record).success).toBe(true);
    }
  });

  it("does not record relationships from a sanctions screen", () => {
    const result = normalizeWiringResult(wiring("opensanctions:screening.sanctions", pepHost([relationship("r1", "subject", "brother", "family_of", "confirmed")])), { ...context, subjectId: "entity-adaeze" });
    expect(result.records.some((record) => record.object_type === "PEPRelationship")).toBe(false);
  });
});
