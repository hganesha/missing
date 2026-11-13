create or replace function context.release_case(p_case_id text)
returns table (packs integer, sections integer, signals integer, chunks integer, graph_packs integer)
language plpgsql security definer set search_path = ag_catalog, pg_catalog, pg_temp as $$
declare
  tenant text := context.bound_tenant();
  removed_graph integer := 0;
  removed_document_chunks integer := 0;
begin
  select count(*) into sections from context.pack_sections s
    join context.packs p on p.tenant_id = s.tenant_id and p.pack_digest = s.pack_digest
    where p.tenant_id = tenant and p.case_id = p_case_id;
  select count(*) into signals from context.quarantine_signals q
    join context.packs p on p.tenant_id = q.tenant_id and p.pack_digest = q.pack_digest
    where p.tenant_id = tenant and p.case_id = p_case_id;
  delete from context.packs where tenant_id = tenant and case_id = p_case_id;
  get diagnostics packs = row_count;
  delete from context.document_chunks where tenant_id=tenant and case_id=p_case_id;
  get diagnostics removed_document_chunks = row_count;
  delete from context.document_generations where tenant_id=tenant and case_id=p_case_id;
  delete from context.knowledge_chunks where tenant_id = tenant and case_id = p_case_id;
  get diagnostics chunks = row_count;
  chunks := chunks + removed_document_chunks;
  execute format('select count(*)::integer from ag_catalog.cypher(%L, $q$
      MATCH (p:Pack {tenantId: $tenant, caseId: $case}) DETACH DELETE p RETURN 1
    $q$, $1) as (r agtype)', 'context_graph')
  into removed_graph
  using (json_build_object('tenant', tenant, 'case', p_case_id)::text)::ag_catalog.agtype;
  -- Sources nothing draws on any more (another case's packs keep a shared source alive).
  execute format('select count(*)::integer from ag_catalog.cypher(%L, $q$
      MATCH (s:Source {tenantId: $tenant}) OPTIONAL MATCH (s)<-[d:DRAWS_ON]-()
      WITH s, count(d) AS uses WHERE uses = 0 DELETE s RETURN 1
    $q$, $1) as (r agtype)', 'context_graph')
  using (json_build_object('tenant', tenant)::text)::ag_catalog.agtype;
  graph_packs := removed_graph;
  return next;
end $$;

alter function context.release_case(text) owner to ehf_context_releaser;
