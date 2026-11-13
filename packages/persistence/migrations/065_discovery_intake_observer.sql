-- This role can observe the outcome of one named intake. It cannot read run inputs,
-- node output bodies, or any case data through the control database.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ehf_svc_discovery_observer') then
    create role ehf_svc_discovery_observer nologin;
  end if;
end;
$$;

create function harness_runtime.discovery_intake_settlement(p_tenant text, p_case text, p_run text)
returns table(state text, work_item_id text, decision_id text, receipt_digest text, plan_digest text)
language plpgsql security definer set search_path = pg_catalog as $$
begin
  perform set_config('app.tenant_id', p_tenant, true);
  return query
  with candidate as (
    select w.work_item_id, w.plan_digest, w.status, w.result, o.output, o.output_digest
    from harness_runtime.runs r
    join workflow.work_items w on w.tenant_id = r.tenant_id and w.case_id = p_case
      and w.plan_digest = r.plan_digest
      and w.document->'constraints'->>'runId' = r.run_id
      and w.document->'constraints'->>'nodeId' = 'pack-intake-ready'
      and w.work_type = 'gate'
    left join workflow.node_outputs o on o.tenant_id = w.tenant_id and o.work_item_id = w.work_item_id
      and w.status = 'COMPLETED'
    where r.tenant_id = p_tenant and r.run_id = p_run
      and r.input->>'tenantId' = p_tenant and r.input->>'caseId' = p_case
    limit 2
  ), ready as (
    select c.* from candidate c
    where (select count(*) from candidate) = 1
      and c.status = 'COMPLETED'
      and c.result->>'failureCode' is null
      and c.result->>'agentResultRef' = 'sha256:' || c.output_digest
      and c.output->>'apiVersion' = 'harness.factory/business-decision-v2'
      and c.output->>'gateId' = 'intake-ready'
      and c.output->>'inputProfile' = 'canonical.onboarding.v2'
      and c.output->>'purpose' = 'CDD_ONBOARDING'
      and c.output->'scope'->>'customerType' = 'corporate'
      and c.output->'result'->>'state' = 'DECIDED'
      and c.output->>'tenantId' = p_tenant and c.output->>'caseId' = p_case
      and c.output->>'planDigest' = c.plan_digest
      and c.output->>'receiptDigest' ~ '^[a-f0-9]{64}$'
      and length(c.output->>'decisionId') between 1 and 200
  )
  select 'ready'::text, v.work_item_id, v.output->>'decisionId', v.output->>'receiptDigest', v.plan_digest
    from ready v
  union all
  select 'ineligible'::text, null::text, null::text, null::text, null::text
    where not exists (select 1 from ready)
      and ((select count(*) from candidate) > 1 or exists (
        select 1 from candidate c where c.status in ('COMPLETED','CANCELLED','EXPIRED','FAILED')
      ));
end;
$$;

revoke all on function harness_runtime.discovery_intake_settlement(text,text,text) from public;
