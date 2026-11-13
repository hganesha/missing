create schema if not exists integration;

create table if not exists integration.connector_revisions (
  tenant_id text not null,
  connector_id text not null,
  revision integer not null check (revision > 0),
  definition jsonb not null,
  definition_digest text not null,
  created_by text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, connector_id, revision)
);

create table if not exists integration.binding_revisions (
  tenant_id text not null,
  binding_id text not null,
  revision integer not null check (revision > 0),
  route_id text not null,
  connector_id text not null,
  connector_revision integer not null,
  deployment_id text not null,
  plan_digest text not null,
  contract_id text not null,
  definition jsonb not null,
  definition_digest text not null,
  status text not null check (status in ('DRAFT','VERIFIED','ACTIVE','PAUSED','REVOKED')),
  verified_at timestamptz,
  activated_at timestamptz,
  activation_watermark timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_by text not null,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, binding_id, revision),
  foreign key (tenant_id, connector_id, connector_revision)
    references integration.connector_revisions(tenant_id, connector_id, revision)
);

create unique index if not exists integration_one_active_binding_idx
  on integration.binding_revisions(tenant_id, deployment_id, plan_digest, contract_id)
  where status = 'ACTIVE';

create unique index if not exists integration_one_active_route_idx
  on integration.binding_revisions(route_id)
  where status = 'ACTIVE';

create table if not exists integration.binding_events (
  event_id text primary key,
  tenant_id text not null,
  binding_id text not null,
  binding_revision integer not null,
  event_type text not null,
  actor_id text not null,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create table if not exists integration.ingress_receipts (
  receipt_id text primary key,
  tenant_id text not null,
  binding_id text not null,
  binding_revision integer not null,
  source_event_id text not null,
  intent text not null check (intent in ('create_case','submit_case_command','start_run')),
  request_digest text not null,
  payload jsonb not null,
  status text not null check (status in ('ACCEPTED','PROCESSING','COMPLETED','FAILED','DEAD_LETTER')),
  result jsonb,
  error_code text,
  available_at timestamptz not null default now(),
  attempt_count integer not null default 0,
  claimed_at timestamptz,
  claim_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, binding_id, binding_revision, source_event_id, intent)
);

create index if not exists integration_ingress_claim_idx
  on integration.ingress_receipts(status, available_at, created_at)
  where status in ('ACCEPTED','FAILED');

create table if not exists integration.event_inbox (
  tenant_id text not null,
  event_id text not null,
  cloud_event jsonb not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  primary key (tenant_id, event_id)
);

create table if not exists integration.deliveries (
  delivery_id text primary key,
  tenant_id text not null,
  binding_id text not null,
  binding_revision integer not null,
  event_id text not null,
  cloud_event jsonb not null,
  status text not null check (status in ('PENDING','PROCESSING','DELIVERED','RETRY','DEAD_LETTER','CANCELLED')),
  attempt_count integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  replayed_from text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  delivered_at timestamptz,
  unique (tenant_id, binding_id, binding_revision, event_id)
);

create index if not exists integration_delivery_claim_idx
  on integration.deliveries(status, next_attempt_at, created_at)
  where status in ('PENDING','PROCESSING','RETRY');

create table if not exists integration.delivery_attempts (
  attempt_id text primary key,
  tenant_id text not null,
  delivery_id text not null references integration.deliveries(delivery_id),
  attempt_number integer not null,
  outcome text not null,
  http_status integer,
  error_code text,
  started_at timestamptz not null,
  completed_at timestamptz not null
);

create table if not exists integration.action_receipts (
  tenant_id text not null,
  case_id text not null,
  action_id text not null,
  request_id text not null,
  request_digest text not null,
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (tenant_id, case_id, action_id, request_id)
);

do $$
declare relation_name text;
begin
  foreach relation_name in array array[
    'connector_revisions', 'binding_revisions', 'binding_events', 'ingress_receipts',
    'event_inbox', 'deliveries', 'delivery_attempts', 'action_receipts'
  ] loop
    execute format('alter table integration.%I enable row level security', relation_name);
    execute format('alter table integration.%I force row level security', relation_name);
    execute format('drop policy if exists integration_tenant_scope on integration.%I', relation_name);
    execute format($policy$
      create policy integration_tenant_scope on integration.%I
      using (
        tenant_id = nullif(current_setting('app.tenant_id', true), '')
        or current_setting('app.integration_controller', true) = 'true'
      )
      with check (
        tenant_id = nullif(current_setting('app.tenant_id', true), '')
        or current_setting('app.integration_controller', true) = 'true'
      )
    $policy$, relation_name);
  end loop;
end $$;
