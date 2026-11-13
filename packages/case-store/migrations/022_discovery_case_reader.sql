-- The synthetic worker only reads case identity and the stored intake receipt.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ehf_svc_discovery_case_reader') then
    create role ehf_svc_discovery_case_reader nologin;
  end if;
end;
$$;

create view {{CASE_CORE_SCHEMA}}.discovery_corporate_anchors with (security_barrier = true) as
select tenant_id, case_id, subject_id, revision, display_name, updated_at
from {{CASE_CORE_SCHEMA}}.case_subjects
where tenant_id = nullif(current_setting('app.tenant_id', true), '')
  and subject_type = 'legal_entity' and attributes->>'role' = 'customer';
