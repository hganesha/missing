import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeReleaseManifestDigest, stableDigest, type ReleaseManifest } from "@ehf/contracts";
import { createDatabase } from "./index.js";
import {
  activateSandboxRelease, listReleaseActivations, listReleases, listReleasesInEffect, requireExecutableRelease,
  SANDBOX_APPROVAL_ACTOR, SANDBOX_RELEASE_COHORT,
} from "./governance.js";

// Sandbox releases (migration 063): a draft's plan in effect for rehearsal, approved by a system
// identity, allowed to decide under a policy that still has release blockers, and kept apart from
// governed releases. Against a migrated database (EHF_TEST_DATABASE_URL).
describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("sandbox releases in PostgreSQL", () => {
  it("puts a blocked policy in effect for a sandbox release only, outside production", async () => {
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    const tenantId = `sandbox_release_${randomUUID()}`;
    const digest = (seed: string) => stableDigest({ seed, tenantId });
    try {
      const bundleDigest = digest("bundle"), planDigest = digest("plan");
      const files = { "policy.yaml": "policySets: []\n" };
      const bundle = {
        apiVersion: "harness.factory/policy-bundle-v1", kind: "PolicyBundle", bundleId: "bundle_1", policyId: "policy.kyc", policyVersion: "1.0.0", sourceDigest: stableDigest(files),
        bundleDigest, opaVersion: "1.9.0", regoModules: [{ path: "policy.rego", digest: digest("rego") }], dataDigest: digest("data"),
        gates: [{ gateId: "disposition", entrypoint: "data.harness.kyc.disposition", inputProfile: "canonical.onboarding.v2", allowedOutcomes: ["DECIDED", "NEEDS_EVIDENCE", "NEEDS_HUMAN"] }], ruleIds: ["KYC-1"], testsDigest: digest("tests"),
        authority: { source: "POLICY_DB", casePath: "$.policyAuthority", requireSnapshotDigest: true }, decisionContract: "business-v2",
      };
      const blockers = [{ id: "set.us", status: "UNRESOLVED", reasonCode: "POLICY_SET_NOT_APPROVED" }];
      await db.query(`insert into harness_control.plans(plan_digest, plan_id, name, domain, version, plan, tenant_id) values ($1,'plan_1','kyc','kyc','1.0.0',$2::jsonb,$3)`,
        [planDigest, JSON.stringify({ policyBundles: [{ policyId: "policy.kyc", bundleDigest }],
          graph: { nodes: [{ id: "gate", kind: "gate", config: { businessDecision: "v2", gateId: "disposition", policyRef: "policy.kyc" } }] } }), tenantId]);
      const manifestFor = (environment: string, cohort: string) => {
        const manifest = {
          apiVersion: "harness.factory/release-manifest-v1", kind: "ReleaseManifest", releaseId: `sandbox-${environment}-${cohort}`, planDigest, packageDigest: digest("package"),
          policyBundleDigests: [bundleDigest], schemaSetDigest: digest("schemas"), agentDigests: [], skillDigests: [], capabilityDigests: [], modelProfileDigests: [],
          executionProfileDigest: digest("execution"), compilerDigest: digest("compiler"), runtimeDigest: digest("runtime"), dependencyManifestDigest: digest("deps"),
          evaluationAttestationDigest: digest("eval"), provenanceDigest: digest("prov"), scope: { environment, tenants: [tenantId], regions: ["US"], cohort },
          createdAt: "2026-01-01T00:00:00.000Z", manifestDigest: "0".repeat(64),
        } as ReleaseManifest;
        manifest.manifestDigest = computeReleaseManifestDigest(manifest);
        return manifest;
      };
      const policies = [{ workspaceId: "sandbox:kyc", files, bundle, releaseBlockers: blockers }];
      const development = {} as NodeJS.ProcessEnv;

      // Refused: not a sandbox manifest, a production scope, the production profile, and self-approval.
      await expect(activateSandboxRelease(db, { tenantId, actor: "author", manifest: manifestFor("development", "all"), policies }, development)).rejects.toThrow("release.sandbox_cohort_required");
      await expect(activateSandboxRelease(db, { tenantId, actor: "author", manifest: manifestFor("production", SANDBOX_RELEASE_COHORT), policies }, development)).rejects.toThrow("release.sandbox_not_allowed");
      await expect(activateSandboxRelease(db, { tenantId, actor: "author", manifest: manifestFor("development", SANDBOX_RELEASE_COHORT), policies }, { SECURITY_PROFILE: "production" } as NodeJS.ProcessEnv))
        .rejects.toThrow("release.sandbox_not_allowed");
      await expect(activateSandboxRelease(db, { tenantId, actor: SANDBOX_APPROVAL_ACTOR, manifest: manifestFor("development", SANDBOX_RELEASE_COHORT), policies }, development)).rejects.toThrow("release.separation_of_duties");
      await expect(requireExecutableRelease(db, tenantId, planDigest, "development")).rejects.toThrow("release.executable_authority_missing");

      const manifest = manifestFor("development", SANDBOX_RELEASE_COHORT);
      const release = await activateSandboxRelease(db, { tenantId, actor: "author", manifest, policies }, development);
      expect(release.record.status).toBe("active");
      expect(release.approvedBy).toBe(SANDBOX_APPROVAL_ACTOR);
      // Idempotent on the release id.
      expect((await activateSandboxRelease(db, { tenantId, actor: "author", manifest, policies }, development)).record.releaseId).toBe(release.record.releaseId);

      // The blocked policy is executable through the sandbox release, here and at the policy authority.
      expect((await requireExecutableRelease(db, tenantId, planDigest, "development")).record.releaseId).toBe(release.record.releaseId);
      const authority = (environment: string) => db.query<{ manifest: unknown }>("select harness_runtime.lock_business_policy_authority($1,$2,$3,$4,$5,$6) as manifest",
        [tenantId, planDigest, manifest.manifestDigest, bundleDigest, "disposition", environment]).then((result) => result.rows[0]!.manifest);
      expect(await authority("development")).not.toBeNull();
      expect(await authority("production")).toBeNull();

      // Its policy authority is its own: the shared registry holds no policy-bundle entry, so a governed
      // approval of the same bundle is neither implied nor blocked.
      expect((await db.query("select 1 from harness_control.artifact_registry where tenant_id=$1 and artifact_kind='policy-bundle'", [tenantId])).rows).toEqual([]);
      await expect(activateSandboxRelease(db, { tenantId, actor: "author", manifest: manifestFor("development", SANDBOX_RELEASE_COHORT),
        policies: [{ ...policies[0]!, workspaceId: "kyc" }] }, development)).rejects.toThrow("release.sandbox_policy_workspace_required");

      // Kept apart from governed releases: not listed, not in the activation history, not offered to a case.
      expect(await listReleases(db, tenantId)).toEqual([]);
      expect((await listReleases(db, tenantId, { sandbox: true })).map((entry) => entry.record.releaseId)).toEqual([release.record.releaseId]);
      expect(await listReleasesInEffect(db, tenantId, "development")).toEqual([]);
      const history = await listReleaseActivations(db, tenantId);
      expect(history.activations).toEqual([]);
      expect(history.inEffect).toEqual([]);

      // A production scope can never carry the sandbox cohort, whatever the caller.
      await expect(db.query(`update harness_control.release_manifests set manifest = jsonb_set(manifest, '{scope,environment}', '"production"') where tenant_id=$1`, [tenantId]))
        .rejects.toThrow(/release_manifests_sandbox_not_production/);
    } finally {
      await db.end();
    }
  });
});
