import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { RUNTIME_SERVICES } from '../packages/contracts/src/deployment-plan.ts';
import { runtimeInputsSchema } from '../apps/launcher/src/recipes/azure.ts';

const foundationScript = fileURLToPath(new URL('./deploy-azure-foundation.mjs', import.meta.url));
const bootstrapScript = fileURLToPath(new URL('./deploy-azure.mjs', import.meta.url));
const tsx = import.meta.resolve('tsx');
const GROUP = 'rg-integralflow-bootstrap';

// A stand-in for the Azure CLI: records every call (and the parameter files it is given),
// keeps vault secrets in a directory, and answers with the shapes the scripts read.
const fakeAz = `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const args = process.argv.slice(2);
const flag = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const parameters = args.find(arg => arg.startsWith('@'));
fs.appendFileSync(process.env.AZ_CALL_LOG, JSON.stringify({ args, parameters: parameters ? JSON.parse(fs.readFileSync(parameters.slice(1), 'utf8')).parameters : undefined }) + '\\n');
const state = file => path.join(process.env.AZ_STATE, file);
const load = file => { try { return JSON.parse(fs.readFileSync(state(file), 'utf8')); } catch { return []; } };
const save = (file, value) => fs.writeFileSync(state(file), JSON.stringify(value));
const key = args.slice(0, 3).join(' ');
let result = null;
if (key.startsWith('account show')) result = { id: '11111111-1111-4111-8111-111111111111', tenantId: '22222222-2222-4222-8222-222222222222' };
else if (key === 'ad signed-in-user show') result = '33333333-3333-4333-8333-333333333333';
else if (key.startsWith('group exists')) result = fs.existsSync(state('group'));
else if (key.startsWith('group create')) fs.writeFileSync(state('group'), '');
else if (key === 'acr manifest show-metadata') result = { digest: 'sha256:' + 'b'.repeat(64) };
else if (key === 'storage account keys') result = 'storage-account-key-value';
else if (key === 'cognitiveservices account keys') result = 'model-account-key-value';
else if (key === 'keyvault secret show') {
  const file = state('secret-' + flag('--name'));
  if (!fs.existsSync(file)) process.exit(1);
  result = flag('--query') === 'value' ? fs.readFileSync(file, 'utf8') : 'https://vault/secrets/' + flag('--name');
}
else if (key === 'keyvault secret set') { fs.copyFileSync(flag('--file'), state('secret-' + flag('--name'))); result = 'id'; }
else if (key === 'deployment group create') {
  const deployment = flag('--name');
  if (deployment.endsWith('-foundation')) result = { properties: { outputs: Object.fromEntries(Object.entries({ appsSubnetId: '/subscriptions/s/subnets/apps', workspaceName: 'integralflow-logs', insightsName: 'integralflow-insights',
    vaultName: 'kv-integral-abc', evidenceAccountName: 'ifevidabc', evidenceEndpoint: 'https://ifevidabc.blob.core.windows.net', evidenceContainer: 'evidence', databaseHost: 'postgres.integralflow.internal',
    outboundAddress: '203.0.113.7', modelsAccountName: 'integralflow-models-abc', modelsEndpoint: 'https://integralflow-models-abc.openai.azure.com/openai/v1', documentsAccountName: '', documentsEndpoint: '' }).map(([name, value]) => [name, { value }])) } };
  else if (deployment.endsWith('-bootstrap')) result = { properties: { outputs: { onboardingUrl: { value: 'https://integralflow.env.example.com/onboarding' }, defaultDomain: { value: 'env.example.com' }, telemetryEndpoint: { value: 'https://integralflow-otel.internal.env.example.com' } } } };
  else result = { properties: { outputs: {} } };
}
else if (key.startsWith('resource list')) result = [];
else if (key === 'ad app list') result = load('apps').filter(app => app.displayName.startsWith(flag('--display-name')));
else if (key === 'ad app create') { const apps = load('apps'); result = { displayName: flag('--display-name'), appId: crypto.randomUUID(), id: crypto.randomUUID() }; save('apps', [...apps, result]); }
else if (key === 'ad sp list') result = load('principals').filter(item => flag('--filter').includes(item.appId));
else if (key === 'ad sp create') { result = { appId: flag('--id'), id: crypto.randomUUID() }; save('principals', [...load('principals'), result]); }
else if (key === 'ad app credential') result = { password: 'client-secret-' + crypto.randomBytes(16).toString('hex') };
else if (args[0] === 'rest') {
  const uri = flag('--uri'); const method = flag('--method');
  const url = new URL(uri);
  const body = flag('--body') ? JSON.parse(flag('--body')) : {};
  const graphId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  if (method === 'GET' && url.pathname === '/v1.0/servicePrincipals') result = { value: [{ id: graphId, appRoles: [{ id: 'df021288-bdef-4463-88db-98f22de89214', value: 'User.Read.All', isEnabled: true, allowedMemberTypes: ['Application'] }] }] };
  else if (method === 'GET' && url.searchParams.has('$select') && url.searchParams.get('$select') === 'requiredResourceAccess') result = { requiredResourceAccess: load('required-access') };
  else if (method === 'GET' && uri.endsWith('/appRoleAssignments')) result = { value: load('graph-grants') };
  else if (method === 'PATCH' && body.requiredResourceAccess) save('required-access', body.requiredResourceAccess);
  else if (method === 'POST' && uri.endsWith('/' + graphId + '/appRoleAssignedTo')) save('graph-grants', [...load('graph-grants'), body]);
  else if (method === 'GET' && uri.endsWith('policies/tokenLifetimePolicies')) result = { value: load('policies') };
  else if (method === 'POST' && uri.endsWith('policies/tokenLifetimePolicies')) { result = { ...JSON.parse(flag('--body')), id: 'policy-1' }; save('policies', [result]); }
  else if (method === 'GET' && uri.endsWith('/tokenLifetimePolicies')) result = { value: load('assigned') };
  else if (method === 'POST' && uri.endsWith('/tokenLifetimePolicies/$ref')) save('assigned', [{ id: 'policy-1' }]);
  else if (method === 'GET' && uri.includes('$select=appRoles')) result = { appRoles: load('roles') };
  else if (method === 'PATCH' && JSON.parse(flag('--body')).appRoles) save('roles', JSON.parse(flag('--body')).appRoles);
}
process.stdout.write(JSON.stringify(result));
`;

