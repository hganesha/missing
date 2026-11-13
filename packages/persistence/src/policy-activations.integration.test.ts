import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { stableDigest } from "@ehf/contracts";
import { createDatabase } from "./index.js";
import {
  activationState, approvePolicyRevision, createPolicyRevision, getPolicyRevision, listPolicyActivations, listPolicyRevisions,
  policyRevisionInEffect, publishPolicyRevision, rollbackPolicyRevision, setPolicyRevisionCompiled,
} from "./governance.js";

// Policy activation (Product Policy Studio phase F): effective dates, scheduling and rollback,
// against PostgreSQL and the same in-effect check the business-policy authority applies.
describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("policy activation", () => {
  const tenantId = `activation_${randomUUID()}`;
  const workspaceId = "kyc";

  async function released(db: ReturnType<typeof createDatabase>, text: string, effectiveFrom?: string) {
    const revision = await createPolicyRevision(db, { tenantId, workspaceId, files: { "policy.yaml": text }, actor: "author" });
    const digest = (seed: string) => stableDigest({ seed, tenantId, text });
    await setPolicyRevisionCompiled(db, { tenantId, workspaceId, revision: revision.revision, actor: "author", bundle: {
      apiVersion: "harness.factory/policy-bundle-v1", kind: "PolicyBundle", bundleId: `bundle_${revision.revision}`,
      policyId: "policy.kyc", policyVersion: `1.0.${revision.revision}`, sourceDigest: revision.sourceDigest, bundleDigest: digest("bundle"),
      opaVersion: "1.9.0", regoModules: [{ path: "policy.rego", digest: digest("rego") }], dataDigest: digest("data"),
      gates: [{ gateId: "disposition", entrypoint: "data.harness.kyc.disposition", allowedOutcomes: ["ALLOW", "REVIEW", "BLOCK"] }],
      ruleIds: ["KYC-1"], testsDigest: digest("tests"), authority: { source: "POLICY_DB", casePath: "$.policyAuthority", requireSnapshotDigest: true },
    } });
    await approvePolicyRevision(db, { tenantId, workspaceId, revision: revision.revision, actor: "approver" });
    return publishPolicyRevision(db, { tenantId, workspaceId, revision: revision.revision, actor: "publisher", effectiveFrom, reason: "Release" });
  }
  const state = async (db: ReturnType<typeof createDatabase>) => activationState(await listPolicyActivations(db, tenantId, workspaceId), await listPolicyRevisions(db, tenantId, workspaceId));

  it("takes effect now, schedules a future date, and rolls back to the exact prior revision", async () => {
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    try {
      const first = await released(db, "rules: [one]\n");
      expect(await policyRevisionInEffect(db, tenantId, workspaceId, first.revision)).toBe(true);
      expect((await state(db)).active).toMatchObject({ revision: first.revision, kind: "PUBLISH" });

      // A revision scheduled for later is published but decides nothing before its date.
      const at = new Date(Date.now() + 2500).toISOString();
      const scheduled = await released(db, "rules: [two]\n", at);
      expect(scheduled.status).toBe("PUBLISHED");
      expect(await policyRevisionInEffect(db, tenantId, workspaceId, scheduled.revision)).toBe(false);
      expect(await state(db)).toMatchObject({ active: { revision: first.revision }, scheduled: [{ revision: scheduled.revision, kind: "SCHEDULE", effectiveFrom: at }] });
      await sleep(2700);
      expect(await policyRevisionInEffect(db, tenantId, workspaceId, scheduled.revision)).toBe(true);
      expect((await state(db)).active?.revision).toBe(scheduled.revision);

      // Roll back: the first revision is in effect again with its exact digests; the later one is superseded.
      const before = (await getPolicyRevision(db, tenantId, workspaceId, first.revision))!;
      await expect(rollbackPolicyRevision(db, { tenantId, workspaceId, revision: first.revision, actor: "operator", reason: "" })).rejects.toThrow("policy.rollback_reason_required");
      await rollbackPolicyRevision(db, { tenantId, workspaceId, revision: first.revision, actor: "operator", reason: "Defect in revision two" });
      const after = (await getPolicyRevision(db, tenantId, workspaceId, first.revision))!;
      expect({ source: after.sourceDigest, bundle: after.bundleDigest, files: after.files, status: after.status }).toEqual({ source: before.sourceDigest, bundle: before.bundleDigest, files: before.files, status: "PUBLISHED" });
      expect((await getPolicyRevision(db, tenantId, workspaceId, scheduled.revision))!.status).toBe("SUPERSEDED");
      expect(await policyRevisionInEffect(db, tenantId, workspaceId, scheduled.revision)).toBe(false);
      expect(await policyRevisionInEffect(db, tenantId, workspaceId, first.revision)).toBe(true);
      expect((await state(db)).active).toMatchObject({ revision: first.revision, kind: "ROLLBACK", reason: "Defect in revision two" });
      // Nothing left to undo, and the history keeps every step.
      await expect(rollbackPolicyRevision(db, { tenantId, workspaceId, revision: first.revision, actor: "operator", reason: "Again" })).rejects.toThrow("policy.rollback_nothing_to_undo");
      await expect(rollbackPolicyRevision(db, { tenantId, workspaceId, revision: scheduled.revision, actor: "operator", reason: "Forward" })).rejects.toThrow("policy.rollback_target_not_published");
      expect((await listPolicyActivations(db, tenantId, workspaceId)).map((entry) => [entry.revision, entry.kind])).toEqual([[first.revision, "ROLLBACK"], [scheduled.revision, "SCHEDULE"], [first.revision, "PUBLISH"]]);
      const events = await db.query("select event_type from harness_control.policy_revision_events where tenant_id=$1 and event_type in ('policy.revision.rolled_back','policy.revision.superseded') order by event_type", [tenantId]);
      expect(events.rows.map((row) => row.event_type)).toEqual(["policy.revision.rolled_back", "policy.revision.superseded"]);
    } finally { await db.end(); }
  }, 30_000);

  it("refuses an effective date in the past", async () => {
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    try { await expect(released(db, "rules: [three]\n", "2020-01-01T00:00:00Z")).rejects.toThrow("policy.effective_from_past"); }
    finally { await db.end(); }
  });
});
