-- Ledger hardening (docs/implementation/data-stores-plan.md §3.5, phase 3).
--
-- 1. Events enter the ledger only through case_ledger.append_event, which enforces the
--    per-case chain: the next sequence, linked to the current head, digest never reused.
--    No service role may insert into case_events, event_chain_heads or the case outbox.
-- 2. History is immutable: triggers refuse UPDATE, DELETE and TRUNCATE on the ledger's
--    record tables for every role, the table owner included. (A superuser can still switch
--    triggers off; that is why signed segments are exported, see ledger-export.ts.)
-- 3. New record tables: rejected commands, signed export segments, export cursors.
--    audit_exports moves from case_core to the ledger.

do $$
declare
  role_name text;
begin
  foreach role_name in array array[
    'ehf_ledger_writer',          -- owns append_event; never granted to a login
    'ehf_svc_ledger_exporter'     -- the signed segment exporter
  ] loop
    if not exists (select 1 from pg_roles where rolname = role_name) then
      execute format('create role %I nologin', role_name);
    end if;
  end loop;
end $$;

-- audit_exports is a record of what was exported, not case state.
alter table {{CASE_CORE_SCHEMA}}.audit_exports set schema {{CASE_LEDGER_SCHEMA}};

-- Command audit: a rejected command is not a ledger event (nothing changed), but who tried
-- what, and why it was refused, is kept.
create table if not exists {{CASE_LEDGER_SCHEMA}}.rejected_commands (
  tenant_id      text not null,
  case_id        text not null,
  command_id     text not null,
  command_type   text not null,
  request_digest char(64) not null,
  reason_code    text not null,
  http_status    integer not null check (http_status between 400 and 499),
  actor          jsonb not null,
  rejected_at    timestamptz not null default clock_timestamp(),
  primary key (tenant_id, case_id, command_id, request_digest, reason_code)
);
create index if not exists rejected_commands_case_idx
  on {{CASE_LEDGER_SCHEMA}}.rejected_commands(tenant_id, case_id, rejected_at desc);

-- One signed export of a tenant's ledger: for each case, the events after the previous
-- segment's head up to this segment's head. The bytes live in the export store; this row
-- records what they must hash to and who signed them.
create table if not exists {{CASE_LEDGER_SCHEMA}}.ledger_segments (
  tenant_id        text not null,
  segment_id       text not null,
  segment_number   bigint not null check (segment_number > 0),
  previous_segment_id text,
  event_count      integer not null check (event_count > 0),
  case_ranges      jsonb not null,  -- [{caseId, fromSequence, toSequence, anchorDigest, headDigest}]
  merkle_root      char(64) not null,
  events_digest    char(64) not null,  -- sha256 of the exact NDJSON bytes exported
  manifest_digest  char(64) not null,
  signature        text not null,
  signing_key_id   text not null,
  algorithm        text not null check (algorithm = 'RS256'),
  export_ref       text not null,
  created_at       timestamptz not null default clock_timestamp(),
  primary key (tenant_id, segment_id),
  unique (tenant_id, segment_number),
  unique (tenant_id, manifest_digest)
);

-- How far each case's ledger has been exported. The only mutable export state.
create table if not exists {{CASE_LEDGER_SCHEMA}}.export_cursors (
  tenant_id          text not null,
  case_id            text not null,
  exported_sequence  bigint not null check (exported_sequence > 0),
  head_digest        char(64) not null,
  segment_id         text not null,
  updated_at         timestamptz not null default clock_timestamp(),
  primary key (tenant_id, case_id),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id)
);

do $$
declare
  target text;
begin
  foreach target in array array[
    '{{CASE_LEDGER_SCHEMA}}.rejected_commands', '{{CASE_LEDGER_SCHEMA}}.ledger_segments',
    '{{CASE_LEDGER_SCHEMA}}.export_cursors'
  ] loop
    execute format('alter table %s enable row level security', target);
    execute format('alter table %s force row level security', target);
    execute format('drop policy if exists case_tenant_scope on %s', target);
    execute format($policy$
      create policy case_tenant_scope on %s
      using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
    $policy$, target);
  end loop;
end $$;

-- Immutability. No role may change or remove a ledger record once written.
create or replace function {{CASE_LEDGER_SCHEMA}}.refuse_ledger_change() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  raise exception 'case_ledger.immutable: % on %.% is not permitted', tg_op, tg_table_schema, tg_table_name
    using errcode = 'insufficient_privilege';
end $$;

do $$
declare
  target text;
