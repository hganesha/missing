-- Make tenant identity part of every control-plane uniqueness and lookup boundary.
--
-- Plans are content-addressed, but admission is a tenant-owned relationship. The same
-- immutable plan may therefore be admitted by more than one tenant. Runs likewise scope
-- idempotency keys to the tenant that supplied them, and receipts copy the run tenant so
-- audit queries cannot accidentally span tenants.

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'harness_control.plans'::regclass
      and conname = 'plans_pkey'
      and pg_get_constraintdef(oid) = 'PRIMARY KEY (tenant_id, plan_digest)'
  ) then
    alter table harness_runtime.runs drop constraint if exists runs_plan_digest_fkey;
    alter table harness_control.plans drop constraint if exists plans_pkey;
    alter table harness_control.plans
      add constraint plans_pkey primary key (tenant_id, plan_digest);
  end if;
end $$;

alter table harness_runtime.runs drop constraint if exists runs_idempotency_key_key;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'runs_tenant_idempotency_key' and conrelid = 'harness_runtime.runs'::regclass) then
    alter table harness_runtime.runs add constraint runs_tenant_idempotency_key unique (tenant_id, idempotency_key);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'runs_tenant_plan_fkey' and conrelid = 'harness_runtime.runs'::regclass) then
    alter table harness_runtime.runs add constraint runs_tenant_plan_fkey foreign key (tenant_id, plan_digest)
      references harness_control.plans(tenant_id, plan_digest);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'runs_tenant_run_key' and conrelid = 'harness_runtime.runs'::regclass) then
    alter table harness_runtime.runs add constraint runs_tenant_run_key unique (tenant_id, run_id);
  end if;
end $$;

alter table harness_runtime.runs add column if not exists request_digest text;
update harness_runtime.runs
set request_digest = 'legacy:' || idempotency_key
where request_digest is null;
alter table harness_runtime.runs alter column request_digest set not null;

alter table harness_gateway.receipts add column if not exists tenant_id text;
update harness_gateway.receipts receipt
set tenant_id = run.tenant_id
from harness_runtime.runs run
where receipt.run_id = run.run_id and receipt.tenant_id is null;
alter table harness_gateway.receipts alter column tenant_id set not null;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'receipts_tenant_run_fkey' and conrelid = 'harness_gateway.receipts'::regclass) then
    alter table harness_gateway.receipts add constraint receipts_tenant_run_fkey foreign key (tenant_id, run_id)
      references harness_runtime.runs(tenant_id, run_id) on delete cascade;
  end if;
end $$;
create index if not exists gateway_receipts_tenant_created_idx
  on harness_gateway.receipts(tenant_id, created_at desc);
