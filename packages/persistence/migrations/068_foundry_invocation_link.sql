create table if not exists observability.foundry_invocation_link (
  invocation_id text primary key references harness_gateway.receipts(invocation_id) on delete cascade,
  run_id text not null references harness_runtime.runs(run_id) on delete cascade,
  attempt integer not null check (attempt >= 0),
  trace_id char(32) not null check (trace_id ~ '^[a-f0-9]{32}$' and trace_id !~ '^0+$'),
  parent_span_id char(16) not null check (parent_span_id ~ '^[a-f0-9]{16}$' and parent_span_id !~ '^0+$'),
  application_insights_resource_id text not null check (length(application_insights_resource_id) between 1 and 512),
  project_endpoint text not null check (length(project_endpoint) between 1 and 512),
  agent_name text not null check (length(agent_name) between 1 and 63),
  agent_version text not null check (agent_version ~ '^[1-9][0-9]{0,19}$'),
  response_id text not null check (response_id ~ '^resp_[a-zA-Z0-9_-]{1,191}$'),
  started_at timestamptz not null,
  completed_at timestamptz not null check (completed_at >= started_at)
);

create index if not exists foundry_invocation_link_trace_idx
  on observability.foundry_invocation_link (trace_id, run_id, attempt, started_at);

revoke all on observability.foundry_invocation_link from public;
