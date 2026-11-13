-- Retention and legal holds for evidence (docs/implementation/data-stores-plan.md §3.6, phase 5).
--
-- Every registered evidence object gets a retention assignment from its class's rule. Classes
-- that run from case closure have no date until the case closes; the retention job fills it in
-- and applies the longest date any assignment asks for to the blob, never shortening it. A
-- legal hold names cases; every artifact of those cases (including evidence registered while
-- the hold is active) becomes a hold target, and the job sets the blob's legal hold. Matter
-- details stay with legal: the hold carries an opaque reference only.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ehf_svc_evidence_retention') then
    create role ehf_svc_evidence_retention nologin;  -- the retention and legal hold job
  end if;
end $$;

-- The rules. Not tenant data: one table, administered by migration.
create table if not exists {{EVIDENCE_SCHEMA}}.retention_rules (
  retention_class text primary key,
  starts_at text not null check (starts_at in ('CASE_CLOSED', 'REGISTERED')),
  keep interval not null check (keep > interval '0'),
  -- Locked retention cannot be shortened or removed by anyone, storage administrators included.
  lock_policy boolean not null
);

insert into {{EVIDENCE_SCHEMA}}.retention_rules(retention_class, starts_at, keep, lock_policy) values
  ('KYC_REGULATED', 'CASE_CLOSED', interval '7 years', true),
  ('DECISION_RECORD', 'CASE_CLOSED', interval '7 years', true),
  ('EXECUTION_SUPPORT', 'CASE_CLOSED', interval '2 years', false),
  ('TRANSIENT_UPLOAD', 'REGISTERED', interval '1 day', false),
  ('QUARANTINE', 'REGISTERED', interval '90 days', false)
on conflict (retention_class) do update set
  starts_at = excluded.starts_at, keep = excluded.keep, lock_policy = excluded.lock_policy;

-- Earlier rows may carry other classes; new rows may not.
alter table {{EVIDENCE_SCHEMA}}.evidence_objects drop constraint if exists evidence_objects_retention_class_known;
alter table {{EVIDENCE_SCHEMA}}.evidence_objects add constraint evidence_objects_retention_class_known
  foreign key (retention_class) references {{EVIDENCE_SCHEMA}}.retention_rules(retention_class) not valid;

-- What storage was last told, per artifact (one blob per tenant and digest).
alter table {{EVIDENCE_SCHEMA}}.artifacts
  add column if not exists retain_until timestamptz,
  add column if not exists retention_state text not null default 'PENDING',
  add column if not exists legal_hold_state text not null default 'NONE',
  add column if not exists governed_at timestamptz;
alter table {{EVIDENCE_SCHEMA}}.artifacts drop constraint if exists artifacts_retention_state;
alter table {{EVIDENCE_SCHEMA}}.artifacts add constraint artifacts_retention_state
  check (retention_state in ('PENDING', 'APPLIED', 'LOCKED', 'NOT_ENFORCED', 'FAILED'));
alter table {{EVIDENCE_SCHEMA}}.artifacts drop constraint if exists artifacts_legal_hold_state;
alter table {{EVIDENCE_SCHEMA}}.artifacts add constraint artifacts_legal_hold_state
  check (legal_hold_state in ('NONE', 'HELD', 'NOT_ENFORCED', 'FAILED'));

create table if not exists {{EVIDENCE_SCHEMA}}.retention_assignments (
  tenant_id text not null,
  evidence_id text not null,
  case_id text not null,
  artifact_digest text not null,
  retention_class text not null references {{EVIDENCE_SCHEMA}}.retention_rules(retention_class),
  basis text not null check (basis in ('CASE_CLOSED', 'REGISTERED')),
  basis_at timestamptz,               -- registration, or the case's (latest) closure
  retain_until timestamptz,           -- null until the basis event; only ever moves later
  assigned_by text not null,
  assigned_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, evidence_id),
  foreign key (tenant_id, evidence_id) references {{EVIDENCE_SCHEMA}}.evidence_objects(tenant_id, evidence_id),
  foreign key (tenant_id, artifact_digest) references {{EVIDENCE_SCHEMA}}.artifacts(tenant_id, artifact_digest),
  check ((basis_at is null) = (retain_until is null))
);
create index if not exists retention_assignments_pending_idx
  on {{EVIDENCE_SCHEMA}}.retention_assignments(tenant_id, case_id) where retain_until is null;
