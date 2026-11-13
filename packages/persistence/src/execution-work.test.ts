import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { executionWorkItemSchema, stableDigest, type ExecutionWorkItem } from "@ehf/contracts";
import {
  acknowledgeExecutionDispatch,
  acquireExecutionWorkItemLease,
  decideExecutionWorkItemReconciliation,
  reconcileExecutionWorkItems,
  scheduleExecutionWork,
} from "./execution-work.js";
import type { Database } from "./index.js";

const actor = { type: "SYSTEM" as const, principalId: "test-controller", roles: ["workflow.controller"] };

function fixture(): ExecutionWorkItem {
  return executionWorkItemSchema.parse({
    apiVersion: "harness.factory/execution-work-item-v1",
    kind: "ExecutionWorkItem",
    tenantId: "tenant-a",
    caseId: "case-a",
    workItemId: "work-a",
    workType: "screening",
    capabilityId: "screening.sanctions",
    assuranceClass: "HIGH",
    revision: 0,
    caseSequenceBasis: 1,
    planDigest: "a".repeat(64),
    policyContextRef: "policy-context-a",
    schemaVersion: "work.v1",
    objective: "Screen subject",
    subjectRefs: ["subject-a"],
    requiredOutputs: ["screening-complete"],
    constraints: {},
    dependencyIds: [],
    dependencyDigest: stableDigest([]),
    invalidationPolicy: "BLOCK",
    status: "READY",
    reasonCode: "workflow.dependencies_satisfied",
    priority: 10,
    readyAt: "2026-09-19T12:00:00.000Z",
    deadlineAt: null,
    terminalAt: null,
    dispatch: { generation: 0, queue: "work.ready.screening", publishedAt: null, brokerMessageId: null },
    lease: null,
    limits: {
      maxAttempts: 3, maxReworkCycles: 2, maxDurationMs: 60_000,
      maxCostUsd: 1, maxModelCalls: 2, maxCapabilityCalls: 5,
    },
    result: null,
    createdBy: actor,
    transitionSequence: 0,
    traceId: null,
    createdAt: "2026-09-19T12:00:00.000Z",
    updatedAt: "2026-09-19T12:00:00.000Z",
  });
}

function row(item = fixture()): Record<string, unknown> {
  return {
    tenant_id: item.tenantId,
    case_id: item.caseId,
    work_item_id: item.workItemId,
    document: item,
    document_digest: stableDigest(item),
    revision: item.revision,
    status: item.status,
    reason_code: item.reasonCode,
    ready_at: item.readyAt,
    deadline_at: item.deadlineAt,
    terminal_at: item.terminalAt,
    dispatch_generation: item.dispatch.generation,
    dispatch_queue: item.dispatch.queue,
    dispatch_published_at: item.dispatch.publishedAt,
    broker_message_id: item.dispatch.brokerMessageId,
    execution_id: item.lease?.executionId ?? null,
    lease_owner: item.lease?.owner ?? null,
    lease_until: item.lease?.leaseUntil ?? null,
    fencing_epoch: item.lease?.fencingEpoch ?? 0,
    attempt_number: item.lease?.attemptNumber ?? 0,
    result: item.result,
    result_digest: null,
    completed_execution_id: null,
    transition_sequence: item.transitionSequence,
    trace_id: item.traceId,
    created_at: item.createdAt,
    updated_at: item.updatedAt,
    max_attempts: item.limits.maxAttempts,
    invalidation_policy: item.invalidationPolicy,
  };
}

describe("execution work kernel", () => {
  it("does not blindly replay a running attempt whose lease expired", () => {
    expect(decideExecutionWorkItemReconciliation({
      status: "RUNNING", invalidationPolicy: "BLOCK", deadlinePassed: false,
      leaseExpired: true, attemptsExhausted: false,
    })).toEqual({ to: "SUSPENDED", reasonCode: "workflow.effect_reconciliation_required" });
  });

  it("safely redispatches a lease that expired before execution started", () => {
    expect(decideExecutionWorkItemReconciliation({
      status: "LEASED", invalidationPolicy: "BLOCK", deadlinePassed: false,
      leaseExpired: true, attemptsExhausted: false,
    })).toEqual({ to: "READY", reasonCode: "workflow.lease_expired_before_execution" });
  });

  it("routes failed dependencies according to invalidation policy", () => {
    expect(decideExecutionWorkItemReconciliation({
      status: "BLOCKED", dependencyStatuses: ["FAILED"], invalidationPolicy: "CANCEL",
      deadlinePassed: false, leaseExpired: false, attemptsExhausted: false,
    })).toEqual({ to: "CANCELLED", reasonCode: "workflow.dependency_cancelled" });
  });
});

