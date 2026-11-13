-- Institution product catalogs (Product Policy Studio plan, phase B): administered configuration,
-- held as append-only revisions with separation of duties. The repository ships seeds only.
create table harness_admin.institution_catalog_revisions (
  tenant_id text not null,
  institution_id text not null check (institution_id ~ '^[a-z0-9][a-z0-9.-]{0,79}$'),
  revision integer not null check (revision > 0),
  status text not null check (status in ('DRAFT','APPROVED','PUBLISHED','SUPERSEDED')),
  document jsonb not null,
  document_digest text not null check (document_digest ~ '^[a-f0-9]{64}$'),
  taxonomy_digest text not null check (taxonomy_digest ~ '^[a-f0-9]{64}$'),
  problems jsonb not null default '[]'::jsonb check (jsonb_typeof(problems) = 'array'),
  reason text not null,
  authored_by text not null,
  authored_at timestamptz not null default now(),
  approved_by text,
  approved_at timestamptz,
  published_by text,
  published_at timestamptz,
  primary key (tenant_id, institution_id, revision),
  check (approved_by is null or approved_by <> authored_by),
  check (published_by is null or published_by <> authored_by),
  check (status not in ('APPROVED','PUBLISHED') or (approved_by is not null and problems = '[]'::jsonb)),
  check (status <> 'PUBLISHED' or published_by is not null)
);
create unique index institution_catalog_one_published
  on harness_admin.institution_catalog_revisions (tenant_id, institution_id) where status = 'PUBLISHED';
create table harness_admin.institution_catalog_events (
  tenant_id text not null,
  event_id uuid not null,
  institution_id text not null,
  revision integer not null,
  event_type text not null check (event_type in ('CREATED','APPROVED','PUBLISHED','SUPERSEDED')),
  actor_id text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, event_id)
);
alter table harness_admin.institution_catalog_revisions enable row level security;
alter table harness_admin.institution_catalog_revisions force row level security;
alter table harness_admin.institution_catalog_events enable row level security;
alter table harness_admin.institution_catalog_events force row level security;
create policy tenant_scope on harness_admin.institution_catalog_revisions
  using (tenant_id = nullif(current_setting('app.tenant_id',true),''))
  with check (tenant_id = nullif(current_setting('app.tenant_id',true),''));
create policy tenant_scope on harness_admin.institution_catalog_events
  using (tenant_id = nullif(current_setting('app.tenant_id',true),''))
  with check (tenant_id = nullif(current_setting('app.tenant_id',true),''));
