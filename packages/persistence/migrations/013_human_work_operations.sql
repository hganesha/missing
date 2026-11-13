-- Mutable assignment is separate from the immutable work-item document and decision log.
create table if not exists workflow.human_assignments (
  tenant_id text not null,
  case_id text not null,
  work_item_id text not null,
  principal_id text not null,
  claimed_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, work_item_id, principal_id),
  foreign key (tenant_id, case_id, work_item_id)
    references workflow.work_items(tenant_id, case_id, work_item_id) on delete cascade
);

-- Conflicting immutable decisions are closed only by a distinct authorized resolver.
create table if not exists workflow.human_conflict_resolutions (
  tenant_id text not null,
  case_id text not null,
  work_item_id text not null,
  resolution_id text not null,
  principal_id text not null,
  decision text not null check (decision in ('APPROVE','REJECT','RETURN')),
  reason_code text not null,
  rationale text not null,
  evidence_refs jsonb not null default '[]'::jsonb,
  resolved_at timestamptz not null,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, resolution_id),
  unique (tenant_id, work_item_id),
  foreign key (tenant_id, case_id, work_item_id)
    references workflow.work_items(tenant_id, case_id, work_item_id) on delete cascade
);

create index if not exists human_assignments_work_idx
  on workflow.human_assignments(tenant_id, work_item_id, claimed_at);

do $$
declare
  relation_name text;
begin
  foreach relation_name in array array['human_assignments', 'human_conflict_resolutions'] loop
    execute format('alter table workflow.%I enable row level security', relation_name);
    execute format('alter table workflow.%I force row level security', relation_name);
    execute format('drop policy if exists workflow_tenant_scope on workflow.%I', relation_name);
    execute format($policy$
      create policy workflow_tenant_scope on workflow.%I
      using (
        tenant_id = nullif(current_setting('app.tenant_id', true), '')
        or current_setting('app.workflow_controller', true) = 'true'
      )
      with check (
        tenant_id = nullif(current_setting('app.tenant_id', true), '')
        or current_setting('app.workflow_controller', true) = 'true'
      )
    $policy$, relation_name);
  end loop;
end $$;
