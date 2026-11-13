import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('portable builds preserve a pinned article while explicit refreshes require its Git sources', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'portable-story-'));
  try {
    await mkdir(join(directory, 'scripts')); await mkdir(join(directory, 'docs'));
    await copyFile(new URL('./sync-visual-story.mjs', import.meta.url), join(directory, 'scripts/sync-visual-story.mjs'));
    await symlink(resolve('node_modules'), join(directory, 'node_modules'), 'dir');
    const data = { sourceRevision: 'a'.repeat(40), sourceFiles: [{ path: 'domains/example/package.yaml', sha256: 'b'.repeat(64) }] };
    const html = `<script id="domain-data" type="application/json">${JSON.stringify(data)}</script>`;
    const article = join(directory, 'docs/visual-story.html'); await writeFile(article, html);
    const run = (...args) => spawnSync(process.execPath, [join(directory, 'scripts/sync-visual-story.mjs'), ...args], { cwd: directory, encoding: 'utf8' });
    assert.equal(run('--if-available').status, 0);
    assert.equal(await readFile(article, 'utf8'), html);
    assert.notEqual(run('--if-available', '--ref', 'a'.repeat(40)).status, 0);
    data.sourceFiles = []; await writeFile(article, `<script id="domain-data">${JSON.stringify(data)}</script>`);
    assert.notEqual(run('--if-available').status, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
