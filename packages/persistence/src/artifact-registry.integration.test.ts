import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeReleaseManifestDigest, stableDigest, type ReleaseManifest } from "@ehf/contracts";
import { createDatabase } from "./index.js";
import {
  approvePolicyRevision,
  createPolicyRevision,
  publishPolicyRevision,
  registerReleaseManifest,
  requireExecutableRelease,
  setPolicyRevisionCompiled,
  transitionRelease,
} from "./governance.js";
import { getArtifactRegistryEntry, listArtifactRegistry, revokeArtifactEntry } from "./artifact-registry.js";

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("artifact registry in PostgreSQL", () => {
  it("makes approval, execution authority and revocation a registry decision", async () => {
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    const tenantId = `registry_${randomUUID()}`;
    const digest = (seed: string) => stableDigest({ seed, tenantId });
    try {
      const revision = await createPolicyRevision(db, { tenantId, workspaceId: "kyc", files: { "policy.yaml": "rules: []\n" }, actor: "author" });
      const bundleDigest = digest("bundle");
      const bundle = {
        apiVersion: "harness.factory/policy-bundle-v1", kind: "PolicyBundle", bundleId: "bundle_1",
        policyId: "policy.kyc", policyVersion: "1.0.0", sourceDigest: revision.sourceDigest, bundleDigest,
        opaVersion: "1.9.0", regoModules: [{ path: "policy.rego", digest: digest("rego") }], dataDigest: digest("data"),
        gates: [{ gateId: "disposition", entrypoint: "data.harness.kyc.disposition", allowedOutcomes: ["ALLOW", "REVIEW", "BLOCK"] }],
        ruleIds: ["KYC-1"], testsDigest: digest("tests"),
        authority: { source: "POLICY_DB", casePath: "$.policyAuthority", requireSnapshotDigest: true },
      };
      await setPolicyRevisionCompiled(db, { tenantId, workspaceId: "kyc", revision: revision.revision, actor: "author", bundle });
      expect((await getArtifactRegistryEntry(db, tenantId, "policy-bundle", bundleDigest))?.status).toBe("registered");

      // Publication requires an approved registry entry; the author cannot approve.
      await expect(publishPolicyRevision(db, { tenantId, workspaceId: "kyc", revision: revision.revision, actor: "publisher" })).rejects.toThrow();
      await expect(approvePolicyRevision(db, { tenantId, workspaceId: "kyc", revision: revision.revision, actor: "author" })).rejects.toThrow("separation");
      const approved = await approvePolicyRevision(db, { tenantId, workspaceId: "kyc", revision: revision.revision, actor: "approver" });
      expect(approved.compiledBundle).toEqual(bundle);
      expect(await getArtifactRegistryEntry(db, tenantId, "policy-bundle", bundleDigest)).toMatchObject({ status: "approved", registeredBy: "author", approvedBy: "approver" });
      await publishPolicyRevision(db, { tenantId, workspaceId: "kyc", revision: revision.revision, actor: "publisher" });

      const planDigest = digest("plan");
      await db.query(`insert into harness_control.plans(plan_digest, plan_id, name, domain, version, plan, tenant_id)
        values ($1,'plan_1','kyc','kyc','1.0.0',$2::jsonb,$3)`, [planDigest, JSON.stringify({ policyBundles: [{ bundleDigest }] }), tenantId]);
      const manifest = {
        apiVersion: "harness.factory/release-manifest-v1", kind: "ReleaseManifest", releaseId: "release_1",
        planDigest, packageDigest: digest("package"), policyBundleDigests: [bundleDigest], schemaSetDigest: digest("schemas"),
        agentDigests: [], skillDigests: [], capabilityDigests: [], modelProfileDigests: [],
        executionProfileDigest: digest("execution"), compilerDigest: digest("compiler"), runtimeDigest: digest("runtime"),
        dependencyManifestDigest: digest("deps"), evaluationAttestationDigest: digest("eval"), provenanceDigest: digest("prov"),
        scope: { environment: "development", tenants: [tenantId], regions: ["US"], cohort: "all" },
        createdAt: new Date().toISOString(), manifestDigest: "0".repeat(64),
      } as ReleaseManifest;
      manifest.manifestDigest = computeReleaseManifestDigest(manifest);
      await registerReleaseManifest(db, { tenantId, actor: "release-author", manifest });
      expect((await getArtifactRegistryEntry(db, tenantId, "release-manifest", manifest.manifestDigest))?.status).toBe("registered");
      await expect(transitionRelease(db, { tenantId, releaseId: "release_1", actor: "release-author", expectedRevision: 0, to: "approved", reasonCode: "ok" })).rejects.toThrow("separation");
      await transitionRelease(db, { tenantId, releaseId: "release_1", actor: "release-approver", expectedRevision: 0, to: "approved", reasonCode: "ok" });
      await transitionRelease(db, { tenantId, releaseId: "release_1", actor: "release-approver", expectedRevision: 1, to: "active", reasonCode: "ok" });
      expect((await requireExecutableRelease(db, tenantId, planDigest, "development")).record.status).toBe("active");

      // Revoking the policy artifact withdraws execution authority immediately, without
      // touching the release record.
      await revokeArtifactEntry(db, { tenantId, kind: "policy-bundle", digest: bundleDigest, actor: "security", reasonCode: "policy.defect" });
      await expect(requireExecutableRelease(db, tenantId, planDigest, "development")).rejects.toThrow("artifact.revoked:policy-bundle");
      expect((await listArtifactRegistry(db, tenantId)).map((entry) => `${entry.kind}:${entry.status}`).sort())
        .toEqual(["policy-bundle:revoked", "release-manifest:approved"]);
    } finally {
      await db.end();
    }
  });
});
