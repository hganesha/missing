-- Connector registry: every gateway adapter binding (connector) that can serve a canonical
-- capability. One capability has many connectors; a release selects one by naming its
-- connector ID as the capability's adapterBindingId. Rows are seeded additively from
-- config/connector-catalog.json by migrate.ts. See docs/implementation/capability-naming.md.
create table if not exists harness_gateway.connector_registry (
  connector_id text primary key,
  capability_id text not null,
  adapter_id text not null,
  provider_id text,
  definition jsonb not null,
  definition_digest text not null check (definition_digest ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('available','live_ready','quarantined','retired')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (connector_id like adapter_id || ':%')
);

create index if not exists connector_registry_capability_idx
  on harness_gateway.connector_registry(capability_id, connector_id);
create index if not exists connector_registry_provider_idx
  on harness_gateway.connector_registry(provider_id, connector_id);

-- Canonical equivalents of the non-canonical placeholders seeded by migration 015. Existing
-- rows always win.
insert into harness_gateway.capability_registry
  (capability_id, definition, definition_digest, status, owner)
values
  (
    'screening.adverse_media.v1',
    '{"id":"screening.adverse_media.v1","kind":"tool","effect":"read","adapterBindingId":"wiring:complyadvantage:screening.adverse_media","inputSchema":{"type":"object","properties":{}},"outputSchema":{"type":"object","properties":{}},"timeoutMs":15000,"maxAttempts":1,"idempotent":true,"description":"Screen a party against adverse-media sources and return normalized, attributable findings.","owner":"compliance-platform","dataClasses":["pii","public-source"],"status":"draft"}'::jsonb,
    '8db143ddd3f63c8ac1c9f19a6f1a44e9a26dbdcf80c0967bce624d2eced3dd11',
    'draft',
    'compliance-platform'
  ),
  (
    'integration.apim.operation.v1',
    '{"id":"integration.apim.operation.v1","kind":"tool","effect":"read","adapterBindingId":"unconfigured:apim-operation","inputSchema":{"type":"object","properties":{}},"outputSchema":{"type":"object","properties":{}},"timeoutMs":15000,"maxAttempts":1,"idempotent":true,"description":"Invoke one allowlisted API Management operation after replacing this placeholder with an operation-specific contract.","owner":"integration-platform","dataClasses":["internal"],"status":"draft"}'::jsonb,
    '5a5cb65440d67bb5f9c25d9a990f62b195052b46d222ceb774c552dbb2560f57',
    'draft',
    'integration-platform'
  )
on conflict (capability_id) do nothing;

-- Deprecate the non-canonical placeholders, but only while they are still exactly the
-- placeholder migration 015 seeded: an operator-edited contract is left for its owner.
update harness_gateway.capability_registry
set definition = '{"id":"screening.adverse-media.search.v1","kind":"tool","effect":"read","adapterBindingId":"unconfigured:adverse-media-search","inputSchema":{"type":"object","properties":{}},"outputSchema":{"type":"object","properties":{}},"timeoutMs":15000,"maxAttempts":1,"idempotent":true,"description":"Search approved adverse-media sources and return normalized, attributable findings.","owner":"compliance-platform","dataClasses":["pii","public-source"],"status":"deprecated"}'::jsonb,
    definition_digest = 'b63a8867f52b484becda5e75bc5cf18999868e44ea4f7b281642f22a1d4ec8b9',
    status = 'deprecated',
    updated_at = now()
where capability_id = 'screening.adverse-media.search.v1'
  and definition_digest = '5d59e676fbd1c7dcd05affb07f4177184c965f7209cdf760ad71988d27260e53';

update harness_gateway.capability_registry
set definition = '{"id":"integration.apim.approved-operation.v1","kind":"tool","effect":"read","adapterBindingId":"unconfigured:apim-approved-operation","inputSchema":{"type":"object","properties":{}},"outputSchema":{"type":"object","properties":{}},"timeoutMs":15000,"maxAttempts":1,"idempotent":true,"description":"Invoke one allowlisted API Management operation after replacing this placeholder with an operation-specific contract.","owner":"integration-platform","dataClasses":["internal"],"status":"deprecated"}'::jsonb,
    definition_digest = '15731bceaab715419a696985781421c3ce2c544dfde2d161de4722c34d039adb',
    status = 'deprecated',
    updated_at = now()
where capability_id = 'integration.apim.approved-operation.v1'
  and definition_digest = '552811203c6782a13b1ec703cf8f69c3e418906ab4ab94a28b2e2052accc2d18';
