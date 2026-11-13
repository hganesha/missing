import { describe, expect, it } from "vitest";
import { abandonGatewayReceipt, reserveCapabilityBudget, reserveGatewayReceipt, type Database } from "./index.js";

function capturing(rowCount: number): { db: Database; statements: Array<{ text: string; values: unknown[] }> } {
  const statements: Array<{ text: string; values: unknown[] }> = [];
  return {
    statements,
    db: {
      query: async (text: string, values: unknown[]) => {
        statements.push({ text, values });
        return { rowCount, rows: [] };
      },
    } as unknown as Database,
  };
}

const budgets = { maxCapabilityCalls: 3, maxModelCalls: 1, maxCostUsd: 0.35 };

describe("capability budget reservation", () => {
  it("tests and increments the counters in one statement", async () => {
    // The gateway used to read the counters, decide, call the provider, and record usage
    // afterwards: two concurrent nodes both passed against the same stale counts.
    const { db, statements } = capturing(1);
    expect(await reserveCapabilityBudget(db, { runId: "RUN-1", modelCall: true, ...budgets })).toBe(true);
    const statement = statements[0]?.text ?? "";
    expect(statement).toContain("capability_calls = capability_calls + 1");
    expect(statement).toContain("capability_calls < $3");
    expect(statement).toContain("model_calls < $4");
    expect(statement).toContain("cost_usd < $5");
    expect(statements).toHaveLength(1);
  });

  it("reports denial when the statement matched no row", async () => {
    const { db } = capturing(0);
    expect(await reserveCapabilityBudget(db, { runId: "RUN-1", modelCall: false, ...budgets })).toBe(false);
  });

  it("only spends the model budget for model calls", async () => {
    const { db, statements } = capturing(1);
    await reserveCapabilityBudget(db, { runId: "RUN-1", modelCall: false, ...budgets });
    expect(statements[0]?.values[1]).toBe(false);
  });

  it("claims idempotency and budget in one transaction", async () => {
    const statements: string[] = [];
    const client = {
      query: async (text: string) => {
        statements.push(text);
        if (text.includes("insert into harness_gateway.receipts")) return { rowCount: 1, rows: [{ result: null }] };
        if (text.includes("update harness_runtime.runs")) return { rowCount: 1, rows: [] };
        return { rowCount: 0, rows: [] };
      },
      release: () => {},
    };
    const db = { connect: async () => client } as unknown as Database;
    await expect(reserveGatewayReceipt(db, {
      invocationId: "INV-1", runId: "RUN-1", nodeId: "node-1", attempt: 1, fencingEpoch: 1,
      planDigest: "a".repeat(64), permissionDigest: "b".repeat(64), capabilityId: "tool.x",
      effect: "read", decision: "allowed", reasonCode: "permission.envelope_allowed",
      requestDigest: "c".repeat(64), budget: { modelCall: false, ...budgets },
    })).resolves.toEqual({ created: true, result: null });
    expect(statements[0]).toBe("begin");
    expect(statements.some((text) => text.includes("capability_calls = capability_calls + 1"))).toBe(true);
    expect(statements.at(-1)).toBe("commit");
  });

  it("stores the selected skill candidate on the receipt", async () => {
    const inserts: unknown[][] = [];
    const client = {
      query: async (text: string, values: unknown[] = []) => {
        if (text.includes("insert into harness_gateway.receipts")) {
          inserts.push(values);
          return { rowCount: 1, rows: [{ result: null }] };
        }
        return { rowCount: 1, rows: [] };
      },
      release: () => {},
    };
    const db = { connect: async () => client } as unknown as Database;
    const skillSelection = {
      skillId: "screening.sanctions.execute", skillVersion: "0.1.0", selectedCapabilityId: "screening.sanctions.v1",
      selectedConnectorId: "wiring:opensanctions:screening.sanctions", candidateIndex: 2, reason: "fallback_after_timeout:candidate_0",
    };
    const receipt = {
      invocationId: "INV-2", runId: "RUN-1", nodeId: "node-1", attempt: 1, fencingEpoch: 1,
      planDigest: "a".repeat(64), permissionDigest: "b".repeat(64), capabilityId: "screening.sanctions.v1",
      effect: "read", decision: "allowed" as const, reasonCode: "permission.envelope_allowed",
      requestDigest: "c".repeat(64), budget: { modelCall: false, ...budgets },
    };
    await reserveGatewayReceipt(db, { ...receipt, skillSelection });
    await reserveGatewayReceipt(db, receipt);
    expect(JSON.parse(inserts[0]!.at(-1) as string)).toEqual(skillSelection);
    expect(inserts[1]!.at(-1)).toBeNull();
  });

  it("does not spend budget again when an invocation is replayed", async () => {
    const statements: string[] = [];
    const client = {
      query: async (text: string) => {
        statements.push(text);
        if (text.includes("insert into harness_gateway.receipts")) return { rowCount: 0, rows: [] };
        if (text.includes("select result, request_digest")) {
          return { rowCount: 1, rows: [{ result: { invocationId: "INV-1" }, request_digest: "c".repeat(64) }] };
        }
        return { rowCount: 0, rows: [] };
      },
      release: () => {},
    };
    const db = { connect: async () => client } as unknown as Database;
    const replay = await reserveGatewayReceipt(db, {
      invocationId: "INV-1", runId: "RUN-1", nodeId: "node-1", attempt: 1, fencingEpoch: 1,
      planDigest: "a".repeat(64), permissionDigest: "b".repeat(64), capabilityId: "tool.x",
      effect: "read", decision: "allowed", reasonCode: "permission.envelope_allowed",
      requestDigest: "c".repeat(64), budget: { modelCall: false, ...budgets },
    });
    expect(replay.created).toBe(false);
    expect(statements.some((text) => text.includes("update harness_runtime.runs"))).toBe(false);
    expect(statements.at(-1)).toBe("commit");
  });

  it("only abandons unfinished receipts owned by the run", async () => {
    const { db, statements } = capturing(1);
    await abandonGatewayReceipt(db, "RUN-1", "INV-1");
    expect(statements[0]?.text).toContain("result is null");
    expect(statements[0]?.text).toContain("run_id = $2");
    expect(statements[0]?.values).toEqual(["INV-1", "RUN-1"]);
  });
});
