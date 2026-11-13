-- Context setup lives in the control plane; samples never write case state.
create table harness_control.context_revisions (
 tenant_id text not null, environment text not null, kind text not null check(kind in ('connection','resource','mapping')),
 id text not null, revision integer not null check(revision>0), digest text not null,
 definition jsonb not null, reason text not null, created_by text not null, created_at timestamptz not null default now(),
 primary key(tenant_id,environment,kind,id,revision), unique(tenant_id,environment,kind,id,digest)
);
create table harness_control.context_samples (
 tenant_id text not null, environment text not null, id text not null, mapping_id text not null,
 report jsonb not null, digest text not null, created_by text not null, expires_at timestamptz not null,
 primary key(tenant_id,environment,id)
);
create table harness_control.context_enablements (
 tenant_id text not null, environment text not null, mapping_id text not null, revision integer not null,
 mapping_digest text not null, report_id text not null, report_digest text not null,
 authority jsonb not null, enabled_by text not null, enabled_at timestamptz not null default now(),
 paused boolean not null default false,
 primary key(tenant_id,environment,mapping_id,revision)
);
create function harness_control.context_revision_immutable() returns trigger language plpgsql as $$
begin raise exception 'context.history_immutable'; end $$;
create trigger context_revision_immutable before update or delete on harness_control.context_revisions
for each row execute function harness_control.context_revision_immutable();
do $$ declare t text; begin
 foreach t in array array['context_revisions','context_samples','context_enablements'] loop
 execute format('alter table harness_control.%I enable row level security',t);
 execute format('alter table harness_control.%I force row level security',t);
 execute format('create policy tenant_scope on harness_control.%I using (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')) with check (tenant_id = nullif(current_setting(''app.tenant_id'',true),''''))',t);
 end loop;
end $$;
