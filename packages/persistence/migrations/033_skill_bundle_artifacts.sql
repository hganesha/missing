-- Skill-host bundles (skill.execution.v1 §8) are registry artifacts: a bundle is executable
-- only while harness_control.artifact_registry holds an approved, unrevoked 'skill-bundle'
-- entry for its bundle_digest. The entry's reference names the exact lock content
-- ('skill-bundle:<id>@<version>;lock=<sha256 of the canonical lock>'), so an approved
-- digest cannot be served with a different skill list. See
-- docs/implementation/skill-library-integration-contract.md (Implementation status).
alter table harness_control.artifact_registry
  drop constraint if exists artifact_registry_artifact_kind_check;
alter table harness_control.artifact_registry
  add constraint artifact_registry_artifact_kind_check check (artifact_kind in (
    'policy-bundle','release-manifest','deployment-package','bootstrap-plan','platform-release','skill-bundle'
  ));
