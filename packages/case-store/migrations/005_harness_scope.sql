create index if not exists cases_harness_scope_idx
  on {{CASE_CORE_SCHEMA}}.cases(tenant_id, harness_plan_digest, updated_at desc, case_id desc);
