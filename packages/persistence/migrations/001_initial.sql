create schema if not exists harness_control;
create schema if not exists harness_runtime;
create schema if not exists harness_gateway;
create schema if not exists langgraph_checkpoint;

create table if not exists harness_control.plans (
  plan_digest text primary key check (plan_digest ~ '^[a-f0-9]{64}$'),
  plan_id text not null,
  name text not null,
  domain text not null,
  version text not null,
  plan jsonb not null,
  admitted_at timestamptz not null default now()
);

create table if not exists harness_runtime.runs (
  run_id text primary key,
  idempotency_key text not null unique,
  plan_digest text not null references harness_control.plans(plan_digest),
  status text not null check (status in ('queued','running','retrying','completed','manual_review','denied','failed')),
  terminal_outcome text,
  input jsonb not null,
  output jsonb,
  attempt integer not null default 0,
  fencing_epoch bigint not null default 0,
  lease_owner text,
  lease_expires_at timestamptz,
  current_node_id text,
  latest_checkpoint_id text,
  event_sequence bigint not null default 0,
  cost_usd numeric(18,8) not null default 0,
  cost_complete boolean not null default true,
  model_calls integer not null default 0,
  capability_calls integer not null default 0,
  error_code text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);

create index if not exists runs_ready_idx
  on harness_runtime.runs(status, lease_expires_at, created_at)
  where status in ('queued','running','retrying');

create table if not exists harness_runtime.run_events (
  run_id text not null references harness_runtime.runs(run_id) on delete cascade,
  sequence bigint not null,
  event_key text not null,
  code text not null,
  node_id text,
  status text not null,
  values jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  primary key (run_id, sequence),
  unique (run_id, event_key)
);

create table if not exists harness_runtime.node_attempts (
  run_id text not null references harness_runtime.runs(run_id) on delete cascade,
  node_id text not null,
  attempt integer not null,
  fencing_epoch bigint not null,
  status text not null,
  input_digest text,
  output_digest text,
  checkpoint_id text,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  error_code text,
  primary key (run_id, node_id, attempt)
);

create table if not exists harness_gateway.receipts (
  invocation_id text primary key,
  run_id text not null,
  node_id text not null,
  attempt integer not null,
  fencing_epoch bigint not null,
  plan_digest text not null,
  permission_digest text not null,
  capability_id text not null,
  effect text not null,
  decision text not null check (decision in ('allowed','denied')),
  reason_code text not null,
  request_digest text not null,
  result jsonb,
  receipt_digest text,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists gateway_receipts_run_idx
  on harness_gateway.receipts(run_id, created_at desc);
