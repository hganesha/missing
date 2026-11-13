import { externalProviderIndex, type GatewayProviderSource } from "@ehf/fincrime-views";
import type { Schemas } from "@ehf/ui-contracts";
import { validatorFor } from "@ehf/ui-contracts/validate";
import catalog from "../../../../config/connector-catalog.json" with { type: "json" };
import { clone } from "../fixtures.js";
import { fail, ok, type Ctx, type Impl } from "../http.js";
import { tenantCatalogSnapshot } from "./catalogs.js";

// Synthetic gateway facts, confined to the mock bundle.
const gateway: GatewayProviderSource = {
  adapters: catalog.connectorTemplates.map(template => ({ id: template.adapterId, credentialState: "Missing" })),
  modules: catalog.connectorTemplates.map(template => ({ id: template.adapterId, label: template.adapterId.replaceAll("-", " "), enabled: template.adapterId !== "skills", connectorTemplate: template })),
  connectors: catalog.connectors.map(connector => ({ connector })) as GatewayProviderSource["connectors"],
};
const rows = (ctx: Ctx) => {
  const tenant = String(ctx.session.tenant.tenantId);
  if (!ctx.state.externalProviders.has(tenant)) ctx.state.externalProviders.set(tenant, []);
  return ctx.state.externalProviders.get(tenant)!;
};
const index = async (ctx: Ctx) => externalProviderIndex(await tenantCatalogSnapshot(ctx), rows(ctx), gateway, ctx.state.clock);

export const externalProviders: Record<string, Impl> = {
  getExternalProviders: async ctx => ok(ctx, await index(ctx)),
  postExternalProviders: async ctx => {
    if (!validatorFor("ExternalProviderDraft")(ctx.body)) return fail(ctx, 400, "external_provider.invalid", "Check the provider ID and name.");
    const draft = ctx.body as Schemas["ExternalProviderDraft"];
    if ((await index(ctx)).items.some(provider => provider.id === draft.id)) return fail(ctx, 409, "external_provider.already_exists", "This provider already exists. Configure its connections instead.");
    rows(ctx).push({ provider: clone(draft), origin: "custom", createdAt: ctx.state.clock, createdBy: ctx.subject, connections: [], activity: [{ action: "provider.created", connectionId: null, revision: null, actor: ctx.subject, at: ctx.state.clock }] });
    return ok(ctx, { id: draft.id }, 201);
  },
  postExternalProvidersProviderIdConnections: async ctx => {
    const connection = ctx.body?.connection as Schemas["ExternalConnectionDraft"] | undefined;
    const expected = ctx.body?.expectedRevision;
    if (!connection || !validatorFor("ExternalConnectionDraft")(connection) || !(expected === null || Number.isInteger(expected) && Number(expected) > 0)) return fail(ctx, 400, "external_provider.connection_invalid", "Check the connection fields.");
    if (connection.endpoint) {
      try { const url = new URL(connection.endpoint); if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error(); }
      catch { return fail(ctx, 400, "external_provider.connection_invalid", "Use an HTTPS endpoint without credentials, query or fragment."); }
    }
    if (connection.adapterId) {
      const template = catalog.connectorTemplates.find(template => template.adapterId === connection.adapterId);
      if (!template) return fail(ctx, 400, "external_provider.adapter_unsupported", "Choose a supported adapter.");
      if (connection.binding && !new RegExp(template.bindingPattern).test(connection.binding)) return fail(ctx, 400, "external_provider.binding_invalid", "The operation does not match the adapter's binding format.");
      if (connection.capabilityIds.some(id => !template.capabilityIds.includes(id))) return fail(ctx, 400, "external_provider.capability_incompatible", "This adapter does not serve the selected capability.");
    } else if (connection.binding || connection.capabilityIds.length) return fail(ctx, 400, "external_provider.adapter_required", "Choose an adapter before an operation or capability.");
    const known = (await index(ctx)).items.find(provider => provider.id === ctx.params.providerId);
    if (!known) return fail(ctx, 404, "external_provider.not_found", "This provider no longer exists.");
    if (known.quarantined) return fail(ctx, 409, "external_provider.quarantined", "This provider is quarantined.");
    let provider = rows(ctx).find(row => row.provider.id === known.id);
    if (!provider) {
      provider = { provider: { id: known.id, name: known.name, description: known.description }, origin: "catalog", createdAt: ctx.state.clock, createdBy: ctx.subject, connections: [], activity: [] };
      rows(ctx).push(provider);
    }
    const before = provider.connections.find(row => row.connection.id === connection.id);
    if (expected === null ? Boolean(before) : before?.revision !== expected) return fail(ctx, 409, "external_provider.connection_revision_conflict", "This draft changed. Reopen the connection to load its latest revision.");
    const record = { connection: clone(connection), revision: (before?.revision ?? 0) + 1, createdAt: before?.createdAt ?? ctx.state.clock, updatedAt: ctx.state.clock, updatedBy: ctx.subject };
    if (before) provider.connections = provider.connections.map(row => row.connection.id === connection.id ? record : row);
    else provider.connections.push(record);
    provider.activity.unshift({ action: before ? "connection.updated" : "connection.created", connectionId: connection.id, revision: record.revision, actor: ctx.subject, at: ctx.state.clock });
    return ok(ctx, record, before ? 200 : 201);
  },
};
