-- The case service cannot choose legacy enforcement or read control tables directly.
create or replace function harness_runtime.case_policy_contract(p_tenant text, p_plan text)
returns integer language plpgsql security definer set search_path = pg_catalog as $$
declare document jsonb;
begin
  perform set_config('app.tenant_id', p_tenant, true);
  select plan into document from harness_control.plans
    where tenant_id=p_tenant and plan_digest=p_plan;
  if document is null then raise exception 'policy.admitted_plan_required'; end if;
  if exists (select 1 from jsonb_array_elements(document->'graph'->'nodes') n
      where n->'config'->>'businessDecision'='v2') then return 2; end if;
  return 1;
end $$;
revoke all on function harness_runtime.case_policy_contract(text,text) from public;

-- Hold the release, published revision and registry approvals against revocation until
-- the case transaction commits. Call this on the separate execution connection.
create or replace function harness_runtime.lock_business_policy_authority(
  p_tenant text, p_plan text, p_release text, p_bundle text, p_gate text, p_environment text)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare document jsonb; release_document jsonb;
begin
  perform set_config('app.tenant_id', p_tenant, true);
  select plan into document from harness_control.plans where tenant_id=p_tenant and plan_digest=p_plan;
  if not exists (select 1 from jsonb_array_elements(document->'graph'->'nodes') n
      join jsonb_array_elements(document->'policyBundles') b on b->>'policyId'=n->'config'->>'policyRef'
      where n->>'kind'='gate' and n->'config'->>'businessDecision'='v2'
        and n->'config'->>'gateId'=p_gate and replace(b->>'bundleDigest','sha256:','')=p_bundle)
    then return null; end if;
  select manifest into release_document from harness_control.release_manifests
    where tenant_id=p_tenant and manifest_digest=p_release and plan_digest=p_plan
      and status='active' and manifest->'scope'->>'environment'=p_environment for share;
  if release_document is null or not exists (select 1 from jsonb_array_elements_text(release_document->'policyBundleDigests') d
      where replace(d,'sha256:','')=p_bundle) then return null; end if;
  perform 1 from harness_control.artifact_registry where tenant_id=p_tenant
    and artifact_kind='release-manifest' and digest=p_release and status='approved' for share;
  if not found then return null; end if;
  perform 1 from harness_control.artifact_registry where tenant_id=p_tenant
    and artifact_kind='policy-bundle' and digest=p_bundle and status='approved' for share;
  if not found then return null; end if;
  perform 1 from harness_control.policy_revisions where tenant_id=p_tenant
    and bundle_digest=p_bundle and status='PUBLISHED' and release_blockers='[]'::jsonb for share;
  if not found then return null; end if;
  return release_document;
end $$;
revoke all on function harness_runtime.lock_business_policy_authority(text,text,text,text,text,text) from public;
