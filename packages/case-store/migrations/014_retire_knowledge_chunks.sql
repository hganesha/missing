-- The retrieval index moved to the context database (ehf_context, context.knowledge_chunks;
-- docs/implementation/data-stores-plan.md §3.3). It is derived data, not case truth, and the
-- capability gateway no longer needs any access to the case database for it.
--
-- Nothing in the platform writes this table. Drop it when it is empty; when an operator has
-- loaded chunks into it, keep them under a new name to re-index into the context store.
do $$
declare
  remaining bigint;
begin
  if to_regclass('{{CASE_CORE_SCHEMA}}.knowledge_chunks') is null then
    return;
  end if;
  -- The forced tenant policy would hide every row from a migrator that is not a superuser
  -- (Azure's administrator) and make a full table look empty.
  alter table {{CASE_CORE_SCHEMA}}.knowledge_chunks no force row level security;
  alter table {{CASE_CORE_SCHEMA}}.knowledge_chunks disable row level security;
  select count(*) into remaining from {{CASE_CORE_SCHEMA}}.knowledge_chunks;
  if remaining = 0 then
    drop table {{CASE_CORE_SCHEMA}}.knowledge_chunks;
  else
    alter table {{CASE_CORE_SCHEMA}}.knowledge_chunks enable row level security;
    alter table {{CASE_CORE_SCHEMA}}.knowledge_chunks force row level security;
    alter table {{CASE_CORE_SCHEMA}}.knowledge_chunks rename to knowledge_chunks_retired;
    raise notice 'case_core.knowledge_chunks held % row(s); renamed to knowledge_chunks_retired for re-indexing into ehf_context', remaining;
  end if;
end $$;
