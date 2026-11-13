import { describe, expect, it } from "vitest";
import {
  businessCommandTypeSchema,
  canonicalRecordDigest,
  canonicalRecordInputSchema,
  canonicalRecordObjectType,
  canonicalRecordSchema,
  caseReadGrantSchema,
  recordCanonicalRecordsPayloadSchema,
  recordSelectorRequirement,
} from "./index.js";

const input = {
  object_type: "RegistryRecord",
  object_id: "registry:companies-house:01234567",
  version_id: "v-1",
  data: { registration_id: "01234567", status: "active", coverage: { status: "complete_for_requested_scope" } },
  observed_at: "2026-11-07T12:00:00Z",
  source_refs: [{ tenant_id: "tenant-1", object_type: "GatewayInvocation", object_id: "inv-1", version_id: "check-1" }],
  provenance: { method: "connector_normalizer" as const, normalizer: "wiring.business@1", connector_id: "wiring:companies-house:business.registry.lookup" },
  classification: "CONFIDENTIAL",
  synthetic: true,
};

describe("canonical records", () => {
  it("accept a library-shaped record and reject unknown keys and inverted validity", () => {
    expect(canonicalRecordInputSchema.parse(input)).toMatchObject({ object_type: "RegistryRecord", synthetic: true });
    expect(canonicalRecordInputSchema.safeParse({ ...input, id: "x" }).success).toBe(false);
    expect(canonicalRecordInputSchema.safeParse({ ...input, object_type: "registry_record" }).success).toBe(false);
    const inverted = canonicalRecordInputSchema.safeParse({ ...input, valid_from: "2026-02-01T00:00:00Z", valid_to: "2026-01-01T00:00:00Z" });
    expect(inverted.success).toBe(false);
  });

  it("digest a version independently of the store's recorded time", () => {
    const stored = { ...input, tenant_id: "tenant-1", case_id: "case-1", supersedes: null };
    const digest = canonicalRecordDigest(stored);
    const parsed = canonicalRecordSchema.parse({ ...stored, recorded_at: "2026-11-07T12:00:01Z", record_digest: digest });
    expect(canonicalRecordDigest({ ...parsed, recorded_at: "2027-01-01T00:00:00Z" })).toBe(digest);
    expect(canonicalRecordDigest({ ...stored, data: { ...stored.data, status: "dissolved" } })).not.toBe(digest);
  });

  it("is a business command with a bounded batch payload", () => {
    expect(businessCommandTypeSchema.parse("RecordCanonicalRecords")).toBe("RecordCanonicalRecords");
    expect(recordCanonicalRecordsPayloadSchema.safeParse({ records: [] }).success).toBe(false);
    expect(recordCanonicalRecordsPayloadSchema.parse({ records: [input], evidenceRefs: ["ev_1"] }).records).toHaveLength(1);
  });

  it("express the library requirement shape on a case selector", () => {
    const record = recordSelectorRequirement({ object_type: "RegistryRecord", fields: ["registration_id", "status", "coverage"], min_count: 1, max_age_seconds: null });
    const selector = caseReadGrantSchema.parse({
      id: "registryRecords", source: "case", path: "records.RegistryRecord", purpose: "KYB_ONBOARDING", classification: "CONFIDENTIAL", required: true, record,
    });
    expect(canonicalRecordObjectType(selector)).toBe("RegistryRecord");
    expect(canonicalRecordObjectType({ path: "records.WatchlistEntry" })).toBe("WatchlistEntry");
    expect(canonicalRecordObjectType({ path: "subjects.0.display_name" })).toBeNull();
    expect(caseReadGrantSchema.safeParse({ ...selector, record: { ...record, fields: [] } }).success).toBe(false);
  });
});
