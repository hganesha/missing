import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runGithubBootstrap } from './deploy-azure-github.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function sandbox(run) {
  const cwd = await mkdtemp(join(tmpdir(), 'if-github-test-'));
  const env = { BOOTSTRAP_MODE: 'apply', BOOTSTRAP_RESOURCE_GROUP: 'rg-test', BOOTSTRAP_NAME: 'test', BOOTSTRAP_LOCATION: 'centralus', AZURE_SUBSCRIPTION_ID: '11111111-1111-4111-8111-111111111111', BOOTSTRAP_STATE_VAULT: 'test-state-vault', BOOTSTRAP_COLLECTOR_IMAGE: `docker.io/otel/opentelemetry-collector-contrib@sha256:${'a'.repeat(64)}`, GITHUB_SHA: 'b'.repeat(40), GITHUB_STEP_SUMMARY: join(cwd, 'summary.md') };
  const plan = { subscription: env.AZURE_SUBSCRIPTION_ID, registryName: 'if0123456789ab', resources: ['Registry', 'Private executor'] };
  const stateName = `if-bootstrap-${hash(`${env.AZURE_SUBSCRIPTION_ID}/rg-test/test`).slice(0, 20)}`;
  const directory = join(cwd, '.integralflow/azure/rg-test');
  const secrets = new Map(); const calls = []; const logs = []; const masks = []; const files = [];
  let exists = false; let hashes; let failure; let resources; let environment = { properties: {} };
  const state = () => ({ version: 1, subscription: env.AZURE_SUBSCRIPTION_ID, resourceGroup: 'rg-test', name: 'test', claimToken: randomBytes(32).toString('hex'), executorToken: randomBytes(32).toString('hex') });
  const az = async (args, parse = true) => {
    const command = args.slice(0, 3).join(' '); calls.push({ kind: 'az', args, parse });
    if (failure === command) throw new Error('mock Azure failure');
    const after = flag => args[args.indexOf(flag) + 1];
    if (args[0] === 'group' && args[1] === 'exists') return exists;
    if (args[0] === 'resource') return resources ?? (exists ? [{ name: 'test', type: 'Microsoft.App/containerApps' }] : []);
    if (command === 'keyvault secret list') return [...secrets.keys()];
    if (command === 'keyvault secret show') return { value: secrets.get(after('--name')) };
    if (command === 'keyvault secret set') { secrets.set(after('--name'), await readFile(after('--file'), 'utf8')); return {}; }
    if (command === 'containerapp secret list') return env.BOOTSTRAP_SECRETS_SECRET ? [{ name: 'model-token' }] : [];
    if (command.startsWith('containerapp show')) return { properties: { managedEnvironmentId: `/subscriptions/${env.AZURE_SUBSCRIPTION_ID}/resourceGroups/rg-test/providers/Microsoft.App/managedEnvironments/test-environment`, template: { containers: [{ env: Object.entries(hashes ?? {}).map(([name, value]) => ({ name, value })) }] } } };
    if (command === 'containerapp env show') return environment;
    if (command.startsWith('acr show')) return { sku: { name: 'Premium' } };
    if (command === 'acr manifest show-metadata') return { digest: 'sha256:' + 'c'.repeat(64) };
    return {};
  };
  const deploy = async args => {
    calls.push({ kind: 'deploy', args });
    if (failure === args[0]) throw new Error('mock deployment failure');
    if (args[0] === 'plan') return JSON.stringify(plan);
    if (args[0] === 'apply') {
      assert.ok(secrets.has(stateName), 'tokens must be durable before apply');
      const saved = JSON.parse(secrets.get(stateName));
      for (const [file, value] of [['claim-token', saved.claimToken], ['executor-token', saved.executorToken]]) {
        assert.equal((await readFile(join(directory, file), 'utf8')).trim(), value);
        assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
      }
      if (args.includes('--secrets-file')) {
        const path = args[args.indexOf('--secrets-file') + 1];
        assert.ok(!path.startsWith(cwd + '/'), 'console secrets must be outside the ACR source context');
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        files.push(path);
        assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), JSON.parse(secrets.get(env.BOOTSTRAP_SECRETS_SECRET)));
      }
      exists = true;
      hashes = { ONBOARDING_BOOTSTRAP_SHA256: hash(saved.claimToken), ONBOARDING_EXECUTOR_SHA256: hash(saved.executorToken) };
      await writeFile(join(directory, 'launch.json'), JSON.stringify({ url: 'https://test.example.com/onboarding', image: `if0123456789ab.azurecr.io/integralflow@sha256:${'d'.repeat(64)}` }));
    }
    return '';
  };
  const execute = () => runGithubBootstrap({ cwd, env, az, deploy, log: value => logs.push(value), mask: value => masks.push(value) });
  const mutations = () => calls.filter(call => call.kind === 'az' && ['set', 'create', 'register', 'build', 'import'].some(word => call.args.slice(0, 3).includes(word)) || call.kind === 'deploy' && call.args[0] === 'apply');
  try { await run({ env, cwd, directory, stateName, secrets, calls, logs, masks, files, state, execute, mutations, setExisting: value => { exists = value; }, setHashes: value => { hashes = value; }, setFailure: value => { failure = value; }, setResources: value => { resources = value; }, setEnvironment: value => { environment = value; } }); }
  finally { await rm(cwd, { recursive: true, force: true }); }
}

