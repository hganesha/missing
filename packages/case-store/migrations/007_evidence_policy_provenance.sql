alter table {{CASE_CORE_SCHEMA}}.case_evidence_refs add column if not exists policy_snapshot_digest text;
-- Existing links deliberately remain unknown; do not invent historical authority.
