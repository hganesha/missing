import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { skillQualificationSchema, stableDigest, type SkillQualification } from "@ehf/contracts";
import { approveSkillQualification, qualificationCovers, registerSkillQualification, requireSkillQualification, type SkillQualificationScope } from "./skill-qualifications.js";
import { createDatabase, getBusinessSkill, revokeArtifactEntry, upsertBusinessSkill } from "./index.js";

const q: SkillQualification = {
  schemaVersion: "skill.qualification.v1", skillId: "entity.resolve", skillVersion: "0.3.0",
  manifestDigest: "a".repeat(64), bundleDigest: `sha256:${"b".repeat(64)}`, bundleLockDigest: "c".repeat(64),
  planDigest: "d".repeat(64), policySnapshotRef: "policy:v1", policyContextDigest: "e".repeat(64),
  jurisdictions: ["US"], purpose: "onboarding", validFrom: "2026-01-01T00:00:00Z", expiresAt: "2027-01-01T00:00:00Z",
  independentReviewer: "reviewer", evidence: {
    reportRef: "evidence:held-out-evaluation", reportDigest: "f".repeat(64), datasetDigest: "1".repeat(64),
    sampleCount: 120, scopeDescription: "Individual deposit onboarding under the exact approved plan and policy", controlsPassed: true,
    metrics: [{ name: "candidate_recall", value: 0.99, comparison: "at_least", threshold: 0.98 }],
  },
};
const now = Date.parse("2026-11-08T12:00:00Z");
const scope: SkillQualificationScope = { ...q, jurisdiction: "US" };

describe("qualification contracts and scope", () => {
  it("rejects failed metrics, duplicate names/jurisdictions, empty evidence and invalid intervals", () => {
    expect(skillQualificationSchema.safeParse(q).success).toBe(true);
    for (const change of [
      { expiresAt: q.validFrom }, { jurisdictions: ["US", "US"] },
      { evidence: { ...q.evidence, metrics: [] } },
      { evidence: { ...q.evidence, metrics: [{ ...q.evidence.metrics[0], value: 0.5 }] } },
      { evidence: { ...q.evidence, controlsPassed: false } },
      { evidence: { ...q.evidence, metrics: [...q.evidence.metrics, ...q.evidence.metrics] } },
    ]) expect(skillQualificationSchema.safeParse({ ...q, ...change }).success).toBe(false);
  });

  it("binds every execution artifact, policy and supported scope, including exact validity boundaries", () => {
    expect(qualificationCovers(q, scope, now)).toBe(true);
    for (const change of [
      { skillVersion: "0.4.0" }, { manifestDigest: "2".repeat(64) }, { bundleLockDigest: "3".repeat(64) },
      { bundleDigest: `sha256:${"4".repeat(64)}` }, { planDigest: "5".repeat(64) }, { jurisdiction: "GB" },
      { policySnapshotRef: "policy:v2" }, { policyContextDigest: "6".repeat(64) }, { purpose: "review" as const },
    ]) expect(qualificationCovers(q, { ...scope, ...change }, now)).toBe(false);
    expect(qualificationCovers(q, scope, Date.parse(q.validFrom))).toBe(true);
    expect(qualificationCovers(q, scope, Date.parse(q.validFrom) - 1)).toBe(false);
    expect(qualificationCovers(q, scope, Date.parse(q.expiresAt))).toBe(false);
  });
});

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("skill catalog qualification in PostgreSQL", () => {
  it("enforces independent approval, tenant isolation, exact scope, immutable evidence and live revocation", async () => {
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    const tenantId = `qualification-${randomUUID()}`;
    try {
      const registered = await registerSkillQualification(db, { tenantId, actor: "author", qualification: q });
      expect(registered.digest).toBe(stableDigest(q));
      await expect(requireSkillQualification(db, tenantId, scope, now)).rejects.toThrow("required");
      await expect(approveSkillQualification(db, { tenantId, actor: "author", digest: registered.digest, now })).rejects.toThrow("reviewer_mismatch");
      await approveSkillQualification(db, { tenantId, actor: "reviewer", digest: registered.digest, now });
      expect(await requireSkillQualification(db, tenantId, scope, now)).toBe(registered.digest);
      await expect(requireSkillQualification(db, tenantId + "-other", scope, now)).rejects.toThrow("required");
      await expect(requireSkillQualification(db, tenantId, { ...scope, policyContextDigest: "9".repeat(64) }, now)).rejects.toThrow("required");
      await expect(requireSkillQualification(db, tenantId, scope, Date.parse(q.expiresAt))).rejects.toThrow("required");
      await expect(db.query("update harness_control.skill_qualifications set qualification=qualification where tenant_id=$1", [tenantId])).rejects.toThrow("immutable");
      await revokeArtifactEntry(db, { tenantId, kind: "skill-qualification", digest: registered.digest, actor: "reviewer", reasonCode: "source_changed" });
      await expect(requireSkillQualification(db, tenantId, scope, now)).rejects.toThrow("required");
      await expect(registerSkillQualification(db, { tenantId, actor: "reviewer", qualification: q })).rejects.toThrow("separation_of_duties");
    } finally { await db.end(); }
  });

  it("refuses mutations of active/verified versions and resets draft qualification on content changes", async () => {
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    const catalog = JSON.parse(readFileSync(new URL("../../../config/business-skills.json", import.meta.url), "utf8"));
    const original = catalog.skills[0].manifest;
    const version = `9.0.0-test.${randomUUID()}`;
    const manifest = { ...original, semver: version };
    const source = { path: "test", revision: "test" };
    try {
      await upsertBusinessSkill(db, { manifest, source, maturity: "designed" });
      await upsertBusinessSkill(db, { manifest: { ...manifest, description: "Draft update" }, source });
      expect((await getBusinessSkill(db, manifest.id, version))?.maturity).toBe("implemented_synthetic");
      const updated = (await getBusinessSkill(db, manifest.id, version))!;
      await upsertBusinessSkill(db, { manifest: updated.manifest, source, status: "active" });
      await expect(upsertBusinessSkill(db, { manifest: { ...manifest, description: "Changed release" }, source })).rejects.toThrow("released_version_immutable");
      await upsertBusinessSkill(db, { manifest: updated.manifest, source, status: "draft", maturity: "integration_verified" });
      await expect(upsertBusinessSkill(db, { manifest: { ...manifest, description: "Changed verification" }, source })).rejects.toThrow("released_version_immutable");
      await upsertBusinessSkill(db, { manifest: updated.manifest, source, status: "draft", maturity: "implemented_synthetic" });
      await expect(upsertBusinessSkill(db, { manifest: { ...manifest, description: "Changed after downgrade" }, source })).rejects.toThrow("released_version_immutable");
      await expect(db.query("delete from harness_control.business_skill_registry where skill_id=$1 and semver=$2", [manifest.id, version])).rejects.toThrow("released_version_immutable");
    } finally {
      await db.end();
    }
  });
});
