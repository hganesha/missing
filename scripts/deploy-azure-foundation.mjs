// The Azure foundation around the bootstrap (deploy/README.md, "Azure foundation"):
//   plan      what `apply` would create; reads the account only
//   apply     network, registry, key vault, logs, evidence storage, model services and the
//             PostgreSQL host (deploy/azure/foundation.bicep); secrets are generated into
//             the key vault and never printed
//   identity  the directory applications the runtime signs in with (run after
//             `pnpm deploy:azure apply`, which gives the console and application origins)
//   inputs    writes the private runtime inputs and bootstrap secrets files, outside the
//             repository, from the key vault
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DEPLOYMENT_ROLES } from '../packages/contracts/src/deployment.ts';
import { RUNTIME_SERVICES } from '../packages/contracts/src/deployment-plan.ts';
import { azureApplicationName } from '../apps/launcher/src/recipes/azure.ts';
import { ensureEntraDirectoryPermission } from './lib/entra-directory.mjs';
import { collectorRepository, collectorSource, collectorTag } from './lib/azure-collector-image.mjs';

const FLAGS = { '--resource-group': 'value', '--location': 'value', '--name': 'value', '--subscription': 'value', '--registry-sku': 'value', '--database-vm-size': 'value',
  '--operator-object-id': 'value', '--model-deployments': 'value', '--out': 'value', '--tenant': 'value', '--monthly-limit': 'value',
  '--no-models': 'switch', '--document-intelligence': 'switch', '--no-purge-protection': 'switch', '--dev-auto-approve-skill-bundle': 'switch' };
const args = process.argv.slice(2);
const command = args.shift() ?? 'plan';
if (!['plan', 'apply', 'identity', 'inputs'].includes(command)) throw new Error(`Usage: node scripts/deploy-azure-foundation.mjs plan|apply|identity|inputs ${Object.keys(FLAGS).map(flag => `[${flag}${FLAGS[flag] === 'value' ? ' VALUE' : ''}]`).join(' ')}`);
const values = {};
while (args.length) {
  const flag = args.shift();
  if (!FLAGS[flag]) throw new Error(`Invalid argument: ${flag}`);
  if (FLAGS[flag] === 'switch') { values[flag.slice(2)] = true; continue; }
  const value = args.shift();
  if (!value || value.startsWith('--')) throw new Error(`Invalid argument: ${flag}`);
  values[flag.slice(2)] = value;
}
const resourceGroup = values['resource-group'] ?? 'rg-integralflow-bootstrap';
const name = values.name ?? 'integralflow';
const location = values.location ?? 'centralus';
const registrySku = values['registry-sku'] ?? 'Basic';
// The name is also a DNS label and prefixes resource names with their own length limits.
if (!/^[a-z][a-z0-9-]{1,17}$/.test(name) || name.endsWith('-') || name.includes('--') || !/^[a-zA-Z0-9_.()-]{1,80}$/.test(resourceGroup) || resourceGroup.endsWith('.') || !/^[a-z0-9]+$/.test(location) || !['Basic', 'Standard', 'Premium'].includes(registrySku)) throw new Error('Invalid deployment name (at most 18 characters here), resource group, region or registry SKU');

