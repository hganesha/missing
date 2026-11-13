alter table {{CASE_CORE_SCHEMA}}.case_decision_recommendations
  add column if not exists policy_rule_refs jsonb not null default '[]'::jsonb,
  add column if not exists confidence numeric,
  add column if not exists requires_human_review boolean;
