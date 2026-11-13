-- Canonical records: immutable, versioned business records (RegistryRecord, WatchlistEntry,
-- OwnershipInterest, ...) aligned to the skill library's Record schema. Written only by the
-- RecordCanonicalRecords business command (ledger event records.recorded); read into canonical
-- snapshots under data.records.<ObjectType>. See docs/implementation/canonical-records.md.
create table if not exists {{CASE_CORE_SCHEMA}}.canonical_records (
  tenant_id text not null,
  case_id text not null,
  object_type text not null,
  object_id text not null,
  version_id text not null,
  schema_version text not null,
  data jsonb not null,
  subject_ids jsonb not null default '[]'::jsonb,
  valid_from timestamptz,
  valid_to timestamptz,
  observed_at timestamptz not null,
  recorded_at timestamptz not null,
  source_refs jsonb not null default '[]'::jsonb,
  provenance jsonb not null,
  classification text not null,
  purposes jsonb not null default '[]'::jsonb,
  synthetic boolean not null,
  supersedes text,
  record_digest char(64) not null,
  -- The record exactly as digested; snapshots return it rather than re-assembling columns.
  document jsonb not null,
  case_sequence bigint not null,
  primary key (tenant_id, case_id, object_type, object_id, version_id),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id),
  check (object_type ~ '^[A-Z][A-Za-z0-9]{0,63}$'),
  check (valid_to is null or valid_from is null or valid_from < valid_to),
  check (supersedes is null or supersedes <> version_id)
);

create index if not exists canonical_records_type_idx
  on {{CASE_CORE_SCHEMA}}.canonical_records(tenant_id, case_id, object_type, recorded_at);

-- Versions are immutable: supersession is a new version, never an update or a delete.
create or replace function {{CASE_CORE_SCHEMA}}.canonical_records_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'canonical_records are immutable; record a new version instead' using errcode = '55000';
end;
$$;

drop trigger if exists canonical_records_immutable on {{CASE_CORE_SCHEMA}}.canonical_records;
create trigger canonical_records_immutable
  before update or delete on {{CASE_CORE_SCHEMA}}.canonical_records
  for each row execute function {{CASE_CORE_SCHEMA}}.canonical_records_immutable();

-- Tenant isolation as on the platform's tenant tables: the case store sets app.tenant_id for
-- the transaction that reads or writes records.
alter table {{CASE_CORE_SCHEMA}}.canonical_records enable row level security;
alter table {{CASE_CORE_SCHEMA}}.canonical_records force row level security;
drop policy if exists canonical_records_tenant_scope on {{CASE_CORE_SCHEMA}}.canonical_records;
create policy canonical_records_tenant_scope on {{CASE_CORE_SCHEMA}}.canonical_records
  using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