function run(argv, { json = true, tolerate = false } = {}) {
  const result = spawnSync('az', [...argv, ...(json ? ['--output', 'json'] : []), '--only-show-errors'], { encoding: 'utf8', stdio: ['ignore', 'pipe', tolerate ? 'ignore' : 'inherit'], maxBuffer: 30_000_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) { if (tolerate) return undefined; throw new Error(`Azure command failed: ${argv.slice(0, 3).join(' ')}`); }
  return json ? (result.stdout.trim() ? JSON.parse(result.stdout) : null) : result.stdout.trim();
}
const az = argv => run(argv);
const azTry = argv => run(argv, { tolerate: true });
const account = az(['account', 'show', ...(values.subscription ? ['--subscription', values.subscription] : [])]);
const scope = ['--subscription', account.id];
const suffix = createHash('sha256').update(`${account.id}/${resourceGroup}/${name}`).digest('hex').slice(0, 12);
const registryName = `if${suffix}`;
const registryHost = `${registryName}.azurecr.io`;
const directory = resolve('.integralflow/azure', resourceGroup);
const databaseHost = `postgres.${name}.internal`;
const receipt = async file => JSON.parse(await readFile(join(directory, file), 'utf8').catch(() => { throw new Error(`Missing ${file}: run the earlier deployment step first`); }));
const record = async (file, value) => { await mkdir(directory, { recursive: true, mode: 0o700 }); await writeFile(join(directory, file), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); };

/** A scratch directory for secret material on its way into the vault; removed afterwards. */
async function withScratch(work) {
  const scratch = await mkdtemp(join(tmpdir(), 'integralflow-foundation-'));
  try { return await work(scratch); } finally { await rm(scratch, { recursive: true, force: true }); }
}
const hasSecret = (vault, secret) => Boolean(azTry(['keyvault', 'secret', 'show', '--vault-name', vault, '--name', secret, '--query', 'id']));
const readSecret = (vault, secret) => az(['keyvault', 'secret', 'show', '--vault-name', vault, '--name', secret, '--query', 'value']);
/** Values reach the vault through a private file, never a command line. A new role assignment can take minutes to apply. */
async function writeSecret(vault, secret, value) {
  await withScratch(async scratch => {
    const file = join(scratch, 'value');
    await writeFile(file, value, { mode: 0o600 });
    const wait = Number(process.env.INTEGRALFLOW_RETRY_MS ?? 15_000);
    for (let attempt = 1; ; attempt++) {
      if (azTry(['keyvault', 'secret', 'set', '--vault-name', vault, '--name', secret, '--file', file, '--encoding', 'utf-8', '--query', 'id']) !== undefined) return;
      if (attempt === 20) throw new Error(`Could not write secret ${secret}; check that this account holds Key Vault Secrets Officer on ${vault}`);
      await sleep(wait);
    }
  });
}
function openssl(argv, cwd) {
  const result = spawnSync('openssl', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  if (result.error || result.status !== 0) throw new Error(`openssl ${argv[0]} failed: ${result.error?.message ?? result.stderr}`);
}
/** A private certificate authority and a server certificate for the database's internal host name. */
async function databaseCertificates(host, scratch) {
  await writeFile(join(scratch, 'server.ext'), `subjectAltName=DNS:${host}\nextendedKeyUsage=serverAuth\nkeyUsage=critical,digitalSignature,keyEncipherment\nbasicConstraints=critical,CA:FALSE\n`);
  openssl(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-keyout', 'ca.key', '-out', 'ca.crt', '-days', '3650', '-subj', `/CN=${host} certificate authority`,
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign'], scratch);
  openssl(['req', '-newkey', 'rsa:3072', '-nodes', '-keyout', 'server.key', '-out', 'server.csr', '-subj', `/CN=${host}`], scratch);
  openssl(['x509', '-req', '-in', 'server.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'server.crt', '-days', '825', '-extfile', 'server.ext'], scratch);
  const read = file => readFile(join(scratch, file), 'utf8');
  return { caCertificate: await read('ca.crt'), caKey: await read('ca.key'), certificate: await read('server.crt'), key: await read('server.key') };
}

const modelDeployments = values['model-deployments'] ? JSON.parse(await readFile(resolve(values['model-deployments']), 'utf8')) : [];
if (!Array.isArray(modelDeployments) || modelDeployments.some(item => !item || ['name', 'model', 'version', 'sku'].some(key => typeof item[key] !== 'string' || !item[key]) || !Number.isInteger(item.capacity))) throw new Error('--model-deployments must be a JSON array of { name, model, version, sku, capacity }');
let priorFoundation;
if (command === 'plan' || command === 'apply') {
  try { priorFoundation = JSON.parse(await readFile(join(directory, 'foundation.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
if (priorFoundation && (priorFoundation.name !== name || priorFoundation.subscription !== account.id || priorFoundation.location !== location)) throw new Error('The existing foundation receipt belongs to a different target');
const databaseVmSize = values['database-vm-size'] ?? priorFoundation?.databaseVmSize ?? 'Standard_D2s_v5';
if (!/^Standard_[A-Za-z0-9_]{2,40}$/.test(databaseVmSize)) throw new Error('Use a Standard Azure VM SKU for --database-vm-size');
const plan = { subscription: account.id, resourceGroup, location, name, registryName, recipe: 'azure-foundation-v1', resources: [
  `Container registry (${registrySku})`, 'Virtual network 10.40.0.0/16: apps, data and private-endpoint subnets, NAT gateway with one public address',
  'Key vault (role-based access, private endpoint)', 'Log Analytics workspace and Application Insights', 'Evidence storage account: versioned, version-level immutability, private endpoint only',
  ...(values['no-models'] ? [] : [`Azure AI services account, private endpoint only, ${modelDeployments.length} model deployment(s)`]),
  ...(values['document-intelligence'] ? ['Azure Document Intelligence account, private endpoint only'] : []),
  `PostgreSQL 17 host (pgvector, Apache AGE) at ${databaseHost}: one ${databaseVmSize} virtual machine, no public address, data disk, private certificate authority`], databaseVmSize };

if (command === 'plan') process.stdout.write(JSON.stringify(plan, null, 2) + '\n');

if (command === 'apply') {
  const operator = values['operator-object-id'] ?? az(['ad', 'signed-in-user', 'show', '--query', 'id']);
  if (!/^[0-9a-f-]{36}$/i.test(operator)) throw new Error('Could not determine the operator; pass --operator-object-id');
  for (const namespace of ['Microsoft.App', 'Microsoft.ContainerRegistry', 'Microsoft.Storage', 'Microsoft.ManagedIdentity', 'Microsoft.Network', 'Microsoft.Compute', 'Microsoft.KeyVault', 'Microsoft.OperationalInsights', 'Microsoft.Insights', 'Microsoft.CognitiveServices']) az(['provider', 'register', '--namespace', namespace, '--wait', ...scope]);
  if (!az(['group', 'exists', '--name', resourceGroup, ...scope])) az(['group', 'create', '--name', resourceGroup, '--location', location, '--tags', 'integralflow.recipe=azure-foundation-v1', ...scope]);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const deploy = async (deployment, template, parameters) => withScratch(async scratch => {
    const file = join(scratch, 'parameters.json');
    await writeFile(file, JSON.stringify({ parameters: Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, { value }])) }), { mode: 0o600 });
    return az(['deployment', 'group', 'create', '--resource-group', resourceGroup, '--name', deployment, '--template-file', `deploy/azure/${template}.bicep`, '--parameters', `@${file}`, ...scope]).properties.outputs;
  });
  process.stdout.write('Preparing the image registry…\n');
  await deploy(`${name}-registry`, 'registry', { registryName, location, sku: registrySku });
  const common = { name, location, registryName, operatorObjectId: operator, operatorPrincipalType: values['operator-object-id'] ? 'ServicePrincipal' : 'User',
    deployModels: !values['no-models'], modelDeployments, deployDocumentIntelligence: Boolean(values['document-intelligence']), vaultPurgeProtection: !values['no-purge-protection'] };
  process.stdout.write('Creating the network, key vault, logs, evidence storage and private endpoints…\n');
  const first = await deploy(`${name}-foundation`, 'foundation', { ...common, deployDatabase: false });
  const vault = first.vaultName.value;

  process.stdout.write('Building the PostgreSQL image (pgvector and Apache AGE) in the registry…\n');
  const revision = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || 'local';
  run(['acr', 'build', '--registry', registryName, '--image', `integralflow-postgres:${revision}`, '--platform', 'linux/amd64', '--file', 'Dockerfile.postgres', ...scope, '.'], { json: false });
  const digest = az(['acr', 'manifest', 'show-metadata', '--registry', registryName, '--name', `integralflow-postgres:${revision}`, ...scope]).digest;
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Registry did not return an immutable image digest');
  run(['acr', 'import', '--name', registryName, '--source', collectorSource, '--image', collectorTag, '--force', ...scope], { json: false });
  const collectorDigest = az(['acr', 'manifest', 'show-metadata', '--registry', registryName, '--name', collectorTag, ...scope]).digest;
  if (!/^sha256:[a-f0-9]{64}$/.test(collectorDigest)) throw new Error('Registry did not return an immutable Collector digest');

  process.stdout.write('Storing database and storage credentials in the key vault…\n');
  if (!hasSecret(vault, 'postgres-migrator-password')) await writeSecret(vault, 'postgres-migrator-password', randomBytes(32).toString('hex'));
  // The server certificate is issued once: replacing it would also need the host to restart.
  if (!hasSecret(vault, 'postgres-server-key')) {
    await withScratch(async scratch => {
      const issued = await databaseCertificates(databaseHost, scratch);
      await writeSecret(vault, 'postgres-ca-key', issued.caKey);
      await writeSecret(vault, 'postgres-ca-cert', issued.caCertificate);
      await writeSecret(vault, 'postgres-server-cert', issued.certificate);
      await writeSecret(vault, 'postgres-server-key', issued.key);
    });
  }
  const accountKey = az(['storage', 'account', 'keys', 'list', '--resource-group', resourceGroup, '--account-name', first.evidenceAccountName.value, '--query', '[0].value', ...scope]);
  await writeSecret(vault, 'evidence-storage-credential', JSON.stringify({ provider: 'azure_blob', accountName: first.evidenceAccountName.value, accountKey }));

  // The host's administrator key, for emergency access from inside the network. Kept beside the receipt.
  const keyPath = join(directory, 'postgres-admin-key');
  if (!(await readFile(`${keyPath}.pub`, 'utf8').catch(() => ''))) {
    const pair = generateKeyPairSync('rsa', { modulusLength: 4096 });
    const jwk = pair.publicKey.export({ format: 'jwk' });
    // The OpenSSH public key format: length-prefixed key type, exponent and modulus (as non-negative integers).
    const field = bytes => { const body = bytes[0] & 0x80 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes; const length = Buffer.alloc(4); length.writeUInt32BE(body.length); return Buffer.concat([length, body]); };
    const blob = Buffer.concat([field(Buffer.from('ssh-rsa')), field(Buffer.from(jwk.e, 'base64url')), field(Buffer.from(jwk.n, 'base64url'))]);
    await writeFile(keyPath, pair.privateKey.export({ type: 'pkcs1', format: 'pem' }), { mode: 0o600 });
    await writeFile(`${keyPath}.pub`, `ssh-rsa ${blob.toString('base64')} ${name}-postgres-admin\n`, { mode: 0o600 });
  }
  process.stdout.write('Starting the PostgreSQL host…\n');
  const outputs = await deploy(`${name}-foundation`, 'foundation', { ...common, deployDatabase: true, databaseVmSize, databaseImage: `${registryHost}/integralflow-postgres@${digest}`, databaseAdminPublicKey: (await readFile(`${keyPath}.pub`, 'utf8')).trim() });
  const value = key => outputs[key]?.value ?? '';
  await record('foundation.json', { ...plan, registrySku, vaultName: vault, appsSubnetId: value('appsSubnetId'), workspaceName: value('workspaceName'), insightsName: value('insightsName'),
    collectorImage: `${registryHost}/${collectorRepository}@${collectorDigest}`, evidenceAccountName: value('evidenceAccountName'), evidenceEndpoint: value('evidenceEndpoint'), evidenceContainer: value('evidenceContainer'),
    databaseHost, databaseImage: `${registryHost}/integralflow-postgres@${digest}`, outboundAddress: value('outboundAddress'),
    modelsAccountName: value('modelsAccountName'), modelsEndpoint: value('modelsEndpoint'), documentsAccountName: value('documentsAccountName'), documentsEndpoint: value('documentsEndpoint') });
  process.stdout.write(`Foundation ready. Receipt: ${join(directory, 'foundation.json')}\nNext: pnpm deploy:azure apply --resource-group ${resourceGroup} --name ${name} --location ${location}\n`);
}

if (command === 'identity') {
  const foundation = await receipt('foundation.json');
  const launch = await receipt('launch.json');
  if (!launch.defaultDomain) throw new Error('launch.json has no environment domain: run pnpm deploy:azure apply again');
  const vault = foundation.vaultName;
  const tenant = account.tenantId;
  const graph = (method, path, body, tolerate = false) => run(['rest', '--method', method, '--uri', `https://graph.microsoft.com/v1.0/${path}`, ...(body ? ['--headers', 'Content-Type=application/json', '--body', JSON.stringify(body)] : [])], { tolerate });
  const application = displayName => az(['ad', 'app', 'list', '--display-name', displayName]).find(item => item.displayName === displayName)
    ?? az(['ad', 'app', 'create', '--display-name', displayName, '--sign-in-audience', 'AzureADMyOrg']);
  const principal = appId => az(['ad', 'sp', 'list', '--filter', `appId eq '${appId}'`])[0] ?? az(['ad', 'sp', 'create', '--id', appId]);
  const credential = async (app, secret) => {
    if (hasSecret(vault, secret)) return;
    const issued = az(['ad', 'app', 'credential', 'reset', '--id', app.appId, '--append', '--display-name', `${name}-deployment`, '--years', '1']);
    await writeSecret(vault, secret, issued.password);
  };

  process.stdout.write('Registering the service audience and one application per runtime service…\n');
  const services = application(`${name}-services`);
  graph('PATCH', `applications/${services.id}`, { identifierUris: [`api://${services.appId}`], api: { requestedAccessTokenVersion: 2 } });
  principal(services.appId);
  // The runtime refuses service tokens that live longer than about an hour; the directory's default is longer.
  const policyName = `${name}-service-token-lifetime`;
  const policy = graph('GET', 'policies/tokenLifetimePolicies').value.find(item => item.displayName === policyName)
    ?? graph('POST', 'policies/tokenLifetimePolicies', { displayName: policyName, isOrganizationDefault: false, definition: [JSON.stringify({ TokenLifetimePolicy: { Version: 1, AccessTokenLifetime: '00:30:00' } })] });
  const assigned = graph('GET', `applications/${services.id}/tokenLifetimePolicies`).value.some(item => item.id === policy.id);
  if (!assigned) graph('POST', `applications/${services.id}/tokenLifetimePolicies/$ref`, { '@odata.id': `https://graph.microsoft.com/v1.0/policies/tokenLifetimePolicies/${policy.id}` });
  const clients = {};
  // The platform services, and the library skill host the runtime deploys beside them.
  for (const identity of [...new Set([...RUNTIME_SERVICES.map(service => service.identity), 'skill-host', 'document-factory-worker'])]) {
    const app = application(`${name}-${identity}`);
    clients[identity] = { clientId: app.appId, subject: principal(app.appId).id };
    await credential(app, `workload-${identity}-client-secret`);
  }

  process.stdout.write('Registering the sign-in application and its roles…\n');
  const human = application(`${name}-console`);
  const existingRoles = graph('GET', `applications/${human.id}?$select=appRoles`).appRoles ?? [];
  const appRoles = DEPLOYMENT_ROLES.map(role => existingRoles.find(item => item.value === role)
    ?? { id: randomUUID(), value: role, displayName: role, description: `IntegralFlow ${role}`, allowedMemberTypes: ['User'], isEnabled: true });
  const applicationOrigin = `https://${azureApplicationName(name, 'experience-bff')}.${launch.defaultDomain}`;
  graph('PATCH', `applications/${human.id}`, { appRoles, web: { redirectUris: [`${new URL(launch.url).origin}/auth/setup/callback`, `${applicationOrigin}/auth/callback`] } });
  const humanPrincipal = principal(human.appId);
  process.stdout.write('Configuring Microsoft Graph User.Read.All application permission and administrator consent…\n');
  try {
    await ensureEntraDirectoryPermission({ rest: graph, applicationId: human.id, principalId: humanPrincipal.id, grant: true });
  } catch (error) {
    throw new Error(`Directory setup failed for sign-in app ${human.appId}. The operator needs Application.ReadWrite.All and AppRoleAssignment.ReadWrite.All with a tenant role allowed to grant Microsoft Graph application permissions. A Privileged Role Administrator can grant User.Read.All (Application) on this app, then rerun identity. Completed resources are retained.`, { cause: error });
  }
  // Authentication is tenant-scoped; the platform directory grants application access.
  if (humanPrincipal.appRoleAssignmentRequired !== false) graph('PATCH', `servicePrincipals/${humanPrincipal.id}`, { appRoleAssignmentRequired: false });
  await credential(human, 'oidc-client-secret');
  const operator = values['operator-object-id'] ?? azTry(['ad', 'signed-in-user', 'show', '--query', 'id']);
  const administrator = appRoles.find(role => role.value === 'Platform.Admin').id;
  // Already assigned answers with a conflict, which is fine.
  if (operator) graph('POST', `servicePrincipals/${humanPrincipal.id}/appRoleAssignedTo`, { principalId: operator, resourceId: humanPrincipal.id, appRoleId: administrator }, true);

  const authority = `https://login.microsoftonline.com/${tenant}`;
  await record('identity.json', { tenant, issuer: `${authority}/v2.0`, tokenEndpoint: `${authority}/oauth2/v2.0/token`, jwksUri: `${authority}/discovery/v2.0/keys`,
    audience: services.appId, scope: `api://${services.appId}/.default`, clients, console: { clientId: human.appId, redirectUris: [`${new URL(launch.url).origin}/auth/setup/callback`, `${applicationOrigin}/auth/callback`] } });
  process.stdout.write(`Identities ready. Receipt: ${join(directory, 'identity.json')}\nNext: pnpm deploy:azure:foundation inputs --resource-group ${resourceGroup} --name ${name} --out /private/integralflow\n`);
}

if (command === 'inputs') {
  if (!values.out) throw new Error('inputs needs --out DIRECTORY, outside the repository');
  await mkdir(resolve(values.out), { recursive: true, mode: 0o700 });
  const out = await realpath(resolve(values.out));
  const sourceRoot = await realpath(process.cwd());
  if (out === sourceRoot || out.startsWith(sourceRoot + '/')) throw new Error('Keep the private inputs outside the repository so they cannot enter the remote image build context');
  const foundation = await receipt('foundation.json');
  const identity = await receipt('identity.json');
  const launch = await receipt('launch.json');
  const vault = foundation.vaultName;
  const tenantId = values.tenant ?? name;
  const monthlyLimitUsd = Number(values['monthly-limit'] ?? 25);
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(tenantId) || !(monthlyLimitUsd > 0)) throw new Error('Invalid --tenant or --monthly-limit');
  const secretName = service => `${service.toUpperCase().replaceAll('-', '_')}_CLIENT_SECRET`;
  const modelToken = foundation.modelsAccountName ? az(['cognitiveservices', 'account', 'keys', 'list', '--resource-group', resourceGroup, '--name', foundation.modelsAccountName, '--query', 'key1', ...scope]) : undefined;
  const oidcSecret = readSecret(vault, 'oidc-client-secret');
  // The evidence pipeline's bearer token and the key its store is encrypted with. Kept in the
  // vault: losing the data key makes the stored evidence unreadable.
  if (!hasSecret(vault, 'evidence-pipeline-token')) await writeSecret(vault, 'evidence-pipeline-token', randomBytes(32).toString('hex'));
  if (!hasSecret(vault, 'evidence-pipeline-data-key')) await writeSecret(vault, 'evidence-pipeline-data-key', randomBytes(32).toString('base64'));
  const secrets = { EVIDENCE_PIPELINE_TOKEN: readSecret(vault, 'evidence-pipeline-token'), EVIDENCE_PIPELINE_DATA_KEY: readSecret(vault, 'evidence-pipeline-data-key'), DATABASE_MIGRATOR_PASSWORD: readSecret(vault, 'postgres-migrator-password'), ...(modelToken ? { MODEL_PROVIDER_TOKEN: modelToken } : {}), OIDC_CLIENT_SECRET: oidcSecret,
    OBJECT_STORAGE_CREDENTIAL: readSecret(vault, 'evidence-storage-credential'),
    ...Object.fromEntries(Object.keys(identity.clients).map(service => [secretName(service), readSecret(vault, `workload-${service}-client-secret`)])) };
  const databaseUrl = database => `postgresql://migration_operator@${foundation.databaseHost}/${database}?sslmode=verify-full`;
  const inputs = { tenantId, monthlyLimitUsd, databaseUrls: { control: databaseUrl('integralflow_control'), case: databaseUrl('integralflow_case'), context: databaseUrl('integralflow_context'),
      ...(foundation.modelsEndpoint ? { discovery: databaseUrl('ehf_discovery') } : {}) },
    databaseCaPem: readSecret(vault, 'postgres-ca-cert'), secrets,
    // Development only: the deployment approves the skill host's bundle instead of a second person.
    hostedServices: { skillHost: values['dev-auto-approve-skill-bundle'] ? { autoApproveBundle: true } : {}, evidencePipeline: { tokenRef: 'env:EVIDENCE_PIPELINE_TOKEN', dataKeyRef: 'env:EVIDENCE_PIPELINE_DATA_KEY' } },
    workload: { issuer: identity.issuer, audience: identity.audience, tokenEndpoint: identity.tokenEndpoint, jwksUri: identity.jwksUri,
      clients: Object.fromEntries(Object.entries(identity.clients).map(([service, client]) => [service, { clientId: client.clientId, secretRef: `env:${secretName(service)}`, subject: client.subject, scope: identity.scope }])) } };
  await writeFile(join(out, 'runtime-inputs.json'), JSON.stringify(inputs, null, 2) + '\n', { mode: 0o600 });
  await writeFile(join(out, 'bootstrap-secrets.json'), JSON.stringify({ ...(modelToken ? { MODEL_PROVIDER_TOKEN: modelToken } : {}), OIDC_CLIENT_SECRET: oidcSecret }, null, 2) + '\n', { mode: 0o600 });
  for (const file of ['runtime-inputs.json', 'bootstrap-secrets.json']) await chmod(join(out, file), 0o600);
  // What to enter in the onboarding console. References only; no secret values.
  const consoleValues = {
    foundation: { database: { host: foundation.databaseHost, port: 5432, credentialRef: 'env:DATABASE_MIGRATOR_PASSWORD' },
      objectStore: { endpoint: foundation.evidenceEndpoint, bucket: foundation.evidenceContainer, credentialRef: 'env:OBJECT_STORAGE_CREDENTIAL' }, telemetryEndpoint: launch.telemetryEndpoint ?? '', ...(launch.applicationInsightsResourceId ? { observability: { backend: 'azure_monitor', applicationInsightsResourceId: launch.applicationInsightsResourceId } } : {}) },
    intelligence: {
      ...(foundation.modelsEndpoint ? { provider: 'azure_foundry', endpoint: foundation.modelsEndpoint, credentialRef: 'env:MODEL_PROVIDER_TOKEN' } : {}),
      ...(foundation.documentsAccountName ? { documentServices: { modelTier: 'med', extractionPlanDigest: '', azure: {
        resourceId: `/subscriptions/${account.id}/resourceGroups/${resourceGroup}/providers/Microsoft.CognitiveServices/accounts/${foundation.documentsAccountName}`,
        layout: false, modelExtraction: false, factory: false,
      } } } : {}),
    },
    access: { issuer: identity.issuer, clientId: identity.console.clientId, clientSecretRef: 'env:OIDC_CLIENT_SECRET', rolesClaim: 'roles', mappings: DEPLOYMENT_ROLES.map(role => ({ group: role, role })) } };
  await record('console-values.json', consoleValues);
  const origins = [...new Set([new URL(identity.issuer).origin, ...(foundation.modelsEndpoint ? [new URL(foundation.modelsEndpoint).origin] : [])])];
  process.stdout.write(`Private files written to ${out} (runtime-inputs.json, bootstrap-secrets.json).\nConsole values: ${join(directory, 'console-values.json')}\n`
    + `Next: pnpm deploy:azure apply --resource-group ${resourceGroup} --name ${name} --location ${location} ${origins.map(origin => `--allowed-origin ${origin}`).join(' ')} --secrets-file ${join(out, 'bootstrap-secrets.json')} --runtime-inputs ${join(out, 'runtime-inputs.json')}\n`);
}
