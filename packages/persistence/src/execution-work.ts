import { randomUUID } from "node:crypto";
import {
  businessDecisionSchema,
  type BusinessDecision,
  humanWorkDecisionSchema,
  executionWorkItemSchema,
  stableDigest,
  type CaseActor,
  type ExecutionWorkItem,
  type HumanWorkDecision,
  type ExecutionWorkItemStatus,
} from "@ehf/contracts";
import type { Database } from "./index.js";

type QueryClient = {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }>;
  release?: () => void;
};

async function setTenantContext(client: QueryClient, tenantId: string): Promise<void> {
  await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
}

// Cross-tenant scheduler and dispatcher work (creating, scheduling, claiming and
// reconciling work items) is authorized by the connecting role's membership in
// ehf_workflow_controller (migration 035), not by a session setting a client could claim.

type WorkItemRow = {
  tenant_id: string;
  case_id: string;
  work_item_id: string;
  document: unknown;
  document_digest: string;
  revision: number;
  status: ExecutionWorkItemStatus;
  reason_code: string | null;
  ready_at: Date | string | null;
  deadline_at: Date | string | null;
  terminal_at: Date | string | null;
  dispatch_generation: number;
  dispatch_queue: string;
  dispatch_published_at: Date | string | null;
  broker_message_id: string | null;
  execution_id: string | null;
  lease_owner: string | null;
  lease_until: Date | string | null;
  fencing_epoch: string | number;
  attempt_number: number;
  result: ExecutionWorkItem["result"];
  transition_sequence: string | number;
  trace_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
  max_attempts: number;
  invalidation_policy: ExecutionWorkItem["invalidationPolicy"];
};

const terminalStatuses = new Set<ExecutionWorkItemStatus>(["COMPLETED", "CANCELLED", "EXPIRED", "FAILED"]);

const allowedTransitions: Readonly<Record<ExecutionWorkItemStatus, readonly ExecutionWorkItemStatus[]>> = {
  PROPOSED: ["BLOCKED", "READY", "CANCELLED", "EXPIRED"],
  BLOCKED: ["READY", "CANCELLED", "EXPIRED"],
  READY: ["LEASED", "BLOCKED", "CANCELLED", "EXPIRED", "SUSPENDED"],
  LEASED: ["RUNNING", "READY", "RETRY_SCHEDULED", "HUMAN_REQUIRED", "SUSPENDED", "FAILED", "CANCELLED", "EXPIRED"],
  RUNNING: ["COMPLETED", "PARTIAL", "RETRY_SCHEDULED", "REWORK_REQUIRED", "HUMAN_REQUIRED", "SUSPENDED", "CANCELLED", "FAILED", "EXPIRED"],
  PARTIAL: ["BLOCKED", "READY", "SUSPENDED", "CANCELLED", "EXPIRED"],
  RETRY_SCHEDULED: ["READY", "CANCELLED", "EXPIRED", "SUSPENDED", "FAILED"],
  REWORK_REQUIRED: ["BLOCKED", "READY", "CANCELLED", "EXPIRED", "FAILED"],
  HUMAN_REQUIRED: ["WAITING_HUMAN", "READY", "COMPLETED", "SUSPENDED", "CANCELLED", "EXPIRED"],
  WAITING_HUMAN: ["READY", "COMPLETED", "SUSPENDED", "CANCELLED", "EXPIRED"],
  SUSPENDED: ["BLOCKED", "READY", "CANCELLED", "EXPIRED", "FAILED"],
  COMPLETED: [],
  CANCELLED: [],
  EXPIRED: [],
  FAILED: [],
};

