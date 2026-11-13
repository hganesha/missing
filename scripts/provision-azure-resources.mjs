/** Azure resource recipe. No shell interpolation; secret request bodies use private files. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { createRequire } from 'node:module';
const pg = createRequire(new URL('../apps/launcher/package.json', import.meta.url))('pg');
import { RUNTIME_SERVICES } from '../packages/contracts/src/deployment-plan.ts';
import { RESOURCE_FAILURES } from '../packages/contracts/src/resource-provisioning.ts';
import { azureDocumentAccountId, azureTrainingContainerId, DEPLOYMENT_ROLES } from '../packages/contracts/src/deployment.ts';
import { azureTraceComponent, collectorEndpointConfigured } from './lib/azure-observability.mjs';
import { ensureEntraDirectoryPermission } from './lib/entra-directory.mjs';

const exec = promisify(execFile);
const DOCUMENT_USER = 'a97b65f3-24c7-4388-baec-2e87135dc908';
const BLOB_CONTRIBUTOR = 'ba92f5b4-2d11-453d-a403-e96b0029c9fe';
const API = { vault: '2023-07-01', postgres: '2024-08-01', storage: '2023-05-01', identity: '2023-01-31', ai: '2025-06-01', app: '2025-01-01' };
export class AzureProvisioner {
  constructor({ receipt, directory, vaultUri, consolePrincipalId, executorPrincipalId, catalog, az, postgresClient = pg.Client, check = () => {} }) {
    Object.assign(this, { receipt, directory, vaultUri, consolePrincipalId, executorPrincipalId, catalog, postgresClient, check });
    this.scope = `/subscriptions/${receipt.subscription}/resourceGroups/${receipt.resourceGroup}`;
    this.cli = az ?? (async argv => {
      try { const { stdout } = await exec('az', [...argv, '--only-show-errors', '--output', 'json'], { timeout: 1900000, maxBuffer: 10_000_000 }); return stdout.trim() ? JSON.parse(stdout) : null; }
      catch (error) { throw Object.assign(new Error(/AuthorizationFailed|Forbidden|Authorization_RequestDenied|Insufficient privileges/.test(error.stderr ?? '') ? 'permission_required' : /InsufficientQuota|QuotaExceeded|InsufficientCapacity|SpecialFeatureOrQuotaIdRequired/.test(error.stderr ?? '') ? 'quota_required' : 'azure_operation_failed'), { notFound: /ResourceNotFound|SecretNotFound|ResourceGroupNotFound|NotFound/.test(error.stderr ?? ''), roleExists: /\bRoleAssignmentExists\b/.test(error.stderr ?? '') }); }
    });
  }
  async jsonFile(value, action) {
    const path = join(this.directory, `request-${randomUUID()}.json`);
    await writeFile(path, JSON.stringify(value), { mode: 0o600 });
    try { return await action(`@${path}`); } finally { await rm(path, { force: true }); }
  }
  async rest(method, path, body) {
    this.check();
    // URLs come only from this recipe, never from an Azure response or browser profile.
    const url = new URL(path.startsWith('https://') ? path : `https://management.azure.com${path}`);
    if (!['management.azure.com', 'graph.microsoft.com'].includes(url.hostname) || url.protocol !== 'https:') throw new Error('invalid_azure_origin');
    if (url.hostname === 'management.azure.com' && !url.pathname.toLowerCase().startsWith(this.scope.toLowerCase() + '/providers/')) throw new Error('resource_scope_mismatch');
    const args = ['rest', '--method', method, '--url', url.href, '--subscription', this.receipt.subscription];
    return body === undefined ? this.cli(args) : this.jsonFile(body, file => this.cli([...args, '--body', file, '--headers', 'Content-Type=application/json']));
  }
  async optional(operation) { try { return await operation(); } catch (error) { if (error.notFound) return null; throw error; } }
  async secret(name, value) {
    const vault = new URL(this.vaultUri).hostname.split('.')[0];
    if (value === undefined) return (await this.optional(() => this.cli(['keyvault', 'secret', 'show', '--vault-name', vault, '--name', name])))?.value;
    const path = join(this.directory, `secret-${randomUUID()}`);
    await writeFile(path, value, { mode: 0o600 });
    try { await this.cli(['keyvault', 'secret', 'set', '--vault-name', vault, '--name', name, '--file', path]); } finally { await rm(path, { force: true }); }
    return value;
  }
  async stableSecret(name, create = () => randomBytes(32).toString('hex')) { return await this.secret(name) ?? await this.secret(name, await create()); }
  resource(type, name) { return `${this.scope}/providers/${type}/${name}`; }
  async ensure(id, version, body) {
    const path = `${id}?api-version=${version}`;
    const previous = await this.optional(() => this.rest('get', path));
    if (previous && (previous.tags?.['integralflow.bootstrap'] !== this.receipt.name || previous.tags?.['integralflow.environment'] !== this.profile.environmentId)) throw new Error('resource_ownership_mismatch');
    if (!previous) await this.rest('put', path, { ...body, location: this.receipt.location, tags: this.tags });
    const deadline = Date.now() + 1800000;
    while (Date.now() < deadline) {
      this.check();
      const current = await this.rest('get', path);
      const state = current.properties?.provisioningState;
      if (!state || state === 'Succeeded') {
        if (id.includes('/Microsoft.App/containerApps/') && (current.properties.runningStatus !== 'Running' || !current.properties.latestReadyRevisionName || current.properties.latestReadyRevisionName !== current.properties.latestRevisionName)) { await pause(5000); continue; }
        return current;
      }
      if (['Failed', 'Canceled'].includes(state)) throw new Error('resource_provisioning_failed');
      await pause(5000);
    }
    throw new Error('resource_provisioning_timed_out');
  }
  async role(scope, principalId, definition) {
    const name = createHash('md5').update(`${scope}/${principalId}/${definition}`).digest('hex').replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
    try {
      await this.rest('put', `${scope}/providers/Microsoft.Authorization/roleAssignments/${name}?api-version=2022-04-01`, { properties: { principalId, principalType: 'ServicePrincipal', roleDefinitionId: `/subscriptions/${this.receipt.subscription}/providers/Microsoft.Authorization/roleDefinitions/${definition}` } });
    } catch (error) {
      if (!error.roleExists) throw error;
    }
  }
  async application(suffix, properties = {}) {
    const displayName = `${this.prefix}-${suffix}`;
    const marker = `integralflow:${this.receipt.name}:${this.profile.environmentId}`;
    const found = await this.rest('get', `https://graph.microsoft.com/v1.0/applications?$filter=${encodeURIComponent(`displayName eq '${displayName}'`)}`);
    if (found.value.length > 1 || (found.value[0] && !found.value[0].tags?.includes(marker))) throw new Error('resource_ownership_mismatch');
    const app = found.value[0] ?? await this.rest('post', 'https://graph.microsoft.com/v1.0/applications', { displayName, tags: [marker], signInAudience: 'AzureADMyOrg', ...properties });
    const principals = await this.rest('get', `https://graph.microsoft.com/v1.0/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${app.appId}'`)}`);
    const principal = principals.value[0] ?? await this.rest('post', 'https://graph.microsoft.com/v1.0/servicePrincipals', { appId: app.appId, appRoleAssignmentRequired: true });
    return { app, principal };
  }
  async appSecret(application, alias) {
    return this.stableSecret(alias, async () => (await this.rest('post', `https://graph.microsoft.com/v1.0/applications/${application.id}/addPassword`, { passwordCredential: { displayName: 'IntegralFlow installer', endDateTime: new Date(Date.now() + 90 * 86400000).toISOString() } })).secretText);
  }
  async assign(principal, resource, appRoleId) {
    const assignments = await this.rest('get', `https://graph.microsoft.com/v1.0/servicePrincipals/${resource}/appRoleAssignedTo`);
    if (!assignments.value.some(item => item.principalId === principal && item.appRoleId === appRoleId)) await this.rest('post', `https://graph.microsoft.com/v1.0/servicePrincipals/${resource}/appRoleAssignedTo`, { principalId: principal, resourceId: resource, appRoleId });
  }
  async context() {
    if (this.azureContext) return this.azureContext;
    const consoleApp = await this.rest('get', `${this.resource('Microsoft.App/containerApps', this.receipt.name)}?api-version=${API.app}`);
    const environmentId = consoleApp.properties.managedEnvironmentId;
    const environment = await this.rest('get', `${environmentId}?api-version=${API.app}`);
    const registry = consoleApp.properties.configuration.registries.find(item => this.receipt.image.startsWith(item.server + '/'));
    if (!registry) throw new Error('image_pull_identity_missing');
    return this.azureContext = { environmentId, defaultDomain: environment.properties.defaultDomain, registry };
  }
  async internalApp(name, image, port, env, secrets, args = []) {
    if (!/^.+@sha256:[a-f0-9]{64}$/.test(image ?? '')) throw new Error('pinned_dependency_image_required');
    const context = await this.context();
    const id = this.resource('Microsoft.App/containerApps', name);
    const service = await this.ensure(id, API.app, { identity: { type: 'UserAssigned', userAssignedIdentities: { [context.registry.identity]: {} } }, properties: { managedEnvironmentId: context.environmentId, configuration: { activeRevisionsMode: 'Single', ingress: { external: false, targetPort: port, transport: 'http', allowInsecure: false }, registries: [context.registry], secrets: Object.entries(secrets).map(([name, value]) => ({ name, value })) }, template: { containers: [{ name: 'service', image, args, env: [...Object.entries(env).map(([name, value]) => ({ name, value })), ...Object.keys(secrets).map(name => ({ name: name.toUpperCase().replaceAll('-', '_'), secretRef: name }))], resources: { cpu: 0.5, memory: '1Gi' }, probes: [{ type: 'Readiness', tcpSocket: { port }, periodSeconds: 10, failureThreshold: 6 }] }], scale: { minReplicas: 1, maxReplicas: 1 } } } });
    return { resourceId: id, endpoint: `https://${service.properties.configuration.ingress.fqdn}` };
  }
  async documentAccount(id) {
    if (!azureDocumentAccountId.safeParse(id).success || !id.toLowerCase().startsWith(this.scope.toLowerCase() + '/providers/')) throw new Error('resource_type_or_scope_mismatch');
    const account = await this.rest('get', `${id}?api-version=${API.ai}`);
    const name = account.properties?.customSubDomainName;
    if (account.kind !== 'FormRecognizer' || account.properties?.provisioningState !== 'Succeeded' || !/^[a-z0-9-]{2,64}$/.test(name ?? '')) throw new Error('document_account_incompatible');
    return { account, endpoint: `https://${name}.cognitiveservices.azure.com` };
  }
  async documentRuntime(settings, identityName) {
    const { account, endpoint } = await this.documentAccount(settings.resourceId);
    const identityId = this.resource('Microsoft.ManagedIdentity/userAssignedIdentities', `${identityName}-documents`);
    const { properties: identity } = await this.ensure(identityId, API.identity, {});
    if (!identity?.clientId || !identity.principalId) throw new Error('deployment.document_identity_required');
    await this.role(settings.resourceId.toLowerCase(), identity.principalId, DOCUMENT_USER);
    let workerIdentity;
    if (settings.factory) {
      const id = this.resource('Microsoft.ManagedIdentity/userAssignedIdentities', `${identityName}-factory`);
      const { properties } = await this.ensure(id, API.identity, {});
      if (!properties?.clientId || !properties.principalId) throw new Error('deployment.document_identity_required');
      await this.role(settings.resourceId.toLowerCase(), properties.principalId, DOCUMENT_USER);
      workerIdentity = { id, clientId: properties.clientId, principalId: properties.principalId };
    }
    let trainingContainerUrl;
    if (settings.factory && settings.trainingContainerId) {
      const id = settings.trainingContainerId.toLowerCase();
      if (!azureTrainingContainerId.safeParse(id).success || !id.startsWith(this.scope.toLowerCase() + '/providers/')) throw new Error('resource_type_or_scope_mismatch');
      const parts = id.split('/');
      const { properties } = await this.rest('get', `${id}?api-version=${API.storage}`);
      const storageAccountId = parts.slice(0, -4).join('/');
      const { properties: storage } = await this.rest('get', `${storageAccountId}?api-version=${API.storage}`);
      if (!storage?.supportsHttpsTrafficOnly) throw new Error('deployment.document_training_container_incompatible');
      const evidenceUrl = this.profile.foundation.objectStore.endpoint;
      const sameEvidence = evidenceUrl && new URL(evidenceUrl).hostname.split('.')[0] === parts.at(-5) && this.profile.foundation.objectStore.bucket === parts.at(-1);
      if (sameEvidence || properties?.publicAccess && properties.publicAccess !== 'None') throw new Error('deployment.document_training_container_incompatible');
      if (account.sku?.name !== 'S0' || !account.identity?.principalId) throw new Error('deployment.document_training_identity_required');
      await this.role(id, workerIdentity.principalId, BLOB_CONTRIBUTOR);
      await this.role(id, account.identity.principalId, BLOB_CONTRIBUTOR);
      trainingContainerUrl = `https://${parts.at(-5)}.blob.core.windows.net/${parts.at(-1)}`;
    }
    return { endpoint, identityId, clientId: identity.clientId,
      ...(workerIdentity ? { workerIdentity: { id: workerIdentity.id, clientId: workerIdentity.clientId } } : {}),
      ...(trainingContainerUrl ? { trainingContainerUrl } : {}) };
  }
  async create(kind) {
    const c = this.configuration;
    if (kind === 'keyVault') {
      const id = this.resource('Microsoft.KeyVault/vaults', new URL(this.vaultUri).hostname.split('.')[0]);
      const vault = await this.rest('get', `${id}?api-version=${API.vault}`);
      if (!vault.properties.enableRbacAuthorization || !vault.properties.enablePurgeProtection || vault.properties.tenantId !== c.tenantId) throw new Error('vault_configuration_incompatible');
      return { resourceId: id, vaultUri: this.vaultUri };
    }
    if (kind === 'postgres') {
      const password = await this.stableSecret(`${this.secretPrefix}-database-migrator-password`);
      const id = this.resource('Microsoft.DBforPostgreSQL/flexibleServers', `${this.prefix}-pg`);
      const server = await this.ensure(id, API.postgres, { sku: { name: 'Standard_B2s', tier: 'Burstable' }, properties: { version: '17', administratorLogin: 'migration_operator', administratorLoginPassword: password, storage: { storageSizeGB: 32 }, backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }, highAvailability: { mode: 'Disabled' }, network: { publicNetworkAccess: 'Enabled' } } });
      for (const [name, value] of [['azure.extensions', 'age,vector'], ['shared_preload_libraries', 'pg_cron,pg_stat_statements,age']]) await this.rest('put', `${id}/configurations/${name}?api-version=${API.postgres}`, { properties: { value, source: 'user-override' } });
      // This public test recipe requires explicit review; private networking is a separate recipe.
      if (!c.allowAzureDatabaseAccess) throw new Error('database_network_approval_required');
      await this.rest('put', `${id}/firewallRules/integralflow-azure?api-version=${API.postgres}`, { properties: { startIpAddress: '0.0.0.0', endIpAddress: '0.0.0.0' } });
      for (const name of ['control', 'case', 'context']) await this.rest('put', `${id}/databases/integralflow_${name}?api-version=${API.postgres}`, { properties: { charset: 'UTF8', collation: 'en_US.utf8' } });
      const preload = await this.rest('get', `${id}/configurations/shared_preload_libraries?api-version=${API.postgres}`);
      if (preload.properties.isConfigPendingRestart === true || preload.properties.isConfigPendingRestart === 'True') await this.cli(['postgres', 'flexible-server', 'restart', '--ids', id, '--subscription', this.receipt.subscription]);
      const host = server.properties.fullyQualifiedDomainName;
      const client = new this.postgresClient({ host, port: 5432, user: 'migration_operator', password, database: 'integralflow_context', ssl: { rejectUnauthorized: true }, connectionTimeoutMillis: 30000 });
      await client.connect();
      try { await client.query('create extension if not exists vector'); await client.query('create extension if not exists age'); await client.query('alter database integralflow_context set search_path = ag_catalog, pg_catalog, public'); } finally { await client.end(); }
      return { resourceId: id, hostname: host, credentialRef: 'env:DATABASE_MIGRATOR_PASSWORD' };
    }
    if (kind === 'managedIdentities') {
      const id = this.resource('Microsoft.ManagedIdentity/userAssignedIdentities', `${this.prefix}-runtime`);
      const identity = await this.ensure(id, API.identity, {});
      const roleId = createHash('md5').update(`${this.prefix}/Runtime.Access`).digest('hex').replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5');
      const api = await this.application('runtime-api', { api: { requestedAccessTokenVersion: 2 }, appRoles: [{ id: roleId, value: 'Runtime.Access', displayName: 'Runtime access', description: 'IntegralFlow runtime services', isEnabled: true, allowedMemberTypes: ['Application'] }] });
      const audience = api.app.appId;
      const scopeAudience = `api://${audience}`;
      if (!api.app.identifierUris?.includes(scopeAudience)) await this.rest('patch', `https://graph.microsoft.com/v1.0/applications/${api.app.id}`, { identifierUris: [scopeAudience] });
      const policies = await this.rest('get', `https://graph.microsoft.com/v1.0/applications/${api.app.id}/tokenLifetimePolicies`);
      if (!policies.value.length) {
        const policy = await this.rest('post', 'https://graph.microsoft.com/v1.0/policies/tokenLifetimePolicies', { displayName: `${this.prefix}-runtime-10min`, isOrganizationDefault: false, definition: [JSON.stringify({ TokenLifetimePolicy: { Version: 1, AccessTokenLifetime: '00:10:00' } })] });
        await this.rest('post', `https://graph.microsoft.com/v1.0/applications/${api.app.id}/tokenLifetimePolicies/$ref`, { '@odata.id': `https://graph.microsoft.com/v1.0/policies/tokenLifetimePolicies/${policy.id}` });
      } else if (!policies.value.some(policy => policy.isOrganizationDefault === false && policy.definition.some(value => JSON.parse(value).TokenLifetimePolicy?.AccessTokenLifetime === '00:10:00'))) throw new Error('runtime_token_policy_incompatible');
      const clients = {};
      const documentServices = this.profile.intelligence.documentServices;
      const identities = new Set([...RUNTIME_SERVICES.map(service => service.identity), ...(documentServices ? ['skill-host'] : []), ...(documentServices?.azure?.factory ? ['document-factory-worker'] : [])]);
      for (const identity of identities) {
        const client = await this.application(identity);
        await this.appSecret(client.app, `${this.secretPrefix}-workload-${identity}`);
        await this.assign(client.principal.id, api.principal.id, roleId);
        clients[identity] = { clientId: client.app.appId, subject: client.principal.id, secretRef: `env:WORKLOAD_${identity.toUpperCase().replaceAll('-', '_')}`, scope: `${scopeAudience}/.default` };
      }
      const issuer = `https://login.microsoftonline.com/${c.tenantId}/v2.0`;
      await this.secret(`${this.secretPrefix}-workload-bindings`, JSON.stringify({ issuer, audience, tokenEndpoint: `https://login.microsoftonline.com/${c.tenantId}/oauth2/v2.0/token`, jwksUri: `https://login.microsoftonline.com/${c.tenantId}/discovery/v2.0/keys`, clients }));
      return { resourceId: id, clientId: identity.properties.clientId };
    }
    if (kind === 'evidence') {
      if (!c.acknowledgeRetentionLock) throw new Error('retention_lock_approval_required');
      const accountName = `if${createHash('sha256').update(this.prefix).digest('hex').slice(0, 20)}`;
      const id = this.resource('Microsoft.Storage/storageAccounts', accountName);
      const account = await this.ensure(id, API.storage, { kind: 'StorageV2', sku: { name: 'Standard_LRS' }, properties: { isHnsEnabled: true, allowBlobPublicAccess: false, allowSharedKeyAccess: false, minimumTlsVersion: 'TLS1_2', supportsHttpsTrafficOnly: true } });
      if (!account.properties.isHnsEnabled || account.properties.allowSharedKeyAccess !== false) throw new Error('evidence_configuration_incompatible');
      const container = `${id}/blobServices/default/containers/evidence`;
      const previous = await this.optional(() => this.rest('get', `${container}?api-version=${API.storage}`));
      if (!previous) await this.rest('put', `${container}?api-version=${API.storage}`, { properties: { publicAccess: 'None' } });
      const policyPath = `${container}/immutabilityPolicies/default?api-version=${API.storage}`;
      let policy = await this.optional(() => this.rest('get', policyPath));
      if (policy?.properties.state === 'Locked' && policy.properties.immutabilityPeriodSinceCreationInDays !== c.retentionDays) throw new Error('locked_retention_mismatch');
      if (policy?.properties.state !== 'Locked') {
        policy = await this.rest('put', policyPath, { properties: { immutabilityPeriodSinceCreationInDays: c.retentionDays } });
        await this.cli(['rest', '--method', 'post', '--url', `https://management.azure.com${container}/immutabilityPolicies/default/lock?api-version=${API.storage}`, '--headers', `If-Match=${policy.etag}`]);
      }
      policy = await this.rest('get', policyPath);
      if (policy.properties.state !== 'Locked') throw new Error('retention_not_locked');
      const credential = await this.application('evidence');
      const clientSecret = await this.appSecret(credential.app, `${this.secretPrefix}-evidence-client`);
      await this.role(container, credential.principal.id, 'ba92f5b4-2d11-453d-a403-e96b0029c9fe');
      await this.role(id, credential.principal.id, 'acdd72a7-3385-48ef-bd42-f606fba81ae7');
      await this.secret(`${this.secretPrefix}-object-storage-credential`, JSON.stringify({ tenantId: c.tenantId, clientId: credential.app.appId, clientSecret, subscriptionId: this.receipt.subscription, resourceGroup: this.receipt.resourceGroup }));
      return { resourceId: id, endpoint: `https://${accountName}.dfs.core.windows.net`, container: 'evidence', credentialRef: 'env:OBJECT_STORAGE_CREDENTIAL' };
    }
    if (kind === 'foundry') {
      const name = `${this.prefix}-ai`;
      const id = this.resource('Microsoft.CognitiveServices/accounts', name);
      await this.ensure(id, API.ai, { kind: 'AIServices', sku: { name: 'S0' }, properties: { customSubDomainName: name, publicNetworkAccess: 'Enabled' } });
      for (const [tier, modelId] of Object.entries(this.profile.intelligence.models)) {
        const model = this.catalog.models.find(item => item.id === modelId)?.providers.azure_foundry;
        if (!model || !/^[a-zA-Z0-9._-]+$/.test(model)) throw new Error('curated_model_required');
        const deployment = `${id}/deployments/${this.profile.environmentId}-${tier}?api-version=${API.ai}`;
        const existing = await this.optional(() => this.rest('get', deployment));
        if (existing && (existing.properties.model.name !== model || existing.properties.model.version !== c.modelVersion || existing.sku.name !== 'GlobalStandard' || existing.sku.capacity !== c.modelCapacity)) throw new Error('model_deployment_configuration_changed');
        if (!existing) await this.rest('put', deployment, { sku: { name: 'GlobalStandard', capacity: c.modelCapacity }, properties: { model: { format: 'OpenAI', name: model, version: c.modelVersion }, versionUpgradeOption: 'NoAutoUpgrade' } });
      }
      for (const tier of Object.keys(this.profile.intelligence.models)) {
        const path = `${id}/deployments/${this.profile.environmentId}-${tier}?api-version=${API.ai}`;
        const deadline = Date.now() + 600000;
        while (true) { this.check(); const deployment = await this.rest('get', path); if (deployment.properties.provisioningState === 'Succeeded') break; if (['Failed', 'Canceled'].includes(deployment.properties.provisioningState) || Date.now() > deadline) throw new Error('model_deployment_failed'); await pause(5000); }
      }
      const keys = await this.rest('post', `${id}/listKeys?api-version=${API.ai}`);
      await this.secret(`${this.secretPrefix}-model-provider-token`, keys.key1);
      return { resourceId: id, endpoint: `https://${name}.services.ai.azure.com/openai/v1`, credentialRef: 'env:MODEL_PROVIDER_TOKEN' };
    }
    if (kind === 'documents') {
      const native = this.profile.intelligence.documentServices?.azure;
      if (this.profile.intelligence.documentServices && !native) return {};
      const name = `${this.prefix}-documents-ai`;
      const id = this.resource('Microsoft.CognitiveServices/accounts', name);
      await this.ensure(id, API.ai, { kind: 'FormRecognizer', sku: { name: 'S0' }, identity: { type: 'SystemAssigned' }, properties: { customSubDomainName: name, publicNetworkAccess: 'Enabled' } });
      if (native) {
        const { endpoint } = await this.documentAccount(id);
        return { resourceId: id, documentAccountId: id, endpoint };
      }
      // The account is kept for the document.analysis.v1 layout adapter (managed identity, no key). The evidence
      // pipeline parses natively and reads no Azure setting, so it receives no Azure endpoint, parser or key.
      const token = await this.stableSecret(`${this.secretPrefix}-document-intelligence-token`);
      const output = await this.internalApp(`${this.prefix}-documents`, this.receipt.documentImage, 8080, { EVIDENCE_PIPELINE_DATA_DIR: '/tmp/documents', EVIDENCE_ALLOW_REMOTE_SENSITIVE_DATA: 'true' }, { 'evidence-pipeline-token': token });
      return { ...output, credentialRef: 'env:DOCUMENT_INTELLIGENCE_TOKEN' };
    }
    if (kind === 'telemetry') return this.azureMonitorTelemetry(c.resources.telemetry);
    if (kind === 'oidc') {
      const context = await this.context();
      const applicationName = `${this.receipt.name.slice(0, 14)}-${createHash('sha256').update(this.receipt.name).digest('hex').slice(0, 4)}-web`;
      const roles = DEPLOYMENT_ROLES.map(value => ({ id: createHash('md5').update(`${this.prefix}/${value}`).digest('hex').replace(/^(........)(....)(....)(....)(............)$/, '$1-$2-$3-$4-$5'), value, displayName: value, description: value, isEnabled: true, allowedMemberTypes: ['User'] }));
      const oidc = await this.application('oidc', { web: { redirectUris: [`${new URL(this.receipt.url).origin}/auth/setup/callback`, `https://${applicationName}.${context.defaultDomain}/auth/callback`] }, appRoles: roles });
      const existingRoles = oidc.app.appRoles ?? [];
      const missingRoles = roles.filter(role => !existingRoles.some(existing => existing.value === role.value));
      if (existingRoles.length && missingRoles.length) {
        await this.rest('patch', `https://graph.microsoft.com/v1.0/applications/${oidc.app.id}`, { appRoles: [...existingRoles, ...missingRoles] });
      }
      await ensureEntraDirectoryPermission({ rest: (method, path, body) => this.rest(method.toLowerCase(), `https://graph.microsoft.com/v1.0/${path}`, body), applicationId: oidc.app.id, principalId: oidc.principal.id, grant: true });
      // Imported users receive their roles in the platform directory after OIDC sign-in.
      if (oidc.principal.appRoleAssignmentRequired !== false) await this.rest('patch', `https://graph.microsoft.com/v1.0/servicePrincipals/${oidc.principal.id}`, { appRoleAssignmentRequired: false });
      await this.appSecret(oidc.app, `${this.secretPrefix}-oidc-client-secret`);
      await this.assign(c.administratorObjectId, oidc.principal.id, (existingRoles.find(role => role.value === 'Platform.Admin') ?? roles.find(role => role.value === 'Platform.Admin')).id);
      return { endpoint: `https://login.microsoftonline.com/${c.tenantId}/v2.0`, clientId: oidc.app.appId, credentialRef: 'env:OIDC_CLIENT_SECRET' };
    }
    throw new Error('unsupported_resource');
  }
  async azureMonitorTelemetry(selection) {
    const requested = this.profile.foundation.observability;
    if (requested?.backend === 'otlp') throw new Error('telemetry_collector_required');
    const id = selection.resourceId || requested?.applicationInsightsResourceId || this.receipt.applicationInsightsResourceId;
    if (!id) throw new Error('existing_resource_id_required');
    const { insights } = await azureTraceComponent(this.rest.bind(this), this.scope, id);
    if (selection.mode === 'manual') {
      const endpoint = this.profile.foundation.telemetryEndpoint;
      if (!collectorEndpointConfigured(endpoint)) throw new Error('telemetry_collector_required');
      return { resourceId: id, applicationInsightsResourceId: id, endpoint };
    }
    if (insights.properties?.DisableLocalAuth === true) throw new Error('telemetry_authenticated_collector_required');
    if (id.toLowerCase() === this.receipt.applicationInsightsResourceId?.toLowerCase() && this.receipt.telemetryEndpoint) {
      const collectorId = this.resource('Microsoft.App/containerApps', `${this.receipt.name}-otel`);
      const collector = await this.rest('get', `${collectorId}?api-version=${API.app}`);
      const context = await this.context();
      if (collector.properties?.managedEnvironmentId?.toLowerCase() !== context.environmentId.toLowerCase()
        || collector.properties.configuration?.ingress?.external !== false
        || collector.properties.configuration.ingress.allowInsecure !== false
        || collector.tags?.['integralflow.trace-destination']?.toLowerCase() !== id.toLowerCase()
        || collector.properties.runningStatus !== 'Running'
        || !collector.properties.latestReadyRevisionName || collector.properties.latestReadyRevisionName !== collector.properties.latestRevisionName) throw new Error('existing_resource_not_ready');
      return { resourceId: id, applicationInsightsResourceId: id, endpoint: this.receipt.telemetryEndpoint };
    }
    if (selection.mode === 'existing') throw new Error('telemetry_collector_required');
    const connectionString = insights.properties?.ConnectionString;
    if (typeof connectionString !== 'string' || !connectionString.startsWith('InstrumentationKey=')) throw new Error('telemetry_component_incompatible');
    const configuration = await readFile(new URL('../deploy/azure/azure-monitor-collector.yml', import.meta.url), 'utf8');
    const suffix = createHash('sha256').update(id.toLowerCase()).digest('hex').slice(0, 6);
    const output = await this.internalApp(`${this.prefix.slice(0, 18)}-otel-${suffix}`, this.receipt.collectorImage, 4318,
      { OTEL_COLLECTOR_CONFIGURATION: configuration }, { 'applicationinsights-connection-string': connectionString }, ['--config=env:OTEL_COLLECTOR_CONFIGURATION']);
    return { ...output, resourceId: id, applicationInsightsResourceId: id };
  }
  async verify(kind, selection) {
    if (kind === 'telemetry' && this.profile.foundation.observability?.backend === 'azure_monitor') return this.azureMonitorTelemetry(selection);
    if (kind === 'keyVault') { if (selection.resourceId && selection.resourceId.toLowerCase() !== this.resource('Microsoft.KeyVault/vaults', new URL(this.vaultUri).hostname.split('.')[0]).toLowerCase()) throw new Error('resource_type_or_scope_mismatch'); return this.create(kind); }
    if (!selection.resourceId) throw new Error('existing_resource_id_required');
    if (kind === 'oidc') {
      const result = await this.rest('get', `https://graph.microsoft.com/v1.0/applications?$filter=${encodeURIComponent(`appId eq '${selection.resourceId}'`)}`);
      if (result.value.length !== 1 || result.value[0].signInAudience !== 'AzureADMyOrg') throw new Error('oidc_application_incompatible');
      if (this.profile.access.clientId !== selection.resourceId || !this.profile.access.clientSecretRef) throw new Error('existing_profile_binding_required');
      const issuer = `https://login.microsoftonline.com/${this.configuration.tenantId}/v2.0`;
      if (this.profile.access.issuer !== issuer) throw new Error('existing_profile_binding_required');
      const principals = await this.rest('get', `https://graph.microsoft.com/v1.0/servicePrincipals?$filter=${encodeURIComponent(`appId eq '${selection.resourceId}'`)}`);
      if (principals.value.length !== 1) throw new Error('oidc_application_incompatible');
      await ensureEntraDirectoryPermission({ rest: (method, path, body) => this.rest(method.toLowerCase(), `https://graph.microsoft.com/v1.0/${path}`, body), applicationId: result.value[0].id, principalId: principals.value[0].id });
      if (principals.value[0].appRoleAssignmentRequired) throw new Error('directory_assignment_required');
      return { clientId: selection.resourceId, endpoint: issuer };
    }
    if (kind === 'documents' && this.profile.intelligence.documentServices?.azure) {
      const { endpoint } = await this.documentAccount(selection.resourceId);
      return { resourceId: selection.resourceId, documentAccountId: selection.resourceId, endpoint };
    }
    const expected = { postgres: ['Microsoft.DBforPostgreSQL/flexibleServers', API.postgres], evidence: ['Microsoft.Storage/storageAccounts', API.storage], managedIdentities: ['Microsoft.ManagedIdentity/userAssignedIdentities', API.identity], foundry: ['Microsoft.CognitiveServices/accounts', API.ai], documents: ['Microsoft.App/containerApps', API.app], telemetry: ['Microsoft.App/containerApps', API.app] }[kind];
    if (!selection.resourceId.toLowerCase().startsWith(`${this.scope}/providers/${expected[0]}/`.toLowerCase())) throw new Error('resource_type_or_scope_mismatch');
    const resource = await this.rest('get', `${selection.resourceId}?api-version=${expected[1]}`);
    if (resource.properties.provisioningState && resource.properties.provisioningState !== 'Succeeded') throw new Error('existing_resource_not_ready');
    if (kind === 'postgres' && (!this.profile.foundation.database.credentialRef || this.profile.foundation.database.host !== resource.properties.fullyQualifiedDomainName)) throw new Error('existing_profile_binding_required');
    if (kind === 'evidence') { const policy = await this.rest('get', `${selection.resourceId}/blobServices/default/containers/${this.profile.foundation.objectStore.bucket}/immutabilityPolicies/default?api-version=${API.storage}`); if (!resource.properties.isHnsEnabled || policy.properties.state !== 'Locked' || !this.profile.foundation.objectStore.credentialRef) throw new Error('evidence_configuration_incompatible'); }
    if (kind === 'foundry') {
      const name = resource.properties.customSubDomainName ?? resource.name;
      const endpoints = ['services.ai.azure.com', 'openai.azure.com', 'cognitiveservices.azure.com'].map(domain => `https://${name}.${domain}/openai/v1`);
      if (!endpoints.includes(this.profile.intelligence.endpoint.replace(/\/$/, '')) || !this.profile.intelligence.credentialRef) throw new Error('existing_profile_binding_required');
      return { resourceId: selection.resourceId, endpoint: this.profile.intelligence.endpoint };
    }
    if (kind === 'documents' || kind === 'telemetry') {
      const endpoint = `https://${resource.properties.configuration?.ingress?.fqdn}`;
      const configured = kind === 'documents' ? this.profile.intelligence.documentIntelligence?.endpoint : this.profile.foundation.telemetryEndpoint;
      if (configured !== endpoint) throw new Error('existing_profile_binding_required');
      return { resourceId: selection.resourceId, endpoint };
    }
    return { resourceId: selection.resourceId };
  }
  async run(job, report) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    this.profile = job.profile; this.configuration = job.configuration;
    if (job.scopeId.toLowerCase() !== this.scope.toLowerCase() || job.image !== this.receipt.image || job.profile.target.region !== this.receipt.location) throw new Error('bootstrap_scope_mismatch');
    const suffix = createHash('sha256').update(`${this.scope}/${this.receipt.name}/${job.profile.environmentId}`).digest('hex').slice(0, 8);
    this.prefix = `if-${this.receipt.name.slice(0, 10).replace(/-+$/, '')}-${suffix}`;
    this.secretPrefix = job.profile.environmentId;
    this.tags = { 'integralflow.bootstrap': this.receipt.name, 'integralflow.environment': job.profile.environmentId, 'integralflow.recipe': 'azure-resources-v1' };
    let failed = false;
    for (const kind of ['keyVault', 'postgres', 'managedIdentities', 'evidence', 'foundry', 'documents', 'telemetry', 'oidc']) {
      this.check();
      await report({ kind, status: 'running', message: 'Creating or reconciling resource' });
      try {
        const selection = job.configuration.resources[kind];
        const docs = this.profile.intelligence;
        const skipDocuments = kind === 'documents' && selection.mode === 'existing' && !selection.resourceId && !docs.documentIntelligence?.endpoint && !docs.documentServices?.azure?.resourceId && !docs.documentServices?.azure;
        const selected = kind === 'documents' && !selection.resourceId && docs.documentServices?.azure?.resourceId ? { ...selection, resourceId: docs.documentServices.azure.resourceId } : selection;
        const output = skipDocuments ? undefined : selected.mode === 'create' ? await this.create(kind) : await this.verify(kind, selected);
        await report({ kind, status: 'passed', message: 'Resource verified', output });
      } catch (error) {
        failed = true;
        const permissionRequired = ['permission_required', 'directory_permission_required', 'directory_assignment_required'].includes(error.message);
        await report({ kind, code: Object.hasOwn(RESOURCE_FAILURES, error.message) ? error.message : 'azure_operation_failed', status: permissionRequired ? 'waiting' : 'failed', message: permissionRequired ? 'Permission required; follow the manual instructions or grant the executor access' : 'Resource operation failed; existing resources retained' });
        // No downstream writes after a failed dependency. Retry reconciles the same names.
        break;
      }
    }
    return !failed;
  }
  async runtimeInputs(profile) {
    const prefix = profile.environmentId;
    let workload = JSON.parse(await this.secret(`${prefix}-workload-bindings`) ?? 'null');
    const required = profile.intelligence.documentServices ? ['skill-host', ...(profile.intelligence.documentServices.azure?.factory ? ['document-factory-worker'] : [])] : [];
    if (required.some(identity => !workload?.clients?.[identity]) && this.configuration.resources.managedIdentities.mode === 'create') {
      this.profile = profile;
      const suffix = createHash('sha256').update(`${this.scope}/${this.receipt.name}/${prefix}`).digest('hex').slice(0, 8);
      this.prefix = `if-${this.receipt.name.slice(0, 10).replace(/-+$/, '')}-${suffix}`;
      this.secretPrefix = prefix;
      this.tags = { 'integralflow.bootstrap': this.receipt.name, 'integralflow.environment': prefix, 'integralflow.recipe': 'azure-resources-v1' };
      await this.create('managedIdentities');
      workload = JSON.parse(await this.secret(`${prefix}-workload-bindings`) ?? 'null');
    }
    if (!workload) throw new Error('runtime_workload_bindings_required');
    const secrets = {};
    for (const [reference, name] of [[profile.foundation.database.credentialRef, 'database-migrator-password'], [profile.foundation.objectStore.credentialRef, 'object-storage-credential'], [profile.intelligence.credentialRef, 'model-provider-token'], [profile.access.clientSecretRef, 'oidc-client-secret'], [profile.intelligence.documentIntelligence?.credentialRef, 'document-intelligence-token']]) {
      if (!reference) continue;
      const value = await this.secret(`${prefix}-${name}`);
      if (!value) throw new Error('vault_credential_binding_required');
      secrets[reference] = value;
    }
    for (const [name, client] of Object.entries(workload.clients)) secrets[client.secretRef] = await this.secret(`${prefix}-workload-${name}`);
    const databaseUrl = name => `postgresql://migration_operator@${profile.foundation.database.host}:${profile.foundation.database.port}/${name}?sslmode=verify-full`;
    const databaseUrls = Object.fromEntries(['control', 'case', 'context'].map(store => [store, databaseUrl(`integralflow_${store}`)]));
    if (profile.intelligence.provider === 'azure_foundry') databaseUrls.discovery = databaseUrl('ehf_discovery');
    const hostedServices = profile.intelligence.documentServices ? { skillHost: {} } : undefined;
    if (hostedServices && !profile.intelligence.documentIntelligence?.endpoint) {
      secrets.EVIDENCE_PIPELINE_TOKEN = await this.stableSecret(`${prefix}-evidence-pipeline-token`);
      secrets.EVIDENCE_PIPELINE_DATA_KEY = await this.stableSecret(`${prefix}-evidence-pipeline-data-key`, () => randomBytes(32).toString('base64'));
      hostedServices.evidencePipeline = { tokenRef: 'env:EVIDENCE_PIPELINE_TOKEN', dataKeyRef: 'env:EVIDENCE_PIPELINE_DATA_KEY' };
    }
    let foundryTraceQualification;
    if (profile.foundation.observability?.backend === 'azure_monitor' && profile.foundation.observability.foundry) {
      try {
        const stored = await this.secret(`${prefix}-foundry-trace-qualification`);
        if (stored) foundryTraceQualification = JSON.parse(stored);
      } catch { /* Unavailable or malformed evidence leaves native Foundry disabled. */ }
    }
    return { ...(hostedServices ? { hostedServices } : {}), ...(foundryTraceQualification ? { foundryTraceQualification } : {}), tenantId: this.configuration.tenantId, monthlyLimitUsd: this.configuration.monthlyLimitUsd, databaseUrls, secrets, workload, identityAllowedOrigins: ['https://login.microsoftonline.com'] };
  }
}
