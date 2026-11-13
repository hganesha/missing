import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';

const image = process.argv[2] ?? 'integralflow:onboarding';
const port = Number(process.env.ONBOARDING_SMOKE_PORT ?? 4301);
assert.ok(Number.isInteger(port) && port > 1024 && port < 65536);
const origin = `http://localhost:${port}`;
const suffix = randomUUID().slice(0, 8);
const name = `integralflow-onboarding-smoke-${suffix}`;
const volume = `${name}-state`;
const token = randomBytes(32).toString('hex');
const hash = createHash('sha256').update(token).digest('hex');
function docker(args, allowFailure = false) {
  const result = spawnSync('docker', args, { encoding: 'utf8' });
  if (!allowFailure && result.status !== 0) throw new Error(`Docker operation failed: ${args.slice(0, 2).join(' ')}\n${result.stderr}`);
  return result;
}
async function start() {
  docker(['run', '-d', '--name', name, '-p', `127.0.0.1:${port}:4300`, '-v', `${volume}:/app/state`, '-e', `ONBOARDING_BOOTSTRAP_SHA256=${hash}`, '-e', `ONBOARDING_PUBLIC_ORIGIN=${origin}`, image]);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const response = await fetch(`${origin}/health/ready`); if (response.ok) return; } catch { /* Wait for the container's listener. */ }
    await setTimeout(200);
  }
  throw new Error('The image did not become ready within 30 seconds');
}
try {
  docker(['volume', 'create', volume]);
  await start();
  assert.equal(docker(['exec', name, 'id', '-u']).stdout.trim(), '1001');
  const root = await fetch(`${origin}/onboarding`);
  assert.equal(root.status, 200); assert.match(root.headers.get('content-type'), /text\/html/);
  const html = await root.text(); const script = html.match(/src="([^"]+\.js)"/)[1];
  assert.equal((await fetch(new URL(script, origin))).status, 200);
  assert.equal((await fetch(`${origin}/api/onboarding`)).status, 401);
  const claim = await fetch(`${origin}/api/onboarding/claim`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(claim.status, 200);
  const cookie = claim.headers.get('set-cookie').split(';')[0];
  const csrf = (await claim.json()).csrfToken;
  const headers = { origin, cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };
  const profile = (await (await fetch(`${origin}/api/onboarding`, { headers })).json()).profile;
  profile.displayName = 'Image restart smoke test';
  const saved = await fetch(`${origin}/api/onboarding`, { method: 'PUT', headers: { ...headers, 'if-match': '"0"' }, body: JSON.stringify(profile) });
  assert.equal(saved.status, 200);
  docker(['stop', '--time', '10', name]);
  docker(['rm', name]);
  await start();
  const resumed = await (await fetch(`${origin}/api/onboarding`, { headers })).json();
  assert.equal(resumed.revision, 1); assert.equal(resumed.profile.displayName, profile.displayName);
  const exported = await (await fetch(`${origin}/api/onboarding/export`, { headers })).json();
  assert.equal(exported.runtimeReady, false); assert.ok(!JSON.stringify(exported).includes(token));
  process.stdout.write('Image smoke passed: non-root launch, real web assets, authenticated claim, profile write, persistent volume/session across restart, and safe export.\n');
} finally {
  docker(['rm', '--force', name], true);
  docker(['volume', 'rm', volume], true);
}
