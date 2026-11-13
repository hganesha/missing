-- Service roles, tenant isolation on every case table, and a narrow relay interface.
--
-- See docs/implementation/data-stores-plan.md §4. What each role may touch is declared in
-- packages/case-store/grants.sql, which the migration runner re-applies on every run.
-- Roles are cluster-wide, so one PostgreSQL cluster serves one environment.

do $$
declare
  role_name text;
begin
  foreach role_name in array array[
    'ehf_svc_case_api',            -- apps/case-api: the only writer of case, ledger and evidence rows
    'ehf_svc_case_outbox_relay',   -- the outbox relay (runs inside case-api): relay functions only
    'ehf_svc_case_retrieval',      -- apps/capability-gateway: reads the retrieval index only
    'ehf_audit_reader',            -- read-only verification
    'ehf_case_relay_controller'    -- owns the relay functions; never granted to a login
  ] loop
    if not exists (select 1 from pg_roles where rolname = role_name) then
      execute format('create role %I nologin', role_name);
    end if;
  end loop;
end $$;

-- Tenant isolation. Until now only canonical_records, financial_crime_outcomes and
-- skill_effects had a policy. Every other tenant table gets the same one. Forced, so the
-- table owner is subject to it too; superusers and BYPASSRLS roles still are not, which is
-- why no service may connect as either.
create or replace function pg_temp.enable_tenant_policy(target regclass, relay_reads boolean) returns void
language plpgsql as $$
begin
  execute format('alter table %s enable row level security', target);
  execute format('alter table %s force row level security', target);
  execute format('drop policy if exists case_tenant_scope on %s', target);
  if relay_reads then
    -- The relay functions run as ehf_case_relay_controller and read across tenants.
    execute format($policy$
      create policy case_tenant_scope on %s
      using (
        tenant_id = nullif(current_setting('app.tenant_id', true), '')
        or (select pg_has_role(current_user, 'ehf_case_relay_controller', 'member'))
      )
      with check (
        tenant_id = nullif(current_setting('app.tenant_id', true), '')
        or (select pg_has_role(current_user, 'ehf_case_relay_controller', 'member'))
      )
    $policy$, target);
  else
    execute format($policy$
      create policy case_tenant_scope on %s
      using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
    $policy$, target);
  end if;
end $$;

select pg_temp.enable_tenant_policy('{{CASE_CORE_SCHEMA}}.cases'::regclass, true);
select pg_temp.enable_tenant_policy('{{CASE_CORE_SCHEMA}}.case_subjects'::regclass, false);
select pg_temp.enable_tenant_policy('{{CASE_CORE_SCHEMA}}.case_subject_identifiers'::regclass, false);
select pg_temp.enable_tenant_policy('{{CASE_CORE_SCHEMA}}.case_risk'::regclass, false);
select pg_temp.enable_tenant_policy('{{CASE_CORE_SCHEMA}}.case_evidence_refs'::regclass, false);
select pg_temp.enable_tenant_policy('{{CASE_CORE_SCHEMA}}.case_claims'::regclass, false);
select pg_temp.enable_tenant_policy('{{CASE_CORE_SCHEMA}}.case_facts'::regclass, false);
select pg_temp.enable_tenant_policy('{{CASE_CORE_SCHEMA}}.case_findings'::regclass, false);
select pg_temp.enable_tenant_policy('{{CASE_CORE_SCHEMA}}.case_assumptions'::regclass, false);
select pg_temp.enable_tenant_policy('{{CASE_CORE_SCHEMA}}.case_contradictions'::regclass, false);
select pg_temp.enable_tenant_policy('{{CASE_CORE_SCHEMA}}.case_work_items'::regclass, false);
select pg_temp.enable_tenant_policy('{{CASE_CORE_SCHEMA}}.case_decision_recommendations'::regclass, false);
select pg_temp.enable_tenant_policy('{{CASE_CORE_SCHEMA}}.case_gate_results'::regclass, false);
select pg_temp.enable_tenant_policy('{{CASE_CORE_SCHEMA}}.case_reviews'::regclass, false);
select pg_temp.enable_tenant_policy('{{CASE_CORE_SCHEMA}}.case_final_dispositions'::regclass, false);
select pg_temp.enable_tenant_policy('{{CASE_CORE_SCHEMA}}.case_execution_refs'::regclass, false);
select pg_temp.enable_tenant_policy('{{CASE_CORE_SCHEMA}}.policy_evaluations'::regclass, false);
select pg_temp.enable_tenant_policy('{{CASE_CORE_SCHEMA}}.audit_exports'::regclass, false);
select pg_temp.enable_tenant_policy('{{CASE_CORE_SCHEMA}}.knowledge_chunks'::regclass, false);
select pg_temp.enable_tenant_policy('{{CASE_LEDGER_SCHEMA}}.case_events'::regclass, false);
select pg_temp.enable_tenant_policy('{{CASE_LEDGER_SCHEMA}}.event_chain_heads'::regclass, false);
select pg_temp.enable_tenant_policy('{{CASE_LEDGER_SCHEMA}}.command_receipts'::regclass, false);
select pg_temp.enable_tenant_policy('{{CASE_LEDGER_SCHEMA}}.outbox'::regclass, true);
select pg_temp.enable_tenant_policy('{{EVIDENCE_SCHEMA}}.artifacts'::regclass, false);
select pg_temp.enable_tenant_policy('{{EVIDENCE_SCHEMA}}.evidence_objects'::regclass, false);
select pg_temp.enable_tenant_policy('{{EVIDENCE_SCHEMA}}.transformations'::regclass, false);
select pg_temp.enable_tenant_policy('{{EVIDENCE_SCHEMA}}.lineage_edges'::regclass, false);
select pg_temp.enable_tenant_policy('{{EVIDENCE_SCHEMA}}.registration_receipts'::regclass, false);
select pg_temp.enable_tenant_policy('{{EVIDENCE_SCHEMA}}.outbox'::regclass, true);

