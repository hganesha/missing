-- Evidence bytes live in any S3-compatible object store, not a vendor-specific blob service.
-- The backend value becomes cloud-neutral; storage_account now holds the object store's
-- endpoint host and container its bucket. Rows written as 'azure_blob' keep their location.
alter table {{EVIDENCE_SCHEMA}}.artifacts drop constraint if exists artifacts_backend_location;
update {{EVIDENCE_SCHEMA}}.artifacts set backend = 'object_store' where backend = 'azure_blob';
alter table {{EVIDENCE_SCHEMA}}.artifacts add constraint artifacts_backend_location check (
  (backend = 'postgres' and content is not null)
  or (backend = 'object_store' and content is null and storage_account is not null and container is not null and blob_name is not null)
);
