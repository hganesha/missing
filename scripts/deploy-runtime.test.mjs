import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import https from 'node:https';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildLauncher } from '../apps/launcher/src/app.ts';
import { SetupStore } from '../apps/launcher/src/store.ts';
import { DEPLOYMENT_STEPS } from '../apps/launcher/src/deployment-jobs.ts';
import { defaultDeploymentProfile } from '../packages/contracts/src/deployment.ts';
import { RUNTIME_SERVICES } from '../packages/contracts/src/deployment-plan.ts';
const exec = promisify(execFile);
const sha = value => createHash('sha256').update(value).digest('hex');

async function executorRun({ hosted }) {
  const directory = await mkdtemp(join(tmpdir(), 'integralflow-executor-'));
  let app; let server;
  try {
    const keyPath = join(directory, 'key.pem'); const certPath = join(directory, 'cert.pem');
    assert.equal(spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', keyPath, '-out', certPath, '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' }).status, 0);
    server = https.createServer({ key: await readFile(keyPath), cert: await readFile(certPath) }, async (request, reply) => {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const result = await app.inject({ method: request.method, url: request.url, headers: request.headers, payload: Buffer.concat(chunks) });
      reply.writeHead(result.statusCode, result.headers); reply.end(result.rawPayload);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `https://localhost:${server.address().port}`;
    const subscription = '11111111-1111-4111-8111-111111111111'; const resourceGroup = 'rg-runtime-test'; const bootstrapName = 'integralflow-test';
    const scope = `/subscriptions/${subscription}/resourceGroups/${resourceGroup}`; const image = `registry.example.com/app@sha256:${'a'.repeat(64)}`;
    const profile = defaultDeploymentProfile({ provider: 'azure', scopeId: scope, region: 'centralus', recipe: 'azure-container-apps-bootstrap-v1' });
    profile.foundation.database = { host: 'database.example.com', port: 5432, credentialRef: 'env:DB_PASSWORD' };
    profile.foundation.objectStore = { endpoint: 'https://objects.example.com', bucket: 'evidence', credentialRef: 'env:OBJECT_STORE' };
    profile.foundation.telemetryEndpoint = 'https://telemetry.example.com'; profile.foundation.observability = { backend: "otlp" }; profile.access.issuer = 'https://identity.example.com'; profile.access.clientId = 'human-client';
    profile.intelligence.credentialRef = 'env:MODEL_TOKEN'; profile.intelligence.models.low = 'approved';
    const catalog = { revision: 'test', models: [{ id: 'approved', name: 'Approved', publisher: 'Example', family: 'frontier', providers: { openrouter: 'test/model' } }] };
    const state = { claimed: true, identityVerified: true, sessions: [{ hash: sha('owner'), csrf: 'csrf', subject: 'owner', method: 'oidc', expires: Date.now() + 600000 }], events: [], document: { revision: 1, phase: 'configured', profile, updatedAt: new Date().toISOString(), tests: [{ kind: 'inference', revision: 1, catalogRevision: 'test', checkedAt: new Date().toISOString(), status: 'passed', message: 'verified' }] } };
    const store = new SetupStore(join(directory, 'setup'), () => structuredClone(state));
    const token = 'b'.repeat(64);
    app = buildLauncher({ env: { ONBOARDING_PUBLIC_ORIGIN: origin, ONBOARDING_BOOTSTRAP_SHA256: sha('bootstrap'), ONBOARDING_EXECUTOR_SHA256: sha(token), IMAGE_REFERENCE: image, DEPLOYMENT_SCOPE: scope }, store, catalog });
    const owner = { cookie: 'integralflow_setup=owner', origin, 'x-csrf-token': 'csrf', 'if-match': '"1"' };
    const review = (await app.inject({ url: '/api/onboarding/deployment', headers: owner })).json();
    assert.equal((await app.inject({ method: 'POST', url: '/api/onboarding/deployment', headers: owner, payload: { environmentId: profile.environmentId, planHash: review.planHash } })).statusCode, 202);
    const bootstrapDirectory = join(directory, 'bootstrap'); await mkdir(bootstrapDirectory, { mode: 0o700 });
    await writeFile(join(bootstrapDirectory, 'executor-token'), token, { mode: 0o600 });
    const receiptPath = join(bootstrapDirectory, 'launch.json');
    const hostImages = { 'skill-host': `registry.example.com/skills@sha256:${'c'.repeat(64)}`, 'evidence-pipeline': `registry.example.com/documents@sha256:${'d'.repeat(64)}` };
    await writeFile(receiptPath, JSON.stringify({ name: bootstrapName, subscription, resourceGroup, location: 'centralus', image, ...(hosted ? { hostImages } : {}), url: origin + '/onboarding' }), { mode: 0o600 });
    const inputsPath = join(directory, 'runtime-inputs.json');
    await writeFile(inputsPath, JSON.stringify({ tenantId: 'tenant', monthlyLimitUsd: 25, databaseUrls: Object.fromEntries(['control', 'case', 'context'].map(store => [store, `postgresql://migrator@database.example.com/${store}?sslmode=verify-full`])), secrets: { DB_PASSWORD: 'private-database-password', MODEL_TOKEN: 'private-model-token', OBJECT_STORE: JSON.stringify({ accessKeyId: 'test-key', secretAccessKey: 'test-secret', region: 'us-east-1' }), ...Object.fromEntries(RUNTIME_SERVICES.map(service => [service.identity, `private-workload-credential-${service.identity}`])) }, workload: { issuer: 'https://identity.example.com', audience: 'services', tokenEndpoint: 'https://identity.example.com/token', jwksUri: 'https://identity.example.com/jwks', clients: Object.fromEntries(RUNTIME_SERVICES.map(service => [service.identity, { clientId: service.identity, subject: `service:${service.identity}`, secretRef: service.identity, scope: 'services' }])) } }), { mode: 0o600 });
    if (hosted) {
      const inputs = JSON.parse(await readFile(inputsPath, 'utf8'));
      inputs.secrets = { ...inputs.secrets, SKILL_HOST_SECRET: 'private-skill-host-client-secret', EVIDENCE_TOKEN: 'private-evidence-token-'.padEnd(64, 'x'), EVIDENCE_KEY: Buffer.alloc(32, 9).toString('base64') };
      inputs.workload.clients['skill-host'] = { clientId: 'skill-host', subject: 'service:skill-host', secretRef: 'env:SKILL_HOST_SECRET', scope: 'integralflow' };
      inputs.hostedServices = { skillHost: {}, evidencePipeline: { tokenRef: 'env:EVIDENCE_TOKEN', dataKeyRef: 'env:EVIDENCE_KEY' } };
      await writeFile(inputsPath, JSON.stringify(inputs), { mode: 0o600 });
    }
    const bin = join(directory, 'bin'); await mkdir(bin);
    await writeFile(join(bin, 'az'), `#!/usr/bin/env node
const fs=require('node:fs');const args=process.argv.slice(2);const after=name=>args[args.indexOf(name)+1];const scope=${JSON.stringify(scope)};const bootstrapName=${JSON.stringify(bootstrapName)};const deploymentId=${JSON.stringify((await store.read()).deployment.id)};const image=${JSON.stringify(image)};
const parameters=args.find(arg=>arg.startsWith('@'));
fs.appendFileSync(process.env.FAKE_AZ_LOG,JSON.stringify({command:args.slice(0,3),url:args.includes('--url')?after('--url'):null,deployment:args.includes('--name')?after('--name'):null,parameters:parameters?JSON.parse(fs.readFileSync(parameters.slice(1),'utf8')).parameters:null})+'\\n');
let result={};
if(args[0]==='bicep')fs.writeFileSync(after('--outfile'),'{}');
if(args[0]==='resource')result=[];
if(args[0]==='deployment'){
 const parameters=JSON.parse(fs.readFileSync(after('--parameters').slice(1),'utf8')).parameters;
 const name=parameters.name?.value;
 if(name && (!/^[a-z][a-z0-9-]{0,30}[a-z0-9]$/.test(name) || name.includes('--'))){process.stderr.write('Invalid Container Apps job name');process.exit(1);}
 const targets=parameters.environmentVariables?.value.DEPLOYMENT_VERIFY_TARGETS;
 if(targets && (targets.startsWith('[') || JSON.parse(targets).length!==7)){process.stderr.write('Verification targets must remain literal JSON through ARM copy expansion');process.exit(1);}
}
if(args[0]==='rest'){
 const url=after('--url');
 if(url.includes('/containerApps/'+bootstrapName+'?'))result={properties:{managedEnvironmentId:scope+'/providers/Microsoft.App/managedEnvironments/test',configuration:{registries:[{server:'registry.example.com',identity:scope+'/providers/Microsoft.ManagedIdentity/userAssignedIdentities/pull'}]}}};
 else if(url.includes('/managedEnvironments/'))result={properties:{defaultDomain:'environment.example.com'}};
 else if(url.includes('/start?'))result={id:url.replace('https://management.azure.com','').replace('/start?api-version=2025-01-01','/executions/test')};
 else if(url.includes('/executions/'))result={properties:{status:'Succeeded'}};
 else if(url.includes('/containerApps/')){const hosts=${JSON.stringify(hostImages)};const own=url.includes('-skills?')?hosts['skill-host']:url.includes('-docs?')?hosts['evidence-pipeline']:image;result={properties:{runningStatus:'Running',latestReadyRevisionName:'ready',latestRevisionName:'ready',template:{containers:[{image:own,env:[{name:'INTEGRALFLOW_DEPLOYMENT_ID',value:deploymentId}]}]}}};}
}
process.stdout.write(JSON.stringify(result));
`, { mode: 0o700 });
    const logPath = join(directory, 'azure-operations.jsonl');
    const result = await exec(process.execPath, ['--import', 'tsx', 'scripts/deploy-runtime.mjs', 'worker', '--receipt', receiptPath, '--inputs', inputsPath, '--once'], { cwd: resolve('.'), env: { ...process.env, PATH: bin + ':' + process.env.PATH, NODE_EXTRA_CA_CERTS: certPath, FAKE_AZ_LOG: logPath }, timeout: 30000 });
    assert.match(result.stdout, /Runtime deployed:/); assert.ok(!result.stdout.includes('private-model-token')); assert.ok(!result.stdout.includes(token));
    const status = (await app.inject({ url: '/api/onboarding/deployment', headers: owner })).json();
    assert.equal(status.job.phase, 'succeeded'); assert.equal(status.runtimeReady, true); assert.equal(status.job.steps.length, DEPLOYMENT_STEPS.length);
    const operations = (await readFile(logPath, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(operations.filter(operation => operation.command[0] === 'rest' && operation.command.includes('delete')).length, 2);
    assert.ok(operations.filter(operation => operation.url).every(operation => operation.url.startsWith('https://management.azure.com' + scope + '/')));
    const keyFile = join(bootstrapDirectory, 'runtime', 'runtime-signing-keys.json'); assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
    const runtime = operations.find(operation => operation.deployment?.endsWith('-runtime')).parameters;
    const verify = operations.find(operation => operation.deployment?.includes('-verify-')).parameters;
    return { runtime, verify, hostImages };
  } finally {
    await app?.close();
    if (server) await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
}

test('operator executor applies only its reviewed bootstrap scope and reports a completed runtime deployment', async () => {
  const { runtime, verify } = await executorRun({ hosted: false });
  assert.equal(runtime.servicesToDeploy.value.length, 7);
  assert.equal(JSON.parse(verify.environmentVariables.value.DEPLOYMENT_VERIFY_HOSTS).length, 0);
});

test('operator executor deploys the skill host with a token sidecar and the evidence pipeline on its volume', async () => {
  const { runtime, verify, hostImages } = await executorRun({ hosted: true });
  const services = runtime.servicesToDeploy.value;
  const secrets = runtime.secretValues.value;
  assert.equal(services.length, 9);
  const skills = services.find(service => service.entrypoint === 'skill-host');
  const documents = services.find(service => service.entrypoint === 'evidence-pipeline');
  assert.equal(skills.image, hostImages['skill-host']); assert.equal(documents.image, hostImages['evidence-pipeline']);
  // The client secret is an app secret only the sidecar references.
  assert.ok(!skills.env.some(variable => variable.name === 'WORKLOAD_OAUTH_CLIENT_SECRET'));
  assert.ok(skills.sidecar.env.some(variable => variable.name === 'WORKLOAD_OAUTH_CLIENT_SECRET' && variable.secretRef === 'workload-oauth-client-secret'));
  assert.equal(secrets[skills.name].WORKLOAD_OAUTH_CLIENT_SECRET, 'private-skill-host-client-secret');
  assert.ok(skills.env.some(variable => variable.name === 'WORKLOAD_TOKEN_FILE'));
  assert.deepEqual(skills.mounts, [{ volumeName: 'workload-token', mountPath: '/var/run/integralflow-token' }]);
  assert.ok(!('sidecar' in documents));
  assert.deepEqual(documents.env.filter(variable => variable.secretRef).map(variable => variable.name).sort(), ['EVIDENCE_PIPELINE_TOKEN', 'KYC_DATA_KEY']);
  assert.equal(documents.volumes[0].storageName, 'evidence-pipeline-data');
  for (const [name, values] of Object.entries(secrets)) {
    if (name === skills.name) continue;
    assert.ok(!JSON.stringify(values).includes('private-skill-host-client-secret'));
  }
  const gateway = services.find(service => service.entrypoint === 'capability-gateway');
  assert.equal(secrets[gateway.name].EVIDENCE_PIPELINE_TOKEN, secrets[documents.name].EVIDENCE_PIPELINE_TOKEN);
  assert.deepEqual(JSON.parse(verify.environmentVariables.value.DEPLOYMENT_VERIFY_HOSTS), [skills, documents].map(service => `https://${service.name}.internal.environment.example.com`));
  assert.equal(JSON.parse(verify.environmentVariables.value.DEPLOYMENT_VERIFY_TARGETS).length, 7);
});
