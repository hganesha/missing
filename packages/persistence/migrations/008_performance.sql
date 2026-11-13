-- Queue claims, backpressure counts and keyset pagination must stay index-backed as
-- history grows. CONCURRENTLY is intentionally omitted because migrations run before
-- serving traffic; this keeps the migration transactional and deterministic.
create index if not exists runs_dispatch_ready_idx
  on harness_runtime.runs (available_at, created_at, run_id)
  where status in ('queued', 'retrying');

create index if not exists runs_running_lease_idx
  on harness_runtime.runs (lease_expires_at, created_at, run_id)
  where status = 'running';

create index if not exists runs_tenant_page_idx
  on harness_runtime.runs (tenant_id, updated_at desc, run_id desc);

create index if not exists runs_tenant_active_idx
  on harness_runtime.runs (tenant_id, status)
  where status in ('queued', 'retrying', 'running');

create index if not exists plans_tenant_page_idx
  on harness_control.plans (tenant_id, admitted_at desc, plan_digest desc);

create index if not exists receipts_tenant_page_idx
  on harness_gateway.receipts (tenant_id, created_at desc, invocation_id desc);
