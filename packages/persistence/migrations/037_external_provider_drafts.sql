-- Tenant-owned configuration proposals; deliberately separate from executable connectors.
create table harness_admin.external_providers (
  tenant_id text not null,
  provider_id text not null,
  definition jsonb not null,
  origin text not null check (origin in ('catalog', 'custom')),
  created_at timestamptz not null default now(),
  created_by text not null,
  primary key (tenant_id, provider_id)
);
create table harness_admin.external_connection_drafts (
  tenant_id text not null,
  provider_id text not null,
  connection_id text not null,
  definition jsonb not null,
  revision integer not null default 1 check (revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text not null,
  primary key (tenant_id, provider_id, connection_id),
  foreign key (tenant_id, provider_id) references harness_admin.external_providers(tenant_id, provider_id)
);
create table harness_admin.external_provider_events (
  event_id bigint generated always as identity primary key,
  tenant_id text not null,
  provider_id text not null,
  action text not null,
  connection_id text,
  revision integer,
  actor text not null,
  created_at timestamptz not null default now(),
  foreign key (tenant_id, provider_id) references harness_admin.external_providers(tenant_id, provider_id)
);
create index external_provider_events_scope on harness_admin.external_provider_events(tenant_id, provider_id, event_id desc);
alter table harness_admin.external_providers enable row level security;
alter table harness_admin.external_providers force row level security;
create policy tenant_scope on harness_admin.external_providers
  using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
alter table harness_admin.external_connection_drafts enable row level security;
alter table harness_admin.external_connection_drafts force row level security;
create policy tenant_scope on harness_admin.external_connection_drafts
  using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
alter table harness_admin.external_provider_events enable row level security;
alter table harness_admin.external_provider_events force row level security;
create policy tenant_scope on harness_admin.external_provider_events
  using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
