-- Control-plane tenancy.
--
-- The case store has always been tenant-scoped; plans, runs and drafts were not, so
-- there was nothing for an authenticated principal's tenant assignment to scope against.
-- Existing rows are backfilled to the POC tenant, then the default is dropped so new
-- rows must state their tenant explicitly.
alter table harness_control.plans
  add column if not exists tenant_id text not null default 'tenant_demo';
alter table harness_control.plans alter column tenant_id drop default;

alter table harness_runtime.runs
  add column if not exists tenant_id text not null default 'tenant_demo';
alter table harness_runtime.runs alter column tenant_id drop default;

alter table harness_control.authoring_drafts
  add column if not exists tenant_id text not null default 'tenant_demo';
alter table harness_control.authoring_drafts alter column tenant_id drop default;

create index if not exists plans_tenant_idx on harness_control.plans(tenant_id, admitted_at desc);
create index if not exists runs_tenant_idx on harness_runtime.runs(tenant_id, updated_at desc);
create index if not exists authoring_drafts_tenant_idx
  on harness_control.authoring_drafts(tenant_id, updated_at desc);

-- Separation of duties.
--
-- approved_by was recorded but never compared with anyone, so one identity could author,
-- evaluate, approve and publish its own plan. The authoring event log already names every
-- actor who touched a draft; this index makes the contributor lookup that the approval
-- check performs cheap.
create index if not exists authoring_events_actor_idx
  on harness_control.authoring_events(draft_id, event_type, actor);

alter table harness_control.authoring_drafts
  add column if not exists published_by text;
