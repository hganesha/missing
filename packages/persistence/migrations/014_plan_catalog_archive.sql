alter table harness_control.plans
  add column if not exists archived_at timestamptz;

create index if not exists plans_active_tenant_admitted_idx
  on harness_control.plans (tenant_id, admitted_at desc, plan_digest desc)
  where archived_at is null;

alter table harness_control.authoring_drafts
  add column if not exists archived_at timestamptz;

create index if not exists authoring_drafts_active_tenant_updated_idx
  on harness_control.authoring_drafts (tenant_id, updated_at desc)
  where archived_at is null;
