-- Grant matrix for the control database (docs/implementation/data-stores-plan.md §4.1).
--
-- Re-applied in one transaction after every migration run: everything the service roles
-- held is revoked, then exactly this is granted. A table added by a migration is therefore
-- unreachable by every service until it is listed here (fail closed), and
-- grants.test.ts fails while any table is missing from this file.
--
-- Each list was derived from the SQL each service's code path runs; widen one only with
-- the code that needs it. Login principals are mapped into these groups by the deployment
-- (one workload identity per service, mapped to a database role by the database's own
-- authentication) or, locally, by the development logins step.

-- Who may connect at all. Nobody by default; the control-plane services (and case-api's
-- execution-authority identity) by group. In a split deployment no case-only identity can
-- open a session here. With one database for both (allowed for local development) the
-- case database's grants.sql adds its groups to the same database.
do $$
begin
  execute format('revoke all on database %I from public, ehf_svc_control_api, ehf_svc_runtime_dispatcher,
    ehf_svc_runtime_checkpoint, ehf_svc_capability_gateway, ehf_svc_integration_worker,
    ehf_svc_case_execution, ehf_svc_case_data_release, ehf_audit_reader, ehf_svc_queue_metrics', current_database());
  execute format('grant connect on database %I to ehf_svc_control_api, ehf_svc_runtime_dispatcher,
    ehf_svc_runtime_checkpoint, ehf_svc_capability_gateway, ehf_svc_integration_worker,
    ehf_svc_case_execution, ehf_svc_case_data_release, ehf_audit_reader, ehf_svc_queue_metrics', current_database());
end $$;

revoke all on all tables in schema harness_control, harness_runtime, harness_gateway, harness_admin,
  workflow, integration, observability, langgraph_checkpoint
  from public, ehf_svc_control_api, ehf_svc_runtime_dispatcher, ehf_svc_runtime_checkpoint,
       ehf_svc_capability_gateway, ehf_svc_integration_worker, ehf_svc_case_execution, ehf_audit_reader,
       ehf_svc_case_data_release, ehf_case_data_releaser, ehf_svc_queue_metrics;
revoke all on all functions in schema harness_control, harness_runtime, harness_gateway, harness_admin,
  workflow, integration, observability
  from public, ehf_svc_control_api, ehf_svc_runtime_dispatcher, ehf_svc_runtime_checkpoint,
       ehf_svc_capability_gateway, ehf_svc_integration_worker, ehf_svc_case_execution, ehf_audit_reader,
       ehf_svc_case_data_release, ehf_svc_queue_metrics;
revoke all on schema harness_control, harness_runtime, harness_gateway, harness_admin,
  workflow, integration, observability, langgraph_checkpoint
  from public, ehf_svc_control_api, ehf_svc_runtime_dispatcher, ehf_svc_runtime_checkpoint,
       ehf_svc_capability_gateway, ehf_svc_integration_worker, ehf_svc_case_execution, ehf_audit_reader,
       ehf_svc_case_data_release, ehf_case_data_releaser, ehf_svc_queue_metrics;

-- control-api: authoring, governance, administration, integrations, human work, run admission.
grant usage on schema harness_control, harness_runtime, harness_gateway, harness_admin, workflow,
  integration, observability to ehf_svc_control_api;
grant select, insert, update on harness_admin.providers, harness_admin.model_profile_revisions,
  harness_admin.platform_settings to ehf_svc_control_api;
grant select, insert on harness_admin.change_log to ehf_svc_control_api;
grant select, insert, update on harness_admin.intelligence_binding_heads to ehf_svc_control_api;
grant select, insert on harness_admin.intelligence_binding_revisions,
  harness_admin.intelligence_configuration_checks, harness_admin.intelligence_events to ehf_svc_control_api;
grant select, insert, update on harness_admin.external_providers, harness_admin.external_connection_drafts to ehf_svc_control_api;
grant select, insert on harness_admin.external_provider_events,
  harness_admin.external_capability_binding_revisions to ehf_svc_control_api;
grant select, insert, update on harness_control.authoring_drafts, harness_control.agent_registry,
  harness_control.skill_registry, harness_control.artifact_registry, harness_control.policy_revisions,
  harness_control.release_manifests, harness_control.monthly_metered_budgets to ehf_svc_control_api;
grant select, insert on harness_control.plans, harness_control.authoring_events,
  harness_control.artifact_registry_events, harness_control.canonical_catalogs,
  harness_control.policy_revision_events, harness_control.release_events,
  harness_control.run_budget_reservations to ehf_svc_control_api;
grant select on harness_control.business_skill_registry to ehf_svc_control_api;
grant select, insert, update on harness_control.runtime_lifecycle to ehf_svc_control_api;
grant select, insert on harness_control.runtime_admission_events to ehf_svc_control_api;
grant select on observability.worker_heartbeats to ehf_svc_control_api;
grant usage on schema observability to ehf_svc_runtime_dispatcher, ehf_svc_integration_worker;
grant select, insert, update on observability.worker_heartbeats to ehf_svc_runtime_dispatcher, ehf_svc_integration_worker;
-- Skill qualifications are content-addressed evidence: recorded, never changed (trigger).
grant select, insert on harness_control.skill_qualifications, harness_control.source_artifacts to ehf_svc_control_api;
grant select on harness_gateway.source_decisions to ehf_svc_control_api;
grant select, insert, update on harness_runtime.runs, harness_runtime.node_attempts,
  harness_runtime.runtime_invocations to ehf_svc_control_api;
grant select, insert on harness_runtime.run_events to ehf_svc_control_api;
grant select on harness_gateway.receipts, harness_gateway.capability_registry,
  harness_gateway.connector_registry to ehf_svc_control_api;
grant select, insert, update on integration.binding_revisions, integration.deliveries,
  integration.event_inbox, integration.ingress_receipts to ehf_svc_control_api;
grant select, insert on integration.connector_revisions, integration.binding_events,
  integration.action_receipts to ehf_svc_control_api;
grant select on integration.delivery_attempts to ehf_svc_control_api;
-- Human work: claim, decide and resolve conflicts on a human work item.
grant select, update on workflow.work_items, workflow.durable_timers to ehf_svc_control_api;
grant select, insert on workflow.work_item_transitions, workflow.human_assignments,
  workflow.human_decisions, workflow.human_conflict_resolutions, workflow.node_outputs to ehf_svc_control_api;
grant select on observability.trace_link, observability.foundry_invocation_link to ehf_svc_control_api;

-- runtime-worker (dispatcher, kernel, reconciler). Member of ehf_workflow_controller.
grant usage on schema harness_control, harness_runtime, harness_admin, workflow, observability
  to ehf_svc_runtime_dispatcher;
grant select on harness_admin.platform_settings to ehf_svc_runtime_dispatcher;
grant select on harness_control.plans, harness_control.artifact_registry, harness_control.policy_revisions,
  harness_control.release_manifests to ehf_svc_runtime_dispatcher;
grant select, update on harness_runtime.runs to ehf_svc_runtime_dispatcher;
grant select, insert on harness_runtime.run_events to ehf_svc_runtime_dispatcher;
grant select, insert, update on workflow.work_items, workflow.dispatch_outbox, workflow.durable_timers,
  workflow.reconciliation_cases to ehf_svc_runtime_dispatcher;
grant select, insert on workflow.work_item_dependencies, workflow.work_item_transitions,
  workflow.node_outputs, workflow.execution_outcomes to ehf_svc_runtime_dispatcher;
grant select, insert, update on observability.trace_link to ehf_svc_runtime_dispatcher;

-- runtime-host: LangGraph checkpoints only. The tables are created by migration 043, not by
-- the saver, so the runtime holds no CREATE anywhere (not on the database, not on the schema).
grant usage on schema langgraph_checkpoint to ehf_svc_runtime_checkpoint;
grant select, insert, update, delete on langgraph_checkpoint.checkpoints, langgraph_checkpoint.checkpoint_blobs,
  langgraph_checkpoint.checkpoint_writes to ehf_svc_runtime_checkpoint;
-- Read at start to check the tables are at the version the saver expects.
grant select on langgraph_checkpoint.checkpoint_migrations to ehf_svc_runtime_checkpoint;

-- Context setup and protected sample history. Preview never writes case data.
grant select, insert on harness_control.context_revisions, harness_control.context_samples to ehf_svc_control_api;
grant delete on harness_control.context_samples to ehf_svc_control_api;
grant select, insert, update on harness_control.context_enablements to ehf_svc_control_api;

grant select on harness_control.context_revisions, harness_control.context_enablements to ehf_svc_capability_gateway;

-- capability-gateway: capability registry, its own receipts, model administration reads.
grant usage on schema harness_control, harness_runtime, harness_gateway, harness_admin, workflow
  to ehf_svc_capability_gateway;
grant select on harness_admin.providers, harness_admin.model_profile_revisions,
  harness_admin.platform_settings to ehf_svc_capability_gateway;
grant select on harness_control.plans, harness_control.artifact_registry,
  harness_control.business_skill_registry, harness_control.skill_qualifications to ehf_svc_capability_gateway;
grant select on harness_control.source_artifacts to ehf_svc_capability_gateway;
grant select, insert on harness_gateway.source_decisions to ehf_svc_capability_gateway;
grant select, insert, update on harness_gateway.capability_registry to ehf_svc_capability_gateway;
grant select, insert, update, delete on harness_gateway.receipts to ehf_svc_capability_gateway;
grant usage on schema observability to ehf_svc_capability_gateway;
grant insert on observability.foundry_invocation_link to ehf_svc_capability_gateway;
grant select on harness_gateway.connector_registry to ehf_svc_capability_gateway;
-- It meters cost onto a run; it can never change a run's status, lease or outcome.
grant select on harness_runtime.runs to ehf_svc_capability_gateway;
-- Reserving a receipt counts the call against the run's budget; settling it records the cost.
grant update (capability_calls, model_calls, cost_usd, cost_complete, updated_at) on harness_runtime.runs to ehf_svc_capability_gateway;
grant select on workflow.work_items to ehf_svc_capability_gateway;
-- Delegating a skill's dependency calls re-checks the run's executable release (requireExecutableRelease):
-- the release in effect for the plan and the published policy revision it names. Read-only, and the
-- policy sources themselves are not readable.
grant select on harness_control.release_manifests to ehf_svc_capability_gateway;
grant select (tenant_id, workspace_id, revision, status, compiled_bundle, bundle_digest, release_blockers, updated_at)
  on harness_control.policy_revisions to ehf_svc_capability_gateway;
grant execute on function harness_control.release_in_effect(text,text) to ehf_svc_capability_gateway;

-- integration-worker. Member of ehf_integration_controller.
grant usage on schema harness_control, integration to ehf_svc_integration_worker;
grant select on harness_control.plans to ehf_svc_integration_worker;
grant select on integration.binding_revisions, integration.connector_revisions to ehf_svc_integration_worker;
grant select, update on integration.deliveries, integration.ingress_receipts to ehf_svc_integration_worker;
grant select, insert on integration.delivery_attempts to ehf_svc_integration_worker;

-- case-api, in the control database: may ask whether an execution still holds its lease
-- and check a financial-crime outcome, and nothing else.
-- ehf_svc_queue_metrics: autoscaler queue depth (044_queue_metrics.sql). Two counting
-- functions and nothing else; it can read no table.
grant usage on schema harness_runtime, integration to ehf_svc_queue_metrics;
grant execute on function harness_runtime.ready_run_count() to ehf_svc_queue_metrics;
grant execute on function integration.ready_work_count() to ehf_svc_queue_metrics;

grant usage on schema harness_runtime to ehf_svc_case_execution;
grant execute on function harness_runtime.context_pull_run(text,text,text,text) to ehf_svc_case_execution;
-- The document re-extraction run's scope (migration 042): ids from its own input and its admitted plan, never the bytes.
grant execute on function harness_runtime.document_extraction_run(text,text,text,text),
  harness_runtime.document_extraction_plan(text,text) to ehf_svc_case_execution;
grant execute on function harness_runtime.lock_case_execution(text, text, text, text, integer, bigint, text, bigint)
  to ehf_svc_case_execution;
grant execute on function harness_runtime.matches_fincrime_outcome(text, text, text, bigint, jsonb)
  to ehf_svc_case_execution;

-- The context release job (data-stores-plan.md §3.3): two functions and nothing else.
grant usage on schema harness_runtime to ehf_svc_case_data_release;
grant execute on function harness_runtime.case_live_executions(text, text),
  harness_runtime.release_case_working_data(text, text) to ehf_svc_case_data_release;
-- What those functions need (they run as this role): read the case's rows, rewrite content.
grant usage on schema harness_runtime, workflow, harness_gateway, langgraph_checkpoint to ehf_case_data_releaser;
grant select, update on harness_runtime.runs, harness_runtime.run_events, workflow.work_items,
  workflow.node_outputs, workflow.execution_outcomes, harness_gateway.receipts to ehf_case_data_releaser;
-- LangGraph's tables are owned by the migration identity (migration 043).
grant select, delete on langgraph_checkpoint.checkpoints, langgraph_checkpoint.checkpoint_blobs,
  langgraph_checkpoint.checkpoint_writes to ehf_case_data_releaser;

-- The context-source qualification route inserts immutable, tenant-prefixed connector IDs.
grant insert on harness_gateway.connector_registry to ehf_svc_capability_gateway;

grant select, insert, update on integration.context_refresh_jobs to ehf_svc_control_api;
grant select, update on integration.context_refresh_jobs to ehf_svc_integration_worker;
grant usage on schema harness_runtime to ehf_svc_integration_worker;
grant select (run_id,tenant_id,status) on harness_runtime.runs to ehf_svc_integration_worker;

-- Connection authoring stays in control-api; gateway records technical checks only.
grant select, insert, update on harness_admin.context_source_heads to ehf_svc_control_api;
grant select, insert on harness_admin.context_source_revisions, harness_admin.context_source_events to ehf_svc_control_api;
grant select on harness_admin.context_source_checks to ehf_svc_control_api;
grant select on harness_admin.context_source_heads, harness_admin.context_source_revisions,
  harness_admin.context_source_events to ehf_svc_capability_gateway;
grant select, insert on harness_admin.context_source_checks to ehf_svc_capability_gateway;

-- Audit verification: read everything, change nothing.
grant usage on schema harness_control, harness_runtime, harness_gateway, harness_admin, workflow,
  integration, observability to ehf_audit_reader;
grant select on all tables in schema harness_control, harness_runtime, harness_gateway, harness_admin,
  workflow, integration, observability to ehf_audit_reader;
revoke select on observability.foundry_invocation_link from ehf_audit_reader;

grant execute on function harness_runtime.case_policy_contract(text,text),
  harness_runtime.lock_business_policy_authority(text,text,text,text,text,text),
  harness_runtime.published_institution_catalog(text,text) to ehf_svc_case_execution;

grant select, insert, update on workflow.policy_human_requirements to ehf_svc_runtime_dispatcher;
grant select on workflow.policy_human_requirements to ehf_svc_control_api;
grant select, insert on harness_control.context_refresh_schedules to ehf_svc_control_api;
grant select, insert, update on harness_control.context_refresh_state, harness_control.context_refresh_batches to ehf_svc_control_api;

-- Versioned source workspaces and evaluation evidence.
grant select, insert, update on harness_control.workspaces, harness_control.workspace_evaluations to ehf_svc_control_api;
grant select, insert on harness_control.workspace_revisions, harness_control.workspace_promotions to ehf_svc_control_api;

grant select on harness_control.workspace_evaluations,harness_control.workspace_revisions to ehf_svc_capability_gateway;
grant select, insert, update on harness_control.workspace_model_steps to ehf_svc_capability_gateway;
grant select on harness_control.workspace_model_steps to ehf_svc_control_api;

grant select, insert on harness_control.workspace_tool_receipts to ehf_svc_control_api;
grant select on harness_control.workspace_tool_receipts to ehf_svc_capability_gateway;

grant select on harness_control.schema_migrations to ehf_svc_control_api;

-- Authoring test history never grants operational execution authority.
grant select, insert, update, delete on harness_control.draft_test_runs to ehf_svc_control_api;

-- User directory writes and immutable access audit belong to the control API.
grant select, insert, update on harness_admin.platform_users to ehf_svc_control_api;
grant select, insert on harness_admin.user_changes to ehf_svc_control_api;
grant select on harness_admin.platform_users, harness_admin.user_changes to ehf_audit_reader;

-- Institution product catalogs: revisions change status (never content); events are append-only.
grant select, insert, update on harness_admin.institution_catalog_revisions to ehf_svc_control_api;
grant select, insert on harness_admin.institution_catalog_events to ehf_svc_control_api;
grant select on harness_admin.institution_catalog_revisions, harness_admin.institution_catalog_events to ehf_audit_reader;

-- Policy activation history (phase F): append-only for the control API; the in-effect check is
-- the same one the business-policy authority applies.
grant select, insert on harness_control.policy_activations to ehf_svc_control_api;
grant select on harness_control.policy_activations to ehf_audit_reader;
grant execute on function harness_control.policy_revision_in_effect(text,text,integer) to ehf_svc_control_api;

-- Release activation history (phase H): append-only for the control API; the in-effect check is the
-- one the business-policy authority and the runtime's executable-release check apply.
grant select, insert on harness_control.release_activations to ehf_svc_control_api;
grant select on harness_control.release_activations to ehf_audit_reader, ehf_svc_runtime_dispatcher;
grant execute on function harness_control.release_in_effect(text,text) to ehf_svc_control_api, ehf_svc_runtime_dispatcher;

-- Policy pack layer revisions (phase H): the studio edits layers as revisions with a second approver.
grant select, insert, update on harness_admin.policy_pack_layer_revisions to ehf_svc_control_api;
grant select, insert on harness_admin.policy_pack_layer_events to ehf_svc_control_api;
grant select on harness_admin.policy_pack_layer_revisions, harness_admin.policy_pack_layer_events to ehf_audit_reader;

-- Document Factory (document factory plan §7): history is append-only for the control API (the immutability
-- triggers refuse changes); model and classifier versions change status, release jobs carry progress and lease.
grant select, insert on harness_control.factory_type_strategies, harness_control.factory_dataset_versions,
  harness_control.factory_evaluation_reports, harness_control.factory_releases, harness_control.factory_release_activations,
  harness_control.factory_events to ehf_svc_control_api;
grant select, insert, update on harness_control.factory_model_versions, harness_control.factory_classifier_versions,
  harness_control.factory_release_jobs to ehf_svc_control_api;
grant select on harness_control.factory_type_strategies, harness_control.factory_dataset_versions, harness_control.factory_model_versions,
  harness_control.factory_classifier_versions, harness_control.factory_release_jobs, harness_control.factory_evaluation_reports,
  harness_control.factory_releases, harness_control.factory_release_activations, harness_control.factory_events to ehf_audit_reader;
-- The gateway's document-model connector reads which release is in effect (releasedDocumentModel), nothing else.
grant select on harness_control.factory_releases, harness_control.factory_release_activations to ehf_svc_capability_gateway;

-- Read the small intake settlement projection for the opt-in synthetic observer.
do $$
begin
  execute format('revoke all on database %I from ehf_svc_discovery_observer', current_database());
  execute format('grant connect on database %I to ehf_svc_discovery_observer', current_database());
end $$;
revoke all on schema harness_runtime from ehf_svc_discovery_observer;
revoke all on all functions in schema harness_runtime from ehf_svc_discovery_observer;
revoke all on all tables in schema harness_runtime, workflow from ehf_svc_discovery_observer;
grant usage on schema harness_runtime to ehf_svc_discovery_observer;
grant execute on function harness_runtime.discovery_intake_settlement(text,text,text) to ehf_svc_discovery_observer;
grant execute on function harness_runtime.discovery_advisory_result(text,text,text,jsonb) to ehf_svc_discovery_observer;
grant execute on function harness_runtime.discovery_parent_run(text,text,text),
  harness_runtime.discovery_run_status(text,text,text,jsonb) to ehf_svc_discovery_observer;

grant select, insert, update on harness_control.sandbox_launches to ehf_svc_control_api;
grant select, insert on harness_control.sandbox_observations to ehf_svc_control_api;
grant usage on sequence harness_control.sandbox_observations_sequence_seq to ehf_svc_control_api;
grant insert on harness_control.sandbox_observation_reads to ehf_svc_control_api;
grant execute on function harness_control.prune_sandbox_observations() to ehf_svc_control_api;
