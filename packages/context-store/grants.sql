-- Grant matrix for the context database (docs/implementation/data-stores-plan.md §4.1).
--
-- Re-applied in one transaction after every migration run: everything the service roles
-- held is revoked, then exactly this is granted. A new table is unreachable until listed
-- here, and grants.test.ts fails while any table is missing.

do $$
begin
  execute format('revoke all on database %I from public, ehf_svc_context_writer, ehf_svc_context_retrieval,
    ehf_svc_context_release, ehf_svc_document_index', current_database());
  execute format('grant connect on database %I to ehf_svc_context_writer, ehf_svc_context_retrieval,
    ehf_svc_context_release, ehf_svc_document_index, ehf_audit_reader', current_database());
end $$;

revoke all on all tables in schema context
  from public, ehf_svc_context_writer, ehf_svc_context_retrieval, ehf_svc_context_release, ehf_svc_document_index, ehf_audit_reader,
       ehf_context_graph_owner, ehf_context_releaser;
revoke all on all functions in schema context
  from public, ehf_svc_context_writer, ehf_svc_context_retrieval, ehf_svc_context_release, ehf_svc_document_index, ehf_audit_reader;
revoke all on schema context
  from public, ehf_svc_context_writer, ehf_svc_context_retrieval, ehf_svc_context_release, ehf_svc_document_index, ehf_audit_reader,
       ehf_context_graph_owner, ehf_context_releaser;
-- No service role reaches the graph schema or AGE's catalog directly.
revoke all on schema context_graph, ag_catalog
  from public, ehf_svc_context_writer, ehf_svc_context_retrieval, ehf_svc_context_release, ehf_svc_document_index, ehf_audit_reader;

-- What the graph functions need (they run as this role).
grant usage on schema context to ehf_context_graph_owner;
grant usage on schema ag_catalog, context_graph to ehf_context_graph_owner;
grant select, insert, update, delete on all tables in schema context_graph to ehf_context_graph_owner;
grant usage, select, update on all sequences in schema context_graph to ehf_context_graph_owner;
grant execute on function context.bound_tenant() to ehf_context_graph_owner;

-- control-api records packs for the runtime. Packs are written once; sections and signals
-- with them. It can read what it wrote (same tenant) and traverse the graph.
grant usage on schema context to ehf_svc_context_writer;
grant select, insert on context.packs, context.pack_sections, context.quarantine_signals to ehf_svc_context_writer;
grant execute on function context.bound_tenant(), context.graph_link_pack(text, text, jsonb),
  context.graph_packs_drawing_on(text), context.graph_sources_of(text) to ehf_svc_context_writer;

-- capability-gateway: similarity search over the retrieval index, read-only.
grant usage on schema context to ehf_svc_context_retrieval;
grant select on context.knowledge_chunks to ehf_svc_context_retrieval;

-- The release job (phase 4d): release_case for a closed case, and its own release records.
grant usage on schema context to ehf_svc_context_release;
grant execute on function context.bound_tenant(), context.release_case(text) to ehf_svc_context_release;
grant select, insert, update on context.case_releases to ehf_svc_context_release;
-- What release_case needs (it runs as this role): delete the case's context and graph nodes.
grant usage on schema context, ag_catalog, context_graph to ehf_context_releaser;
grant select, delete on context.packs, context.pack_sections, context.quarantine_signals, context.knowledge_chunks
  to ehf_context_releaser;
grant select, insert, update, delete on all tables in schema context_graph to ehf_context_releaser;
grant usage, select, update on all sequences in schema context_graph to ehf_context_releaser;
grant execute on function context.bound_tenant() to ehf_context_releaser;

-- Audit verification: read everything, change nothing (still tenant-bound by policy).
grant usage on schema context to ehf_audit_reader;
grant select on all tables in schema context to ehf_audit_reader;
grant execute on function context.bound_tenant(), context.graph_packs_drawing_on(text), context.graph_sources_of(text)
  to ehf_audit_reader;

-- Case API maintains rebuildable document text; evidence bytes stay in the case store.
grant usage on schema context to ehf_svc_document_index;
grant select,insert,update on context.document_generations,context.document_chunks to ehf_svc_document_index;
grant select on context.document_generations,context.document_chunks to ehf_svc_context_retrieval;
grant select,delete on context.document_generations,context.document_chunks to ehf_context_releaser;
