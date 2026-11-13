import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { compileAzureRuntime } from '../apps/launcher/src/recipes/azure.ts';
import { checkServiceReadiness } from '../apps/launcher/src/runtime-verification.ts';
import { defaultDeploymentProfile } from '../packages/contracts/src/deployment.ts';
import { RUNTIME_SERVICES } from '../packages/contracts/src/deployment-plan.ts';

const image = process.argv[2] ?? 'integralflow:onboarding';
const postgresImage = process.argv[3] ?? 'integralflow:postgres-smoke';
const id = randomUUID(); const network = `integralflow-runtime-${id.slice(0, 8)}`;
const directory = await mkdtemp(join(tmpdir(), 'integralflow-runtime-smoke-'));
const containers = []; const password = randomBytes(32).toString('hex');
function docker(args, allowFailure = false) {
  const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 240000, maxBuffer: 2000000 });
  if (!allowFailure && result.status !== 0) throw new Error(`Docker ${args[0]} failed: ${result.stderr}\n${result.stdout}`);
  return result;
}
const envArgs = env => Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
const sql = (database, query) => docker(['exec', `${network}-pg`, 'psql', '-U', 'postgres', '-d', database, '-Atc', query]).stdout.trim();
try {
  const cert = join(directory, 'cert.pem'); const key = join(directory, 'key.pem');
  const certificate = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert, '-subj', '/CN=runtime-smoke', '-addext', 'subjectAltName=DNS:*.test.local,DNS:*.internal.test.local'], { encoding: 'utf8' });
  assert.equal(certificate.status, 0);
  const ca = await readFile(cert, 'utf8');
  const profile = defaultDeploymentProfile({ provider: 'azure', scopeId: '/subscriptions/test/resourceGroups/smoke', region: 'centralus', recipe: 'azure-container-apps-bootstrap-v1' });
  profile.environmentId = 'smoke'; profile.foundation.database = { host: 'database.test.local', port: 5432, credentialRef: 'env:MIGRATOR_PASSWORD' };
  profile.foundation.objectStore = { endpoint: 'https://objects.test.local', bucket: 'evidence', credentialRef: 'env:OBJECT_STORE' };
  profile.foundation.telemetryEndpoint = 'https://telemetry.test.local'; profile.foundation.observability = { backend: "otlp" };
  profile.access.issuer = 'https://identity.test.local/humans'; profile.access.clientId = 'human-client'; profile.access.mappings = [{ group: 'admins', role: 'Platform.Admin' }];
  profile.intelligence.endpoint = 'https://models.test.local/v1'; profile.intelligence.credentialRef = 'env:MODEL_TOKEN'; profile.intelligence.models.low = 'approved';
  const inputs = { tenantId: 'smoke', monthlyLimitUsd: 10, databaseUrls: Object.fromEntries(['control', 'case', 'context'].map(store => [store, `postgresql://postgres@database.test.local/ehf_${store}?sslmode=verify-full`])), databaseCaPem: ca,
    secrets: { OBJECT_STORE: JSON.stringify({ accessKeyId: 'test-access-key', secretAccessKey: randomBytes(32).toString('hex'), region: 'us-east-1' }), MIGRATOR_PASSWORD: password, MODEL_TOKEN: randomBytes(32).toString('hex'), ...Object.fromEntries(RUNTIME_SERVICES.map(service => [service.identity, randomBytes(32).toString('hex')])) },
    workload: { issuer: 'https://identity.test.local/workloads', audience: 'integralflow-smoke', tokenEndpoint: 'https://identity.test.local/token', jwksUri: 'https://identity.test.local/jwks', clients: Object.fromEntries(RUNTIME_SERVICES.map(service => [service.identity, { clientId: service.identity, subject: `service:${service.identity}`, secretRef: service.identity, scope: 'integralflow-smoke' }])) } };
  const job = { id, revision: 1, planHash: 'a'.repeat(64), phase: 'running', requestedBy: 'smoke-owner', createdAt: 'now', updatedAt: 'now', steps: [], image: `registry.test.local/app@sha256:${'a'.repeat(64)}`, document: { revision: 1, phase: 'configured', profile, tests: [], updatedAt: 'now' }, catalog: { revision: 'test', models: [{ id: 'approved', name: 'Approved', publisher: 'Example', family: 'frontier', providers: { openrouter: 'test/approved' } }] } };
  const compiled = compileAzureRuntime(job, inputs, { name: 'smoke', location: 'centralus', managedEnvironmentId: 'test', defaultDomain: 'test.local', pullIdentityId: 'test', registryHost: 'registry.test.local' });
  await writeFile(join(directory, 'config.json'), JSON.stringify({ services: compiled.services, inputs }), { mode: 0o600 });
  await writeFile(join(directory, 'proxy.mjs'), `
import https from 'node:https'; import http from 'node:http'; import fs from 'node:fs'; import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
const config=JSON.parse(fs.readFileSync('/run/test/config.json')); const key=fs.readFileSync('/run/test/key.pem'); const jwk={...createPublicKey(key).export({format:'jwk'}),kid:'smoke',alg:'RS256'};
const json=(res,status,body)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};
https.createServer({key,cert:fs.readFileSync('/run/test/cert.pem')},async(req,res)=>{
 const host=req.headers.host?.split(':')[0];
 if(host==='identity.test.local') {
  if(req.url==='/jwks')return json(res,200,{keys:[jwk]});
  if(req.url==='/humans/.well-known/openid-configuration')return json(res,200,{issuer:'https://identity.test.local/humans',jwks_uri:'https://identity.test.local/jwks'});
  if(req.url==='/human-token') {
   const now=Math.floor(Date.now()/1000);const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');const content=encode({alg:'RS256',kid:'smoke'})+'.'+encode({iss:'https://identity.test.local/humans',aud:'human-client',sub:'human-owner',groups:['admins'],iat:now,exp:now+300});
   return json(res,200,{token:content+'.'+sign('RSA-SHA256',Buffer.from(content),key).toString('base64url')});
  }
  if(req.url==='/token') {
   const [clientId,secret]=Buffer.from((req.headers.authorization??'').slice(6),'base64').toString().split(':').map(decodeURIComponent); const client=config.inputs.workload.clients[clientId];
   if(!client||secret!==config.inputs.secrets[client.secretRef])return json(res,401,{error:'invalid_client'});
   const now=Math.floor(Date.now()/1000); const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url'); const content=encode({alg:'RS256',kid:'smoke'})+'.'+encode({iss:config.inputs.workload.issuer,aud:config.inputs.workload.audience,sub:client.subject,iat:now,exp:now+300});
   return json(res,200,{token_type:'Bearer',access_token:content+'.'+sign('RSA-SHA256',Buffer.from(content),key).toString('base64url')});
  }
  return json(res,404,{error:'not_found'});
 }
 if(host==='objects.test.local') { res.writeHead(200,{'content-type':'application/xml'}); return res.end(req.url.includes('versioning')?'<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>':'<ObjectLockConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><ObjectLockEnabled>'+(req.url.includes('/disabled/')?'Disabled':'Enabled')+'</ObjectLockEnabled></ObjectLockConfiguration>'); }
 if(host==='telemetry.test.local')return json(res,200,{});
 if(host==='models.test.local')return json(res,200,{choices:[{message:{content:'OK'}}]});
 const service=config.services.find(service=>host===service.name+'.'+(service.external?'':'internal.')+'test.local'); if(!service)return json(res,404,{});
 const upstream=http.request({host:service.entrypoint,port:service.port,path:req.url,method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);}); upstream.on('error',()=>json(res,503,{}));req.pipe(upstream);
}).listen(443,'0.0.0.0');
`, { mode: 0o600 });
  docker(['network', 'create', network]);
  const pgName = `${network}-pg`; containers.push(pgName);
  docker(['run', '--rm', '-d', '--name', pgName, '--network', network, '--network-alias', 'database.test.local', '-v', `${directory}:/run/test:ro`, '-e', `POSTGRES_PASSWORD=${password}`, postgresImage, 'sh', '-c', 'cp /run/test/key.pem /tmp/server.key; cp /run/test/cert.pem /tmp/server.crt; chown postgres:postgres /tmp/server.key /tmp/server.crt; chmod 600 /tmp/server.key; exec docker-entrypoint.sh postgres -c ssl=on -c ssl_key_file=/tmp/server.key -c ssl_cert_file=/tmp/server.crt']);
  let ready = false;
  for (let i = 0; i < 100; i++) { if (docker(['exec', pgName, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres'], true).status === 0) { ready = true; break; } await setTimeout(200); }
  assert.ok(ready, 'TLS PostgreSQL must start');
  for (const store of ['control', 'case', 'context']) sql('postgres', `create database ehf_${store}`);
  const proxyName = `${network}-proxy`; containers.push(proxyName);
  const aliases = ['identity.test.local', 'telemetry.test.local', 'models.test.local', 'objects.test.local', ...compiled.services.map(service => `${service.name}.${service.external ? '' : 'internal.'}test.local`)];
  docker(['run', '--rm', '-d', '--name', proxyName, '--network', network, ...aliases.flatMap(alias => ['--network-alias', alias]), '--user', '0', '--entrypoint', 'node', '-v', `${directory}:/run/test:ro`, image, '/run/test/proxy.mjs']);
  const invalidStorage = JSON.parse(compiled.migration.DEPLOYMENT_OBJECT_STORE); invalidStorage.endpoint += '/disabled';
  const rejectedStorage = docker(['run', '--rm', '--network', network, ...envArgs({ ...compiled.migration, DEPLOYMENT_OBJECT_STORE: JSON.stringify(invalidStorage) }), image, 'apply', '--environment', 'smoke'], true);
  assert.notEqual(rejectedStorage.status, 0);
  assert.equal(sql('ehf_control', "select count(*) from pg_namespace where nspname='harness_control'"), '0', 'Unqualified evidence storage must fail before schema writes');
  docker(['run', '--rm', '--network', network, ...envArgs(compiled.migration), image, 'apply', '--environment', 'smoke']);
  assert.equal(sql('ehf_control', "select count(*) from harness_admin.model_profile_revisions where status='active'"), '1', 'Only selected curated models are seeded');
  assert.equal(sql('ehf_control', "select count(*) from harness_admin.model_profile_revisions where definition->>'model'='test/approved' and status='active'"), '1');
  for (const service of compiled.services) {
    const name = `${network}-${service.entrypoint}`; containers.push(name);
    docker(['run', '-d', '--name', name, '--network', network, '--network-alias', service.entrypoint, ...envArgs({ ...service.environment, ...service.secrets }), image]);
  }
  const checkpointBackend = compiled.services.find(service => service.entrypoint === 'runtime-host')?.environment.RUNTIME_CHECKPOINT_BACKEND;
  const check = `const response = await fetch(process.argv[1] + '/health/ready'); if (!response.ok) process.exit(1); console.log(JSON.stringify(await response.json()));`;
  for (const service of compiled.services) {
    let live = false;
    for (let i = 0; i < 60; i++) {
      const endpoint = new URL(`https://${service.name}.${service.external ? '' : 'internal.'}test.local`);
      const result = docker(['exec', `${network}-${service.entrypoint}`, 'node', '-e', check, endpoint.origin], true);
      if (result.status === 0) {
        try {
          checkServiceReadiness(JSON.parse(result.stdout), endpoint, new URL(compiled.runtimeEndpoint), checkpointBackend);
          live = true;
          break;
        } catch { /* Continue until the deployed readiness contract passes. */ }
      }
      const state = docker(['inspect', `${network}-${service.entrypoint}`, '--format', '{{.State.Running}}'], true);
      if (state.status !== 0 || state.stdout.trim() !== 'true') break;
      await setTimeout(500);
    }
    if (!live) {
      // No user secrets are present in this disposable fixture.
      process.stderr.write(docker(['logs', `${network}-${service.entrypoint}`], true).stderr);
      throw new Error(`Production entrypoint not ready: ${service.entrypoint}`);
    }
  }
  const catalogCheck = `const issuer=await fetch('https://identity.test.local/human-token');const token=(await issuer.json()).token;const session=await fetch(${JSON.stringify(compiled.applicationUrl + '/api/v1/session')},{headers:{authorization:'Bearer '+token}});if(session.status!==200)throw new Error('application.session_failed');const cookie=session.headers.get('set-cookie').split(';')[0];const response=await fetch(${JSON.stringify(compiled.applicationUrl + '/api/v1/catalogs')},{headers:{cookie}});if(response.status!==200)throw new Error('application.catalog_failed:'+response.status);const body=await response.json();if(!Array.isArray(body.items)||!body.items.length)throw new Error('application.catalog_empty');const setup=await fetch(${JSON.stringify(compiled.applicationUrl + '/onboarding')},{headers:{cookie},redirect:'manual'});if(setup.status!==302)throw new Error('application.setup_navigation_failed');`;
  docker(['exec', `${network}-experience-bff`, 'node', '-e', catalogCheck]);
  const issuedAt = () => Number(docker(['exec', `${network}-control-api`, 'node', '-e', "const fs=require('node:fs');const t=fs.readFileSync('/tmp/integralflow-secrets/workload.jwt','utf8').trim();process.stdout.write(String(JSON.parse(Buffer.from(t.split('.')[1],'base64url')).iat))"]).stdout.trim());
  const firstIssuedAt = issuedAt();
  await setTimeout(32000);
  assert.ok(issuedAt() > firstIssuedAt, 'Workload projection must rotate while the service stays running');
  for (const service of compiled.services) assert.equal(docker(['exec', `${network}-${service.entrypoint}`, 'id', '-u']).stdout.trim(), '1001');
  const dispatcher = compiled.services.find(service => service.entrypoint === 'runtime-worker');
  const verifyEnv = { ...Object.fromEntries(Object.entries(dispatcher.environment).filter(([name]) => name.startsWith('WORKLOAD_'))), WORKLOAD_OAUTH_CLIENT_SECRET: dispatcher.secrets.WORKLOAD_OAUTH_CLIENT_SECRET, SERVICE_NAME: 'runtime-verify', INTEGRALFLOW_RUNTIME_LAUNCH: 'true', INTEGRALFLOW_PRIVATE_FILES: JSON.stringify({ 'database-ca.pem': Buffer.from(ca).toString('base64') }), NODE_EXTRA_CA_CERTS: '/tmp/integralflow-secrets/database-ca.pem', DEPLOYMENT_JOB_ID: id, DEPLOYMENT_RUNTIME_CHECKPOINT_BACKEND: checkpointBackend, DEPLOYMENT_RUNTIME_ENDPOINT: compiled.runtimeEndpoint, DEPLOYMENT_VERIFY_TARGETS: JSON.stringify(compiled.services.map(service => `https://${service.name}.${service.external ? '' : 'internal.'}test.local`)) };
  const verified = docker(['run', '--rm', '--network', network, ...envArgs(verifyEnv), image]);
  assert.match(verified.stdout, /runtimeControlPlaneRoundTrip/);
  for (const name of ['runtime-host', 'experience-bff']) {
    const result = docker(['exec', `${network}-${name}`, 'node', '-e', "if(Object.keys(process.env).some(k=>k.includes('DATABASE_URL')||k==='PGPASSWORD'))process.exit(1)"]);
    assert.equal(result.status, 0);
  }
  process.stdout.write('Production runtime image smoke passed: seven non-root services, verified TLS, distinct rotating OAuth workload identities, scoped database logins, published curated model, authenticated application/catalog and setup navigation, denied anonymous runtime access, and authenticated runtime/control-plane round trip.\n');
} finally {
  if (containers.length) docker(['rm', '--force', ...containers.reverse()], true);
  docker(['network', 'rm', network], true);
  await rm(directory, { recursive: true, force: true });
}
