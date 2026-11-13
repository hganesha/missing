-- Bounded retry.
--
-- A failure went straight to a terminal 'failed' status even though the run model
-- already carried a 'retrying' state and an attempt counter, so a transient provider
-- error ended the run. available_at carries the backoff, and attempt_limit bounds how
-- many times a run may be re-claimed -- previously a run whose worker kept crashing was
-- re-claimed forever on lease expiry with no cap at all.
alter table harness_runtime.runs
  add column if not exists available_at timestamptz,
  add column if not exists attempt_limit integer not null default 3,
  add column if not exists cancellation_requested_at timestamptz,
  add column if not exists cancellation_reason text;

-- The ready index has to cover the new availability predicate or every poll degrades to
-- a scan once retrying rows accumulate.
drop index if exists harness_runtime.runs_ready_idx;
create index if not exists runs_ready_idx
  on harness_runtime.runs(status, available_at, lease_expires_at, created_at)
  where status in ('queued','running','retrying');

-- Cancellation is a terminal outcome in its own right, distinct from a failure: the
-- audit record has to say that a run was stopped on request rather than that it broke.
alter table harness_runtime.runs drop constraint if exists runs_status_check;
alter table harness_runtime.runs add constraint runs_status_check
  check (status in ('queued','running','retrying','completed','manual_review','denied','failed','cancelled'));
