create table if not exists workflow.policy_human_requirements (
  tenant_id text not null, case_id text not null, work_item_id text not null,
  decision_id text not null, decision jsonb not null,
  primary key (tenant_id,work_item_id),
  foreign key (tenant_id,work_item_id) references workflow.work_items(tenant_id,work_item_id)
);
alter table workflow.policy_human_requirements enable row level security;
alter table workflow.policy_human_requirements force row level security;
create policy tenant_scope on workflow.policy_human_requirements
  using (tenant_id = nullif(current_setting('app.tenant_id',true),''))
  with check (tenant_id = nullif(current_setting('app.tenant_id',true),''));
