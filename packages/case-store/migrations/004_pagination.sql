create index if not exists cases_tenant_page_idx
  on {{CASE_CORE_SCHEMA}}.cases (tenant_id, updated_at desc, case_id desc);
