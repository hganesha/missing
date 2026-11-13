-- Widen the administered setting sections to cover agent runtime, observability, case
-- store and database configuration.
--
-- These were the remaining values a deployment could only change by editing an
-- environment and redeploying. Nothing depends on a check constraint, so dropping and
-- re-adding it is replay-safe; the drop is unconditional on the name Postgres generated
-- for the inline constraint as well as the name used here, because the table may carry
-- either depending on when it was created.

alter table harness_admin.platform_settings
  drop constraint if exists platform_settings_section_check;
alter table harness_admin.platform_settings
  drop constraint if exists platform_settings_section_allowed;
alter table harness_admin.platform_settings
  add constraint platform_settings_section_allowed check (section in (
    'dispatcher', 'gateway', 'envelope', 'authoring',
    'runtime', 'observability', 'caseStore', 'database',
    'outbox', 'evidence'
  ));
