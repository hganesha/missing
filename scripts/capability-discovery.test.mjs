import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { capabilityDiscovery } from './lib/capability-discovery.mjs';

const read = path => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));
const providers = read('tools/kyc-provider-atlas/catalog/providers.json');
const definitions = read('tools/kyc-provider-atlas/capability-model/registry/capability-definitions.json').records;
const bindings = read('tools/kyc-provider-atlas/capability-model/registry/capability-bindings.json').records;
const priorities = read('config/provider-priorities.json');
const collections = read('config/capability-collections.json');
const build = (priority = priorities, taxonomy = collections) => capabilityDiscovery(providers, definitions, bindings, priority, taxonomy);

test('the complete census has one research lane per provider and one collection per definition', () => {
  const result = build();
  assert.equal(result.providers.length, 376);
  assert.equal(new Set(result.providers.map(provider => provider.id)).size, 376);
  assert.equal(result.collectionByPath.size, 56);
  const count = value => result.providers.filter(provider => provider.discovery.priority === value).length;
  assert.deepEqual(['core', 'specialist', 'discovery', 'source', 'quarantined'].map(count), [29, 13, 245, 88, 1]);
  assert.equal(result.providers.filter(provider => provider.discovery.researchState === 'public_material_reviewed').length, 49);
  assert.equal(result.providers.find(provider => provider.id === 'finantier').discovery.priority, 'quarantined');
});

test('missing, duplicate or unknown provider metadata fails generation rather than disappearing silently', () => {
  assert.throws(() => build({ ...priorities, providers: priorities.providers.slice(1) }), /Every source provider/);
  assert.throws(() => build({ ...priorities, providers: [...priorities.providers, priorities.providers[0]] }), /duplicate provider/);
  assert.throws(() => build({ ...priorities, providers: [{ ...priorities.providers[0], providerRecordId: 'unknown' }, ...priorities.providers.slice(1)] }), /Invalid or duplicate/);
});

test('public research needs evidence and HTTPS links without embedded credentials', () => {
  for (const url of ['javascript:alert(1)', 'http://example.com', 'https://secret@example.com']) {
    const edited = structuredClone(priorities);
    edited.providers.find(provider => provider.evidence.length).evidence[0].url = url;
    assert.throws(() => build(edited), /Invalid research evidence/);
  }
  const edited = structuredClone(priorities);
  edited.providers.find(provider => provider.evidence.length).evidence = [];
  assert.throws(() => build(edited), /Missing research evidence/);
});

test('missing or overlapping collection membership fails generation', () => {
  const edited = structuredClone(collections);
  edited.collections[0].capabilityPaths.pop();
  assert.throws(() => build(priorities, edited), /Every capability definition/);
  edited.collections[0].capabilityPaths.push(definitions.find(definition => !collections.collections[0].capabilityPaths.includes(definition.capability_path)).capability_path);
  assert.throws(() => build(priorities, edited), /duplicate collection path/);
});

test('discovery generation preserves every canonical binding contract, digest and restriction', () => {
  const snapshot = read('apps/fincrime-host/docs/ui/contracts/fixtures/catalogs.json');
  const entries = new Map(snapshot.entries.filter(entry => entry.kind === 'external-capabilities' && entry.entryType === 'binding').map(entry => [entry.id, entry]));
  const { collectionByPath } = build();
  assert.equal(entries.size, bindings.length);
  for (const binding of bindings) {
    const entry = entries.get(binding.binding_id);
    const { capability_id, provider_record_id, actions, jurisdiction, coverage, implementation, governance, versions } = binding;
    const contract = { capability_id, provider_record_id, actions, jurisdiction, coverage, implementation, governance, versions };
    assert.deepEqual(entry.contract, contract);
    assert.equal(entry.digest, createHash('sha256').update(JSON.stringify(contract)).digest('hex'));
    assert.equal(entry.status, governance.quarantine ? 'quarantined' : 'disabled');
    assert.equal(entry.collection, collectionByPath.get(binding.capability_path));
  }
});
