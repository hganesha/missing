create table if not exists {{EVIDENCE_SCHEMA}}.registration_receipts (
  tenant_id text not null,
  idempotency_key text not null,
  request_digest text not null,
  evidence_id text not null,
  response jsonb not null,
  response_digest text not null,
  created_at timestamptz not null,
  primary key (tenant_id, idempotency_key),
  foreign key (tenant_id, evidence_id) references {{EVIDENCE_SCHEMA}}.evidence_objects(tenant_id, evidence_id)
);

create table if not exists {{EVIDENCE_SCHEMA}}.outbox (
  outbox_id text primary key,
  tenant_id text not null,
  case_id text not null,
  evidence_id text not null,
  event_type text not null,
  classification text not null,
  payload jsonb not null,
  created_at timestamptz not null,
  published_at timestamptz,
  publish_attempts integer not null default 0,
  unique (tenant_id, evidence_id, event_type),
  foreign key (tenant_id, evidence_id) references {{EVIDENCE_SCHEMA}}.evidence_objects(tenant_id, evidence_id)
);

create index if not exists evidence_outbox_unpublished_idx
  on {{EVIDENCE_SCHEMA}}.outbox(created_at) where published_at is null;