export function isExecutionWorkItemTransitionAllowed(
  from: ExecutionWorkItemStatus,
  to: ExecutionWorkItemStatus,
): boolean {
  return allowedTransitions[from].includes(to);
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function mapWorkItem(row: WorkItemRow): ExecutionWorkItem {
  const base = executionWorkItemSchema.parse(row.document);
  const activeLease = (row.status === "LEASED" || row.status === "RUNNING")
    && row.execution_id && row.lease_owner && row.lease_until;
  return executionWorkItemSchema.parse({
    ...base,
    revision: row.revision,
    status: row.status,
    reasonCode: row.reason_code,
    readyAt: iso(row.ready_at),
    deadlineAt: iso(row.deadline_at),
    terminalAt: iso(row.terminal_at),
    dispatch: {
      generation: row.dispatch_generation,
      queue: row.dispatch_queue,
      publishedAt: iso(row.dispatch_published_at),
      brokerMessageId: row.broker_message_id,
    },
    lease: activeLease ? {
      executionId: row.execution_id,
      owner: row.lease_owner,
      leaseUntil: iso(row.lease_until),
      fencingEpoch: Number(row.fencing_epoch),
      attemptNumber: row.attempt_number,
    } : null,
    result: row.result,
    transitionSequence: Number(row.transition_sequence),
    traceId: row.trace_id?.trim() ?? null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function workItemValues(item: ExecutionWorkItem, digest: string): unknown[] {
  return [
    item.tenantId, item.caseId, item.workItemId, JSON.stringify(item), digest,
    item.workType, item.capabilityId, item.assuranceClass, item.revision,
    item.caseSequenceBasis, item.planDigest, item.policyContextRef, item.schemaVersion,
    item.dependencyDigest, item.invalidationPolicy, item.status, item.reasonCode,
    item.priority, item.readyAt, item.deadlineAt, item.terminalAt,
    item.dispatch.generation, item.dispatch.queue, item.dispatch.publishedAt,
    item.dispatch.brokerMessageId, item.lease?.executionId ?? null,
    item.lease?.owner ?? null, item.lease?.leaseUntil ?? null,
    item.lease?.fencingEpoch ?? 0, item.lease?.attemptNumber ?? 0,
    item.limits.maxAttempts, item.limits.maxReworkCycles, item.limits.maxDurationMs,
    item.limits.maxCostUsd, item.limits.maxModelCalls, item.limits.maxCapabilityCalls,
    item.result ? JSON.stringify(item.result) : null, JSON.stringify(item.createdBy),
    item.transitionSequence, item.traceId, item.createdAt, item.updatedAt,
  ];
}

/**
 * Materialize a graph of node work in one transaction.
 *
 * Dependencies are deferred until commit so callers can supply nodes in any order.
 * Replaying the exact immutable documents is a no-op; reusing an ID with different
 * content is rejected instead of silently mutating already-authorized work.
 */
export async function createExecutionWorkItems(
  db: Database,
  inputs: readonly unknown[],
): Promise<{ created: number; workItems: ExecutionWorkItem[] }> {
  const items = inputs.map((input) => executionWorkItemSchema.parse(input));
  if (items.length === 0) return { created: 0, workItems: [] };
  const identity = new Set<string>();
  for (const item of items) {
    const key = `${item.tenantId}\0${item.workItemId}`;
    if (identity.has(key)) throw new Error("workflow.work_item_duplicate_in_batch");
    identity.add(key);
    if ((item.status === "LEASED" || item.status === "RUNNING") !== Boolean(item.lease)) {
      throw new Error("workflow.work_item_lease_state_invalid");
    }
    if (terminalStatuses.has(item.status) !== Boolean(item.terminalAt)) {
      throw new Error("workflow.work_item_terminal_time_invalid");
    }
  }
  const client = await db.connect() as unknown as QueryClient;
  let created = 0;
  const rows: WorkItemRow[] = [];
  try {
    await client.query("begin");
    await client.query("set constraints all deferred");
    for (const item of items) {
      const digest = stableDigest(item);
      const inserted = await client.query<WorkItemRow>(`
        insert into workflow.work_items(
          tenant_id, case_id, work_item_id, document, document_digest,
          work_type, capability_id, assurance_class, revision, case_sequence_basis,
          plan_digest, policy_context_ref, schema_version, dependency_digest,
          invalidation_policy, status, reason_code, priority, ready_at, deadline_at,
          terminal_at, dispatch_generation, dispatch_queue, dispatch_published_at,
          broker_message_id, execution_id, lease_owner, lease_until, fencing_epoch,
          attempt_number, max_attempts, max_rework_cycles, max_duration_ms,
          max_cost_usd, max_model_calls, max_capability_calls, result, created_by,
          transition_sequence, trace_id, created_at, updated_at
        ) values (
          $1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
          $19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,
          $37::jsonb,$38::jsonb,$39,$40,$41,$42
        ) on conflict (tenant_id, work_item_id) do nothing
        returning *
      `, workItemValues(item, digest));
      let row = inserted.rows[0];
      if (row) {
        created += 1;
        await client.query(`
          insert into workflow.work_item_transitions(
            tenant_id, case_id, work_item_id, transition_sequence, from_status,
            to_status, revision, reason_code, actor, input_digest, occurred_at
          ) values ($1,$2,$3,$4,null,$5,$6,$7,$8::jsonb,$9,$10)
        `, [item.tenantId, item.caseId, item.workItemId, item.transitionSequence,
          item.status, item.revision, item.reasonCode ?? "workflow.materialized",
          JSON.stringify(item.createdBy), digest, item.createdAt]);
        for (const dependencyId of new Set(item.dependencyIds)) {
          await client.query(`
            insert into workflow.work_item_dependencies(tenant_id, case_id, work_item_id, dependency_id)
            values ($1,$2,$3,$4) on conflict do nothing
          `, [item.tenantId, item.caseId, item.workItemId, dependencyId]);
        }
        if (item.deadlineAt) {
          await client.query(`
            insert into workflow.durable_timers(tenant_id, case_id, work_item_id, purpose, target_revision, due_at)
            values ($1,$2,$3,'DEADLINE',$4,$5) on conflict do nothing
          `, [item.tenantId, item.caseId, item.workItemId, item.revision, item.deadlineAt]);
        }
      } else {
        const existing = await client.query<WorkItemRow>(`
          select * from workflow.work_items where tenant_id=$1 and work_item_id=$2 for update
        `, [item.tenantId, item.workItemId]);
        row = existing.rows[0];
        if (!row || row.document_digest !== digest) throw new Error("workflow.work_item_idempotency_conflict");
      }
      rows.push(row);
    }
    await client.query("commit");
    return { created, workItems: rows.map(mapWorkItem) };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release?.();
  }
}

export async function createExecutionWorkItem(
  db: Database,
  input: unknown,
): Promise<{ created: boolean; workItem: ExecutionWorkItem }> {
  const result = await createExecutionWorkItems(db, [input]);
  return { created: result.created === 1, workItem: result.workItems[0]! };
}

export async function getExecutionWorkItem(
  db: Database,
  tenantId: string,
  workItemId: string,
): Promise<ExecutionWorkItem | null> {
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin");
    await setTenantContext(client, tenantId);
    const result = await client.query<WorkItemRow>(
      "select * from workflow.work_items where tenant_id=$1 and work_item_id=$2",
      [tenantId, workItemId],
    );
    await client.query("commit");
    return result.rows[0] ? mapWorkItem(result.rows[0]) : null;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release?.();
  }
}

type TransitionOptions = {
  expectedFencingEpoch?: number;
  expectedExecutionId?: string;
  readyAt?: string | null;
  result?: ExecutionWorkItem["result"];
  resultDigest?: string | null;
  clearLease?: boolean;
  bumpFence?: boolean;
};

async function transitionLocked(
  client: QueryClient,
  row: WorkItemRow,
  to: ExecutionWorkItemStatus,
  reasonCode: string,
  actor: CaseActor,
  options: TransitionOptions = {},
): Promise<WorkItemRow> {
  if (!isExecutionWorkItemTransitionAllowed(row.status, to)) {
    throw new Error(`workflow.transition_invalid:${row.status}:${to}`);
  }
  if (options.expectedFencingEpoch !== undefined && Number(row.fencing_epoch) !== options.expectedFencingEpoch) {
    throw new Error("workflow.stale_fence");
  }
  if (options.expectedExecutionId !== undefined && row.execution_id !== options.expectedExecutionId) {
    throw new Error("workflow.stale_execution");
  }
  if (options.expectedExecutionId !== undefined) {
    // Holding the row lock prevents a new owner; DB wall time still decides expiry.
    // An epoch alone is insufficient before the reconciler has fenced an expired owner.
    const live = await client.query<{ active: boolean }>(`select
      lease_until > clock_timestamp() and cancellation_requested_at is null
      and (deadline_at is null or deadline_at > clock_timestamp()) as active
      from workflow.work_items where tenant_id=$1 and work_item_id=$2`, [row.tenant_id, row.work_item_id]);
    if (live.rows[0]?.active !== true) throw new Error("workflow.lease_expired");
  }
  const nextRevision = row.revision + 1;
  const nextSequence = Number(row.transition_sequence) + 1;
  const terminal = terminalStatuses.has(to);
  const result = options.result === undefined ? row.result : options.result;
  const inputDigest = stableDigest({
    tenantId: row.tenant_id, workItemId: row.work_item_id, from: row.status, to,
    revision: nextRevision, reasonCode, fence: Number(row.fencing_epoch), result,
  });
  const updated = await client.query<WorkItemRow>(`
    update workflow.work_items
    set status=$3, reason_code=$4, revision=$5, transition_sequence=$6,
        ready_at=case when $7::boolean then $8::timestamptz else ready_at end,
        terminal_at=case when $9::boolean then transaction_timestamp() else null end,
        result=case when $10::boolean then $11::jsonb else result end,
        result_digest=case when $10::boolean then $12 else result_digest end,
        completed_execution_id=case when $9::boolean then execution_id else completed_execution_id end,
        execution_id=case when $13::boolean then null else execution_id end,
        lease_owner=case when $13::boolean then null else lease_owner end,
        lease_until=case when $13::boolean then null else lease_until end,
        fencing_epoch=fencing_epoch + case when $14::boolean then 1 else 0 end,
        suspended_at=case when $3='SUSPENDED' then transaction_timestamp() else suspended_at end,
        updated_at=transaction_timestamp()
    where tenant_id=$1 and work_item_id=$2
    returning *
  `, [row.tenant_id, row.work_item_id, to, reasonCode, nextRevision, nextSequence,
    options.readyAt !== undefined, options.readyAt ?? null, terminal,
    options.result !== undefined, result ? JSON.stringify(result) : null,
    options.resultDigest ?? (result ? stableDigest(result) : null),
    options.clearLease ?? terminal, options.bumpFence ?? false]);
  const next = updated.rows[0];
  if (!next) throw new Error("workflow.transition_lost");
  await client.query(`
    insert into workflow.work_item_transitions(
      tenant_id, case_id, work_item_id, transition_sequence, from_status,
      to_status, revision, reason_code, actor, input_digest
    ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
  `, [row.tenant_id, row.case_id, row.work_item_id, nextSequence, row.status, to,
    nextRevision, reasonCode, JSON.stringify(actor), inputDigest]);
  return next;
}

export type DispatchIntent = {
  tenantId: string;
  caseId: string;
  workItemId: string;
  generation: number;
  queue: string;
  messageId: string;
};

/** Create generation-specific durable dispatch intents without doing broker I/O. */
export async function scheduleExecutionWork(
  db: Database,
  batchSize = 100,
  scope?: {tenantId:string;workItemId:string},
): Promise<DispatchIntent[]> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new Error("workflow.scheduler_batch_invalid");
  }
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin");
    const selected = await client.query<WorkItemRow>(`
      select work.*
      from workflow.work_items work
      where work.status='READY'
        ${scope ? 'and work.tenant_id=$2 and work.work_item_id=$3' : ''}
        and (work.ready_at is null or work.ready_at <= transaction_timestamp())
        and (work.deadline_at is null or work.deadline_at > transaction_timestamp())
        and not exists (
          select 1 from workflow.dispatch_outbox dispatch
          where dispatch.tenant_id=work.tenant_id and dispatch.work_item_id=work.work_item_id
            and dispatch.dispatch_generation=work.dispatch_generation
            and dispatch.status in ('PENDING','PUBLISHED')
        )
      order by work.priority desc, work.deadline_at nulls last, work.ready_at nulls first,
        work.updated_at, work.work_item_id
      for update of work skip locked
      limit $1
    `, scope ? [batchSize,scope.tenantId,scope.workItemId] : [batchSize]);
    const intents: DispatchIntent[] = [];
    for (const row of selected.rows) {
      const generation = row.dispatch_generation + 1;
      const messageId = `${row.tenant_id}:${row.work_item_id}:${generation}`;
      await client.query(`
        update workflow.work_items
        set dispatch_generation=$3, dispatch_published_at=null, broker_message_id=null,
            revision=revision+1, updated_at=transaction_timestamp()
        where tenant_id=$1 and work_item_id=$2 and status='READY'
      `, [row.tenant_id, row.work_item_id, generation]);
      await client.query(`
        insert into workflow.dispatch_outbox(
          tenant_id, case_id, work_item_id, dispatch_generation, queue, message_id
        ) values ($1,$2,$3,$4,$5,$6) on conflict do nothing
      `, [row.tenant_id, row.case_id, row.work_item_id, generation, row.dispatch_queue, messageId]);
      intents.push({ tenantId: row.tenant_id, caseId: row.case_id, workItemId: row.work_item_id,
        generation, queue: row.dispatch_queue, messageId });
    }
    await client.query("commit");
    return intents;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release?.();
  }
}

