import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const directory = resolve(process.env.ONBOARDING_STATE_DIR ?? '.integralflow/local');
await mkdir(directory, { recursive: true, mode: 0o700 });
const tokenFile = resolve(directory, 'claim-token');
let token;
try { token = (await readFile(tokenFile, 'utf8')).trim(); }
catch (error) { if (error.code !== 'ENOENT') throw error; token = randomBytes(32).toString('hex'); await writeFile(tokenFile, token + '\n', { mode: 0o600, flag: 'wx' }); }
await chmod(tokenFile, 0o600);
const port = process.env.PORT ?? '4300';
const origin = process.env.ONBOARDING_PUBLIC_ORIGIN ?? `http://localhost:${port}`;
process.stdout.write(`Onboarding: ${origin}/onboarding\nAdministrator token file: ${tokenFile}\n`);
const child = spawn(process.execPath, ['--import', 'tsx', 'apps/launcher/src/server.ts'], { stdio: 'inherit', env: {
  ...process.env, ONBOARDING_STATE_DIR: directory, ONBOARDING_PUBLIC_ORIGIN: origin,
  ONBOARDING_BOOTSTRAP_SHA256: createHash('sha256').update(token).digest('hex'),
  ONBOARDING_WEB_ROOT: resolve('apps/web/dist'), PORT: port,
} });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
child.once('exit', (code) => { process.exitCode = code ?? 1; });
