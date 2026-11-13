import { describe, it, expect } from "vitest";
import type { PoolClient } from "pg";
import type { BusinessCommand } from "@ehf/contracts";
import { recordCanonicalRecords } from "./canonical-records.js";
const ref = (object_type: string, object_id: string, tenant_id = "t") => ({
  tenant_id,
  object_type,
  object_id,
  version_id: "v1",
});
const application = {
  contract_version: "1.0.0",
  source_application_id: "app1",
  applicants: [{ party_ref: ref("Party", "party1"), role: "PRIMARY" }],
  requested_products: [ref("Product", "prod1")],
  channel: "online",
  status: "DRAFT",
  submitted_at: null,
  effective_from: "2026-11-09T12:00:00Z",
  effective_to: null,
  evidence_refs: [],
  historical_decisions: [],
};
const command = (data: unknown): BusinessCommand =>
  ({
    tenantId: "t",
    caseId: "c",
    payload: {
      records: [
        {
          object_type: "Application",
          object_id: "app1",
          version_id: "v1",
          data,
          source_refs: [],
          provenance: { method: "platform" },
          classification: "CONFIDENTIAL",
          observed_at: "2026-11-09T12:00:00Z",
          synthetic: true,
        },
      ],
    },
  }) as unknown as BusinessCommand;
describe("application admission at the case boundary", () => {
  it("refuses invalid semantics and cross-tenant or unresolved versioned references before record insertion", async () => {
    let inserts = 0;
    const client = {
      query: async (sql: string) => {
        if (sql.startsWith("insert")) inserts++;
        return { rows: [] };
      },
    } as unknown as PoolClient;
    const schemas = {
        core: "case_core",
        ledger: "case_ledger",
        evidence: "evidence",
      },
      basis = { recordedAt: "2026-11-09T12:00:00Z", caseSequence: 2 };
    await expect(
      recordCanonicalRecords(
        client,
        schemas,
        command({ ...application, status: "INVALID" }),
        basis,
      ),
    ).rejects.toThrow("record.application_data_invalid");
    await expect(
      recordCanonicalRecords(
        client,
        schemas,
        command({
          ...application,
          applicants: [
            { party_ref: ref("Party", "p", "other"), role: "PRIMARY" },
          ],
        }),
        basis,
      ),
    ).rejects.toThrow("record.reference_tenant_mismatch");
    await expect(
      recordCanonicalRecords(client, schemas, command(application), basis),
    ).rejects.toThrow("record.reference_unresolved");
    expect(inserts).toBe(0);
  });
});
