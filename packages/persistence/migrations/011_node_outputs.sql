create table if not exists workflow.node_outputs (
  tenant_id text not null,
  work_item_id text not null,
  output jsonb not null,
  output_digest char(64) not null,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id,work_item_id),
  foreign key (tenant_id,work_item_id) references workflow.work_items(tenant_id,work_item_id)
);
alter table workflow.node_outputs enable row level security;
alter table workflow.node_outputs force row level security;
create policy workflow_tenant_scope on workflow.node_outputs
using (tenant_id=nullif(current_setting('app.tenant_id',true),'') or current_setting('app.workflow_controller',true)='true')
with check (tenant_id=nullif(current_setting('app.tenant_id',true),'') or current_setting('app.workflow_controller',true)='true');
