-- Requested effects of hosted skills (skill.execution.v1 §6.3) that the platform holds instead of
-- committing when the skill completes: the case commands of an approval-required skill and every
-- external action. Bound to the run, the skill and release nodes, the skill execution and its
-- binding hashes (request, context, code), and to the case sequence at the hold. The release node
-- after the durable approval commits them (COMMITTED, or QUEUED / NO_ROUTE for an external action)
-- or discards them (DISCARDED); a changed case or a passed expiry refuses the release (STALE,
-- EXPIRED). Rows are never deleted. See docs/implementation/canonical-records.md.
create table if not exists {{CASE_CORE_SCHEMA}}.skill_effects (
  tenant_id text not null,
  case_id text not null,
  execution_id text not null,
  effect_key text not null,
  effect_index integer not null,
  run_id text not null,
  skill_node_id text not null,
  approval_node_id text not null,
  release_node_id text not null,
  skill_id text not null,
  skill_version text not null,
  effect_type text not null,
  command_type text,
  action text,
  payload jsonb not null,
  justification_refs jsonb not null default '[]'::jsonb,
  binding jsonb not null,
  binding_digest char(64) not null,
  held_at_sequence bigint not null,
  expires_at timestamptz not null,
  status text not null,
  decision jsonb,
  outcome jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, case_id, execution_id, effect_key),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id),
  check (effect_type in ('case_command', 'external_action')),
  check ((effect_type = 'case_command') = (command_type is not null)),
  check ((effect_type = 'external_action') = (action is not null)),
  check (status in ('HELD', 'COMMITTED', 'QUEUED', 'NO_ROUTE', 'DISCARDED', 'STALE', 'EXPIRED'))
);

create index if not exists skill_effects_pending_idx
  on {{CASE_CORE_SCHEMA}}.skill_effects(tenant_id, case_id, status, created_at);

alter table {{CASE_CORE_SCHEMA}}.skill_effects enable row level security;
alter table {{CASE_CORE_SCHEMA}}.skill_effects force row level security;
drop policy if exists skill_effects_tenant_scope on {{CASE_CORE_SCHEMA}}.skill_effects;
create policy skill_effects_tenant_scope on {{CASE_CORE_SCHEMA}}.skill_effects
  using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
