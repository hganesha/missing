-- A successful pipeline is not a certified serving release until evidence is checked.
alter table harness_control.environment_deployments
  drop constraint if exists environment_deployments_state_check,
  add constraint environment_deployments_state_check
    check (state in ('DRAFT','DISCOVERED','VALIDATED','PR_OPEN','APPROVED','DEPLOYING','VERIFYING','READY','DEGRADED','FAILED'));
