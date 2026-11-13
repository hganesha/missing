-- Releasing a closed case's context (data-stores-plan.md §3.3, phase 4d). What a decision
-- relied on was promoted to the case's evidence when the decision was accepted (phase 4c), so
-- once the case has been closed for the grace period its packs, sections, signals, case-scoped
-- retrieval chunks and graph nodes are deleted. The release job records each case here.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ehf_context_releaser') then
    create role ehf_context_releaser nologin;  -- owns release_case; never granted to a login
  end if;
end $$;

-- One row per case whose context has been, or is waiting to be, released. No content; kept
-- after release so "was this case's context released, when, and what survived" stays answerable.
create table if not exists context.case_releases (
  tenant_id          text not null,
  case_id            text not null,
  closed_sequence    bigint not null,
  closed_at          timestamptz not null,
  eligible_at        timestamptz not null,
  state              text not null check (state in ('SCHEDULED', 'BLOCKED', 'RELEASED')),
  blocked_reason     text check (blocked_reason in ('legal_hold', 'unpromoted_citation', 'active_execution', 'case_reopened')),
  counts             jsonb,
  promoted_evidence  jsonb,
  ledger_event_id    text,
  released_at        timestamptz,
  updated_at         timestamptz not null default clock_timestamp(),
  primary key (tenant_id, case_id, closed_sequence),
  check ((state = 'BLOCKED') = (blocked_reason is not null)),
  check ((state = 'RELEASED') = (released_at is not null))
);

alter table context.case_releases enable row level security;
alter table context.case_releases force row level security;
drop policy if exists context_tenant_scope on context.case_releases;
create policy context_tenant_scope on context.case_releases
  using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
  with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''));

-- Delete the bound tenant's context for one case: packs (their sections and signals cascade),
-- the case's retrieval chunks, its Pack nodes and every Source no longer linked. Idempotent.
create or replace function context.release_case(p_case_id text)
returns table (packs integer, sections integer, signals integer, chunks integer, graph_packs integer)
language plpgsql security definer set search_path = ag_catalog, pg_catalog, pg_temp as $$
declare
  tenant text := context.bound_tenant();
  removed_graph integer := 0;
begin
  select count(*) into sections from context.pack_sections s
    join context.packs p on p.tenant_id = s.tenant_id and p.pack_digest = s.pack_digest
    where p.tenant_id = tenant and p.case_id = p_case_id;
  select count(*) into signals from context.quarantine_signals q
    join context.packs p on p.tenant_id = q.tenant_id and p.pack_digest = q.pack_digest
    where p.tenant_id = tenant and p.case_id = p_case_id;
  delete from context.packs where tenant_id = tenant and case_id = p_case_id;
  get diagnostics packs = row_count;
  delete from context.knowledge_chunks where tenant_id = tenant and case_id = p_case_id;
  get diagnostics chunks = row_count;
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

grant usage, create on schema context to ehf_context_releaser;
do $$
begin
  if not (select rolsuper from pg_roles where rolname = current_user) then
    execute format('grant ehf_context_releaser to %I', current_user);
  end if;
end $$;
alter function context.release_case(text) owner to ehf_context_releaser;
