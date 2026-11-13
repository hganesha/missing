import { describe, expect, it } from "vitest";
import { createRun, listEvents, listGatewayReceipts, type Database } from "./index.js";

const runRow = {
  run_id: "RUN-1", idempotency_key: "idem-1", plan_digest: "a".repeat(64), status: "queued",
  terminal_outcome: null, input: { value: 1 }, output: null, attempt: 0, fencing_epoch: 0,
  latest_checkpoint_id: null, current_node_id: null, error_code: null, trace_id: null,
  root_span_id: null, trace_flags: null, cost_usd: 0, cost_complete: true, model_calls: 0,
  capability_calls: 0, created_at: new Date("2026-01-01T00:00:00Z"), started_at: null,
  completed_at: null, updated_at: new Date("2026-01-01T00:00:00Z"),
};

describe("control-plane tenant integrity", () => {
  it("scopes run idempotency to tenant and binds it to the request digest", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const client = { query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      if (text.includes("where tenant_id = $1 and idempotency_key = $2")) return { rows: [] };
      if (text.includes("count(*)::text")) return { rows: [{ count: "0" }] };
      if (text.includes("insert into harness_runtime.runs")) return { rowCount: 1, rows: [runRow] };
      return { rows: [] };
    }, release: () => {} };
    const db = { connect: async () => client } as unknown as Database;

    await createRun(db, { tenantId: "tenant-a", idempotencyKey: "idem-1", planDigest: "a".repeat(64), runInput: { value: 1 } });
    const insert = calls.find((call) => call.text.includes("insert into harness_runtime.runs"));
    expect(insert?.values[4]).toBe("tenant-a");
    expect(insert?.values[5]).toMatch(/^[a-f0-9]{64}$/);
    expect(calls.some((call) => call.text.includes("pg_advisory_xact_lock"))).toBe(true);
    expect(calls.some((call) => call.text.includes("pg_notify('harness_run_queue'"))).toBe(true);
  });

  it("fails closed when an idempotency key is reused for different content", async () => {
    const client = { query: async (text: string) => {
      if (text.includes("select request_digest")) return { rows: [{ request_digest: "different" }] };
      if (text.includes("select run_id")) return { rows: [runRow] };
      return { rows: [] };
    }, release: () => {} };
    const db = { connect: async () => client } as unknown as Database;
    await expect(createRun(db, {
      tenantId: "tenant-a", idempotencyKey: "idem-1", planDigest: "a".repeat(64), runInput: { value: 2 },
    })).rejects.toThrow("run.idempotency_conflict");
  });

  it("applies queue backpressure after checking for an idempotent replay", async () => {
    const previous = process.env.RUN_QUEUE_MAX_PENDING;
    process.env.RUN_QUEUE_MAX_PENDING = "1";
    const client = { query: async (text: string) => {
      if (text.includes("where tenant_id = $1 and idempotency_key = $2")) return { rows: [] };
      if (text.includes("count(*)::text")) return { rows: [{ count: "1" }] };
      return { rows: [] };
    }, release: () => {} };
    const db = { connect: async () => client } as unknown as Database;
    try {
      await expect(createRun(db, {
        tenantId: "tenant-a", idempotencyKey: "idem-new", planDigest: "a".repeat(64), runInput: {},
      })).rejects.toThrow("run.queue_saturated");
    } finally {
      if (previous === undefined) delete process.env.RUN_QUEUE_MAX_PENDING;
      else process.env.RUN_QUEUE_MAX_PENDING = previous;
    }
  });

  it("joins events to their tenant-owned run", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const db = { query: async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return { rows: [] };
    } } as unknown as Database;
    await listEvents(db, "RUN-1", "tenant-a", 7);
    expect(calls[0]?.text).toContain("run.tenant_id = $2");
    expect(calls[0]?.text).toContain("event.status");
    expect(calls[0]?.values).toEqual(["RUN-1", "tenant-a", 7, 101]);
  });

  it("requires a tenant for receipt listings", async () => {
    const calls: Array<{ text: string; values: unknown[] }> = [];
    const db = { query: async (text: string, values: unknown[]) => {
      calls.push({ text, values });
      return { rows: [] };
    } } as unknown as Database;
    await listGatewayReceipts(db, "tenant-a", { runId: "RUN-1", decision: "denied" });
    expect(calls[0]?.text).toContain("where tenant_id = $1");
    expect(calls[0]?.values.slice(0, 3)).toEqual(["tenant-a", "RUN-1", "denied"]);
  });
});
