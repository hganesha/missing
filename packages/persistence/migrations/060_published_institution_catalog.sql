-- The product resolver (Product Policy Studio phase G) resolves a case's offerings through the
-- institution's PUBLISHED catalog. The case service cannot read control tables, so it reads only
-- this: the published document for one tenant and institution, or null.
create or replace function harness_runtime.published_institution_catalog(p_tenant text, p_institution text)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog as $$
declare document jsonb;
begin
  perform set_config('app.tenant_id', p_tenant, true);
  select r.document into document from harness_admin.institution_catalog_revisions r
    where r.tenant_id=p_tenant and r.institution_id=p_institution and r.status='PUBLISHED';
  return document;
end $$;
revoke all on function harness_runtime.published_institution_catalog(text,text) from public;
