// Capture the real UI against its existing synthetic contract fixtures.
// Start pnpm dev:web first. No production API or external provider is contacted.
// System Chromium: CHROMIUM_EXECUTABLE=/usr/bin/chromium node scripts/capture-ui-surfaces.mjs
// Retry selected inventory IDs with --only 001,019. Captures stay in ignored .integralflow/.
// After capture, run node scripts/embed-ui-gallery.mjs to refresh the portable article.
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(resolve(root, 'e2e/ui/package.json'));
const { chromium } = require('@playwright/test');
const inventory = JSON.parse(await readFile(resolve(root, 'docs/ui-surfaces.json'), 'utf8'));
const output = resolve(root, '.integralflow/ui-gallery');
await mkdir(output, { recursive: true });
const baseURL = process.env.UI_CAPTURE_URL ?? 'http://127.0.0.1:5173';
if (!['localhost', '127.0.0.1'].includes(new URL(baseURL).hostname)) throw new Error('Capture requires a local mock server');
const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {});
const only = process.argv.indexOf('--only');
const selected = only < 0 ? inventory.surfaces : inventory.surfaces.filter(s => process.argv[only + 1].split(',').includes(s.id));
let failed = false;
try {
  // Separate browser contexts keep personas and scenario state isolated.
  const groups = [...new Set(selected.map(s => s.persona))];
  for (const persona of groups) {
    const context = await browser.newContext({ viewport: inventory.viewport, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce' });
    await context.addInitScript(() => localStorage.setItem('integralflow.theme', 'light'));
    const page = await context.newPage();
    await page.goto(baseURL + '/about');
    await page.getByRole('link', { name: 'IntegralFlow home' }).waitFor({ timeout: 60000 });
    const session = await page.evaluate(() => fetch('/api/v1/session').then(r => r.json()));
    if (!session.environment?.synthetic) throw new Error('Refusing to capture a non-synthetic environment');
    const mock = async (method, path, body = {}) => page.evaluate(async ({ method, path, body }) => {
      const response = await fetch('/api/mock/' + path, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (!response.ok) throw new Error(`Mock ${path}: ${response.status}`);
      return response.json();
    }, { method, path, body });
    for (const surface of selected.filter(s => s.persona === persona)) {
      try {
        await mock('PUT', 'scenario', { scenario: surface.scenario });
        await mock('POST', 'reset');
        await mock('PUT', 'session', { personaId: persona });
        await page.evaluate(path => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate')); }, surface.path);
        await page.waitForFunction(() => document.querySelector('main')?.innerText.trim().length > 80, undefined, { timeout: 30000 });
        await page.waitForTimeout(1800);
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(() => !document.querySelector('main [aria-busy="true"]'), undefined, { timeout: 20000 });
        for (const action of surface.actions ?? []) {
          if (action.kind === 'fill') await page.getByLabel(action.label, { exact: true }).fill(action.value);
          else if (action.kind === 'click') await page.getByRole('button', { name: action.label, exact: true }).click();
          else throw new Error('Unknown capture action: ' + action.kind);
        }
        if (surface.waitForText) await page.getByText(surface.waitForText, { exact: true }).first().waitFor();
        if (surface.waitForRole) await page.getByRole(surface.waitForRole).waitFor();
        await page.evaluate(() => window.scrollTo(0, 0));
        const text = await page.locator('main').innerText();
        if (/not available to you|Something went wrong|Page not found/.test(text)) throw new Error(text.slice(0, 300));
        const unavailable = text.includes('This workspace is not available yet');
        const notes = [...new Set(text.split('\n').filter(line => /not available|not configured|no .* yet|could not|failed to|unavailable/i.test(line)))];
        const image = await page.screenshot({ type: 'webp', quality: 82, fullPage: true, animations: 'disabled' });
        await writeFile(resolve(output, surface.id + '.webp'), image);
        await writeFile(resolve(output, surface.id + '.json'), JSON.stringify({ ...surface, status: unavailable ? 'planned' : surface.status ?? 'demo', capturedPath: new URL(page.url()).pathname + new URL(page.url()).search, headings: await page.locator('main h1, main h2').allTextContents(), notes, bytes: image.length, capturedAt: new Date().toISOString() }, null, 2));
        console.log(`Captured ${surface.id}: ${surface.title} (${image.length} bytes)`);
      } catch (error) { failed = true; console.error(`FAILED ${surface.id}: ${surface.path}: ${error.message}`); }
    }
    await context.close();
  }
} finally { await browser.close(); }
if (failed) process.exitCode = 1;
