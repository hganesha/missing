import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const image = process.argv[2] ?? 'integralflow:onboarding';
const postgresImage = process.argv[3] ?? 'integralflow:postgres-smoke';
const suffix = randomUUID().slice(0, 8);
const network = `integralflow-migrations-${suffix}`;
const database = `${network}-pg`;
const incompatible = `${network}-no-age`;
const directory = await mkdtemp(join(tmpdir(), 'integralflow-migration-smoke-'));
const password = randomBytes(24).toString('hex');
function docker(args, allowFailure = false) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 2_000_000 });
  if (!allowFailure && result.status !== 0) throw new Error(`Docker operation failed (${args[0]}): ${result.stderr}`);
  return result;
}
function sql(query) { return docker(['exec', database, 'psql', '-U', 'postgres', '-d', 'postgres', '-Atc', query]).stdout.trim(); }
function run(action, allowFailure = false, overrides = []) {
  return docker(['run', '--rm', '--read-only', '--tmpfs', '/tmp', '--network', network, '-v', `${directory}:/run/config:ro`,
    '--env-file', join(directory, 'database.env'), '-e', 'SERVICE_NAME=migrate', '-e', 'DEPLOYMENT_BUNDLE_PATH=/run/config/bundle.json',
    '-e', 'SECURITY_PROFILE=development', ...overrides, image, ...action], allowFailure);
}
try {
  // Test-only credentials. Private directory is exposed read-only to UID 1001;
  // password-bearing URLs never appear in the profile or migrator environment.
  await chmod(directory, 0o755);
  const profile = { apiVersion: 'integralflow/deployment-v1', environmentId: 'migration-smoke', displayName: 'Migration smoke',
    target: { provider: 'container', scopeId: 'smoke', region: 'local', recipe: 'container-bootstrap-v1' },
    foundation: { posture: 'minimal', database: { host: 'database', port: 5432, credentialRef: 'env:PGPASSWORD' }, objectStore: { endpoint: '', bucket: '', credentialRef: '' }, telemetryEndpoint: '' },
    intelligence: { provider: 'openrouter', endpoint: 'https://openrouter.ai/api/v1', credentialRef: '', models: { low: '', med: '', high: '', xhigh: '' }, runtimeEndpoint: '' },
    access: { issuer: '', clientId: '', clientSecretRef: '', rolesClaim: 'groups', mappings: [] }, connections: [], schedules: [] };
  await writeFile(join(directory, 'bundle.json'), JSON.stringify({ apiVersion: 'integralflow/deployment-bundle-v1', revision: 1, phase: 'configured', profile }), { mode: 0o644 });
  await writeFile(join(directory, 'database.env'), `DATABASE_AUTH=url\nPGPASSWORD=${password}\nDATABASE_URL=postgresql://postgres@database/ehf_control\nCASE_DATABASE_URL=postgresql://postgres@database/ehf_case\nCONTEXT_DATABASE_URL=postgresql://postgres@database/ehf_context\nPLATFORM_TENANT_ID=smoke\n`, { mode: 0o600 });
  docker(['network', 'create', network]);
  docker(['run', '--rm', '-d', '--name', database, '--network', network, '--network-alias', 'database', '-e', `POSTGRES_PASSWORD=${password}`, postgresImage]);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (docker(['exec', database, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], true).status === 0) { ready = true; break; }
    await setTimeout(200);
  }
  assert.ok(ready, 'PostgreSQL must start');
  for (const store of ['control', 'case', 'context']) sql(`create database ehf_${store}`);
  // Managed PostgreSQL can omit AGE from the default path. The runner must set it
  // for its own session before graph DDL, independent of server/image defaults.
  sql("alter database ehf_context set search_path = pg_catalog, public");
  const before = sql("select count(*) from pg_roles where rolname like 'ehf_svc_%'");
  const checked = run(['check']);
  const result = JSON.parse(checked.stdout.trim());
  assert.ok(result.results.every(check => check.status === 'passed'));
  assert.equal(sql("select count(*) from pg_roles where rolname like 'ehf_svc_%'"), before, 'Check must not create service groups');
  assert.notEqual(run(['apply', '--environment', 'wrong-environment'], true).status, 0);
  const migrated = run(['apply', '--environment', 'migration-smoke']);
  assert.match(migrated.stdout, /"completed":\["control","case","context","authoring"\]/);
  assert.equal(sql("select count(*) from pg_roles where rolname like 'ehf_svc_%' and rolcanlogin"), '0', 'No shared service logins are created');
  const count = store => docker(['exec', database, 'psql', '-U', 'postgres', '-d', `ehf_${store}`, '-Atc', `select count(*) from ${store === 'control' ? 'harness_control' : store === 'case' ? 'case_core' : 'context'}.schema_migrations`]).stdout.trim();
  const first = ['control', 'case', 'context'].map(count);
  assert.ok(first.every(n => Number(n) > 0));
  run(['apply', '--environment', 'migration-smoke']);
  assert.deepEqual(['control', 'case', 'context'].map(count), first, 'Rerun must preserve applied migration counts');
  const drafts = docker(['exec', database, 'psql', '-U', 'postgres', '-d', 'ehf_control', '-Atc', "select count(*) from harness_control.authoring_drafts where tenant_id='smoke' and status='DRAFT' and source_files ? 'policy.yaml' and name like 'Agentic %'"]).stdout.trim();
  assert.equal(drafts, '5', 'Deployment seeds the five released agentic drafts exactly once');
  const age = docker(['exec', database, 'psql', '-U', 'postgres', '-d', 'ehf_context', '-Atc', "select count(*) from pg_extension where extname in ('vector','age')"]).stdout.trim();
  assert.equal(age, '2');
  assert.notEqual(run(['check'], true, ['-e', 'CASE_DATABASE_URL=postgresql://postgres@database/ehf_control']).status, 0);
  const partial = run(['apply', '--environment', 'migration-smoke'], true, ['-e', 'CASE_CORE_SCHEMA=invalid-schema']);
  assert.notEqual(partial.status, 0);
  const failure = JSON.parse(partial.stdout.trim().split('\n').at(-1));
  assert.deepEqual(failure.completed, ['control']); assert.equal(failure.failed, 'case');
  assert.equal(failure.code, 'migration.store_failed');
  assert.ok(!partial.stdout.includes('invalid-schema'));
  // A vanilla pgvector server has no AGE; fail before any schema writes.
  docker(['run', '--rm', '-d', '--name', incompatible, '--network', network, '--network-alias', 'no-age', '-e', `POSTGRES_PASSWORD=${password}`, 'pgvector/pgvector:pg17']);
  ready = false;
  for (let i = 0; i < 100; i++) {
    if (docker(['exec', incompatible, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], true).status === 0) { ready = true; break; }
    await setTimeout(200);
  }
  assert.ok(ready);
  for (const store of ['control', 'case', 'context']) docker(['exec', incompatible, 'psql', '-U', 'postgres', '-d', 'postgres', '-c', `create database ehf_${store}`]);
  profile.foundation.database.host = 'no-age';
  await writeFile(join(directory, 'incompatible.json'), JSON.stringify({ apiVersion: 'integralflow/deployment-bundle-v1', revision: 1, phase: 'configured', profile }), { mode: 0o644 });
  const rejected = run(['apply', '--environment', 'migration-smoke'], true, ['-e', 'DEPLOYMENT_BUNDLE_PATH=/run/config/incompatible.json', ...['DATABASE_URL=postgresql://postgres@no-age/ehf_control', 'CASE_DATABASE_URL=postgresql://postgres@no-age/ehf_case', 'CONTEXT_DATABASE_URL=postgresql://postgres@no-age/ehf_context'].flatMap(value => ['-e', value])]);
  assert.notEqual(rejected.status, 0);
  assert.ok(JSON.parse(rejected.stdout.trim()).results.find(check => check.store === 'context').checks.some(check => check.id === 'extension-available:age' && !check.passed));
  assert.equal(docker(['exec', incompatible, 'psql', '-U', 'postgres', '-d', 'ehf_control', '-Atc', "select count(*) from pg_namespace where nspname='harness_control'"]).stdout.trim(), '0');
  assert.ok(!migrated.stdout.includes(password));
  process.stdout.write('Migration image smoke passed: read-only preflight, target confirmation, three real stores, pgvector + AGE, schema/grants application and idempotent rerun; no service logins or runtime-ready claim.\n');
} finally {
  docker(['rm', '--force', database, incompatible], true);
  docker(['network', 'rm', network], true);
  await rm(directory, { recursive: true, force: true });
}