async function sandbox(work) {
  const directory = await mkdtemp(join(tmpdir(), 'integralflow-foundation-test-'));
  const state = join(directory, 'az-state');
  await mkdir(state);
  await writeFile(join(directory, 'az'), fakeAz, { mode: 0o700 });
  const log = join(directory, 'calls.jsonl');
  const env = { ...process.env, PATH: `${directory}:${process.env.PATH}`, AZ_CALL_LOG: log, AZ_STATE: state, INTEGRALFLOW_RETRY_MS: '1' };
  const invoke = (script, ...args) => spawnSync(process.execPath, ['--import', tsx, script, ...args], { cwd: directory, encoding: 'utf8', env });
  const calls = async () => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const secret = name => readFile(join(state, `secret-${name}`), 'utf8');
  try { await work({ directory, invoke, calls, secret }); } finally { await rm(directory, { recursive: true, force: true }); }
}
const ok = result => { assert.equal(result.status, 0, result.stderr); return result; };

test('plan reads the account only and writes nothing', async () => sandbox(async ({ invoke, calls, directory }) => {
  const plan = JSON.parse(ok(invoke(foundationScript, 'plan')).stdout);
  assert.equal(plan.recipe, 'azure-foundation-v1');
  assert.equal(plan.databaseVmSize, 'Standard_D2s_v5');
  assert.ok(plan.resources.some(item => item.includes('PostgreSQL 17 host')));
  assert.equal((await calls()).length, 1);
  await assert.rejects(stat(join(directory, '.integralflow')));
}));