test('preview compiles templates without vault reads, credentials or cloud writes', async () => sandbox(async f => {
  f.env.BOOTSTRAP_MODE = 'preview';
  await f.execute();
  assert.deepEqual(f.calls.map(call => [call.kind, call.args[0]]), [['deploy', 'plan'], ['deploy', 'validate']]);
  assert.equal(f.masks.length, 0); assert.equal(f.secrets.size, 0);
  assert.match(await readFile(f.env.GITHUB_STEP_SUMMARY, 'utf8'), /No ARM what-if or deployment/);
}));

test('the actual runner entrypoint loads the current TypeScript installer and compiles preview through a fake Azure CLI', async () => sandbox(async f => {
  const bin = join(f.cwd, 'bin'); await mkdir(bin);
  const callsPath = join(f.cwd, 'azure-calls.jsonl');
  await writeFile(join(bin, 'az'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.AZURE_CALLS_FILE, JSON.stringify(args) + '\\n');
if (args[0] === 'account') process.stdout.write(JSON.stringify({ id: process.env.AZURE_SUBSCRIPTION_ID }));
else if (args[0] === 'bicep') { fs.writeFileSync(args[args.indexOf('--outfile') + 1], '{}'); }
else process.exit(42);
`, { mode: 0o700 });
  const result = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./deploy-azure-github.mjs', import.meta.url))], { cwd: fileURLToPath(new URL('..', import.meta.url)), env: { ...process.env, ...f.env, GITHUB_ACTIONS: 'true', BOOTSTRAP_MODE: 'preview', PATH: bin + ':' + process.env.PATH, AZURE_CALLS_FILE: callsPath }, timeout: 30000 });
  assert.match(result.stdout, /Templates compiled/);
  const commands = (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(commands.filter(args => args[0] === 'account').length, 2);
  assert.ok(commands.some(args => args[0] === 'bicep'));
  assert.ok(commands.every(args => ['account', 'bicep'].includes(args[0])));
  assert.match(await readFile(f.env.GITHUB_STEP_SUMMARY, 'utf8'), /Azure bootstrap preview/);
}));

test('fresh and repeated runner installs preserve tokens, pin dependencies and keep secrets out of summaries', async () => sandbox(async f => {
  await f.execute();
  const original = f.secrets.get(f.stateName);
  await f.execute();
  assert.equal(f.secrets.get(f.stateName), original);
  assert.equal(f.calls.filter(call => call.args.slice(0, 3).join(' ') === 'keyvault secret set' && call.args.includes(f.stateName)).length, 1);
  const firstWrite = f.mutations()[0];
  assert.equal(firstWrite.args.slice(0, 3).join(' '), 'keyvault secret set');
  assert.ok(f.secrets.has(f.stateName + '-receipt'));
  const apply = f.calls.find(call => call.kind === 'deploy' && call.args[0] === 'apply').args;
  assert.ok(apply.includes('--cloud-executor')); assert.ok(!apply.includes('--runtime-inputs'));
  assert.match(apply[apply.indexOf('--collector-image') + 1], /^if0123456789ab\.azurecr\.io\/.+@sha256:[a-f0-9]{64}$/);
  const publicOutput = JSON.stringify(f.logs) + await readFile(f.env.GITHUB_STEP_SUMMARY, 'utf8');
  for (const token of [JSON.parse(original).claimToken, JSON.parse(original).executorToken]) { assert.ok(f.masks.includes(token)); assert.ok(!publicOutput.includes(token)); }
  await assert.rejects(stat(f.directory), { code: 'ENOENT' });
}));

test('an existing console without original state is never assigned new tokens', async () => sandbox(async f => {
  f.setExisting(true);
  await assert.rejects(f.execute(), /Import its original/);
  assert.equal(f.mutations().length, 0); assert.equal(f.secrets.size, 0);
}));

test('mismatched saved tokens block updates before resource creation', async () => sandbox(async f => {
  f.setExisting(true); f.secrets.set(f.stateName, JSON.stringify(f.state()));
  f.setHashes({ ONBOARDING_BOOTSTRAP_SHA256: 'incorrect', ONBOARDING_EXECUTOR_SHA256: 'incorrect' });
  await assert.rejects(f.execute(), /do not match/);
  assert.equal(f.mutations().length, 0);
}));

test('vault errors fail closed and never generate replacement state', async () => sandbox(async f => {
  f.setFailure('keyvault secret list');
  await assert.rejects(f.execute(), /mock Azure failure/);
  assert.equal(f.mutations().length, 0); assert.equal(f.secrets.size, 0);
}));

test('foundation resources and non-Basic registries are never reset by standalone bootstrap', async () => sandbox(async f => {
  f.setExisting(true); f.setResources([{ name: 'network', tags: { 'integralflow.component': 'foundation' } }]);
  await assert.rejects(f.execute(), /original foundation receipt/);
  assert.equal(f.mutations().length, 0);
  f.setResources([{ name: 'if0123456789ab', type: 'Microsoft.ContainerRegistry/registries' }]);
  await assert.rejects(f.execute(), /non-Basic SKU/);
  assert.equal(f.mutations().length, 0);
}));

test('existing VNet and log destinations are preserved by refusing standalone updates', async () => sandbox(async f => {
  await f.execute(); f.calls.length = 0;
  f.setEnvironment({ properties: { vnetConfiguration: { infrastructureSubnetId: '/private/subnet' } } });
  await assert.rejects(f.execute(), /networking or logging/);
  assert.equal(f.mutations().length, 0);
  f.setEnvironment({ properties: { appLogsConfiguration: { destination: 'log-analytics' } } });
  await assert.rejects(f.execute(), /networking or logging/);
  assert.equal(f.mutations().length, 0);
}));

test('failed applies retain recoverable vault state and clean private runner files', async () => sandbox(async f => {
  f.setFailure('apply');
  await assert.rejects(f.execute(), /mock deployment failure/);
  const original = f.secrets.get(f.stateName); assert.ok(original);
  await assert.rejects(stat(f.directory), { code: 'ENOENT' });
  f.setFailure(undefined); await f.execute();
  assert.equal(f.secrets.get(f.stateName), original);
}));

test('console secrets resolve outside the source tree and are removed after deployment', async () => sandbox(async f => {
  const value = randomBytes(32).toString('base64');
  f.env.BOOTSTRAP_SECRETS_SECRET = 'console-secrets'; f.secrets.set('console-secrets', JSON.stringify({ MODEL_PROVIDER_TOKEN: value }));
  await f.execute(); await f.execute();
  assert.ok(f.masks.includes(value)); assert.equal(f.files.length, 2);
  for (const file of f.files) await assert.rejects(stat(file), { code: 'ENOENT' });
  assert.ok(!JSON.stringify(f.logs).includes(value));
}));

test('invalid dispatch values and mutable images are rejected before invoking tools', async () => sandbox(async f => {
  f.env.BOOTSTRAP_RESOURCE_GROUP = '../elsewhere';
  await assert.rejects(f.execute(), /Invalid bootstrap/);
  f.env.BOOTSTRAP_RESOURCE_GROUP = 'rg-test'; f.env.BOOTSTRAP_COLLECTOR_IMAGE = 'registry.example.com/otel:latest';
  await assert.rejects(f.execute(), /pinned/);
  assert.equal(f.calls.length, 0);
}));

test('a local operator state directory is preserved rather than overwritten', async () => sandbox(async f => {
  await mkdir(f.directory, { recursive: true });
  await writeFile(join(f.directory, 'claim-token'), 'local state');
  await assert.rejects(f.execute(), { code: 'EEXIST' });
  assert.equal(await readFile(join(f.directory, 'claim-token'), 'utf8'), 'local state');
  assert.equal(f.mutations().length, 0);
}));
