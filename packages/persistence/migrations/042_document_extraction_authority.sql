-- A case-only database principal can resolve a document grant without gaining runtime-table reads.
-- Deployment grants EXECUTE to the Case API execution principal, like lock_case_execution.
create or replace function harness_runtime.document_extraction_run(p_tenant text, p_case text, p_run text, p_plan text)
returns table(idempotency_key text, input jsonb)
language plpgsql security definer set search_path = pg_catalog as $$
begin
  perform set_config('app.tenant_id', p_tenant, true);
  return query select r.idempotency_key, jsonb_build_object(
    'tenantId', r.input->>'tenantId', 'caseId', r.input->>'caseId',
    'documentId', r.input->>'documentId', 'documentVersion', r.input->>'documentVersion',
    'evidenceId', r.input->>'evidenceId')
  from harness_runtime.runs r
  join harness_control.plans p on p.tenant_id=r.tenant_id and p.plan_digest=r.plan_digest
  where r.tenant_id=p_tenant and r.run_id=p_run and r.plan_digest=p_plan
    and r.input->>'caseId'=p_case and r.input->>'tenantId'=p_tenant
    and p.plan->'metadata'->>'name'='document-reextraction';
end;
$$;
revoke all on function harness_runtime.document_extraction_run(text,text,text,text) from public;

create or replace function harness_runtime.document_extraction_plan(p_tenant text, p_plan text)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare result jsonb;
begin
  perform set_config('app.tenant_id', p_tenant, true);
  select p.plan into result from harness_control.plans p
    where p.tenant_id=p_tenant and p.plan_digest=p_plan
      and p.plan->'metadata'->>'name'='document-reextraction';
  return result;
end;
$$;
revoke all on function harness_runtime.document_extraction_plan(text,text) from public;
