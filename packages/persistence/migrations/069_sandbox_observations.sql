alter table harness_runtime.runs add column sandbox_capture boolean not null default false;

create table harness_control.sandbox_observations (
  tenant_id text not null,
  run_id text not null references harness_runtime.runs(run_id) on delete cascade,
  node_id text not null,
  attempt integer not null,
  fencing_epoch bigint not null,
  kind text not null check (kind in ('context', 'skill', 'documents')),
  observation_key text not null,
  invocation_id text,
  version integer not null default 1 check (version = 1),
  data jsonb not null check (octet_length(data::text) <= 16384),
  sequence bigint generated always as identity,
  recorded_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '14 days'),
  primary key (tenant_id, run_id, node_id, attempt, fencing_epoch, kind, observation_key)
);
create index sandbox_observations_feed on harness_control.sandbox_observations (tenant_id, run_id, kind, sequence);
create index sandbox_observations_expiry on harness_control.sandbox_observations (expires_at);
alter table harness_control.sandbox_observations enable row level security;
alter table harness_control.sandbox_observations force row level security;
create policy tenant_scope on harness_control.sandbox_observations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''));

-- A fixed cleanup operation. The service has no cross-tenant read access to capture rows.
create function harness_control.prune_sandbox_observations() returns void
language sql security definer set search_path = pg_catalog as $$
  delete from harness_control.sandbox_observations
  where expires_at <= now()
$$;
revoke all on function harness_control.prune_sandbox_observations() from public;

create table harness_control.sandbox_observation_reads (
  tenant_id text not null,
  run_id text not null references harness_runtime.runs(run_id) on delete cascade,
  actor text not null,
  kind text not null,
  node_id text,
  attempt integer,
  fencing_epoch bigint,
  recorded_at timestamptz not null default now()
);
alter table harness_control.sandbox_observation_reads enable row level security;
alter table harness_control.sandbox_observation_reads force row level security;
create policy tenant_scope on harness_control.sandbox_observation_reads
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
