-- Published/verified skill content is immutable. Draft edits invalidate inherited maturity.
alter table harness_control.business_skill_registry add column content_frozen boolean not null default false;
update harness_control.business_skill_registry set content_frozen=true
  where status <> 'draft' or maturity in ('integration_verified','production_qualified');
create or replace function harness_control.guard_business_skill_content() returns trigger
language plpgsql as $$
begin
  if TG_OP = 'DELETE' then
    if old.content_frozen then
      raise exception 'business_skill.released_version_immutable' using errcode = '23514';
    end if;
    return old;
  end if;
  if TG_OP = 'INSERT' then
    new.content_frozen := new.status <> 'draft' or new.maturity in ('integration_verified','production_qualified');
    return new;
  end if;
  if new.manifest is distinct from old.manifest and new.manifest_digest = old.manifest_digest then
    raise exception 'business_skill.manifest_digest_required' using errcode = '23514';
  end if;
  if new.manifest_digest is distinct from old.manifest_digest then
    if old.content_frozen then
      raise exception 'business_skill.released_version_immutable' using errcode = '23514';
    end if;
    new.status := 'draft';
    new.maturity := case when new.manifest->>'maturity' in ('catalogued', 'designed', 'implemented_synthetic')
      then new.manifest->>'maturity' else 'designed' end;
  end if;
  new.content_frozen := old.content_frozen or new.status <> 'draft'
    or new.maturity in ('integration_verified','production_qualified');
  return new;
end $$;
drop trigger if exists guard_business_skill_content on harness_control.business_skill_registry;
create trigger guard_business_skill_content before insert or update or delete on harness_control.business_skill_registry
  for each row execute function harness_control.guard_business_skill_content();

alter table harness_control.artifact_registry drop constraint if exists artifact_registry_artifact_kind_check;
alter table harness_control.artifact_registry add constraint artifact_registry_artifact_kind_check
  check (artifact_kind in ('policy-bundle','release-manifest','deployment-package','bootstrap-plan',
    'platform-release','skill-bundle','skill-qualification'));

-- Content-addressed evidence; approval/revocation remains in the existing artifact registry.
create table harness_control.skill_qualifications (
  tenant_id text not null,
  digest char(64) not null check (digest ~ '^[a-f0-9]{64}$'),
  qualification jsonb not null,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, digest)
);
create index skill_qualifications_lookup_idx on harness_control.skill_qualifications
  (tenant_id, (qualification->>'skillId'), (qualification->>'skillVersion'), (qualification->>'planDigest'));
alter table harness_control.skill_qualifications enable row level security;
alter table harness_control.skill_qualifications force row level security;
create policy harness_control_tenant_scope on harness_control.skill_qualifications
  using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''));

create or replace function harness_control.reject_qualification_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'skill_qualification.immutable' using errcode = '23514';
end $$;
create trigger guard_skill_qualification before update or delete on harness_control.skill_qualifications
  for each row execute function harness_control.reject_qualification_mutation();