/** Claim outbox sends briefly; failure to acknowledge makes them eligible again. */
export async function claimExecutionDispatches(
  db: Database,
  batchSize = 100,
  retryAfterSeconds = 30,
): Promise<DispatchIntent[]> {
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin");
    const result = await client.query<{
    tenant_id: string; case_id: string; work_item_id: string; dispatch_generation: number;
    queue: string; message_id: string;
  }>(`
    with claimed as (
      select tenant_id, work_item_id, dispatch_generation
      from workflow.dispatch_outbox
      where status='PENDING' and available_at <= transaction_timestamp()
      order by available_at, tenant_id, work_item_id
      for update skip locked limit $1
    )
    update workflow.dispatch_outbox dispatch
    set publish_attempts=publish_attempts+1,
        available_at=transaction_timestamp() + make_interval(secs => $2)
    from claimed
    where dispatch.tenant_id=claimed.tenant_id
      and dispatch.work_item_id=claimed.work_item_id
      and dispatch.dispatch_generation=claimed.dispatch_generation
    returning dispatch.tenant_id, dispatch.case_id, dispatch.work_item_id,
      dispatch.dispatch_generation, dispatch.queue, dispatch.message_id
    `, [batchSize, retryAfterSeconds]);
    await client.query("commit");
    return result.rows.map((row) => ({ tenantId: row.tenant_id, caseId: row.case_id,
      workItemId: row.work_item_id, generation: row.dispatch_generation,
      queue: row.queue, messageId: row.message_id }));
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release?.();
  }
}

export async function acknowledgeExecutionDispatch(
  db: Database,
  intent: DispatchIntent,
  brokerMessageId: string,
): Promise<boolean> {
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin");
    const acknowledged = await client.query(`
      update workflow.dispatch_outbox
      set status='PUBLISHED', published_at=transaction_timestamp(), broker_message_id=$4
      where tenant_id=$1 and work_item_id=$2 and dispatch_generation=$3
        and status in ('PENDING','PUBLISHED')
    `, [intent.tenantId, intent.workItemId, intent.generation, brokerMessageId]);
    await client.query(`
      update workflow.work_items work
      set dispatch_published_at=transaction_timestamp(), broker_message_id=$4,
          updated_at=transaction_timestamp()
      where tenant_id=$1 and work_item_id=$2 and dispatch_generation=$3
    `, [intent.tenantId, intent.workItemId, intent.generation, brokerMessageId]);
    await client.query("commit");
    return (acknowledged.rowCount ?? 0) === 1;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release?.();
  }
}

/**
 * Local PostgreSQL transport: publication state and NOTIFY commit atomically.
 *
 * This closes the otherwise unavoidable race where a consumer observes the notification
 * before the outbox row is marked PUBLISHED and therefore cannot acquire its lease.
 */
export async function publishPostgresExecutionDispatch(
  db: Database,
  intent: DispatchIntent,
): Promise<boolean> {
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin");
    const published = await client.query(`
      update workflow.dispatch_outbox
      set status='PUBLISHED', published_at=transaction_timestamp(), broker_message_id=message_id
      where tenant_id=$1 and work_item_id=$2 and dispatch_generation=$3 and status='PENDING'
    `, [intent.tenantId, intent.workItemId, intent.generation]);
    if ((published.rowCount ?? 0) === 1) {
      await client.query(`
        update workflow.work_items
        set dispatch_published_at=transaction_timestamp(), broker_message_id=$4,
            updated_at=transaction_timestamp()
        where tenant_id=$1 and work_item_id=$2 and dispatch_generation=$3
      `, [intent.tenantId, intent.workItemId, intent.generation, intent.messageId]);
      await client.query("select pg_notify('harness_execution_work', $1)", [JSON.stringify(intent)]);
    }
    await client.query("commit");
    return (published.rowCount ?? 0) === 1;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release?.();
  }
}

export type LeaseAcquisition =
  | { outcome: "acquired" | "replayed"; workItem: ExecutionWorkItem }
  | { outcome: "not_eligible" | "stale_generation" | "terminal" | "not_found"; workItem: ExecutionWorkItem | null };

/** Atomically acquire a generation-specific application lease and fencing epoch. */
export async function acquireExecutionWorkItemLease(
  db: Database,
  input: {
    tenantId: string; workItemId: string; generation: number; executionId?: string;
    owner: string; leaseSeconds: number; actor: CaseActor;
  },
): Promise<LeaseAcquisition> {
  if (!Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 1) throw new Error("workflow.lease_duration_invalid");
  const executionId = input.executionId ?? `EXEC-${randomUUID()}`;
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin");
    await setTenantContext(client, input.tenantId);
    const selected = await client.query<WorkItemRow>(`
      select * from workflow.work_items where tenant_id=$1 and work_item_id=$2 for update
    `, [input.tenantId, input.workItemId]);
    const row = selected.rows[0];
    if (!row) {
      await client.query("commit");
      return { outcome: "not_found", workItem: null };
    }
    if (terminalStatuses.has(row.status)) {
      await client.query("commit");
      return { outcome: "terminal", workItem: mapWorkItem(row) };
    }
    if ((row.status === "LEASED" || row.status === "RUNNING") && row.execution_id === executionId) {
      await client.query("commit");
      return { outcome: "replayed", workItem: mapWorkItem(row) };
    }
    if (row.dispatch_generation !== input.generation) {
      await client.query("commit");
      return { outcome: "stale_generation", workItem: mapWorkItem(row) };
    }
    if (row.status !== "READY" || row.attempt_number >= row.max_attempts) {
      await client.query("commit");
      return { outcome: "not_eligible", workItem: mapWorkItem(row) };
    }
    const nextRevision = row.revision + 1;
    const nextSequence = Number(row.transition_sequence) + 1;
    const updated = await client.query<WorkItemRow>(`
      update workflow.work_items work
      set status='LEASED', reason_code='workflow.lease_acquired', revision=$4,
          transition_sequence=$5, execution_id=$6, lease_owner=$7,
          lease_until=transaction_timestamp() + make_interval(secs => $8),
          fencing_epoch=fencing_epoch+1, attempt_number=attempt_number+1,
          updated_at=transaction_timestamp()
      where work.tenant_id=$1 and work.work_item_id=$2 and work.dispatch_generation=$3 and work.status='READY'
        and (work.ready_at is null or work.ready_at <= transaction_timestamp())
        and (work.deadline_at is null or work.deadline_at > transaction_timestamp())
        and exists (
          select 1 from workflow.dispatch_outbox dispatch
          where dispatch.tenant_id=work.tenant_id
            and dispatch.work_item_id=work.work_item_id
            and dispatch.dispatch_generation=work.dispatch_generation
            and dispatch.status='PUBLISHED'
        )
      returning *
    `, [input.tenantId, input.workItemId, input.generation, nextRevision, nextSequence,
      executionId, input.owner, input.leaseSeconds]);
    const next = updated.rows[0];
    if (!next) {
      await client.query("commit");
      return { outcome: "not_eligible", workItem: mapWorkItem(row) };
    }
    await client.query(`
      update workflow.dispatch_outbox set status='CONSUMED'
      where tenant_id=$1 and work_item_id=$2 and dispatch_generation=$3 and status='PUBLISHED'
    `, [input.tenantId, input.workItemId, input.generation]);
    await client.query(`
      insert into workflow.work_item_transitions(
        tenant_id, case_id, work_item_id, transition_sequence, from_status,
        to_status, revision, reason_code, actor, input_digest
      ) values ($1,$2,$3,$4,'READY','LEASED',$5,'workflow.lease_acquired',$6::jsonb,$7)
    `, [row.tenant_id, row.case_id, row.work_item_id, nextSequence, nextRevision,
      JSON.stringify(input.actor), stableDigest({ generation: input.generation, executionId,
        owner: input.owner, fencingEpoch: Number(next.fencing_epoch) })]);
    await client.query("commit");
    return { outcome: "acquired", workItem: mapWorkItem(next) };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release?.();
  }
}

