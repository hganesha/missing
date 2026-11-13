-- Proposals only. No triggers project these records into executable configuration.
create table harness_admin.intelligence_binding_heads (
  tenant_id text not null,
  environment text not null,
  binding_id text not null,
  revision integer not null check (revision > 0),
  primary key (tenant_id, environment, binding_id)
);
create table harness_admin.intelligence_binding_revisions (
  tenant_id text not null,
  environment text not null,
  binding_id text not null,
  revision integer not null check (revision > 0),
  definition jsonb not null,
  digest text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  created_by text not null,
  primary key (tenant_id, environment, binding_id, revision),
  foreign key (tenant_id, environment, binding_id) references harness_admin.intelligence_binding_heads(tenant_id, environment, binding_id)
);
create table harness_admin.intelligence_configuration_checks (
  check_id bigint generated always as identity primary key,
  tenant_id text not null,
  environment text not null,
  binding_id text not null,
  revision integer not null,
  report jsonb not null,
  foreign key (tenant_id, environment, binding_id, revision) references harness_admin.intelligence_binding_revisions(tenant_id, environment, binding_id, revision)
);
create table harness_admin.intelligence_events (
  event_id bigint generated always as identity primary key,
  tenant_id text not null,
  environment text not null,
  binding_id text not null,
  revision integer not null,
  action text not null,
  actor text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, environment, binding_id, revision) references harness_admin.intelligence_binding_revisions(tenant_id, environment, binding_id, revision)
);
create index intelligence_events_scope on harness_admin.intelligence_events(tenant_id, environment, event_id desc);
create index intelligence_checks_scope on harness_admin.intelligence_configuration_checks(tenant_id, environment, binding_id, check_id desc);

create function harness_admin.intelligence_history_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'intelligence.history_immutable';
end;
$$;
create trigger intelligence_revision_immutable before update or delete on harness_admin.intelligence_binding_revisions
for each row execute function harness_admin.intelligence_history_immutable();
create trigger intelligence_event_immutable before update or delete on harness_admin.intelligence_events
for each row execute function harness_admin.intelligence_history_immutable();
create trigger intelligence_check_immutable before update or delete on harness_admin.intelligence_configuration_checks
for each row execute function harness_admin.intelligence_history_immutable();

do $$
declare table_name text;
begin
  foreach table_name in array array['intelligence_binding_heads', 'intelligence_binding_revisions', 'intelligence_configuration_checks', 'intelligence_events'] loop
    execute format('alter table harness_admin.%I enable row level security', table_name);
    execute format('alter table harness_admin.%I force row level security', table_name);
    execute format('create policy tenant_scope on harness_admin.%I using (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')) with check (tenant_id = nullif(current_setting(''app.tenant_id'', true), ''''))', table_name);
  end loop;
end;
$$;
