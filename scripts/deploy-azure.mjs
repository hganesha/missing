import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, mkdtemp, rm, chmod, realpath } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { azureApplicationName } from '../apps/launcher/src/recipes/azure.ts';
import { collectorRepository, collectorSource, collectorTag } from './lib/azure-collector-image.mjs';
import { skillBundleLockDigest, skillBundleLockSchema } from '../packages/contracts/src/index.ts';

const args = process.argv.slice(2);
const command = args.shift() ?? 'plan';
if (!['plan', 'validate', 'apply'].includes(command)) throw new Error('Usage: node scripts/deploy-azure.mjs plan|validate|apply [--resource-group NAME] [--location REGION] [--name NAME] [--subscription ID] [--allowed-origin URL] [--secrets-file PATH] [--runtime-inputs PATH]');
const values = {};
const extraOrigins = [];
while (args.length) {
  const flag = args.shift(); const value = args.shift();
  if (!['--resource-group', '--location', '--name', '--subscription', '--allowed-origin', '--secrets-file', '--runtime-inputs', '--cloud-executor', '--document-image', '--collector-image', '--telemetry-image'].includes(flag) || !value || value.startsWith('--')) throw new Error(`Invalid argument: ${flag}`);
  if (flag === '--allowed-origin') { const url = new URL(value); if (url.protocol !== 'https:' || url.origin !== value) throw new Error('Allowed origins must be exact HTTPS origins'); extraOrigins.push(value); }
  else values[flag.slice(2)] = value;
}
if (values['telemetry-image']) throw new Error('Use --collector-image for an approved OpenTelemetry Contrib override; the Azure default is pinned.');
if (values['cloud-executor'] && values['cloud-executor'] !== 'true') throw new Error('--cloud-executor accepts true');
if (values['document-image'] && !/^.+@sha256:[a-f0-9]{64}$/.test(values['document-image'])) throw new Error('Supply a pinned evidence pipeline override');
if (values['collector-image'] && !/^.+@sha256:[a-f0-9]{64}$/.test(values['collector-image'])) throw new Error('Supply a pinned OpenTelemetry Contrib image for --collector-image');
const resourceGroup = values['resource-group'] ?? 'rg-integralflow-bootstrap';
const name = values.name ?? 'integralflow';
const location = values.location ?? 'centralus';
if (!/^[a-z][a-z0-9-]{1,25}$/.test(name) || name.endsWith('-') || name.includes('--') || !/^[a-zA-Z0-9_.()-]{1,80}$/.test(resourceGroup) || resourceGroup.endsWith('.') || !/^[a-z0-9]+$/.test(location)) throw new Error('Invalid deployment name, resource group or region');
function az(argv, json = true) {
  const result = spawnSync('az', [...argv, ...(json ? ['--output', 'json'] : []), '--only-show-errors'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 30_000_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Azure command failed: ${argv.slice(0, 3).join(' ')}`);
  return json ? (result.stdout.trim() ? JSON.parse(result.stdout) : null) : result.stdout.trim();
}
const account = az(['account', 'show', ...(values.subscription ? ['--subscription', values.subscription] : [])]);
const scope = ['--subscription', account.id];
const suffix = createHash('sha256').update(`${account.id}/${resourceGroup}/${name}`).digest('hex').slice(0, 12);
const registryName = `if${suffix}`;
const plan = { subscription: account.id, resourceGroup, location, name, registryName, recipe: 'azure-container-apps-bootstrap-v1', resources: ['Basic container registry', 'Container Apps environment', 'Console: 0.25 vCPU / 0.5 GiB, one replica', 'Persistent Azure Files setup, evidence pipeline and Factory dataset shares', 'Image-pull identity and scoped AcrPull grant', 'Internal OpenTelemetry Collector, workspace-based Application Insights and Log Analytics'], runtimeProvisioning: Boolean(values['cloud-executor']) };
if (values['cloud-executor']) plan.resources.push('Key Vault and console secret-reader identity', 'Private cloud executor: 0.5 vCPU / 1 GiB, one replica', 'Persistent executor share and scoped provisioning role assignments');
if (command === 'plan') { process.stdout.write(JSON.stringify(plan, null, 2) + '\n'); process.exit(0); }
const temporary = await mkdtemp(join(tmpdir(), 'integralflow-azure-'));
try {
  for (const file of ['registry', 'foundation', 'bootstrap', 'runtime', 'runtime-job']) az(['bicep', 'build', '--file', `deploy/azure/${file}.bicep`, '--outfile', join(temporary, `${file}.json`)], false);
  if (command === 'validate') { process.stdout.write('Azure bootstrap Bicep templates compile successfully. No resources were changed.\n'); process.exitCode = 0; }
  else {
    for (const privateFlag of ['secrets-file', 'runtime-inputs']) {
      if (!values[privateFlag]) continue;
      const secretPath = await realpath(resolve(values[privateFlag]));
      const sourceRoot = await realpath(process.cwd());
      if (secretPath === sourceRoot || secretPath.startsWith(sourceRoot + '/')) throw new Error('Keep the private secrets file outside the repository so it cannot enter the remote image build context');
    }
    const secrets = values['secrets-file'] ? JSON.parse(await readFile(resolve(values['secrets-file']), 'utf8')) : {};
    const reserved = /^(ONBOARDING_|DEPLOYMENT_|SERVICE_NAME$|HOST$|PORT$|NODE_|IMAGE_REFERENCE$)/;
    if (!secrets || Array.isArray(secrets) || typeof secrets !== 'object') throw new Error('Secrets file must contain an object of environment variable names and string values');
    for (const [key, value] of Object.entries(secrets)) if (!/^[A-Z][A-Z0-9_]{1,60}$/.test(key) || reserved.test(key) || typeof value !== 'string' || !value || value.length > 65536) throw new Error('Secrets file contains an invalid or reserved environment variable');
    const groupExists = az(['group', 'exists', '--name', resourceGroup, ...scope]);
    const existing = groupExists ? az(['resource', 'list', '--resource-group', resourceGroup, '--resource-type', 'Microsoft.App/containerApps', ...scope]).find(item => item.name === name) : undefined;
    if (existing && !values['secrets-file']) {
      const configuredSecrets = az(['containerapp', 'secret', 'list', '--resource-group', resourceGroup, '--name', name, ...scope]) ?? [];
      if (!Array.isArray(configuredSecrets)) throw new Error('Azure returned an invalid console secret inventory; refusing to update.');
      if (configuredSecrets.length) throw new Error('This console has secrets. Supply the existing --secrets-file on updates to preserve them; pass an explicit empty file only when intentionally removing them.');
    }
    const directory = resolve('.integralflow/azure', resourceGroup);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // With a foundation (pnpm deploy:azure:foundation apply) the environment joins its network,
    // logs to its workspace and gets a trace collector. Without one the bootstrap stands alone.
    let foundation;
    try { foundation = JSON.parse(await readFile(join(directory, 'foundation.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (foundation && (foundation.name !== name || foundation.subscription !== account.id || foundation.registryName !== registryName)) throw new Error('The foundation receipt in this directory belongs to another deployment name or subscription');
    const tokenPath = join(directory, 'claim-token');
    let token;
    try { token = (await readFile(tokenPath, 'utf8')).trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; token = randomBytes(32).toString('hex'); await writeFile(tokenPath, token + '\n', { mode: 0o600, flag: 'wx' }); }
    await chmod(tokenPath, 0o600);
    const executorPath = join(directory, 'executor-token');
    let executorToken;
    try { executorToken = (await readFile(executorPath, 'utf8')).trim(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; executorToken = randomBytes(32).toString('hex'); await writeFile(executorPath, executorToken + '\n', { mode: 0o600, flag: 'wx' }); }
    if (!/^[a-f0-9]{64}$/.test(executorToken)) throw new Error("Existing executor-token is invalid; restore it or replace it with a private 32-byte hexadecimal token before applying bootstrap.");
    await chmod(executorPath, 0o600);
    for (const namespace of ['Microsoft.App', 'Microsoft.ContainerRegistry', 'Microsoft.Storage', 'Microsoft.ManagedIdentity', 'Microsoft.KeyVault', 'Microsoft.DBforPostgreSQL', 'Microsoft.CognitiveServices', 'Microsoft.OperationalInsights', 'Microsoft.Insights']) az(['provider', 'register', '--namespace', namespace, '--wait', ...scope]);
    if (!groupExists) az(['group', 'create', '--name', resourceGroup, '--location', location, '--tags', 'integralflow.recipe=azure-container-apps-bootstrap-v1', ...scope]);
    process.stdout.write('Preparing the image registry…\n');
    az(['deployment', 'group', 'create', '--resource-group', resourceGroup, '--name', `${name}-registry`, '--template-file', join(temporary, 'registry.json'), '--parameters', `registryName=${registryName}`, `location=${location}`, ...(foundation?.registrySku ? [`sku=${foundation.registrySku}`] : []), ...scope]);
    const registryHost = `${registryName}.azurecr.io`;
    let collectorImage = values['collector-image'] ?? foundation?.collectorImage;
    // Old foundation receipts recorded a mutable registry tag. Import the approved digest
    // under the same tag, then use a digest in the Container App and in the new receipt.
    if (!collectorImage || !/@sha256:[a-f0-9]{64}$/.test(collectorImage)) {
      az(['acr', 'import', '--name', registryName, '--source', collectorSource, '--image', collectorTag, '--force', ...scope], false);
      const collectorDigest = az(['acr', 'manifest', 'show-metadata', '--registry', registryName, '--name', collectorTag, ...scope]).digest;
      if (!/^sha256:[a-f0-9]{64}$/.test(collectorDigest)) throw new Error('Registry did not return an immutable Collector digest');
      collectorImage = `${registryHost}/${collectorRepository}@${collectorDigest}`;
    }

    const sourceRevision = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).stdout.trim() || 'local';
    const dirty = spawnSync('git', ['status', '--short', '--untracked-files=normal'], { encoding: 'utf8' }).stdout.trim();
    const revision = dirty ? `${sourceRevision}-worktree` : sourceRevision;
    const tag = `integralflow:${revision}`;
    process.stdout.write('Building the application image in Azure Container Registry…\n');
    az(['acr', 'build', '--registry', registryName, '--image', tag, '--platform', 'linux/amd64', '--file', 'Dockerfile.platform', '--build-arg', `IMAGE_REVISION=${revision}`, ...scope, '.'], false);
    const metadata = az(['acr', 'manifest', 'show-metadata', '--registry', registryName, '--name', tag, ...scope]);
    if (!/^sha256:[a-f0-9]{64}$/.test(metadata.digest)) throw new Error('Registry did not return an immutable image digest');
    const image = `${registryHost}/integralflow@${metadata.digest}`;
    let executorImage = '';
    if (values['cloud-executor']) {
      const executorTag = `integralflow-executor:${revision}`;
      process.stdout.write('Building the private cloud executor…\n');
      az(['acr', 'build', '--registry', registryName, '--image', executorTag, '--platform', 'linux/amd64', '--file', 'Dockerfile.executor', ...scope, '.'], false);
      const executorMetadata = az(['acr', 'manifest', 'show-metadata', '--registry', registryName, '--name', executorTag, ...scope]);
      if (!/^sha256:[a-f0-9]{64}$/.test(executorMetadata.digest)) throw new Error('Executor image digest unavailable');
      executorImage = `${registryHost}/integralflow-executor@${executorMetadata.digest}`;
    }
    // The library skill host and the evidence pipeline: their own images, deployed by the
    // runtime executor only when the private runtime inputs enable them.
    const hostImages = {};
    // The bundle lock both the skill host image and the application image carry, from this checkout.
    const skillBundleLock = skillBundleLockDigest(skillBundleLockSchema.parse(JSON.parse(await readFile(new URL('../apps/fincrime-host/src/financial_crime/resources/bundle.lock.json', import.meta.url), 'utf8'))));
    for (const [service, context] of [['skill-host', 'apps/fincrime-host'], ['evidence-pipeline', 'apps/evidence-pipeline']]) {
      process.stdout.write(`Building the ${service} image…\n`);
      az(['acr', 'build', '--registry', registryName, '--image', `integralflow-${service}:${revision}`, '--platform', 'linux/amd64', '--file', `${context}/Dockerfile`, ...scope, context], false);
      const built = az(['acr', 'manifest', 'show-metadata', '--registry', registryName, '--name', `integralflow-${service}:${revision}`, ...scope]);
      if (!/^sha256:[a-f0-9]{64}$/.test(built.digest)) throw new Error('Registry did not return an immutable image digest');
      hostImages[service] = `${registryHost}/integralflow-${service}@${built.digest}`;
    }
    const parameterPath = join(temporary, 'parameters.json');
    const documentImage = values['document-image'] ?? hostImages['evidence-pipeline'];
    const parameters = { hostImages, skillBundleLockDigest: skillBundleLock, executorImage, executorToken: executorImage ? executorToken : '', documentImage, collectorImage, name, location, registryName, image, runtimeApplicationName: `${name.slice(0, 14)}-${createHash("sha256").update(name).digest("hex").slice(0, 4)}-web`, bootstrapTokenHash: createHash('sha256').update(token).digest('hex'), executorTokenHash: createHash('sha256').update(executorToken).digest('hex'), allowedOrigins: ['https://openrouter.ai', 'https://api.openai.com', ...extraOrigins].join(','), secretValues: secrets ,
      ...(foundation ? { infrastructureSubnetId: foundation.appsSubnetId, logWorkspaceName: foundation.workspaceName, insightsName: foundation.insightsName } : {}) };
    await writeFile(parameterPath, JSON.stringify({ parameters: Object.fromEntries(Object.entries(parameters).map(([key, value]) => [key, { value }])) }), { mode: 0o600 });
    process.stdout.write('Launching the onboarding console and persistent setup volume…\n');
    const deployment = az(['deployment', 'group', 'create', '--resource-group', resourceGroup, '--name', `${name}-bootstrap`, '--template-file', join(temporary, 'bootstrap.json'), '--parameters', `@${parameterPath}`, ...scope]);
    const url = deployment.properties.outputs.onboardingUrl.value;
    const defaultDomain = deployment.properties.outputs.defaultDomain?.value;
    const telemetryEndpoint = deployment.properties.outputs.telemetryEndpoint?.value;
    const applicationInsightsResourceId = deployment.properties.outputs.applicationInsightsResourceId?.value;
    await writeFile(join(directory, 'launch.json'), JSON.stringify({ ...plan, image, hostImages, skillBundleLockDigest: skillBundleLock, ...(defaultDomain ? { defaultDomain } : {}), ...(telemetryEndpoint ? { telemetryEndpoint } : {}), executorImage, documentImage, collectorImage, ...(applicationInsightsResourceId ? { applicationInsightsResourceId } : {}), url, tokenPath }, null, 2), { mode: 0o600 });
    process.stdout.write(`Onboarding: ${url}\nAdministrator token file: ${tokenPath}\n`);
    process.stdout.write(executorImage ? 'Private cloud executor installed. Review directory consent and resource creation in the wizard.\n' : `Start the scoped operator executor with pnpm deploy:runtime worker --receipt ${join(directory, 'launch.json')} --inputs /private/runtime-inputs.json, then deploy from Review.\n`);
    await rm(parameterPath, { force: true });
    if (values['runtime-inputs'] && !executorImage) {
      const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/deploy-runtime.mjs', 'worker', '--receipt', join(directory, 'launch.json'), '--inputs', resolve(values['runtime-inputs'])], { stdio: 'inherit' });
      for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
      await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => { process.exitCode = code ?? 1; resolve(); }); });
    }
  }
} finally { await rm(temporary, { recursive: true, force: true }); }
