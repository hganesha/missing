import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { stableDigest, createKycCaseRequestSchema } from "@ehf/contracts";
import { createCaseStore, createKycCase } from "./index.js";
import { canonicalJson, createAuditExport, getAuditExport, renderAuditExport, verifyAuditEvents, type AuditPackage } from "./audit-export.js";

const document: AuditPackage = { schema: "kyc.audit-package.v1", tenantId: "tenant", caseId: "case_雪<script>", caseSequence: 0,
  sections: { findings: [{ text: "雪<script>alert('x')</script>" }] }, sectionDigests: { findings: stableDigest([{ text: "雪<script>alert('x')</script>" }]) },
  ledger: { valid: true, eventCount: 0, headDigest: null } };
describe("reproducible audit exports", () => {
  it("canonicalizes key order and escapes untrusted HTML", async () => {
    expect(canonicalJson({ z: 1, a: { z: 2, a: 3 } })).toBe('{"a":{"a":3,"z":2},"z":1}');
    const html = (await renderAuditExport(document, "html")).toString();
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(JSON.parse((await renderAuditExport(document, "json")).toString())).toEqual(document);
  });
  it("produces byte-identical PDFs with the full JSON attachment", async () => {
    const first = await renderAuditExport(document, "pdf");
    const second = await renderAuditExport(document, "pdf");
    expect(first.equals(second)).toBe(true);
    expect(first.subarray(0, 5).toString()).toBe("%PDF-");
    expect(first.toString()).toContain("/EmbeddedFiles");
  });
  it("rejects missing ledger events instead of attesting to a truncated chain", () => {
    expect(() => verifyAuditEvents([], 1)).toThrow("audit.ledger_incomplete");
    expect(() => verifyAuditEvents([{ case_sequence: 1, event_digest: "bad" }], 1)).toThrow("audit.ledger_integrity_failed");
  });
});

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("audit package PostgreSQL integration", () => {
  it("freezes, verifies, persists, and isolates a real case export", async () => {
    const store = createCaseStore({ connectionString: process.env.EHF_TEST_DATABASE_URL! });
    try {
      const tenantId = `audit_${randomUUID()}`;
      const created = await createKycCase(store, createKycCaseRequestSchema.parse({ tenantId,
        caseType: "kyc_onboarding", schemaVersion: "kyc.case.v1", jurisdiction: "US",
        policySnapshotDigest: "a".repeat(64), harnessPlanDigest: "b".repeat(64), classification: "confidential",
        actor: { type: "HUMAN", principalId: "auditor", roles: [] } }), randomUUID());
      const first = await createAuditExport(store, tenantId, created.case.caseId);
      const second = await createAuditExport(store, tenantId, created.case.caseId);
      expect(second.digest).toBe(first.digest);
      expect(first.document.ledger.eventCount).toBe(1);
      expect(await getAuditExport(store, tenantId, created.case.caseId, first.digest)).toEqual(first.document);
      await expect(getAuditExport(store, "other-tenant", created.case.caseId, first.digest)).rejects.toThrow("audit.export_not_found");
    } finally { await store.db.end(); }
  });
});
