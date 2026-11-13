create schema if not exists observability;

alter table harness_runtime.runs
  add column if not exists trace_id char(32),
  add column if not exists root_span_id char(16),
  add column if not exists trace_flags smallint;

alter table harness_runtime.node_attempts
  add column if not exists trace_id char(32),
  add column if not exists span_id char(16);

alter table harness_gateway.receipts
  add column if not exists trace_id char(32),
  add column if not exists span_id char(16);

create table if not exists observability.trace_link (
  run_id text not null references harness_runtime.runs(run_id) on delete cascade,
  attempt integer not null,
  trace_id char(32) not null check (trace_id ~ '^[a-f0-9]{32}$'),
  root_span_id char(16) not null check (root_span_id ~ '^[a-f0-9]{16}$'),
  trace_flags smallint not null default 0,
  service_name text not null,
  telemetry_class text not null default 'internal-operational',
  observed_at timestamptz not null default now(),
  primary key (run_id, attempt, service_name)
);

create index if not exists trace_link_trace_idx on observability.trace_link(trace_id, observed_at desc);
