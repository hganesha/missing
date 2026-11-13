import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const script = new URL('./check-bundle.mjs', import.meta.url);
test('allows article provenance while retaining the mock and fixture gates', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bundle-check-'));
  const provenance = '{"path":"apps/fincrime-host/docs/ui/contracts/fixtures/catalogs.json"}';
  try {
    const check = () => spawnSync(process.execPath, [script.pathname, directory], { encoding: 'utf8' });
    await writeFile(join(directory, 'visual-story.html'), `<script type="application/json">${provenance}</script>`);
    assert.equal(check().status, 0);
    await writeFile(join(directory, 'app.js'), provenance);
    assert.notEqual(check().status, 0);
    await rm(join(directory, 'app.js'));
    for (const forbidden of ['contracts/fixtures/people.json', 'personas.json', 'setupWorker()']) {
      await writeFile(join(directory, 'visual-story.html'), `${provenance}<script>${forbidden}</script>`);
      assert.notEqual(check().status, 0);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