create index if not exists retention_assignments_artifact_idx
  on {{EVIDENCE_SCHEMA}}.retention_assignments(tenant_id, artifact_digest);

create table if not exists {{EVIDENCE_SCHEMA}}.legal_holds (
  tenant_id text not null,
  hold_id text not null,
  matter_ref text not null,           -- opaque; matter detail lives with legal, not here
  case_ids text[] not null check (cardinality(case_ids) between 1 and 500),
  authority jsonb not null,
  placed_by text not null,
  placed_at timestamptz not null default clock_timestamp(),
  released_by text,
  released_at timestamptz,
  release_authority jsonb,
  primary key (tenant_id, hold_id),
  -- Two people: whoever placed a hold cannot release it.
  check (released_by is null or released_by <> placed_by),
  check ((released_by is null) = (released_at is null) and (released_by is null) = (release_authority is null))
);
create index if not exists legal_holds_active_idx
  on {{EVIDENCE_SCHEMA}}.legal_holds using gin (case_ids) where released_at is null;

create table if not exists {{EVIDENCE_SCHEMA}}.legal_hold_targets (
  tenant_id text not null,
  hold_id text not null,
  artifact_digest text not null,
  storage_state text not null default 'PENDING'
    check (storage_state in ('PENDING', 'APPLIED', 'NOT_ENFORCED', 'FAILED', 'RELEASED')),
  added_at timestamptz not null default clock_timestamp(),
  applied_at timestamptz,
  primary key (tenant_id, hold_id, artifact_digest),
  foreign key (tenant_id, hold_id) references {{EVIDENCE_SCHEMA}}.legal_holds(tenant_id, hold_id),
  foreign key (tenant_id, artifact_digest) references {{EVIDENCE_SCHEMA}}.artifacts(tenant_id, artifact_digest)
);
create index if not exists legal_hold_targets_open_idx
  on {{EVIDENCE_SCHEMA}}.legal_hold_targets(tenant_id, storage_state) where storage_state <> 'RELEASED';

-- A hold is a record: nothing is deleted, and the only change is its release, once.
create or replace function {{EVIDENCE_SCHEMA}}.legal_holds_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'evidence.legal_hold_immutable: holds are released, never deleted' using errcode = 'insufficient_privilege';
  end if;
  if old.released_at is not null then
    raise exception 'evidence.legal_hold_released: a released hold cannot change' using errcode = 'check_violation';
  end if;
  if (new.tenant_id, new.hold_id, new.matter_ref, new.case_ids, new.authority, new.placed_by, new.placed_at)
     is distinct from (old.tenant_id, old.hold_id, old.matter_ref, old.case_ids, old.authority, old.placed_by, old.placed_at) then
    raise exception 'evidence.legal_hold_immutable: only the release may be recorded' using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists legal_holds_guard on {{EVIDENCE_SCHEMA}}.legal_holds;
create trigger legal_holds_guard before update or delete on {{EVIDENCE_SCHEMA}}.legal_holds
  for each row execute function {{EVIDENCE_SCHEMA}}.legal_holds_guard();

-- An assignment's date only moves later, and nothing else about it changes.
create or replace function {{EVIDENCE_SCHEMA}}.retention_assignments_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'evidence.retention_immutable: assignments are never deleted' using errcode = 'insufficient_privilege';
  end if;
  if (new.tenant_id, new.evidence_id, new.case_id, new.artifact_digest, new.retention_class, new.basis, new.assigned_by, new.assigned_at)
     is distinct from (old.tenant_id, old.evidence_id, old.case_id, old.artifact_digest, old.retention_class, old.basis, old.assigned_by, old.assigned_at) then
    raise exception 'evidence.retention_immutable: only the date may be set' using errcode = 'check_violation';
  end if;
  if old.retain_until is not null and (new.retain_until is null or new.retain_until < old.retain_until) then
    raise exception 'evidence.retention_shortened: % would end before %', new.retain_until, old.retain_until using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists retention_assignments_guard on {{EVIDENCE_SCHEMA}}.retention_assignments;
