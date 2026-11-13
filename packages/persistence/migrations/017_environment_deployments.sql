create table if not exists harness_control.environment_deployments (
  tenant_id text not null,
  deployment_id text not null,
  spec jsonb not null,
  spec_digest text not null check (spec_digest ~ '^[a-f0-9]{64}$'),
  state text not null check (state in ('DRAFT','DISCOVERED','VALIDATED','PR_OPEN','APPROVED','DEPLOYING','READY','DEGRADED','FAILED')),
  lifecycle_state text not null check (lifecycle_state in ('RUNNING','STOPPING','STOPPED','STARTING')),
  package_manifest jsonb,
  package_files jsonb,
  pull_request_url text,
  pipeline_run_id text,
  pipeline_run_url text,
  last_operation text check (last_operation is null or last_operation in ('plan','deploy','start','stop','restart','smoke','rollback')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, deployment_id),
  unique (tenant_id, spec_digest)
);

create index if not exists environment_deployments_tenant_updated_idx
  on harness_control.environment_deployments (tenant_id, updated_at desc, deployment_id desc);

create table if not exists harness_control.environment_deployment_events (
  tenant_id text not null,
  deployment_id text not null,
  event_id text not null,
  operation text check (operation is null or operation in ('plan','deploy','start','stop','restart','smoke','rollback')),
  prior_state text,
  next_state text not null,
  prior_lifecycle_state text,
  next_lifecycle_state text not null,
  actor_id text not null,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  primary key (tenant_id, event_id),
  foreign key (tenant_id, deployment_id)
    references harness_control.environment_deployments(tenant_id, deployment_id)
    on delete restrict
);

create index if not exists environment_deployment_events_deployment_idx
  on harness_control.environment_deployment_events (tenant_id, deployment_id, occurred_at desc);

