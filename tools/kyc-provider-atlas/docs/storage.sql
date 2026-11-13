-- PostgreSQL illustrative design, not a deployed or tested migration.
-- Authenticate tenant out of band; app.tenant_id must be set by trusted middleware
-- in a transaction using a non-owner, non-superuser application role.
CREATE TABLE provider_catalog (
 provider_id text PRIMARY KEY, family_id text NOT NULL, metadata jsonb NOT NULL,
 evidence_level text NOT NULL, reviewed_at timestamptz
);
CREATE TABLE provider_binding (
 tenant_id uuid NOT NULL, binding_id uuid NOT NULL, provider_id text NOT NULL REFERENCES provider_catalog,
 capability text NOT NULL, adapter_version text NOT NULL, api_version text,
 enabled boolean NOT NULL DEFAULT false, allowed_countries text[] NOT NULL DEFAULT '{}',
 allowed_regions text[] NOT NULL DEFAULT '{}', secret_reference text, entitlement_reference text,
 configuration jsonb NOT NULL, PRIMARY KEY (tenant_id,binding_id)
);
CREATE TABLE check_run (
 tenant_id uuid NOT NULL, check_id uuid NOT NULL, request_id text NOT NULL,
 idempotency_key text NOT NULL, request_digest text NOT NULL, request jsonb NOT NULL,
 capability text NOT NULL, status text NOT NULL, resource_version bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (tenant_id,check_id),
 UNIQUE (tenant_id,idempotency_key)
);
CREATE TABLE host_result (
 tenant_id uuid NOT NULL, result_id text NOT NULL, check_id uuid NOT NULL,
 payload jsonb NOT NULL, schema_version text NOT NULL, received_at timestamptz NOT NULL,
 PRIMARY KEY (tenant_id,result_id), FOREIGN KEY (tenant_id,check_id) REFERENCES check_run(tenant_id,check_id)
);
CREATE TABLE evidence_artifact (
 tenant_id uuid NOT NULL, evidence_id text NOT NULL, result_id text NOT NULL,
 vault_reference text NOT NULL, sha256 text NOT NULL, content_representation text NOT NULL,
 classification text NOT NULL, license_reference text, retention_policy_reference text,
 retrieved_at timestamptz NOT NULL, PRIMARY KEY(tenant_id,evidence_id),
 FOREIGN KEY (tenant_id,result_id) REFERENCES host_result(tenant_id,result_id)
);
CREATE TABLE entity_observation (
 tenant_id uuid NOT NULL, observation_id uuid NOT NULL, entity_id text NOT NULL,
 source_provider_id text NOT NULL, result_id text NOT NULL, attributes jsonb NOT NULL,
 valid_from timestamptz, valid_to timestamptz, observed_at timestamptz NOT NULL,
 PRIMARY KEY (tenant_id,observation_id), FOREIGN KEY (tenant_id,result_id) REFERENCES host_result(tenant_id,result_id)
);
CREATE TABLE relationship_observation (
 tenant_id uuid NOT NULL, relationship_id text NOT NULL, result_id text NOT NULL,
 from_entity_id text NOT NULL, to_entity_id text NOT NULL, relationship_type text NOT NULL,
 assertion_status text NOT NULL, ownership jsonb, evidence_ids text[] NOT NULL,
 valid_from timestamptz, valid_to timestamptz, PRIMARY KEY (tenant_id,relationship_id,result_id),
 FOREIGN KEY (tenant_id,result_id) REFERENCES host_result(tenant_id,result_id)
);
-- Entity IDs are graph references; enforce referential constraints in projection service,
-- since source observations intentionally allow multiple temporal versions of each entity.
CREATE TABLE event_outbox (
 tenant_id uuid NOT NULL, event_id uuid NOT NULL, check_id uuid NOT NULL,
 resource_version bigint NOT NULL, event_type text NOT NULL, body jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
 PRIMARY KEY (tenant_id,event_id), FOREIGN KEY (tenant_id,check_id) REFERENCES check_run(tenant_id,check_id)
);
CREATE TABLE webhook_inbox (
 tenant_id uuid NOT NULL, provider_id text NOT NULL, deduplication_key text NOT NULL,
 original_byte_digest text NOT NULL, signature_verified boolean NOT NULL,
 artifact_reference text NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,provider_id,deduplication_key)
);
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['provider_binding','check_run','host_result','evidence_artifact','entity_observation','relationship_observation','event_outbox','webhook_inbox'] LOOP
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
 END LOOP;
END $$;
-- Add explicit grants, indexes, retention partitions, immutable audit controls,
-- encryption, GDPR data-subject handling and security tests before deployment.
-- Application checks must reject idempotency-key reuse with a different digest.
-- Store canonical JSON digests separately from original-byte signature digests.
