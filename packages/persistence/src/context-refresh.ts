import { randomUUID } from "node:crypto";
import type { Database } from "./index.js";
export type ContextRefreshJob = {
  tenant_id: string;
  binding_id: string;
  revision: number;
  plan_digest: string;
  source_context_digest: string;
  run_input: Record<string, unknown>;
  scheduled_for: Date;
  claim_id: string;
  run_id: string | null;
  failures: number;
};
export async function claimContextRefresh(
  db: Database,
  tenantId: string,
): Promise<ContextRefreshJob | null> {
  const result = await db.query<ContextRefreshJob>(
    `with next as (
    select tenant_id,binding_id from integration.context_refresh_jobs where tenant_id=$1 and enabled and due_at<=now()
      and (lease_until is null or lease_until<now()) order by due_at for update skip locked limit 1
  ) update integration.context_refresh_jobs j set claim_id=$2,lease_until=now()+interval '60 seconds'
    from next where j.tenant_id=next.tenant_id and j.binding_id=next.binding_id returning j.*`,
    [tenantId, randomUUID()],
  );
  return result.rows[0] ?? null;
}
export async function contextRefreshRunStatus(
  db: Database,
  job: ContextRefreshJob,
): Promise<string | null> {
  if (!job.run_id) return null;
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id',$1,true)", [
      job.tenant_id,
    ]);
    const result = await client.query<{ status: string }>(
      "select status from harness_runtime.runs where tenant_id=$1 and run_id=$2",
      [job.tenant_id, job.run_id],
    );
    await client.query("commit");
    return result.rows[0]?.status ?? null;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
export async function finishContextRefresh(
  db: Database,
  job: ContextRefreshJob,
  outcome: { runId?: string; status?: string; error?: string },
): Promise<void> {
  const terminal =
    outcome.status !== undefined &&
    ["completed", "failed", "cancelled"].includes(outcome.status);
  const successful = outcome.status === "completed";
  await db.query(
    `update integration.context_refresh_jobs set
    run_id=case when $5 then null else coalesce($6,run_id) end,
    scheduled_for=case when $5 then now() else scheduled_for end,
    due_at=case when $5 then now()+make_interval(mins=>interval_minutes) else now()+interval '15 seconds' end,
    failures=case when $7 then 0 when $8::text is not null or $5 then failures+1 else failures end,
    enabled=enabled and not (failures>=4 and ($8::text is not null or ($5 and not $7))),
    last_success_at=case when $7 then now() else last_success_at end,
    last_error=$8,claim_id=null,lease_until=null
    where tenant_id=$1 and binding_id=$2 and revision=$3 and claim_id=$4`,
    [
      job.tenant_id,
      job.binding_id,
      job.revision,
      job.claim_id,
      terminal,
      outcome.runId ?? null,
      successful,
      outcome.error ??
        (terminal && !successful ? "context_source.refresh_run_failed" : null),
    ],
  );
}
