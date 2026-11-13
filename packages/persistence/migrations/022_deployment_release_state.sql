alter table harness_control.environment_deployments
  add column if not exists active_package_digest text,
  add column if not exists operation_package_digest text;

alter table harness_control.environment_deployments
  drop constraint if exists environment_deployments_active_package_digest_check,
  add constraint environment_deployments_active_package_digest_check
    check (active_package_digest is null or active_package_digest ~ '^sha256:[a-f0-9]{64}$'),
  drop constraint if exists environment_deployments_operation_package_digest_check,
  add constraint environment_deployments_operation_package_digest_check
    check (operation_package_digest is null or operation_package_digest ~ '^sha256:[a-f0-9]{64}$');
