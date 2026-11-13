import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile, appendFile, rm, realpath, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { azureBaseName, compileAzureRuntime } from '../apps/launcher/src/recipes/azure.ts';

import { deploymentProfileSchema, telemetryConfigured } from '../packages/contracts/src/deployment.ts';
import { AzureProvisioner } from './provision-azure-resources.mjs';
import { azureTraceComponent, foundryAgentRoleId, foundryProof, traceRoleId, verifyFoundryPolicy } from './lib/azure-observability.mjs';

const exec = promisify(execFile);
const args = process.argv.slice(2); const command = args.shift(); const flags = {};
while (args.length) { const key = args.shift(); if (key === '--once') flags.once = true; else { const value = args.shift(); if (!['--receipt', '--inputs'].includes(key) || !value) throw new Error('Usage: deploy:runtime worker --receipt PATH --inputs PRIVATE_JSON [--once]'); flags[key.slice(2)] = value; } }
if (command !== 'worker' || !flags.receipt || !flags.inputs) throw new Error('Usage: deploy:runtime worker --receipt PATH --inputs PRIVATE_JSON [--once]');
const receiptPath = await realpath(resolve(flags.receipt));
const inputsPath = await realpath(resolve(flags.inputs));
const repository = await realpath(process.cwd());
if (inputsPath === repository || inputsPath.startsWith(repository + '/')) throw new Error('Keep runtime credentials outside the repository');
const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
const receiptDirectory = dirname(receiptPath);
const root = join(receiptDirectory, 'runtime');
await mkdir(root, { recursive: true, mode: 0o700 });
await chmod(root, 0o700);
const executorToken = (await readFile(join(receiptDirectory, 'executor-token'), 'utf8')).trim();
if (!/^[a-f0-9]{64}$/.test(executorToken) || !/^[a-zA-Z0-9_.()-]{1,80}$/.test(receipt.resourceGroup) || !/^[a-f0-9-]{36}$/i.test(receipt.subscription) || !/^[a-z][a-z0-9-]{1,25}$/.test(receipt.name)) throw new Error('Invalid bootstrap receipt');
const consoleOrigin = new URL(receipt.url).origin;
if (!consoleOrigin.startsWith('https://')) throw new Error('Executor requires an HTTPS console');
const expectedScope = `/subscriptions/${receipt.subscription}/resourceGroups/${receipt.resourceGroup}`;
const azScope = ['--subscription', receipt.subscription];
let diagnosticPath = join(root, 'executor-diagnostics.log');
async function az(argv, json = true) {
  try {
    const { stdout } = await exec('az', [...argv, '--only-show-errors', ...(json ? ['--output', 'json'] : [])], { timeout: 1900000, maxBuffer: 10000000 });
    return json ? stdout.trim() ? JSON.parse(stdout) : null : stdout.trim();
  } catch (error) {
    await appendFile(diagnosticPath, `${new Date().toISOString()} ${argv.slice(0, 3).join(' ')}\n${error.stderr ?? ''}\n`, { mode: 0o600 });
    throw new Error('deployment.azure_operation_failed');
  }
}
async function consoleRequest(path, body) {
  const response = await fetch(new URL(path, consoleOrigin), { method: 'POST', headers: { authorization: `Bearer ${executorToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Object.assign(new Error('deployment.console_request_failed'), { status: response.status });
  return response.json();
}
async function parameters(path, values) {
  await writeFile(path, JSON.stringify({ parameters: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])) }), { mode: 0o600 });
}
const templates = { runtime: resolve('deploy/azure/runtime.bicep'), job: resolve('deploy/azure/runtime-job.bicep') };
await az(['bicep', 'build', '--file', templates.runtime, '--outfile', join(root, 'runtime-template.json')], false);
await az(['bicep', 'build', '--file', templates.job, '--outfile', join(root, 'job-template.json')], false);
process.stdout.write(`Executor ready for ${receipt.resourceGroup}. Request deployment from the console's Review step.\n`);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; });
while (!stopping) {
  let lease;
  try { lease = await consoleRequest('/api/deployment/lease', { image: receipt.image, scopeId: expectedScope }); } catch (error) { if ([401,403,409].includes(error.status) || flags.once) throw error; await pause(5000); continue; }
  if (!lease.job) { if (flags.once) break; await pause(5000); continue; }
  const job = lease.job; const directory = join(root, `deployment-${job.id}`);
  if (!/^[a-f0-9-]{36}$/.test(job.id)) throw new Error('deployment.job_invalid');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  diagnosticPath = join(directory, 'diagnostics.log');
  const steps = []; let leaseLost = false; let applicationUrl; let operationResourceId; let failureCode;
  const report = phase => consoleRequest('/api/deployment/report', { id: job.id, leaseToken: lease.leaseToken, phase, steps, ...(operationResourceId ? { resourceId: operationResourceId } : {}), ...(failureCode ? { failureCode } : {}), ...(applicationUrl ? { applicationUrl } : {}) });
  let missedHeartbeats = 0;
  const heartbeat = setInterval(() => { void report('running').then(() => { missedHeartbeats = 0; }).catch(() => { missedHeartbeats++; if (missedHeartbeats >= 3) leaseLost = true; }); }, 30000);
  const stage = async (name, operation) => {
    if (leaseLost || stopping) throw new Error('deployment.executor_stopped');
    steps.push({ name, status: 'running' }); await report('running');
    process.stdout.write(`${name}…\n`);
    try { const value = await operation(); steps.at(-1).status = 'passed'; await report('running'); return value; }
    catch (error) { steps.at(-1).status = 'failed'; throw error; }
  };
  const commonParameters = { bootstrapName: receipt.name, image: receipt.image, location: receipt.location };
  let compiled; let context; let previousFactory;
  let jobStatusCode;
  async function runJob(kind, environmentVariables, argv) {
    const name = `${compiled.baseName.slice(0, 13).replace(/-+$/, '')}-${kind}-${compiled.generation}`;
    const path = join(directory, `${kind}-parameters.json`);
    const id = `${expectedScope}/providers/Microsoft.App/jobs/${name}`;
    operationResourceId = id; await report('running');
    await parameters(path, { ...commonParameters, name, environmentName: context.managedEnvironmentId.split('/').at(-1), pullIdentityId: context.pullIdentityId, registryHost: context.registryHost, environmentVariables, arguments: argv });
    await az(['deployment', 'group', 'create', '--resource-group', receipt.resourceGroup, '--name', name, '--template-file', join(root, 'job-template.json'), '--parameters', `@${path}`, ...azScope]);
    await rm(path, { force: true });
    const started = await az(['rest', '--method', 'post', '--url', `https://management.azure.com${id}/start?api-version=2025-01-01`, ...azScope]);
    if (!started?.id?.startsWith(`${id}/executions/`)) throw new Error('deployment.job_start_not_confirmed');
    const deadline = Date.now() + 1800000;
    while (Date.now() < deadline) {
      if (leaseLost || stopping) throw new Error('deployment.executor_stopped');
      const result = await az(['rest', '--method', 'get', '--url', `https://management.azure.com${started.id}?api-version=2025-01-01`, ...azScope]);
      const status = result.properties?.status;
      if (status === 'Succeeded') {
        // Remove the short-lived privileged job and its secrets after success.
        await az(['rest', '--method', 'delete', '--url', `https://management.azure.com${id}?api-version=2025-01-01`, ...azScope]);
        return;
      }
      if (['Failed', 'Stopped', 'Degraded'].includes(status)) {
        throw new Error(jobStatusCode ?? 'deployment.job_failed');
      }
      await pause(5000);
    }
    throw new Error('deployment.job_timed_out');
  }
  try {
    await stage('validate', async () => {
      if (job.document.profile.target.scopeId.toLowerCase() !== expectedScope.toLowerCase() || job.image !== receipt.image || job.document.profile.target.provider !== 'azure' || job.document.profile.target.region !== receipt.location) throw new Error('deployment.bootstrap_scope_mismatch');
      const bootstrap = await az(['rest', '--method', 'get', '--url', `https://management.azure.com${expectedScope}/providers/Microsoft.App/containerApps/${receipt.name}?api-version=2025-01-01`, ...azScope]);
      const managedEnvironmentId = bootstrap.properties.managedEnvironmentId;
      if (!managedEnvironmentId.toLowerCase().startsWith(expectedScope.toLowerCase() + '/providers/microsoft.app/managedenvironments/')) throw new Error('deployment.environment_scope_mismatch');
      const environment = await az(['rest', '--method', 'get', '--url', `https://management.azure.com${managedEnvironmentId}?api-version=2025-01-01`, ...azScope]);
      const registry = bootstrap.properties.configuration.registries.find(registry => job.image.startsWith(registry.server + '/'));
      if (!registry || !registry.identity.toLowerCase().startsWith(expectedScope.toLowerCase() + '/providers/microsoft.managedidentity/userassignedidentities/')) throw new Error('deployment.registry_identity_scope_mismatch');
      context = { name: receipt.name, location: receipt.location, managedEnvironmentId, defaultDomain: environment.properties.defaultDomain, pullIdentityId: registry.identity, registryHost: registry.server, ...(receipt.hostImages ? { hostImages: receipt.hostImages } : {}), ...(receipt.skillBundleLockDigest ? { skillBundleLockDigest: receipt.skillBundleLockDigest } : {}) };
      const inputs = JSON.parse(await readFile(inputsPath, 'utf8'));
      const profile = deploymentProfileSchema.parse(job.document.profile);
      if (!telemetryConfigured(profile)) throw new Error('deployment.telemetry_binding_required');
      const documents = profile.intelligence.documentServices?.azure;
      if (documents && (documents.layout || documents.modelExtraction || documents.factory)) {
        if (!documents.resourceId) throw new Error('deployment.document_account_required');
        const provisioner = new AzureProvisioner({ receipt, directory, check: () => { if (leaseLost || stopping) throw new Error('deployment.executor_stopped'); } });
        provisioner.profile = profile;
        provisioner.tags = { 'integralflow.bootstrap': receipt.name, 'integralflow.environment': profile.environmentId, 'integralflow.component': 'document-identity' };
        context.documents = await provisioner.documentRuntime(documents, azureBaseName(receipt.name));
      }
      const trace = profile.foundation.observability;
      if (trace?.backend === 'azure_monitor') {
        const provisioner = new AzureProvisioner({ receipt, directory, check: () => { if (leaseLost || stopping) throw new Error('deployment.executor_stopped'); } });
        provisioner.profile = profile;
        provisioner.tags = { 'integralflow.bootstrap': receipt.name, 'integralflow.environment': profile.environmentId, 'integralflow.component': 'trace-identity' };
        const rest = provisioner.rest.bind(provisioner);
        const { insights } = await azureTraceComponent(rest, expectedScope, trace.applicationInsightsResourceId);
        const identityName = azureBaseName(receipt.name);
        const queryIdentityId = provisioner.resource('Microsoft.ManagedIdentity/userAssignedIdentities', `${identityName}-trace-reader`);
        const reader = await provisioner.ensure(queryIdentityId, '2023-01-31', {});
        if (!reader.properties?.principalId || !reader.properties?.clientId) throw new Error('deployment.telemetry_query_identity_required');
        await provisioner.role(trace.applicationInsightsResourceId.toLowerCase(), reader.properties.principalId, traceRoleId);
        context.observability = { queryIdentityId, queryIdentityClientId: reader.properties.clientId };
        if (trace.foundry) {
          let rawProof = inputs.foundryTraceQualification;
          if (process.env.FOUNDRY_TRACE_QUALIFICATION_JSON) {
            try { rawProof = JSON.parse(process.env.FOUNDRY_TRACE_QUALIFICATION_JSON); } catch { rawProof = undefined; }
          }
          const qualification = foundryProof(rawProof, { binding: trace.foundry, tenantId: inputs.tenantId, identity: reader });
          try {
            const projectId = await verifyFoundryPolicy(rest, expectedScope, insights, qualification);
            if (projectId) {
              // Qualification already proved the BFF identity's read permissions. Its
              // destination grant is created by the qualification operator and rechecked
              // by the probe, while the gateway receives its own invocation identity.
              const invokeIdentityId = provisioner.resource('Microsoft.ManagedIdentity/userAssignedIdentities', `${identityName}-foundry-agent`);
              const invoker = await provisioner.ensure(invokeIdentityId, '2023-01-31', {});
              if (!invoker.properties?.principalId || !invoker.properties?.clientId) throw new Error('deployment.foundry_invoke_identity_required');
              await provisioner.role(projectId.toLowerCase(), invoker.properties.principalId, foundryAgentRoleId);
              context.observability.foundry = { qualification, invokeIdentityId, invokeIdentityClientId: invoker.properties.clientId };
            }
          } catch {
            // Keep the platform exporter/reader deployable when Azure or Foundry policy
            // verification fails. There is no native capability or query binding to use.
          }
          if (!context.observability.foundry) process.stdout.write('Foundry Agent Service traces are awaiting deployment qualification. Platform Azure tracing stays enabled.\n');
        }
      }
      let keys; try { keys = JSON.parse(await readFile(join(root, 'runtime-signing-keys.json'), 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      compiled = compileAzureRuntime(job, inputs, context, keys);
      if (compiled.migration.DEPLOYMENT_SKILL_BUNDLE_LOCK_DIGEST) process.stdout.write('Development setting: the skill host bundle will be approved automatically (registry actor system:dev-auto-approval). Remove skillHost.autoApproveBundle from the runtime inputs before any shared or production use.\n');
      process.stdout.write(`Peak database connections at maximum replicas (${compiled.pooled ? 'through the pooler' : 'direct'}): ${Object.entries(compiled.connectionBudget).map(([database, count]) => `${database} ${count}`).join(', ')}. Keep these within the server's usable connections (deploy/performance.md).${compiled.queueScaling ? '' : ' Workers stay at one replica: queue scaling needs a publicly trusted database certificate.'}\n`);
      // Only the signing keys persist: later rollouts reuse them. The compiled deployment
      // (every generated password and secret) is never written to disk.
      await writeFile(join(root, 'runtime-signing-keys.json'), JSON.stringify(compiled.keys), { mode: 0o600 });
      const existing = await az(['resource', 'list', '--resource-group', receipt.resourceGroup, '--resource-type', 'Microsoft.App/containerApps', ...azScope]);
      for (const service of [...compiled.services, ...compiled.hostedServices]) {
        const previous = existing.find(resource => resource.name === service.name);
        if (previous && (previous.tags?.['integralflow.bootstrap'] !== receipt.name || previous.tags?.['integralflow.environment'] !== job.document.profile.environmentId)) throw new Error('deployment.resource_ownership_mismatch');
      }
      const factoryName = `${compiled.baseName}-factory`;
      previousFactory = existing.find(resource => resource.name === factoryName &&
        resource.tags?.['integralflow.bootstrap'] === receipt.name &&
        resource.tags?.['integralflow.environment'] === profile.environmentId &&
        resource.tags?.['integralflow.service'] === 'document-factory-worker');
      applicationUrl = compiled.applicationUrl;
    });
    await stage('migrate', async () => {
      // The migration job also creates the service logins and publishes the curated
      // provider/model registry revisions; the console's job record holds what was applied.
      await runJob('db', compiled.migration, ['apply', '--environment', job.document.profile.environmentId]);
    });
    await stage('deploy', async () => {
      const path = join(directory, 'runtime-parameters.json');
      // Scale-rule secrets are app secrets for the platform scaler only; they are not
      // exposed to the container as environment variables.
      const envOf = (environment, secrets) => [...Object.entries(environment).map(([name, value]) => ({ name, value })), ...Object.keys(secrets).map(name => ({ name, secretRef: name.toLowerCase().replaceAll('_', '-') }))];
      const deployed = [...compiled.services, ...compiled.hostedServices];
      // A hosted service's token sidecar gets its own environment; its secret is an app secret the service container never references.
      const servicesToDeploy = deployed.map(({ secrets, scaleSecrets, environment, sidecar, ...service }) => ({ ...service, cpu: String(service.cpu), env: envOf(environment, secrets), ...(sidecar ? { sidecar: { env: envOf(sidecar.environment, sidecar.secrets) } } : {}) }));
      await parameters(path, { ...commonParameters, environmentId: job.document.profile.environmentId, environmentName: context.managedEnvironmentId.split('/').at(-1), pullIdentityId: context.pullIdentityId, registryHost: context.registryHost, servicesToDeploy, secretValues: Object.fromEntries(deployed.map(service => [service.name, { ...service.secrets, ...service.scaleSecrets, ...(service.sidecar?.secrets ?? {}) }])) });
      await az(['deployment', 'group', 'create', '--resource-group', receipt.resourceGroup, '--name', `${compiled.baseName}-runtime`, '--template-file', join(root, 'runtime-template.json'), '--parameters', `@${path}`, ...azScope]);
      await rm(path, { force: true });
      if (previousFactory && compiled.hostedServices.some(service => service.entrypoint === 'document-factory-worker')) {
        const state = await az(['containerapp', 'show', '--name', previousFactory.name, '--resource-group', receipt.resourceGroup, ...azScope]);
        if (state.properties?.runningStatus === 'Stopped') await az(['rest', '--method', 'post', '--url', `https://management.azure.com${previousFactory.id}/start?api-version=2025-07-01`, ...azScope]);
      }
    });
    await stage('verify', async () => {
      const dispatcher = compiled.services.find(service => service.entrypoint === 'runtime-worker');
      const env = { ...Object.fromEntries(Object.entries(dispatcher.environment).filter(([key]) => key.startsWith('WORKLOAD_'))), WORKLOAD_OAUTH_CLIENT_SECRET: dispatcher.secrets.WORKLOAD_OAUTH_CLIENT_SECRET, SERVICE_NAME: 'runtime-verify', INTEGRALFLOW_RUNTIME_LAUNCH: 'true', DEPLOYMENT_JOB_ID: job.id, DEPLOYMENT_RUNTIME_ENDPOINT: compiled.runtimeEndpoint,
        INTEGRALFLOW_PRIVATE_FILES: JSON.stringify(compiled.inputs.databaseCaPem ? { 'database-ca.pem': Buffer.from(compiled.inputs.databaseCaPem).toString('base64') } : {}),
        ...(compiled.inputs.databaseCaPem ? { NODE_EXTRA_CA_CERTS: '/tmp/integralflow-secrets/database-ca.pem' } : {}),
        DEPLOYMENT_VERIFY_TARGETS: " " + JSON.stringify(compiled.services.map(service => `https://${service.name}.${service.external ? '' : 'internal.'}${context.defaultDomain}`)),
        DEPLOYMENT_RUNTIME_CHECKPOINT_BACKEND: compiled.services.find(service => service.entrypoint === 'runtime-host')?.environment.RUNTIME_CHECKPOINT_BACKEND ?? 'external',
        ...(job.document.profile.intelligence.documentServices ? { DEPLOYMENT_VERIFY_DOCUMENT_STUDIO: compiled.services.find(service => service.entrypoint === 'control-api').environment.CONTROL_API_URL } : {}),
        DEPLOYMENT_VERIFY_HOSTS: " " + JSON.stringify(compiled.hostedServices.map(service => `https://${service.name}.internal.${context.defaultDomain}`)) };
      // Wait until revisions are healthy before creating the verification job.
      for (const service of [...compiled.services, ...compiled.hostedServices]) {
        const deadline = Date.now() + 300000; let ready = false;
        while (Date.now() < deadline) {
          const current = await az(['rest', '--method', 'get', '--url', `https://management.azure.com${expectedScope}/providers/Microsoft.App/containerApps/${service.name}?api-version=2025-01-01`, ...azScope]);
          if (current.properties.template?.containers?.[0]?.image !== (service.image ?? job.image) || !current.properties.template?.containers?.[0]?.env?.some(variable => variable.name === 'INTEGRALFLOW_DEPLOYMENT_ID' && variable.value === job.id)) throw new Error('deployment.revision_identity_mismatch');
          if (current.properties.runningStatus === 'Running' && typeof current.properties.latestRevisionName === 'string' && current.properties.latestRevisionName.length > 0 && current.properties.latestReadyRevisionName === current.properties.latestRevisionName) { ready = true; break; }
          if (leaseLost || stopping) throw new Error('deployment.executor_stopped');
          await pause(5000);
        }
        if (!ready) throw new Error('deployment.revision_not_ready');
      }
      if (env.DEPLOYMENT_VERIFY_DOCUMENT_STUDIO) jobStatusCode = 'deployment.runtime_or_document_verification_failed';
      await runJob('verify', env, []);
      const factory = compiled.hostedServices.find(service => service.entrypoint === 'document-factory-worker');
      if (previousFactory && !factory) {
        const appUrl = `https://management.azure.com${previousFactory.id}`;
        const state = () => az(['rest', '--method', 'get', '--url', `${appUrl}?api-version=2025-07-01`, ...azScope]);
        if ((await state()).properties?.runningStatus !== 'Stopped') {
          await az(['rest', '--method', 'post', '--url', `${appUrl}/stop?api-version=2025-07-01`, ...azScope]);
          const deadline = Date.now() + 180000;
          while ((await state()).properties?.runningStatus !== 'Stopped') {
            if (leaseLost || stopping || Date.now() >= deadline) throw new Error('deployment.document_factory_stop_not_verified');
            await pause(5000);
          }
        }
      }
    });
    await report('succeeded');
    process.stdout.write(`Runtime deployed: ${applicationUrl}\nGoverned connections and schedules remain disabled until their process-flow bindings are qualified.\n`);
  } catch (error) {
    const code = /^(deployment|database|migration)\.[a-z_]+$/.test(error.message ?? '') ? error.message : 'deployment.configuration_or_execution_failed';
    await appendFile(diagnosticPath, JSON.stringify({ at: new Date().toISOString(), code, issues: error.issues?.map(issue => ({ path: issue.path, message: issue.message })) }) + '\n', { mode: 0o600 });
    failureCode = code;
    await report('failed').catch(() => undefined);
    process.stderr.write(`Deployment stopped; existing resources retained. Private diagnostics: ${diagnosticPath}\n`);
    process.exitCode = 1;
  } finally { clearInterval(heartbeat); }
  if (flags.once) break;
}
