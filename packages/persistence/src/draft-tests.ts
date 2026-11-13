import { draftTestRunSchema, type DraftTestRun } from "@ehf/contracts";
import { contextTransaction, type ContextScope } from "./context-setup.js";
import type { Database } from "./index.js";

export function draftTestStore(db: Database, scope: ContextScope, draftId: string) {
  const keys = [scope.tenantId, scope.environment, draftId];
  return {
    async list(): Promise<DraftTestRun[]> {
      return contextTransaction(db, scope, async c => (await c.query(
        "select report from harness_control.draft_test_runs where tenant_id=$1 and environment=$2 and draft_id=$3 and expires_at>now() order by created_at desc limit 10", keys,
      )).rows.map(row => draftTestRunSchema.parse(row.report)));
    },
    async get(id: string): Promise<DraftTestRun | null> {
      return contextTransaction(db, scope, async c => {
        const row = (await c.query("select report from harness_control.draft_test_runs where tenant_id=$1 and environment=$2 and draft_id=$3 and id=$4 and expires_at>now()", [...keys, id])).rows[0];
        return row ? draftTestRunSchema.parse(row.report) : null;
      });
    },
    async create(run: DraftTestRun, requestKey: string, requestDigest: string, actor: string): Promise<DraftTestRun> {
      return contextTransaction(db, scope, async c => {
        await c.query("delete from harness_control.draft_test_runs where tenant_id=$1 and environment=$2 and expires_at<=now()", keys.slice(0, 2));
        await c.query("insert into harness_control.draft_test_runs(tenant_id,environment,draft_id,id,request_key,request_digest,created_by,report) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb) on conflict(tenant_id,environment,draft_id,request_key) do nothing", [...keys, run.testRunId, requestKey, requestDigest, actor, JSON.stringify(run)]);
        const row = (await c.query("select request_digest,report from harness_control.draft_test_runs where tenant_id=$1 and environment=$2 and draft_id=$3 and request_key=$4", [...keys, requestKey])).rows[0]!;
        if (row.request_digest !== requestDigest) throw new Error("draft_test.idempotency_conflict");
        return draftTestRunSchema.parse(row.report);
      });
    },
    async save(run: DraftTestRun): Promise<void> {
      await contextTransaction(db, scope, async c => {
        // Cancellation wins over a worker's late update.
        await c.query("update harness_control.draft_test_runs set report=$5::jsonb where tenant_id=$1 and environment=$2 and draft_id=$3 and id=$4 and report->>'status'='running'", [...keys, run.testRunId, JSON.stringify(run)]);
      });
    },
  };
}
