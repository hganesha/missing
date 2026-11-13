create table harness_admin.platform_users (
  tenant_id text not null,
  user_id uuid not null,
  subject_id text not null,
  display_name text not null,
  email text not null check (email = lower(email)),
  roles text[] not null check (cardinality(roles) > 0),
  revision integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text not null,
  primary key (tenant_id, user_id),
  unique (tenant_id, subject_id),
  unique (tenant_id, email)
);
create table harness_admin.user_changes (
  tenant_id text not null,
  change_id uuid not null,
  user_id uuid not null,
  actor_id text not null,
  actor_roles text[] not null,
  reason text not null,
  before_value jsonb,
  after_value jsonb not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, change_id)
);
alter table harness_admin.platform_users enable row level security;
alter table harness_admin.platform_users force row level security;
alter table harness_admin.user_changes enable row level security;
alter table harness_admin.user_changes force row level security;
create policy tenant_scope on harness_admin.platform_users
  using (tenant_id = nullif(current_setting('app.tenant_id',true),''))
  with check (tenant_id = nullif(current_setting('app.tenant_id',true),''));
create policy tenant_scope on harness_admin.user_changes
  using (tenant_id = nullif(current_setting('app.tenant_id',true),''))
  with check (tenant_id = nullif(current_setting('app.tenant_id',true),''));
