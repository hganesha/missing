alter table harness_control.artifact_registry drop constraint if exists artifact_registry_artifact_kind_check;
alter table harness_control.artifact_registry add constraint artifact_registry_artifact_kind_check
  check (artifact_kind in ('policy-bundle','release-manifest','deployment-package','bootstrap-plan',
    'platform-release','skill-bundle','skill-qualification','source-policy','source-binding','source-access','source-context'));

create table harness_control.source_artifacts (
  tenant_id text not null,
  artifact_kind text not null check (artifact_kind in ('source-policy','source-binding','source-access','source-context')),
  digest char(64) not null check (digest ~ '^[a-f0-9]{64}$'),
  artifact jsonb not null,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, artifact_kind, digest),
  foreign key (tenant_id, artifact_kind, digest) references harness_control.artifact_registry(tenant_id, artifact_kind, digest)
);
alter table harness_control.source_artifacts enable row level security;
alter table harness_control.source_artifacts force row level security;
create policy tenant_scope on harness_control.source_artifacts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''));

create or replace function harness_control.reject_source_mutation() returns trigger language plpgsql as $$
begin
  raise exception 'source_policy.immutable' using errcode = '23514';
end $$;
create trigger source_artifact_immutable before update or delete on harness_control.source_artifacts
  for each row execute function harness_control.reject_source_mutation();

alter table harness_runtime.runs add column source_context_digest char(64)
  check (source_context_digest ~ '^[a-f0-9]{64}$');
create or replace function harness_runtime.guard_source_context() returns trigger language plpgsql as $$
begin
  if new.source_context_digest is distinct from old.source_context_digest then
    raise exception 'source_policy.run_context_immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger run_source_context_immutable before update on harness_runtime.runs
  for each row execute function harness_runtime.guard_source_context();

-- Append-only authority records include denied attempts before any capability receipt exists.
create table harness_gateway.source_decisions (
  decision_id text primary key,
  tenant_id text not null,
  run_id text not null references harness_runtime.runs(run_id),
  invocation_id text not null,
  capability_id text not null,
  connector_id text not null,
  stage text not null check (stage in ('acquire','use','transport')),
  decision_digest char(64) not null check (decision_digest ~ '^[a-f0-9]{64}$'),
  decision jsonb not null,
  observation jsonb,
  created_at timestamptz not null default transaction_timestamp()
);
create index source_decisions_lookup on harness_gateway.source_decisions(tenant_id, run_id, created_at desc, decision_id);
alter table harness_gateway.source_decisions enable row level security;
alter table harness_gateway.source_decisions force row level security;
create policy tenant_scope on harness_gateway.source_decisions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
create trigger source_decision_immutable before update or delete on harness_gateway.source_decisions
  for each row execute function harness_control.reject_source_mutation();
alter table harness_gateway.receipts add column source_decision_id text references harness_gateway.source_decisions(decision_id);
