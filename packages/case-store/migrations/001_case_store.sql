create schema if not exists {{CASE_CORE_SCHEMA}};
create schema if not exists {{CASE_LEDGER_SCHEMA}};
create schema if not exists {{EVIDENCE_SCHEMA}};

create table if not exists {{CASE_CORE_SCHEMA}}.cases (
  tenant_id text not null,
  case_id text not null,
  case_type text not null,
  schema_version text not null,
  jurisdiction text not null,
  status text not null,
  case_sequence bigint not null default 0,
  external_ref text,
  policy_snapshot_digest text not null,
  harness_plan_digest text not null,
  classification text not null,
  created_by jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, case_id),
  unique (tenant_id, external_ref),
  check (status in ('INTAKE','VALIDATING','SCREENING','INVESTIGATING','READY_FOR_DECISION','QA_REVIEW','HUMAN_REVIEW','NEEDS_INFORMATION','SUSPENDED','APPROVED','DECLINED','CLOSED'))
);

create index if not exists cases_queue_idx
  on {{CASE_CORE_SCHEMA}}.cases(tenant_id, status, updated_at desc);

create table if not exists {{CASE_CORE_SCHEMA}}.case_subjects (
  tenant_id text not null,
  case_id text not null,
  subject_id text not null,
  subject_type text not null,
  schema_version text not null,
  revision integer not null default 1,
  display_name text,
  attributes jsonb not null default '{}'::jsonb,
  classification text not null,
  created_by jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, case_id, subject_id),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id)
);

create table if not exists {{CASE_CORE_SCHEMA}}.case_subject_identifiers (
  tenant_id text not null,
  case_id text not null,
  subject_id text not null,
  identifier_id text not null,
  identifier_type text not null,
  value_digest text not null,
  masked_value text,
  source text not null,
  revision integer not null default 1,
  classification text not null,
  created_by jsonb not null,
  created_at timestamptz not null,
  primary key (tenant_id, case_id, subject_id, identifier_id),
  foreign key (tenant_id, case_id, subject_id) references {{CASE_CORE_SCHEMA}}.case_subjects(tenant_id, case_id, subject_id)
);

create table if not exists {{CASE_CORE_SCHEMA}}.case_risk (
  tenant_id text not null,
  case_id text not null,
  risk_id text not null,
  schema_version text not null,
  revision integer not null default 1,
  band text,
  score numeric,
  method text not null,
  basis_refs jsonb not null default '[]'::jsonb,
  status text not null,
  classification text not null,
  created_by jsonb not null,
  created_at timestamptz not null,
  superseded_at timestamptz,
  primary key (tenant_id, case_id, risk_id),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id)
);

create table if not exists {{CASE_CORE_SCHEMA}}.case_evidence_refs (
  tenant_id text not null,
  case_id text not null,
  evidence_id text not null,
  purpose text not null,
  status text not null,
  linked_by jsonb not null,
  linked_at timestamptz not null,
  primary key (tenant_id, case_id, evidence_id),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id)
);

create table if not exists {{CASE_CORE_SCHEMA}}.case_claims (
  tenant_id text not null,
  case_id text not null,
  claim_id text not null,
  schema_version text not null,
  revision integer not null default 1,
  subject_ref text,
  predicate text not null,
  value jsonb not null,
  asserted_by jsonb not null,
  evidence_refs jsonb not null default '[]'::jsonb,
  confidence jsonb,
  status text not null,
  classification text not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, case_id, claim_id),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id)
);

create table if not exists {{CASE_CORE_SCHEMA}}.case_facts (
  tenant_id text not null,
  case_id text not null,
  fact_id text not null,
  schema_version text not null,
  revision integer not null default 1,
  subject_ref text,
  predicate text not null,
  value jsonb not null,
  basis_claim_refs jsonb not null,
  acceptance_policy_ref text not null,
  purpose text not null,
  valid_from timestamptz,
  valid_to timestamptz,
  recorded_at timestamptz not null,
  superseded_at timestamptz,
  status text not null,
  classification text not null,
  created_by jsonb not null,
  primary key (tenant_id, case_id, fact_id),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id)
);

create table if not exists {{CASE_CORE_SCHEMA}}.case_findings (
  tenant_id text not null,
  case_id text not null,
  finding_id text not null,
  schema_version text not null,
  revision integer not null default 1,
  finding_type text not null,
  subject_ref text,
  classification text not null,
  confidence jsonb,
  uncertainty jsonb,
  reason text not null,
  evidence_refs jsonb not null default '[]'::jsonb,
  fact_refs jsonb not null default '[]'::jsonb,
  policy_relevance text,
  status text not null,
  created_by jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, case_id, finding_id),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id)
);

