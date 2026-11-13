create table if not exists {{CASE_CORE_SCHEMA}}.audit_exports (
  tenant_id text not null, case_id text not null, export_digest char(64) not null,
  case_sequence bigint not null, document jsonb not null,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id,case_id,export_digest),
  foreign key (tenant_id,case_id) references {{CASE_CORE_SCHEMA}}.cases(tenant_id,case_id)
);
