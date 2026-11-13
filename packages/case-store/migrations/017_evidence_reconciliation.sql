-- Storage reconciliation (docs/implementation/data-stores-plan.md §3.6, phase 5): a tenant's
-- blob inventory against its artifact rows. A run reports; it never deletes or rewrites. An
-- orphan blob is usually a registration whose database transaction failed after the bytes
-- were written; removing one is the human-gated retention enforcement skill's decision.
create table if not exists {{EVIDENCE_SCHEMA}}.reconciliation_runs (
  tenant_id text not null,
  run_id text not null,
  container text not null,
  started_at timestamptz not null default clock_timestamp(),
  finished_at timestamptz,
  checked bigint,
  verified bigint,                    -- bytes downloaded and hashed this run
  missing_blob bigint,
  orphan_blob bigint,
  length_mismatch bigint,
  digest_mismatch bigint,
  policy_mismatch bigint,
  findings jsonb,                     -- the first findings, by kind and name; no content
  primary key (tenant_id, run_id)
);
create index if not exists reconciliation_runs_recent_idx on {{EVIDENCE_SCHEMA}}.reconciliation_runs(tenant_id, started_at desc);

alter table {{EVIDENCE_SCHEMA}}.reconciliation_runs enable row level security;
alter table {{EVIDENCE_SCHEMA}}.reconciliation_runs force row level security;
drop policy if exists case_tenant_scope on {{EVIDENCE_SCHEMA}}.reconciliation_runs;
create policy case_tenant_scope on {{EVIDENCE_SCHEMA}}.reconciliation_runs
  using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
