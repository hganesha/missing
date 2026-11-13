import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { executionWorkItemSchema, stableDigest } from "@ehf/contracts";
import { createDatabase } from "./index.js";
import { claimHumanWorkItem, createExecutionWorkItem, submitHumanWorkDecision, getExecutionOutput, listHumanWorkQueue, resolveHumanWorkConflict } from "./execution-work.js";

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("durable human decisions in PostgreSQL", () => {
  it("requires independent reviewers, replays decisions safely, and preserves conflicting votes", async () => {
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    const tenantId = `review_${randomUUID()}`;
    const timestamp = new Date().toISOString();
    try {
      const make = async (workItemId: string) => createExecutionWorkItem(db, executionWorkItemSchema.parse({
        apiVersion: "harness.factory/execution-work-item-v1", kind: "ExecutionWorkItem", tenantId, caseId: "case", workItemId,
        workType: "approval", capabilityId: "human.review", assuranceClass: "HIGH", revision: 0, caseSequenceBasis: 1,
        planDigest: "a".repeat(64), policyContextRef: "policy", schemaVersion: "work.v1", objective: "Independent review",
        subjectRefs: [], requiredOutputs: ["decision"], constraints: { dualControlRequired: true }, dependencyIds: [], dependencyDigest: stableDigest([]),
        invalidationPolicy: "BLOCK", status: "HUMAN_REQUIRED", reasonCode: "review", priority: 10, readyAt: null, deadlineAt: null, terminalAt: null,
        dispatch: { generation: 0, queue: "human", publishedAt: null, brokerMessageId: null }, lease: null,
        limits: { maxAttempts: 3, maxReworkCycles: 2, maxDurationMs: 60000, maxCostUsd: 1, maxModelCalls: 1, maxCapabilityCalls: 1 },
        result: null, createdBy: { type: "SYSTEM", principalId: "test", roles: [] }, transitionSequence: 0, traceId: null, createdAt: timestamp, updatedAt: timestamp,
      }));
      const decision = (workItemId: string, principalId: string, outcome = "APPROVE") => ({ decisionId: randomUUID(), tenantId,
        caseId: "case", workItemId, principalId, decision: outcome, reasonCode: "review.evidence_checked", rationale: "Reviewed pinned evidence", evidenceRefs: [], decidedAt: timestamp });
      await make("agree");
      const first = decision("agree", "reviewer-a");
      expect((await submitHumanWorkDecision(db, first)).effective).toBe(false);
      await expect(submitHumanWorkDecision(db, decision("agree", "reviewer-a"))).rejects.toThrow();
      const second = decision("agree", "reviewer-b");
      const accepted = await submitHumanWorkDecision(db, second);
      expect(accepted.effective).toBe(true); expect(accepted.workItem.status).toBe("COMPLETED");
      expect((await submitHumanWorkDecision(db, { ...second, decidedAt: new Date().toISOString() })).effective).toBe(true);
      await expect(submitHumanWorkDecision(db, { ...second, rationale: "Altered" })).rejects.toThrow("idempotency_conflict");
      expect(await getExecutionOutput(db, tenantId, "agree")).toMatchObject({ decision: "APPROVE", authority: "HUMAN" });
      await make("conflict");
      await submitHumanWorkDecision(db, decision("conflict", "reviewer-a"));
      const conflict = await submitHumanWorkDecision(db, decision("conflict", "reviewer-b", "REJECT"));
      expect(conflict.conflict).toBe(true); expect(conflict.workItem.status).toBe("WAITING_HUMAN");
      expect((await listHumanWorkQueue(db, tenantId)).map((item) => item.workItem.workItemId)).toEqual(["conflict"]);
      const resolved = await resolveHumanWorkConflict(db, {
        ...decision("conflict", "operator-c", "REJECT"), decisionId: `resolution_${randomUUID()}`,
        reasonCode: "review.conflict_resolved", rationale: "Independent escalation review",
      });
      expect(resolved.workItem.status).toBe("COMPLETED");
      expect(await getExecutionOutput(db, tenantId, "conflict")).toMatchObject({ authority: "HUMAN_CONFLICT_RESOLUTION", decision: "REJECT" });

      await make("claimed");
      expect((await claimHumanWorkItem(db, { tenantId, workItemId: "claimed", principalId: "reviewer-a" })).replayed).toBe(false);
      expect((await claimHumanWorkItem(db, { tenantId, workItemId: "claimed", principalId: "reviewer-a" })).replayed).toBe(true);
      await expect(submitHumanWorkDecision(db, decision("claimed", "reviewer-b"))).rejects.toThrow("workflow.human_decision_not_assigned");
      expect((await submitHumanWorkDecision(db, decision("claimed", "reviewer-a"))).effective).toBe(false);
      expect(await listHumanWorkQueue(db, "other-tenant")).toEqual([]);
    } finally { await db.end(); }
  });
});
