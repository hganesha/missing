-- Provider-neutral draft contracts keep planned integration families visible in the
-- authoring catalog before vendor selection. They are deliberately unconfigured and
-- cannot enter a compiled plan until an author supplies a supported adapter binding and
-- promotes the contract to active. Existing rows always win so migrations never replace
-- an operator-authored contract.
insert into harness_gateway.capability_registry
  (capability_id, definition, definition_digest, status, owner)
values
  (
    'identity.document.verify.v1',
    '{"id":"identity.document.verify.v1","kind":"tool","effect":"read","adapterBindingId":"unconfigured:identity-document-verify","inputSchema":{"type":"object","properties":{}},"outputSchema":{"type":"object","properties":{}},"timeoutMs":15000,"maxAttempts":1,"idempotent":true,"description":"Verify identity-document evidence through an approved provider.","owner":"identity-platform","dataClasses":["identity","pii"],"status":"draft"}'::jsonb,
    'bf16c7bdaa90826ca692f913b631ea14a3736589eda550848b79a014a40fc216',
    'draft',
    'identity-platform'
  ),
  (
    'identity.ocr.extract.v1',
    '{"id":"identity.ocr.extract.v1","kind":"tool","effect":"read","adapterBindingId":"unconfigured:identity-ocr-extract","inputSchema":{"type":"object","properties":{}},"outputSchema":{"type":"object","properties":{}},"timeoutMs":15000,"maxAttempts":1,"idempotent":true,"description":"Extract structured identity-document fields through an approved OCR provider.","owner":"identity-platform","dataClasses":["identity","pii","document"],"status":"draft"}'::jsonb,
    'b7ab7f1bd07e2f1d3bd57e6f386d1afce37e24850b9935ea5b650551474589b0',
    'draft',
    'identity-platform'
  ),
  (
    'screening.adverse-media.search.v1',
    '{"id":"screening.adverse-media.search.v1","kind":"tool","effect":"read","adapterBindingId":"unconfigured:adverse-media-search","inputSchema":{"type":"object","properties":{}},"outputSchema":{"type":"object","properties":{}},"timeoutMs":15000,"maxAttempts":1,"idempotent":true,"description":"Search approved adverse-media sources and return normalized, attributable findings.","owner":"compliance-platform","dataClasses":["pii","public-source"],"status":"draft"}'::jsonb,
    '5d59e676fbd1c7dcd05affb07f4177184c965f7209cdf760ad71988d27260e53',
    'draft',
    'compliance-platform'
  ),
  (
    'customer.internal.search.v1',
    '{"id":"customer.internal.search.v1","kind":"tool","effect":"read","adapterBindingId":"unconfigured:customer-internal-search","inputSchema":{"type":"object","properties":{}},"outputSchema":{"type":"object","properties":{}},"timeoutMs":15000,"maxAttempts":1,"idempotent":true,"description":"Search approved internal customer systems using a purpose-bound subject query.","owner":"data-platform","dataClasses":["identity","pii","internal"],"status":"draft"}'::jsonb,
    '323dd0bc02c821e2c7258c7b7883b15e0b9ca5b67413f4957ff511289337f8a5',
    'draft',
    'data-platform'
  ),
  (
    'knowledge.vector.search.v1',
    '{"id":"knowledge.vector.search.v1","kind":"tool","effect":"read","adapterBindingId":"unconfigured:knowledge-vector-search","inputSchema":{"type":"object","properties":{}},"outputSchema":{"type":"object","properties":{}},"timeoutMs":15000,"maxAttempts":1,"idempotent":true,"description":"Search an approved vector or document index and return provenance-bearing passages.","owner":"data-platform","dataClasses":["internal","document"],"status":"draft"}'::jsonb,
    '9550d3990ecbd76075ac9a722733bb8a00c76c3c855eba49bc3ba23e7ff161f5',
    'draft',
    'data-platform'
  ),
  (
    'integration.apim.approved-operation.v1',
    '{"id":"integration.apim.approved-operation.v1","kind":"tool","effect":"read","adapterBindingId":"unconfigured:apim-approved-operation","inputSchema":{"type":"object","properties":{}},"outputSchema":{"type":"object","properties":{}},"timeoutMs":15000,"maxAttempts":1,"idempotent":true,"description":"Invoke one allowlisted API Management operation after replacing this placeholder with an operation-specific contract.","owner":"integration-platform","dataClasses":["internal"],"status":"draft"}'::jsonb,
    '552811203c6782a13b1ec703cf8f69c3e418906ab4ab94a28b2e2052accc2d18',
    'draft',
    'integration-platform'
  )
on conflict (capability_id) do nothing;
