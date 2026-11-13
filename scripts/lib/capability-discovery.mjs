const PRIORITIES = new Set(['core', 'specialist', 'discovery', 'source', 'quarantined']);

/** Validate editorial metadata at generation time. No execution configuration is read or changed. */
export function capabilityDiscovery(providers, definitions, bindings, priorities, taxonomy) {
  const providerIds = new Set(providers.map(provider => provider.provider_id));
  const paths = new Set(definitions.map(definition => definition.capability_path));
  const collectionByPath = new Map();
  for (const collection of taxonomy.collections) {
    if (!collection.name || !collection.capabilityPaths.length) throw new Error('Empty capability collection');
    for (const path of collection.capabilityPaths) {
      if (!paths.has(path) || collectionByPath.has(path)) throw new Error(`Invalid or duplicate collection path: ${path}`);
      collectionByPath.set(path, collection.name);
    }
  }
  if (collectionByPath.size !== paths.size) throw new Error('Every capability definition needs exactly one collection');
  const byProvider = new Map();
  for (const priority of priorities.providers) {
    const id = priority.providerRecordId;
    if (!providerIds.has(id) || byProvider.has(id)) throw new Error(`Invalid or duplicate provider priority: ${id}`);
    if (!PRIORITIES.has(priority.priority) || priority.priorityStatus !== 'proposed') throw new Error(`Invalid provider priority: ${id}`);
    if (!['not_started', 'public_material_reviewed'].includes(priority.researchState)
      || !['unknown', 'publisher_reported'].includes(priority.adoptionEvidenceState)
      || !priority.familyId || !priority.rationale) throw new Error(`Invalid provider research metadata: ${id}`);
    if (priority.researchState === 'public_material_reviewed' && (!priority.reviewedAt || !priority.evidence.length)) throw new Error(`Missing research evidence: ${id}`);
    for (const evidence of priority.evidence) {
      const url = new URL(evidence.url);
      if (url.protocol !== 'https:' || url.username || url.password || !evidence.title || !evidence.observation || !evidence.limitation
        || !/^\d{4}-\d{2}-\d{2}$/.test(evidence.observedAt)) throw new Error(`Invalid research evidence: ${id}`);
    }
    const { providerRecordId: _id, ...discovery } = priority;
    byProvider.set(id, discovery);
  }
  if (byProvider.size !== providerIds.size) throw new Error('Every source provider needs a research priority');
  const collectionsByProvider = new Map(providers.map(provider => [provider.provider_id, new Set()]));
  for (const binding of bindings) {
    const collections = collectionsByProvider.get(binding.provider_record_id);
    if (!collections || !collectionByPath.has(binding.capability_path)) throw new Error(`Unknown discovery binding: ${binding.binding_id}`);
    collections.add(collectionByPath.get(binding.capability_path));
  }
  return {
    collectionByPath,
    providers: providers.map(provider => ({
      id: provider.provider_id,
      name: provider.name,
      discovery: { ...byProvider.get(provider.provider_id), collections: [...collectionsByProvider.get(provider.provider_id)].sort() },
    })).sort((a, b) => a.id.localeCompare(b.id)),
  };
}
