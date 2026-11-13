alter table harness_control.environment_deployments
  add column if not exists release_evidence jsonb;
