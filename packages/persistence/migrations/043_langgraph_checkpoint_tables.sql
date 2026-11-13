-- LangGraph checkpoint tables, owned by the migration identity.
--
-- @langchain/langgraph-checkpoint-postgres creates these from PostgresSaver.setup(), which
-- starts with CREATE SCHEMA IF NOT EXISTS. PostgreSQL checks CREATE on the database before
-- it checks whether the schema exists, so the runtime host could only start if its login
-- held CREATE on the whole control database. Creating the tables here instead lets the
-- runtime host hold DML on four tables and nothing else (grants.sql), and lets the case
-- data release be granted on them like any other table.
--
-- The DDL is the package's migrations 0-4 (version 1.0.5) in their final shape, and the
-- package's own migration ledger records them as applied. apps/runtime-host checks that
-- ledger at start and refuses to run against a version it does not expect; its
-- checkpoint test compares these tables with what the package's setup() creates, so an
-- upgrade that adds a migration fails there and needs a migration here.

create schema if not exists langgraph_checkpoint;

-- Before this migration the runtime host's login created the tables (when it was allowed
-- to). Take them over so the grant matrix can be re-applied over them.
do $$
declare
  existing record;
begin
  for existing in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'langgraph_checkpoint' and c.relkind = 'r'
      and c.relname in ('checkpoint_migrations', 'checkpoints', 'checkpoint_blobs', 'checkpoint_writes')
      and c.relowner <> (select oid from pg_roles where rolname = current_user)
  loop
    begin
      execute format('alter table langgraph_checkpoint.%I owner to current_user', existing.relname);
    exception when insufficient_privilege then
      raise exception 'langgraph_checkpoint.% is owned by another role; the migration identity must be a member of it (or a superuser) to take it over', existing.relname;
    end;
  end loop;
end $$;

create table if not exists langgraph_checkpoint.checkpoint_migrations (
  v integer primary key
);

create table if not exists langgraph_checkpoint.checkpoints (
  thread_id text not null,
  checkpoint_ns text not null default '',
  checkpoint_id text not null,
  parent_checkpoint_id text,
  type text,
  checkpoint jsonb not null,
  metadata jsonb not null default '{}',
  primary key (thread_id, checkpoint_ns, checkpoint_id)
);

create table if not exists langgraph_checkpoint.checkpoint_blobs (
  thread_id text not null,
  checkpoint_ns text not null default '',
  channel text not null,
  version text not null,
  type text not null,
  blob bytea,
  primary key (thread_id, checkpoint_ns, channel, version)
);

create table if not exists langgraph_checkpoint.checkpoint_writes (
  thread_id text not null,
  checkpoint_ns text not null default '',
  checkpoint_id text not null,
  task_id text not null,
  idx integer not null,
  channel text not null,
  type text,
  blob bytea not null,
  primary key (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
);

-- Package migration 4, for tables an older saver created before it existed.
alter table langgraph_checkpoint.checkpoint_blobs alter column blob drop not null;

insert into langgraph_checkpoint.checkpoint_migrations (v)
select generate_series(0, 4)
on conflict (v) do nothing;
