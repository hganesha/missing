import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { skillBundleLockDigest, skillBundleLockSchema } from "@ehf/contracts";
import { createDatabase } from "./index.js";
import { getArtifactRegistryEntry } from "./artifact-registry.js";
import { autoApproveSkillBundle, DEV_AUTO_APPROVAL_ACTOR, registerSkillBundle, requireApprovedSkillBundle } from "./skill-bundles.js";

const lock = skillBundleLockSchema.parse(JSON.parse(readFileSync(new URL("../../../apps/fincrime-host/src/financial_crime/resources/bundle.lock.json", import.meta.url), "utf8")));

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("development auto-approval of a skill bundle", () => {
  it("registers and approves under a named system approver, so the lock is executable", async () => {
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    const tenantId = `bundles_${randomUUID()}`;
    try {
      const result = await autoApproveSkillBundle(db, { tenantId, lock, registeredBy: "system:deployment:dev" });
      expect(result.lockDigest).toBe(skillBundleLockDigest(lock));
      expect(await getArtifactRegistryEntry(db, tenantId, "skill-bundle", lock.bundle_digest)).toMatchObject({ status: "approved", registeredBy: "system:deployment:dev", approvedBy: DEV_AUTO_APPROVAL_ACTOR });
      await expect(requireApprovedSkillBundle(db, tenantId, lock)).resolves.toMatchObject({ status: "approved" });
      // Repeating a deployment is harmless and keeps the first approval.
      await expect(autoApproveSkillBundle(db, { tenantId, lock, registeredBy: "system:deployment:dev" })).resolves.toMatchObject({ entry: { status: "approved" } });
      // The approver name cannot also register.
      await expect(autoApproveSkillBundle(db, { tenantId: `${tenantId}_b`, lock, registeredBy: DEV_AUTO_APPROVAL_ACTOR })).rejects.toThrow("artifact.separation_of_duties");
    } finally { await db.end(); }
  });

  it("approves a lock someone registered for review, and nothing else about another tenant", async () => {
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    const tenantId = `bundles_${randomUUID()}`;
    try {
      await registerSkillBundle(db, { tenantId, lock, actor: "author" });
      await autoApproveSkillBundle(db, { tenantId, lock, registeredBy: "author" });
      expect(await getArtifactRegistryEntry(db, tenantId, "skill-bundle", lock.bundle_digest)).toMatchObject({ status: "approved", registeredBy: "author", approvedBy: DEV_AUTO_APPROVAL_ACTOR });
      await expect(requireApprovedSkillBundle(db, `${tenantId}_other`, lock)).rejects.toThrow();
    } finally { await db.end(); }
  });
});
