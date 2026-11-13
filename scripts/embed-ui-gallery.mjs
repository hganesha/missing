// Embed captured WebP bytes into the portable article; no image server is needed.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const inventory = JSON.parse(await readFile(resolve(root, 'docs/ui-surfaces.json'), 'utf8'));
const directory = resolve(root, '.integralflow/ui-gallery');
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const purpose = path => {
  const rules = [
    ['/work/decisions', 'Review the decision basis, record a rationale, and complete an independent second approval.'],
    ['/lens/ownership', 'Explore beneficial ownership, conflicting evidence, and the human review required to continue.'],
    ['/lens/screening', 'Inspect screening findings and supporting evidence before recording a disposition.'],
    ['/lens/documents', 'Review source documents, extraction status, and field-level evidence.'],
    ['/lens/risk', 'Review the recorded risk assessment and the evidence supporting it.'],
    ['/work/cases', 'Inspect the shared case record, its evidence, work items, decisions, and history.'],
    ['/work', 'Find assigned cases and the human work that needs attention.'],
    ['/studio/drafts/', 'Compose and review a versioned workflow, its instructions, sources, capabilities, and release controls.'],
    ['/studio/drafts', 'Browse draft processes and inspect their compilation and review status.'],
    ['/studio/policies', 'Explore business scope, product policies, requirements, approval rules, and version history.'],
    ['/studio/agents/mandates', 'Explore agent responsibilities, task composition, skill contracts, and required context.'],
    ['/studio/agents', 'Configure agent instructions and inspect their governed bindings.'],
    ['/studio/skills', 'Inspect reusable skill definitions and the contracts they expose.'],
    ['/studio/published', 'Inspect published processes and environment release status.'],
    ['/catalogs', 'Discover reusable definitions, inspect their provenance, and follow their relationships.'],
    ['/context/preview', 'Preview the bounded context supplied to an agent and task.'],
    ['/context/documents', 'Search document evidence and inspect its source context.'],
    ['/context/cases', 'Explore authorized relationships across case records.'],
    ['/context', 'Explore context products, banks, and the definitions used by agents.'],
    ['/assurance/recorder', 'Reconstruct a case through its recorded events and execution timeline.'],
    ['/assurance/lineage', 'Trace decisions back through claims, evidence, and accountable work.'],
    ['/assurance/packages', 'Inspect the evidence assembled for assurance and review.'],
    ['/assurance', 'Monitor case progress, exceptions, and work requiring intervention.'],
    ['/platform/data-sources', 'Inspect source connections, mappings, bindings, calls, and refresh controls.'],
    ['/platform/document-studio', 'Inspect document field contracts and the document-testing workspace. Live model tests require HTTP services.'],
    ['/platform/plans', 'Inspect admitted plans, their immutable definitions, and execution bindings.'],
    ['/platform/runs', 'Inspect execution status, node progress, attempts, and reported usage.'],
    ['/platform/traces', 'Inspect recorded execution spans and their relationship to the run.'],
    ['/platform/cases', 'Inspect canonical case records and their execution references.'],
    ['/platform/human-work', 'Inspect human work queues, ownership, and review requirements.'],
    ['/platform/system', 'Inspect service connections, gateway readiness, and runtime admission controls.'],
    ['/platform/users', 'Inspect users, roles, permissions, and access administration.'],
    ['/platform/admin', 'Inspect model profiles, providers, capabilities, settings, and configuration history.'],
    ['/platform/intelligence', 'Inspect model bindings, adapters, trust, activation, and operational visibility.'],
    ['/platform/integrations', 'Inspect integration connectors, bindings, deliveries, and human actions.'],
    ['/about', 'Read the product overview and its current scope.'],
  ];
  return rules.find(([part]) => path.includes(part))?.[1] ?? 'Monitor the platform overview, readiness, active runs, and reported operating figures.';
};
const captures = [];
for (const surface of inventory.surfaces) {
  const metadata = JSON.parse(await readFile(resolve(directory, surface.id + '.json'), 'utf8'));
  if (metadata.path !== surface.path || metadata.persona !== surface.persona || metadata.scenario !== surface.scenario) throw new Error('Stale capture: ' + surface.id);
  const bytes = await readFile(resolve(directory, surface.id + '.webp'));
  if (metadata.bytes !== bytes.length) throw new Error('Capture size mismatch: ' + surface.id);
  captures.push({ ...metadata, title: surface.title, image: 'data:image/webp;base64,' + bytes.toString('base64') });
}
const groups = ['Workspace', 'Studios', 'Catalogs', 'Context', 'Assurance', 'Platform'];
captures.sort((a, b) => groups.indexOf(a.group) - groups.indexOf(b.group) || a.id.localeCompare(b.id));
const revision = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const cards = captures.map(c => `<figure class="ui-gallery-card" data-group="${escape(c.group)}" data-search="${escape([c.title,c.group,c.path,c.persona,c.status].join(' ').toLowerCase())}">
<button type="button" data-gallery-open="${c.id}" aria-label="Enlarge ${escape(c.title)}"><img loading="lazy" decoding="async" width="1440" height="1000" src="${c.image}" alt="${escape(c.title)} — ${escape(c.group)}, synthetic ${escape(c.scenario.replaceAll('_',' '))} scenario"></button>
<figcaption><div class="ui-gallery-meta"><span>${escape(c.group)}</span><span>${c.status === 'planned' ? 'Planned surface' : 'Synthetic demo'}</span></div><h3>${escape(c.title)}</h3><p>${c.status === 'planned' ? 'This route is present but its workspace is still being prepared. The capture shows its current availability notice.' : escape(purpose(c.path))}</p><code>${escape(c.path)}</code><small>${escape(c.persona.replaceAll('_',' '))} · ${escape(c.scenario.replaceAll('_',' '))}</small>${c.notes.length ? `<details><summary>Availability notes</summary><p>${escape(c.notes.join(' · '))}</p></details>` : ''}</figcaption></figure>`).join('\n');
const section = `<!-- ui-gallery:start -->
<section id="ui-gallery" aria-labelledby="ui-gallery-title"><div class="wrap">
<div class="section-head"><div class="eyebrow">Product walkthrough · ${captures.length} screens</div><div><h2 id="ui-gallery-title">The platform, on screen</h2><p>Explore the actual UI with synthetic cases, evidence, catalogs, and demo personas. Select a screenshot to inspect it at full size. All images are embedded in this file and remain available offline.</p></div></div>
<p class="ui-gallery-note">Captured from revision <code>${revision}</code> on ${captures.map(c=>c.capturedAt).sort().at(-1).slice(0,10)} at 1440 × 1000 CSS pixels. Major tabs and case stages are included. Legacy routes share their current destination; unfinished workspaces and services unavailable in mock mode are shown explicitly. These captures demonstrate the UI, not live provider results.</p>
<div class="ui-gallery-tools"><label>Find a screen<input id="ui-gallery-search" type="search" placeholder="Search screens, routes, or personas"></label><label>Area<select id="ui-gallery-group"><option value="">All areas</option>${groups.map(g=>`<option>${g}</option>`).join('')}</select></label><p id="ui-gallery-count" role="status" aria-live="polite">${captures.length} screens</p></div>
<p id="ui-gallery-empty" hidden>No screens match your search. Try another screen name or area.</p>
<div class="ui-gallery-grid">${cards}</div>
<details class="ui-gallery-coverage"><summary>Screen coverage and route aliases</summary><p>${inventory.surfaces.length} captures cover canonical screens, major tabs, case sections, and scenario variants. The seven planned surfaces retain their availability notices.</p><ul>${Object.keys(inventory.aliases).map(path=>`<li><code>${escape(path)}</code> · uses its current destination screen</li>`).join('')}</ul><p>Fixture sources: the existing UI contract catalog, platform, personas, and KYB-1042 scenario fixtures. Interactive dialogs and every possible filter combination are not separate surfaces in this inventory.</p></details>
</div></section>
<dialog id="ui-gallery-dialog" aria-labelledby="ui-gallery-dialog-title"><div class="ui-gallery-dialog-bar"><h2 id="ui-gallery-dialog-title">UI screen</h2><div><button type="button" id="ui-gallery-prev" aria-label="Previous screenshot">←</button><button type="button" id="ui-gallery-next" aria-label="Next screenshot">→</button><button type="button" id="ui-gallery-close">Close ✕</button></div></div><div class="ui-gallery-full"><img id="ui-gallery-image" alt=""></div><p id="ui-gallery-dialog-caption"></p></dialog>
<!-- ui-gallery:end -->`;
const style = `<style id="ui-gallery-styles">
#ui-gallery{border-top:1px solid var(--rule)}.ui-gallery-note{max-width:900px;color:var(--muted);font-size:13px;margin-bottom:28px}.ui-gallery-tools{display:flex;align-items:end;gap:20px;flex-wrap:wrap;margin-bottom:28px}.ui-gallery-tools label{display:grid;gap:6px;font-size:12px}.ui-gallery-tools input,.ui-gallery-tools select{background:var(--white);color:var(--ink);border:1px solid var(--rule);border-radius:5px;padding:11px 13px;max-width:100%}.ui-gallery-tools input{width:340px}.ui-gallery-tools p{font:12px var(--mono);color:var(--muted);padding-bottom:13px}.ui-gallery-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:28px}.ui-gallery-card{margin:0;min-width:0;border:1px solid var(--rule);background:var(--white);border-radius:8px;overflow:hidden}.ui-gallery-card[hidden]{display:none}.ui-gallery-card>button{display:block;width:100%;padding:0;background:var(--paper);border-bottom:1px solid var(--rule);cursor:zoom-in}.ui-gallery-card img{display:block;width:100%;height:auto;aspect-ratio:1.44;object-fit:cover;object-position:top}.ui-gallery-card figcaption{padding:22px}.ui-gallery-meta{display:flex;justify-content:space-between;gap:10px;font:10px var(--mono);text-transform:uppercase;color:var(--muted);margin-bottom:12px}.ui-gallery-card h3{font-size:22px;margin-bottom:10px}.ui-gallery-card p{font-size:13px;color:var(--muted)}.ui-gallery-card code{display:block;margin:15px 0 7px;font-size:10px;overflow-wrap:anywhere}.ui-gallery-card small{display:block;color:var(--muted);font-size:11px}.ui-gallery-card details{margin-top:14px;font-size:12px}.ui-gallery-card details p{margin-top:10px}.ui-gallery-coverage{margin-top:30px;font-size:13px}.ui-gallery-coverage p{margin:15px 0}.ui-gallery-coverage li{margin:5px 0}#ui-gallery-dialog{width:min(1600px,96vw);max-width:96vw;max-height:94vh;padding:0;border:1px solid var(--rule);border-radius:8px;background:var(--white);color:var(--ink)}#ui-gallery-dialog::backdrop{background:rgba(10,20,35,.8)}.ui-gallery-dialog-bar{position:sticky;top:0;display:flex;justify-content:space-between;align-items:center;gap:20px;padding:15px 20px;background:var(--white);border-bottom:1px solid var(--rule);z-index:1}.ui-gallery-dialog-bar h2{font:20px var(--sans);letter-spacing:0}.ui-gallery-dialog-bar>div{display:flex;gap:8px;flex-shrink:0}.ui-gallery-dialog-bar button{padding:8px 12px;background:var(--paper);border:1px solid var(--rule);border-radius:4px}.ui-gallery-full{overflow:auto;max-height:calc(94vh - 140px);background:#f7f8fb}.ui-gallery-full img{display:block;width:100%;height:auto}#ui-gallery-dialog-caption{padding:12px 20px;font-size:12px;overflow-wrap:anywhere}@media(max-width:760px){.ui-gallery-grid{grid-template-columns:1fr}.ui-gallery-tools{align-items:stretch;gap:12px}.ui-gallery-tools label{width:100%}.ui-gallery-tools input{width:100%}.ui-gallery-dialog-bar{align-items:start;padding:12px;gap:8px}.ui-gallery-dialog-bar h2{font-size:16px}.ui-gallery-dialog-bar button{padding:7px 9px}.ui-gallery-card figcaption{padding:18px}}@media print{.ui-gallery-tools,.ui-gallery-card>button{break-inside:avoid}#ui-gallery-dialog{display:none}.ui-gallery-card{break-inside:avoid}}
</style>`;
const script = `<script id="ui-gallery-behavior">
(()=>{const cards=[...document.querySelectorAll('.ui-gallery-card')],search=document.getElementById('ui-gallery-search'),group=document.getElementById('ui-gallery-group'),dialog=document.getElementById('ui-gallery-dialog');let current=null,opener=null;
function filter(){const words=search.value.toLowerCase().trim().split(/\\s+/).filter(Boolean);for(const card of cards)card.hidden=Boolean(group.value&&card.dataset.group!==group.value)||!words.every(word=>card.dataset.search.includes(word));const count=cards.filter(card=>!card.hidden).length;document.getElementById('ui-gallery-count').textContent=count+' of '+cards.length+' screens';document.getElementById('ui-gallery-empty').hidden=count!==0;}
function show(card){current=card;const image=card.querySelector('img'),title=card.querySelector('h3').textContent;document.getElementById('ui-gallery-image').src=image.src;document.getElementById('ui-gallery-image').alt=image.alt;document.getElementById('ui-gallery-dialog-title').textContent=title;document.getElementById('ui-gallery-dialog-caption').textContent=card.querySelector('code').textContent+' · '+card.querySelector('small').textContent;document.querySelector('.ui-gallery-full').scrollTop=0;if(!dialog.open){opener=document.activeElement;dialog.showModal();}}
function move(delta){const visible=cards.filter(card=>!card.hidden);show(visible[(visible.indexOf(current)+delta+visible.length)%visible.length]);}
for(const card of cards)card.querySelector('button').addEventListener('click',()=>show(card));search.addEventListener('input',filter);group.addEventListener('change',filter);document.getElementById('ui-gallery-close').addEventListener('click',()=>dialog.close());document.getElementById('ui-gallery-prev').addEventListener('click',()=>move(-1));document.getElementById('ui-gallery-next').addEventListener('click',()=>move(1));dialog.addEventListener('keydown',event=>{if(event.key==='ArrowRight'){event.preventDefault();move(1);}if(event.key==='ArrowLeft'){event.preventDefault();move(-1);}});dialog.addEventListener('close',()=>opener?.focus());dialog.addEventListener('click',event=>{if(event.target===dialog){const rect=dialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)dialog.close();}});
})();
</script>`;
const path = resolve(root, 'docs/visual-story.html');
let html = await readFile(path, 'utf8');
html = html.replace(/<!-- ui-gallery:start -->[\s\S]*?<!-- ui-gallery:end -->\s*/g, '').replace(/<style id="ui-gallery-styles">[\s\S]*?<\/style>\s*/g, '').replace(/<script id="ui-gallery-behavior">[\s\S]*?<\/script>\s*/g, '');
html = html.replace('</head>', style + '\n</head>').replace('</main>', section + '\n</main>').replace('</body>', script + '\n</body>');
if (!html.includes('href="#ui-gallery"')) html = html.replace('<a href="#catalogs">Catalog library</a>', '<a href="#catalogs">Catalog library</a><a href="#ui-gallery">UI gallery</a>');
await writeFile(path, html);
console.log(`Embedded ${captures.length} screenshots (${(Buffer.byteLength(html)/1024/1024).toFixed(1)} MiB) in docs/visual-story.html`);
