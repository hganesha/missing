-- Catalog authoring history. Invocation routing never reads these tenant-owned proposals.
create table harness_admin.external_capability_binding_revisions (
  tenant_id text not null,
  binding_id text not null,
  revision integer not null check (revision > 0),
  definition jsonb not null,
  source_digest text not null,
  digest text not null,
  reason text not null,
  updated_at timestamptz not null default now(),
  updated_by text not null,
  primary key (tenant_id, binding_id, revision)
);
alter table harness_admin.external_capability_binding_revisions enable row level security;
alter table harness_admin.external_capability_binding_revisions force row level security;
create policy tenant_scope on harness_admin.external_capability_binding_revisions
  using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
