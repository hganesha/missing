-- Case teams and case assignment (docs/implementation/case-access-model.md, step 1).
--
-- A team is a case-work queue in a tenant with members. A case is assigned to one team and,
-- optionally, to named members of it. This migration records assignment; nothing reads it to
-- decide access yet (steps 2 and 3 of the design do).
--
-- case-api has no DELETE on these tables (grants.sql), so a member is removed by setting
-- removed_at, and a reassignment replaces the single current row for the case. The history of
-- assignments is the case ledger: every AssignCase command appends a case.assigned event.

create table if not exists {{CASE_CORE_SCHEMA}}.case_teams (
  tenant_id text not null,
  team_id text not null,
  name text not null,
  updated_by jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, team_id),
  constraint case_teams_id_shape check (team_id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'),
  constraint case_teams_name_present check (length(btrim(name)) > 0)
);

create table if not exists {{CASE_CORE_SCHEMA}}.case_team_members (
  tenant_id text not null,
  team_id text not null,
  subject_id text not null,
  added_by jsonb not null,
  added_at timestamptz not null,
  removed_at timestamptz,
  primary key (tenant_id, team_id, subject_id),
  foreign key (tenant_id, team_id) references {{CASE_CORE_SCHEMA}}.case_teams(tenant_id, team_id)
);

create index if not exists case_team_members_by_subject
  on {{CASE_CORE_SCHEMA}}.case_team_members (tenant_id, subject_id) where removed_at is null;

create table if not exists {{CASE_CORE_SCHEMA}}.case_assignments (
  tenant_id text not null,
  case_id text not null,
  team_id text not null,
  assignees jsonb not null default '[]'::jsonb,
  reason text not null,
  assigned_by jsonb not null,
  assigned_at timestamptz not null,
  primary key (tenant_id, case_id),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id),
  foreign key (tenant_id, team_id) references {{CASE_CORE_SCHEMA}}.case_teams(tenant_id, team_id),
  constraint case_assignments_assignees_array check (jsonb_typeof(assignees) = 'array'),
  constraint case_assignments_reason_present check (length(btrim(reason)) > 0)
);

create index if not exists case_assignments_by_team
  on {{CASE_CORE_SCHEMA}}.case_assignments (tenant_id, team_id);

do $$
declare
  target text;
begin
  foreach target in array array['case_teams', 'case_team_members', 'case_assignments'] loop
    execute format('alter table {{CASE_CORE_SCHEMA}}.%I enable row level security', target);
    execute format('alter table {{CASE_CORE_SCHEMA}}.%I force row level security', target);
    execute format('drop policy if exists case_tenant_scope on {{CASE_CORE_SCHEMA}}.%I', target);
    execute format($policy$
      create policy case_tenant_scope on {{CASE_CORE_SCHEMA}}.%I
      using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
    $policy$, target);
  end loop;
end $$;
