-- Plans are immutable. A run is claimed durably before calling the external executor.
create table if not exists harness_control.bootstrap_plans (
  tenant_id text not null,
  plan_digest text not null,
  spec_digest text not null,
  plan jsonb not null,
  requested_by text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, plan_digest)
);

create table if not exists harness_control.bootstrap_runs (
  tenant_id text not null,
  run_id text not null,
  plan_digest text not null,
  idempotency_key text not null,
  requested_by text not null,
  status text not null check (status in ('QUEUEING','QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELED','QUEUE_UNKNOWN')),
  pipeline_run_id text,
  pipeline_run_url text,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, run_id),
  unique (tenant_id, idempotency_key),
  foreign key (tenant_id, plan_digest) references harness_control.bootstrap_plans(tenant_id, plan_digest)
);
create unique index if not exists bootstrap_single_live_plan_run on harness_control.bootstrap_runs(tenant_id, plan_digest)
  where status in ('QUEUEING','QUEUED','RUNNING','QUEUE_UNKNOWN');
