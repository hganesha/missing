create table if not exists harness_control.runtime_lifecycle (
  tenant_id text primary key,
  accepting_runs boolean not null default true,
  reason text,
  updated_at timestamptz not null default now(),
  updated_by text not null
);
