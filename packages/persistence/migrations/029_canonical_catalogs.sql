create table harness_control.canonical_catalogs (
  tenant_id text not null,
  catalog_digest char(64) not null check (catalog_digest ~ '^[a-f0-9]{64}$'),
  source_release text not null,
  bundle_code_hash char(64) not null check (bundle_code_hash ~ '^[a-f0-9]{64}$'),
  artifact jsonb not null,
  imported_by text not null,
  imported_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id, catalog_digest)
);
alter table harness_control.canonical_catalogs enable row level security;
alter table harness_control.canonical_catalogs force row level security;
create policy canonical_catalog_tenant on harness_control.canonical_catalogs
  using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