test('apply creates the vault before the database, keeps every secret out of commands and output, and is repeatable', async () => sandbox(async ({ invoke, calls, secret, directory }) => {
  const first = ok(invoke(foundationScript, 'apply', '--database-vm-size', 'Standard_B2ms'));
  const operations = await calls();
  const foundations = operations.filter(call => call.args.includes('integralflow-foundation'));
  assert.deepEqual(foundations.map(call => call.parameters.deployDatabase.value), [false, true]);
  assert.equal(foundations[0].parameters.operatorObjectId.value, '33333333-3333-4333-8333-333333333333');
  assert.match(foundations[1].parameters.databaseImage.value, /^if[a-f0-9]{12}\.azurecr\.io\/integralflow-postgres@sha256:b{64}$/);
  assert.match(foundations[1].parameters.databaseAdminPublicKey.value, /^ssh-rsa /);
  assert.equal(foundations[1].parameters.databaseVmSize.value, 'Standard_B2ms');
  const order = name => operations.findIndex(call => call.args.includes(name));
  assert.ok(operations.findIndex(call => call.args.slice(0, 3).join(' ') === 'keyvault secret set') < operations.lastIndexOf(foundations[1]));
  assert.ok(order('Dockerfile.postgres') > operations.indexOf(foundations[0]));

  const password = await secret('postgres-migrator-password');
  assert.match(password, /^[a-f0-9]{64}$/);
  const credential = JSON.parse(await secret('evidence-storage-credential'));
  assert.deepEqual(credential, { provider: 'azure_blob', accountName: 'ifevidabc', accountKey: 'storage-account-key-value' });
  // The server certificate chains to the generated authority and names the internal host.
  const material = join(directory, 'material'); await mkdir(material);
  for (const name of ['postgres-ca-cert', 'postgres-server-cert']) await writeFile(join(material, name), await secret(name));
  assert.equal(spawnSync('openssl', ['verify', '-CAfile', join(material, 'postgres-ca-cert'), '-verify_hostname', 'postgres.integralflow.internal', join(material, 'postgres-server-cert')], { encoding: 'utf8' }).status, 0);
  assert.match(await secret('postgres-server-key'), /BEGIN PRIVATE KEY/);

  const receiptPath = join(directory, '.integralflow/azure', GROUP, 'foundation.json');
  const receipt = await readFile(receiptPath, 'utf8');
  const everything = JSON.stringify(operations) + first.stdout + first.stderr + receipt;
  for (const hidden of [password, 'storage-account-key-value', (await secret('postgres-server-key')).split('\n')[1]]) assert.ok(!everything.includes(hidden));
  assert.equal(JSON.parse(receipt).databaseHost, 'postgres.integralflow.internal');
  assert.equal((await stat(receiptPath)).mode & 0o077, 0);

  ok(invoke(foundationScript, 'apply'));
  assert.equal((await calls()).filter(call => call.parameters?.deployDatabase?.value === true).at(-1).parameters.databaseVmSize.value, 'Standard_B2ms');
  assert.equal(await secret('postgres-migrator-password'), password);
  assert.equal((await readdir(join(directory, '.integralflow/azure', GROUP))).filter(file => file.startsWith('postgres-admin-key')).length, 2);
}));

