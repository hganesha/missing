import { describe, expect, it } from "vitest";
import type { CaseStore } from "./index.js";
import { drainOutbox, LoggingOutboxSink, type OutboxRecord, type OutboxSink } from "./outbox-relay.js";

type Statement = { text: string; values: unknown[] };

/**
 * Records every statement so the claim/publish/mark ordering can be asserted. The relay
 * works only through the relay functions (case-store migration 012), so the fake answers
 * those calls.
 */
function store(rows: Record<string, unknown[]>): { store: CaseStore; statements: Statement[] } {
  const statements: Statement[] = [];
  return {
    statements,
    store: {
      db: {
        connect: async () => { throw new Error("the relay must not open its own transactions"); },
        query: async (text: string, values: unknown[] = []) => {
          statements.push({ text, values });
          if (!text.includes("relay_claim_outbox")) return { rowCount: 0, rows: [] };
          const table = text.includes('"case_ledger"') ? "case" : "evidence";
          const claimed = (rows[table] ?? []).map((item) => ({ ...item as object, harness_plan_digest: "a".repeat(64) }));
          return { rowCount: claimed.length, rows: claimed };
        },
      },
      schemas: { core: "case_core", ledger: "case_ledger", evidence: "evidence" },
    } as unknown as CaseStore,
  };
}

const row = (id: string) => ({
  outbox_id: id, tenant_id: "tenant_demo", case_id: "case_1",
  event_id: `evt_${id}`, case_sequence: 4,
  event_type: "SubjectAdded", classification: "CONFIDENTIAL", created_at: new Date("2026-01-01T00:00:00Z"),
});

describe("outbox relay", () => {
  it("claims, publishes, then marks delivered", async () => {
    const published: OutboxRecord[][] = [];
    const { store: subject, statements } = store({ case: [row("ob_1")] });
    const sink: OutboxSink = { name: "test", publish: async (records) => {
      statements.push({ text: "sink.publish", values: [] });
      published.push(records);
    } };
    const result = await drainOutbox(subject, sink);
    expect(result.published).toBe(1);
    expect(published[0]?.[0]).toMatchObject({ outboxId: "ob_1", source: "case", eventType: "SubjectAdded" });
    // The claim (skip locked, inside relay_claim_outbox) commits before the sink sees the
    // rows, and rows are marked only after the sink accepted them.
    const claimIndex = statements.findIndex((s) => s.text.includes('"case_ledger"."relay_claim_outbox"'));
    const publishIndex = statements.findIndex((s) => s.text === "sink.publish");
    const markIndex = statements.findIndex((s) => s.text.includes('"case_ledger"."relay_mark_published"'));
    expect(claimIndex).toBeGreaterThanOrEqual(0);
    expect(publishIndex).toBeGreaterThan(claimIndex);
    expect(markIndex).toBeGreaterThan(publishIndex);
    expect(statements[markIndex]?.values[1]).toEqual(["ob_1"]);
  });

  it("carries identifiers and classification, not case content", async () => {
    // The relay hands a sink enough to route an event and nothing that would put case
    // payloads into a message bus or a log.
    const seen: OutboxRecord[] = [];
    const sink: OutboxSink = { name: "test", publish: async (records) => { seen.push(...records); } };
    await drainOutbox(store({ evidence: [row("ob_2")] }).store, sink);
    expect(Object.keys(seen[0] ?? {}).sort()).toEqual([
      "caseId", "caseSequence", "classification", "createdAt", "eventId", "eventType", "outboxId", "planDigest", "source", "tenantId",
    ]);
  });

  it("leaves rows unmarked when the sink refuses them", async () => {
    const sink: OutboxSink = { name: "failing", publish: async () => { throw new Error("bus unavailable"); } };
    const { store: subject, statements } = store({ case: [row("ob_3")] });
    await expect(drainOutbox(subject, sink)).rejects.toThrow("bus unavailable");
    expect(statements.some((s) => s.text.includes("relay_mark_published"))).toBe(false);
    expect(statements.some((s) => s.text.includes('"case_ledger"."relay_release_claim"'))).toBe(true);
  });

  it("purges published rows only when a retention window is set", async () => {
    const sink = new LoggingOutboxSink(() => {});
    const withoutRetention = store({});
    await drainOutbox(withoutRetention.store, sink, { retentionDays: 0 });
    expect(withoutRetention.statements.some((s) => s.text.includes("relay_purge_published"))).toBe(false);

    const withRetention = store({});
    const result = await drainOutbox(withRetention.store, sink, { retentionDays: 7 });
    const purges = withRetention.statements.filter((s) => s.text.includes("relay_purge_published"));
    // Both outboxes are aged out (the function deletes only rows already published).
    expect(purges.map((s) => s.text.includes('"case_ledger"') ? "case" : "evidence")).toEqual(["case", "evidence"]);
    expect(purges.every((s) => s.values[0] === 7)).toBe(true);
    expect(result.purged).toBe(0);
  });

  it("writes one bounded line per event through the default sink", async () => {
    const lines: string[] = [];
    const sink = new LoggingOutboxSink((line) => lines.push(line));
    await drainOutbox(store({ case: [row("ob_4")] }).store, sink);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      outbox: {
        outboxId: "ob_4", source: "case", tenantId: "tenant_demo", caseId: "case_1",
        eventId: "evt_ob_4", caseSequence: 4, planDigest: "a".repeat(64),
        eventType: "SubjectAdded", classification: "CONFIDENTIAL", createdAt: "2026-01-01T00:00:00.000Z",
      },
    });
  });
});
