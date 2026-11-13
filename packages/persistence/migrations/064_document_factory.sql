-- Document Factory control plane (document factory plan §7, Phase 3). Tenant-scoped, row-level secured.
-- History is append-only: strategies, dataset versions, evaluation reports, release manifests, activations and
-- events never change once written. Model and classifier versions change status only; release jobs carry their
-- progress and lease. A release manifest is also registered in the artifact registry (kind document-model-release),
-- whose second-identity approval decides whether it may activate.

create table harness_control.factory_type_strategies (
  tenant_id text not null,
  document_type text not null,
  revision integer not null check (revision > 0),
  body jsonb not null,
  created_by text not null,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, document_type, revision)
);

create table harness_control.factory_dataset_versions (
  tenant_id text not null,
  dataset_digest text not null check (dataset_digest ~ '^[a-f0-9]{64}$'),
  document_type text not null,
  body jsonb not null,
  registered_by text not null,
  registered_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, dataset_digest)
);
create index factory_dataset_versions_type_idx on harness_control.factory_dataset_versions(tenant_id, document_type, registered_at desc);

create table harness_control.factory_model_versions (
  tenant_id text not null,
  model_version_id text not null,
  document_type text not null,
  status text not null check (status in ('training','ready','failed','retired')),
  body jsonb not null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, model_version_id)
);

create table harness_control.factory_classifier_versions (
  tenant_id text not null,
  classifier_version_id text not null,
  status text not null check (status in ('training','ready','failed','retired')),
  body jsonb not null,
  created_at timestamptz not null default transaction_timestamp(),
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, classifier_version_id)
);

create table harness_control.factory_release_jobs (
  tenant_id text not null,
  job_id text not null,
  status text not null check (status in ('planned','awaiting_approval','queued','running','cancelling','cancelled','failed','completed')),
  stage text not null,
  body jsonb not null,
  idempotency_key text not null,
  request_digest text not null,
  created_by text not null,
  created_at timestamptz not null default transaction_timestamp(),
  spend_approved_by text,
  spend_approved_at timestamptz,
  cancellation_requested boolean not null default false,
  lease_owner text,
  lease_until timestamptz,
  updated_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, job_id),
  unique (tenant_id, idempotency_key),
  -- Separation of duties: whoever plans a release does not approve its spend.
  check (spend_approved_by is null or spend_approved_by <> created_by)
);
create index factory_release_jobs_queue_idx on harness_control.factory_release_jobs(tenant_id, status, created_at);

create table harness_control.factory_evaluation_reports (
  tenant_id text not null,
  report_digest text not null check (report_digest ~ '^[a-f0-9]{64}$'),
  job_id text not null,
  body jsonb not null,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, report_digest),
  foreign key (tenant_id, job_id) references harness_control.factory_release_jobs(tenant_id, job_id)
);

create table harness_control.factory_releases (
  tenant_id text not null,
  release_digest text not null check (release_digest ~ '^[a-f0-9]{64}$'),
  release_id text not null,
  job_id text not null,
  report_digest text not null,
  body jsonb not null,
  created_by text not null,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, release_digest),
  unique (tenant_id, release_id),
  foreign key (tenant_id, job_id) references harness_control.factory_release_jobs(tenant_id, job_id),
  foreign key (tenant_id, report_digest) references harness_control.factory_evaluation_reports(tenant_id, report_digest)
);

-- When each release takes effect per environment, as release activation does for process releases: activating now,
-- scheduling a date and rolling back each add a row; the release in effect is the one whose activation started last.
create table harness_control.factory_release_activations (
  tenant_id text not null,
  activation_id text not null,
  release_digest text not null,
  environment text not null,
  kind text not null check (kind in ('ACTIVATE','SCHEDULE','ROLLBACK')),
  effective_from timestamptz not null,
  actor text not null,
  reason text not null default '',
  created_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, activation_id),
  foreign key (tenant_id, release_digest) references harness_control.factory_releases(tenant_id, release_digest)
);
create index factory_release_activations_env_idx on harness_control.factory_release_activations(tenant_id, environment, effective_from desc);

create table harness_control.factory_events (
  tenant_id text not null,
  event_id bigint generated always as identity,
  kind text not null,
  ref text not null,
  actor text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default transaction_timestamp(),
  primary key (tenant_id, event_id)
);

create function harness_control.factory_history_immutable() returns trigger language plpgsql as $$
begin
  raise exception 'factory.history_immutable';
end $$;

do $$
declare name text;
begin
  foreach name in array array['factory_type_strategies','factory_dataset_versions','factory_evaluation_reports','factory_releases',
    'factory_release_activations','factory_events'] loop
    execute format('create trigger %I before update or delete on harness_control.%I for each row execute function harness_control.factory_history_immutable()', name || '_immutable', name);
  end loop;
  foreach name in array array['factory_type_strategies','factory_dataset_versions','factory_model_versions','factory_classifier_versions',
    'factory_release_jobs','factory_evaluation_reports','factory_releases','factory_release_activations','factory_events'] loop
    execute format('alter table harness_control.%I enable row level security', name);
    execute format('alter table harness_control.%I force row level security', name);
    execute format($p$create policy harness_control_tenant_scope on harness_control.%I
      using (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
      with check (tenant_id = nullif(current_setting('app.tenant_id', true), ''))$p$, name);
  end loop;
end $$;

alter table harness_control.artifact_registry drop constraint if exists artifact_registry_artifact_kind_check;
alter table harness_control.artifact_registry add constraint artifact_registry_artifact_kind_check
  check (artifact_kind in ('policy-bundle','release-manifest','deployment-package','bootstrap-plan',
    'platform-release','skill-bundle','skill-qualification','source-policy','source-binding','source-access','source-context',
    'document-model-release'));
