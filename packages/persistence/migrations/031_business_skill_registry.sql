-- Business skill registry: the financial-crime canonical skills catalog (business contracts
-- such as screening.sanctions.execute). Not the agent-playbook skills of the authoring
-- registry (skill.kyc.*). Rows are seeded additively from config/business-skills.json by
-- migrate.ts; see docs/implementation/business-skills.md.
create table if not exists harness_control.business_skill_registry (
  skill_id text not null check (skill_id ~ '^[a-z][a-z_]*(\.[a-z][a-z0-9_]*)+$'),
  semver text not null check (semver ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$'),
  manifest jsonb not null,
  manifest_digest text not null check (manifest_digest ~ '^[a-f0-9]{64}$'),
  status text not null check (status in ('draft', 'active', 'deprecated')),
  -- How far the skill is proven, independent of its lifecycle status. Spec-derived
  -- placeholders are 'catalogued' only.
  maturity text not null default 'catalogued' check (maturity in
    ('catalogued', 'designed', 'implemented_synthetic', 'integration_verified', 'production_qualified')),
  source jsonb not null check (jsonb_typeof(source->'path') = 'string' and jsonb_typeof(source->'revision') = 'string'),
  owner text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (skill_id, semver),
  check (manifest->>'id' = skill_id and manifest->>'semver' = semver),
  -- A placeholder derived from the specification text implements nothing.
  check (manifest->>'source' is distinct from 'spec-derived-placeholder' or maturity = 'catalogued')
);

create index if not exists business_skill_registry_maturity_idx
  on harness_control.business_skill_registry(maturity, skill_id);

create index if not exists business_skill_registry_status_idx
  on harness_control.business_skill_registry(status, skill_id);