test('the bootstrap joins the foundation network, and identity and inputs produce a valid private runtime file', async () => sandbox(async ({ invoke, calls, secret, directory }) => {
  ok(invoke(foundationScript, 'apply'));
  ok(invoke(bootstrapScript, 'apply', '--allowed-origin', 'https://integralflow-models-abc.openai.azure.com'));
  const bootstrap = (await calls()).find(call => call.args.includes('integralflow-bootstrap')).parameters;
  assert.equal(bootstrap.infrastructureSubnetId.value, '/subscriptions/s/subnets/apps');
  assert.equal(bootstrap.logWorkspaceName.value, 'integralflow-logs');
  assert.match(bootstrap.collectorImage.value, /azurecr\.io\/otel\/opentelemetry-collector-contrib@sha256:/);
  assert.ok(bootstrap.allowedOrigins.value.split(',').includes('https://integralflow-models-abc.openai.azure.com'));

  ok(invoke(foundationScript, 'identity'));
  const identities = [...new Set([...RUNTIME_SERVICES.map(service => service.identity), 'skill-host', 'document-factory-worker'])];
  const identity = JSON.parse(await readFile(join(directory, '.integralflow/azure', GROUP, 'identity.json'), 'utf8'));
  assert.deepEqual(Object.keys(identity.clients).sort(), [...identities].sort());
  assert.equal(new Set(Object.values(identity.clients).map(client => client.subject)).size, identities.length);
  assert.equal(identity.issuer, 'https://login.microsoftonline.com/22222222-2222-4222-8222-222222222222/v2.0');
  assert.deepEqual(identity.console.redirectUris.map(uri => new URL(uri).pathname), ['/auth/setup/callback', '/auth/callback']);
  const operations = await calls();
  const policy = operations.find(call => call.args.includes('POST') && call.args.some(arg => arg.endsWith('policies/tokenLifetimePolicies')));
  assert.match(policy.args[policy.args.indexOf('--body') + 1], /AccessTokenLifetime\\":\\"00:30:00/);
  const graphConsent = items => items.filter(call => call.args.includes('POST') && call.args.some(arg => arg.endsWith('/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/appRoleAssignedTo')));
  assert.equal(graphConsent(operations).length, 1);
  const consentBody = JSON.parse(graphConsent(operations)[0].args[graphConsent(operations)[0].args.indexOf('--body') + 1]);
  assert.equal(consentBody.appRoleId, 'df021288-bdef-4463-88db-98f22de89214');
  assert.ok(operations.some(call => call.args.includes('PATCH') && call.args.some(arg => arg.includes('requiredResourceAccess'))));
  const resets = operations.filter(call => call.args.slice(0, 4).join(' ') === 'ad app credential reset').length;
  assert.equal(resets, identities.length + 1);
  // A second run reuses the applications and issues no new credentials.
  ok(invoke(foundationScript, 'identity'));
  const after = await calls();
  assert.equal(graphConsent(after).length, 1);
  assert.equal(after.filter(call => call.args.slice(0, 4).join(' ') === 'ad app credential reset').length, resets);
  assert.equal(after.filter(call => call.args.slice(0, 3).join(' ') === 'ad app create').length, identities.length + 2);

  const inside = invoke(foundationScript, 'inputs', '--out', join(directory, 'private'));
  assert.notEqual(inside.status, 0); assert.match(inside.stderr, /outside the repository/);
  const out = await mkdtemp(join(tmpdir(), 'integralflow-private-'));
  try {
    const written = ok(invoke(foundationScript, 'inputs', '--out', out, '--tenant', 'acme'));
    const inputs = runtimeInputsSchema.parse(JSON.parse(await readFile(join(out, 'runtime-inputs.json'), 'utf8')));
    assert.equal(inputs.databaseUrls.discovery, 'postgresql://migration_operator@postgres.integralflow.internal/ehf_discovery?sslmode=verify-full');
    assert.equal(inputs.databaseUrls.context, 'postgresql://migration_operator@postgres.integralflow.internal/integralflow_context?sslmode=verify-full');
    assert.equal(inputs.databaseCaPem, await secret('postgres-ca-cert'));
    for (const service of identities) {
      const client = inputs.workload.clients[service];
      assert.equal(inputs.secrets[client.secretRef.slice(4)], await secret(`workload-${service}-client-secret`));
      assert.equal(client.scope, `api://${inputs.workload.audience}/.default`);
    }
    assert.equal(JSON.parse(inputs.secrets.OBJECT_STORAGE_CREDENTIAL).provider, 'azure_blob');
    assert.deepEqual(inputs.hostedServices, { skillHost: {}, evidencePipeline: { tokenRef: 'env:EVIDENCE_PIPELINE_TOKEN', dataKeyRef: 'env:EVIDENCE_PIPELINE_DATA_KEY' } });
    assert.equal(inputs.secrets.EVIDENCE_PIPELINE_TOKEN, await secret('evidence-pipeline-token'));
    assert.equal(Buffer.from(inputs.secrets.EVIDENCE_PIPELINE_DATA_KEY, 'base64').length, 32);
    ok(invoke(foundationScript, 'inputs', '--out', out, '--tenant', 'acme', '--dev-auto-approve-skill-bundle'));
    assert.deepEqual(JSON.parse(await readFile(join(out, 'runtime-inputs.json'), 'utf8')).hostedServices.skillHost, { autoApproveBundle: true });
    assert.deepEqual(Object.keys(JSON.parse(await readFile(join(out, 'bootstrap-secrets.json'), 'utf8'))).sort(), ['MODEL_PROVIDER_TOKEN', 'OIDC_CLIENT_SECRET']);
    assert.equal((await stat(join(out, 'runtime-inputs.json'))).mode & 0o077, 0);
    const consoleValues = await readFile(join(directory, '.integralflow/azure', GROUP, 'console-values.json'), 'utf8');
    assert.equal(JSON.parse(consoleValues).foundation.telemetryEndpoint, 'https://integralflow-otel.internal.env.example.com');
    assert.equal(JSON.parse(consoleValues).access.rolesClaim, 'roles');
    for (const hidden of [inputs.secrets.OIDC_CLIENT_SECRET, inputs.secrets.DATABASE_MIGRATOR_PASSWORD, 'model-account-key-value']) assert.ok(!(consoleValues + written.stdout + JSON.stringify(await calls())).includes(hidden));
  } finally { await rm(out, { recursive: true, force: true }); }
}));
