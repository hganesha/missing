-- Release activation (phase H): when each active release takes effect. Append-only, as policy
-- activation is: activating now, scheduling a future date and rolling back each add a row. A
-- release's line is its environment and its plan's process (harness_control.plans.name); the
-- release in effect for a line is the active one whose activation started most recently, so a
-- scheduled release supersedes the one before it on its date, and nothing earlier decides after.
create table harness_control.release_activations (
  tenant_id text not null,
  activation_id text not null,
  release_id text not null,
  environment text not null,
  line text not null,
  kind text not null check (kind in ('ACTIVATE','SCHEDULE','ROLLBACK')),
  effective_from timestamptz not null,
  actor text not null,
  reason text not null default '',
  created_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, activation_id),
  foreign key (tenant_id, release_id) references harness_control.release_manifests(tenant_id, release_id)
);
create index release_activations_line_idx on harness_control.release_activations(tenant_id, environment, line, effective_from desc);
alter table harness_control.release_activations enable row level security;
alter table harness_control.release_activations force row level security;
create policy harness_control_tenant_scope on harness_control.release_activations
  using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''));

-- Releases active before activation history existed took effect when they were activated.
insert into harness_control.release_activations(tenant_id, activation_id, release_id, environment, line, kind, effective_from, actor, reason, created_at)
select m.tenant_id, 'ract_backfill_' || m.release_id, m.release_id, m.manifest->'scope'->>'environment', coalesce(p.name, m.plan_digest), 'ACTIVATE',
  coalesce(m.activated_at, m.updated_at), coalesce(m.approved_by, m.created_by), 'Activated before activation history', coalesce(m.activated_at, m.updated_at)
from harness_control.release_manifests m
left join harness_control.plans p on p.tenant_id = m.tenant_id and p.plan_digest = m.plan_digest
where m.status = 'active'
on conflict do nothing;

-- Whether a release is in effect now: active, with a started activation, and the most recent one
-- started among the active releases of its line.
create or replace function harness_control.release_in_effect(p_tenant text, p_release text)
returns boolean language sql stable security definer set search_path = pg_catalog as $$
  with mine as (
    select a.environment, a.line, a.effective_from, a.created_at from harness_control.release_activations a
    join harness_control.release_manifests m on m.tenant_id = a.tenant_id and m.release_id = a.release_id
    where a.tenant_id = p_tenant and a.release_id = p_release and m.status = 'active' and a.effective_from <= transaction_timestamp()
    order by a.effective_from desc, a.created_at desc limit 1
  )
  select exists (select 1 from mine) and not exists (
    select 1 from mine, harness_control.release_activations a
    join harness_control.release_manifests m on m.tenant_id = a.tenant_id and m.release_id = a.release_id
    where a.tenant_id = p_tenant and a.environment = mine.environment and a.line = mine.line and a.release_id <> p_release
      and m.status = 'active' and a.effective_from <= transaction_timestamp()
      and (a.effective_from, a.created_at) > (mine.effective_from, mine.created_at))
$$;
revoke all on function harness_control.release_in_effect(text,text) from public;

-- The business-policy authority now also requires the release to be in effect: a scheduled
-- release decides nothing before its date, and a superseded or rolled-back one nothing after.
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
