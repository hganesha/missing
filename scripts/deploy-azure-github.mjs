import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { collectorSource } from './lib/azure-collector-image.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const json = (value, message) => { try { return JSON.parse(value); } catch { throw new Error(message); } };
function invoke(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 30_000_000, timeout: 5_400_000 });
  // Provider diagnostics can contain private request parameters. Inspect failed
  // operations in Azure; never forward arbitrary CLI stderr to Actions logs.
  if (result.error || result.status !== 0) throw new Error(`${executable === 'az' ? 'Azure operation' : 'Bootstrap command'} failed; inspect the Azure deployment or ACR task logs.`);
  return result.stdout;
}

export async function runGithubBootstrap({ env = process.env, cwd = process.cwd(), az, deploy, log = console.log, mask = value => console.log(`::add-mask::${value.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')}`) } = {}) {
  const mode = env.BOOTSTRAP_MODE ?? 'preview';
  const resourceGroup = env.BOOTSTRAP_RESOURCE_GROUP ?? 'rg-integralflow-bootstrap';
  const name = env.BOOTSTRAP_NAME ?? 'integralflow';
  const location = env.BOOTSTRAP_LOCATION ?? 'centralus';
  const subscription = env.AZURE_SUBSCRIPTION_ID ?? '';
  const vault = env.BOOTSTRAP_STATE_VAULT ?? '';
  const collector = env.BOOTSTRAP_COLLECTOR_IMAGE || collectorSource;
  const secretsName = env.BOOTSTRAP_SECRETS_SECRET;
  // Leave room for the -executor suffix within Container Apps' 32-character limit.
  if (!['preview', 'apply'].includes(mode) || !/^[a-f0-9-]{36}$/i.test(subscription) || !/^[a-zA-Z0-9_.()-]{1,80}$/.test(resourceGroup) || resourceGroup.endsWith('.') || !/^[a-z][a-z0-9-]{1,22}$/.test(name) || name.endsWith('-') || name.includes('--') || !/^[a-z0-9]+$/.test(location)) throw new Error('Invalid bootstrap mode or Azure target.');
  if (!/^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$/.test(vault) || (secretsName && !/^[a-zA-Z0-9-]{1,127}$/.test(secretsName))) throw new Error('Configure AZURE_BOOTSTRAP_STATE_VAULT and a valid optional AZURE_BOOTSTRAP_SECRETS_SECRET.');
  if (!/^[a-z0-9][a-z0-9.-]*(?::[0-9]+)?\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/.test(collector)) throw new Error('Supply a public OpenTelemetry Contrib registry/repository image pinned by SHA-256 digest.');
  const origins = [...new Set((env.BOOTSTRAP_ALLOWED_ORIGINS ?? 'https://login.microsoftonline.com').split(',').map(value => value.trim()).filter(Boolean))];
  for (const origin of origins) { let valid = false; try { const url = new URL(origin); valid = url.protocol === 'https:' && url.origin === origin; } catch {} if (!valid) throw new Error('Allowed origins must be exact HTTPS origins.'); }
  const cli = az ?? ((args, parse = true) => {
    const output = invoke('az', [...args, '--output', 'json', '--only-show-errors'], cwd);
    return parse ? output.trim() ? json(output, 'Azure returned invalid JSON.') : null : output;
  });
  const run = deploy ?? (args => invoke(process.execPath, ['--import', 'tsx', 'scripts/deploy-azure.mjs', ...args], cwd));
  const scope = ['--subscription', subscription];
  const target = ['--subscription', subscription, '--resource-group', resourceGroup, '--name', name, '--location', location, '--cloud-executor', 'true', ...origins.flatMap(origin => ['--allowed-origin', origin])];
  const plan = json(await run(['plan', ...target]), 'Bootstrap returned an invalid plan.');
  if (plan.subscription?.toLowerCase() !== subscription.toLowerCase() || !/^if[a-f0-9]{12}$/.test(plan.registryName)) throw new Error('Bootstrap plan does not match the configured subscription.');
  await run(['validate', ...target]);
  log(`Templates compiled for ${resourceGroup}/${name} in ${location}.`);
  const stateName = `if-bootstrap-${hash(`${subscription.toLowerCase()}/${resourceGroup.toLowerCase()}/${name}`).slice(0, 20)}`;
  const summary = async lines => { if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n'); };
  if (mode === 'preview') {
    await summary(['## Azure bootstrap preview', `Target: \`${resourceGroup}/${name}\` (\`${location}\`).`, '', ...plan.resources.map(item => `- ${item}`), '', 'Bicep compilation and target inventory only. No ARM what-if or deployment was performed.', 'Apply will also build the document adapter and import the pinned OpenTelemetry Collector image into ACR.']);
    return { mode, stateName, plan };
  }
  if (!/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')) throw new Error('A full GitHub commit SHA is required for apply.');
  const groupExists = await cli(['group', 'exists', '--name', resourceGroup, ...scope]);
  const resources = groupExists ? await cli(['resource', 'list', '--resource-group', resourceGroup, ...scope]) : [];
  // This workflow carries no private foundation receipt. Refuse to redeploy a
  // foundation with standalone defaults, which could reset its VNet/logging/SKU.
  if (resources.some(item => item.tags?.['integralflow.component'] === 'foundation')) throw new Error('This target has an Azure foundation. Use its operator installer with the original foundation receipt.');
  if (resources.some(item => item.type?.toLowerCase() === 'microsoft.containerregistry/registries' && item.name === plan.registryName)) {
    const registry = await cli(['acr', 'show', '--name', plan.registryName, ...scope]);
    if (registry.sku?.name !== 'Basic') throw new Error('The existing registry has a non-Basic SKU. Use its operator installer to preserve the foundation.');
  }
  const existing = resources.find(item => item.type?.toLowerCase() === 'microsoft.app/containerapps' && item.name === name);
  // Listing metadata distinguishes a missing secret from permission/network errors.
  // Any error fails closed rather than silently generating replacement credentials.
  const names = await cli(['keyvault', 'secret', 'list', '--vault-name', vault, '--query', '[].name']);
  const loadSecret = async secretName => {
    const result = await cli(['keyvault', 'secret', 'show', '--vault-name', vault, '--name', secretName]);
    if (typeof result?.value !== 'string') throw new Error('Key Vault returned an invalid secret.');
    mask(result.value);
    return result.value;
  };
  let state;
  if (names.includes(stateName)) state = json(await loadSecret(stateName), 'The bootstrap state secret is invalid JSON.');
  else if (existing) throw new Error('This installation has no saved bootstrap state in the configured vault. Import its original claim and executor tokens before rerunning.');
  else state = { version: 1, subscription, resourceGroup, name, claimToken: randomBytes(32).toString('hex'), executorToken: randomBytes(32).toString('hex') };
  if (state?.version !== 1 || state.subscription?.toLowerCase() !== subscription.toLowerCase() || state.resourceGroup?.toLowerCase() !== resourceGroup.toLowerCase() || state.name !== name || !/^[a-f0-9]{64}$/.test(state.claimToken ?? '') || !/^[a-f0-9]{64}$/.test(state.executorToken ?? '')) throw new Error('Saved bootstrap state is invalid or belongs to another target.');
  mask(state.claimToken); mask(state.executorToken);
  if (existing) {
    const console = await cli(['containerapp', 'show', '--resource-group', resourceGroup, '--name', name, ...scope]);
    const environment = await cli(['containerapp', 'env', 'show', '--ids', console.properties.managedEnvironmentId, ...scope]);
    if (environment.properties?.vnetConfiguration?.infrastructureSubnetId || environment.properties?.appLogsConfiguration?.destination === 'log-analytics') throw new Error('The existing environment has networking or logging configuration. Use its operator installer to preserve the foundation.');
    const variables = console.properties?.template?.containers?.[0]?.env ?? [];
    for (const [variable, token] of [['ONBOARDING_BOOTSTRAP_SHA256', state.claimToken], ['ONBOARDING_EXECUTOR_SHA256', state.executorToken]]) {
      if (variables.find(item => item.name === variable)?.value !== hash(token)) throw new Error('Saved bootstrap tokens do not match the deployed console; restore the original state before updating.');
    }
  }
  let secrets;
  if (secretsName) {
    secrets = json(await loadSecret(secretsName), 'The console secrets secret is invalid JSON.');
    if (!secrets || Array.isArray(secrets) || typeof secrets !== 'object') throw new Error('Console secrets must be a JSON object.');
    for (const [key, value] of Object.entries(secrets)) {
      if (!/^[A-Z][A-Z0-9_]{1,60}$/.test(key) || /^(ONBOARDING_|DEPLOYMENT_|SERVICE_NAME$|HOST$|PORT$|NODE_|IMAGE_REFERENCE$)/.test(key) || typeof value !== 'string' || !value || value.length > 65536) throw new Error('Console secrets contain an invalid or reserved variable.');
      mask(value);
    }
  } else if (existing && (await cli(['containerapp', 'secret', 'list', '--resource-group', resourceGroup, '--name', name, ...scope]) ?? []).length) throw new Error('Preserve existing console secrets with AZURE_BOOTSTRAP_SECRETS_SECRET before updating.');
  const temporary = await mkdtemp(join(tmpdir(), 'integralflow-github-'));
  const directory = resolve(cwd, '.integralflow/azure', resourceGroup);
  let ownsDirectory = false;
  try {
    await mkdir(resolve(cwd, '.integralflow/azure'), { recursive: true, mode: 0o700 });
    // The CI wrapper never overwrites a local operator's state directory.
    await mkdir(directory, { mode: 0o700 }); ownsDirectory = true;
    const saveSecret = async (secretName, value) => {
      const path = join(temporary, 'secret');
      await writeFile(path, value, { mode: 0o600 });
      try { await cli(['keyvault', 'secret', 'set', '--vault-name', vault, '--name', secretName, '--file', path]); }
      finally { await rm(path, { force: true }); }
    };
    // Persist before any Azure resource creation, including failures halfway through apply.
    if (!names.includes(stateName)) await saveSecret(stateName, JSON.stringify(state));
    await writeFile(join(directory, 'claim-token'), state.claimToken + '\n', { mode: 0o600 });
    await writeFile(join(directory, 'executor-token'), state.executorToken + '\n', { mode: 0o600 });
    log(`Bootstrap tokens are preserved in Key Vault ${vault}, secret ${stateName}.`);
    if (!groupExists) await cli(['group', 'create', '--name', resourceGroup, '--location', location, ...scope]);
    await cli(['provider', 'register', '--namespace', 'Microsoft.ContainerRegistry', '--wait', ...scope]);
    await cli(['deployment', 'group', 'create', '--resource-group', resourceGroup, '--name', `${name}-registry`, '--template-file', 'deploy/azure/registry.bicep', '--parameters', `registryName=${plan.registryName}`, `location=${location}`, ...scope]);
    log('Importing the pinned OpenTelemetry Collector image.');
    const collectorTag = `telemetry/opentelemetry-collector-contrib:sha256-${collector.split('@sha256:')[1]}`;
    await cli(['acr', 'import', '--name', plan.registryName, '--source', collector, '--image', collectorTag, '--force', ...scope]);
    const pinned = async tag => {
      const metadata = await cli(['acr', 'manifest', 'show-metadata', '--registry', plan.registryName, '--name', tag, ...scope]);
      if (!/^sha256:[a-f0-9]{64}$/.test(metadata?.digest ?? '')) throw new Error('ACR did not return an immutable dependency digest.');
      return `${plan.registryName}.azurecr.io/${tag.split(':')[0]}@${metadata.digest}`;
    };
    const args = ['apply', ...target, '--collector-image', await pinned(collectorTag)];
    if (secrets !== undefined) { const path = join(temporary, 'console-secrets.json'); await writeFile(path, JSON.stringify(secrets), { mode: 0o600 }); args.push('--secrets-file', path); }
    log('Building the console and private executor, then applying bootstrap. Inspect ACR task logs in Azure for build progress.');
    await run(args);
    const receipt = json(await readFile(join(directory, 'launch.json'), 'utf8'), 'Bootstrap did not produce a valid launch receipt.');
    const url = new URL(receipt.url);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Bootstrap returned an invalid onboarding URL.');
    await saveSecret(`${stateName}-receipt`, JSON.stringify(receipt));
    await summary(['## Azure bootstrap installed', `Open onboarding: <${url.href}>`, '', `State vault: \`${vault}\`. State secret: \`${stateName}\`.`, 'An authorized operator can open that secret in Azure Portal and copy only its `claimToken` into the claim screen. Do not share the JSON or the executor token.', '', 'The private executor stays in Azure. Continue resource review, directory consent, administrator sign-in and reviewed runtime deployment in the wizard.', 'This run installs bootstrap; it does not certify runtime readiness.']);
    log(`Onboarding: ${url.href}`);
    return { mode, stateName, url: url.href };
  } finally {
    await rm(temporary, { recursive: true, force: true });
    if (ownsDirectory) await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Use this wrapper from the Bootstrap Azure GitHub Actions workflow.');
    await runGithubBootstrap();
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
