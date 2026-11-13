create extension if not exists vector;

create table if not exists {{CASE_CORE_SCHEMA}}.knowledge_chunks (
  tenant_id text not null,
  chunk_id text not null,
  source_uri text not null,
  title text not null,
  content text not null,
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(1536) not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, chunk_id)
);

create index if not exists knowledge_chunks_embedding_hnsw_idx
  on {{CASE_CORE_SCHEMA}}.knowledge_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists knowledge_chunks_tenant_idx
  on {{CASE_CORE_SCHEMA}}.knowledge_chunks (tenant_id, created_at desc);
