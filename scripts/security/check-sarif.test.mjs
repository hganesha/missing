import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countFindings, describeFindings } from './check-sarif.mjs';

test('only a completed report with no findings passes', () => {
  assert.equal(countFindings({ version: '2.1.0', runs: [{ results: [] }] }), 0);
  assert.equal(countFindings({ version: '2.1.0', runs: [{ results: [{ level: 'warning', suppressions: [{}] }] }] }), 1);
  assert.throws(() => countFindings({ version: '2.1.0', runs: [] }));
  assert.throws(() => countFindings({ version: '2.1.0', runs: [{}] }));
  assert.throws(() => countFindings({ version: '2.1.0', runs: [{ results: [], invocations: [{ executionSuccessful: false }] }] }));
});

test('each finding is reported with its rule and location', () => {
  const document = { version: '2.1.0', runs: [{ results: [{ ruleId: 'js/path-injection', message: { text: 'This path depends on\na user-provided value.' }, locations: [{ physicalLocation: { artifactLocation: { uri: 'apps/x.ts' }, region: { startLine: 12 } } }] }, { message: {} }] }] };
  assert.deepEqual(describeFindings(document), ['js/path-injection  apps/x.ts:12  This path depends on a user-provided value.', 'unknown-rule  <no location>  ']);
});

test('every CodeQL rule exclusion is reviewed and explained', async () => {
  const { readFileSync } = await import('node:fs');
  const config = readFileSync('.github/codeql/codeql-config.yml', 'utf8');
  const excluded = [...config.matchAll(/- exclude:\n\s+id: (\S+)/g)].map((match) => match[1]);
  assert.ok(excluded.length > 0 && excluded.length <= 5, 'keep the exclusion list short');
  for (const id of excluded) {
    const before = config.slice(0, config.indexOf(`id: ${id}`)).split('- exclude:').at(-2) ?? '';
    assert.match(before, /# Reviewed \d{4}-\d{2}-\d{2}/, `${id} needs a dated review line`);
    assert.ok(before.split('\n').filter((line) => line.trim().startsWith('#')).length >= 2, `${id} needs a written reason`);
  }
  assert.match(readFileSync('.github/workflows/security.yml', 'utf8'), /config-file: \.\/\.github\/codeql\/codeql-config\.yml/);
});

test('the apps whose rate-limit findings are excluded still register the limiter', async () => {
  const { readFileSync } = await import('node:fs');
  for (const file of ['apps/experience-bff/src/app.ts', 'apps/launcher/src/app.ts', 'apps/skill-host-reference/src/app.ts']) {
    const source = readFileSync(file, 'utf8');
    const created = source.indexOf('Fastify(');
    const limited = source.indexOf('rateLimitRequests(app');
    const firstRoute = source.search(/\bapp\.(get|post|put|delete|patch)\(/);
    assert.ok(created >= 0 && limited > created && (firstRoute < 0 || limited < firstRoute), `${file} must register rateLimitRequests before its routes`);
  }
});
