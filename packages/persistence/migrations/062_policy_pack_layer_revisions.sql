-- Policy pack layers edited in the studio (phase H): administered configuration held as append-only
-- revisions with separation of duties, as institution catalogs are. The repository's layers
-- (domains/policy/packs) are the starting point; a tenant's published revision of a layer replaces
-- it for that tenant's authoring and process composition. Problems are the tighten-only refusals of
-- composing every selected pack with the edit; a layer with problems cannot be approved.
create table harness_admin.policy_pack_layer_revisions (
  tenant_id text not null,
  layer_id text not null check (layer_id ~ '^[a-z0-9][a-z0-9.-]{0,119}$'),
  revision integer not null check (revision > 0),
  status text not null check (status in ('DRAFT','APPROVED','PUBLISHED','SUPERSEDED')),
  document jsonb not null,
  document_digest text not null check (document_digest ~ '^[a-f0-9]{64}$'),
  problems jsonb not null default '[]'::jsonb check (jsonb_typeof(problems) = 'array'),
  reason text not null,
  authored_by text not null,
  authored_at timestamptz not null default now(),
  approved_by text,
  approved_at timestamptz,
  published_by text,
  published_at timestamptz,
  primary key (tenant_id, layer_id, revision),
  check (approved_by is null or approved_by <> authored_by),
  check (published_by is null or published_by <> authored_by),
  check (status not in ('APPROVED','PUBLISHED') or (approved_by is not null and problems = '[]'::jsonb)),
  check (status <> 'PUBLISHED' or published_by is not null)
);
create unique index policy_pack_layer_one_published
  on harness_admin.policy_pack_layer_revisions (tenant_id, layer_id) where status = 'PUBLISHED';
create table harness_admin.policy_pack_layer_events (
  tenant_id text not null,
  event_id uuid not null,
  layer_id text not null,
  revision integer not null,
  event_type text not null check (event_type in ('CREATED','APPROVED','PUBLISHED','SUPERSEDED')),
  actor_id text not null,
  reason text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, event_id)
);
alter table harness_admin.policy_pack_layer_revisions enable row level security;
alter table harness_admin.policy_pack_layer_revisions force row level security;
alter table harness_admin.policy_pack_layer_events enable row level security;
alter table harness_admin.policy_pack_layer_events force row level security;
create policy tenant_scope on harness_admin.policy_pack_layer_revisions
  using (tenant_id = nullif(current_setting('app.tenant_id',true),''))
  with check (tenant_id = nullif(current_setting('app.tenant_id',true),''));
create policy tenant_scope on harness_admin.policy_pack_layer_events
  using (tenant_id = nullif(current_setting('app.tenant_id',true),''))
  with check (tenant_id = nullif(current_setting('app.tenant_id',true),''));
