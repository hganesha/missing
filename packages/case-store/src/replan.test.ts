import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createKycCaseRequestSchema, type BusinessCommand } from "@ehf/contracts";
import { createCaseStore, createKycCase, submitBusinessCommand, type CaseStore } from "./index.js";

// ReplanCase: the control plane moves a case onto the process its policy escalated it to (EDD).
const database = process.env.EHF_TEST_DATABASE_URL;
const hex = () => randomBytes(32).toString("hex");

describe.skipIf(!database)("case re-planning in PostgreSQL", () => {
  async function setup(store: CaseStore) {
    const tenantId = `t-${randomUUID()}`, plan = hex(), policy = hex();
    await insertPlan(store, tenantId, plan);
    const created = await createKycCase(store, createKycCaseRequestSchema.parse({
      tenantId, policySnapshotDigest: policy, harnessPlanDigest: plan, actor: { type: "HUMAN", principalId: "requester@example.test", roles: [] },
      policyAuthority: { policyId: "policy.pack.us.standard", policyVersion: "2.0.0", policyBundleDigest: hex(), dependencyDigest: hex() },
    }), randomUUID());
    const caseId = String(created.case.caseId);
    const sequence = async () => Number((await store.db.query("select case_sequence from case_core.cases where tenant_id=$1 and case_id=$2", [tenantId, caseId])).rows[0].case_sequence);
    const command = async (commandType: BusinessCommand["commandType"], payload: Record<string, unknown>, actor: BusinessCommand["actor"] = { type: "SYSTEM", principalId: "control-api", roles: [] }) =>
      submitBusinessCommand(store, {
        commandId: randomUUID(), commandType, commandVersion: "v1", tenantId, caseId, actor,
        authority: { planDigest: plan, permissionEnvelopeDigest: hex(), policySnapshotDigest: policy },
        payload, preconditions: { caseSequence: await sequence() }, idempotencyKey: randomUUID(),
      });
    return { tenantId, caseId, plan, policy, command };
  }
  const insertPlan = (store: CaseStore, tenantId: string, digest: string) => store.db.query(
    "insert into harness_control.plans(plan_digest,plan_id,name,domain,version,plan,tenant_id) values($1,$2,'test','kyc','1','{}',$3)", [digest, `plan-${digest.slice(0, 8)}`, tenantId]);
  const target = () => ({ harnessPlanDigest: hex(), policySnapshotDigest: hex(),
    policyAuthority: { policyId: "policy.pack.us.enhanced", policyVersion: "2.0.0", policyBundleDigest: hex(), dependencyDigest: hex() },
    reason: "EDD triggers fired", requestedBy: "policy:edd-escalation" });

  it("moves the pin only while an EDD escalation is open, completes it, and records both pins", async () => {
    const store = createCaseStore({ connectionString: database! });
    try {
      const ctx = await setup(store);
      const to = target();
      await insertPlan(store, ctx.tenantId, to.harnessPlanDigest);
      await expect(ctx.command("ReplanCase", { ...to, workItemId: "edd-escalation" })).rejects.toThrow("replan.escalation_not_open");
      await ctx.command("ProposeWorkItem", { workItemId: "other", workType: "DOCUMENT_REQUEST" });
      await expect(ctx.command("ReplanCase", { ...to, workItemId: "other" })).rejects.toThrow("replan.escalation_not_open");
      await ctx.command("ProposeWorkItem", { workItemId: "edd-escalation", workType: "EDD_ESCALATION", priority: "HIGH" });
      await expect(ctx.command("ReplanCase", { ...to, harnessPlanDigest: ctx.plan, workItemId: "edd-escalation" })).rejects.toThrow("replan.same_plan");
      await ctx.command("ReplanCase", { ...to, workItemId: "edd-escalation" });
      const row = (await store.db.query("select harness_plan_digest, policy_snapshot_digest, policy_id from case_core.cases where tenant_id=$1 and case_id=$2", [ctx.tenantId, ctx.caseId])).rows[0];
      expect(row).toEqual({ harness_plan_digest: to.harnessPlanDigest, policy_snapshot_digest: to.policySnapshotDigest, policy_id: "policy.pack.us.enhanced" });
      const item = (await store.db.query("select status from case_core.case_work_items where tenant_id=$1 and case_id=$2 and work_item_id='edd-escalation'", [ctx.tenantId, ctx.caseId])).rows[0];
      expect(item.status).toBe("COMPLETED");
      const event = (await store.db.query("select payload from case_ledger.case_events where tenant_id=$1 and case_id=$2 and event_type='case.replanned'", [ctx.tenantId, ctx.caseId])).rows[0];
      expect(event.payload).toMatchObject({ fromPlanDigest: ctx.plan, toPlanDigest: to.harnessPlanDigest, requestedBy: "policy:edd-escalation" });
      // The escalation is spent: a second re-plan is refused.
      await expect(ctx.command("ReplanCase", { ...target(), workItemId: "edd-escalation" })).rejects.toThrow();
    } finally { await store.db.end(); }
  });
});
