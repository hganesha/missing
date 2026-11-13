-- The context store (docs/implementation/data-stores-plan.md §3.3): its own database,
-- ehf_context, with pgvector for the retrieval index and Apache AGE for the context
-- provenance graph. Working data for open cases; released after a case closes (phase 4d).
--
-- The tables are the record and carry forced tenant policies. The graph is a projection
-- for traversal ("which packs drew on this evidence?"); AGE label tables cannot carry a
-- usable row-level policy, so no service touches the graph directly: the functions below
-- take the tenant from the bound transaction (app.tenant_id), never from an argument.
--
-- AGE is preloaded for this database only (session_preload_libraries, set by the migration
-- runner); see src/migrate.ts for why not for the whole server.

create extension if not exists vector;
create extension if not exists age;

do $$
declare
  role_name text;
begin
  foreach role_name in array array[
    'ehf_svc_context_writer',      -- control-api, recording packs on behalf of the runtime
    'ehf_svc_context_retrieval',   -- capability-gateway, similarity search
    'ehf_svc_context_release',     -- the release job (phase 4d)
    'ehf_context_graph_owner',     -- owns the graph functions; never granted to a login
    'ehf_audit_reader'
  ] loop
    if not exists (select 1 from pg_roles where rolname = role_name) then
      execute format('create role %I nologin', role_name);
    end if;
  end loop;
end $$;

create schema if not exists context;

-- One context pack an agent or evaluate node was given: what it was shown, under which
-- plan, profile and budget. `pack` holds the rendered content (it contains case data) until
-- packs move to blob storage (phase 5); the rest is metadata.
create table if not exists context.packs (
  tenant_id        text not null,
  pack_digest      char(64) not null,
  case_id          text,
  run_id           text not null,
  node_id          text not null,
  attempt          integer not null check (attempt > 0),
  plan_digest      text not null,
  capability_id    text,
  agent_id         text,
  prompt_digest    text,
  manifest_digest  char(64),
  manifest         jsonb,
  snapshot_id      text,
  snapshot_digest  text,
  case_sequence    bigint,
  budget           jsonb not null,
  quarantined      boolean not null,
  pack             jsonb not null,
  recorded_at      timestamptz not null default clock_timestamp(),
  primary key (tenant_id, pack_digest)
);
create index if not exists packs_case_idx on context.packs(tenant_id, case_id, recorded_at desc);
create index if not exists packs_run_idx on context.packs(tenant_id, run_id, node_id);
create index if not exists packs_manifest_idx on context.packs(tenant_id, manifest_digest) where manifest_digest is not null;

create table if not exists context.pack_sections (
  tenant_id       text not null,
  pack_digest     char(64) not null,
  section_id      text not null,
  kind            text not null,
  trust           text not null check (trust in ('TRUSTED_DATA', 'UNTRUSTED_DATA', 'UNTRUSTED_EXTERNAL')),
  disposition     text not null check (disposition in ('INCLUDED', 'DROPPED_BUDGET', 'QUARANTINED')),
  required        boolean not null,
  classification  text not null,
  purpose         text not null,
  provenance_ref  text not null,
  content_digest  text not null,
  primary key (tenant_id, pack_digest, section_id),
  foreign key (tenant_id, pack_digest) references context.packs(tenant_id, pack_digest) on delete cascade
);

create table if not exists context.quarantine_signals (
  tenant_id    text not null,
  pack_digest  char(64) not null,
  section_id   text not null,
  signal       text not null,
  primary key (tenant_id, pack_digest, section_id, signal),
  foreign key (tenant_id, pack_digest) references context.packs(tenant_id, pack_digest) on delete cascade
);

-- The retrieval index, moved out of the case database. Derived and rebuildable; every chunk
-- names its source. Chunks built from one case's evidence carry case_id and are released
-- with the case; policy, procedure and reference chunks (case_id null) are kept.
create table if not exists context.knowledge_chunks (
  tenant_id        text not null,
  chunk_id         text not null,
  case_id          text,
  source_kind      text not null check (source_kind in ('policy', 'procedure', 'evidence', 'reference')),
  source_ref       text not null,
  source_digest    text,
  title            text not null,
  content          text not null,
  classification   text not null default 'INTERNAL',
  metadata         jsonb not null default '{}'::jsonb,
  embedding_model  text not null,
  embedding        vector(1536) not null,
  created_at       timestamptz not null default clock_timestamp(),
  primary key (tenant_id, chunk_id)
);
create index if not exists knowledge_chunks_embedding_hnsw_idx
  on context.knowledge_chunks using hnsw (embedding vector_cosine_ops);
create index if not exists knowledge_chunks_case_idx on context.knowledge_chunks(tenant_id, case_id) where case_id is not null;

do $$
declare
  target text;
begin
  foreach target in array array['packs', 'pack_sections', 'quarantine_signals', 'knowledge_chunks'] loop
    execute format('alter table context.%I enable row level security', target);
    execute format('alter table context.%I force row level security', target);
    execute format('drop policy if exists context_tenant_scope on context.%I', target);
    execute format($policy$
      create policy context_tenant_scope on context.%I
      using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
    $policy$, target);
  end loop;
end $$;

