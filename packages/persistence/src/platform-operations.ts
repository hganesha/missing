import type { Database } from "./index.js";

export async function recordWorkerHeartbeat(
  db: Database,
  input: {
    id: string;
    kind: "runtime-worker" | "integration-worker";
    concurrency: number;
    inFlight: number;
    lastSuccessAt: Date | null;
    state?: "ready" | "draining" | "stopped";
  },
) {
  await db.query(
    `insert into observability.worker_heartbeats(worker_id,kind,concurrency,in_flight,last_success_at,state)
    values($1,$2,$3,$4,$5,$6) on conflict(worker_id) do update set concurrency=excluded.concurrency,in_flight=excluded.in_flight,
    last_success_at=excluded.last_success_at,state=excluded.state,observed_at=now()`,
    [
      input.id,
      input.kind,
      input.concurrency,
      input.inFlight,
      input.lastSuccessAt,
      input.state ?? "ready",
    ],
  );
}

export async function getWorkerHealth(db: Database) {
  const result = await db.query<{
    kind: string;
    ready: number;
    stale: number;
    draining: number;
    in_flight: number;
    concurrency: number;
  }>(`select kind,
    count(*) filter(where state='ready' and observed_at>now()-interval '30 seconds' and (last_success_at>now()-interval '60 seconds' or in_flight>0))::integer as ready,
    count(*) filter(where observed_at<=now()-interval '30 seconds' or ((last_success_at is null or last_success_at<=now()-interval '60 seconds') and in_flight=0))::integer as stale,
    count(*) filter(where state='draining' and observed_at>now()-interval '30 seconds')::integer as draining,
    coalesce(sum(in_flight) filter(where observed_at>now()-interval '30 seconds'),0)::integer as in_flight,
    coalesce(sum(concurrency) filter(where observed_at>now()-interval '30 seconds'),0)::integer as concurrency
    from observability.worker_heartbeats where state<>'stopped' and observed_at>now()-interval '1 day' group by kind`);
  return result.rows;
}

export async function getRuntimeAdmission(db: Database, tenantId: string) {
  const result = await db.query<{
    accepting_runs: boolean;
    active_run_policy: string | null;
    reason: string | null;
    updated_at: Date;
    updated_by: string;
    revision: number;
  }>(
    "select accepting_runs,reason,updated_at,updated_by,revision,(select active_run_policy from harness_control.runtime_admission_events e where e.tenant_id=l.tenant_id and e.revision=l.revision) as active_run_policy from harness_control.runtime_lifecycle l where tenant_id=$1",
    [tenantId],
  );
  const row = result.rows[0];
  return {
    state: row?.accepting_runs === false ? "stopped" : "running",
    revision: row?.revision ?? 0,
    activeRunPolicy: row?.active_run_policy ?? null,
    reason: row?.reason ?? null,
    updatedAt: row?.updated_at.toISOString() ?? null,
    updatedBy: row?.updated_by ?? null,
  };
}

/** Shares the admission lock with createRun. Cancellation advances the existing fence;
 * a running invocation acknowledges cancellation through its normal lifecycle. */
export async function changeRuntimeAdmission(
  db: Database,
  input: {
    tenantId: string;
    actor: string;
    operation: "stop" | "resume";
    activeRunPolicy: "drain" | "cancel";
    reason: string;
    expectedRevision: number;
  },
) {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      input.tenantId,
    ]);
    const current = await getRuntimeAdmission(
      client as unknown as Database,
      input.tenantId,
    );
    if (current.revision !== input.expectedRevision)
      throw new Error("runtime.admission_revision_conflict");
    const revision = current.revision + 1;
    await client.query(
      `insert into harness_control.runtime_lifecycle(tenant_id,accepting_runs,reason,updated_by,revision)
      values($1,$2,$3,$4,$5) on conflict(tenant_id) do update set accepting_runs=excluded.accepting_runs,
      reason=excluded.reason,updated_by=excluded.updated_by,revision=excluded.revision,updated_at=now()`,
      [
        input.tenantId,
        input.operation === "resume",
        input.reason,
        input.actor,
        revision,
      ],
    );
    let cancellationRequests = 0;
    if (input.operation === "stop" && input.activeRunPolicy === "cancel") {
      const cancelled = await client.query(
        `update harness_runtime.runs set cancellation_requested_at=now(),cancellation_reason=$2,
        fencing_epoch=fencing_epoch+1,status=case when status='running' then status else 'cancelled' end,
        terminal_outcome=case when status='running' then terminal_outcome else 'cancelled' end,
        completed_at=case when status='running' then completed_at else now() end,
        lease_owner=case when status='running' then lease_owner else null end,
        lease_expires_at=case when status='running' then lease_expires_at else null end,updated_at=now()
        where tenant_id=$1 and status in ('queued','retrying','running') and cancellation_requested_at is null`,
        [input.tenantId, input.reason],
      );
      cancellationRequests = cancelled.rowCount ?? 0;
    }
    await client.query(
      `insert into harness_control.runtime_admission_events
      (tenant_id,revision,operation,active_run_policy,actor,reason,cancellation_requests) values($1,$2,$3,$4,$5,$6,$7)`,
      [
        input.tenantId,
        revision,
        input.operation,
        input.activeRunPolicy,
        input.actor,
        input.reason,
        cancellationRequests,
      ],
    );
    const admission = await getRuntimeAdmission(
      client as unknown as Database,
      input.tenantId,
    );
    await client.query("commit");
    return { ...admission, cancellationRequests };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

export async function getPlatformQueueState(db: Database, tenantId: string) {
  const result = await db.query<{
    ready: number;
    leased: number;
    retrying: number;
    stale: number;
  }>(
    `select
    count(*) filter(where status='queued')::integer as ready,
    count(*) filter(where status='running' and lease_expires_at>now())::integer as leased,
    count(*) filter(where status='retrying')::integer as retrying,
    count(*) filter(where status='running' and (lease_expires_at is null or lease_expires_at<=now()))::integer as stale
    from harness_runtime.runs where tenant_id=$1`,
    [tenantId],
  );
  return result.rows[0]!;
}
