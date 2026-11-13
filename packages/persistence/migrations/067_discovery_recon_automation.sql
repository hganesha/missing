create function harness_runtime.discovery_parent_run(p_tenant text,p_case text,p_plan text)
returns text
language plpgsql security definer set search_path = pg_catalog as $$
declare result text;
begin
  perform set_config('app.tenant_id',p_tenant,true);
  select r.run_id into result
  from workflow.work_items w
  join harness_runtime.runs r on r.tenant_id=w.tenant_id and r.run_id=w.document->'constraints'->>'runId'
  cross join lateral harness_runtime.discovery_intake_settlement(p_tenant,p_case,r.run_id) s
  where w.tenant_id=p_tenant and w.case_id=p_case and w.plan_digest=p_plan
    and w.status='COMPLETED' and w.document->'constraints'->>'nodeId'='pack-intake-ready'
    and s.state='ready'
  order by w.terminal_at desc,w.work_item_id desc limit 1;
  return result;
end;
$$;

create function harness_runtime.discovery_run_status(p_tenant text,p_run text,p_plan text,p_input jsonb)
returns text
language plpgsql security definer set search_path = pg_catalog as $$
declare result text;
begin
  perform set_config('app.tenant_id',p_tenant,true);
  select r.status into result from harness_runtime.runs r
  join harness_control.plans p on p.tenant_id=r.tenant_id and p.plan_digest=r.plan_digest and p.domain='discovery'
  where r.tenant_id=p_tenant and r.run_id=p_run and r.plan_digest=p_plan and r.input=p_input;
  return result;
end;
$$;

revoke all on function harness_runtime.discovery_parent_run(text,text,text),
  harness_runtime.discovery_run_status(text,text,text,jsonb) from public;
