-- Case API may check and lock authority, but cannot read or mutate runtime tables.
create or replace function harness_runtime.lock_case_execution(
  p_run text, p_tenant text, p_case text, p_plan text, p_attempt integer, p_fence bigint,
  p_work text, p_work_fence bigint
) returns boolean language plpgsql security definer set search_path = pg_catalog as $$
begin
  perform set_config('app.tenant_id', p_tenant, true);
  perform 1 from harness_runtime.runs
    where run_id=p_run and tenant_id=p_tenant and input->>'caseId'=p_case
      and plan_digest=p_plan and attempt=p_attempt and fencing_epoch=p_fence
      and status='running' and cancellation_requested_at is null
      and lease_expires_at > clock_timestamp()
    for share;
  if not found then return false; end if;
  if p_work is not null then
    perform 1 from workflow.work_items
      where tenant_id=p_tenant and case_id=p_case and work_item_id=p_work
        and fencing_epoch=p_work_fence and status='RUNNING'
        and lease_until > clock_timestamp() and cancellation_requested_at is null
        and document->'constraints'->>'runId'=p_run
      for share;
    if not found then return false; end if;
  end if;
  return true;
end;
$$;
revoke all on function harness_runtime.lock_case_execution(text,text,text,text,integer,bigint,text,bigint) from public;
