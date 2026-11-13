import { readFile, writeFile } from 'node:fs/promises';
const source = new URL('../apps/web/public/deployment/azure-resources.md', import.meta.url);
const escape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const inline = value => escape(value).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
const output = []; let paragraph = []; let list = ''; let table = false; let code = null;
function close() { if (paragraph.length) output.push(`<p>${inline(paragraph.join(' '))}</p>`); paragraph = []; if (list) output.push(`</${list}>`); list = ''; if (table) output.push('</tbody></table></div>'); table = false; }
for (const line of (await readFile(source, 'utf8')).split('\n')) {
  if (line.startsWith('```')) { if (code !== null) { output.push(`<pre><code>${escape(code.join('\n'))}</code></pre>`); code = null; } else { close(); code = []; } continue; }
  if (code !== null) { code.push(line); continue; }
  if (!line.trim()) { close(); continue; }
  const heading = /^(#{1,3}) (.*)/.exec(line);
  if (heading) { close(); output.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`); continue; }
  if (line.startsWith('|')) { if (/^\|[ -|]+\|$/.test(line)) continue; if (!table) { close(); output.push('<div class="table"><table><tbody>'); table = true; } output.push(`<tr>${line.split('|').slice(1, -1).map(cell => `<td>${inline(cell.trim())}</td>`).join('')}</tr>`); continue; }
  const item = /^(- |\d+\. )(.*)/.exec(line);
  if (item) { const type = item[1] === '- ' ? 'ul' : 'ol'; if (list !== type) { close(); output.push(`<${type}>`); list = type; } output.push(`<li>${inline(item[2])}</li>`); continue; }
  paragraph.push(line);
}
close();
await writeFile(new URL('../apps/web/public/deployment/azure-resources.html', import.meta.url), `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Azure resource setup · IntegralFlow</title><style>body{margin:0;background:#f4f6fa;color:#17202f;font:16px/1.7 system-ui,sans-serif}main{max-width:900px;margin:0 auto;padding:40px 24px 100px}h1,h2,h3{line-height:1.25}h2{margin-top:48px}a{color:inherit;text-underline-offset:4px}pre{background:#e9edf3;padding:20px;border-radius:8px;overflow:auto;font-size:13px;line-height:1.6}code{overflow-wrap:anywhere}li{margin:8px 0}.table{overflow:auto}table{border-collapse:collapse;font-size:13px}td{border:1px solid #ccd4df;padding:10px;vertical-align:top}tr:first-child{font-weight:600}nav{margin-bottom:32px}</style><main><nav><a href="/onboarding">← Return to environment setup</a></nav>${output.join('\n')}</main></html>\n`);