create table if not exists {{CASE_CORE_SCHEMA}}.case_assumptions (
  tenant_id text not null,
  case_id text not null,
  assumption_id text not null,
  proposition text not null,
  materiality text not null,
  basis_refs jsonb not null default '[]'::jsonb,
  status text not null,
  classification text not null,
  created_by jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, case_id, assumption_id),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id)
);

create table if not exists {{CASE_CORE_SCHEMA}}.case_contradictions (
  tenant_id text not null,
  case_id text not null,
  contradiction_id text not null,
  object_refs jsonb not null,
  description text not null,
  materiality text not null,
  detection_method text not null,
  status text not null,
  resolution jsonb,
  classification text not null,
  created_by jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, case_id, contradiction_id),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id)
);

create table if not exists {{CASE_CORE_SCHEMA}}.case_work_items (
  tenant_id text not null,
  case_id text not null,
  work_item_id text not null,
  work_type text not null,
  status text not null,
  priority text not null,
  assigned_to jsonb,
  required_capability text,
  due_at timestamptz,
  result_refs jsonb not null default '[]'::jsonb,
  classification text not null,
  created_by jsonb not null,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key (tenant_id, case_id, work_item_id),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id)
);

create table if not exists {{CASE_CORE_SCHEMA}}.case_decision_recommendations (
  tenant_id text not null,
  case_id text not null,
  recommendation_id text not null,
  outcome text not null,
  case_sequence bigint not null,
  rationale text not null,
  finding_refs jsonb not null default '[]'::jsonb,
  evidence_refs jsonb not null default '[]'::jsonb,
  policy_snapshot_digest text not null,
  status text not null,
  classification text not null,
  created_by jsonb not null,
  created_at timestamptz not null,
  primary key (tenant_id, case_id, recommendation_id),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id)
);

create table if not exists {{CASE_CORE_SCHEMA}}.case_gate_results (
  tenant_id text not null,
  case_id text not null,
  gate_result_id text not null,
  recommendation_ref text not null,
  decision text not null,
  case_sequence bigint not null,
  rule_results jsonb not null,
  policy_snapshot_digest text not null,
  created_by jsonb not null,
  created_at timestamptz not null,
  primary key (tenant_id, case_id, gate_result_id),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id)
);

create table if not exists {{CASE_CORE_SCHEMA}}.case_reviews (
  tenant_id text not null,
  case_id text not null,
  review_id text not null,
  review_type text not null,
  outcome text not null,
  object_ref text not null,
  rationale text not null,
  viewed_evidence_refs jsonb not null default '[]'::jsonb,
  reviewer jsonb not null,
  created_at timestamptz not null,
  primary key (tenant_id, case_id, review_id),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id)
);

create table if not exists {{CASE_CORE_SCHEMA}}.case_final_dispositions (
  tenant_id text not null,
  case_id text not null,
  disposition_id text not null,
  outcome text not null,
  recommendation_ref text not null,
  gate_result_ref text not null,
  review_ref text,
  policy_snapshot_digest text not null,
  rationale text not null,
  follow_up_obligations jsonb not null default '[]'::jsonb,
  status text not null,
  effective_at timestamptz not null,
  authorized_actor jsonb not null,
  created_at timestamptz not null,
  primary key (tenant_id, case_id, disposition_id),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id)
);

create table if not exists {{CASE_CORE_SCHEMA}}.case_execution_refs (
  tenant_id text not null,
  case_id text not null,
  run_id text not null,
  plan_digest text not null,
  trace_id char(32),
  purpose text not null,
  linked_by jsonb not null,
  linked_at timestamptz not null,
  primary key (tenant_id, case_id, run_id),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id)
);

create table if not exists {{CASE_LEDGER_SCHEMA}}.case_events (
  tenant_id text not null,
  case_id text not null,
  case_sequence bigint not null,
  event_id text not null,
  event_type text not null,
  event_schema text not null,
  occurred_at timestamptz not null,
  recorded_at timestamptz not null,
  actor jsonb not null,
  command_id text not null,
  authority jsonb not null,
  payload jsonb not null,
  evidence_refs jsonb not null default '[]'::jsonb,
  previous_event_digest text,
  event_digest text not null,
  primary key (tenant_id, case_id, case_sequence),
  unique (event_id),
  unique (tenant_id, case_id, event_digest),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id)
);

