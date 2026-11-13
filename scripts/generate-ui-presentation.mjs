import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const source = JSON.parse(readFileSync(new URL('apps/fincrime-host/docs/ui/contracts/fixtures/catalogs.json', root), 'utf8'));
const output = new URL('apps/web/src/presentation/catalog.generated.json', root);
const content = JSON.stringify(Object.fromEntries(source.entries.map(entry => [`${entry.kind}:${entry.id}`, [entry.title, entry.group, entry.entryType]]))) + '\n';
if (process.argv.includes('--check')) {
  if (readFileSync(output, 'utf8') !== content) throw new Error('UI presentation metadata is stale. Run node scripts/generate-ui-presentation.mjs');
} else {
  mkdirSync(fileURLToPath(new URL('.', output)), { recursive: true });
  writeFileSync(output, content);
}
console.log(`UI presentation: ${source.entries.length} source-backed identities`);