-- The provenance graph: (Pack)-[:DRAWS_ON {sectionId, trust, disposition}]->(Source).
-- Labels are created here so no runtime role ever needs CREATE on the graph schema.
do $$
begin
  if not exists (select 1 from ag_catalog.ag_graph where name = 'context_graph') then
    perform ag_catalog.create_graph('context_graph');
  end if;
  if not exists (select 1 from ag_catalog.ag_label l join ag_catalog.ag_graph g on g.graphid = l.graph
                 where g.name = 'context_graph' and l.name = 'Pack') then
    perform ag_catalog.create_vlabel('context_graph', 'Pack');
  end if;
  if not exists (select 1 from ag_catalog.ag_label l join ag_catalog.ag_graph g on g.graphid = l.graph
                 where g.name = 'context_graph' and l.name = 'Source') then
    perform ag_catalog.create_vlabel('context_graph', 'Source');
  end if;
  if not exists (select 1 from ag_catalog.ag_label l join ag_catalog.ag_graph g on g.graphid = l.graph
                 where g.name = 'context_graph' and l.name = 'DRAWS_ON') then
    perform ag_catalog.create_elabel('context_graph', 'DRAWS_ON');
  end if;
end $$;

create or replace function context.bound_tenant() returns text
language plpgsql stable set search_path = pg_catalog, pg_temp as $$
declare
  tenant text := nullif(current_setting('app.tenant_id', true), '');
begin
  if tenant is null then
    raise exception 'context.tenant_unbound' using errcode = 'insufficient_privilege';
  end if;
  return tenant;
end $$;

-- Link one pack to what it drew on. `p_sources` is [{ref, kind, sectionId, trust, disposition}].
-- Idempotent: recording the same pack again adds nothing.
create or replace function context.graph_link_pack(p_pack_digest text, p_case_id text, p_sources jsonb) returns void
language plpgsql security definer set search_path = ag_catalog, pg_catalog, pg_temp as $$
declare
  tenant text := context.bound_tenant();
  source jsonb;
begin
  execute format('select * from ag_catalog.cypher(%L, $q$
      MERGE (p:Pack {tenantId: $tenant, digest: $pack, caseId: $case})
    $q$, $1) as (r agtype)', 'context_graph')
  using (json_build_object('tenant', tenant, 'pack', p_pack_digest, 'case', coalesce(p_case_id, ''))::text)::ag_catalog.agtype;
  for source in select * from jsonb_array_elements(coalesce(p_sources, '[]'::jsonb)) loop
    -- One call per source: values from UNWIND over a parameter list do not bind in AGE 1.5,
    -- and SET after MERGE does not persist, so every property is part of the MERGE pattern.
    -- That is exact here: a pack, its sources and their links never change once recorded.
    execute format('select * from ag_catalog.cypher(%L, $q$
        MATCH (p:Pack {tenantId: $tenant, digest: $pack})
        MERGE (s:Source {tenantId: $tenant, ref: $ref, kind: $kind})
        MERGE (p)-[d:DRAWS_ON {sectionId: $section, trust: $trust, disposition: $disposition}]->(s)
      $q$, $1) as (r agtype)', 'context_graph')
    using (jsonb_build_object('tenant', tenant, 'pack', p_pack_digest, 'ref', source->>'ref', 'kind', source->>'kind',
      'section', source->>'sectionId', 'trust', source->>'trust', 'disposition', source->>'disposition')::text)::ag_catalog.agtype;
  end loop;
end $$;

-- Every pack of the bound tenant that drew on `p_ref` (an evidence id, a selector, a receipt).
create or replace function context.graph_packs_drawing_on(p_ref text)
returns table (pack_digest text, case_id text, section_id text, disposition text)
language plpgsql security definer set search_path = ag_catalog, pg_catalog, pg_temp as $$
declare
  tenant text := context.bound_tenant();
begin
  return query execute format('select pack::text, case_id::text, section::text, disposition::text from ag_catalog.cypher(%L, $q$
      MATCH (p:Pack)-[d:DRAWS_ON]->(s:Source)
      WHERE p.tenantId = $tenant AND s.tenantId = $tenant AND s.ref = $ref
      RETURN p.digest, p.caseId, d.sectionId, d.disposition
    $q$, $1) as (pack agtype, case_id agtype, section agtype, disposition agtype)', 'context_graph')
  using (json_build_object('tenant', tenant, 'ref', p_ref)::text)::ag_catalog.agtype;
end $$;

-- Everything one pack drew on.
create or replace function context.graph_sources_of(p_pack_digest text)
returns table (ref text, kind text, section_id text, disposition text)
language plpgsql security definer set search_path = ag_catalog, pg_catalog, pg_temp as $$
declare
  tenant text := context.bound_tenant();
begin
  return query execute format('select ref::text, kind::text, section::text, disposition::text from ag_catalog.cypher(%L, $q$
      MATCH (p:Pack)-[d:DRAWS_ON]->(s:Source)
      WHERE p.tenantId = $tenant AND p.digest = $pack AND s.tenantId = $tenant
      RETURN s.ref, s.kind, d.sectionId, d.disposition
    $q$, $1) as (ref agtype, kind agtype, section agtype, disposition agtype)', 'context_graph')
  using (json_build_object('tenant', tenant, 'pack', p_pack_digest)::text)::ag_catalog.agtype;
end $$;

grant usage, create on schema context to ehf_context_graph_owner;
do $$
begin
  if not (select rolsuper from pg_roles where rolname = current_user) then
    execute format('grant ehf_context_graph_owner to %I', current_user);
  end if;
end $$;
alter function context.graph_link_pack(text, text, jsonb) owner to ehf_context_graph_owner;
alter function context.graph_packs_drawing_on(text) owner to ehf_context_graph_owner;
alter function context.graph_sources_of(text) owner to ehf_context_graph_owner;
