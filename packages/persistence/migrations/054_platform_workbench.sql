alter table harness_control.runtime_lifecycle add column if not exists revision integer not null default 0;
create table harness_control.runtime_admission_events (
  tenant_id text not null, revision integer not null, operation text not null,
  active_run_policy text not null, actor text not null, reason text not null,
  cancellation_requests integer not null, occurred_at timestamptz not null default now(),
  primary key (tenant_id, revision)
);
create table observability.worker_heartbeats (
  worker_id text primary key, kind text not null check(kind in ('runtime-worker','integration-worker')),
  concurrency integer not null, in_flight integer not null, last_success_at timestamptz,
  observed_at timestamptz not null default now()
);
create table harness_control.workspaces (
  tenant_id text not null, workspace_id text not null, kind text not null check(kind in ('skill','agent')),
  name text not null, revision integer not null, published_revision integer,
  created_by text not null, updated_at timestamptz not null default now(), primary key(tenant_id,workspace_id)
);
create table harness_control.workspace_revisions (
  tenant_id text not null, workspace_id text not null, revision integer not null, digest text not null,
  files jsonb not null, config jsonb not null, message text not null, actor text not null,
  created_at timestamptz not null default now(), primary key(tenant_id,workspace_id,revision),
  foreign key(tenant_id,workspace_id) references harness_control.workspaces(tenant_id,workspace_id)
);
create table harness_control.workspace_evaluations (
  tenant_id text not null, evaluation_id text not null, workspace_id text not null, revision integer not null,
  source_digest text not null, dataset_digest text not null, dataset jsonb not null,
  model_profile_id text, model_profile_digest text, model_profile_revision integer,
  status text not null check(status in ('queued','running','passed','failed','error','cancelled')), cancellation_requested boolean not null default false,
  cases jsonb not null default '[]', error text, actor text not null, max_cost_usd numeric not null,
  created_at timestamptz not null default now(), completed_at timestamptz, lease_until timestamptz, owner text,
  primary key(tenant_id,evaluation_id),
  foreign key(tenant_id,workspace_id,revision) references harness_control.workspace_revisions(tenant_id,workspace_id,revision)
);
create index workspace_evaluations_queue on harness_control.workspace_evaluations(status,created_at);
create table harness_control.workspace_model_steps (
  tenant_id text not null, evaluation_id text not null, case_index integer not null, step_index integer not null,
  status text not null check(status in ('started','completed','error')), result jsonb, cost_usd numeric,
  started_at timestamptz not null default now(), completed_at timestamptz,
  primary key(tenant_id,evaluation_id,case_index,step_index),
  foreign key(tenant_id,evaluation_id) references harness_control.workspace_evaluations(tenant_id,evaluation_id)
);
create table harness_control.workspace_tool_receipts (
  tenant_id text not null,evaluation_id text not null,case_index integer not null,step_index integer not null,
  receipt jsonb not null,primary key(tenant_id,evaluation_id,case_index,step_index),
  foreign key(tenant_id,evaluation_id) references harness_control.workspace_evaluations(tenant_id,evaluation_id)
);
create table harness_control.workspace_promotions (
  tenant_id text not null, workspace_id text not null, revision integer not null,
  operation text not null check(operation in ('approve','publish')), evaluation_id text not null,
  actor text not null, reason text not null, occurred_at timestamptz not null default now(),
  primary key(tenant_id,workspace_id,revision,operation),
  foreign key(tenant_id,workspace_id,revision) references harness_control.workspace_revisions(tenant_id,workspace_id,revision),
  foreign key(tenant_id,evaluation_id) references harness_control.workspace_evaluations(tenant_id,evaluation_id)
);
-- Content snapshots and promotion evidence are append-only.
create function harness_control.reject_workspace_evidence_mutation() returns trigger language plpgsql as $$
begin raise exception 'workbench.evidence_immutable'; end $$;
create trigger workspace_revisions_immutable before update or delete on harness_control.workspace_revisions
  for each row execute function harness_control.reject_workspace_evidence_mutation();
create trigger workspace_promotions_immutable before update or delete on harness_control.workspace_promotions
  for each row execute function harness_control.reject_workspace_evidence_mutation();