-- The relay. It must see every tenant's unpublished outbox rows, so it cannot run under a
-- tenant-bound role, and granting a whole service cross-tenant reads would undo the
-- policies above. Instead the four things it does are functions owned by
-- ehf_case_relay_controller. A caller receives outbox metadata (ids, types,
-- classification, plan digest), never payloads or case content.

create or replace function {{CASE_LEDGER_SCHEMA}}.relay_claim_outbox(p_batch integer, p_claim_id text, p_timeout_seconds integer)
returns table (outbox_id text, tenant_id text, case_id text, event_id text, case_sequence bigint,
               event_type text, classification text, created_at timestamptz, harness_plan_digest text)
language sql security definer set search_path = pg_catalog, pg_temp as $$
  with candidates as (
    select o.outbox_id from {{CASE_LEDGER_SCHEMA}}.outbox o
    where o.published_at is null
      and (o.publish_claimed_at is null or o.publish_claimed_at < now() - make_interval(secs => p_timeout_seconds))
    order by o.created_at
    for update skip locked
    limit greatest(1, least(p_batch, 500))
  ), claimed as (
    update {{CASE_LEDGER_SCHEMA}}.outbox o
    set publish_claim_id = p_claim_id, publish_claimed_at = now(), publish_attempts = o.publish_attempts + 1
    from candidates
    where o.outbox_id = candidates.outbox_id
    returning o.outbox_id, o.tenant_id, o.case_id, o.event_id, o.case_sequence, o.event_type, o.classification, o.created_at
  )
  select c.outbox_id, c.tenant_id, c.case_id, c.event_id, c.case_sequence, c.event_type, c.classification,
         c.created_at, k.harness_plan_digest
  from claimed c
  left join {{CASE_CORE_SCHEMA}}.cases k on k.tenant_id = c.tenant_id and k.case_id = c.case_id
  order by c.created_at
$$;

create or replace function {{EVIDENCE_SCHEMA}}.relay_claim_outbox(p_batch integer, p_claim_id text, p_timeout_seconds integer)
returns table (outbox_id text, tenant_id text, case_id text, event_id text, case_sequence bigint,
               event_type text, classification text, created_at timestamptz, harness_plan_digest text)
language sql security definer set search_path = pg_catalog, pg_temp as $$
  with candidates as (
    select o.outbox_id from {{EVIDENCE_SCHEMA}}.outbox o
    where o.published_at is null
      and (o.publish_claimed_at is null or o.publish_claimed_at < now() - make_interval(secs => p_timeout_seconds))
    order by o.created_at
    for update skip locked
    limit greatest(1, least(p_batch, 500))
  ), claimed as (
    update {{EVIDENCE_SCHEMA}}.outbox o
    set publish_claim_id = p_claim_id, publish_claimed_at = now(), publish_attempts = o.publish_attempts + 1
    from candidates
    where o.outbox_id = candidates.outbox_id
    returning o.outbox_id, o.tenant_id, o.case_id, o.evidence_id, o.event_type, o.classification, o.created_at
  )
  select c.outbox_id, c.tenant_id, c.case_id, c.evidence_id, null::bigint, c.event_type, c.classification,
         c.created_at, k.harness_plan_digest
  from claimed c
  left join {{CASE_CORE_SCHEMA}}.cases k on k.tenant_id = c.tenant_id and k.case_id = c.case_id
  order by c.created_at
