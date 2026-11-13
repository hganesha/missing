-- Evidence bytes in blob storage (docs/implementation/data-stores-plan.md §3.6, phase 5).
-- The artifact row stays the metadata and authorization record; with backend 'azure_blob' the
-- bytes live in the evidence container under a content-addressed, per-tenant name and
-- `content` is null. 'postgres' remains the development backend.
alter table {{EVIDENCE_SCHEMA}}.artifacts
  add column if not exists storage_account text,
  add column if not exists container text,
  add column if not exists blob_name text,
  add column if not exists blob_version_id text,
  add column if not exists verified_at timestamptz;

alter table {{EVIDENCE_SCHEMA}}.artifacts drop constraint if exists artifacts_backend_location;
alter table {{EVIDENCE_SCHEMA}}.artifacts add constraint artifacts_backend_location check (
  (backend = 'postgres' and content is not null)
  or (backend = 'azure_blob' and content is null and storage_account is not null and container is not null and blob_name is not null)
);