export async function startExecutionWorkItem(
  db: Database,
  input: { tenantId: string; workItemId: string; executionId: string; fencingEpoch: number; actor: CaseActor },
): Promise<ExecutionWorkItem> {
  return fencedTransition(db, input, "RUNNING", "workflow.execution_started");
}

export async function renewExecutionWorkItemLease(
  db: Database,
  input: { tenantId: string; workItemId: string; executionId: string; fencingEpoch: number; leaseSeconds: number },
): Promise<boolean> {
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin");
    await setTenantContext(client, input.tenantId);
    const result = await client.query(`
      update workflow.work_items
      set lease_until=transaction_timestamp() + make_interval(secs => $5), updated_at=transaction_timestamp()
      where tenant_id=$1 and work_item_id=$2 and execution_id=$3 and fencing_epoch=$4
        and status in ('LEASED','RUNNING') and cancellation_requested_at is null
        and lease_until > clock_timestamp() and (deadline_at is null or deadline_at > clock_timestamp())
    `, [input.tenantId, input.workItemId, input.executionId, input.fencingEpoch, input.leaseSeconds]);
    await client.query("commit");
    return (result.rowCount ?? 0) === 1;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release?.();
  }
}

async function fencedTransition(
  db: Database,
  input: { tenantId: string; workItemId: string; executionId: string; fencingEpoch: number; actor: CaseActor },
  to: ExecutionWorkItemStatus,
  reasonCode: string,
  options: TransitionOptions = {},
): Promise<ExecutionWorkItem> {
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin");
    await setTenantContext(client, input.tenantId);
    const selected = await client.query<WorkItemRow>(
      "select * from workflow.work_items where tenant_id=$1 and work_item_id=$2 for update",
      [input.tenantId, input.workItemId],
    );
    const row = selected.rows[0];
    if (!row) throw new Error("workflow.work_item_not_found");
    const next = await transitionLocked(client, row, to, reasonCode, input.actor, {
      ...options, expectedExecutionId: input.executionId, expectedFencingEpoch: input.fencingEpoch,
    });
    await client.query("commit");
    return mapWorkItem(next);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release?.();
  }
}

export async function completeExecutionWorkItem(
  db: Database,
  input: {
    tenantId: string; workItemId: string; executionId: string; fencingEpoch: number;
    result: NonNullable<ExecutionWorkItem["result"]>; actor: CaseActor;
    output?: unknown;
  },
): Promise<{ replayed: boolean; workItem: ExecutionWorkItem }> {
  const resultDigest = stableDigest(input.result);
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin");
    await setTenantContext(client, input.tenantId);
    const selected = await client.query<WorkItemRow & { completed_execution_id: string | null; result_digest: string | null }>(
      "select * from workflow.work_items where tenant_id=$1 and work_item_id=$2 for update",
      [input.tenantId, input.workItemId],
    );
    const row = selected.rows[0];
    if (!row) throw new Error("workflow.work_item_not_found");
    if (row.status === "COMPLETED") {
      if (row.completed_execution_id !== input.executionId || row.result_digest !== resultDigest) {
        throw new Error("workflow.completion_idempotency_conflict");
      }
      await client.query("commit");
      return { replayed: true, workItem: mapWorkItem(row) };
    }
    const next = await transitionLocked(client, row, "COMPLETED", "workflow.execution_completed", input.actor, {
      expectedExecutionId: input.executionId, expectedFencingEpoch: input.fencingEpoch,
      result: input.result, resultDigest, clearLease: true,
    });
    if (input.output !== undefined) {
      await client.query(`insert into workflow.node_outputs(tenant_id, work_item_id, output, output_digest)
        values ($1,$2,$3::jsonb,$4) on conflict (tenant_id,work_item_id) do nothing`,
      [input.tenantId, input.workItemId, JSON.stringify(input.output), stableDigest(input.output)]);
    }
    await client.query("commit");
    return { replayed: false, workItem: mapWorkItem(next) };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release?.();
  }
}

export async function getExecutionOutput(db: Database, tenantId: string, workItemId: string): Promise<unknown> {
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin");
    await setTenantContext(client, tenantId);
    const result = await client.query<{ output: unknown; output_digest: string }>(`select output, output_digest from workflow.node_outputs
      where tenant_id=$1 and work_item_id=$2`, [tenantId, workItemId]);
    await client.query("commit");
    const row = result.rows[0];
    if (!row || stableDigest(row.output) !== row.output_digest) throw new Error("workflow.output_missing_or_corrupt");
    return row.output;
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release?.(); }
}

export async function requestHumanExecutionDecision(db: Database, input: {
  tenantId: string; workItemId: string; executionId: string; fencingEpoch: number; actor: CaseActor;
  parent?: { runId: string; workerId: string; fencingEpoch: number };
  policyDecision?: BusinessDecision;
}): Promise<ExecutionWorkItem> {
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin");
    await setTenantContext(client, input.tenantId);
    const selected = await client.query<WorkItemRow>("select * from workflow.work_items where tenant_id=$1 and work_item_id=$2 for update", [input.tenantId, input.workItemId]);
    const row = selected.rows[0];
    if (!row) throw new Error("workflow.work_item_not_found");
    if (input.parent) {
      const parent = await client.query(`update harness_runtime.runs set status='manual_review',
        terminal_outcome='workflow.human_decision_required', error_code='workflow.human_decision_required',
        lease_owner=null, lease_expires_at=null, completed_at=now(), updated_at=now()
        where tenant_id=$1 and run_id=$2 and lease_owner=$3 and fencing_epoch=$4 and status='running' returning run_id`,
      [input.tenantId, input.parent.runId, input.parent.workerId, input.parent.fencingEpoch]);
      if (!parent.rows.length) throw new Error("runtime.stale_fence");
    }
    if (input.policyDecision) {
      const decision = businessDecisionSchema.parse(input.policyDecision);
      const { receiptDigest, ...unsigned } = decision;
      const work = mapWorkItem(row);
      if (stableDigest(unsigned) !== receiptDigest || decision.result.state !== "NEEDS_HUMAN"
        || decision.tenantId !== work.tenantId || decision.caseId !== work.caseId || decision.planDigest !== work.planDigest)
        throw new Error("policy.human_work_scope_mismatch");
      await client.query(`insert into workflow.policy_human_requirements(tenant_id,case_id,work_item_id,decision_id,decision)
        values($1,$2,$3,$4,$5::jsonb) on conflict(tenant_id,work_item_id) do update set decision_id=excluded.decision_id,decision=excluded.decision`,
      [row.tenant_id,row.case_id,row.work_item_id,decision.decisionId,JSON.stringify(decision)]);
    }
    const next = await transitionLocked(client, row, "HUMAN_REQUIRED", "workflow.human_decision_required", input.actor,
      { clearLease: true, expectedExecutionId: input.executionId, expectedFencingEpoch: input.fencingEpoch });
    const constraints = executionWorkItemSchema.parse(row.document).constraints as Record<string, unknown>;
    const configuredDelay = input.policyDecision?.result.humanRequirement
      ? Math.max(0,Date.parse(input.policyDecision.evaluatedAt)+input.policyDecision.result.humanRequirement.ttlSeconds*1000-Date.now())
      : Number(constraints.humanEscalationAfterMs ?? 86_400_000);
    const escalationAfterMs = Number.isFinite(configuredDelay) && configuredDelay >= (input.policyDecision ? 0 : 60_000)
      ? Math.min(configuredDelay, 30 * 86_400_000)
      : 86_400_000;
    await client.query(`
      insert into workflow.durable_timers(tenant_id, case_id, work_item_id, purpose, target_revision, due_at)
      values ($1,$2,$3,'HUMAN_ESCALATION',$4,
        least(coalesce($5::timestamptz, 'infinity'::timestamptz), transaction_timestamp() + make_interval(secs => $6)))
      on conflict do nothing
    `, [row.tenant_id, row.case_id, row.work_item_id, next.revision, row.deadline_at, escalationAfterMs / 1000]);
    await client.query("commit");
    return mapWorkItem(next);
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release?.(); }
}