begin
  foreach target in array array['case_events', 'command_receipts', 'rejected_commands', 'ledger_segments', 'audit_exports'] loop
    execute format('drop trigger if exists ledger_immutable_row on {{CASE_LEDGER_SCHEMA}}.%I', target);
    execute format('create trigger ledger_immutable_row before update or delete on {{CASE_LEDGER_SCHEMA}}.%I
      for each row execute function {{CASE_LEDGER_SCHEMA}}.refuse_ledger_change()', target);
    execute format('drop trigger if exists ledger_immutable_truncate on {{CASE_LEDGER_SCHEMA}}.%I', target);
    execute format('create trigger ledger_immutable_truncate before truncate on {{CASE_LEDGER_SCHEMA}}.%I
      for each statement execute function {{CASE_LEDGER_SCHEMA}}.refuse_ledger_change()', target);
  end loop;
end $$;

-- The only way into the ledger. The caller has computed the event digest over the
-- canonical envelope (stableDigest); this function enforces what makes the chain a chain.
-- Recomputing the digest itself happens on verification (verifyCaseLedger, and offline
-- over exported segments), because the canonical form is defined in TypeScript.
create or replace function {{CASE_LEDGER_SCHEMA}}.append_event(
  p_tenant_id text, p_case_id text, p_case_sequence bigint, p_event_id text, p_event_type text,
  p_event_schema text, p_occurred_at timestamptz, p_recorded_at timestamptz, p_actor jsonb,
  p_command_id text, p_authority jsonb, p_payload jsonb, p_evidence_refs jsonb,
  p_previous_event_digest text, p_event_digest text,
  p_outbox_id text, p_classification text, p_outbox_payload jsonb
) returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  head_sequence bigint;
  head_digest text;
begin
  if p_tenant_id is distinct from nullif(current_setting('app.tenant_id', true), '') then
    raise exception 'case_ledger.tenant_unbound' using errcode = 'insufficient_privilege';
  end if;
  if p_event_digest !~ '^[a-f0-9]{64}$' then
    raise exception 'case_ledger.digest_invalid' using errcode = 'check_violation';
  end if;
  select h.case_sequence, h.event_digest into head_sequence, head_digest
  from {{CASE_LEDGER_SCHEMA}}.event_chain_heads h
  where h.tenant_id = p_tenant_id and h.case_id = p_case_id
  for update;
  if not found then
    if p_case_sequence <> 1 or p_previous_event_digest is not null then
      raise exception 'case_ledger.chain_broken: first event must be sequence 1 with no predecessor'
        using errcode = 'check_violation';
    end if;
    insert into {{CASE_LEDGER_SCHEMA}}.event_chain_heads(tenant_id, case_id, case_sequence, event_digest, updated_at)
    values (p_tenant_id, p_case_id, p_case_sequence, p_event_digest, p_recorded_at);
  else
    if p_case_sequence <> head_sequence + 1 or p_previous_event_digest is distinct from head_digest then
      raise exception 'case_ledger.chain_broken: expected sequence % after %, got % after %',
        head_sequence + 1, head_digest, p_case_sequence, p_previous_event_digest
        using errcode = 'check_violation';
    end if;
    update {{CASE_LEDGER_SCHEMA}}.event_chain_heads
    set case_sequence = p_case_sequence, event_digest = p_event_digest, updated_at = p_recorded_at
    where tenant_id = p_tenant_id and case_id = p_case_id;
  end if;
  insert into {{CASE_LEDGER_SCHEMA}}.case_events(
    tenant_id, case_id, case_sequence, event_id, event_type, event_schema, occurred_at, recorded_at,
    actor, command_id, authority, payload, evidence_refs, previous_event_digest, event_digest)
  values (p_tenant_id, p_case_id, p_case_sequence, p_event_id, p_event_type, p_event_schema, p_occurred_at,
    p_recorded_at, p_actor, p_command_id, p_authority, p_payload, p_evidence_refs, p_previous_event_digest,
    p_event_digest);
  insert into {{CASE_LEDGER_SCHEMA}}.outbox(
    outbox_id, tenant_id, case_id, case_sequence, event_id, event_type, classification, payload,
    source_event_digest, created_at)
  values (p_outbox_id, p_tenant_id, p_case_id, p_case_sequence, p_event_id, p_event_type, p_classification,
    p_outbox_payload, p_event_digest, p_recorded_at);
end $$;

grant usage, create on schema {{CASE_LEDGER_SCHEMA}} to ehf_ledger_writer;
do $$
begin
  if not (select rolsuper from pg_roles where rolname = current_user) then
    execute format('grant ehf_ledger_writer to %I', current_user);
  end if;
end $$;
alter function {{CASE_LEDGER_SCHEMA}}.append_event(text, text, bigint, text, text, text, timestamptz, timestamptz,
  jsonb, text, jsonb, jsonb, jsonb, text, text, text, text, jsonb) owner to ehf_ledger_writer;
