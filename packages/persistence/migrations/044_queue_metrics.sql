-- Queue depth for autoscalers.
--
-- A platform autoscaler (KEDA's PostgreSQL scaler, or a Container Apps scale rule built on
-- it) needs one number per worker: how much work is ready to claim now. It gets a login in
-- ehf_svc_queue_metrics, which may call these two functions and nothing else: no table,
-- row, tenant or payload is visible to it. The counts mirror the claim queries in
-- packages/persistence/src/index.ts (claimRun) and integrations.ts, including work whose
-- lease or claim has expired, so the scaler sees exactly what a worker would pick up.
-- Grants are in grants.sql.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ehf_svc_queue_metrics') then
    create role ehf_svc_queue_metrics nologin;
  end if;
end $$;

-- The integration tables force row-level security even for their owner, and the count
-- below runs as the owner (the migration identity). A superuser bypasses that; a managed
-- database's migration identity usually is not one. Without controller membership the
-- integration count would silently read zero. The owner already owns these tables, so
-- membership grants it nothing it could not do with ALTER TABLE.
do $$
begin
  if not pg_has_role(current_user, 'ehf_integration_controller', 'member') then
    execute format('grant ehf_integration_controller to %I', current_user);
  end if;
end $$;

create or replace function harness_runtime.ready_run_count() returns bigint
language sql stable security definer set search_path = pg_catalog as $$
  select count(*) from harness_runtime.runs
  where ((status in ('queued','retrying') and (available_at is null or available_at <= now()))
      or (status = 'running' and lease_expires_at < now()))
    and cancellation_requested_at is null
    and attempt < attempt_limit
$$;

create or replace function integration.ready_work_count() returns bigint
language sql stable security definer set search_path = pg_catalog as $$
  select (select count(*) from integration.deliveries
          where (status in ('PENDING','RETRY') and next_attempt_at <= now())
             or (status = 'PROCESSING' and updated_at < now() - interval '5 minutes'))
       + (select count(*) from integration.ingress_receipts
          where (status in ('ACCEPTED','FAILED') and available_at <= now())
             or (status = 'PROCESSING' and claimed_at < now() - interval '5 minutes'))
$$;

revoke all on function harness_runtime.ready_run_count() from public;
revoke all on function integration.ready_work_count() from public;
