import {
  contextRefreshScheduleSchema,
  type ContextRefreshSchedule,
} from "@ehf/contracts/context-refresh";
import { stableDigest } from "@ehf/contracts";
import {
  ContextSetupError,
  contextTransaction,
  type ContextScope,
} from "./context-setup.js";
import type { Database } from "./index.js";

export async function listContextRefreshSchedules(
  db: Database,
  scope: ContextScope,
  mappingId?: string,
) {
  return contextTransaction(
    db,
    scope,
    async (c) =>
      (
        await c.query(
          `
    select s.id,s.revision,s.definition,s.digest,s.created_by,s.created_at,
      state.next_due,state.completed_through,state.last_success_at,
      (select to_jsonb(b) - 'tenant_id' - 'environment' from harness_control.context_refresh_batches b
       where b.tenant_id=s.tenant_id and b.environment=s.environment and b.schedule_id=s.id and b.revision=s.revision
       order by b.slot desc,b.attempt desc limit 1) as latest_batch,
      (select coalesce(jsonb_agg(to_jsonb(history) - 'tenant_id' - 'environment'), '[]'::jsonb) from
        (select * from harness_control.context_refresh_batches b where b.tenant_id=s.tenant_id and b.environment=s.environment and b.schedule_id=s.id order by b.slot desc,b.revision desc,b.attempt desc limit 10) history) as history
    from (select distinct on(id) * from harness_control.context_refresh_schedules
      where tenant_id=$1 and environment=$2 order by id,revision desc) s
    join harness_control.context_refresh_state state using(tenant_id,environment,id,revision)
    where ($3::text is null or s.definition->>'mappingId'=$3) order by s.id limit 100`,
          [scope.tenantId, scope.environment, mappingId ?? null],
        )
      ).rows,
  );
}
export async function saveContextRefreshSchedule(
  db: Database,
  scope: ContextScope,
  input: {
    schedule: ContextRefreshSchedule;
    expectedRevision: number;
    reason: string;
    actor: string;
  },
) {
  const schedule = contextRefreshScheduleSchema.parse(input.schedule);
  return contextTransaction(db, scope, async (c) => {
    const p = [scope.tenantId, scope.environment, schedule.id];
    await c.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify([...p, "refresh"]),
    ]);
    const head = await c.query<{
      revision: number;
      definition: ContextRefreshSchedule;
    }>(
      "select revision,definition from harness_control.context_refresh_schedules where tenant_id=$1 and environment=$2 and id=$3 order by revision desc limit 1",
      p,
    );
    if ((head.rows[0]?.revision ?? 0) !== input.expectedRevision)
      throw new ContextSetupError("context.refresh_revision_conflict", 409);
    // A running revision must settle before replacement; this also makes pause behavior explicit.
    const running = await c.query(
      "select 1 from harness_control.context_refresh_batches where tenant_id=$1 and environment=$2 and schedule_id=$3 and status='RUNNING'",
      p,
    );
    if (running.rows.length)
      throw new ContextSetupError("context.refresh_in_flight", 409);
    const rev = input.expectedRevision + 1;
    await c.query(
      "insert into harness_control.context_refresh_schedules(tenant_id,environment,id,revision,definition,digest,reason,created_by) values($1,$2,$3,$4,$5::jsonb,$6,$7,$8)",
      [
        ...p,
        rev,
        JSON.stringify(schedule),
        stableDigest(schedule),
        input.reason,
        input.actor,
      ],
    );
    await c.query(
      "insert into harness_control.context_refresh_state(tenant_id,environment,id,revision,next_due) values($1,$2,$3,$4,$5)",
      [...p, rev, schedule.startsAt],
    );
    const prior = head.rows[0];
    if (
      prior &&
      stableDigest({ ...prior.definition, enabled: false }) ===
        stableDigest({ ...schedule, enabled: false })
    )
      await c.query(
        `update harness_control.context_refresh_state next set next_due=prior.next_due,completed_through=prior.completed_through,last_success_at=prior.last_success_at from harness_control.context_refresh_state prior where next.tenant_id=$1 and next.environment=$2 and next.id=$3 and next.revision=$4 and prior.tenant_id=next.tenant_id and prior.environment=next.environment and prior.id=next.id and prior.revision=$5`,
        [...p, rev, prior.revision],
      );
    return { id: schedule.id, revision: rev };
  });
}
type Batch = {
  slot: Date;
  attempt: number;
  status: string;
  run_id: string | null;
};
/** One bounded tick under a tenant lock. Deterministic run keys repair a crash between queue and batch commit. */
export async function tickContextRefresh(
  db: Database,
  scope: ContextScope,
  id: string,
  deps: {
    validate: (s: ContextRefreshSchedule) => Promise<void>;
    start: (s: ContextRefreshSchedule, key: string) => Promise<string>;
    inspect: (
      runId: string,
      s: ContextRefreshSchedule,
    ) => Promise<{
      status: "pending" | "completed" | "failed";
      receiptDigest?: string;
      errorCode?: string;
    }>;
  },
) {
  return contextTransaction(db, scope, async (c) => {
    const p = [scope.tenantId, scope.environment, id];
    await c.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify([...p, "refresh"]),
    ]);
    const head = await c.query<{
      definition: unknown;
      revision: number;
      next_due: Date;
      now: Date;
    }>(
      `select s.definition,s.revision,state.next_due,now() as now from harness_control.context_refresh_schedules s join harness_control.context_refresh_state state using(tenant_id,environment,id,revision) where tenant_id=$1 and environment=$2 and id=$3 order by revision desc limit 1`,
      p,
    );
    const row = head.rows[0];
    if (!row) throw new ContextSetupError("context.refresh_not_found", 404);
    const s = contextRefreshScheduleSchema.parse(row.definition),
      q = [...p, row.revision];
    const current = await c.query<Batch>(
      "select * from harness_control.context_refresh_batches where tenant_id=$1 and environment=$2 and schedule_id=$3 and revision=$4 order by slot desc,attempt desc limit 1",
      q,
    );
    let batch = current.rows[0];
    if (batch?.status === "RUNNING" && batch.run_id) {
      const observed = await deps.inspect(batch.run_id, s);
      if (observed.status === "pending")
        return { status: "running", runId: batch.run_id };
      if (observed.status === "completed" && observed.receiptDigest) {
        await c.query(
          "update harness_control.context_refresh_batches set status='COMPLETED',completed_at=now(),receipt_digest=$7 where tenant_id=$1 and environment=$2 and schedule_id=$3 and revision=$4 and slot=$5 and attempt=$6",
          [...q, batch.slot, batch.attempt, observed.receiptDigest],
        );
        // Coalesce missed intervals; never produce an unbounded catch-up backlog.
        await c.query(
          "update harness_control.context_refresh_state set completed_through=$5,last_success_at=now(),next_due=greatest($5::timestamptz + make_interval(mins=>$6), now()+make_interval(mins=>$6)) where tenant_id=$1 and environment=$2 and id=$3 and revision=$4",
          [...q, batch.slot, s.intervalMinutes],
        );
        return {
          status: "completed",
          runId: batch.run_id,
          completedThrough: batch.slot.toISOString(),
        };
      }
      await c.query(
        "update harness_control.context_refresh_batches set status='QUARANTINED',error_code=$7 where tenant_id=$1 and environment=$2 and schedule_id=$3 and revision=$4 and slot=$5 and attempt=$6",
        [
          ...q,
          batch.slot,
          batch.attempt,
          observed.errorCode ?? "context.refresh_commit_missing",
        ],
      );
      return { status: "quarantined", runId: batch.run_id };
    }
    if (!s.enabled) return { status: "paused" };
    if (batch?.status === "QUARANTINED")
      return { status: "quarantined", runId: batch.run_id };
    if (row.next_due > row.now && batch?.status !== "PENDING")
      return { status: "waiting" };
    if (batch?.status !== "PENDING") {
      batch = {
        slot: row.next_due,
        attempt: 1,
        status: "PENDING",
        run_id: null,
      };
      await c.query(
        "insert into harness_control.context_refresh_batches(tenant_id,environment,schedule_id,revision,slot,attempt,status) values($1,$2,$3,$4,$5,1,'PENDING')",
        [...q, batch.slot],
      );
    }
    try {
      await deps.validate(s);
      const key = `context-refresh:${stableDigest({ scope, id, revision: row.revision, slot: batch.slot.toISOString(), attempt: batch.attempt })}`;
      const runId = await deps.start(s, key);
      await c.query(
        "update harness_control.context_refresh_batches set status='RUNNING',run_id=$7,error_code=null where tenant_id=$1 and environment=$2 and schedule_id=$3 and revision=$4 and slot=$5 and attempt=$6",
        [...q, batch.slot, batch.attempt, runId],
      );
      return { status: "running", runId };
    } catch (error) {
      const code =
        error instanceof Error &&
        /^(context|source_policy|release|run)\.[a-z_.]+$/.test(error.message)
          ? error.message
          : "context.refresh_start_failed";
      await c.query(
        "update harness_control.context_refresh_batches set status='QUARANTINED',error_code=$7 where tenant_id=$1 and environment=$2 and schedule_id=$3 and revision=$4 and slot=$5 and attempt=$6",
        [...q, batch.slot, batch.attempt, code],
      );
      return { status: "quarantined", error: code };
    }
  });
}
/** Retry the exact oldest failed slot only; no arbitrary offset or checkpoint editing. */
export async function retryContextRefresh(
  db: Database,
  scope: ContextScope,
  id: string,
  expectedRevision: number,
) {
  return contextTransaction(db, scope, async (c) => {
    const p = [scope.tenantId, scope.environment, id];
    await c.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [
      JSON.stringify([...p, "refresh"]),
    ]);
    const head = await c.query<{
      revision: number;
      definition: ContextRefreshSchedule;
    }>(
      "select revision,definition from harness_control.context_refresh_schedules where tenant_id=$1 and environment=$2 and id=$3 order by revision desc limit 1",
      p,
    );
    const s = head.rows[0];
    if (!s || s.revision !== expectedRevision)
      throw new ContextSetupError("context.refresh_revision_conflict", 409);
    const q = [...p, expectedRevision];
    const r = await c.query<Batch>(
      "select * from harness_control.context_refresh_batches where tenant_id=$1 and environment=$2 and schedule_id=$3 and revision=$4 order by slot desc,attempt desc limit 1",
      q,
    );
    const b = r.rows[0];
    if (
      !b ||
      b.status !== "QUARANTINED" ||
      b.attempt >= s.definition.maxAttempts
    )
      throw new ContextSetupError("context.refresh_retry_unavailable", 409);
    await c.query(
      "insert into harness_control.context_refresh_batches(tenant_id,environment,schedule_id,revision,slot,attempt,status) values($1,$2,$3,$4,$5,$6,'PENDING')",
      [...q, b.slot, b.attempt + 1],
    );
    return { status: "retry_pending" };
  });
}
