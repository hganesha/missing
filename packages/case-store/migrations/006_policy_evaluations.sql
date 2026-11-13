alter table {{CASE_CORE_SCHEMA}}.cases add column if not exists policy_id text;
alter table {{CASE_CORE_SCHEMA}}.cases add column if not exists policy_version text;
alter table {{CASE_CORE_SCHEMA}}.cases add column if not exists policy_bundle_digest text;
alter table {{CASE_CORE_SCHEMA}}.cases add column if not exists dependency_digest text;
create table if not exists {{CASE_CORE_SCHEMA}}.policy_evaluations (
  tenant_id text not null, case_id text not null, evaluation_id text not null,
  receipt_digest char(64) not null, case_sequence bigint not null,
  document jsonb not null, created_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id,case_id,evaluation_id),
  foreign key (tenant_id,case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id,case_id)
);
