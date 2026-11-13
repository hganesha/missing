import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('./deploy-azure.mjs', import.meta.url));
// The script imports the recipe's TypeScript naming, as `pnpm deploy:azure` runs it under tsx.
const tsx = import.meta.resolve('tsx');
async function sandbox(run, env = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'integralflow-azure-test-'));
  const executable = `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.AZ_CALL_LOG, JSON.stringify(args) + '\\n');
const key = args.slice(0,3).join(' ');
let result = null;
if (key.startsWith('account show')) result = { id: 'test-subscription' };
else if (key.startsWith('group exists')) result = process.env.GROUP_EXISTS === 'true';
else if (key.startsWith('resource list')) {
  if (process.env.GROUP_EXISTS !== 'true') { process.stderr.write('Listed a missing resource group'); process.exit(1); }
  result = [{name:'integralflow'}];
}
else if (key === 'containerapp secret list') result = process.env.EMPTY_SECRET_LIST === 'true' ? null : [{name:'model-token'}];
else if (key === 'acr manifest show-metadata') result = {digest:'sha256:' + 'a'.repeat(64)};
else if (key === 'deployment group create' && args.includes('integralflow-bootstrap')) result = {properties:{outputs:{onboardingUrl:{value:'https://integralflow.example.com/onboarding'}}}};
process.stdout.write(JSON.stringify(result));
`;
  await writeFile(join(directory, 'az'), executable, { mode: 0o700 });
  const log = join(directory, 'calls.jsonl');
  const invoke = (...args) => spawnSync(process.execPath, ['--import', tsx, script, ...args], { cwd: directory, encoding: 'utf8', env: { ...process.env, ...env, PATH: `${directory}:${process.env.PATH}`, AZ_CALL_LOG: log } });
  const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  try { await run({ directory, invoke, calls }); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('plan is read-only and does not generate or expose an administrator token', async () => sandbox(async ({ invoke, calls, directory }) => {
  const result = invoke('plan'); assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).runtimeProvisioning, false);
  assert.equal((await calls()).length, 1);
  await assert.rejects(readFile(join(directory, '.integralflow/azure/rg-integralflow-bootstrap/claim-token')));
}));

test('cloud preview inventories the executor without requiring built dependency digests', async () => sandbox(async ({ invoke, calls }) => {
  const result = invoke('plan', '--cloud-executor', 'true'); assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.runtimeProvisioning, true);
  assert.ok(plan.resources.some(resource => resource.startsWith('Private cloud executor:')));
  assert.equal((await calls()).length, 1);
  assert.notEqual(invoke('apply', '--cloud-executor', 'true', '--document-image', 'mutable:latest').status, 0);
}));

test('first deployment creates the group before provisioning and pins the returned image digest', async () => sandbox(async ({ invoke, calls, directory }) => {
  const result = invoke('apply'); assert.equal(result.status, 0, result.stderr);
  const operations = await calls();
  assert.ok(operations.some(args => args.slice(0,2).join(' ') === 'group create'));
  assert.ok(!operations.some(args => args.slice(0,2).join(' ') === 'resource list'));
  const receipt = JSON.parse(await readFile(join(directory, '.integralflow/azure/rg-integralflow-bootstrap/launch.json'), 'utf8'));
  assert.ok(receipt.image.endsWith('@sha256:' + 'a'.repeat(64)));
  assert.deepEqual(Object.keys(receipt.hostImages).sort(), ['evidence-pipeline', 'skill-host']);
  assert.match(receipt.skillBundleLockDigest, /^[a-f0-9]{64}$/);
  assert.ok(Object.values(receipt.hostImages).every(image => /^if[a-f0-9]{12}\.azurecr\.io\/integralflow-[a-z-]+@sha256:a{64}$/.test(image)));
  const builds = operations.filter(args => args.slice(0, 2).join(' ') === 'acr build');
  assert.deepEqual(builds.map(args => args.at(-2)), ['.', 'apps/fincrime-host', 'apps/evidence-pipeline']);
  const token = (await readFile(receipt.tokenPath, 'utf8')).trim();
  assert.ok(!result.stdout.includes(token)); assert.ok(!JSON.stringify(operations).includes(token));
}));

test('an update refuses to silently remove existing deployed secrets', async () => sandbox(async ({ invoke, calls }) => {
  const result = invoke('apply'); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Supply the existing --secrets-file/);
  assert.ok(!(await calls()).some(args => args.slice(0,3).join(' ') === 'deployment group create'));
}, { GROUP_EXISTS: 'true' }));

test('an update accepts the empty secret inventory returned as null by Azure CLI', async () => sandbox(async ({ invoke, calls }) => {
  const result = invoke('apply'); assert.equal(result.status, 0, result.stderr);
  assert.ok((await calls()).some(args => args.slice(0,2).join(' ') === 'acr build'));
}, { GROUP_EXISTS: 'true', EMPTY_SECRET_LIST: 'true' }));

test('secrets inside the source context are rejected before a remote image build', async () => sandbox(async ({ invoke, directory, calls }) => {
  const path = join(directory, 'private.json'); await writeFile(path, '{"MODEL_PROVIDER_TOKEN":"private-token"}');
  const result = invoke('apply', '--secrets-file', path); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /outside the repository/);
  assert.ok(!(await calls()).some(args => args.slice(0,2).join(' ') === 'acr build'));
}));

test('cloud bootstrap builds a separate pinned executor and never prints its bearer credential', async () => sandbox(async ({ invoke, calls, directory }) => {
  const dependency = 'ifregistry.azurecr.io/dependency@sha256:' + 'b'.repeat(64);
  const result = invoke('apply', '--cloud-executor', 'true', '--document-image', dependency, '--collector-image', dependency);
  assert.equal(result.status, 0, result.stderr);
  const operations = await calls();
  assert.ok(operations.some(args => args.includes('Dockerfile.executor')));
  const receipt = JSON.parse(await readFile(join(directory, '.integralflow/azure/rg-integralflow-bootstrap/launch.json'), 'utf8'));
  assert.ok(receipt.executorImage.includes('/integralflow-executor@sha256:')); assert.equal(receipt.runtimeProvisioning, true);
  const token = (await readFile(join(directory, '.integralflow/azure/rg-integralflow-bootstrap/executor-token'), 'utf8')).trim();
  assert.ok(!result.stdout.includes(token)); assert.ok(!JSON.stringify(operations).includes(token));
  assert.match(result.stdout, /Private cloud executor installed/);
}));
