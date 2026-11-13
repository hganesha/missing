create table if not exists harness_control.monthly_metered_budgets (
  tenant_id text not null,
  period_start date not null,
  limit_usd numeric(12,6) not null check (limit_usd >= 0),
  reserved_usd numeric(12,6) not null default 0 check (reserved_usd >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, period_start)
);

create table if not exists harness_control.run_budget_reservations (
  run_id text primary key references harness_runtime.runs(run_id) on delete restrict,
  tenant_id text not null,
  period_start date not null,
  reserved_usd numeric(12,6) not null check (reserved_usd >= 0),
  created_at timestamptz not null default now(),
  foreign key (tenant_id, period_start)
    references harness_control.monthly_metered_budgets(tenant_id, period_start) on delete restrict
);

create index if not exists run_budget_reservations_tenant_period_idx
  on harness_control.run_budget_reservations(tenant_id, period_start);
