ALTER TABLE harness_control.authoring_drafts
  ADD COLUMN source_files jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(source_files) = 'object');
