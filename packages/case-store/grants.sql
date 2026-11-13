-- Grant matrix for the case database (docs/implementation/data-stores-plan.md §4.1).
--
-- Re-applied in one transaction after every migration run: everything the service roles
-- held is revoked, then exactly this is granted. A table added by a migration is
-- unreachable by every service until it is listed here (fail closed), and grants.test.ts
-- fails while any table is missing from this file.

-- Who may connect at all. Nobody by default; case-api, the relay, the ledger exporter and the
-- evidence retention job by group.
-- In a split deployment no control-plane identity (runtime, control-api, integration
-- worker) can open a session here.
do $$
begin
  execute format('revoke all on database %I from public, ehf_svc_case_api, ehf_svc_case_outbox_relay,
    ehf_svc_case_retrieval, ehf_svc_ledger_exporter, ehf_svc_evidence_retention', current_database());
  execute format('grant connect on database %I to ehf_svc_case_api, ehf_svc_case_outbox_relay,
    ehf_svc_ledger_exporter, ehf_svc_evidence_retention, ehf_audit_reader', current_database());
end $$;

revoke all on all tables in schema {{CASE_CORE_SCHEMA}}, {{CASE_LEDGER_SCHEMA}}, {{EVIDENCE_SCHEMA}}
  from public, ehf_svc_case_api, ehf_svc_case_outbox_relay, ehf_svc_case_retrieval, ehf_svc_ledger_exporter,
       ehf_svc_evidence_retention, ehf_audit_reader, ehf_case_relay_controller, ehf_ledger_writer;
revoke all on all functions in schema {{CASE_CORE_SCHEMA}}, {{CASE_LEDGER_SCHEMA}}, {{EVIDENCE_SCHEMA}}
  from public, ehf_svc_case_api, ehf_svc_case_outbox_relay, ehf_svc_case_retrieval, ehf_svc_ledger_exporter,
       ehf_svc_evidence_retention, ehf_audit_reader;
revoke all on schema {{CASE_CORE_SCHEMA}}, {{CASE_LEDGER_SCHEMA}}, {{EVIDENCE_SCHEMA}}
  from public, ehf_svc_case_api, ehf_svc_case_outbox_relay, ehf_svc_case_retrieval, ehf_svc_ledger_exporter,
       ehf_svc_evidence_retention, ehf_audit_reader, ehf_case_relay_controller, ehf_ledger_writer;

-- case-api: the case command gateway, the only writer of case, ledger and evidence rows.
-- No DELETE anywhere: corrections are new rows and new ledger events.
grant usage on schema {{CASE_CORE_SCHEMA}}, {{CASE_LEDGER_SCHEMA}}, {{EVIDENCE_SCHEMA}} to ehf_svc_case_api;
grant select, insert, update on all tables in schema {{CASE_CORE_SCHEMA}} to ehf_svc_case_api;
revoke all on {{CASE_CORE_SCHEMA}}.schema_migrations from ehf_svc_case_api;
-- A retained pre-move retrieval index (migration 014) is nobody's to read or write.
do $$
begin
  if to_regclass('{{CASE_CORE_SCHEMA}}.knowledge_chunks_retired') is not null then
    revoke all on {{CASE_CORE_SCHEMA}}.knowledge_chunks_retired from ehf_svc_case_api, ehf_audit_reader;
  end if;
end $$;
-- Events enter the ledger only through append_event, which enforces the chain; case-api
-- cannot insert an event, move a chain head or write the case outbox itself. Receipts,
-- rejections and audit exports it inserts directly; triggers forbid changing any of them.
grant select on {{CASE_LEDGER_SCHEMA}}.case_events, {{CASE_LEDGER_SCHEMA}}.event_chain_heads to ehf_svc_case_api;
grant execute on function {{CASE_LEDGER_SCHEMA}}.append_event(text, text, bigint, text, text, text,
  timestamptz, timestamptz, jsonb, text, jsonb, jsonb, jsonb, text, text, text, text, jsonb) to ehf_svc_case_api;
grant select, insert on {{CASE_LEDGER_SCHEMA}}.command_receipts, {{CASE_LEDGER_SCHEMA}}.rejected_commands,
  {{CASE_LEDGER_SCHEMA}}.audit_exports to ehf_svc_case_api;
-- What append_event itself needs (it runs as this role).
grant usage on schema {{CASE_LEDGER_SCHEMA}} to ehf_ledger_writer;
grant select, insert on {{CASE_LEDGER_SCHEMA}}.case_events to ehf_ledger_writer;
grant select, insert, update on {{CASE_LEDGER_SCHEMA}}.event_chain_heads to ehf_ledger_writer;
grant insert on {{CASE_LEDGER_SCHEMA}}.outbox to ehf_ledger_writer;
grant select, insert on {{EVIDENCE_SCHEMA}}.artifacts, {{EVIDENCE_SCHEMA}}.evidence_objects,
  {{EVIDENCE_SCHEMA}}.transformations, {{EVIDENCE_SCHEMA}}.lineage_edges,
  {{EVIDENCE_SCHEMA}}.registration_receipts to ehf_svc_case_api;
grant insert on {{EVIDENCE_SCHEMA}}.outbox to ehf_svc_case_api;
-- Registration's trigger (migration 016) assigns retention and joins active holds; case-api
-- places holds and records their release (by someone else), and never sets a storage state
-- or a retention date.
grant select on {{EVIDENCE_SCHEMA}}.retention_rules to ehf_svc_case_api;
grant select, insert on {{EVIDENCE_SCHEMA}}.retention_assignments, {{EVIDENCE_SCHEMA}}.legal_hold_targets,
  {{EVIDENCE_SCHEMA}}.legal_holds to ehf_svc_case_api;
grant update (released_by, released_at, release_authority) on {{EVIDENCE_SCHEMA}}.legal_holds to ehf_svc_case_api;

-- The evidence retention job: sets closure-based retention dates and tells storage about
-- retention and holds, recording what storage was told. It reads case status and closure
-- events, and cannot register evidence, place or release a hold, or touch the ledger.
grant usage on schema {{CASE_CORE_SCHEMA}}, {{CASE_LEDGER_SCHEMA}}, {{EVIDENCE_SCHEMA}} to ehf_svc_evidence_retention;
grant select on {{CASE_CORE_SCHEMA}}.cases, {{CASE_LEDGER_SCHEMA}}.case_events to ehf_svc_evidence_retention;
grant select on {{EVIDENCE_SCHEMA}}.artifacts, {{EVIDENCE_SCHEMA}}.evidence_objects, {{EVIDENCE_SCHEMA}}.retention_rules,
  {{EVIDENCE_SCHEMA}}.retention_assignments, {{EVIDENCE_SCHEMA}}.legal_holds, {{EVIDENCE_SCHEMA}}.legal_hold_targets
  to ehf_svc_evidence_retention;
grant update (retain_until, retention_state, legal_hold_state, governed_at, verified_at) on {{EVIDENCE_SCHEMA}}.artifacts
  to ehf_svc_evidence_retention;
grant update (basis_at, retain_until) on {{EVIDENCE_SCHEMA}}.retention_assignments to ehf_svc_evidence_retention;
grant update (storage_state, applied_at) on {{EVIDENCE_SCHEMA}}.legal_hold_targets to ehf_svc_evidence_retention;
-- The same job reconciles storage against the artifact rows and records each run.
grant select, insert, update on {{EVIDENCE_SCHEMA}}.reconciliation_runs to ehf_svc_evidence_retention;

-- The outbox relay: the relay functions and nothing else.
grant usage on schema {{CASE_LEDGER_SCHEMA}}, {{EVIDENCE_SCHEMA}} to ehf_svc_case_outbox_relay;
grant execute on function
  {{CASE_LEDGER_SCHEMA}}.relay_claim_outbox(integer, text, integer),
  {{CASE_LEDGER_SCHEMA}}.relay_mark_published(text, text[]),
  {{CASE_LEDGER_SCHEMA}}.relay_release_claim(text),
  {{CASE_LEDGER_SCHEMA}}.relay_purge_published(integer),
  {{EVIDENCE_SCHEMA}}.relay_claim_outbox(integer, text, integer),
  {{EVIDENCE_SCHEMA}}.relay_mark_published(text, text[]),
  {{EVIDENCE_SCHEMA}}.relay_release_claim(text),
  {{EVIDENCE_SCHEMA}}.relay_purge_published(integer)
  to ehf_svc_case_outbox_relay;
-- What the relay functions themselves need (they run as this role).
grant usage on schema {{CASE_CORE_SCHEMA}}, {{CASE_LEDGER_SCHEMA}}, {{EVIDENCE_SCHEMA}} to ehf_case_relay_controller;
grant select, update, delete on {{CASE_LEDGER_SCHEMA}}.outbox, {{EVIDENCE_SCHEMA}}.outbox to ehf_case_relay_controller;
grant select on {{CASE_CORE_SCHEMA}}.cases to ehf_case_relay_controller;

-- The ledger exporter: reads events, records signed segments and moves its own cursors.
-- It cannot change an event, and the export store's retention is administered elsewhere.
grant usage on schema {{CASE_LEDGER_SCHEMA}} to ehf_svc_ledger_exporter;
grant select on {{CASE_LEDGER_SCHEMA}}.case_events, {{CASE_LEDGER_SCHEMA}}.event_chain_heads to ehf_svc_ledger_exporter;
grant select, insert on {{CASE_LEDGER_SCHEMA}}.ledger_segments to ehf_svc_ledger_exporter;
grant select, insert, update on {{CASE_LEDGER_SCHEMA}}.export_cursors to ehf_svc_ledger_exporter;

-- capability-gateway: nothing. The retrieval index lives in the context database
-- (ehf_context); ehf_svc_case_retrieval is kept only so earlier grants are revoked above.

-- Audit verification: read everything, change nothing (still tenant-bound by policy).
grant usage on schema {{CASE_CORE_SCHEMA}}, {{CASE_LEDGER_SCHEMA}}, {{EVIDENCE_SCHEMA}} to ehf_audit_reader;
grant select on all tables in schema {{CASE_CORE_SCHEMA}}, {{CASE_LEDGER_SCHEMA}}, {{EVIDENCE_SCHEMA}} to ehf_audit_reader;

revoke update on {{CASE_CORE_SCHEMA}}.policy_snapshot_reads from ehf_svc_case_api;
grant execute on function {{CASE_CORE_SCHEMA}}.purge_expired_policy_reads() to ehf_svc_case_api;

-- Retire access to the original rehearsal table. Briefs now live in the discovery database.
revoke all on schema case_discovery
  from public, ehf_svc_case_api, ehf_svc_case_outbox_relay, ehf_svc_case_retrieval,
       ehf_svc_ledger_exporter, ehf_svc_evidence_retention, ehf_audit_reader, ehf_case_relay_controller, ehf_ledger_writer;
revoke all on all tables in schema case_discovery
  from public, ehf_svc_case_api, ehf_svc_case_outbox_relay, ehf_svc_case_retrieval,
       ehf_svc_ledger_exporter, ehf_svc_evidence_retention, ehf_audit_reader, ehf_case_relay_controller, ehf_ledger_writer;

do $$
begin
  execute format('revoke all on database %I from ehf_svc_discovery_case_reader', current_database());
  execute format('grant connect on database %I to ehf_svc_discovery_case_reader', current_database());
end $$;
revoke all on schema {{CASE_CORE_SCHEMA}} from ehf_svc_discovery_case_reader;
revoke all on all tables in schema {{CASE_CORE_SCHEMA}} from ehf_svc_discovery_case_reader;
grant usage on schema {{CASE_CORE_SCHEMA}} to ehf_svc_discovery_case_reader;
grant select (tenant_id, case_id, harness_plan_digest, status, case_type, jurisdiction)
  on {{CASE_CORE_SCHEMA}}.cases to ehf_svc_discovery_case_reader;
grant select (tenant_id, case_id, decision_id, receipt, receipt_digest)
  on {{CASE_CORE_SCHEMA}}.business_decisions to ehf_svc_discovery_case_reader;
revoke all on {{CASE_CORE_SCHEMA}}.discovery_corporate_anchors from ehf_svc_case_api, ehf_audit_reader;
grant select on {{CASE_CORE_SCHEMA}}.discovery_corporate_anchors to ehf_svc_case_api, ehf_svc_discovery_case_reader;
