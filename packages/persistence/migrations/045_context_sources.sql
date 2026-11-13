-- Revisioned enterprise connections. Existing provider drafts and executable connectors
-- keep their identities; importing a draft is explicit and never grants source permission.
create table harness_admin.context_source_heads (
  tenant_id text not null, kind text not null check (kind in ('connection','binding')),
  source_id text not null, revision integer not null check (revision > 0),
  active_revision integer, disabled boolean not null default false,
  primary key (tenant_id,kind,source_id)
);
create table harness_admin.context_source_revisions (
  tenant_id text not null, kind text not null, source_id text not null,
  revision integer not null, definition jsonb not null, digest text not null,
  actor text not null, created_at timestamptz not null default now(),
  primary key (tenant_id,kind,source_id,revision),
  foreign key (tenant_id,kind,source_id) references harness_admin.context_source_heads
);
create table harness_admin.context_source_checks (
  tenant_id text not null, check_id text not null, binding_id text not null,
  revision integer not null, report jsonb not null, created_at timestamptz not null default now(),
  primary key (tenant_id,check_id)
);
create index context_source_checks_binding on harness_admin.context_source_checks(tenant_id,binding_id,created_at desc);
create table harness_admin.context_source_events (
  event_id bigint generated always as identity primary key,
  tenant_id text not null, source_id text not null, kind text not null,
  revision integer not null, action text not null, actor text not null,
  reason text not null, qualification_id text, created_at timestamptz not null default now()
);
create function harness_admin.context_source_immutable() returns trigger language plpgsql as $$
begin raise exception 'context_source.immutable'; end $$;
create trigger context_source_revision_immutable before update or delete on harness_admin.context_source_revisions
  for each row execute function harness_admin.context_source_immutable();
create trigger context_source_check_immutable before update or delete on harness_admin.context_source_checks
  for each row execute function harness_admin.context_source_immutable();
create trigger context_source_event_immutable before update or delete on harness_admin.context_source_events
  for each row execute function harness_admin.context_source_immutable();
alter table harness_admin.context_source_heads enable row level security;
alter table harness_admin.context_source_heads force row level security;
create policy tenant_scope on harness_admin.context_source_heads
  using (tenant_id = nullif(current_setting('app.tenant_id',true),''))
  with check (tenant_id = nullif(current_setting('app.tenant_id',true),''));
alter table harness_admin.context_source_revisions enable row level security;
alter table harness_admin.context_source_revisions force row level security;
create policy tenant_scope on harness_admin.context_source_revisions
  using (tenant_id = nullif(current_setting('app.tenant_id',true),''))
  with check (tenant_id = nullif(current_setting('app.tenant_id',true),''));
alter table harness_admin.context_source_checks enable row level security;
alter table harness_admin.context_source_checks force row level security;
create policy tenant_scope on harness_admin.context_source_checks
  using (tenant_id = nullif(current_setting('app.tenant_id',true),''))
  with check (tenant_id = nullif(current_setting('app.tenant_id',true),''));
alter table harness_admin.context_source_events enable row level security;
alter table harness_admin.context_source_events force row level security;
create policy tenant_scope on harness_admin.context_source_events
  using (tenant_id = nullif(current_setting('app.tenant_id',true),''))
  with check (tenant_id = nullif(current_setting('app.tenant_id',true),''));

-- Schedules dispatch a published process flow through normal run admission. They never
-- fetch source data or manufacture case mutations with a worker's database credential.
create table integration.context_refresh_jobs (
  tenant_id text not null, binding_id text not null, revision integer not null,
  enabled boolean not null, plan_digest text not null, source_context_digest text not null,
  run_input jsonb not null, interval_minutes integer not null check (interval_minutes>0),
  due_at timestamptz not null default now(), scheduled_for timestamptz not null default now(),
  claim_id text, lease_until timestamptz, run_id text, failures integer not null default 0,
  last_success_at timestamptz, last_error text,
  primary key (tenant_id,binding_id)
);
alter table integration.context_refresh_jobs enable row level security;
alter table integration.context_refresh_jobs force row level security;
create policy refresh_scope on integration.context_refresh_jobs
  using (tenant_id=nullif(current_setting('app.tenant_id',true),'') or (select pg_has_role(current_user,'ehf_integration_controller','member')))
  with check (tenant_id=nullif(current_setting('app.tenant_id',true),'') or (select pg_has_role(current_user,'ehf_integration_controller','member')));
