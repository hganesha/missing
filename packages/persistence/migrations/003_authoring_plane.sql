create table if not exists harness_control.authoring_drafts (
  draft_id text primary key,
  name text not null,
  domain text not null,
  version text not null,
  status text not null check (status in ('DRAFT','COMPILED','EVALUATED','APPROVED','PUBLISHED')),
  revision integer not null default 1,
  package_source text not null,
  workflow_source text not null,
  parsed_package jsonb not null,
  parsed_workflow jsonb not null,
  compiled_plan jsonb,
  diagnostics jsonb not null default '[]'::jsonb,
  evaluation_report jsonb,
  approved_by text,
  published_plan_digest text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists authoring_drafts_updated_idx
  on harness_control.authoring_drafts(updated_at desc);

create table if not exists harness_control.authoring_events (
  event_id text primary key,
  draft_id text not null references harness_control.authoring_drafts(draft_id) on delete cascade,
  revision integer not null,
  event_type text not null,
  actor text not null,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create index if not exists authoring_events_draft_idx
  on harness_control.authoring_events(draft_id, occurred_at desc);

create table if not exists harness_gateway.capability_registry (
  capability_id text primary key,
  definition jsonb not null,
  definition_digest text not null check (definition_digest ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('draft','active','deprecated')),
  owner text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
