-- Tenant-scoped snapshot refresh. A checkpoint accounts for completed schedule slots,
-- not source offsets or CDC watermarks. Source reads and case writes use normal runs.
create table harness_control.context_refresh_schedules (
 tenant_id text not null, environment text not null, id text not null, revision integer not null,
 definition jsonb not null, digest text not null, reason text not null, created_by text not null,
 created_at timestamptz not null default now(), primary key(tenant_id,environment,id,revision)
);
create trigger context_refresh_schedule_immutable before update or delete on harness_control.context_refresh_schedules
 for each row execute function harness_control.context_revision_immutable();
create table harness_control.context_refresh_state (
 tenant_id text not null, environment text not null, id text not null, revision integer not null,
 next_due timestamptz not null, completed_through timestamptz, last_success_at timestamptz,
 primary key(tenant_id,environment,id,revision),
 foreign key(tenant_id,environment,id,revision) references harness_control.context_refresh_schedules
);
create table harness_control.context_refresh_batches (
 tenant_id text not null, environment text not null, schedule_id text not null, revision integer not null,
 slot timestamptz not null, attempt integer not null check(attempt between 1 and 3),
 status text not null check(status in ('PENDING','RUNNING','COMPLETED','QUARANTINED')),
 run_id text, error_code text, completed_at timestamptz, receipt_digest text,
 created_at timestamptz not null default now(),
 primary key(tenant_id,environment,schedule_id,revision,slot,attempt),
 foreign key(tenant_id,environment,schedule_id,revision) references harness_control.context_refresh_schedules
);
do $$ declare t text; begin
 foreach t in array array['context_refresh_schedules','context_refresh_state','context_refresh_batches'] loop
 execute format('alter table harness_control.%I enable row level security',t);
 execute format('alter table harness_control.%I force row level security',t);
 execute format('create policy tenant_scope on harness_control.%I using (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')) with check (tenant_id=nullif(current_setting(''app.tenant_id'',true),''''))',t);
 end loop;
end $$;
