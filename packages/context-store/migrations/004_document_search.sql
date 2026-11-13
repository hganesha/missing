do $$ begin
 if not exists(select 1 from pg_roles where rolname='ehf_svc_document_index') then create role ehf_svc_document_index nologin; end if;
end $$;
-- Rebuildable lexical index, separate from durable artifacts and canonical records.
create table context.document_generations (
 tenant_id text not null, case_id text not null, document_id text not null, generation text not null,
 document_version text not null, artifact_hash text not null, artifact_ref text not null,
 authorization_digest text not null, subject_ids text[] not null, purposes text[] not null,
 access_roles text[] not null, residency text not null, parser_version text not null,
 chunker_version text not null, text_coverage text not null,
 active boolean not null default true, created_at timestamptz not null default now(), withdrawn_at timestamptz,
 primary key(tenant_id,case_id,document_id,generation)
);
create unique index document_one_active on context.document_generations(tenant_id,case_id,document_id) where active;
create table context.document_chunks (
 tenant_id text not null, case_id text not null, document_id text not null, generation text not null,
 citation_id text not null, page integer not null, span_start integer not null, span_end integer not null,
 chunk_digest text not null, content text, page_record_id text not null, page_record_version text not null,
 primary key(tenant_id,citation_id),
 foreign key(tenant_id,case_id,document_id,generation) references context.document_generations
);
create index document_chunk_text on context.document_chunks using gin(to_tsvector('simple',coalesce(content,'')));
do $$ declare t text; begin
 foreach t in array array['document_generations','document_chunks'] loop
 execute format('alter table context.%I enable row level security',t);
 execute format('alter table context.%I force row level security',t);
 execute format('create policy tenant_scope on context.%I using (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')) with check (tenant_id=nullif(current_setting(''app.tenant_id'',true),''''))',t);
 end loop;
end $$;
