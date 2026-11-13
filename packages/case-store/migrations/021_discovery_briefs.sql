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
  primary key (tenant_id, case_id, subject_id, intake_decision_id, subject_revision),
  foreign key (tenant_id, case_id, subject_id)
    references {{CASE_CORE_SCHEMA}}.case_subjects(tenant_id, case_id, subject_id),
  foreign key (tenant_id, case_id, intake_decision_id)
    references {{CASE_CORE_SCHEMA}}.business_decisions(tenant_id, case_id, decision_id)
);

create index if not exists discovery_briefs_latest
  on case_discovery.briefs (tenant_id, case_id, recorded_at desc);

alter table case_discovery.briefs enable row level security;
alter table case_discovery.briefs force row level security;
drop policy if exists tenant_scope on case_discovery.briefs;
create policy tenant_scope on case_discovery.briefs
  using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
