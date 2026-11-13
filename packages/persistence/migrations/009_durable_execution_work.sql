-- Authoritative node-level execution state.
--
-- Broker messages and runtime adapter state are deliberately not authoritative.  A
-- dispatch is only a hint to re-read this row and acquire the matching generation.
create schema if not exists workflow;

create table if not exists workflow.work_items (
  tenant_id text not null,
  case_id text not null,
  work_item_id text not null,
  document jsonb not null,
  document_digest char(64) not null check (document_digest ~ '^[a-f0-9]{64}$'),
  work_type text not null,
  capability_id text,
  assurance_class text not null,
  revision integer not null check (revision >= 0),
  case_sequence_basis bigint not null check (case_sequence_basis >= 0),
  plan_digest text not null check (plan_digest ~ '^(sha256:)?[a-f0-9]{64}$'),
  policy_context_ref text not null,
  schema_version text not null,
  dependency_digest text not null check (dependency_digest ~ '^(sha256:)?[a-f0-9]{64}$'),
  invalidation_policy text not null check (invalidation_policy in ('BLOCK','CANCEL','REWORK','REEVALUATE')),
  status text not null check (status in (
    'PROPOSED','BLOCKED','READY','LEASED','RUNNING','PARTIAL','RETRY_SCHEDULED',
    'REWORK_REQUIRED','HUMAN_REQUIRED','WAITING_HUMAN','SUSPENDED','COMPLETED',
    'CANCELLED','EXPIRED','FAILED'
  )),
  reason_code text,
  priority integer not null,
  ready_at timestamptz,
  deadline_at timestamptz,
  terminal_at timestamptz,
  dispatch_generation integer not null default 0 check (dispatch_generation >= 0),
  dispatch_queue text not null,
  dispatch_published_at timestamptz,
  broker_message_id text,
  execution_id text,
  lease_owner text,
  lease_until timestamptz,
  fencing_epoch bigint not null default 0 check (fencing_epoch >= 0),
  attempt_number integer not null default 0 check (attempt_number >= 0),
  max_attempts integer not null check (max_attempts > 0),
  max_rework_cycles integer not null check (max_rework_cycles >= 0),
  rework_cycles integer not null default 0 check (rework_cycles >= 0),
  max_duration_ms integer not null check (max_duration_ms > 0),
  max_cost_usd numeric(18,8) not null check (max_cost_usd >= 0),
  max_model_calls integer not null check (max_model_calls >= 0),
  max_capability_calls integer not null check (max_capability_calls >= 0),
  result jsonb,
  result_digest char(64) check (result_digest is null or result_digest ~ '^[a-f0-9]{64}$'),
  completed_execution_id text,
  created_by jsonb not null,
  transition_sequence bigint not null default 0 check (transition_sequence >= 0),
  trace_id char(32) check (trace_id is null or trace_id ~ '^[a-f0-9]{32}$'),
  cancellation_requested_at timestamptz,
  cancellation_reason text,
  suspended_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, work_item_id),
  unique (tenant_id, case_id, work_item_id),
  check ((status in ('LEASED','RUNNING')) =
    (execution_id is not null and lease_owner is not null and lease_until is not null)),
  check ((status in ('COMPLETED','CANCELLED','EXPIRED','FAILED')) = (terminal_at is not null)),
  check (terminal_at is null or terminal_at >= created_at),
  check (deadline_at is null or deadline_at >= created_at)
);

create table if not exists workflow.work_item_dependencies (
  tenant_id text not null,
  case_id text not null,
  work_item_id text not null,
  dependency_id text not null,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, work_item_id, dependency_id),
  foreign key (tenant_id, case_id, work_item_id)
    references workflow.work_items(tenant_id, case_id, work_item_id) on delete cascade,
  foreign key (tenant_id, case_id, dependency_id)
    references workflow.work_items(tenant_id, case_id, work_item_id)
    deferrable initially deferred
);

create table if not exists workflow.work_item_transitions (
  tenant_id text not null,
  case_id text not null,
  work_item_id text not null,
  transition_sequence bigint not null,
  from_status text check (from_status is null or from_status in (
    'PROPOSED','BLOCKED','READY','LEASED','RUNNING','PARTIAL','RETRY_SCHEDULED',
    'REWORK_REQUIRED','HUMAN_REQUIRED','WAITING_HUMAN','SUSPENDED','COMPLETED',
    'CANCELLED','EXPIRED','FAILED'
  )),
  to_status text not null check (to_status in (
    'PROPOSED','BLOCKED','READY','LEASED','RUNNING','PARTIAL','RETRY_SCHEDULED',
    'REWORK_REQUIRED','HUMAN_REQUIRED','WAITING_HUMAN','SUSPENDED','COMPLETED',
    'CANCELLED','EXPIRED','FAILED'
  )),
  revision integer not null,
  reason_code text not null,
  actor jsonb not null,
  input_digest char(64) not null check (input_digest ~ '^[a-f0-9]{64}$'),
  occurred_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, work_item_id, transition_sequence),
  foreign key (tenant_id, case_id, work_item_id)
    references workflow.work_items(tenant_id, case_id, work_item_id) on delete cascade
);

