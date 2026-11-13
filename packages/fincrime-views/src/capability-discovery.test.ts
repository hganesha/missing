import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validatorFor } from '@ehf/ui-contracts/validate';
import { catalogIndex, type CatalogSnapshot } from './catalogs.js';
import { externalProviderIndex } from './external-providers.js';

const snapshot = JSON.parse(readFileSync(new URL('../../ui-contracts/vendor/docs/ui/contracts/fixtures/catalogs.json', import.meta.url), 'utf8')) as CatalogSnapshot;
const actions = ['capability.read'];

describe('additive capability discovery', () => {
  it('reconciles record, family, definition and binding counts without mixing units', () => {
    const index = catalogIndex(snapshot, actions, { kind: 'external-capabilities' });
    expect(index.boards[0]).toMatchObject({ definitions: 56, providers: 376, declaredFamilies: 360, bindings: 825 });
    const providers = externalProviderIndex(snapshot, [], null, '2026-11-11T00:00:00Z');
    expect(providers.counts).toEqual({ providers: 376, declaredFamilies: 360, bindings: 825, unresolvedBindings: 748, publiclyResearched: 49, quarantined: 1 });
    expect(validatorFor('ExternalProviderIndex')(providers)).toBe(true);
  });

  it('keeps technical-domain filters and full collection counts before pagination', () => {
    const query = { kind: 'external-capabilities' as const, entryType: 'definition' as const, limit: 1 };
    const all = catalogIndex(snapshot, actions, query);
    expect(all.groups).toHaveLength(20);
    expect(all.collections).toHaveLength(9);
    expect(all.collectionCounts?.reduce((total, collection) => total + collection.count, 0)).toBe(56);
    const identity = catalogIndex(snapshot, actions, { ...query, collection: 'Identity and credentials' });
    expect(identity.total).toBe(12);
    expect(identity.collectionCounts).toEqual(all.collectionCounts);
    expect(identity.items.every(entry => entry.collection === 'Identity and credentials')).toBe(true);
    expect(catalogIndex(snapshot, actions, { ...query, group: 'Identity' }).total).toBe(10);
    expect(validatorFor('CatalogIndex')(identity)).toBe(true);
  });

  it('binds cursors to the collection and restarts after collection changes', () => {
    const query = { kind: 'external-capabilities' as const, entryType: 'binding' as const, collection: 'Identity and credentials', limit: 2 };
    const first = catalogIndex(snapshot, actions, query);
    const second = catalogIndex(snapshot, actions, { ...query, cursor: first.nextCursor! });
    expect(new Set([...first.items, ...second.items].map(entry => entry.id)).size).toBe(4);
    const changed = { ...query, collection: 'Business and ownership' };
    expect(catalogIndex(snapshot, actions, { ...changed, cursor: first.nextCursor! }).items).toEqual(catalogIndex(snapshot, actions, changed).items);
  });

  it('authorizes before exposing collections and provider counts', () => {
    const denied = catalogIndex(snapshot, ['evidence.read'], { kind: 'external-capabilities' });
    expect(denied.items).toEqual([]);
    expect(denied.collections).toEqual([]);
    expect(denied.collectionCounts).toEqual([]);
    expect(denied.boards.some(board => board.kind === 'external-capabilities')).toBe(false);
  });

  it('supports older snapshots and keeps custom providers unclassified', () => {
    const legacy = structuredClone(snapshot);
    delete legacy.providers;
    for (const entry of legacy.entries) delete entry.collection;
    expect(validatorFor('CatalogSnapshot')(legacy)).toBe(true);
    expect(externalProviderIndex(legacy, [], null, '2026-11-11T00:00:00Z').items).toHaveLength(376);
    expect(catalogIndex(legacy, actions).collections).toEqual([]);
    const custom = { provider: { id: 'new-source', name: 'New source', description: '' }, origin: 'custom' as const, createdAt: '2026-11-11T00:00:00Z', createdBy: 'admin', connections: [], activity: [] };
    const result = externalProviderIndex(snapshot, [custom], null, '2026-11-11T00:00:00Z');
    expect(result.items.find(provider => provider.id === custom.provider.id)?.discovery).toBeUndefined();
    expect(result.counts?.providers).toBe(377);
    expect(result.counts?.bindings).toBe(825);
  });

  it('does not reintroduce providers from metadata when the caller filters the source inventory', () => {
    const restricted = { ...snapshot, entries: snapshot.entries.filter(entry => entry.kind === 'external-capabilities' && entry.id.includes(':persona:')) };
    const result = externalProviderIndex(restricted, [], null, '2026-11-11T00:00:00Z');
    expect(result.items.map(provider => provider.id)).toEqual(['persona']);
    expect(result.counts?.providers).toBe(1);
    expect(result.counts?.bindings).toBe(3);
  });
});
