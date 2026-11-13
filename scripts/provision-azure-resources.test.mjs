import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AzureProvisioner } from './provision-azure-resources.mjs';
const receipt = { name: 'test', location: 'centralus', subscription: '11111111-1111-4111-8111-111111111111', resourceGroup: 'test', image: 'image' };
test('owned resources reconcile without overwriting; foreign names fail closed', async () => {
  const p = new AzureProvisioner({ receipt, directory: '/tmp', az: async () => ({ properties: { provisioningState: 'Succeeded' }, tags: { 'integralflow.bootstrap': 'test', 'integralflow.environment': 'env' } }) });
  p.profile = { environmentId: 'env' };
  assert.equal((await p.ensure(`${p.scope}/providers/Microsoft.Storage/storageAccounts/test`, 'version', {})).properties.provisioningState, 'Succeeded');
  p.profile = { environmentId: 'foreign' };
  await assert.rejects(() => p.ensure(`${p.scope}/providers/Microsoft.Storage/storageAccounts/test`, 'version', {}), /ownership/);
});
test('scope and origin checks reject arbitrary management paths before invoking CLI', async () => {
  let calls = 0; const p = new AzureProvisioner({ receipt, directory: '/tmp', az: async () => { calls++; } });
  await assert.rejects(() => p.rest('get', 'https://other.example/secret'), /origin/);
  await assert.rejects(() => p.rest('put', '/subscriptions/other/resourceGroups/other/providers/test'), /scope/);
  assert.equal(calls, 0);
});
test('permission failure is redacted and stops dependent writes; retries reconcile stable names', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'azure-recipe-test-'));
  try {
    const p = new AzureProvisioner({ receipt, directory }); const seen = []; const events = [];
    p.create = async kind => { seen.push([kind, p.prefix]); if (kind === 'postgres') throw new Error('permission_required'); return {}; };
    const kinds = ['keyVault', 'postgres', 'managedIdentities', 'evidence', 'foundry', 'documents', 'telemetry', 'oidc'];
    const job = { scopeId: p.scope, image: receipt.image, profile: { environmentId: 'env', target: { region: 'centralus' } }, configuration: { resources: Object.fromEntries(kinds.map(kind => [kind, { mode: 'create' }])) } };
    assert.equal(await p.run(job, async event => events.push(event)), false);
    assert.deepEqual(seen.map(item => item[0]), ['keyVault', 'postgres']); assert.equal(events.at(-1).status, 'waiting');
    await p.run(job, async () => {}); assert.equal(seen[0][1], seen[2][1]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('all eight resources create, report and reconcile without replacing identities or secrets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'azure-full-recipe-'));
  const { readFile, readdir } = await import('node:fs/promises');
  const { randomUUID } = await import('node:crypto');
  const { defaultResourceConfiguration, RESOURCE_KINDS } = await import('../packages/contracts/src/resource-provisioning.ts');
  const resources = new Map(); const secrets = new Map(); const applications = []; const principals = [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', appId: '00000003-0000-0000-c000-000000000000', appRoles: [{ id: 'df021288-bdef-4463-88db-98f22de89214', value: 'User.Read.All', allowedMemberTypes: ['Application'], isEnabled: true }] }]; const policies = []; const assignments = new Map(); const bound = new Map(); let locks = 0;
  const notFound = () => { throw Object.assign(new Error('not found'), { notFound: true }); };
  const scope = `/subscriptions/${receipt.subscription}/resourceGroups/${receipt.resourceGroup}`;
  const vaultUri = 'https://test-vault.vault.azure.net/';
  const insightsId = `${scope}/providers/Microsoft.Insights/components/test-traces`;
  const workspaceId = `${scope}/providers/Microsoft.OperationalInsights/workspaces/test-logs`;
  resources.set(insightsId, { properties: { WorkspaceResourceId: workspaceId, ConnectionString: 'InstrumentationKey=private' } });
  resources.set(workspaceId, { properties: { provisioningState: 'Succeeded', features: { enableLogAccessUsingOnlyResourcePermissions: true } } });
  resources.set(`${scope}/providers/Microsoft.KeyVault/vaults/test-vault`, { properties: { enableRbacAuthorization: true, enablePurgeProtection: true, tenantId: '22222222-2222-4222-8222-222222222222' } });
  resources.set(`${scope}/providers/Microsoft.App/containerApps/test`, { properties: { managedEnvironmentId: `${scope}/providers/Microsoft.App/managedEnvironments/test`, configuration: { registries: [{ server: 'test.azurecr.io', identity: `${scope}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/pull` }] } } });
  resources.set(`${scope}/providers/Microsoft.App/managedEnvironments/test`, { properties: { defaultDomain: 'example.azurecontainerapps.io' } });
  const azure = async args => {
    if (args[0] === 'keyvault') {
      const name = args[args.indexOf('--name') + 1];
      if (args[2] === 'show') return secrets.has(name) ? { value: secrets.get(name) } : notFound();
      secrets.set(name, await readFile(args[args.indexOf('--file') + 1], 'utf8')); return {};
    }
    if (args[0] === 'postgres') return {};
    const method = args[args.indexOf('--method') + 1]; const url = new URL(args[args.indexOf('--url') + 1]);
    const body = args.includes('--body') ? JSON.parse(await readFile(args[args.indexOf('--body') + 1].slice(1), 'utf8')) : {};
    const path = url.pathname;
    if (url.hostname === 'graph.microsoft.com') {
      if (path === '/v1.0/applications') {
        if (method === 'get') return { value: applications.filter(app => url.searchParams.get('$filter') === `displayName eq '${app.displayName}'`) };
        const app = { ...body, id: randomUUID(), appId: randomUUID() }; applications.push(app); return app;
      }
      if (path === '/v1.0/servicePrincipals') {
        if (method === 'get') return { value: principals.filter(sp => url.searchParams.get('$filter') === `appId eq '${sp.appId}'`) };
        const sp = { ...body, id: randomUUID() }; principals.push(sp); return sp;
      }
      if (path === '/v1.0/policies/tokenLifetimePolicies') { const policy = { ...body, id: randomUUID() }; policies.push(policy); return policy; }
      if (path.endsWith('/tokenLifetimePolicies/$ref')) { bound.set(path.split('/')[3], body['@odata.id'].split('/').at(-1)); return {}; }
      if (path.endsWith('/tokenLifetimePolicies')) return { value: policies.filter(policy => policy.id === bound.get(path.split('/')[3])) };
      if (path.endsWith('/addPassword')) return { secretText: 'a-secret-' + randomUUID() };
      if (path.endsWith('/appRoleAssignedTo')) { if (method === 'get') return { value: assignments.get(path) ?? [] }; assignments.set(path, [...(assignments.get(path) ?? []), body]); return body; }
      if (path.endsWith('/appRoleAssignments')) return { value: [...assignments.values()].flat().filter(item => item.principalId === path.split('/')[3]) };
      if (method === 'get' && path.startsWith('/v1.0/applications/')) return applications.find(app => app.id === path.split('/').at(-1));
      if (method === 'patch' && path.startsWith('/v1.0/servicePrincipals/')) { Object.assign(principals.find(sp => sp.id === path.split('/').at(-1)), body); return {}; }
      if (method === 'patch') { Object.assign(applications.find(app => app.id === path.split('/').at(-1)), body); return {}; }
      throw new Error('Unexpected graph operation: ' + path);
    }
    if (path.endsWith('/listKeys')) return { key1: 'resource-key-for-test' };
    if (path.endsWith('/immutabilityPolicies/default/lock')) { const key = path.slice(0, -5); resources.get(key).properties.state = 'Locked'; locks++; return resources.get(key); }
    if (method === 'get') return resources.get(path) ?? notFound();
    if (method === 'put') {
      const result = { ...body, id: path, etag: 'test-etag', properties: { ...body.properties, provisioningState: 'Succeeded' } };
      if (path.includes('/flexibleServers/') && !path.split('/flexibleServers/')[1].includes('/')) result.properties.fullyQualifiedDomainName = 'test.postgres.database.azure.com';
      if (path.includes('/userAssignedIdentities/')) result.properties = { ...result.properties, clientId: randomUUID(), principalId: randomUUID() };
      if (path.includes('/containerApps/') && !path.endsWith('/test')) result.properties = { ...result.properties, runningStatus: 'Running', latestRevisionName: 'ready', latestReadyRevisionName: 'ready', configuration: { ...body.properties.configuration, ingress: { ...body.properties.configuration.ingress, fqdn: 'service.internal.example.azurecontainerapps.io' } } };
      resources.set(path, result); return result;
    }
    throw new Error('Unexpected Azure operation: ' + path);
  };
  try {
    const configuration = defaultResourceConfiguration('22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333');
    for (const kind of RESOURCE_KINDS) configuration.resources[kind].mode = 'create';
    configuration.allowAzureDatabaseAccess = true; configuration.acknowledgeRetentionLock = true;
    const image = 'test.azurecr.io/image@sha256:' + 'a'.repeat(64);
    const p = new AzureProvisioner({ receipt: { ...receipt, image, url: 'https://test.example.com/onboarding', documentImage: image, collectorImage: image, applicationInsightsResourceId: insightsId }, directory, vaultUri, az: azure, catalog: { models: [{ id: 'model', providers: { azure_foundry: 'gpt-4.1' } }] }, postgresClient: class { async connect() {} async query() {} async end() {} } });
    const profile = { environmentId: 'env', foundation: { observability: { backend: 'azure_monitor', applicationInsightsResourceId: '' }, telemetryEndpoint: '' }, target: { region: 'centralus' }, intelligence: { models: { low: 'model', med: 'model', high: 'model', xhigh: 'model' } } };
    const job = { scopeId: scope, image, profile, configuration };
    const events = [];
    assert.equal(await p.run(job, async event => events.push(event)), true, JSON.stringify(events));
    assert.equal(events.filter(event => event.status === 'passed').length, 8);
    assert.deepEqual(events.find(event => event.kind === 'telemetry' && event.status === 'passed').output, {
      resourceId: insightsId, applicationInsightsResourceId: insightsId, endpoint: 'https://service.internal.example.azurecontainerapps.io',
    });
    assert.equal(applications.length, 10); assert.equal(policies.length, 1); assert.equal(locks, 1);
    const workloadBinding = JSON.parse(secrets.get('env-workload-bindings'));
    assert.equal(workloadBinding.audience, applications.find(app => app.displayName.endsWith('-runtime-api')).appId);
    assert.ok(workloadBinding.clients['control-api'].scope.startsWith('api://' + workloadBinding.audience));
    const oidc = applications.find(app => app.displayName.endsWith('-oidc'));
    assert.deepEqual(oidc.requiredResourceAccess, [{ resourceAppId: '00000003-0000-0000-c000-000000000000', resourceAccess: [{ id: 'df021288-bdef-4463-88db-98f22de89214', type: 'Role' }] }]);
    assert.equal(principals.find(sp => sp.appId === oidc.appId).appRoleAssignmentRequired, false);
    const graphGrants = () => [...assignments.values()].flat().filter(item => item.appRoleId === 'df021288-bdef-4463-88db-98f22de89214');
    assert.equal(graphGrants().length, 1);
    const originalSecrets = new Map(secrets);
    assert.equal(await p.run(job, async event => events.push(event)), true, JSON.stringify(events.slice(16)));
    assert.equal(applications.length, 10); assert.equal(policies.length, 1); assert.equal(locks, 1);
    assert.equal(graphGrants().length, 1);
    for (const [name, value] of originalSecrets) assert.equal(secrets.get(name), value, name);
    const inputs = await p.runtimeInputs({
      environmentId: 'env', intelligence: { provider: 'azure_foundry' }, access: {},
      foundation: { database: { host: 'test.postgres.database.azure.com', port: 5432, credentialRef: 'env:DB' }, objectStore: {} },
    });
    assert.equal(inputs.databaseUrls.discovery,
      'postgresql://migration_operator@test.postgres.database.azure.com:5432/ehf_discovery?sslmode=verify-full');
    assert.ok(Object.values(inputs.databaseUrls).every(value => new URL(value).password === ''));
    assert.equal(inputs.secrets['env:DB'], secrets.get('env-database-migrator-password'));
    assert.deepEqual(await readdir(directory), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
