-- Review details supplement immutable extracted assertions; they never promote a fact.
alter table {{CASE_CORE_SCHEMA}}.case_reviews
  add column if not exists details jsonb;
create index if not exists document_reviews_version_idx
  on {{CASE_CORE_SCHEMA}}.case_reviews(tenant_id, case_id, object_ref, created_at)
  where review_type = 'DOCUMENT_EXTRACTION';
