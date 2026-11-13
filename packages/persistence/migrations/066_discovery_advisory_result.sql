-- Return only the completed output of the explicitly pinned detached advisory plan.
create function harness_runtime.discovery_advisory_result(p_tenant text, p_run text, p_plan text, p_input jsonb)
returns jsonb
language plpgsql security definer set search_path = pg_catalog as $$
declare result jsonb;
begin
  perform set_config('app.tenant_id', p_tenant, true);
  select o.output into strict result
  from harness_runtime.runs r
  join harness_control.plans p on p.tenant_id=r.tenant_id and p.plan_digest=r.plan_digest
  join workflow.work_items w on w.tenant_id=r.tenant_id and w.case_id=r.input->>'caseId'
    and w.plan_digest=r.plan_digest and w.document->'constraints'->>'runId'=r.run_id
    and w.document->'constraints'->>'nodeId'='advisory-output' and w.work_type='output'
    and w.status='COMPLETED' and w.result->>'failureCode' is null
  join workflow.node_outputs o on o.tenant_id=w.tenant_id and o.work_item_id=w.work_item_id
    and w.result->>'agentResultRef'='sha256:' || o.output_digest
  where r.tenant_id=p_tenant and r.run_id=p_run and r.plan_digest=p_plan and r.input=p_input
    and r.status='completed' and p.domain='discovery' and p.plan->'metadata'->>'domain'='discovery'
    and p.plan->'execution'->>'coordinationMode'='dataFlow';
  return result;
exception when no_data_found then
  return null;
end;
$$;

revoke all on function harness_runtime.discovery_advisory_result(text,text,text,jsonb) from public;
