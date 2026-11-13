-- Production governance and human-operations state.
--
-- Compiled artifacts are immutable. Mutable lifecycle state is kept in a separate
-- record with an append-only event trail so approval, activation, revocation and
-- rollback never rewrite the artifact that was reviewed and signed.

create table if not exists harness_control.policy_revisions (
  tenant_id text not null,
  workspace_id text not null,
  revision integer not null check (revision > 0),
  status text not null check (status in ('DRAFT','COMPILED','APPROVED','PUBLISHED','SUPERSEDED')),
  files jsonb not null,
  source_digest char(64) not null check (source_digest ~ '^[a-f0-9]{64}$'),
  compiled_bundle jsonb,
  bundle_digest char(64),
  release_blockers jsonb not null default '[]'::jsonb,
  authored_by text not null,
  approved_by text,
  published_by text,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, workspace_id, revision),
  unique (tenant_id, workspace_id, source_digest),
  check ((status in ('COMPILED','APPROVED','PUBLISHED')) = (compiled_bundle is not null)),
  check ((compiled_bundle is null and bundle_digest is null) or
         (compiled_bundle is not null and bundle_digest ~ '^[a-f0-9]{64}$')),
  check (approved_by is null or approved_by <> authored_by),
  check (published_by is null or published_by <> authored_by)
);

create table if not exists harness_control.policy_revision_events (
  event_id text primary key,
  tenant_id text not null,
  workspace_id text not null,
  revision integer not null,
  event_type text not null,
  actor text not null,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default transaction_timestamp(),
  foreign key (tenant_id, workspace_id, revision)
    references harness_control.policy_revisions(tenant_id, workspace_id, revision)
);

create table if not exists harness_control.release_manifests (
  tenant_id text not null,
  release_id text not null,
  manifest_digest char(64) not null check (manifest_digest ~ '^[a-f0-9]{64}$'),
  plan_digest char(64) not null check (plan_digest ~ '^[a-f0-9]{64}$'),
  manifest jsonb not null,
  status text not null check (status in ('candidate','approved','active','deprecated','revoked')),
  revision integer not null default 0 check (revision >= 0),
  reason_code text,
  created_by text not null,
  approved_by text,
  activated_at timestamptz,
  deprecated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, release_id),
  unique (tenant_id, manifest_digest),
  check (approved_by is null or approved_by <> created_by),
  check ((status = 'active') = (activated_at is not null)),
  check ((status = 'revoked') = (revoked_at is not null))
);

create table if not exists harness_control.release_events (
  event_id text primary key,
  tenant_id text not null,
  release_id text not null,
  revision integer not null,
  from_status text,
  to_status text not null,
  actor text not null,
  reason_code text,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default transaction_timestamp(),
  foreign key (tenant_id, release_id)
    references harness_control.release_manifests(tenant_id, release_id)
);

-- Sticky cohort allocation: once a subject enters a canary cohort it remains bound
-- to that exact release until an explicit rollback/retirement operation changes it.
create table if not exists harness_control.release_allocations (
  tenant_id text not null,
  environment text not null,
  subject_key text not null,
  release_id text not null,
  cohort text not null,
  allocated_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, environment, subject_key),
  foreign key (tenant_id, release_id)
    references harness_control.release_manifests(tenant_id, release_id)
);

-- A human decision is immutable. Dual control is represented by two decisions from
-- distinct principals; the effective decision is derived, never overwritten.
create table if not exists workflow.human_decisions (
  tenant_id text not null,
  case_id text not null,
  work_item_id text not null,
  decision_id text not null,
  principal_id text not null,
  decision text not null check (decision in ('APPROVE','REJECT','RETURN')),
  reason_code text not null,
  rationale text not null,
  evidence_refs jsonb not null default '[]'::jsonb,
  decided_at timestamptz not null,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, decision_id),
  unique (tenant_id, work_item_id, principal_id),
  foreign key (tenant_id, case_id, work_item_id)
    references workflow.work_items(tenant_id, case_id, work_item_id) on delete cascade
);

create index if not exists policy_revisions_recent_idx
  on harness_control.policy_revisions(tenant_id, workspace_id, revision desc);
create index if not exists policy_revision_events_recent_idx
  on harness_control.policy_revision_events(tenant_id, workspace_id, occurred_at desc);
create index if not exists release_manifests_status_idx
  on harness_control.release_manifests(tenant_id, status, updated_at desc);
create index if not exists release_events_recent_idx
  on harness_control.release_events(tenant_id, release_id, occurred_at desc);
create index if not exists human_queue_idx
  on workflow.work_items(tenant_id, priority desc, deadline_at, updated_at)
  where status in ('HUMAN_REQUIRED','WAITING_HUMAN');
create index if not exists human_decisions_work_idx
  on workflow.human_decisions(tenant_id, work_item_id, decided_at);

do $$
declare
  relation_name text;
begin
  foreach relation_name in array array[
    'policy_revisions', 'policy_revision_events', 'release_manifests',
    'release_events', 'release_allocations'
  ] loop
    execute format('alter table harness_control.%I enable row level security', relation_name);
    execute format('alter table harness_control.%I force row level security', relation_name);
    execute format('drop policy if exists harness_control_tenant_scope on harness_control.%I', relation_name);
    execute format($policy$
      create policy harness_control_tenant_scope on harness_control.%I
      using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
    $policy$, relation_name);
  end loop;
end $$;

alter table workflow.human_decisions enable row level security;
alter table workflow.human_decisions force row level security;
drop policy if exists workflow_tenant_scope on workflow.human_decisions;
create policy workflow_tenant_scope on workflow.human_decisions
using (
  tenant_id = nullif(current_setting('app.tenant_id', true), '')
  or current_setting('app.workflow_controller', true) = 'true'
)
with check (
  tenant_id = nullif(current_setting('app.tenant_id', true), '')
  or current_setting('app.workflow_controller', true) = 'true'
);