create table if not exists workflow.dispatch_outbox (
  tenant_id text not null,
  case_id text not null,
  work_item_id text not null,
  dispatch_generation integer not null,
  queue text not null,
  message_id text not null,
  status text not null default 'PENDING' check (status in ('PENDING','PUBLISHED','CONSUMED')),
  available_at timestamptz not null default transaction_timestamp(),
  publish_attempts integer not null default 0 check (publish_attempts >= 0),
  published_at timestamptz,
  broker_message_id text,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, work_item_id, dispatch_generation),
  unique (message_id),
  foreign key (tenant_id, case_id, work_item_id)
    references workflow.work_items(tenant_id, case_id, work_item_id) on delete cascade
);

create table if not exists workflow.durable_timers (
  tenant_id text not null,
  case_id text not null,
  work_item_id text not null,
  purpose text not null check (purpose in ('RETRY_ELIGIBLE','DEADLINE','RESUME','HUMAN_ESCALATION')),
  target_revision integer not null check (target_revision >= 0),
  due_at timestamptz not null,
  status text not null default 'PENDING' check (status in ('PENDING','FIRED','CANCELLED')),
  fired_at timestamptz,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, work_item_id, purpose, target_revision),
  foreign key (tenant_id, case_id, work_item_id)
    references workflow.work_items(tenant_id, case_id, work_item_id) on delete cascade
);

create table if not exists workflow.reconciliation_cases (
  tenant_id text not null,
  case_id text not null,
  work_item_id text not null,
  fencing_epoch bigint not null,
  category text not null,
  status text not null default 'OPEN' check (status in ('OPEN','RESOLVED','ABANDONED')),
  reason_code text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default transaction_timestamp(),
  resolved_at timestamptz,
  primary key (tenant_id, work_item_id, fencing_epoch, category),
  foreign key (tenant_id, case_id, work_item_id)
    references workflow.work_items(tenant_id, case_id, work_item_id) on delete cascade
);

create index if not exists workflow_work_ready_idx
  on workflow.work_items(tenant_id, priority desc, deadline_at, ready_at, work_item_id)
  where status = 'READY';
create index if not exists workflow_work_lease_idx
  on workflow.work_items(tenant_id, lease_until, work_item_id)
  where status in ('LEASED','RUNNING');
create index if not exists workflow_work_retry_idx
  on workflow.work_items(tenant_id, ready_at, work_item_id)
  where status = 'RETRY_SCHEDULED';
create index if not exists workflow_work_case_idx
  on workflow.work_items(tenant_id, case_id, updated_at desc, work_item_id);
create index if not exists workflow_dependency_reverse_idx
  on workflow.work_item_dependencies(tenant_id, dependency_id, work_item_id);
create index if not exists workflow_dispatch_pending_idx
  on workflow.dispatch_outbox(status, available_at, tenant_id, work_item_id)
  where status = 'PENDING';
create index if not exists workflow_timer_due_idx
  on workflow.durable_timers(status, due_at, tenant_id, work_item_id)
  where status = 'PENDING';
create index if not exists workflow_reconciliation_open_idx
  on workflow.reconciliation_cases(tenant_id, status, created_at)
  where status = 'OPEN';

-- Tenant identity is supplied by repository transactions with SET LOCAL.  The
-- workflow controller deliberately opts into a cross-tenant service context for its
-- bounded SKIP LOCKED scans; ordinary tenant reads cannot see another tenant's rows.
do $$
declare
  relation_name text;
begin
  foreach relation_name in array array[
    'work_items', 'work_item_dependencies', 'work_item_transitions',
    'dispatch_outbox', 'durable_timers', 'reconciliation_cases'
  ] loop
    execute format('alter table workflow.%I enable row level security', relation_name);
    execute format('alter table workflow.%I force row level security', relation_name);
    execute format('drop policy if exists workflow_tenant_scope on workflow.%I', relation_name);
    execute format($policy$
      create policy workflow_tenant_scope on workflow.%I
      using (
        tenant_id = nullif(current_setting('app.tenant_id', true), '')
        or current_setting('app.workflow_controller', true) = 'true'
      )
      with check (
        tenant_id = nullif(current_setting('app.tenant_id', true), '')
        or current_setting('app.workflow_controller', true) = 'true'
      )
    $policy$, relation_name);
  end loop;
end $$;
