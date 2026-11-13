-- Releasing a closed case's working data in the control database (data-stores-plan.md §3.2,
-- §3.3, phase 4d). The context release job calls these two functions; it holds no table
-- grant here. What made a decision is in the case database (the ledger and the promoted
-- model_context evidence), so after release the control database keeps what ran, when, at
-- what cost and with which digests, and drops the content.

do $$
declare
  role_name text;
begin
  foreach role_name in array array[
    'ehf_svc_case_data_release',   -- the context release job's login group in this database
    'ehf_case_data_releaser'       -- owns the functions below; never granted to a login
  ] loop
    if not exists (select 1 from pg_roles where rolname = role_name) then
      execute format('create role %I nologin', role_name);
    end if;
  end loop;
end $$;

-- How many of the case's runs and work items are still live. A live one blocks release.
create or replace function harness_runtime.case_live_executions(p_tenant text, p_case text) returns integer
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  live integer;
begin
  perform set_config('app.tenant_id', p_tenant, true);
  select
    (select count(*) from harness_runtime.runs
      where tenant_id = p_tenant and input->>'caseId' = p_case and status in ('queued', 'running', 'retrying'))
    + (select count(*) from workflow.work_items
      where tenant_id = p_tenant and case_id = p_case
        and status not in ('COMPLETED', 'CANCELLED', 'EXPIRED', 'FAILED'))
  into live;
  return live;
end $$;

-- Replace the case's content columns with markers that keep each original digest. Idempotent:
-- a second call finds nothing left to redact. Rows stay readable by their schemas: a work
-- item keeps its shape (objective replaced, constraints reduced to runId and nodeId).
create or replace function harness_runtime.release_case_working_data(p_tenant text, p_case text) returns jsonb
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  run_ids text[];
  runs_redacted integer;
  events_redacted integer;
  work_items_redacted integer;
  outputs_redacted integer;
  outcomes_redacted integer;
  receipts_redacted integer;
  checkpoints_released integer := null;
  checkpoint_table text;
  removed integer;
begin
  if harness_runtime.case_live_executions(p_tenant, p_case) > 0 then
    raise exception 'context_release.active_execution' using errcode = 'object_in_use';
  end if;
  perform set_config('app.tenant_id', p_tenant, true);
  select coalesce(array_agg(run_id), '{}') into run_ids
  from harness_runtime.runs where tenant_id = p_tenant and input->>'caseId' = p_case;

  update harness_runtime.runs
  set input = jsonb_build_object('tenantId', input->'tenantId', 'caseId', input->'caseId', 'released', true),
      output = case when output is null then null else jsonb_build_object('released', true) end
  where run_id = any(run_ids) and not coalesce((input->>'released')::boolean, false);
  get diagnostics runs_redacted = row_count;

  update harness_runtime.run_events set values = jsonb_build_object('released', true)
  where run_id = any(run_ids) and values <> jsonb_build_object('released', true);
  get diagnostics events_redacted = row_count;

  update workflow.work_items
  set document = jsonb_set(jsonb_set(document, '{objective}', '"[released]"'), '{constraints}',
        jsonb_strip_nulls(jsonb_build_object('runId', document->'constraints'->'runId', 'nodeId', document->'constraints'->'nodeId')))
  where tenant_id = p_tenant and case_id = p_case and document->>'objective' is distinct from '[released]';
  get diagnostics work_items_redacted = row_count;

  update workflow.node_outputs n set output = jsonb_build_object('released', true, 'digest', n.output_digest)
  from workflow.work_items w
  where n.tenant_id = w.tenant_id and n.work_item_id = w.work_item_id and w.tenant_id = p_tenant and w.case_id = p_case
    and not (n.output ? 'released');
  get diagnostics outputs_redacted = row_count;

  update workflow.execution_outcomes o set outcome = jsonb_build_object('released', true, 'digest', o.outcome_digest)
  from workflow.work_items w
  where o.tenant_id = w.tenant_id and o.work_item_id = w.work_item_id and w.tenant_id = p_tenant and w.case_id = p_case
    and not (o.outcome ? 'released');
  get diagnostics outcomes_redacted = row_count;

  update harness_gateway.receipts set result = jsonb_build_object('released', true, 'receiptDigest', receipt_digest)
  where run_id = any(run_ids) and result is not null and not (result ? 'released');
  get diagnostics receipts_redacted = row_count;

  -- LangGraph checkpoints (thread id = run id, or run:work item:attempt:fence). The saver
  -- creates its tables at runtime, so they can be removed only once the deployment granted
  -- this function's owner access to them (grants.sql does when it can); otherwise null.
  foreach checkpoint_table in array array['checkpoint_writes', 'checkpoint_blobs', 'checkpoints'] loop
    if to_regclass('langgraph_checkpoint.' || checkpoint_table) is not null
       and has_table_privilege('langgraph_checkpoint.' || checkpoint_table, 'DELETE') then
      execute format('delete from langgraph_checkpoint.%I where thread_id = any($1)
                        or exists (select 1 from unnest($1) r where thread_id like r || '':%%'')', checkpoint_table)
        using run_ids;
      get diagnostics removed = row_count;
      checkpoints_released := coalesce(checkpoints_released, 0) + removed;
    end if;
  end loop;

  return jsonb_build_object(
    'runs', runs_redacted, 'runEvents', events_redacted, 'workItems', work_items_redacted,
    'nodeOutputs', outputs_redacted, 'executionOutcomes', outcomes_redacted, 'gatewayReceipts', receipts_redacted,
    'checkpoints', checkpoints_released);
end $$;

do $$
begin
  if not (select rolsuper from pg_roles where rolname = current_user) then
    execute format('grant ehf_case_data_releaser to %I', current_user);
  end if;
end $$;
grant usage, create on schema harness_runtime to ehf_case_data_releaser;
alter function harness_runtime.case_live_executions(text, text) owner to ehf_case_data_releaser;
alter function harness_runtime.release_case_working_data(text, text) owner to ehf_case_data_releaser;
