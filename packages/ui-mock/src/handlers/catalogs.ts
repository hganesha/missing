import { withExternalBindingRevisions, catalogEntry, catalogIndex, type CatalogQuery, type CatalogSnapshot } from '@ehf/fincrime-views';
import { CATALOG_KINDS, canReadCatalog, type CatalogKind } from '@ehf/ui-contracts';
import snapshot from '../../../ui-contracts/vendor/docs/ui/contracts/fixtures/catalogs.json' with { type: 'json' };
import { bindingRevisions } from './external-bindings.js';
import { fail, ok, notFound, type Ctx, type Impl } from '../http.js';
export const CATALOG_SNAPSHOT = snapshot as CatalogSnapshot;
export const tenantCatalogSnapshot = (ctx: Ctx) => withExternalBindingRevisions(CATALOG_SNAPSHOT, bindingRevisions(ctx));
export const catalogs: Record<string, Impl> = {
    getCatalogs: async ctx => {
        const kind = ctx.url.searchParams.get('kind');
        if (kind && (!CATALOG_KINDS.includes(kind as CatalogKind) || !canReadCatalog(ctx.session.actions, kind as CatalogKind)))
            return fail(ctx, 403, 'authorization.role_missing', 'Your role does not have access to this catalog.');
        const query = Object.fromEntries(ctx.url.searchParams) as CatalogQuery;
        return ok(ctx, catalogIndex(await tenantCatalogSnapshot(ctx), ctx.session.actions, query));
    },
    getCatalogsKindEntryId: async ctx => {
        const kind = ctx.params.kind as CatalogKind;
        if (!CATALOG_KINDS.includes(kind))
            return notFound(ctx, 'Catalog');
        if (!canReadCatalog(ctx.session.actions, kind))
            return fail(ctx, 403, 'authorization.role_missing', 'Your role does not have access to this catalog.');
        const entry = catalogEntry(await tenantCatalogSnapshot(ctx), ctx.session.actions, kind, ctx.params.entryId);
        return entry ? ok(ctx, entry) : notFound(ctx, 'Catalog definition');
    },
};
