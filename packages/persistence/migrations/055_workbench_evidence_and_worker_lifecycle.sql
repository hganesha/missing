alter table observability.worker_heartbeats add column state text not null default 'ready'
  check(state in ('ready','draining','stopped'));
create function harness_control.protect_finished_workspace_evaluation() returns trigger language plpgsql as $$
begin
  if old.status in ('passed','failed','error','cancelled') then raise exception 'workbench.evaluation_immutable'; end if;
  return new;
end $$;
create trigger workspace_evaluation_finished_immutable before update or delete on harness_control.workspace_evaluations
  for each row execute function harness_control.protect_finished_workspace_evaluation();
create function harness_control.protect_finished_workspace_model_step() returns trigger language plpgsql as $$
begin
  if old.status <> 'started' then raise exception 'workbench.model_receipt_immutable'; end if;
  return new;
end $$;
create trigger workspace_model_receipt_immutable before update or delete on harness_control.workspace_model_steps
  for each row execute function harness_control.protect_finished_workspace_model_step();
create trigger workspace_tool_receipt_immutable before update or delete on harness_control.workspace_tool_receipts
  for each row execute function harness_control.reject_workspace_evidence_mutation();
