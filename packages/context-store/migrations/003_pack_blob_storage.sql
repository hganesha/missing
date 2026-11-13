-- Context pack bodies in blob storage (docs/implementation/data-stores-plan.md §3.6, phase 5).
-- With a pack container configured, the rendered pack (it holds case data) is written to it and
-- the row keeps only where it is; the release job deletes a case's pack blobs with its rows.
-- Without one (development), the body stays in `pack`.
alter table context.packs alter column pack drop not null;
alter table context.packs
  add column if not exists pack_container text,
  add column if not exists pack_blob_name text;
alter table context.packs drop constraint if exists packs_body_location;
alter table context.packs add constraint packs_body_location check (
  (pack is not null and pack_blob_name is null and pack_container is null)
  or (pack is null and pack_blob_name is not null and pack_container is not null)
);