export async function retryExecutionWorkItem(
  db: Database,
  input: {
    tenantId: string; workItemId: string; executionId: string; fencingEpoch: number;
    backoffMs: number; reasonCode: string; actor: CaseActor;
  },
): Promise<ExecutionWorkItem> {
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin");
    await setTenantContext(client, input.tenantId);
    const selected = await client.query<WorkItemRow>(
      "select * from workflow.work_items where tenant_id=$1 and work_item_id=$2 for update",
      [input.tenantId, input.workItemId],
    );
    const row = selected.rows[0];
    if (!row) throw new Error("workflow.work_item_not_found");
    if (row.attempt_number >= row.max_attempts) {
      const failed = await transitionLocked(client, row, "FAILED", "workflow.attempts_exhausted", input.actor, {
        expectedExecutionId: input.executionId, expectedFencingEpoch: input.fencingEpoch, clearLease: true,
      });
      await client.query("commit");
      return mapWorkItem(failed);
    }
    const due = await client.query<{ due_at: Date | string }>(
      "select transaction_timestamp() + make_interval(secs => $1) as due_at",
      [Math.max(0, input.backoffMs) / 1000],
    );
    const dueAt = iso(due.rows[0]!.due_at)!;
    const next = await transitionLocked(client, row, "RETRY_SCHEDULED", input.reasonCode, input.actor, {
      expectedExecutionId: input.executionId, expectedFencingEpoch: input.fencingEpoch,
      readyAt: dueAt, clearLease: true,
    });
    await client.query(`
      insert into workflow.durable_timers(tenant_id, case_id, work_item_id, purpose, target_revision, due_at)
      values ($1,$2,$3,'RETRY_ELIGIBLE',$4,$5) on conflict do nothing
    `, [row.tenant_id, row.case_id, row.work_item_id, next.revision, dueAt]);
    await client.query("commit");
    return mapWorkItem(next);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release?.();
  }
}

export async function cancelExecutionWorkItem(
  db: Database,
  input: { tenantId: string; workItemId: string; reason: string; actor: CaseActor },
): Promise<{ replayed: boolean; workItem: ExecutionWorkItem }> {
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin");
    await setTenantContext(client, input.tenantId);
    const selected = await client.query<WorkItemRow>(
      "select * from workflow.work_items where tenant_id=$1 and work_item_id=$2 for update",
      [input.tenantId, input.workItemId],
    );
    const row = selected.rows[0];
    if (!row) throw new Error("workflow.work_item_not_found");
    if (row.status === "CANCELLED") {
      await client.query("commit");
      return { replayed: true, workItem: mapWorkItem(row) };
    }
    if (terminalStatuses.has(row.status)) throw new Error("workflow.work_item_terminal");
    await client.query(`
      update workflow.work_items set cancellation_requested_at=transaction_timestamp(), cancellation_reason=$3
      where tenant_id=$1 and work_item_id=$2
    `, [input.tenantId, input.workItemId, input.reason]);
    const next = await transitionLocked(client, row, "CANCELLED", "workflow.cancelled", input.actor,
      { clearLease: true, bumpFence: true });
    await client.query(`
      update workflow.durable_timers set status='CANCELLED'
      where tenant_id=$1 and work_item_id=$2 and status='PENDING'
    `, [input.tenantId, input.workItemId]);
    await client.query("commit");
    return { replayed: false, workItem: mapWorkItem(next) };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release?.();
  }
}

export async function suspendExecutionWorkItem(
  db: Database,
  input: { tenantId: string; workItemId: string; reasonCode: string; actor: CaseActor },
): Promise<{ replayed: boolean; workItem: ExecutionWorkItem }> {
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin");
    await setTenantContext(client, input.tenantId);
    const selected = await client.query<WorkItemRow>(
      "select * from workflow.work_items where tenant_id=$1 and work_item_id=$2 for update",
      [input.tenantId, input.workItemId],
    );
    const row = selected.rows[0];
    if (!row) throw new Error("workflow.work_item_not_found");
    if (row.status === "SUSPENDED") {
      await client.query("commit");
      return { replayed: true, workItem: mapWorkItem(row) };
    }
    const next = await transitionLocked(client, row, "SUSPENDED", input.reasonCode, input.actor, {
      clearLease: true,
      bumpFence: row.status === "LEASED" || row.status === "RUNNING",
    });
    await client.query("commit");
    return { replayed: false, workItem: mapWorkItem(next) };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release?.();
  }
}

/** Resume through BLOCKED so dependencies are always re-evaluated before dispatch. */
export async function resumeExecutionWorkItem(
  db: Database,
  input: { tenantId: string; workItemId: string; reasonCode: string; actor: CaseActor },
): Promise<{ replayed: boolean; workItem: ExecutionWorkItem }> {
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin");
    await setTenantContext(client, input.tenantId);
    const selected = await client.query<WorkItemRow>(
      "select * from workflow.work_items where tenant_id=$1 and work_item_id=$2 for update",
      [input.tenantId, input.workItemId],
    );
    const row = selected.rows[0];
    if (!row) throw new Error("workflow.work_item_not_found");
    if (row.status === "BLOCKED") {
      await client.query("commit");
      return { replayed: true, workItem: mapWorkItem(row) };
    }
    if (row.status !== "SUSPENDED") throw new Error("workflow.work_item_not_suspended");
    const next = await transitionLocked(client, row, "BLOCKED", input.reasonCode, input.actor, { clearLease: true });
    await client.query("commit");
    return { replayed: false, workItem: mapWorkItem(next) };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release?.();
  }
}

export type ReconciliationDecision =
  | { to: ExecutionWorkItemStatus; reasonCode: string }
  | null;

/** Pure kernel decision used by the sweeper and deterministic fault-boundary tests. */
export function decideExecutionWorkItemReconciliation(input: {
  status: ExecutionWorkItemStatus;
  dependencyStatuses?: readonly ExecutionWorkItemStatus[];
  invalidationPolicy: ExecutionWorkItem["invalidationPolicy"];
  deadlinePassed: boolean;
  leaseExpired: boolean;
  attemptsExhausted: boolean;
}): ReconciliationDecision {
  if (terminalStatuses.has(input.status)) return null;
  if (input.deadlinePassed) return { to: "EXPIRED", reasonCode: "workflow.deadline_expired" };
  if (input.leaseExpired && input.status === "RUNNING") {
    return { to: "SUSPENDED", reasonCode: "workflow.effect_reconciliation_required" };
  }
  if (input.leaseExpired && input.status === "LEASED") {
    return input.attemptsExhausted
      ? { to: "FAILED", reasonCode: "workflow.attempts_exhausted" }
      : { to: "READY", reasonCode: "workflow.lease_expired_before_execution" };
  }
  if (input.status === "RETRY_SCHEDULED") return null;
  if (!["PROPOSED", "BLOCKED", "PARTIAL", "REWORK_REQUIRED"].includes(input.status)) return null;
  const dependencies = input.dependencyStatuses ?? [];
  if (dependencies.every((status) => status === "COMPLETED")) {
    return { to: "READY", reasonCode: "workflow.dependencies_satisfied" };
  }
  const invalid = dependencies.some((status) => terminalStatuses.has(status) && status !== "COMPLETED");
  if (invalid) {
    if (input.invalidationPolicy === "CANCEL") return { to: "CANCELLED", reasonCode: "workflow.dependency_cancelled" };
    if (input.invalidationPolicy === "REWORK" && input.status === "PARTIAL") {
      return { to: "REWORK_REQUIRED", reasonCode: "workflow.dependency_rework_required" };
    }
  }
  return input.status === "BLOCKED" ? null : { to: "BLOCKED", reasonCode: "workflow.dependencies_unsatisfied" };
}

const controllerActor: CaseActor = {
  type: "SYSTEM",
  principalId: "workflow-controller",
  roles: ["workflow.controller"],
};

/**
 * Recover deadlines, expired leases, delayed retries and dependency readiness.
 * Every repair is a normal, journaled state transition in the same transaction.
 */
