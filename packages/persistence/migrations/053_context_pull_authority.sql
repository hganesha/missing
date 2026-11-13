-- Resolve only reviewed, currently qualified case pulls for the case API. No runtime-table read grant.
create function harness_runtime.context_pull_run(p_tenant text, p_case text, p_run text, p_plan text)
returns table(input jsonb, binding jsonb, mapping jsonb, connector_id text)
language plpgsql security definer set search_path = pg_catalog as $$
begin
  perform set_config('app.tenant_id', p_tenant, true);
  return query
  select r.input, b.definition, m.definition, e.authority->>'connectorId'
  from harness_runtime.runs r
  join lateral (select c.* from harness_control.context_revisions c
    where c.tenant_id=r.tenant_id and c.environment=r.input->>'contextEnvironment'
      and c.kind='case-binding' and c.id=r.input->'contextPullBinding'->>'id'
    order by c.revision desc limit 1) b on b.digest=r.input->'contextPullBinding'->>'digest'
  join lateral (select c.* from harness_control.context_revisions c
    where c.tenant_id=r.tenant_id and c.environment=b.environment and c.kind='mapping'
      and c.id=b.definition->>'mappingId' order by c.revision desc limit 1) m
    on m.digest=b.definition->>'mappingDigest'
  join lateral (select c.* from harness_control.context_revisions c
    where c.tenant_id=r.tenant_id and c.environment=b.environment and c.kind='resource'
      and c.id=m.definition->>'resourceId' order by c.revision desc limit 1) rs
    on rs.digest=m.definition->>'resourceDigest'
  join lateral (select c.* from harness_control.context_revisions c
    where c.tenant_id=r.tenant_id and c.environment=b.environment and c.kind='connection'
      and c.id=rs.definition->>'connectionId' order by c.revision desc limit 1) cn
    on cn.digest=rs.definition->>'connectionDigest'
  join lateral (select ce.* from harness_control.context_enablements ce
    where ce.tenant_id=r.tenant_id and ce.environment=b.environment and ce.mapping_id=m.id
    order by ce.revision desc limit 1) e on not e.paused
      and e.revision=(b.definition->>'enablementRevision')::integer and e.mapping_digest=m.digest
  where r.tenant_id=p_tenant and r.run_id=p_run and r.plan_digest=p_plan
    and r.input->>'tenantId'=p_tenant and r.input->>'caseId'=p_case
    and b.definition->>'caseId'=p_case and b.definition->>'planDigest'=p_plan
    and b.definition->>'nodeId'=r.input->>'contextPullNodeId'
    and b.definition->>'sourceContextDigest'=r.source_context_digest
    and b.definition->>'enabled'='true'
    and cn.definition->>'connectorId'=e.authority->>'connectorId'
    and replace(e.authority->>'planDigest', 'sha256:', '')=p_plan
    and cn.definition->'api'->>'kind' in ('salesforce','fenergo');
end;
$$;
revoke all on function harness_runtime.context_pull_run(text,text,text,text) from public;
