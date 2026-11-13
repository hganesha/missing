alter table {{CASE_CORE_SCHEMA}}.cases add column if not exists decision_contract_version integer not null default 1
  check (decision_contract_version in (1,2));

create table if not exists {{CASE_CORE_SCHEMA}}.policy_snapshot_reads (
  tenant_id text not null, case_id text not null, read_receipt_id text not null,
  plan_digest text not null, node_id text not null, purpose text not null,
  case_sequence bigint not null, snapshot_digest text not null, captured_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id,read_receipt_id),
  foreign key (tenant_id,case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id,case_id)
);

create table if not exists {{CASE_CORE_SCHEMA}}.business_decisions (
  tenant_id text not null, case_id text not null, decision_id text not null,
  receipt_digest char(64) not null, case_sequence bigint not null, receipt jsonb not null, input jsonb not null,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id,case_id,decision_id),
  foreign key (tenant_id,case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id,case_id)
);
create table if not exists {{CASE_CORE_SCHEMA}}.business_action_consumptions (
  tenant_id text not null, case_id text not null, decision_id text not null,
  action_index integer not null check (action_index >= 0 and action_index < 200),
  action_digest char(64) not null, result jsonb not null,
  primary key (tenant_id,case_id,decision_id,action_index),
  foreign key (tenant_id,case_id,decision_id) references {{CASE_CORE_SCHEMA}}.business_decisions(tenant_id,case_id,decision_id)
);
create table if not exists {{CASE_CORE_SCHEMA}}.adopted_assessments (
  tenant_id text not null, case_id text not null, decision_id text not null, action_index integer not null,
  object_type text not null, object_id text not null, version_id text not null,
  interpretation text not null, value jsonb not null,
  primary key (tenant_id,case_id,decision_id,action_index),
  foreign key (tenant_id,case_id,decision_id,action_index) references {{CASE_CORE_SCHEMA}}.business_action_consumptions(tenant_id,case_id,decision_id,action_index)
    deferrable initially deferred
);
create table if not exists {{CASE_CORE_SCHEMA}}.business_effect_outbox (
  tenant_id text not null, case_id text not null, decision_id text not null, action_index integer not null,
  action_digest char(64) not null, action jsonb not null,
  status text not null default 'PENDING' check (status in ('PENDING','DELIVERED','CANCELLED','RECONCILIATION')),
  provider_receipt jsonb,
  primary key (tenant_id,case_id,decision_id,action_index),
  foreign key (tenant_id,case_id,decision_id,action_index) references {{CASE_CORE_SCHEMA}}.business_action_consumptions(tenant_id,case_id,decision_id,action_index)
    deferrable initially deferred
);
create table if not exists {{CASE_CORE_SCHEMA}}.business_human_responses (
  tenant_id text not null, case_id text not null, decision_id text not null,
  response_id text not null, principal_id text not null, response jsonb not null,
  primary key (tenant_id,case_id,response_id),
  unique (tenant_id,case_id,decision_id,principal_id),
  foreign key (tenant_id,case_id,decision_id) references {{CASE_CORE_SCHEMA}}.business_decisions(tenant_id,case_id,decision_id)
);
do $$ declare relation_name text; begin
  foreach relation_name in array array['business_decisions','business_action_consumptions','adopted_assessments','business_effect_outbox','business_human_responses','policy_snapshot_reads'] loop
    execute format('alter table {{CASE_CORE_SCHEMA}}.%I enable row level security', relation_name);
    execute format('alter table {{CASE_CORE_SCHEMA}}.%I force row level security', relation_name);
    execute format('drop policy if exists tenant_scope on {{CASE_CORE_SCHEMA}}.%I', relation_name);
    execute format('create policy tenant_scope on {{CASE_CORE_SCHEMA}}.%I using (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')) with check (tenant_id = nullif(current_setting(''app.tenant_id'',true),''''))', relation_name);
  end loop;
end $$;

do $$ declare relation_name text; begin
  foreach relation_name in array array['business_decisions','business_action_consumptions','adopted_assessments','business_human_responses'] loop
    execute format('drop trigger if exists business_authority_immutable on {{CASE_CORE_SCHEMA}}.%I', relation_name);
    execute format('create trigger business_authority_immutable before update or delete or truncate on {{CASE_CORE_SCHEMA}}.%I for each statement execute function {{CASE_CORE_SCHEMA}}.canonical_records_immutable()', relation_name);
  end loop;
end $$;

-- Read proofs are short-lived transport authority. Business decision inputs remain in
-- the immutable decision ledger; expired unused read tokens need no business retention.
create index if not exists policy_snapshot_read_expiry on {{CASE_CORE_SCHEMA}}.policy_snapshot_reads(tenant_id,created_at);
create or replace function {{CASE_CORE_SCHEMA}}.purge_expired_policy_reads() returns integer
language plpgsql security definer set search_path=pg_catalog as $$
declare removed integer;
begin
  delete from {{CASE_CORE_SCHEMA}}.policy_snapshot_reads where (tenant_id,read_receipt_id) in (
    select tenant_id,read_receipt_id from {{CASE_CORE_SCHEMA}}.policy_snapshot_reads
      where tenant_id=nullif(current_setting('app.tenant_id',true),'') and created_at<clock_timestamp()-interval '5 minutes'
      order by created_at limit 100 for update skip locked);
  get diagnostics removed = row_count;
  return removed;
end $$;
revoke all on function {{CASE_CORE_SCHEMA}}.purge_expired_policy_reads() from public;
