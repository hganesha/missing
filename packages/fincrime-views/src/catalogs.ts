import { CATALOG_KINDS, canReadCatalog, type CatalogKind, type Schemas } from '@ehf/ui-contracts';
export type CatalogSnapshot = Schemas['CatalogSnapshot'];
export type CatalogEntry = Schemas['CatalogEntry'];
export type CatalogQuery = {
    kind?: CatalogKind;
    entryType?: 'definition' | 'binding' | 'field';
    q?: string;
    group?: string;
    collection?: string;
    status?: string;
    sort?: 'name' | 'name-desc' | 'group';
    cursor?: string;
    limit?: number;
};
/** Shared projection: authorization precedes counts, search, facets and pagination. */
export function catalogIndex(snapshot: CatalogSnapshot, actions: readonly string[], query: CatalogQuery = {}): Schemas['CatalogIndex'] {
    const visible = snapshot.entries.filter(entry => canReadCatalog(actions, entry.kind));
    const candidates = visible.filter(entry => (!query.kind || entry.kind === query.kind) && (!query.entryType || entry.entryType === query.entryType));
    const term = (query.q ?? '').trim().toLocaleLowerCase();
    const matching = candidates.filter(entry => (!query.status || entry.status === query.status)
        && (!term || [entry.title, entry.id, entry.description, entry.group, entry.collection ?? '', ...entry.tags, ...entry.fields.map(field => field.name)].join(' ').toLocaleLowerCase().includes(term)));
    const collectionMatching = matching.filter(entry => !query.collection || entry.collection === query.collection);
    const filtered = collectionMatching.filter(entry => !query.group || entry.group === query.group);
    const counts = new Map<string, number>();
    for (const entry of collectionMatching) counts.set(entry.group, (counts.get(entry.group) ?? 0) + 1);
    const collectionCounts = new Map<string, number>();
    for (const entry of matching) if (entry.collection) collectionCounts.set(entry.collection, (collectionCounts.get(entry.collection) ?? 0) + 1);
    filtered.sort((a, b) => {
        const names = a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
        // Category structure survives sorting and page boundaries in every skill/capability view.
        if (query.kind === 'skills' || query.kind === 'external-capabilities' || query.kind === 'products')
            return a.group.localeCompare(b.group) || (query.sort === 'name-desc' ? -names : names);
        return query.sort === 'name-desc' ? -names : query.sort === 'group' ? a.group.localeCompare(b.group) || names : names;
    });
    // Cursor binds to the immutable snapshot and all filters, so a saved URL cannot silently
    // skip records after a release or filter changes. Invalid cursors restart the list.
    const scope = [snapshot.digest, [...actions].sort().join(','), query.kind, query.entryType, term, query.group, query.collection, query.status, query.sort].join('|');
    const cursor = query.cursor?.split('~');
    const offset = cursor?.[0] === encodeURIComponent(scope) && /^\d+$/.test(cursor[1] ?? '') ? Number(cursor?.[1]) : 0;
    const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 30) || 30));
    const items = filtered.slice(offset, offset + limit).map(({ relationships: _links, fields: _fields, contract: _contract, notice: _notice, workspace: _workspace, ...summary }) => summary);
    return {
        snapshot: { digest: snapshot.digest, sourceRelease: snapshot.sourceRelease, scope: snapshot.scope, note: snapshot.note },
        boards: CATALOG_KINDS.filter(kind => canReadCatalog(actions, kind)).map(kind => {
            const entries = visible.filter(entry => entry.kind === kind);
            const providerIds = new Set(entries.filter(entry => entry.entryType === 'binding').map(entry => entry.contract.provider_record_id).filter((id): id is string => typeof id === 'string'));
            const families = new Map(snapshot.providers?.map(provider => [provider.id, provider.discovery.familyId]));
            return { kind, count: entries.length, definitions: entries.filter(entry => entry.entryType === 'definition').length,
                bindings: entries.filter(entry => entry.entryType === 'binding').length, fields: entries.filter(entry => entry.entryType === 'field').length,
                ...(kind === 'external-capabilities' ? { providers: providerIds.size, declaredFamilies: new Set([...providerIds].map(id => families.get(id) ?? id)).size } : {}) };
        }),
        items, total: filtered.length,
        nextCursor: offset + limit < filtered.length ? `${encodeURIComponent(scope)}~${offset + limit}` : null,
        groups: [...new Set(candidates.map(entry => entry.group))].sort((a,b)=>a.localeCompare(b)),
        groupCounts: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)),
        collections: [...new Set(candidates.flatMap(entry => entry.collection ? [entry.collection] : []))].sort(),
        collectionCounts: [...collectionCounts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)),
        statuses: [...new Map(candidates.map(entry => [entry.status, { label: entry.statusLabel, value: entry.status }])).values()].sort((a, b) => a.label.localeCompare(b.label)),
    };
}
export function catalogEntry(snapshot: CatalogSnapshot, actions: readonly string[], kind: CatalogKind, id: string): CatalogEntry | undefined {
    if (!canReadCatalog(actions, kind))
        return undefined;
    const entry = snapshot.entries.find(entry => entry.kind === kind && entry.id === id);
    if (!entry)
        return undefined;
    return { ...entry, relationships: entry.relationships.filter(link => canReadCatalog(actions, link.kind)) };
}
