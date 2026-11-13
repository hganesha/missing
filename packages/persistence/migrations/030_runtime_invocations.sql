create table harness_runtime.runtime_invocations (
  tenant_id text not null, invocation_id text not null, run_id text not null,
  request_digest char(64) not null, execution_profile_digest text not null,
  state text not null check (state in ('running','completed','failed','cancelled')),
  cancellation_requested boolean not null default false,
  result jsonb, result_digest char(64),
  created_at timestamptz not null default clock_timestamp(), completed_at timestamptz,
  primary key (tenant_id,invocation_id)
);
alter table harness_runtime.runtime_invocations enable row level security;
alter table harness_runtime.runtime_invocations force row level security;
create policy runtime_invocation_tenant on harness_runtime.runtime_invocations
  using (tenant_id=nullif(current_setting('app.tenant_id',true),''))
  with check (tenant_id=nullif(current_setting('app.tenant_id',true),''));
