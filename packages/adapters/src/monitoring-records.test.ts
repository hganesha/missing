import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeTransactionMonitoring, type MonitorInput } from "./monitoring-records.js";

const root = fileURLToPath(new URL("../../../fixtures/context-corpus/parties", import.meta.url));
const load = (party: string) => ({
  payload: JSON.parse(readFileSync(`${root}/${party}/provider/transaction.monitor.v1/alerts.json`, "utf8")) as MonitorInput,
  records: readFileSync(`${root}/${party}/records.jsonl`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)),
});
const context = { connectorId: "corpus:replay", capabilityId: "transaction.monitor.v1", invocationId: "inv-9", tenantId: "tenant-synthetic" };

describe("transaction.monitor.v1 normalizer", () => {
  for (const party of ["H05", "H07"]) {
    it(`${party}: provider alerts normalize to the committed Alert records`, () => {
      const { payload, records } = load(party);
      const out = normalizeTransactionMonitoring({ ...payload, synthetic: true }, context);
      expect(out.recordGap).toBeNull();
      const want = new Map(records.filter((r: any) => r.object_type === "Alert").map((r: any) => [r.data.source_id, r.data]));
      expect(out.records).toHaveLength(want.size);
      for (const r of out.records) expect(r.data).toEqual(want.get((r.data as any).source_id));
      expect(out.records.every((r) => r.synthetic && r.source_refs[0]?.object_type === "GatewayInvocation")).toBe(true);
    });
  }

  it("treats no alerts as a gap, not a clean result", () => {
    const { payload } = load("H01");
    const out = normalizeTransactionMonitoring(payload, context);
    expect(out.records).toEqual([]);
    expect(out.recordGap).toMatchObject({ outcome: "completed" });
  });

  it("deduplicates identical alerts, refuses conflicts and incomplete alerts, and never invents a severity", () => {
    const a = { alert_id: "x-1", rule_id: "R", severity: "HIGH", subject: "e1", raised_at: "2026-01-02T00:00:00Z", event_ids: ["evt-1"] };
    expect(normalizeTransactionMonitoring({ alerts: [a, a] }, context).records).toHaveLength(1);
    expect(normalizeTransactionMonitoring({ alerts: [a, { ...a, rule_id: "S" }] }, context).recordGap?.reason).toContain("conflicting");
    expect(normalizeTransactionMonitoring({ alerts: [{ ...a, event_ids: [] }] }, context).recordGap?.reason).toContain("missing");
    expect((normalizeTransactionMonitoring({ alerts: [{ ...a, severity: "CRITICAL" }] }, context).records[0]!.data as any).severity).toBe("UNKNOWN");
  });

  it("is deterministic", () => {
    const { payload } = load("H07");
    const run = () => normalizeTransactionMonitoring(payload, context).records.map((r) => r.version_id);
    expect(run()).toEqual(run());
  });
});
