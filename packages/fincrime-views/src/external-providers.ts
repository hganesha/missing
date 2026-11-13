import type { Schemas } from "@ehf/ui-contracts";
import type { CatalogSnapshot } from "./catalogs.js";

type Provider = Schemas["ExternalProviderView"];
type Adapter = Schemas["ExternalAdapterView"];
export type GatewayProviderSource = {
  adapters: Array<{ id: string; credentialState: "Configured" | "Missing" | "Not required" }>;
  modules: Array<{ id: string; label: string; enabled: boolean; connectorTemplate: null | { bindingPattern: string; capabilityIds: string[]; configEnv: string[]; description: string } }>;
  connectors: Array<{ connector: { connectorId: string; providerId: string | null; providerName: string | null; adapterId: string; capabilityId: string; status: "available" | "live_ready" | "quarantined" | "retired"; liveBlockers: string[] } }>;
};
/** Catalog proposals, tenant configuration and gateway facts stay separate in this projection. */
export function externalProviderIndex(snapshot: CatalogSnapshot, records: Schemas["ExternalProviderRecord"][], gateway: GatewayProviderSource | null, generatedAt: string): Schemas["ExternalProviderIndex"] {
  const providers = new Map<string, Provider>();
  const discoveryById = new Map(snapshot.providers?.map(provider => [provider.id, provider.discovery]));
  const definitions = new Map(snapshot.entries.filter(entry => entry.kind === "external-capabilities" && entry.entryType === "definition").map(entry => [entry.id, entry]));
  const ensure = (id: string, name: string): Provider => {
    let provider = providers.get(id);
    if (!provider) {
      const discovery = discoveryById.get(id);
      provider = { id, name, description: "", origin: "catalog", quarantined: false, domains: [], capabilities: [], connections: [], gatewayBindings: [], activity: [],
        ...(discovery ? { discovery: { ...discovery, collections: [] } } : {}) };
      providers.set(id, provider);
    }
    return provider;
  };
  // Metadata only enriches visible bindings/tenant records; it never reintroduces filtered source rows.
  for (const entry of snapshot.entries) {
    if (entry.kind !== "external-capabilities" || entry.entryType !== "binding") continue;
    const contract = entry.contract as { provider_record_id?: string; capability_id?: string; jurisdiction?: { code?: string }; coverage?: { status?: string }; implementation?: { validation?: string }; governance?: { quarantine?: boolean; blockers?: string[] } };
    if (!contract.provider_record_id || !contract.capability_id) continue;
    const provider = ensure(contract.provider_record_id, entry.title.split(" · ")[0] ?? contract.provider_record_id);
    provider.quarantined ||= contract.governance?.quarantine === true || entry.status === "quarantined";
    if (!provider.domains.includes(entry.group)) provider.domains.push(entry.group);
    const definitionLink = entry.relationships.find(link => link.kind === "external-capabilities" && link.entryType === "definition");
    if (provider.discovery && entry.collection && !provider.discovery.collections.includes(entry.collection)) provider.discovery.collections.push(entry.collection);
    provider.capabilities.push({ id: entry.id, name: definitions.get(definitionLink?.id ?? "")?.title ?? definitionLink?.label ?? contract.capability_id, domain: entry.group, jurisdiction: contract.jurisdiction?.code ?? "unresolved", status: entry.statusLabel, blockers: contract.governance?.blockers ?? [],
      ...(entry.collection ? { collection: entry.collection } : {}), coverageStatus: contract.coverage?.status ?? "unknown", validation: contract.implementation?.validation ?? "none" });
  }
  for (const record of records) {
    const provider = ensure(record.provider.id, record.provider.name);
    Object.assign(provider, { name: record.provider.name, description: record.provider.description, origin: record.origin, connections: record.connections, activity: record.activity });
  }
  for (const { connector } of gateway?.connectors ?? []) {
    if (!connector.providerId) continue;
    const provider = ensure(connector.providerId, connector.providerName ?? connector.providerId);
    provider.quarantined ||= connector.status === "quarantined";
    provider.gatewayBindings.push({ id: connector.connectorId, capabilityId: connector.capabilityId, adapterId: connector.adapterId, status: connector.status, blockers: connector.liveBlockers });
  }
  const descriptors = new Map(gateway?.adapters.map(adapter => [adapter.id, adapter]));
  const adapters: Adapter[] = (gateway?.modules ?? []).flatMap(module => module.connectorTemplate ? [{ id: module.id, label: module.label,
    description: module.connectorTemplate.description, bindingPattern: module.connectorTemplate.bindingPattern,
    capabilityIds: module.connectorTemplate.capabilityIds, configEnv: module.connectorTemplate.configEnv,
    enabled: module.enabled, credentialState: descriptors.get(module.id)?.credentialState ?? "Unknown" }] : []);
  const items = [...providers.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { items, adapters, gatewayAvailable: gateway !== null, generatedAt, counts: {
    providers: items.length, declaredFamilies: new Set(items.map(provider => provider.discovery?.familyId ?? provider.id)).size,
    bindings: items.reduce((total, provider) => total + provider.capabilities.length, 0),
    unresolvedBindings: items.reduce((total, provider) => total + provider.capabilities.filter(capability => capability.jurisdiction === 'unresolved').length, 0),
    publiclyResearched: items.filter(provider => provider.discovery?.researchState === 'public_material_reviewed').length,
    quarantined: items.filter(provider => provider.quarantined).length,
  } };
}

/** Advisory checklist for a saved proposal; no item grants execution authority. */
export function externalConnectionBlockers(connection: Schemas["ExternalConnectionDraft"], adapters: Schemas["ExternalAdapterView"][], gatewayAvailable: boolean): string[] {
  const adapter = adapters.find(adapter => adapter.id === connection.adapterId);
  const blockers: string[] = [];
  if (!gatewayAvailable) blockers.push("Gateway readiness unavailable");
  if (!connection.adapterId) blockers.push("Adapter implementation required");
  else if (!adapter) blockers.push("Adapter template unavailable");
  else {
    if (!adapter.enabled) blockers.push("Adapter disabled in this deployment");
    if (adapter.credentialState === "Missing") blockers.push("Gateway credentials missing");
    if (adapter.credentialState === "Unknown") blockers.push("Gateway credential state unknown");
  }
  if (!connection.binding) blockers.push("Provider operation or deployment binding required");
  if (!connection.capabilityIds.length) blockers.push("Capability mapping required");
  if (connection.jurisdiction === "unresolved") blockers.push("Jurisdiction unresolved");
  if (!connection.coverageNote.trim()) blockers.push("Coverage scope not described");
  if ((connection.authentication === "api_key" || connection.authentication === "oauth2") && !connection.credentialRef) blockers.push("Credential reference required");
  blockers.push("Deployment configuration and binding review pending", "Provider acceptance and policy approval pending");
  return blockers;
}
