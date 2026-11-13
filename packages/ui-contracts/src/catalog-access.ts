import type { Schemas } from './index.js';
export const CATALOG_KINDS = ['context', 'skills', 'agents', 'external-capabilities', 'policies', 'documents', 'products'] as const;
export type CatalogKind = Schemas['CatalogKind'];
/** Existing read authorities, shared by UI, BFF and mock. Never an administration gate. */
export const CATALOG_ACCESS: Record<CatalogKind, readonly string[]> = {
    context: ['draft.read'], skills: ['draft.read'], agents: ['draft.read'],
    'external-capabilities': ['capability.read'], policies: ['draft.read', 'case.read'],
    documents: ['evidence.read'], products: ['draft.read', 'case.read'],
};
export function canReadCatalog(actions: readonly string[], kind: CatalogKind): boolean {
    return CATALOG_ACCESS[kind].some(action => actions.includes(action));
}
