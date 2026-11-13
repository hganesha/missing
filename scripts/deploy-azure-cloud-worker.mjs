/** Private, single-replica executor. The public console holds no provisioning identity. */
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as pause } from 'node:timers/promises';
import { AzureProvisioner } from './provision-azure-resources.mjs';
const exec = promisify(execFile);
const root = process.env.EXECUTOR_STATE_DIR ?? '/worker-state';
await mkdir(root, { recursive: true, mode: 0o700 });
const receipt = JSON.parse(process.env.EXECUTOR_RECEIPT ?? await readFile(join(root, 'launch.json'), 'utf8'));
const executorToken = process.env.EXECUTOR_TOKEN ?? (await readFile(join(root, 'executor-token'), 'utf8')).trim();
if (!/^[a-f0-9]{64}$/.test(executorToken) || !/^https:\/\//.test(receipt.url)) throw new Error('Invalid executor bootstrap');
if (process.env.AZURE_CLIENT_ID) await exec('az', ['login', '--identity', '--client-id', process.env.AZURE_CLIENT_ID, '--allow-no-subscriptions', '--output', 'none']);
const expected = { scopeId: `/subscriptions/${receipt.subscription}/resourceGroups/${receipt.resourceGroup}`, image: receipt.image };
const request = async (path, body) => {
  const response = await fetch(new URL(path, receipt.url), { method: 'POST', headers: { authorization: `Bearer ${executorToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000), redirect: 'error' });
  if (!response.ok) throw Object.assign(new Error('Executor console request failed'), { status: response.status });
  return response.json();
};
await writeFile(join(root, 'launch.json'), JSON.stringify(receipt), { mode: 0o600 });
await writeFile(join(root, 'executor-token'), executorToken, { mode: 0o600 });
let stopping = false; let child;
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { stopping = true; child?.kill(signal); });
while (!stopping) {
  try {
    const lease = await request('/api/provisioning/lease', expected);
    if (lease.job) {
      let lostLease = false; let misses = 0;
      const report = (phase, resource) => request('/api/provisioning/report', { id: lease.job.id, leaseToken: lease.leaseToken, phase, ...(resource ? { resource } : {}) });
      const timer = setInterval(() => { void report('running').then(() => { misses = 0; }).catch(() => { if (++misses >= 3) lostLease = true; }); }, 30000);
      const provisioner = new AzureProvisioner({ receipt, directory: root, vaultUri: process.env.ONBOARDING_VAULT_URI, catalog: JSON.parse(await readFile('config/onboarding-models.json', 'utf8')), check: () => { if (stopping || lostLease) throw new Error('Executor stopped'); } });
      try { const succeeded = await provisioner.run(lease.job, resource => report('running', resource)); await report(succeeded ? 'succeeded' : 'failed'); }
      catch { await report('failed').catch(() => undefined); }
      finally { clearInterval(timer); }
    }
    const context = await request('/api/provisioning/context', expected);
    if (context.deploymentQueued) {
      const provisioner = new AzureProvisioner({ receipt, directory: root, vaultUri: process.env.ONBOARDING_VAULT_URI });
      provisioner.configuration = context.configuration;
      const inputPath = join(root, 'runtime-inputs.json');
      try {
        const inputs = await provisioner.runtimeInputs(context.profile);
        await writeFile(inputPath, JSON.stringify(inputs), { mode: 0o600 });
        child = spawn(process.execPath, ['--import', 'tsx', 'scripts/deploy-runtime.mjs', 'worker', '--receipt', join(root, 'launch.json'), '--inputs', inputPath, '--once'], { cwd: resolve('.'), stdio: ['ignore', 'inherit', 'inherit'] });
        await new Promise((accept, reject) => { child.once('exit', accept); child.once('error', reject); });
      } catch {
        // Binding preparation is part of validation. Do not leave a queued job hanging.
        const failed = await request('/api/deployment/lease', expected);
        if (failed.job) await request('/api/deployment/report', { id: failed.job.id, leaseToken: failed.leaseToken, phase: 'failed', failureCode: 'deployment.secret_binding_missing', steps: [{ name: 'validate', status: 'failed' }] });
      } finally { child = undefined; await rm(inputPath, { force: true }); }
    }
  } catch (error) {
    // Diagnostics never include CLI stderr, tokens, request bodies or provider responses.
    process.stderr.write(`Executor needs attention (${[401, 403, 409].includes(error.status) ? 'console authorization or image/scope changed' : 'resource operation or connection failed'}).\n`);
  }
  await pause(5000);
}
