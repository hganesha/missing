-- The Azure deployment studio, its pipeline and the release-admission routes were removed.
-- Nothing reads or writes environment deployments, their events, bootstrap plans or
-- bootstrap runs any more, and nothing registers deployment-package, bootstrap-plan or
-- platform-release artifacts.
--
-- Fail closed: no CASCADE, so an unexpected dependent object (a view, a foreign key from
-- another table) stops the migration instead of disappearing with these tables. Their own
-- indexes, constraints and policies are dropped with them. Row security is turned off for
-- the deletes so that a migrating role that is not exempt from the registry's forced
-- row-level security raises an error instead of silently deleting nothing.
set local row_security = off;

drop table if exists harness_control.environment_deployment_events;
drop table if exists harness_control.environment_deployments;
drop table if exists harness_control.bootstrap_runs;
drop table if exists harness_control.bootstrap_plans;

delete from harness_control.artifact_registry_events
where artifact_kind in ('deployment-package', 'bootstrap-plan', 'platform-release');
delete from harness_control.artifact_registry
where artifact_kind in ('deployment-package', 'bootstrap-plan', 'platform-release');

alter table harness_control.artifact_registry
  drop constraint if exists artifact_registry_artifact_kind_check;
alter table harness_control.artifact_registry
  add constraint artifact_registry_artifact_kind_check check (artifact_kind in (
    'policy-bundle', 'release-manifest', 'skill-bundle'
  ));
