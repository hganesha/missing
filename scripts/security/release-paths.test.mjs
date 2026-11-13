import { existsSync, readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';

test('only the manually requested, validation-gated Azure bootstrap may obtain cloud credentials', () => {
  // The browser-triggered bootstrap is the explicit deployment exception. Keep
  // ordinary CI unprivileged and the retired POC release paths absent.
  for (const file of readdirSync('.github/workflows')) {
    const workflow = readFileSync(`.github/workflows/${file}`, 'utf8');
    if (file === 'bootstrap-azure.yml') {
      const config = parse(workflow);
      assert.deepEqual(Object.keys(config.on), ['workflow_dispatch']);
      assert.deepEqual(config.permissions, { contents: 'read' });
      assert.deepEqual(config.concurrency, { group: 'azure-bootstrap', 'cancel-in-progress': false });
      assert.equal(config.jobs.validate.uses, './.github/workflows/validate.yml');
      const job = config.jobs.bootstrap;
      assert.equal(job.needs, 'validate');
      assert.equal(job.if, "github.ref == 'refs/heads/main'");
      assert.equal(job.environment, 'azure-bootstrap');
      assert.deepEqual(job.permissions, { contents: 'read', 'id-token': 'write' });
      assert.equal(job.steps.find(step => step.uses?.startsWith('actions/checkout@')).with['persist-credentials'], false);
      assert.doesNotMatch(workflow, /actions\/upload-artifact|secrets:\s*inherit/);
      for (const step of job.steps) if (step.run) assert.doesNotMatch(step.run, /\$\{\{/, 'Dispatch inputs belong in env, never interpolated shell code.');
      continue;
    }
    assert.doesNotMatch(workflow, /uses:\s*(?:azure\/login|aws-actions\/configure-aws-credentials|google-github-actions\/auth)|id-token:\s*write/, file);
  }
  for (const file of ['deploy-apps.yml', 'deploy-foundation.yml', 'build-images.yml', 'infra-plan.yml', 'smoke.yml']) {
    assert.equal(existsSync(`.github/workflows/${file}`), false, file);
  }
});

test('no .env or signing material enters any Docker build context', () => {
  const ignore = readFileSync('.dockerignore', 'utf8');
  for (const pattern of ['**/.env*', '.claude', '**/*.pem', '**/*.key']) {
    assert.ok(ignore.split('\n').includes(pattern), `missing build-context exclusion: ${pattern}`);
  }
});

test('security tool downloads are pinned and checksum checked', () => {
  const script = readFileSync('scripts/security/install-tools.sh', 'utf8');
  assert.doesNotMatch(script, /releases\/latest|curl[^\n]*\|\s*(?:ba)?sh/);
  assert.match(script, /shasum -a 256/);
  assert.match(script, /Checksum mismatch/);
});

test('every active GitHub action uses an immutable commit', () => {
  for (const file of readdirSync('.github/workflows').filter((name) => name.endsWith('.yml'))) {
    const content = readFileSync(`.github/workflows/${file}`, 'utf8');
    for (const match of content.matchAll(/uses:\s*([^\s#]+)/g)) {
      if (match[1].startsWith('./')) continue;
      assert.match(match[1], /@[a-f0-9]{40}$/, `${file}: mutable action ${match[1]}`);
    }
  }
});