create trigger retention_assignments_guard before update or delete on {{EVIDENCE_SCHEMA}}.retention_assignments
  for each row execute function {{EVIDENCE_SCHEMA}}.retention_assignments_guard();

-- Registration assigns retention and joins any active hold over the case, in the same
-- transaction, whichever path registered the evidence.
create or replace function {{EVIDENCE_SCHEMA}}.govern_new_evidence() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
declare
  rule record;
  digest text;
begin
  select r.starts_at, r.keep into rule from {{EVIDENCE_SCHEMA}}.retention_rules r where r.retention_class = new.retention_class;
  if not found then
    raise exception 'evidence.retention_class_unknown: %', new.retention_class using errcode = 'check_violation';
  end if;
  select a.artifact_digest into strict digest from {{EVIDENCE_SCHEMA}}.artifacts a
    where a.tenant_id = new.tenant_id and a.artifact_ref = new.artifact_ref;
  insert into {{EVIDENCE_SCHEMA}}.retention_assignments(
    tenant_id, evidence_id, case_id, artifact_digest, retention_class, basis, basis_at, retain_until, assigned_by)
  values (new.tenant_id, new.evidence_id, new.case_id, digest, new.retention_class, rule.starts_at,
    case when rule.starts_at = 'REGISTERED' then new.created_at end,
    case when rule.starts_at = 'REGISTERED' then new.created_at + rule.keep end,
    coalesce(new.created_by->>'principalId', 'unknown'));
  insert into {{EVIDENCE_SCHEMA}}.legal_hold_targets(tenant_id, hold_id, artifact_digest)
    select h.tenant_id, h.hold_id, digest from {{EVIDENCE_SCHEMA}}.legal_holds h
    where h.tenant_id = new.tenant_id and h.released_at is null and h.case_ids @> array[new.case_id]
  on conflict (tenant_id, hold_id, artifact_digest) do nothing;
  return new;
end $$;
drop trigger if exists govern_new_evidence on {{EVIDENCE_SCHEMA}}.evidence_objects;
create trigger govern_new_evidence after insert on {{EVIDENCE_SCHEMA}}.evidence_objects
  for each row execute function {{EVIDENCE_SCHEMA}}.govern_new_evidence();

-- Evidence registered before this migration: assign from its class where the class is known.
insert into {{EVIDENCE_SCHEMA}}.retention_assignments(
  tenant_id, evidence_id, case_id, artifact_digest, retention_class, basis, basis_at, retain_until, assigned_by)
select e.tenant_id, e.evidence_id, e.case_id, a.artifact_digest, e.retention_class, r.starts_at,
  case when r.starts_at = 'REGISTERED' then e.created_at end,
  case when r.starts_at = 'REGISTERED' then e.created_at + r.keep end,
  'migration:016'
from {{EVIDENCE_SCHEMA}}.evidence_objects e
join {{EVIDENCE_SCHEMA}}.artifacts a on a.tenant_id = e.tenant_id and a.artifact_ref = e.artifact_ref
join {{EVIDENCE_SCHEMA}}.retention_rules r on r.retention_class = e.retention_class
on conflict (tenant_id, evidence_id) do nothing;

do $$
declare
  target text;
begin
  foreach target in array array['retention_assignments', 'legal_holds', 'legal_hold_targets'] loop
    execute format('alter table {{EVIDENCE_SCHEMA}}.%I enable row level security', target);
    execute format('alter table {{EVIDENCE_SCHEMA}}.%I force row level security', target);
    execute format('drop policy if exists case_tenant_scope on {{EVIDENCE_SCHEMA}}.%I', target);
    execute format($policy$
      create policy case_tenant_scope on {{EVIDENCE_SCHEMA}}.%I
      using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
    $policy$, target);
  end loop;
end $$;
