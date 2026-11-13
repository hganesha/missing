import { describe, expect, it } from "vitest";
import { stableDigest } from "@ehf/contracts";
import { getCanonicalCaseSnapshot, getCaseSnapshot, projectCanonicalCaseSnapshot, type CaseStore } from "./index.js";

describe("authority-bearing case snapshots", () => {
  it("reads through one repeatable-read transaction and returns a stable digest", async () => {
    const statements: string[] = [];
    let released = false;
    const row = {
      tenant_id: "tenant_demo",
      case_id: "case_1",
      case_type: "kyc_onboarding",
      schema_version: "kyc.case.v1",
      jurisdiction: "US",
      status: "SCREENING",
      case_sequence: 7,
      external_ref: null,
      policy_snapshot_digest: "a".repeat(64),
      harness_plan_digest: "b".repeat(64),
      classification: "CONFIDENTIAL",
      created_by: { type: "HUMAN", principalId: "analyst", roles: ["KYC.Analyst"] },
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date("2026-01-02T00:00:00.000Z"),
    };
    const client = {
      query: async (sql: string) => {
        statements.push(sql.replace(/\s+/g, " ").trim());
        if (sql.includes('from "case_core"."cases"')) return { rows: [row], rowCount: 1 };
        if (sql.includes('from "evidence"."evidence_objects"')) {
          return { rows: [{ tenant_id: "tenant_demo", case_id: "case_1", evidence_id: "ev_1", content: Buffer.from("secret") }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => { released = true; },
    };
    const store = {
      db: { connect: async () => client },
      ownsDatabase: false,
      schemas: { core: "case_core", ledger: "case_ledger", evidence: "evidence" },
      artifactBackend: "postgres",
      evidenceRequireScan: false,
      evidenceMaxBytes: 1024,
    } as unknown as CaseStore;

    const snapshot = await getCaseSnapshot(store, "tenant_demo", "case_1", "KYC_POLICY_EVALUATION");
    expect(snapshot?.caseSequence).toBe(7);
    expect(snapshot?.purpose).toBe("KYC_POLICY_EVALUATION");
    expect(snapshot?.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((snapshot?.data.evidence as Record<string, unknown>[])[0]).not.toHaveProperty("content");
    expect(statements[0]).toBe("begin isolation level repeatable read read only");
    expect(statements.at(-1)).toBe("commit");
    expect(released).toBe(true);
  });

  it("rejects a snapshot read without an explicit purpose", async () => {
    const store = { db: {} } as unknown as CaseStore;
    await expect(getCaseSnapshot(store, "tenant_demo", "case_1", " ")).rejects.toThrow("case.snapshot_purpose_required");
  });

  it("returns a contract-valid canonical snapshot bound to complete authority", async () => {
    const statements: string[] = [];
    const digest = "a".repeat(64);
    const row = {
      tenant_id: "tenant_demo",
      case_id: "case_1",
      case_type: "kyc_onboarding",
      schema_version: "kyc.case.v1",
      jurisdiction: "US",
      status: "SCREENING",
      case_sequence: 9,
      external_ref: null,
      policy_snapshot_digest: digest,
      harness_plan_digest: "b".repeat(64),
      dependency_digest: "c".repeat(64),
      policy_id: "policy.kyc.customer-acceptance.v1",
      policy_version: "1.0.0",
      policy_bundle_digest: "d".repeat(64),
      classification: "CONFIDENTIAL",
      created_by: { type: "HUMAN", principalId: "analyst", roles: ["KYC.Analyst"] },
      created_at: new Date("2026-01-01T00:00:00.000Z"),
      updated_at: new Date("2026-01-02T00:00:00.000Z"),
    };
    const client = {
      query: async (sql: string) => {
        statements.push(sql.replace(/\s+/g, " ").trim());
        if (sql.includes('from "case_core"."cases"')) return { rows: [row], rowCount: 1 };
        if (sql.includes('from "evidence"."evidence_objects"')) {
          return { rows: [{ evidence_id: "ev_1", content: Buffer.from("never expose") }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const store = {
      db: { connect: async () => client },
      schemas: { core: "case_core", ledger: "case_ledger", evidence: "evidence" },
    } as unknown as CaseStore;

    const snapshot = await getCanonicalCaseSnapshot(store, "tenant_demo", "case_1", "KYC_POLICY_EVALUATION");

    expect(snapshot).toMatchObject({
      apiVersion: "harness.factory/case-snapshot-v1",
      kind: "CaseSnapshot",
      tenantId: "tenant_demo",
      caseId: "case_1",
      caseSequence: 9,
      dependencyDigest: "c".repeat(64),
      planDigest: "b".repeat(64),
      policyAuthority: {
        policyId: "policy.kyc.customer-acceptance.v1",
        policyVersion: "1.0.0",
        policySnapshotDigest: digest,
        policyBundleDigest: "d".repeat(64),
      },
      consistency: "strong",
    });
    expect(snapshot?.snapshotId).toBe(`snapshot_${snapshot?.snapshotDigest}`);
    expect(snapshot?.data.purpose).toBe("KYC_POLICY_EVALUATION");
    expect((snapshot?.data.evidence as Record<string, unknown>[])[0]).not.toHaveProperty("content");
    expect(statements[0]).toBe("begin isolation level repeatable read read only");
    expect(statements.at(-1)).toBe("commit");
  });

  it("fails closed when the current database cannot supply mandatory authority", async () => {
    const row = {
      tenant_id: "tenant_demo", case_id: "case_1", case_type: "kyc_onboarding", schema_version: "kyc.case.v1",
      jurisdiction: "US", status: "SCREENING", case_sequence: 7, external_ref: null,
      policy_snapshot_digest: "a".repeat(64), harness_plan_digest: "b".repeat(64), classification: "CONFIDENTIAL",
      created_by: { type: "HUMAN", principalId: "analyst", roles: [] },
      created_at: new Date("2026-01-01T00:00:00.000Z"), updated_at: new Date("2026-01-02T00:00:00.000Z"),
    };
    const statements: string[] = [];
    const client = {
      query: async (sql: string) => {
        statements.push(sql.trim());
        if (sql.includes('from "case_core"."cases"')) return { rows: [row], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
      release: () => undefined,
    };
    const store = {
      db: { connect: async () => client },
      schemas: { core: "case_core", ledger: "case_ledger", evidence: "evidence" },
    } as unknown as CaseStore;

    await expect(getCanonicalCaseSnapshot(store, "tenant_demo", "case_1", "KYC_POLICY_EVALUATION"))
      .rejects.toMatchObject({
        code: "case.snapshot_authority_incomplete",
        httpStatus: 409,
        details: { missingAuthorityFields: ["dependencyDigest", "policyId", "policyVersion", "policyBundleDigest"] },
      });
    expect(statements.at(-1)).toBe("rollback");
  });

  it("serializes only signed context-selector paths into a projected snapshot", async () => {
    const canonical = {
      apiVersion: "harness.factory/case-snapshot-v1" as const,
      kind: "CaseSnapshot" as const,
      tenantId: "tenant_demo", caseId: "case_1", caseSequence: 2,
      dependencyDigest: "a".repeat(64), planDigest: "b".repeat(64),
      policyAuthority: { policyId: "policy.test", policyVersion: "1", policySnapshotDigest: "c".repeat(64), policyBundleDigest: "d".repeat(64) },
      consistency: "strong" as const, classification: "CONFIDENTIAL",
      data: { case: { subject: { id: "subject_1" }, secret: "never-send" }, evidence: [{ evidenceId: "ev_1", secret: "never-send" }] },
    };
    const snapshotDigest = stableDigest(canonical);
    const snapshot = {
      ...canonical, snapshotId: `snapshot_${snapshotDigest}`, snapshotDigest,
      capturedAt: "2026-09-20T00:00:00.000Z",
    };
    const projected = projectCanonicalCaseSnapshot(snapshot, [{
      id: "subject", source: "case", path: "case.subject", purpose: "KYC_SCREENING", classification: "CONFIDENTIAL", required: true,
    }], [{ classification: "CONFIDENTIAL", action: "allow" }]);
    expect(projected.data).toEqual({ case: { subject: { id: "subject_1" } } });
    expect(projected.snapshotDigest).not.toBe(snapshot.snapshotDigest);
    expect(projected.snapshotId).toBe(`snapshot_${projected.snapshotDigest}`);
    for (const path of ["__proto__.polluted", "constructor.prototype.polluted", "case.__proto__.polluted"]) {
      expect(() => projectCanonicalCaseSnapshot(snapshot, [{
        id: "malicious", source: "case", path, purpose: "KYC_SCREENING", classification: "CONFIDENTIAL", required: true,
      }], [{ classification: "CONFIDENTIAL", action: "allow" }])).toThrow("case.context_path_invalid");
    }
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
  });

  it("keeps an array a node selects whole when it also selects one of its elements' fields", () => {
    const canonical = {
      apiVersion: "harness.factory/case-snapshot-v1" as const, kind: "CaseSnapshot" as const,
      tenantId: "tenant_demo", caseId: "case_1", caseSequence: 2, dependencyDigest: "a".repeat(64), planDigest: "b".repeat(64),
      policyAuthority: { policyId: "policy.test", policyVersion: "1", policySnapshotDigest: "c".repeat(64), policyBundleDigest: "d".repeat(64) },
      consistency: "strong" as const, classification: "CONFIDENTIAL",
      data: { subjects: [{ subject_id: "subject_1", attributes: { country: "US" } }] },
    };
    const snapshotDigest = stableDigest(canonical);
    const snapshot = { ...canonical, snapshotId: `snapshot_${snapshotDigest}`, snapshotDigest, capturedAt: "2026-09-20T00:00:00.000Z" };
    const selector = (id: string, path: string) => ({ id, source: "case" as const, path, purpose: "KYC_ONBOARDING", classification: "CONFIDENTIAL", required: true });
    // The document extraction node selects both, in this order (kycSubjects, subjectId).
    const projected = projectCanonicalCaseSnapshot(snapshot, [selector("kycSubjects", "subjects"), selector("subjectId", "subjects.0.subject_id")], [{ classification: "CONFIDENTIAL", action: "allow" }]);
    expect(projected.data).toEqual({ subjects: [{ subject_id: "subject_1", attributes: { country: "US" } }] });
  });

  it("applies the configured classification mask before context leaves the store", () => {
    const canonical = {
      apiVersion: "harness.factory/case-snapshot-v1" as const,
      kind: "CaseSnapshot" as const,
      tenantId: "tenant_demo", caseId: "case_1", caseSequence: 2,
      dependencyDigest: "a".repeat(64), planDigest: "b".repeat(64),
      policyAuthority: { policyId: "policy.test", policyVersion: "1", policySnapshotDigest: "c".repeat(64), policyBundleDigest: "d".repeat(64) },
      consistency: "strong" as const, classification: "CONFIDENTIAL",
      data: { case: { subject: { nationalId: "123456789" } } },
    };
    const snapshotDigest = stableDigest(canonical);
    const snapshot = { ...canonical, snapshotId: `snapshot_${snapshotDigest}`, snapshotDigest, capturedAt: "2026-09-20T00:00:00.000Z" };
    const selector = { id: "national-id", source: "case" as const, path: "case.subject.nationalId", purpose: "KYC_SCREENING", classification: "PII", required: true };
    const projected = projectCanonicalCaseSnapshot(snapshot, [selector], [{
      classification: "PII", action: "mask", transform: { kind: "partial", visiblePrefix: 0, visibleSuffix: 4, replacement: "*" },
    }]);
    expect(projected.data).toEqual({ case: { subject: { nationalId: "*****6789" } } });
    expect(() => projectCanonicalCaseSnapshot(snapshot, [selector], [{ classification: "PII", action: "deny" }]))
      .toThrow("case.context_classification_denied");
  });
});
