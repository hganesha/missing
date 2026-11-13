alter table {{CASE_LEDGER_SCHEMA}}.outbox
  add column if not exists publish_claim_id text,
  add column if not exists publish_claimed_at timestamptz;

alter table {{EVIDENCE_SCHEMA}}.outbox
  add column if not exists publish_claim_id text,
  add column if not exists publish_claimed_at timestamptz;

create index if not exists case_outbox_claimable_idx
  on {{CASE_LEDGER_SCHEMA}}.outbox(created_at)
  where published_at is null;

create index if not exists evidence_outbox_claimable_idx
  on {{EVIDENCE_SCHEMA}}.outbox(created_at)
  where published_at is null;