export async function reconcileExecutionWorkItems(db: Database, batchSize = 100): Promise<number> {
  const client = await db.connect() as unknown as QueryClient;
  let changed = 0;
  try {
    await client.query("begin");
    const candidates = await client.query<WorkItemRow & {
      dependency_statuses: ExecutionWorkItemStatus[];
      deadline_passed: boolean;
      lease_expired: boolean;
      retry_due: boolean;
    }>(`
      select work.*,
        coalesce(array(
          select dependency.status
          from workflow.work_item_dependencies edge
          join workflow.work_items dependency
            on dependency.tenant_id=edge.tenant_id and dependency.work_item_id=edge.dependency_id
          where edge.tenant_id=work.tenant_id and edge.work_item_id=work.work_item_id
          order by edge.dependency_id
        ), '{}') as dependency_statuses,
        coalesce(work.deadline_at <= transaction_timestamp(), false) deadline_passed,
        coalesce(work.lease_until <= transaction_timestamp(), false) lease_expired,
        coalesce(work.ready_at <= transaction_timestamp(), false) retry_due
      from workflow.work_items work
      where work.status not in ('COMPLETED','CANCELLED','EXPIRED','FAILED')
        and (
          (work.deadline_at is not null and work.deadline_at <= transaction_timestamp())
          or (work.status in ('LEASED','RUNNING') and work.lease_until <= transaction_timestamp())
          or (work.status='RETRY_SCHEDULED' and work.ready_at <= transaction_timestamp())
          or work.status in ('PROPOSED','PARTIAL','REWORK_REQUIRED')
          -- A blocked item is a candidate only when its dependencies can now change it. Otherwise the
          -- blocked items of stalled runs fill every batch and newer work is never reached.
          or (work.status='BLOCKED' and (
            not exists (select 1 from workflow.work_item_dependencies edge
              join workflow.work_items dependency on dependency.tenant_id=edge.tenant_id and dependency.work_item_id=edge.dependency_id
              where edge.tenant_id=work.tenant_id and edge.work_item_id=work.work_item_id and dependency.status <> 'COMPLETED')
            or (work.invalidation_policy='CANCEL' and exists (select 1 from workflow.work_item_dependencies edge
              join workflow.work_items dependency on dependency.tenant_id=edge.tenant_id and dependency.work_item_id=edge.dependency_id
              where edge.tenant_id=work.tenant_id and edge.work_item_id=work.work_item_id and dependency.status in ('CANCELLED','EXPIRED','FAILED')))))
        )
      order by work.updated_at, work.work_item_id
      for update of work skip locked
      limit $1
    `, [batchSize]);
    for (const row of candidates.rows) {
      const retryDue = row.status === "RETRY_SCHEDULED" && row.retry_due;
      const decision = retryDue
        ? { to: "READY" as const, reasonCode: "workflow.retry_timer_fired" }
        : decideExecutionWorkItemReconciliation({
          status: row.status,
          dependencyStatuses: row.dependency_statuses,
          invalidationPolicy: row.invalidation_policy,
          deadlinePassed: row.deadline_passed,
          leaseExpired: row.lease_expired,
          attemptsExhausted: row.attempt_number >= row.max_attempts,
        });
      if (!decision || decision.to === row.status) continue;
      const expiredRunning = row.status === "RUNNING" && decision.to === "SUSPENDED";
      const invalidatesActiveLease = row.status === "LEASED" || row.status === "RUNNING";
      await transitionLocked(client, row, decision.to, decision.reasonCode, controllerActor, {
        clearLease: decision.to !== "RUNNING", bumpFence: invalidatesActiveLease,
      });
      if (expiredRunning) {
        await client.query(`
          insert into workflow.reconciliation_cases(
            tenant_id, case_id, work_item_id, fencing_epoch, category, reason_code, details
          ) values ($1,$2,$3,$4,'UNKNOWN_EFFECT',$5,$6::jsonb) on conflict do nothing
        `, [row.tenant_id, row.case_id, row.work_item_id, row.fencing_epoch,
          decision.reasonCode, JSON.stringify({ executionId: row.execution_id })]);
      }
      changed += 1;
    }
    await client.query(`
      update workflow.durable_timers timer set status='FIRED', fired_at=transaction_timestamp()
      from workflow.work_items work
      where timer.tenant_id=work.tenant_id and timer.work_item_id=work.work_item_id
        and timer.status='PENDING' and timer.due_at <= transaction_timestamp()
        and (timer.target_revision <= work.revision or work.status in ('COMPLETED','CANCELLED','EXPIRED','FAILED'))
    `);
    await client.query("commit");
    return changed;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release?.();
  }
}

export type HumanQueueItem = {
  workItem: ExecutionWorkItem;
  overdue: boolean;
  escalated: boolean;
  assignedTo: string[];
  decisions: HumanWorkDecision[];
  policyDecision?: BusinessDecision;
  policyRequestDigest?: string;
  requiredApprovals: number;
};

type HumanDecisionRow = {
  decision_id: string; tenant_id: string; case_id: string; work_item_id: string;
  principal_id: string; decision: HumanWorkDecision["decision"]; reason_code: string;
  rationale: string; evidence_refs: string[]; decided_at: Date | string;
};

function mapHumanDecision(row: HumanDecisionRow): HumanWorkDecision {
  return humanWorkDecisionSchema.parse({
    decisionId: row.decision_id,
    tenantId: row.tenant_id,
    caseId: row.case_id,
    workItemId: row.work_item_id,
    principalId: row.principal_id,
    decision: row.decision,
    reasonCode: row.reason_code,
    rationale: row.rationale,
    evidenceRefs: row.evidence_refs,
    decidedAt: iso(row.decided_at)!,
  });
}

export async function listHumanWorkQueue(
  db: Database,
  tenantId: string,
  options: { caseId?: string; runId?: string; includeTerminal?: boolean; limit?: number } = {},
): Promise<HumanQueueItem[]> {
  const limit = options.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("pagination.limit_invalid");
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin");
    await setTenantContext(client, tenantId);
    const result = await client.query<WorkItemRow & { decisions: HumanDecisionRow[]; assigned_to: string[]; escalated: boolean; policy_decision: unknown }>(`
      select work.*,
        (select decision from workflow.policy_human_requirements p where p.tenant_id=work.tenant_id and p.work_item_id=work.work_item_id) policy_decision,
        coalesce((select jsonb_agg(jsonb_build_object(
          'decision_id', decision_id, 'tenant_id', tenant_id, 'case_id', case_id,
          'work_item_id', work_item_id, 'principal_id', principal_id, 'decision', decision,
          'reason_code', reason_code, 'rationale', rationale, 'evidence_refs', evidence_refs,
          'decided_at', decided_at
        ) order by decided_at, decision_id)
        from workflow.human_decisions decision where decision.tenant_id=work.tenant_id
          and decision.work_item_id=work.work_item_id), '[]'::jsonb) decisions,
        coalesce(array(select assignment.principal_id from workflow.human_assignments assignment
          where assignment.tenant_id=work.tenant_id and assignment.work_item_id=work.work_item_id
          order by assignment.claimed_at, assignment.principal_id), '{}') assigned_to,
        exists(select 1 from workflow.durable_timers timer where timer.tenant_id=work.tenant_id
          and timer.work_item_id=work.work_item_id and timer.purpose='HUMAN_ESCALATION'
          and timer.status='FIRED') escalated
      from workflow.work_items work
      where work.tenant_id=$1
        and ($2::text is null or work.case_id=$2)
        and ($3::text is null or work.document->'constraints'->>'runId'=$3)
        and ($4::boolean or work.status in ('HUMAN_REQUIRED','WAITING_HUMAN'))
      order by work.priority desc, work.deadline_at nulls last, work.updated_at, work.work_item_id
      limit $5
    `, [tenantId, options.caseId ?? null, options.runId ?? null, options.includeTerminal === true, limit]);
    await client.query("commit");
    return result.rows.map((row) => {
      const workItem = mapWorkItem(row);
      const constraints = workItem.constraints as Record<string, unknown>;
      const policyDecision = row.policy_decision ? businessDecisionSchema.parse(row.policy_decision) : undefined;
      return {
        ...(policyDecision ? { policyDecision, policyRequestDigest: stableDigest({decisionId:policyDecision.decisionId,inputDigest:policyDecision.inputDigest,requirement:policyDecision.result.humanRequirement}) } : {}),
        workItem,
        overdue: Boolean(workItem.deadlineAt && Date.parse(workItem.deadlineAt) <= Date.now()),
        escalated: row.escalated,
        assignedTo: row.assigned_to,
        decisions: row.decisions.map(mapHumanDecision),
        requiredApprovals: policyDecision?.result.humanRequirement?.quorum ?? (constraints.dualControlRequired === true ? 2 : 1),
      };
    });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release?.();
  }
}

