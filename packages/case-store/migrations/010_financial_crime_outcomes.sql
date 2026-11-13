create table {{CASE_CORE_SCHEMA}}.financial_crime_outcomes (
  tenant_id text not null, case_id text not null, work_item_id text not null, execution_id text not null,
  skill_id text not null, skill_version text not null, basis_case_sequence bigint not null,
  outcome jsonb not null, outcome_digest char(64) not null, context_digest text,
  recorded_by jsonb not null, recorded_at timestamptz not null,
  primary key (tenant_id,case_id,work_item_id,execution_id),
  foreign key (tenant_id,case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id,case_id)
);
alter table {{CASE_CORE_SCHEMA}}.financial_crime_outcomes enable row level security;
alter table {{CASE_CORE_SCHEMA}}.financial_crime_outcomes force row level security;
create policy fincrime_outcome_tenant on {{CASE_CORE_SCHEMA}}.financial_crime_outcomes
  using (tenant_id=nullif(current_setting('app.tenant_id',true),''))
  with check (tenant_id=nullif(current_setting('app.tenant_id',true),''));
