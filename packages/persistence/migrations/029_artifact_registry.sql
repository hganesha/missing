-- Artifact registry: the single trust anchor for compiled governance artifacts.
--
-- Policy bundles, release manifests, deployment packages, bootstrap plans and
-- platform releases used to carry detached Key Vault signatures that every reader
-- verified against a configured public-key map, with a separate key-revocation
-- table. That made trust depend on key distribution and let a single key
-- revocation silently disable every artifact it had signed.
--
-- Trust is now a row: an artifact is executable only while this registry holds an
-- entry for (tenant, kind, digest) that was approved by someone other than its
-- registrant and has not been revoked. Readers recompute the digest from content,
-- so the registry row binds exact bytes. Revocation is per artifact.

create table if not exists harness_control.artifact_registry (
  tenant_id text not null,
  artifact_kind text not null check (artifact_kind in (
    'policy-bundle','release-manifest','deployment-package','bootstrap-plan','platform-release'
  )),
  digest char(64) not null check (digest ~ '^[a-f0-9]{64}$'),
  reference text not null check (length(reference) between 1 and 300),
  status text not null check (status in ('registered','approved','revoked')),
  registered_by text not null,
  approved_by text,
  revoked_by text,
  reason_code text,
  registered_at timestamptz not null default transaction_timestamp(),
  approved_at timestamptz,
  revoked_at timestamptz,
  primary key (tenant_id, artifact_kind, digest),
  check (approved_by is null or approved_by <> registered_by),
  check ((status = 'approved') <= (approved_by is not null)),
  check ((status = 'revoked') = (revoked_at is not null))
);

create table if not exists harness_control.artifact_registry_events (
  event_id text primary key,
  tenant_id text not null,
  artifact_kind text not null,
  digest char(64) not null,
  from_status text,
  to_status text not null,
  actor text not null,
  reason_code text,
  occurred_at timestamptz not null default transaction_timestamp(),
  foreign key (tenant_id, artifact_kind, digest)
    references harness_control.artifact_registry(tenant_id, artifact_kind, digest)
);

create index if not exists artifact_registry_recent_idx
  on harness_control.artifact_registry(tenant_id, registered_at desc);

do $$
declare
  relation_name text;
begin
  foreach relation_name in array array['artifact_registry', 'artifact_registry_events'] loop
    execute format('alter table harness_control.%I enable row level security', relation_name);
    execute format('alter table harness_control.%I force row level security', relation_name);
    execute format('drop policy if exists harness_control_tenant_scope on harness_control.%I', relation_name);
    execute format($policy$
      create policy harness_control_tenant_scope on harness_control.%I
      using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
    $policy$, relation_name);
  end loop;
end $$;

-- Backfill: carry existing governance state into the registry so artifacts that
-- were approved under signing remain executable, and artifacts signed by a revoked
-- key stay revoked.
insert into harness_control.artifact_registry(
  tenant_id, artifact_kind, digest, reference, status, registered_by, approved_by,
  registered_at, approved_at
)
select tenant_id, 'policy-bundle', bundle_digest, 'policy:' || workspace_id || '/' || revision,
  case when status in ('APPROVED','PUBLISHED','SUPERSEDED') and approved_by is not null then 'approved' else 'registered' end,
  authored_by,
  case when status in ('APPROVED','PUBLISHED','SUPERSEDED') then approved_by end,
  created_at,
  case when status in ('APPROVED','PUBLISHED','SUPERSEDED') then updated_at end
from harness_control.policy_revisions
where bundle_digest is not null
on conflict do nothing;

insert into harness_control.artifact_registry(
  tenant_id, artifact_kind, digest, reference, status, registered_by, approved_by,
  revoked_by, reason_code, registered_at, approved_at, revoked_at
)
select tenant_id, 'release-manifest', manifest_digest, 'release:' || release_id,
  case when status = 'revoked' then 'revoked'
       when status in ('approved','active','deprecated') and approved_by is not null then 'approved'
       else 'registered' end,
  created_by,
  approved_by,
  case when status = 'revoked' then coalesce(approved_by, created_by) end,
  case when status = 'revoked' then coalesce(reason_code, 'release.revoked') end,
  created_at,
  case when approved_by is not null then updated_at end,
  case when status = 'revoked' then coalesce(revoked_at, updated_at) end
from harness_control.release_manifests
on conflict do nothing;

update harness_control.artifact_registry registry
set status = 'revoked', revoked_by = revocation.actor, revoked_at = revocation.revoked_at,
    reason_code = 'artifact.signing_key_revoked'
from harness_control.policy_revisions policy
join harness_control.signing_key_revocations revocation
  on revocation.tenant_id = policy.tenant_id
 and revocation.key_id = policy.compiled_bundle->'signature'->>'keyId'
 and revocation.key_version = policy.compiled_bundle->'signature'->>'keyVersion'
where registry.tenant_id = policy.tenant_id and registry.artifact_kind = 'policy-bundle'
  and registry.digest = policy.bundle_digest and registry.status <> 'revoked';

update harness_control.artifact_registry registry
set status = 'revoked', revoked_by = revocation.actor, revoked_at = revocation.revoked_at,
    reason_code = 'artifact.signing_key_revoked'
from harness_control.release_manifests release
join harness_control.signing_key_revocations revocation
  on revocation.tenant_id = release.tenant_id
 and revocation.key_id = release.manifest->'signature'->>'keyId'
 and revocation.key_version = release.manifest->'signature'->>'keyVersion'
where registry.tenant_id = release.tenant_id and registry.artifact_kind = 'release-manifest'
  and registry.digest = release.manifest_digest and registry.status <> 'revoked';

insert into harness_control.artifact_registry_events(
  event_id, tenant_id, artifact_kind, digest, from_status, to_status, actor, reason_code
)
select 'aevt_backfill_' || md5(tenant_id || artifact_kind || digest), tenant_id, artifact_kind,
  digest, null, status, registered_by, 'artifact.registry_backfill'
from harness_control.artifact_registry
on conflict do nothing;

-- Detached signatures are no longer part of any artifact contract.
update harness_control.policy_revisions set compiled_bundle = compiled_bundle - 'signature'
where compiled_bundle ? 'signature';
update harness_control.release_manifests set manifest = manifest - 'signature'
where manifest ? 'signature';


update harness_control.environment_deployments set package_manifest = package_manifest - 'signature'
where package_manifest ? 'signature';
update harness_control.environment_deployment_events
set details = (details - 'signedPackage')
  || jsonb_build_object('packageSnapshot', (details->'signedPackage') #- '{manifest,signature}')
where details ? 'signedPackage';

drop table if exists harness_control.signing_key_revocations;
