-- Policy activation (Product Policy Studio phase F): when each published revision takes effect.
-- Append-only: publishing now, scheduling a future date and rolling back each add a row; nothing
-- is edited. A revision is in effect once it is PUBLISHED and one of its activations has started.
create table harness_control.policy_activations (
  tenant_id text not null,
  workspace_id text not null,
  activation_id text not null,
  revision integer not null,
  kind text not null check (kind in ('PUBLISH','SCHEDULE','ROLLBACK')),
  effective_from timestamptz not null,
  actor text not null,
  reason text not null default '',
  created_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, workspace_id, activation_id),
  foreign key (tenant_id, workspace_id, revision) references harness_control.policy_revisions(tenant_id, workspace_id, revision)
);
create index policy_activations_effective_idx on harness_control.policy_activations(tenant_id, workspace_id, effective_from desc);
alter table harness_control.policy_activations enable row level security;
alter table harness_control.policy_activations force row level security;
create policy harness_control_tenant_scope on harness_control.policy_activations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''));

-- Revisions published before activations existed took effect when they were published.
insert into harness_control.policy_activations(tenant_id, workspace_id, activation_id, revision, kind, effective_from, actor, reason, created_at)
select tenant_id, workspace_id, 'pact_backfill_' || revision, revision, 'PUBLISH', updated_at, coalesce(published_by, 'migration'), 'Published before activation history', updated_at
from harness_control.policy_revisions where status = 'PUBLISHED'
on conflict do nothing;

-- A revision a rollback supersedes keeps its compiled bundle: SUPERSEDED joins the statuses that carry one.
alter table harness_control.policy_revisions drop constraint policy_revisions_check;
alter table harness_control.policy_revisions add constraint policy_revisions_bundle_by_status
  check ((status in ('COMPILED','APPROVED','PUBLISHED','SUPERSEDED')) = (compiled_bundle is not null));

-- Whether a revision is in effect now: PUBLISHED, with an activation that has started.
create or replace function harness_control.policy_revision_in_effect(p_tenant text, p_workspace text, p_revision integer)
returns boolean language sql stable security definer set search_path = pg_catalog as $$
  select exists (select 1 from harness_control.policy_revisions r
    join harness_control.policy_activations a on a.tenant_id=r.tenant_id and a.workspace_id=r.workspace_id and a.revision=r.revision
    where r.tenant_id=p_tenant and r.workspace_id=p_workspace and r.revision=p_revision and r.status='PUBLISHED'
      and a.effective_from <= transaction_timestamp())
$$;
revoke all on function harness_control.policy_revision_in_effect(text,text,integer) from public;

-- The business-policy authority now also requires the bundle's revision to be in effect, so a
-- scheduled revision decides nothing before its date and a rolled-back one nothing after.
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
  perform 1 from harness_control.policy_revisions r where r.tenant_id=p_tenant
    and r.bundle_digest=p_bundle and r.status='PUBLISHED' and r.release_blockers='[]'::jsonb
    and harness_control.policy_revision_in_effect(r.tenant_id, r.workspace_id, r.revision) for share of r;
  if not found then return null; end if;
  return release_document;
end $$;
revoke all on function harness_runtime.lock_business_policy_authority(text,text,text,text,text,text) from public;