export async function claimHumanWorkItem(db: Database, input: {
  tenantId: string; workItemId: string; principalId: string;
}): Promise<{ workItem: ExecutionWorkItem; assignedTo: string[]; replayed: boolean }> {
  if (![input.tenantId, input.workItemId, input.principalId].every((value) => value.trim().length > 0)) {
    throw new Error("workflow.human_assignment_invalid");
  }
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin");
    await setTenantContext(client, input.tenantId);
    const selected = await client.query<WorkItemRow>(`
      select * from workflow.work_items where tenant_id=$1 and work_item_id=$2 for update
    `, [input.tenantId, input.workItemId]);
    const row = selected.rows[0];
    if (!row || (row.status !== "HUMAN_REQUIRED" && row.status !== "WAITING_HUMAN")) {
      throw new Error("workflow.human_assignment_not_pending");
    }
    const inserted = await client.query(`
      insert into workflow.human_assignments(tenant_id,case_id,work_item_id,principal_id)
      values($1,$2,$3,$4) on conflict do nothing returning principal_id
    `, [input.tenantId, row.case_id, input.workItemId, input.principalId]);
    const assignments = await client.query<{ principal_id: string }>(`
      select principal_id from workflow.human_assignments
      where tenant_id=$1 and work_item_id=$2 order by claimed_at, principal_id
    `, [input.tenantId, input.workItemId]);
    await client.query("commit");
    return { workItem: mapWorkItem(row), assignedTo: assignments.rows.map((item) => item.principal_id), replayed: !inserted.rows.length };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release?.();
  }
}

export async function resolveHumanWorkConflict(db: Database, raw: unknown): Promise<{
  workItem: ExecutionWorkItem; resolution: HumanWorkDecision;
}> {
  const resolution = humanWorkDecisionSchema.parse(raw);
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin");
    await setTenantContext(client, resolution.tenantId);
    const selected = await client.query<WorkItemRow>(`
      select * from workflow.work_items where tenant_id=$1 and case_id=$2 and work_item_id=$3 for update
    `, [resolution.tenantId, resolution.caseId, resolution.workItemId]);
    const row = selected.rows[0];
    if (!row) throw new Error("workflow.human_resolution_not_pending");
    const policyRequirement=await client.query("select 1 from workflow.policy_human_requirements where tenant_id=$1 and work_item_id=$2",[resolution.tenantId,resolution.workItemId]);
    if(policyRequirement.rows.length) throw new Error("policy.post_human_gate_required");
    if (row.status !== "WAITING_HUMAN") throw new Error("workflow.human_resolution_not_pending");
    const decisions = await client.query<HumanDecisionRow>(`
      select decision_id, tenant_id, case_id, work_item_id, principal_id, decision,
        reason_code, rationale, evidence_refs, decided_at
      from workflow.human_decisions where tenant_id=$1 and work_item_id=$2
      order by decided_at, decision_id
    `, [resolution.tenantId, resolution.workItemId]);
    if (new Set(decisions.rows.map((item) => item.decision)).size < 2) throw new Error("workflow.human_resolution_conflict_missing");
    if (decisions.rows.some((item) => item.principal_id === resolution.principalId)) {
      throw new Error("workflow.human_resolution_separation_required");
    }
    const inserted = await client.query(`
      insert into workflow.human_conflict_resolutions(
        tenant_id,case_id,work_item_id,resolution_id,principal_id,decision,reason_code,rationale,evidence_refs,resolved_at
      ) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
      returning resolution_id
    `, [resolution.tenantId, resolution.caseId, resolution.workItemId, resolution.decisionId,
      resolution.principalId, resolution.decision, resolution.reasonCode, resolution.rationale,
      JSON.stringify(resolution.evidenceRefs), resolution.decidedAt]);
    if (!inserted.rows.length) throw new Error("workflow.human_resolution_conflict");
    const next = await transitionLocked(client, row, "COMPLETED", resolution.reasonCode, {
      type: "HUMAN", principalId: resolution.principalId, roles: ["Harness.Operator"],
    }, {
      clearLease: true,
      result: {
        agentResultRef: null,
        acceptedCommandRefs: [...decisions.rows.map((item) => item.decision_id), resolution.decisionId],
        outputRefs: resolution.evidenceRefs,
        failureCode: resolution.decision === "REJECT" ? resolution.reasonCode : null,
        failureDetailRef: null,
      },
    });
    const output = { decision: resolution.decision, authority: "HUMAN_CONFLICT_RESOLUTION",
      decisionIds: decisions.rows.map((item) => item.decision_id), resolutionId: resolution.decisionId,
      reasonCode: resolution.reasonCode };
    await client.query(`insert into workflow.node_outputs(tenant_id,work_item_id,output,output_digest)
      values ($1,$2,$3::jsonb,$4) on conflict do nothing`,
    [resolution.tenantId, resolution.workItemId, JSON.stringify(output), stableDigest(output)]);
    await client.query(`update workflow.durable_timers set status='CANCELLED'
      where tenant_id=$1 and work_item_id=$2 and purpose='HUMAN_ESCALATION' and status='PENDING'`,
    [resolution.tenantId, resolution.workItemId]);
    const constraints = executionWorkItemSchema.parse(row.document).constraints as Record<string, unknown>;
    if (typeof constraints.runId === "string") {
      await client.query(`update harness_runtime.runs set status='queued', completed_at=null,
        terminal_outcome=null, error_code=null, available_at=transaction_timestamp(),
        attempt_limit=greatest(attempt_limit,attempt+1), updated_at=transaction_timestamp()
        where run_id=$1 and tenant_id=$2 and status='manual_review'`, [constraints.runId, resolution.tenantId]);
      await client.query("select pg_notify('harness_run_queue',$1)", [constraints.runId]);
    }
    await client.query("commit");
    return { workItem: mapWorkItem(next), resolution };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release?.();
  }
}

/**
 * Record an immutable human decision and derive the work-item transition atomically.
 * For dual control, two distinct principals must submit the same decision. Conflicting
 * decisions remain waiting for escalation; neither decision overwrites the other.
 */
