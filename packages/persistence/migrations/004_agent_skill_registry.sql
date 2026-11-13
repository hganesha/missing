create table if not exists harness_control.skill_registry (
  skill_id text primary key,
  definition jsonb not null,
  definition_digest char(64) not null,
  status text not null check (status in ('draft', 'active', 'deprecated')),
  source_type text not null check (source_type in ('manual', 'github')),
  source_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists harness_control.agent_registry (
  agent_id text primary key,
  definition jsonb not null,
  definition_digest char(64) not null,
  status text not null check (status in ('draft', 'active', 'deprecated')),
  source_type text not null check (source_type in ('manual', 'github')),
  source_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists skill_registry_status_idx on harness_control.skill_registry(status, updated_at desc);
create index if not exists agent_registry_status_idx on harness_control.agent_registry(status, updated_at desc);
