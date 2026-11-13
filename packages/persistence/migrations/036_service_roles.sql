-- Service roles and controller membership for the control database.
--
-- Each workload gets one NOLOGIN group role. A deployment maps its login principal (an
-- Entra managed identity in Azure, a development login locally) into that group; the
-- group never logs in and never owns anything. What each group may touch is declared in
-- packages/persistence/grants.sql, which the migration runner re-applies on every run.
-- See docs/implementation/data-stores-plan.md §4.
--
-- Roles are cluster-wide, so one PostgreSQL cluster serves one environment.

do $$
declare
  role_name text;
begin
  foreach role_name in array array[
    -- service groups
    'ehf_svc_control_api',          -- apps/control-api
    'ehf_svc_runtime_dispatcher',   -- apps/runtime-worker
    'ehf_svc_runtime_checkpoint',   -- apps/runtime-host (LangGraph checkpoints only)
    'ehf_svc_capability_gateway',   -- apps/capability-gateway
    'ehf_svc_integration_worker',   -- apps/integration-worker
    'ehf_svc_case_execution',       -- apps/case-api asking whether an execution holds its lease
    'ehf_audit_reader',             -- read-only verification
    -- controller roles: membership, not a session setting, grants cross-tenant scope
    'ehf_workflow_controller',
    'ehf_integration_controller'
  ] loop
    if not exists (select 1 from pg_roles where rolname = role_name) then
      execute format('create role %I nologin', role_name);
    end if;
  end loop;
end $$;

grant ehf_workflow_controller to ehf_svc_runtime_dispatcher;
-- control-api resolves an inbound event's binding (and so its tenant) before it knows the
-- tenant, the integration worker claims deliveries across tenants.
grant ehf_integration_controller to ehf_svc_control_api;
grant ehf_integration_controller to ehf_svc_integration_worker;

-- The workflow and integration policies used to accept
--   current_setting('app.workflow_controller') = 'true'
-- as a cross-tenant bypass. Any session can set a custom setting, so that was not a
-- control. Role membership cannot be claimed by a client. The sub-select makes PostgreSQL
-- evaluate the membership check once per statement rather than once per row.
do $$
declare
  relation_name text;
begin
  foreach relation_name in array array[
    'work_items', 'work_item_dependencies', 'work_item_transitions', 'dispatch_outbox',
    'durable_timers', 'reconciliation_cases', 'human_decisions', 'node_outputs',
    'human_assignments', 'human_conflict_resolutions'
  ] loop
    execute format('drop policy if exists workflow_tenant_scope on workflow.%I', relation_name);
    execute format($policy$
      create policy workflow_tenant_scope on workflow.%I
      using (
        tenant_id = nullif(current_setting('app.tenant_id', true), '')
        or (select pg_has_role(current_user, 'ehf_workflow_controller', 'member'))
      )
      with check (
        tenant_id = nullif(current_setting('app.tenant_id', true), '')
        or (select pg_has_role(current_user, 'ehf_workflow_controller', 'member'))
      )
    $policy$, relation_name);
  end loop;

  foreach relation_name in array array[
    'connector_revisions', 'binding_revisions', 'binding_events', 'ingress_receipts',
    'event_inbox', 'deliveries', 'delivery_attempts', 'action_receipts'
  ] loop
    execute format('drop policy if exists integration_tenant_scope on integration.%I', relation_name);
    execute format($policy$
      create policy integration_tenant_scope on integration.%I
      using (
        tenant_id = nullif(current_setting('app.tenant_id', true), '')
        or (select pg_has_role(current_user, 'ehf_integration_controller', 'member'))
      )
      with check (
        tenant_id = nullif(current_setting('app.tenant_id', true), '')
        or (select pg_has_role(current_user, 'ehf_integration_controller', 'member'))
      )
    $policy$, relation_name);
  end loop;
end $$;
