import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { createDatabase } from "./index.js";
import {
  listContextRefreshSchedules,
  saveContextRefreshSchedule,
  tickContextRefresh,
  retryContextRefresh,
} from "./context-setup-refresh.js";
describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)(
  "durable context refresh",
  () => {
    it("serializes overlapping ticks, holds checkpoints on failure, bounds replay and preserves revisions", async () => {
      const db = createDatabase(process.env.EHF_TEST_DATABASE_URL),
        scope = { tenantId: `refresh-${randomUUID()}`, environment: "test" };
      const schedule = {
        id: "daily",
        mappingId: "map",
        mappingDigest: "a".repeat(64),
        enablementRevision: 1,
        caseId: "c",
        nodeId: "fetch",
        planDigest: "b".repeat(64),
        sourceContextDigest: "c".repeat(64),
        subjects: ["42"],
        intervalMinutes: 60,
        startsAt: "2026-01-01T00:00:00Z",
        maxAttempts: 2,
        enabled: true,
      };
      const runKeys: string[] = [];
      let outcome: "pending" | "failed" | "completed" = "pending";
      const deps = {
        validate: async () => {},
        start: async (_s: unknown, key: string) => {
          runKeys.push(key);
          return `run-${runKeys.length}`;
        },
        inspect: async () => ({
          status: outcome,
          ...(outcome === "completed"
            ? { receiptDigest: "d".repeat(64) }
            : { errorCode: "context.validation_failed" }),
        }),
      };
      try {
        await saveContextRefreshSchedule(db, scope, {
          schedule,
          expectedRevision: 0,
          reason: "Test bounded refresh",
          actor: "operator",
        });
        await Promise.all([
          tickContextRefresh(db, scope, "daily", deps),
          tickContextRefresh(db, scope, "daily", deps),
        ]);
        expect(runKeys).toHaveLength(1);
        let rows = await listContextRefreshSchedules(db, scope);
        expect(rows[0]!.completed_through).toBeNull();
        await expect(
          saveContextRefreshSchedule(db, scope, {
            schedule: { ...schedule, enabled: false },
            expectedRevision: 1,
            reason: "Pause",
            actor: "operator",
          }),
        ).rejects.toThrow("context.refresh_in_flight");
        outcome = "failed";
        expect(
          (await tickContextRefresh(db, scope, "daily", deps)).status,
        ).toBe("quarantined");
        expect(
          (await tickContextRefresh(db, scope, "daily", deps)).status,
        ).toBe("quarantined");
        expect(runKeys).toHaveLength(1);
        await retryContextRefresh(db, scope, "daily", 1);
        await tickContextRefresh(db, scope, "daily", deps);
        expect(runKeys).toHaveLength(2);
        expect(runKeys[1]).not.toBe(runKeys[0]);
        outcome = "completed";
        expect(
          (await tickContextRefresh(db, scope, "daily", deps)).status,
        ).toBe("completed");
        rows = await listContextRefreshSchedules(db, scope);
        expect(rows[0]!.completed_through).not.toBeNull();
        expect(
          (await tickContextRefresh(db, scope, "daily", deps)).status,
        ).toBe("waiting");
        expect(
          await listContextRefreshSchedules(db, {
            ...scope,
            tenantId: "other",
          }),
        ).toEqual([]);
        await saveContextRefreshSchedule(db, scope, {
          schedule: { ...schedule, enabled: false },
          expectedRevision: 1,
          reason: "Pause",
          actor: "operator",
        });
        expect(
          (await tickContextRefresh(db, scope, "daily", deps)).status,
        ).toBe("paused");
      } finally {
        await db.end();
      }
    });
  },
);
