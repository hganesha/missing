create schema if not exists case_discovery;

create table if not exists case_discovery.briefs (
  tenant_id text not null,
  case_id text not null,
  subject_id text not null,
  intake_decision_id text not null,
  subject_revision integer not null check (subject_revision > 0),
  parent_plan_digest text not null check (parent_plan_digest ~ '^[a-f0-9]{64}$'),
  recorded_at timestamptz not null,
  brief jsonb not null check (jsonb_typeof(brief) = 'object' and octet_length(brief::text) <= 98304),
  primary key (tenant_id, case_id, subject_id, intake_decision_id, subject_revision)
);

create index if not exists discovery_briefs_latest
  on case_discovery.briefs (tenant_id, case_id, recorded_at desc);

alter table case_discovery.briefs enable row level security;
alter table case_discovery.briefs force row level security;
drop policy if exists tenant_scope on case_discovery.briefs;
create policy tenant_scope on case_discovery.briefs
  using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''));


-- Case and receipt identifiers are validated by the trusted publisher before insertion.
-- PostgreSQL foreign keys cannot reference another database.
do $$
declare role_name text;
begin
  foreach role_name in array array['ehf_svc_discovery_reader','ehf_svc_discovery_writer'] loop
    if not exists (select 1 from pg_roles where rolname = role_name) then
      execute format('create role %I nologin', role_name);
    end if;
  end loop;
  execute format('revoke all on database %I from public, ehf_svc_discovery_reader, ehf_svc_discovery_writer', current_database());
  execute format('grant connect on database %I to ehf_svc_discovery_reader, ehf_svc_discovery_writer', current_database());
end;
$$;

revoke all on schema case_discovery from public, ehf_svc_discovery_reader, ehf_svc_discovery_writer;
revoke all on all tables in schema case_discovery from public, ehf_svc_discovery_reader, ehf_svc_discovery_writer;
grant usage on schema case_discovery to ehf_svc_discovery_reader, ehf_svc_discovery_writer;
grant select on case_discovery.briefs to ehf_svc_discovery_reader;
grant select, insert on case_discovery.briefs to ehf_svc_discovery_writer;

-- Keep the manual rehearsal history alongside the hosted advisory result.
alter table case_discovery.briefs add column if not exists origin text not null default 'synthetic_fixture';
alter table case_discovery.briefs drop constraint if exists briefs_origin_check;
alter table case_discovery.briefs add constraint briefs_origin_check
  check (origin in ('synthetic_fixture','hosted_synthetic','openrouter_web','azure_foundry_web'));
do $$
begin
  if not exists (
    select 1 from pg_constraint where conrelid='case_discovery.briefs'::regclass and contype='p'
      and pg_get_constraintdef(oid) like '%subject_revision, origin)%'
  ) then
    alter table case_discovery.briefs drop constraint briefs_pkey;
    alter table case_discovery.briefs add primary key (tenant_id, case_id, subject_id, intake_decision_id, subject_revision, origin);
  end if;
end;
$$;

create table if not exists case_discovery.recon_jobs (
  tenant_id text not null,
  case_id text not null,
  basis text not null check (basis ~ '^[a-f0-9]{64}$'),
  parent_plan_digest text not null check (parent_plan_digest ~ '^[a-f0-9]{64}$'),
  attempt integer not null default 1 check (attempt > 0),
  status text not null default 'queued' check (status in ('queued','running','complete','failed')),
  parent_run_id text,
  advisory_run_id text,
  advisory_plan_digest text,
  lease_token uuid,
  lease_until timestamptz,
  next_at timestamptz not null default clock_timestamp(),
  deadline_at timestamptz not null default clock_timestamp() + interval '10 minutes',
  primary key (tenant_id, case_id, basis)
);
alter table case_discovery.recon_jobs add column if not exists mode text not null default 'synthetic'
  check (mode in ('synthetic','live'));
-- Why the last attempt failed, from the closed vocabulary in @ehf/contracts. Never provider text.
alter table case_discovery.recon_jobs add column if not exists failure_reason text
  check (failure_reason in ('timeout','provider_rejected','output_unusable','not_eligible','expired','interrupted','error'));
create index if not exists discovery_recon_ready on case_discovery.recon_jobs (tenant_id, next_at)
  where status in ('queued','running');

alter table case_discovery.recon_jobs enable row level security;
alter table case_discovery.recon_jobs force row level security;
drop policy if exists tenant_scope on case_discovery.recon_jobs;
create policy tenant_scope on case_discovery.recon_jobs
  using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''));

-- A case staff request can enqueue or retry an attempt. Only the worker can lease
-- or settle it. The case API has already checked case standing and eligibility.
create or replace function case_discovery.request_recon(p_case text, p_basis text, p_parent_plan text, p_mode text)
returns text
language plpgsql security definer set search_path = pg_catalog as $$
declare
  tenant text := nullif(current_setting('app.tenant_id', true), '');
  result text;
begin
  insert into case_discovery.recon_jobs (tenant_id,case_id,basis,parent_plan_digest,mode)
    values (tenant,p_case,p_basis,p_parent_plan,p_mode)
    on conflict (tenant_id,case_id,basis) do update
      set status='queued', attempt=recon_jobs.attempt+1, parent_run_id=null, advisory_run_id=null,
          advisory_plan_digest=null, lease_token=null, lease_until=null, failure_reason=null, next_at=clock_timestamp(),
          deadline_at=clock_timestamp()+interval '10 minutes'
      where recon_jobs.status='failed' and recon_jobs.mode=excluded.mode
    returning status into result;
  if result is null then
    select status into result from case_discovery.recon_jobs
      where tenant_id=tenant and case_id=p_case and basis=p_basis and mode=p_mode;
  end if;
  return result;
end;
$$;
revoke all on function case_discovery.request_recon(text,text,text,text) from public;
grant execute on function case_discovery.request_recon(text,text,text,text) to ehf_svc_discovery_reader;
create or replace function case_discovery.request_recon(p_case text, p_basis text, p_parent_plan text)
returns text
language sql security definer set search_path = pg_catalog as $$
  select case_discovery.request_recon(p_case,p_basis,p_parent_plan,'synthetic');
$$;
revoke all on function case_discovery.request_recon(text,text,text) from public;
grant execute on function case_discovery.request_recon(text,text,text) to ehf_svc_discovery_reader;
grant select on case_discovery.recon_jobs to ehf_svc_discovery_reader;
grant select on case_discovery.recon_jobs to ehf_svc_discovery_writer;
grant update (status,parent_run_id,advisory_run_id,advisory_plan_digest,lease_token,lease_until,next_at,failure_reason)
  on case_discovery.recon_jobs to ehf_svc_discovery_writer;