$$;

create or replace function {{CASE_LEDGER_SCHEMA}}.relay_mark_published(p_claim_id text, p_outbox_ids text[])
returns integer language sql security definer set search_path = pg_catalog, pg_temp as $$
  with done as (
    update {{CASE_LEDGER_SCHEMA}}.outbox
    set published_at = now(), publish_claim_id = null, publish_claimed_at = null
    where publish_claim_id = p_claim_id and outbox_id = any(p_outbox_ids)
    returning 1
  ) select count(*)::integer from done
$$;

create or replace function {{EVIDENCE_SCHEMA}}.relay_mark_published(p_claim_id text, p_outbox_ids text[])
returns integer language sql security definer set search_path = pg_catalog, pg_temp as $$
  with done as (
    update {{EVIDENCE_SCHEMA}}.outbox
    set published_at = now(), publish_claim_id = null, publish_claimed_at = null
    where publish_claim_id = p_claim_id and outbox_id = any(p_outbox_ids)
    returning 1
  ) select count(*)::integer from done
$$;

create or replace function {{CASE_LEDGER_SCHEMA}}.relay_release_claim(p_claim_id text)
returns integer language sql security definer set search_path = pg_catalog, pg_temp as $$
  with released as (
    update {{CASE_LEDGER_SCHEMA}}.outbox
    set publish_claim_id = null, publish_claimed_at = null
    where publish_claim_id = p_claim_id
    returning 1
  ) select count(*)::integer from released
$$;

create or replace function {{EVIDENCE_SCHEMA}}.relay_release_claim(p_claim_id text)
returns integer language sql security definer set search_path = pg_catalog, pg_temp as $$
  with released as (
    update {{EVIDENCE_SCHEMA}}.outbox
    set publish_claim_id = null, publish_claimed_at = null
    where publish_claim_id = p_claim_id
    returning 1
  ) select count(*)::integer from released
$$;

-- A published outbox row is a delivery receipt, not evidence; the ledger is the record.
create or replace function {{CASE_LEDGER_SCHEMA}}.relay_purge_published(p_retention_days integer)
returns integer language sql security definer set search_path = pg_catalog, pg_temp as $$
  with purged as (
    delete from {{CASE_LEDGER_SCHEMA}}.outbox
    where published_at is not null and published_at < now() - make_interval(days => greatest(p_retention_days, 1))
    returning 1
  ) select count(*)::integer from purged
$$;

create or replace function {{EVIDENCE_SCHEMA}}.relay_purge_published(p_retention_days integer)
returns integer language sql security definer set search_path = pg_catalog, pg_temp as $$
  with purged as (
    delete from {{EVIDENCE_SCHEMA}}.outbox
    where published_at is not null and published_at < now() - make_interval(days => greatest(p_retention_days, 1))
    returning 1
  ) select count(*)::integer from purged
$$;

-- Handing ownership to another role needs CREATE on the schema for that role and, for a
-- migrator that is not a superuser (Azure's administrator is not), membership in it.
-- grants.sql takes CREATE away again once the owner is set.
grant usage, create on schema {{CASE_LEDGER_SCHEMA}}, {{EVIDENCE_SCHEMA}} to ehf_case_relay_controller;
do $$
begin
  if not (select rolsuper from pg_roles where rolname = current_user) then
    execute format('grant ehf_case_relay_controller to %I', current_user);
  end if;
end $$;

alter function {{CASE_LEDGER_SCHEMA}}.relay_claim_outbox(integer, text, integer) owner to ehf_case_relay_controller;
alter function {{EVIDENCE_SCHEMA}}.relay_claim_outbox(integer, text, integer) owner to ehf_case_relay_controller;
alter function {{CASE_LEDGER_SCHEMA}}.relay_mark_published(text, text[]) owner to ehf_case_relay_controller;
alter function {{EVIDENCE_SCHEMA}}.relay_mark_published(text, text[]) owner to ehf_case_relay_controller;
alter function {{CASE_LEDGER_SCHEMA}}.relay_release_claim(text) owner to ehf_case_relay_controller;
alter function {{EVIDENCE_SCHEMA}}.relay_release_claim(text) owner to ehf_case_relay_controller;
alter function {{CASE_LEDGER_SCHEMA}}.relay_purge_published(integer) owner to ehf_case_relay_controller;
alter function {{EVIDENCE_SCHEMA}}.relay_purge_published(integer) owner to ehf_case_relay_controller;
