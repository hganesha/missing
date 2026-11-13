-- Rehearsals are deliberately separate from admitted plans and operational runs.
create table harness_control.draft_test_runs (
 tenant_id text not null, environment text not null, draft_id text not null,
 id text not null, request_key text not null, request_digest text not null,
 created_by text not null, created_at timestamptz not null default now(),
 expires_at timestamptz not null default now() + interval '7 days',
 report jsonb not null,
 primary key(tenant_id, environment, draft_id, id),
 unique(tenant_id, environment, draft_id, request_key)
);
create index draft_test_history on harness_control.draft_test_runs(tenant_id,environment,draft_id,created_at desc);
alter table harness_control.draft_test_runs enable row level security;
alter table harness_control.draft_test_runs force row level security;
create policy tenant_scope on harness_control.draft_test_runs
 using (tenant_id = nullif(current_setting('app.tenant_id',true),''))
 with check (tenant_id = nullif(current_setting('app.tenant_id',true),''));
