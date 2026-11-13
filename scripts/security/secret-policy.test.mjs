import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';

test('false-positive classifications expire and never exempt whole paths', () => {
  const config = readFileSync('.gitleaks.toml', 'utf8');
  const sections = config.split('[[allowlists]]').slice(1);
  assert.ok(sections.length > 0);
  for (const section of sections) {
    const date = section.match(/expires=(\d{4}-\d{2}-\d{2})/)?.[1];
    assert.ok(date && new Date(`${date}T23:59:59Z`) > new Date(), 'expired or undated exception');
    assert.match(section, /condition = "AND"/);
    assert.match(section, /paths =/);
    assert.match(section, /regexes =/);
    assert.match(section, /owner=/);
  }
});

const scanner = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
test('an unrelated credential in an excepted path still fails secret scanning', { skip: scanner.error ? 'install pinned gitleaks to execute scanner integration' : false }, () => {
  const root = mkdtempSync(join(tmpdir(), 'ehf-secret-policy-'));
  try {
    const fixture = join(root, 'apps/control-api/src/envelope-broker.test.ts');
    mkdirSync(dirname(fixture), { recursive: true });
    writeFileSync(fixture, `const ENVELOPE_SECRET = "${['broker', 'envelope', 'secret', 'for', 'tests', '01'].join('-')}";\n`);
    const args = ['dir', '--config', resolve('.gitleaks.toml'), '--ignore-gitleaks-allow', '--redact', '--no-banner', root];
    assert.equal(spawnSync('gitleaks', args, { encoding: 'utf8' }).status, 0);
    writeFileSync(fixture, `const API_KEY = "${randomBytes(24).toString('hex')}";\n`);
    assert.equal(spawnSync('gitleaks', args, { encoding: 'utf8' }).status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('reviewed bootstrap false positives do not exempt new secrets or the same value in another path', { skip: scanner.error ? 'install pinned gitleaks to execute scanner integration' : false }, () => {
  const root = mkdtempSync(join(tmpdir(), 'ehf-bootstrap-secret-policy-'));
  const cases = [
    ['apps/experience-bff/src/application-intake.test.ts', 'const response = await app.inject'],
    ['scripts/provision-azure-resources.mjs', 'await this.role(container,'],
    ['deploy/azure/foundation.bicep', 'secretsUser:'],
    ['docs/audits/2026-11-09-ui/token-inventory.json', '"apps/fincrime-host/docs/ui/tokens.json":'],
    ['docs/audits/2026-11-09-ui/implementation/build-manifest.json', '"apps/web/src/app/auth.ts":'],
  ];
  const invoke = () => spawnSync('gitleaks', ['dir', '--config', resolve('.gitleaks.toml'), '--ignore-gitleaks-allow', '--redact', '--no-banner', root], { encoding: 'utf8' }).status;
  try {
    const fixtures = cases.map(([file, marker]) => {
      const line = readFileSync(file, 'utf8').split('\n').find(line => line.includes(marker));
      assert.ok(line, `reviewed source value is missing from ${file}`);
      const path = join(root, file); mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, line + '\n');
      return { path, line };
    });
    assert.equal(invoke(), 0, 'reviewed values should pass only in their classified paths');
    for (const { path, line } of fixtures) {
      writeFileSync(path, line + `\nconst API_KEY = "${randomBytes(24).toString('hex')}";\n`);
      assert.equal(invoke(), 1, `a new credential must still be detected in ${path}`);
      writeFileSync(path, line + '\n');
    }
    writeFileSync(join(root, 'unreviewed.bicep'), fixtures[2].line + '\n');
    assert.equal(invoke(), 1, 'the value classification must not apply outside its reviewed path');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
