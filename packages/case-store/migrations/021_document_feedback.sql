-- Document review feedback (document factory plan Phase 4).
--
-- 1. A work item keeps the text a skill raised it with and, for a document route conflict, the extracted
--    assertion it is about, so the document workspace can show and resolve it. Both were previously only in
--    the work_item.created event.
-- 2. document_feedback records what reviewers did with extracted values: corrections, rejections and
--    resolved route conflicts, with what each route read. It is review evidence for drift and quality
--    reporting, not training data: training_use is fixed at 'prohibited', and nothing in a release job
--    reads this table (a case document reaches training only through an explicit, revocable
--    authorization, plan §7.4). Rows are append-only.

alter table {{CASE_CORE_SCHEMA}}.case_work_items add column if not exists description text;
alter table {{CASE_CORE_SCHEMA}}.case_work_items add column if not exists subject_ref text;

create table if not exists {{CASE_CORE_SCHEMA}}.document_feedback (
  tenant_id text not null,
  case_id text not null,
  feedback_id text not null,
  review_id text not null,
  document_id text not null,
  document_version text not null,
  assertion_id text not null,
  assertion_version text not null,
  field text not null,
  kind text not null,
  outcome text not null,
  proposed_value jsonb,
  final_value jsonb,
  proposed_route text,
  adjudication jsonb,
  resolved_work_items jsonb not null default '[]'::jsonb,
  reviewer jsonb not null,
  training_use text not null default 'prohibited',
  created_at timestamptz not null,
  primary key (tenant_id, case_id, feedback_id),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id),
  constraint document_feedback_kind check (kind in ('CORRECTION', 'REJECTION', 'CONFLICT_RESOLUTION')),
  constraint document_feedback_outcome check (outcome in ('CHECKED', 'CORRECTED', 'REJECTED')),
  constraint document_feedback_not_training check (training_use = 'prohibited'),
  constraint document_feedback_version check (document_version ~ '^[a-f0-9]{64}$')
);
create index if not exists document_feedback_document on {{CASE_CORE_SCHEMA}}.document_feedback (tenant_id, document_version, created_at);

create or replace function {{CASE_CORE_SCHEMA}}.document_feedback_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'document_feedback is append-only' using errcode = '42501';
end $$;
drop trigger if exists document_feedback_append_only on {{CASE_CORE_SCHEMA}}.document_feedback;
create trigger document_feedback_append_only before update or delete on {{CASE_CORE_SCHEMA}}.document_feedback
  for each row execute function {{CASE_CORE_SCHEMA}}.document_feedback_append_only();

alter table {{CASE_CORE_SCHEMA}}.document_feedback enable row level security;
alter table {{CASE_CORE_SCHEMA}}.document_feedback force row level security;
drop policy if exists case_tenant_scope on {{CASE_CORE_SCHEMA}}.document_feedback;
create policy case_tenant_scope on {{CASE_CORE_SCHEMA}}.document_feedback
  using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