export async function submitHumanWorkDecision(
  db: Database,
  raw: unknown,
): Promise<{ decision: HumanWorkDecision; workItem: ExecutionWorkItem; effective: boolean; conflict: boolean }> {
  const decision = humanWorkDecisionSchema.parse(raw);
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin");
    await setTenantContext(client, decision.tenantId);
    const locked = await client.query<WorkItemRow>(`
      select * from workflow.work_items where tenant_id=$1 and case_id=$2 and work_item_id=$3 for update
    `, [decision.tenantId, decision.caseId, decision.workItemId]);
    const row = locked.rows[0];
    const policyRequirement = await client.query("select 1 from workflow.policy_human_requirements where tenant_id=$1 and work_item_id=$2", [decision.tenantId,decision.workItemId]);
    if (policyRequirement.rows.length) throw new Error("policy.post_human_gate_required");
    const prior = await client.query<HumanDecisionRow>(`select * from workflow.human_decisions where tenant_id=$1 and decision_id=$2`, [decision.tenantId, decision.decisionId]);
    if (prior.rows[0]) {
      const saved = mapHumanDecision(prior.rows[0]);
      const { decidedAt: _savedAt, ...savedContent } = saved;
      const { decidedAt: _requestedAt, ...requestedContent } = decision;
      if (!row || stableDigest(savedContent) !== stableDigest(requestedContent)) throw new Error("workflow.human_decision_idempotency_conflict");
      const conflict = await client.query<{ conflict: boolean }>(`select count(distinct decision)>1 as conflict from workflow.human_decisions where tenant_id=$1 and work_item_id=$2`, [decision.tenantId, decision.workItemId]);
      await client.query("commit");
      return { decision: saved, workItem: mapWorkItem(row), effective: row.status === "COMPLETED", conflict: conflict.rows[0]?.conflict ?? false };
    }
    if (!row || (row.status !== "HUMAN_REQUIRED" && row.status !== "WAITING_HUMAN")) {
      throw new Error("workflow.human_decision_not_pending");
    }
    const assignments = await client.query<{ principal_id: string }>(`
      select principal_id from workflow.human_assignments where tenant_id=$1 and work_item_id=$2
    `, [decision.tenantId, decision.workItemId]);
    if (assignments.rows.length && !assignments.rows.some((item) => item.principal_id === decision.principalId)) {
      throw new Error("workflow.human_decision_not_assigned");
    }
    const inserted = await client.query<HumanDecisionRow>(`
      insert into workflow.human_decisions(
        tenant_id, case_id, work_item_id, decision_id, principal_id, decision,
        reason_code, rationale, evidence_refs, decided_at
      ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
      on conflict (tenant_id, decision_id) do nothing
      returning decision_id, tenant_id, case_id, work_item_id, principal_id, decision,
        reason_code, rationale, evidence_refs, decided_at
    `, [decision.tenantId, decision.caseId, decision.workItemId, decision.decisionId,
      decision.principalId, decision.decision, decision.reasonCode, decision.rationale,
      JSON.stringify(decision.evidenceRefs), decision.decidedAt]);
    if (!inserted.rows[0]) throw new Error("workflow.human_decision_idempotency_conflict");
    const all = await client.query<HumanDecisionRow>(`
      select decision_id, tenant_id, case_id, work_item_id, principal_id, decision,
        reason_code, rationale, evidence_refs, decided_at
      from workflow.human_decisions where tenant_id=$1 and work_item_id=$2
      order by decided_at, decision_id
    `, [decision.tenantId, decision.workItemId]);
    const constraints = executionWorkItemSchema.parse(row.document).constraints as Record<string, unknown>;
    const required = constraints.dualControlRequired === true ? 2 : 1;
    const counts = new Map<HumanWorkDecision["decision"], number>();
    for (const item of all.rows) counts.set(item.decision, (counts.get(item.decision) ?? 0) + 1);
    const effective = (counts.get(decision.decision) ?? 0) >= required;
    const conflict = new Set(all.rows.map((item) => item.decision)).size > 1;
    let target: ExecutionWorkItemStatus = "WAITING_HUMAN";
    let reasonCode = conflict ? "workflow.human_decision_conflict" : "workflow.dual_control_pending";
    if (effective && !conflict) {
      // RETURN is a durable branch outcome, not permission to repeat the same approval.
      target = "COMPLETED";
      reasonCode = decision.reasonCode;
    }
    const transitioned = target === row.status ? row : await transitionLocked(client, row, target, reasonCode, {
      type: "HUMAN", principalId: decision.principalId, roles: ["Case.Reviewer"],
    }, {
      clearLease: true,
      ...(target === "COMPLETED" ? {
        result: {
          agentResultRef: null,
          acceptedCommandRefs: all.rows.map((item) => item.decision_id),
          outputRefs: decision.evidenceRefs,
          failureCode: decision.decision === "REJECT" ? decision.reasonCode : null,
          failureDetailRef: null,
        },
      } : {}),
    });
    if (effective && !conflict && target === "COMPLETED") {
      const output = {
        decision: decision.decision,
        authority: "HUMAN",
        decisionIds: all.rows.map((item) => item.decision_id),
        reviewerPrincipalId: decision.principalId,
        reviewerPrincipalIds: all.rows.map((item) => item.principal_id),
        reasonCode: decision.reasonCode,
        rationale: decision.rationale,
        evidenceRefs: decision.evidenceRefs,
      };
      await client.query(`insert into workflow.node_outputs(tenant_id,work_item_id,output,output_digest)
        values ($1,$2,$3::jsonb,$4) on conflict do nothing`, [decision.tenantId, decision.workItemId, JSON.stringify(output), stableDigest(output)]);
      const runId = constraints.runId;
      if (typeof runId === "string") {
        await client.query(`update harness_runtime.runs set status='queued', completed_at=null,
          terminal_outcome=null, error_code=null, available_at=transaction_timestamp(), attempt_limit=greatest(attempt_limit,attempt+1), updated_at=transaction_timestamp()
          where run_id=$1 and tenant_id=$2 and status='manual_review'`, [runId, decision.tenantId]);
        await client.query("select pg_notify('harness_run_queue',$1)", [runId]);
      }
      await client.query(`update workflow.durable_timers set status='CANCELLED'
        where tenant_id=$1 and work_item_id=$2 and purpose='HUMAN_ESCALATION' and status='PENDING'`,
      [decision.tenantId, decision.workItemId]);
    }
    await client.query("commit");
    return { decision: mapHumanDecision(inserted.rows[0]), workItem: mapWorkItem(transitioned), effective, conflict };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release?.();
  }
}

export type ExecutionWorkQueueStats = {
  ready: number;
  delayed: number;
  leased: number;
  running: number;
  suspended: number;
  reconciliationOpen: number;
};

export async function getExecutionWorkQueueStats(db: Database): Promise<ExecutionWorkQueueStats> {
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin");
    const result = await client.query<{
    ready: string; delayed: string; leased: string; running: string; suspended: string; reconciliation_open: string;
  }>(`
    select
      count(*) filter (where status='READY')::text ready,
      count(*) filter (where status='RETRY_SCHEDULED')::text delayed,
      count(*) filter (where status='LEASED')::text leased,
      count(*) filter (where status='RUNNING')::text running,
      count(*) filter (where status='SUSPENDED')::text suspended,
      (select count(*)::text from workflow.reconciliation_cases where status='OPEN') reconciliation_open
    from workflow.work_items
  `);
    const row = result.rows[0] ?? { ready: "0", delayed: "0", leased: "0", running: "0", suspended: "0", reconciliation_open: "0" };
    await client.query("commit");
    return { ready: Number(row.ready), delayed: Number(row.delayed), leased: Number(row.leased),
      running: Number(row.running), suspended: Number(row.suspended), reconciliationOpen: Number(row.reconciliation_open) };
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release?.();
  }
}

/** Read the request recorded from the evaluated gate, never from a human form's authority fields. */
export async function getPolicyHumanWork(db: Database, tenantId: string, workItemId: string) {
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin read only"); await setTenantContext(client, tenantId);
    const row = (await client.query<{decision: unknown}>("select decision from workflow.policy_human_requirements where tenant_id=$1 and work_item_id=$2", [tenantId,workItemId])).rows[0];
    await client.query("commit"); return row ? businessDecisionSchema.parse(row.decision) : null;
  } finally { await client.query("rollback").catch(() => undefined); client.release?.(); }
}

/** Re-evaluate the same gate after recording a human observation. Never complete it from the choice. */
export async function resumePolicyHumanWork(db: Database, input: {tenantId:string; workItemId:string; decisionId:string; actor:CaseActor}) {
  const client = await db.connect() as unknown as QueryClient;
  try {
    await client.query("begin"); await setTenantContext(client,input.tenantId);
    const row = (await client.query<WorkItemRow>("select * from workflow.work_items where tenant_id=$1 and work_item_id=$2 for update", [input.tenantId,input.workItemId])).rows[0];
    const requirement = (await client.query<{decision_id:string}>("select decision_id from workflow.policy_human_requirements where tenant_id=$1 and work_item_id=$2", [input.tenantId,input.workItemId])).rows[0];
    if (!row || requirement?.decision_id !== input.decisionId) throw new Error("policy.human_work_scope_mismatch");
    if (row.status === "HUMAN_REQUIRED" || row.status === "WAITING_HUMAN") {
      await transitionLocked(client,row,"READY","policy.human_observation_recorded",input.actor,{clearLease:true,readyAt:new Date().toISOString()});
      await client.query("update workflow.work_items set dispatch_generation=dispatch_generation+1,dispatch_published_at=null,broker_message_id=null,max_attempts=greatest(max_attempts,attempt_number+1) where tenant_id=$1 and work_item_id=$2",[input.tenantId,input.workItemId]);
      const work=mapWorkItem(row); const runId=work.constraints.runId;
      if(typeof runId!=="string") throw new Error("policy.human_work_run_missing");
      await client.query(`update harness_runtime.runs set status='queued',completed_at=null,terminal_outcome=null,error_code=null,
        available_at=transaction_timestamp(),attempt_limit=greatest(attempt_limit,attempt+1),updated_at=transaction_timestamp()
        where tenant_id=$1 and run_id=$2 and status='manual_review'`,[input.tenantId,runId]);
      await client.query("select pg_notify('harness_run_queue',$1)",[runId]);
    }
    await client.query("commit");
  } catch(error) {await client.query("rollback");throw error;} finally{client.release?.();}
}
