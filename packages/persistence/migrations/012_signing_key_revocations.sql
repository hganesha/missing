create table if not exists harness_control.signing_key_revocations (
  tenant_id text not null, key_id text not null, key_version text not null,
  actor text not null, reason_code text not null,
  revoked_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id,key_id,key_version)
);
alter table harness_control.signing_key_revocations enable row level security;
alter table harness_control.signing_key_revocations force row level security;
create policy signing_key_tenant_scope on harness_control.signing_key_revocations
  using (tenant_id = nullif(current_setting('app.tenant_id',true),''))
  with check (tenant_id = nullif(current_setting('app.tenant_id',true),''));