create table if not exists {{CASE_LEDGER_SCHEMA}}.event_chain_heads (
  tenant_id text not null,
  case_id text not null,
  case_sequence bigint not null,
  event_digest text not null,
  updated_at timestamptz not null,
  primary key (tenant_id, case_id),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id)
);

create table if not exists {{CASE_LEDGER_SCHEMA}}.command_receipts (
  tenant_id text not null,
  case_id text not null,
  command_id text not null,
  command_type text not null,
  idempotency_key text not null,
  request_digest text not null,
  outcome text not null,
  accepted_sequence_from bigint,
  accepted_sequence_to bigint,
  created_identifiers jsonb not null default '{}'::jsonb,
  response jsonb not null,
  response_digest text not null,
  created_at timestamptz not null,
  primary key (tenant_id, case_id, command_id),
  unique (tenant_id, case_id, idempotency_key),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id)
);

create table if not exists {{CASE_LEDGER_SCHEMA}}.outbox (
  outbox_id text primary key,
  tenant_id text not null,
  case_id text not null,
  case_sequence bigint not null,
  event_id text not null,
  event_type text not null,
  classification text not null,
  payload jsonb not null,
  source_event_digest text not null,
  created_at timestamptz not null,
  published_at timestamptz,
  publish_attempts integer not null default 0,
  unique (event_id),
  foreign key (tenant_id, case_id, case_sequence) references {{CASE_LEDGER_SCHEMA}}.case_events(tenant_id, case_id, case_sequence)
);

create index if not exists outbox_unpublished_idx
  on {{CASE_LEDGER_SCHEMA}}.outbox(created_at) where published_at is null;

create table if not exists {{EVIDENCE_SCHEMA}}.artifacts (
  tenant_id text not null,
  artifact_digest text not null,
  artifact_ref text not null,
  backend text not null,
  media_type text not null,
  byte_length bigint not null,
  content bytea,
  encryption_metadata jsonb not null default '{}'::jsonb,
  immutability_state text not null,
  created_at timestamptz not null,
  primary key (tenant_id, artifact_digest),
  unique (artifact_ref)
);

create table if not exists {{EVIDENCE_SCHEMA}}.evidence_objects (
  tenant_id text not null,
  case_id text not null,
  evidence_id text not null,
  schema_version text not null,
  evidence_type text not null,
  source jsonb not null,
  subject_refs jsonb not null default '[]'::jsonb,
  trust jsonb not null,
  raw_digest text not null,
  normalized_digest text,
  artifact_ref text not null,
  classification text not null,
  retention_class text not null,
  residency text not null,
  scan_status text not null,
  verification_status text not null,
  created_by jsonb not null,
  created_at timestamptz not null,
  primary key (tenant_id, evidence_id),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id),
  foreign key (artifact_ref) references {{EVIDENCE_SCHEMA}}.artifacts(artifact_ref)
);

create index if not exists evidence_case_idx
  on {{EVIDENCE_SCHEMA}}.evidence_objects(tenant_id, case_id, created_at desc);

create table if not exists {{EVIDENCE_SCHEMA}}.transformations (
  tenant_id text not null,
  transformation_id text not null,
  input_evidence_id text not null,
  output_evidence_id text not null,
  method text not null,
  method_version text not null,
  execution_ref text,
  created_by jsonb not null,
  created_at timestamptz not null,
  primary key (tenant_id, transformation_id)
);

create table if not exists {{EVIDENCE_SCHEMA}}.lineage_edges (
  tenant_id text not null,
  case_id text not null,
  edge_id text not null,
  source_type text not null,
  source_id text not null,
  source_revision integer,
  predicate text not null,
  predicate_version text not null,
  target_type text not null,
  target_id text not null,
  target_revision integer,
  method text,
  confidence jsonb,
  policy_ref text,
  creation_event_id text not null,
  created_by jsonb not null,
  created_at timestamptz not null,
  primary key (tenant_id, case_id, edge_id),
  foreign key (tenant_id, case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id, case_id)
);

create index if not exists lineage_source_idx
  on {{EVIDENCE_SCHEMA}}.lineage_edges(tenant_id, case_id, source_type, source_id);
create index if not exists lineage_target_idx
  on {{EVIDENCE_SCHEMA}}.lineage_edges(tenant_id, case_id, target_type, target_id);
