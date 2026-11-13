import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeReleaseManifestDigest, stableDigest, type ReleaseManifest } from "@ehf/contracts";
import { createDatabase } from "./index.js";
import {
  approvePolicyRevision, createPolicyRevision, listReleaseActivations, publishPolicyRevision, registerReleaseManifest, requireExecutableRelease,
  rollbackRelease, setPolicyRevisionCompiled, transitionRelease,
} from "./governance.js";

// Release activation (phase H): when a release takes effect, superseding the one before it on its
// line, and rollback to an earlier one, against a migrated database (EHF_TEST_DATABASE_URL).
describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("release activation in PostgreSQL", () => {
  it("schedules, supersedes on its date and rolls back, and only the release in effect may execute", async () => {
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    const tenantId = `release_activation_${randomUUID()}`;
    const digest = (seed: string) => stableDigest({ seed, tenantId });
    try {
      const revision = await createPolicyRevision(db, { tenantId, workspaceId: "kyc", files: { "policy.yaml": "rules: []\n" }, actor: "author" });
      const bundleDigest = digest("bundle");
      await setPolicyRevisionCompiled(db, { tenantId, workspaceId: "kyc", revision: revision.revision, actor: "author", bundle: {
        apiVersion: "harness.factory/policy-bundle-v1", kind: "PolicyBundle", bundleId: "bundle_1", policyId: "policy.kyc", policyVersion: "1.0.0", sourceDigest: revision.sourceDigest,
        bundleDigest, opaVersion: "1.9.0", regoModules: [{ path: "policy.rego", digest: digest("rego") }], dataDigest: digest("data"),
        gates: [{ gateId: "disposition", entrypoint: "data.harness.kyc.disposition", allowedOutcomes: ["ALLOW", "REVIEW", "BLOCK"] }], ruleIds: ["KYC-1"], testsDigest: digest("tests"),
        authority: { source: "POLICY_DB", casePath: "$.policyAuthority", requireSnapshotDigest: true } } });
      await approvePolicyRevision(db, { tenantId, workspaceId: "kyc", revision: revision.revision, actor: "approver" });
      await publishPolicyRevision(db, { tenantId, workspaceId: "kyc", revision: revision.revision, actor: "publisher" });

      // Three versions of the same process (one line): plans named kyc, each with its release.
      const release = async (n: number) => {
        const planDigest = digest(`plan-${n}`);
        await db.query(`insert into harness_control.plans(plan_digest, plan_id, name, domain, version, plan, tenant_id) values ($1,$2,'kyc','kyc',$3,$4::jsonb,$5)`,
          [planDigest, `plan_${n}`, `1.0.${n}`, JSON.stringify({ policyBundles: [{ bundleDigest }] }), tenantId]);
        const manifest = {
          apiVersion: "harness.factory/release-manifest-v1", kind: "ReleaseManifest", releaseId: `release_${n}`, planDigest, packageDigest: digest(`package-${n}`),
          policyBundleDigests: [bundleDigest], schemaSetDigest: digest("schemas"), agentDigests: [], skillDigests: [], capabilityDigests: [], modelProfileDigests: [],
          executionProfileDigest: digest("execution"), compilerDigest: digest("compiler"), runtimeDigest: digest("runtime"), dependencyManifestDigest: digest("deps"),
          evaluationAttestationDigest: digest("eval"), provenanceDigest: digest("prov"), scope: { environment: "development", tenants: [tenantId], regions: ["US"], cohort: "all" },
          createdAt: new Date().toISOString(), manifestDigest: "0".repeat(64),
        } as ReleaseManifest;
        manifest.manifestDigest = computeReleaseManifestDigest(manifest);
        await registerReleaseManifest(db, { tenantId, actor: "release-author", manifest });
        await transitionRelease(db, { tenantId, releaseId: `release_${n}`, actor: "release-approver", expectedRevision: 0, to: "approved", reasonCode: "ok" });
        return planDigest;
      };
      const executable = (planDigest: string) => requireExecutableRelease(db, tenantId, planDigest, "development").then((entry) => entry.record.releaseId, (error: Error) => error.message);

      const plan1 = await release(1);
      await transitionRelease(db, { tenantId, releaseId: "release_1", actor: "release-approver", expectedRevision: 1, to: "active", reasonCode: "go-live" });
      expect(await executable(plan1)).toBe("release_1");

      // Scheduled for tomorrow: active, but not in effect, so release 1 still runs and release 2 does not.
      const plan2 = await release(2);
      const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
      await expect(transitionRelease(db, { tenantId, releaseId: "release_2", actor: "release-approver", expectedRevision: 1, to: "active", reasonCode: "x", effectiveFrom: "2001-01-01T00:00:00Z" }))
        .rejects.toThrow("release.effective_from_out_of_range");
      await transitionRelease(db, { tenantId, releaseId: "release_2", actor: "release-approver", expectedRevision: 1, to: "active", reasonCode: "next-year", effectiveFrom: tomorrow });
      expect(await executable(plan1)).toBe("release_1");
      expect(await executable(plan2)).toBe("release.executable_authority_missing");
      let state = await listReleaseActivations(db, tenantId);
      expect(state.inEffect).toEqual(["release_1"]);
      expect(state.scheduled.map((entry) => [entry.releaseId, entry.kind, entry.line])).toEqual([["release_2", "SCHEDULE", "kyc"]]);

      // Activated now: release 3 supersedes release 1 on the line.
      const plan3 = await release(3);
      await transitionRelease(db, { tenantId, releaseId: "release_3", actor: "release-approver", expectedRevision: 1, to: "active", reasonCode: "hotfix" });
      expect(await executable(plan3)).toBe("release_3");
      expect(await executable(plan1)).toBe("release.executable_authority_missing");

      // Roll back to release 1: release 3 and the scheduled release 2 are deprecated.
      await expect(rollbackRelease(db, { tenantId, releaseId: "release_1", actor: "release-approver", reason: "" })).rejects.toThrow("release.rollback_reason_required");
      await rollbackRelease(db, { tenantId, releaseId: "release_1", actor: "release-approver", reason: "Hotfix withdrawn" });
      expect(await executable(plan1)).toBe("release_1");
      expect(await executable(plan3)).toBe("release.executable_authority_missing");
      state = await listReleaseActivations(db, tenantId);
      expect(state.inEffect).toEqual(["release_1"]);
      expect(state.scheduled).toEqual([]);
      expect(state.activations.map((entry) => `${entry.releaseId}:${entry.kind}`).sort()).toEqual(["release_1:ACTIVATE", "release_1:ROLLBACK", "release_2:SCHEDULE", "release_3:ACTIVATE"]);
      const statuses = (await db.query<{ release_id: string; status: string }>("select release_id, status from harness_control.release_manifests where tenant_id=$1 order by release_id", [tenantId])).rows;
      expect(statuses.map((row) => `${row.release_id}:${row.status}`)).toEqual(["release_1:active", "release_2:deprecated", "release_3:deprecated"]);
      // A release that never took effect cannot be rolled back to.
      const plan4 = await release(4);
      await expect(rollbackRelease(db, { tenantId, releaseId: "release_4", actor: "release-approver", reason: "Try" })).rejects.toThrow("release.rollback_target_invalid");
      expect(plan4).toBeTruthy();
    } finally {
      await db.end();
    }
  });
});
