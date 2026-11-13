import { externalBindingError, externalBindingSaveSchema, type ExternalBindingCatalog } from "@ehf/contracts/external-bindings";
import source from "../../../../config/external-capability-bindings.json" with { type: "json" };
import { clone } from "../fixtures.js";
import { fail, ok, type Ctx, type Impl } from "../http.js";
const catalog = source as ExternalBindingCatalog;
export const bindingHistory = (ctx: Ctx) => {
  const tenant = String(ctx.session.tenant.tenantId);
  if (!ctx.state.externalBindingRevisions.has(tenant)) ctx.state.externalBindingRevisions.set(tenant, []);
  return ctx.state.externalBindingRevisions.get(tenant)!;
};
export const bindingRevisions = (ctx: Ctx) => [...new Map(bindingHistory(ctx).map(row => [row.bindingId, row])).values()];
export const externalBindings: Record<string, Impl> = {
  getExternalCapabilityBindingsBindingId: ctx => {
    const binding = catalog.bindings.find(item => item.bindingId === ctx.params.bindingId);
    if (!binding) return fail(ctx, 404, "external_binding.not_found", "This binding no longer exists.");
    const history = bindingHistory(ctx).filter(row => row.bindingId === binding.bindingId).reverse().slice(0, 30);
    const latest = history[0];
    return ok(ctx, { ...binding, definition: latest?.definition ?? binding.definition, revision: latest?.revision ?? 0, sourceChanged: Boolean(latest && latest.sourceDigest !== binding.sourceDigest), history, definitions: catalog.definitions, jurisdictions: catalog.jurisdictions });
  },
  postExternalCapabilityBindingsBindingId: async ctx => {
    const parsed = externalBindingSaveSchema.safeParse(ctx.body);
    if (!parsed.success) return fail(ctx, 400, "external_binding.invalid", "Check the binding fields and change reason.");
    const binding = catalog.bindings.find(item => item.bindingId === ctx.params.bindingId);
    if (!binding) return fail(ctx, 404, "external_binding.not_found", "This binding no longer exists.");
    const latest = bindingHistory(ctx).filter(row => row.bindingId === binding.bindingId).at(-1);
    if (parsed.data.expectedRevision !== (latest?.revision ?? 0)) return fail(ctx, 409, "external_binding.revision_conflict", "This binding changed. Reload the editor before saving.");
    if (binding.sourceDigest !== parsed.data.sourceDigest) return fail(ctx, 409, "external_binding.source_changed", "The source changed. Reload the editor before saving.");
    const error = externalBindingError(parsed.data.definition, catalog);
    if (error) return fail(ctx, 400, error, "Choose registered scope and supported actions; include evidence for coverage claims.");
    const { definition, reason, sourceDigest } = parsed.data;
    const revision = (latest?.revision ?? 0) + 1;
    const bytes = new TextEncoder().encode(JSON.stringify([definition, reason, revision, sourceDigest]));
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(byte => byte.toString(16).padStart(2, "0")).join("");
    // Recheck after the asynchronous digest so concurrent requests cannot both win.
    if ((bindingHistory(ctx).filter(row => row.bindingId === binding.bindingId).at(-1)?.revision ?? 0) !== parsed.data.expectedRevision) return fail(ctx, 409, "external_binding.revision_conflict", "This binding changed. Reload the editor before saving.");
    const record = { bindingId: binding.bindingId, definition: clone(definition), reason, sourceDigest, revision, digest, updatedBy: ctx.subject, updatedAt: ctx.state.clock };
    bindingHistory(ctx).push(record);
    return ok(ctx, record);
  },
};
