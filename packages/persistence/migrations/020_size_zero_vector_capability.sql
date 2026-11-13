update harness_gateway.capability_registry
set definition = '{"id":"knowledge.vector.search.v1","kind":"tool","effect":"read","adapterBindingId":"pgvector:knowledge.search","inputSchema":{"type":"object","required":["query"],"properties":{"query":{"type":"string"},"topK":{"type":"integer"}}},"outputSchema":{"type":"object","required":["query","matches"],"properties":{"query":{"type":"string"},"matches":{"type":"array"}}},"timeoutMs":30000,"maxAttempts":2,"idempotent":true,"description":"Search tenant-scoped knowledge chunks with Azure embeddings and PostgreSQL pgvector.","owner":"data-platform","dataClasses":["internal","document"],"status":"active"}'::jsonb,
    definition_digest = 'ec968b7b1f98909af45c003f8e60a5399d1b32e887279bc7224d910eed012ae8',
    status = 'active',
    updated_at = now()
where capability_id = 'knowledge.vector.search.v1'
  and status = 'draft'
  and definition->>'adapterBindingId' = 'unconfigured:knowledge-vector-search';
