import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { validatorFor } from '@ehf/ui-contracts/validate';
import { catalogEntry, catalogIndex, type CatalogSnapshot } from './catalogs.js';
import { externalProviderIndex } from './external-providers.js';
const snapshot = JSON.parse(readFileSync(new URL('../../ui-contracts/vendor/docs/ui/contracts/fixtures/catalogs.json', import.meta.url), 'utf8')) as CatalogSnapshot;
const all = ['draft.read', 'capability.read', 'case.read', 'evidence.read'];
describe('canonical catalog projection', () => {
    it('validates the complete source snapshot and resolves every relationship', () => {
        const validate = validatorFor('CatalogSnapshot');
        expect(validate(snapshot), JSON.stringify(validate.errors)).toBe(true);
        const ids = new Set(snapshot.entries.map(entry => `${entry.kind}:${entry.id}`));
        expect(ids.size).toBe(snapshot.entries.length);
        expect(snapshot.entries.every(entry => entry.relationships.every(link => ids.has(`${link.kind}:${link.id}`)))).toBe(true);
        expect(catalogIndex(snapshot, all).boards.find(board => board.kind === 'agents')?.count).toBe(7);
        expect(catalogIndex(snapshot, all).boards.find(board => board.kind === 'skills')?.count).toBe(232);
    });
    it('authorizes before counts, search, facets and detail relationships', () => {
        const analyst = ['case.read', 'evidence.read'];
        expect(catalogIndex(snapshot, analyst).boards.map(board => board.kind)).toEqual(['policies', 'documents', 'products']);
        expect(catalogIndex(snapshot, analyst, { kind: 'skills' }).items).toEqual([]);
        expect(catalogEntry(snapshot, analyst, 'agents', 'agent.screening')).toBeUndefined();
        const passport = catalogEntry(snapshot, analyst, 'documents', 'passport');
        expect(passport?.relationships.every(link => link.kind === 'documents' || link.kind === 'policies')).toBe(true);
    });
    it('paginates a stable filtered set without duplicates and invalidates cursors after filters change', () => {
        const first = catalogIndex(snapshot, all, { kind: 'skills', limit: 12 });
        const next = catalogIndex(snapshot, all, { kind: 'skills', limit: 12, cursor: first.nextCursor! });
        expect(new Set([...first.items, ...next.items].map(entry => entry.id)).size).toBe(24);
        const changed = catalogIndex(snapshot, all, { kind: 'skills', q: 'document', limit: 12, cursor: first.nextCursor! });
        expect(changed.items).toEqual(catalogIndex(snapshot, all, { kind: 'skills', q: 'document', limit: 12 }).items);
    });
    it('searches business names and preserves proposed capability authority', () => {
        expect(catalogIndex(snapshot, all, { kind: 'skills', q: 'beneficial owners' }).items.some(entry => entry.id === 'ownership.ubo.resolve')).toBe(true);
        const bindings = catalogIndex(snapshot, all, { kind: 'external-capabilities', entryType: 'binding', group: 'Business' });
        expect(bindings.items.length).toBeGreaterThan(0);
        expect(bindings.items.every(entry => entry.group === 'Business')).toBe(true);
        expect(bindings.items.every(entry => ['disabled', 'quarantined'].includes(entry.status))).toBe(true);
        expect(validatorFor('CatalogIndex')(bindings)).toBe(true);
    });
    it('counts complete classifications before pagination and independently of the selected group', () => {
        const documents = catalogIndex(snapshot, all, { kind: 'documents', entryType: 'definition', limit: 1 });
        expect(documents.items).toHaveLength(1);
        expect(documents.groupCounts).toHaveLength(38);
        expect(documents.groupCounts.reduce((total, group) => total + group.count, 0)).toBe(documents.total);
        const identity = catalogIndex(snapshot, all, { kind: 'documents', entryType: 'definition', group: 'Personal identity', limit: 1 });
        expect(identity.groupCounts).toEqual(documents.groupCounts);
        expect(identity.total).toBe(documents.groupCounts.find(group => group.name === 'Personal identity')?.count);
        expect(identity.items.every(entry => entry.group === 'Personal identity')).toBe(true);
        const search = catalogIndex(snapshot, all, { kind: 'documents', entryType: 'definition', q: 'passport' });
        expect(search.groupCounts.reduce((total, group) => total + group.count, 0)).toBe(search.total);
        expect(catalogIndex(snapshot, [], { kind: 'documents' }).groupCounts).toEqual([]);
    });
    it('classifies bindings under the same functional domain as their capability definition', () => {
        const capabilities = snapshot.entries.filter(entry => entry.kind === 'external-capabilities');
        const definitions = new Map(capabilities.filter(entry => entry.entryType === 'definition').map(entry => [entry.id, entry]));
        expect(new Set([...definitions.values()].map(entry => entry.group)).size).toBe(20);
        for (const binding of capabilities.filter(entry => entry.entryType === 'binding')) {
            const definition = definitions.get(binding.relationships.find(link => link.kind === 'external-capabilities')!.id);
            expect(binding.group).toBe(definition?.group);
        }
    });
    it('presents canonical definitions separately from unresolved provider jurisdiction', () => {
        const capabilities = snapshot.entries.filter(entry => entry.kind === 'external-capabilities');
        const definitions = new Map(capabilities.filter(entry => entry.entryType === 'definition').map(entry => [entry.id, entry]));
        expect(definitions.size).toBe(56);
        const providers = externalProviderIndex(snapshot, [], null, '2026-11-08T00:00:00Z');
        let unresolved = 0;
        for (const binding of capabilities.filter(entry => entry.entryType === 'binding')) {
            const link = binding.relationships.find(link => link.kind === 'external-capabilities' && link.entryType === 'definition')!;
            const definition = definitions.get(link.id)!;
            expect(binding.description).toBe(definition.description);
            expect(binding.description).not.toContain('.intelligence.');
            const contract = binding.contract as { provider_record_id: string; capability_id: string; jurisdiction: { code: string }; governance: { enabled: boolean } };
            const providerCapability = providers.items.find(provider => provider.id === contract.provider_record_id)!.capabilities.find(capability => capability.id === binding.id)!;
            expect(providerCapability.name).toBe(definition.title);
            expect(providerCapability.jurisdiction).toBe(contract.jurisdiction.code);
            expect(contract.governance.enabled).toBe(false);
            if (contract.jurisdiction.code === 'unresolved') {
                unresolved++;
                expect(contract.capability_id).toMatch(/\.intelligence\.unresolved$/);
                expect(binding.facts.find(fact => fact.label === 'Jurisdiction')?.value).toBe('Not established');
                expect(binding.notice).toContain('semantic jurisdiction is not established');
            }
        }
        expect(unresolved).toBeGreaterThan(0);
    });
});
