import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DraftTestRun } from "@ehf/contracts";
import { createDatabase } from "./index.js";
import { draftTestStore } from "./draft-tests.js";

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("draft test history in PostgreSQL", () => {
  it("keeps tenant/draft/environment histories separate, deduplicates retries, and makes cancellation final", async () => {
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    const tenantId = `draft-test-${randomUUID()}`;
    const scope = { tenantId, environment: "test" };
    const store = draftTestStore(db, scope, "draft-1");
    const run: DraftTestRun = { testRunId: `test-${randomUUID()}`, draftId: "draft-1", revision: 1, planDigest: "a".repeat(64), mode: "recorded", status: "running", createdAt: new Date().toISOString(), finishedAt: null, error: null, output: null, warnings: [], calls: [], nodes: [] };
    try {
      expect((await store.create(run, "request-1", "digest-1", "author")).testRunId).toBe(run.testRunId);
      expect((await store.create({ ...run, testRunId: "duplicate" }, "request-1", "digest-1", "author")).testRunId).toBe(run.testRunId);
      await expect(store.create(run, "request-1", "different-input", "author")).rejects.toThrow("draft_test.idempotency_conflict");
      expect(await draftTestStore(db, { ...scope, tenantId: "other" }, "draft-1").get(run.testRunId)).toBeNull();
      expect(await draftTestStore(db, { ...scope, environment: "production" }, "draft-1").get(run.testRunId)).toBeNull();
      expect(await draftTestStore(db, scope, "draft-2").get(run.testRunId)).toBeNull();
      expect(await store.list()).toHaveLength(1);
      await store.save({ ...run, status: "cancelled", error: "draft_test.cancelled" });
      await store.save({ ...run, status: "completed" });
      expect((await store.get(run.testRunId))?.status).toBe("cancelled");
    } finally {
      await db.query("delete from harness_control.draft_test_runs where tenant_id=$1", [tenantId]);
      await db.end();
    }
  });
});