describe("dispatch crash boundaries", () => {
  it("creates generation 2 after a generation 1 lease expires before RUNNING", async () => {
    const mutable = row();
    const outbox = new Map<number, "PENDING" | "PUBLISHED" | "CONSUMED">();
    const statements: string[] = [];
    const client = {
      query: async (text: string, values: unknown[] = []) => {
        statements.push(text);
        if (text.includes("select work.*") && text.includes("dispatch_outbox")) {
          const generation = Number(mutable.dispatch_generation);
          const outstanding = outbox.get(generation);
          return { rows: mutable.status === "READY" && outstanding !== "PENDING" && outstanding !== "PUBLISHED" ? [mutable] : [] };
        }
        if (text.includes("set dispatch_generation=$3")) {
          mutable.dispatch_generation = values[2];
          mutable.revision = Number(mutable.revision) + 1;
          return { rowCount: 1, rows: [] };
        }
        if (text.includes("insert into workflow.dispatch_outbox")) {
          outbox.set(Number(values[3]), "PENDING");
          return { rowCount: 1, rows: [] };
        }
        if (text.includes("set status='PUBLISHED'")) {
          outbox.set(Number(values[2]), "PUBLISHED");
          return { rowCount: 1, rows: [] };
        }
        if (text.includes("select * from workflow.work_items") && text.includes("for update")) return { rows: [mutable] };
        if (text.includes("set status='LEASED'")) {
          mutable.status = "LEASED";
          mutable.reason_code = "workflow.lease_acquired";
          mutable.revision = values[3];
          mutable.transition_sequence = values[4];
          mutable.execution_id = values[5];
          mutable.lease_owner = values[6];
          mutable.lease_until = "2026-09-19T12:01:00.000Z";
          mutable.fencing_epoch = 1;
          mutable.attempt_number = 1;
          return { rowCount: 1, rows: [mutable] };
        }
        if (text.includes("set status='CONSUMED'")) {
          outbox.set(Number(values[2]), "CONSUMED");
          return { rowCount: 1, rows: [] };
        }
        if (text.includes("as dependency_statuses")) {
          return { rows: [{ ...mutable, dependency_statuses: [], deadline_passed: false, lease_expired: true, retry_due: false }] };
        }
        if (text.includes("set status=$3")) {
          mutable.status = values[2];
          mutable.reason_code = values[3];
          mutable.revision = values[4];
          mutable.transition_sequence = values[5];
          if (values[12]) {
            mutable.execution_id = null;
            mutable.lease_owner = null;
            mutable.lease_until = null;
          }
          return { rowCount: 1, rows: [mutable] };
        }
        return { rowCount: 1, rows: [] };
      },
      release: () => {},
    };
    const db = { connect: async () => client } as unknown as Database;

    const first = (await scheduleExecutionWork(db, 1))[0]!;
    expect(first.generation).toBe(1);
    await acknowledgeExecutionDispatch(db, first, first.messageId);
    const lease = await acquireExecutionWorkItemLease(db, {
      tenantId: "tenant-a", workItemId: "work-a", generation: 1,
      executionId: "execution-a", owner: "worker-a", leaseSeconds: 60, actor,
    });
    expect(lease.outcome).toBe("acquired");
    expect(outbox.get(1)).toBe("CONSUMED");

    expect(await reconcileExecutionWorkItems(db, 1)).toBe(1);
    expect(mutable.status).toBe("READY");
    const second = (await scheduleExecutionWork(db, 1))[0]!;
    expect(second.generation).toBe(2);
    expect(second.messageId).toBe("tenant-a:work-a:2");
    expect(statements.some((text) => text.includes("dispatch.status in ('PENDING','PUBLISHED')"))).toBe(true);
  });

  it("forces tenant RLS on every authoritative workflow relation", () => {
    const migration = readFileSync(new URL("../migrations/009_durable_execution_work.sql", import.meta.url), "utf8");
    expect(migration).toContain("force row level security");
    for (const relation of ["work_items", "work_item_dependencies", "work_item_transitions",
      "dispatch_outbox", "durable_timers", "reconciliation_cases"]) {
      expect(migration).toContain(`'${relation}'`);
    }
    expect(migration).toContain("current_setting('app.tenant_id', true)");
  });
});
