-- Sandbox releases: a development-only way to run a draft's plan before its release is governed.
--
-- A sandbox release is an ordinary release manifest whose scope.cohort is 'sandbox'. It is
-- created and approved by a system identity (never a person's review), it has its own release
-- line so it cannot supersede a governed release of the same process, and it can never be scoped
-- to production. Its policy authority is separate from a governed release's: it reads the policy
-- revision it published in a sandbox workspace (workspace_id 'sandbox:...'), which may still have
-- unresolved release blockers and has no registry approval of its own, so a draft can be rehearsed
-- before its installation policy is finished. A governed release never reads a sandbox revision, so
-- a rehearsal can neither stand in for a policy approval nor get in its way.
alter table harness_control.release_manifests add constraint release_manifests_sandbox_not_production
  check (not (manifest->'scope'->>'cohort' = 'sandbox' and manifest->'scope'->>'environment' = 'production'));

create or replace function harness_runtime.lock_business_policy_authority(
  p_tenant text, p_plan text, p_release text, p_bundle text, p_gate text, p_environment text)
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare document jsonb; release_document jsonb; release_name text;
begin
  perform set_config('app.tenant_id', p_tenant, true);
  select plan into document from harness_control.plans where tenant_id=p_tenant and plan_digest=p_plan;
  if not exists (select 1 from jsonb_array_elements(document->'graph'->'nodes') n
      join jsonb_array_elements(document->'policyBundles') b on b->>'policyId'=n->'config'->>'policyRef'
      where n->>'kind'='gate' and n->'config'->>'businessDecision'='v2'
        and n->'config'->>'gateId'=p_gate and replace(b->>'bundleDigest','sha256:','')=p_bundle)
    then return null; end if;
  select manifest, release_id into release_document, release_name from harness_control.release_manifests
    where tenant_id=p_tenant and manifest_digest=p_release and plan_digest=p_plan
      and status='active' and manifest->'scope'->>'environment'=p_environment for share;
  if release_document is null or not exists (select 1 from jsonb_array_elements_text(release_document->'policyBundleDigests') d
      where replace(d,'sha256:','')=p_bundle) then return null; end if;
  if not harness_control.release_in_effect(p_tenant, release_name) then return null; end if;
  perform 1 from harness_control.artifact_registry where tenant_id=p_tenant
    and artifact_kind='release-manifest' and digest=p_release and status='approved' for share;
  if not found then return null; end if;
  if release_document->'scope'->>'cohort'='sandbox' then
    -- Never in production; the bundle is the one this sandbox published, blockers and all.
    if p_environment = 'production' then return null; end if;
    perform 1 from harness_control.policy_revisions r where r.tenant_id=p_tenant
      and r.bundle_digest=p_bundle and r.status='PUBLISHED' and r.workspace_id like 'sandbox:%'
      and harness_control.policy_revision_in_effect(r.tenant_id, r.workspace_id, r.revision) for share of r;
    if not found then return null; end if;
    return release_document;
  end if;
  perform 1 from harness_control.artifact_registry where tenant_id=p_tenant
    and artifact_kind='policy-bundle' and digest=p_bundle and status='approved' for share;
  if not found then return null; end if;
  perform 1 from harness_control.policy_revisions r where r.tenant_id=p_tenant
    and r.bundle_digest=p_bundle and r.status='PUBLISHED' and r.release_blockers='[]'::jsonb
    and r.workspace_id not like 'sandbox:%'
    and harness_control.policy_revision_in_effect(r.tenant_id, r.workspace_id, r.revision) for share of r;
  if not found then return null; end if;
  return release_document;
end $$;
revoke all on function harness_runtime.lock_business_policy_authority(text,text,text,text,text,text) from public;
