import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createMemoryBlobContainer } from "@ehf/blob-store/testing";
import { createKycCaseRequestSchema, registerEvidenceRequestSchema } from "@ehf/contracts";
import { createAuditExport, createCaseStore, createKycCase, getEvidenceContent, reconcileTenantEvidence, registerEvidence, tenantEvidencePrefix, type CaseStore } from "./index.js";

// Phase 5 (docs/implementation/data-stores-plan.md §3.6): evidence bytes in the evidence blob
// container (an in-memory object store here), the artifact row as metadata. EHF_TEST_DATABASE_URL: a migrated
// database with the case schemas.

const database = process.env.EHF_TEST_DATABASE_URL;

it("refuses the database evidence backend under the production profile", () => {
  vi.stubEnv("SECURITY_PROFILE", "production");
  try {
    expect(() => createCaseStore({ connectionString: "postgresql://unused@localhost/x", artifactBackend: "postgres" })).toThrow("case_store.evidence_blob_required_in_production");
  } finally { vi.unstubAllEnvs(); }
});

describe.skipIf(!database)("evidence in blob storage", () => {
  let blobs: ReturnType<typeof createMemoryBlobContainer>;
  let store: CaseStore;
  beforeAll(async () => {
    blobs = createMemoryBlobContainer({ container: "evidence", immutability: "none" });
    await blobs.ensure();
    store = createCaseStore({ connectionString: database!, artifactBackend: "object_store", evidenceBlobs: blobs });
  }, 60_000);
  afterAll(async () => { await store?.db.end(); });

  const newCase = async (tenantId: string) => String((await createKycCase(store, createKycCaseRequestSchema.parse({
    tenantId, policySnapshotDigest: "a".repeat(64), harnessPlanDigest: "b".repeat(64), actor: { type: "HUMAN", principalId: "requester", roles: [] },
  }), randomUUID())).case.caseId);
  const register = (tenantId: string, caseId: string, text: string) => registerEvidence(store, registerEvidenceRequestSchema.parse({
    tenantId, caseId, type: "registry_extract", mediaType: "application/json", contentBase64: Buffer.from(text).toString("base64"),
    source: { type: "TOOL", retrievedAt: new Date().toISOString() }, trust: { tier: "LICENSED_PROVIDER", instructionTrust: "UNTRUSTED_DATA" },
    createdBy: { type: "HUMAN", principalId: "analyst", roles: [] },
  }), randomUUID());

  it("stores the bytes in the container, not the database, and serves them back verified", async () => {
    const tenantId = `blob_${randomUUID()}`;
    const caseId = await newCase(tenantId);
    const registered = await register(tenantId, caseId, '{"registry":"companies-house"}');
    const evidenceId = String(registered.evidence.evidenceId);
    const artifact = (await store.db.query(`select a.backend, a.content, a.container, a.blob_name, a.immutability_state, a.artifact_ref
      from evidence.artifacts a join evidence.evidence_objects e on e.tenant_id = a.tenant_id and e.artifact_ref = a.artifact_ref
      where e.evidence_id = $1`, [evidenceId])).rows[0];
    expect(artifact).toMatchObject({ backend: "object_store", content: null, container: "evidence", immutability_state: "PENDING_RETENTION" });
    expect(artifact.blob_name).toMatch(/^tenants\/[a-f0-9]{16}\/sha256\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{64}$/);
    expect(artifact.artifact_ref).toBe(`artifact://object-store/${blobs.account}/evidence/${artifact.blob_name}`);
    expect((await blobs.get(artifact.blob_name)).toString()).toBe('{"registry":"companies-house"}');
    expect((await getEvidenceContent(store, tenantId, evidenceId))?.content.toString()).toBe('{"registry":"companies-house"}');

    // The same bytes again (another registration) reuse the blob; another tenant gets its own.
    await register(tenantId, caseId, '{"registry":"companies-house"}');
    const otherTenant = `blob_${randomUUID()}`;
    const other = await register(otherTenant, await newCase(otherTenant), '{"registry":"companies-house"}');
    expect(String(other.evidence.integrity && (other.evidence.integrity as { artifactRef: string }).artifactRef)).not.toBe(artifact.artifact_ref);

    // An audit package carries the bytes from the container, verified.
    const exported = await createAuditExport(store, tenantId, caseId);
    const artifacts = (exported as unknown as { document: { sections: { artifacts: Array<{ content: string }> } } }).document.sections.artifacts;
    expect(artifacts.map((item) => Buffer.from(item.content, "base64").toString())).toEqual(['{"registry":"companies-house"}']);
  });

  it("detects bytes changed behind the platform's back", async () => {
    const tenantId = `blob_${randomUUID()}`;
    const caseId = await newCase(tenantId);
    const evidenceId = String((await register(tenantId, caseId, "original")).evidence.evidenceId);
    const name = (await store.db.query(`select a.blob_name from evidence.artifacts a join evidence.evidence_objects e
      on e.tenant_id = a.tenant_id and e.artifact_ref = a.artifact_ref where e.evidence_id = $1`, [evidenceId])).rows[0].blob_name as string;
    // Overwrite through raw storage access, as someone with no platform role would.
    blobs.outOfBand.overwrite(name, "tampered");
    await expect(getEvidenceContent(store, tenantId, evidenceId)).rejects.toThrow("evidence.integrity_failed");
  });

  it("reconciles the container with the artifact rows and records the run", async () => {
    const tenantId = `blob_${randomUUID()}`;
    const caseId = await newCase(tenantId);
    const blobName = async (text: string) => {
      const evidenceId = String((await register(tenantId, caseId, text)).evidence.evidenceId);
      return (await store.db.query(`select a.blob_name from evidence.artifacts a join evidence.evidence_objects e
        on e.tenant_id = a.tenant_id and e.artifact_ref = a.artifact_ref where e.evidence_id = $1`, [evidenceId])).rows[0].blob_name as string;
    };
    const intact = await blobName("intact");
    const deleted = await blobName("deleted later");
    const swapped = await blobName("swapped later");
    blobs.outOfBand.remove(deleted);
    blobs.outOfBand.overwrite(swapped, "other");
    const orphan = `${tenantEvidencePrefix(tenantId)}sha256/00/00/${"0".repeat(64)}`;
    blobs.outOfBand.overwrite(orphan, "left behind");

    const report = await reconcileTenantEvidence(store, tenantId, { verifySample: 10 });
    expect(report).toMatchObject({ checked: 3, verified: 1, missingBlob: 1, orphanBlob: 1, lengthMismatch: 1, digestMismatch: 1, policyMismatch: 0 });
    expect(report.findings.map((finding) => `${finding.kind}:${finding.name}`).sort()).toEqual([
      `digest_mismatch:${swapped}`, `length_mismatch:${swapped}`, `missing_blob:${deleted}`, `orphan_blob:${orphan}`,
    ].sort());
    const run = (await store.db.query(`select * from evidence.reconciliation_runs where tenant_id = $1 and run_id = $2`, [tenantId, report.runId])).rows[0];
    expect(run).toMatchObject({ checked: "3", missing_blob: "1", orphan_blob: "1", digest_mismatch: "1" });
    expect(run.finished_at).toBeInstanceOf(Date);
    expect((await store.db.query(`select verified_at from evidence.artifacts where tenant_id = $1 and blob_name = $2`, [tenantId, intact])).rows[0].verified_at).toBeInstanceOf(Date);
    // Reporting only: the orphan is still there.
    expect(blobs.outOfBand.exists(orphan)).toBe(true);
  });
});
