-- The platform no longer ships cloud-specific mechanisms (Azure AI Foundry, Azure OpenAI,
-- Azure AI Search, API Management). Earlier migrations are checksummed and stay as they
-- were applied; this one moves stored data onto the cloud-neutral equivalents.

-- 1. Model providers: an `azure_foundry` binding becomes a disabled OpenAI-compatible one.
--    It is disabled because its base URL was an Azure deployment path, not an
--    OpenAI-compatible root; an administrator re-points and re-enables it. The digest is
--    recomputed exactly as the admin store computes it (sorted-key canonical JSON).
update harness_admin.providers
set kind = 'openai_compatible',
    status = 'disabled',
    definition = definition || '{"kind":"openai_compatible","status":"disabled"}'::jsonb,
    definition_digest = encode(sha256(convert_to(
      '{"appName":' || coalesce(to_json(definition->>'appName')::text, 'null')
      || ',"baseUrl":' || coalesce(to_json(definition->>'baseUrl')::text, 'null')
      || ',"credentialRef":' || coalesce(to_json(definition->>'credentialRef')::text, 'null')
      || ',"displayName":' || to_json(definition->>'displayName')::text
      || ',"id":' || to_json(definition->>'id')::text
      || ',"kind":"openai_compatible","siteUrl":' || coalesce(to_json(definition->>'siteUrl')::text, 'null')
      || ',"status":"disabled"}', 'UTF8')), 'hex'),
    updated_at = now(),
    updated_by = 'system:migration'
where kind = 'azure_foundry';

alter table harness_admin.providers drop constraint if exists providers_kind_check;
alter table harness_admin.providers add constraint providers_kind_check
  check (kind in ('openrouter', 'openai_compatible', 'recorded'));

-- 2. Runtime settings: the Foundry section is gone; a Foundry default target falls back to
--    the platform's own runtime, and Foundry bindings are dropped.
update harness_admin.platform_settings
set value = (value - 'foundry')
      || jsonb_build_object('provider', case when value->>'provider' like 'azure\_foundry%' then 'local_http' else value->>'provider' end)
      || case when value ? 'bindings' then jsonb_build_object('bindings', coalesce((
           select jsonb_object_agg(name, binding)
           from jsonb_each(value->'bindings') as entry(name, binding)
           where binding->>'adapter' <> 'azure_foundry' and binding->>'auth' <> 'azure_msi'
         ), '{}'::jsonb)) else '{}'::jsonb end,
    updated_at = now(),
    updated_by = 'system:migration'
where section = 'runtime'
  and (value ? 'foundry' or value->>'provider' like 'azure\_foundry%' or value->'bindings' is not null);

-- 3. Connectors whose adapter no longer exists. A release naming one would fail at
--    invocation anyway; removing the row makes the gap visible at registration instead.
delete from harness_gateway.connector_registry
where adapter_id in ('azure-openai', 'foundry-agent', 'azure-search', 'apim');

-- 4. Capability contracts: the vector search description no longer names a vendor, the
--    API Management placeholder is deprecated in favour of a gateway-neutral HTTP one.
--    Each update applies only while the row is still exactly what an earlier migration
--    seeded; an operator-edited contract is left to its owner.
update harness_gateway.capability_registry
set definition = '{"id":"knowledge.vector.search.v1","kind":"tool","effect":"read","adapterBindingId":"pgvector:knowledge.search","inputSchema":{"type":"object","required":["query"],"properties":{"query":{"type":"string"},"topK":{"type":"integer"}}},"outputSchema":{"type":"object","required":["query","matches"],"properties":{"query":{"type":"string"},"matches":{"type":"array"}}},"timeoutMs":30000,"maxAttempts":2,"idempotent":true,"description":"Search tenant-scoped knowledge chunks with an OpenAI-compatible embedding endpoint and PostgreSQL pgvector.","owner":"data-platform","dataClasses":["internal","document"],"status":"active"}'::jsonb,
    definition_digest = '2f3a63d708cba968daf20c3e8f399f8f9dfd593b12684ec87618cdbc23e45354',
    updated_at = now()
where capability_id = 'knowledge.vector.search.v1'
  and definition_digest = 'ec968b7b1f98909af45c003f8e60a5399d1b32e887279bc7224d910eed012ae8';

update harness_gateway.capability_registry
set definition = '{"id":"integration.apim.operation.v1","kind":"tool","effect":"read","adapterBindingId":"unconfigured:apim-operation","inputSchema":{"type":"object","properties":{}},"outputSchema":{"type":"object","properties":{}},"timeoutMs":15000,"maxAttempts":1,"idempotent":true,"description":"Invoke one allowlisted API Management operation after replacing this placeholder with an operation-specific contract.","owner":"integration-platform","dataClasses":["internal"],"status":"deprecated"}'::jsonb,
    definition_digest = 'b6ac77e7b807c2f23173142e572887c68a9419bbcc438d426513f9a40b5cfed5',
    status = 'deprecated',
    updated_at = now()
where capability_id = 'integration.apim.operation.v1'
  and definition_digest = '5a5cb65440d67bb5f9c25d9a990f62b195052b46d222ceb774c552dbb2560f57';

insert into harness_gateway.capability_registry
  (capability_id, definition, definition_digest, status, owner)
values (
  'integration.http.operation.v1',
  '{"id":"integration.http.operation.v1","kind":"tool","effect":"read","adapterBindingId":"unconfigured:http-operation","inputSchema":{"type":"object","properties":{}},"outputSchema":{"type":"object","properties":{}},"timeoutMs":15000,"maxAttempts":1,"idempotent":true,"description":"Invoke one allowlisted HTTP API operation after replacing this placeholder with an operation-specific contract.","owner":"integration-platform","dataClasses":["internal"],"status":"draft"}'::jsonb,
  'ba6b2313d49f8f0a010dae0fbe603e069d6dc8f3019fa8df6452080e461d9157',
  'draft',
  'integration-platform'
)
on conflict (capability_id) do nothing;
