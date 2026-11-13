create table harness_control.sandbox_launches (
  tenant_id text not null,
  environment text not null check (environment <> 'production'),
  draft_id text not null,
  request_key text not null,
  revision integer not null,
  party text not null,
  actor text not null,
  copy_id text not null,
  plan_digest text not null,
  lease_id text,
  lease_until timestamptz,
  run_id text unique references harness_runtime.runs(run_id),
  result jsonb,
  created_at timestamptz not null default now(),
  primary key (tenant_id, environment, draft_id, request_key),
  check ((run_id is null) = (result is null))
);
create index sandbox_launch_history on harness_control.sandbox_launches (tenant_id, environment, created_at desc, run_id desc)
  where run_id is not null;
alter table harness_control.sandbox_launches enable row level security;
alter table harness_control.sandbox_launches force row level security;
create policy tenant_scope on harness_control.sandbox_launches
  using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
