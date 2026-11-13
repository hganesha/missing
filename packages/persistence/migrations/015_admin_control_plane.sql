-- Administered platform configuration.
--
-- Model profiles, provider bindings and operational knobs used to live in a JSON file
-- baked into the images and in literals inside the services, which meant changing a
-- model or repointing a provider required a rebuild and left no record of who changed
-- what. They move here, with the distinction the plan trust root requires: a model
-- profile document is immutable and revisioned because `harnessc` digests it into every
-- plan compiled against it, while a provider binding and a platform setting are not part
-- of any digest and may be changed in place.

create schema if not exists harness_admin;

-- Where a provider is reached and which credential answers for it.
--
-- `credential_ref` names an environment variable. The credential value never reaches
-- this table, the admin API, or the control surface: the gateway is still the only
-- component that holds one, and it resolves the named variable locally.
create table if not exists harness_admin.providers (
  tenant_id text not null,
  provider_id text not null check (provider_id ~ '^[a-z0-9][a-z0-9._-]*$'),
  kind text not null check (kind in ('openrouter', 'openai_compatible', 'recorded')),
  definition jsonb not null,
  definition_digest char(64) not null,
  status text not null check (status in ('active', 'disabled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by text not null,
  primary key (tenant_id, provider_id)
);

-- Immutable model-profile revisions.
--
-- `definition` holds exactly the document the compiler digests, and `definition_digest`
-- is that digest. A plan records the digest it was compiled against, so an invocation
-- can resolve the exact revision rather than whatever is current -- which is what makes
-- editing a profile safe for runs already in flight.
create table if not exists harness_admin.model_profile_revisions (
  tenant_id text not null,
  profile_id text not null check (profile_id ~ '^[a-z0-9][a-z0-9._-]*$'),
  revision integer not null check (revision > 0),
  definition jsonb not null,
  definition_digest char(64) not null check (definition_digest ~ '^[a-f0-9]{64}$'),
  provider_id text not null,
  status text not null check (status in ('active', 'superseded', 'disabled')),
  note text,
  created_at timestamptz not null default now(),
  created_by text not null,
  primary key (tenant_id, profile_id, revision)
);

-- At most one revision of a profile is the one new compilations resolve to. Superseded
-- revisions are kept, not deleted: a plan that pinned one still has to resolve it.
create unique index if not exists model_profile_active_idx
  on harness_admin.model_profile_revisions(tenant_id, profile_id)
  where status = 'active';
create index if not exists model_profile_digest_idx
  on harness_admin.model_profile_revisions(tenant_id, definition_digest);

create table if not exists harness_admin.platform_settings (
  tenant_id text not null,
  -- The allowed sections are widened by a later migration; the constraint is named so
  -- that replacing it does not depend on the name Postgres would have generated.
  section text not null constraint platform_settings_section_allowed
    check (section in ('dispatcher', 'gateway', 'envelope', 'authoring', 'outbox', 'evidence')),
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text not null,
  primary key (tenant_id, section)
);

-- Append-only. Every admin write lands here before the change is visible, so "who
-- repointed the provider, when, and from what" is answerable without reading a diff of
-- the deployment.
create table if not exists harness_admin.change_log (
  change_id uuid primary key,
  tenant_id text not null,
  occurred_at timestamptz not null default now(),
  actor_id text not null,
  actor_roles text[] not null default '{}',
  resource_kind text not null check (resource_kind in ('provider', 'model-profile', 'platform-setting')),
  resource_id text not null,
  action text not null check (action in ('create', 'update', 'activate', 'disable')),
  before jsonb,
  after jsonb,
  before_digest char(64),
  after_digest char(64),
  reason text
);

create index if not exists admin_change_log_recent_idx
  on harness_admin.change_log(tenant_id, occurred_at desc);
create index if not exists admin_change_log_resource_idx
  on harness_admin.change_log(tenant_id, resource_kind, resource_id, occurred_at desc);
