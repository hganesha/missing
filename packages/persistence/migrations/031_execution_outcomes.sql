create table workflow.execution_outcomes (
  tenant_id text not null, work_item_id text not null, execution_id text not null,
  fencing_epoch bigint not null, outcome jsonb not null, outcome_digest char(64) not null,
  recorded_at timestamptz not null default clock_timestamp(),
  primary key (tenant_id,work_item_id,execution_id),
  foreign key (tenant_id,work_item_id) references workflow.work_items(tenant_id,work_item_id)
);
alter table workflow.execution_outcomes enable row level security;
alter table workflow.execution_outcomes force row level security;
create policy execution_outcome_tenant on workflow.execution_outcomes
  using (tenant_id=nullif(current_setting('app.tenant_id',true),''))
  with check (tenant_id=nullif(current_setting('app.tenant_id',true),''));

create function harness_runtime.matches_fincrime_outcome(p_tenant text,p_work text,p_execution text,p_fence bigint,p_outcome jsonb)
returns boolean language sql security definer set search_path=pg_catalog as $$
  select exists(select 1 from workflow.execution_outcomes o
    where o.tenant_id=p_tenant and o.work_item_id=p_work and o.execution_id=p_execution and o.fencing_epoch=p_fence
      and (o.outcome=p_outcome or o.outcome->'output'=p_outcome));
$$;
revoke all on function harness_runtime.matches_fincrime_outcome(text,text,text,bigint,jsonb) from public;
