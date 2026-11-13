#!/usr/bin/env node
// Generates config/connector-catalog.json: every canonical capability the platform knows and
// every connector (gateway adapter binding) that can serve one.
//
//   node scripts/sync-connector-catalog.mjs [--source <atlas dir>] [--out <file>] [--check]
//
// --source  the provider atlas inside a data-adapters checkout
//           (default: apps/kyc-wiring/vendor/atlas)
// --out     output path (default: config/connector-catalog.json)
// --check   do not write; exit 1 when the committed file differs from what would be generated
//
// Naming rules: docs/implementation/capability-naming.md. No dependencies; deterministic
// output (sorted, canonical key order, two-space JSON, trailing newline).
//
// The atlas's v2 canonical capability model (<source>/capability-model/, design in
// data-adapters docs/CANONICAL_EXTERNAL_CAPABILITY_MODEL.md) is the semantic layer: every
// atlas-derived capability carries its v2 definition, every wiring connector its v2 bindings
// and migration disposition, and the v2 families without a legacy name become capabilities
// `<capability_path>.v1`. Capability IDs of the 37 legacy names are unchanged.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const source = resolve(option("--source", resolve(repoRoot, "apps/kyc-wiring/vendor/atlas")));
const out = resolve(option("--out", resolve(repoRoot, "config/connector-catalog.json")));
const check = args.includes("--check");

const CANONICAL = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$/;
const ATLAS_CATALOG = "data-adapters/api-wiring/vendor/atlas";
const PLATFORM_CATALOG = "ehfconcept/platform";

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const capabilitiesPath = resolve(source, "catalog/capabilities.json");
const operationsPath = resolve(source, "catalog/provider-capabilities.json");
const providersPath = resolve(source, "catalog/providers.json");
const atlasCapabilities = readJson(capabilitiesPath);
const atlasOperations = readJson(operationsPath);
const atlasProviders = new Map(readJson(providersPath).map((provider) => [provider.provider_id, provider]));
const modelDir = resolve(source, "capability-model");
const definitionsPath = resolve(modelDir, "capability-definitions.json");
const crosswalkPath = resolve(modelDir, "legacy-crosswalk.json");
const readRegistry = (path) => {
  try {
    return readJson(path);
  } catch {
    throw new Error(`v2 capability model missing: ${path} (data-adapters with capability-model/ is required)`);
  }
};
const modelDefinitions = readRegistry(definitionsPath);
const modelCrosswalk = readRegistry(crosswalkPath);
const MODEL_VERSION = modelDefinitions.model_version;

function sourceRevision() {
  // The atlas lives in this repository (apps/kyc-wiring/vendor/atlas), so a git revision would
  // change with every commit: pin the exact inputs instead.
  const hash = createHash("sha256");
  for (const path of [capabilitiesPath, operationsPath, providersPath, definitionsPath, crosswalkPath]) hash.update(readFileSync(path));
  return `sha256:${hash.digest("hex")}`;
}
const atlasRevision = sourceRevision();

// Atlas capabilities that change state outside the platform; everything else only reads.
const EXTERNAL_EFFECT = new Set([
  "case.manage", "regulatory.report", "questionnaire.collect",
  "monitoring.subscribe", "workflow.orchestrate", "travel_rule.exchange",
]);

const ATLAS_DESCRIPTIONS = {
  "identity.person.verify": "Verify that a natural person is who they claim to be.",
  "identity.document.verify": "Verify an identity document's authenticity and extract its fields.",
  "identity.biometric.verify": "Match and liveness-check a biometric sample against an identity.",
  "identity.address.verify": "Verify a residential or registered address.",
  "identity.digital_id.verify": "Verify a government or scheme-issued digital identity.",
  "identity.tax_id.verify": "Verify a tax identifier against its issuing authority.",
  "business.verify": "Verify that a business exists and matches the details supplied.",
  "business.registry.lookup": "Look up a company in an official business registry.",
  "business.ownership.discover": "Discover beneficial owners and the ownership chain of a business.",
  "business.officers.lookup": "Look up the directors and officers of a business.",
  "screening.sanctions": "Screen a party against sanctions lists.",
  "screening.pep": "Screen a party for politically exposed person status.",
  "screening.adverse_media": "Screen a party against adverse-media sources.",
  "screening.enforcement": "Screen a party against regulatory enforcement actions.",
  "screening.payment": "Screen a payment and its parties.",
  "risk.device": "Assess device risk signals.",
  "risk.email": "Assess email-address risk signals.",
  "risk.phone": "Assess phone-number risk signals.",
  "risk.network": "Assess IP and network risk signals.",
  "risk.jurisdiction": "Assess jurisdiction and country risk.",
  "risk.customer.assess": "Produce a customer risk assessment.",
  "account.ownership.verify": "Verify ownership of a bank account.",
  "financial.evidence.retrieve": "Retrieve financial evidence such as statements or income data.",
  "transaction.monitor": "Monitor transactions for suspicious activity.",
  "case.manage": "Create or update a case in an external case-management system.",
  "regulatory.report": "File a regulatory report.",
  "crypto.wallet.screen": "Screen a crypto wallet address.",
  "crypto.transaction.monitor": "Monitor crypto transactions for risk.",
  "travel_rule.exchange": "Exchange travel-rule originator and beneficiary data with a counterparty.",
  "edd.report.retrieve": "Retrieve an enhanced-due-diligence report.",
  "entity.resolve": "Resolve records that refer to the same real-world entity.",
  "monitoring.subscribe": "Subscribe a party to ongoing monitoring.",
  "reference.identifier.lookup": "Look up an entity by a reference identifier such as an LEI.",
  "reference.list.ingest": "Ingest a reference list such as an official sanctions list.",
  "workflow.orchestrate": "Run a provider-hosted verification workflow.",
  "credential.verify": "Verify a verifiable credential.",
  "questionnaire.collect": "Collect a due-diligence questionnaire from a party.",
};

const dataClassesFor = (name) => /^(business|reference|screening)\./.test(name) ? ["pii", "public-source"] : ["pii"];

// ---------------------------------------------------------------- v2 canonical model
// A v2 family's platform ID: its legacy atlas name when it has one, else its path; `.v1`.
const definitionsByPath = new Map(modelDefinitions.records.map((definition) => [definition.capability_path, definition]));
const platformIdForPath = (path) => {
  const definition = definitionsByPath.get(path);
  if (!definition) throw new Error(`unknown v2 capability path: ${path}`);
  return `${definition.legacy_aliases[0] ?? path}.v1`;
};
const canonicalDefinition = (definition) => ({
  capabilityPath: definition.capability_path,
  modelVersion: MODEL_VERSION,
  definitionVersion: definition.definition_version,
  status: definition.status,
  kind: definition.kind,
  jurisdictionBasis: definition.jurisdiction_basis,
  requiredScopeFields: definition.required_scope_fields,
  subjectTypes: definition.subject_types,
  defaultAction: definition.default_action,
  resultFamily: definition.result_family,
  legacyCapability: definition.legacy_aliases[0] ?? null,
  notSubstitutableFor: definition.not_substitutable_for.map(platformIdForPath).sort(),
});
const definitionForLegacy = new Map(modelDefinitions.records
  .filter((definition) => definition.legacy_aliases.length)
  .map((definition) => [definition.legacy_aliases[0], definition]));
const crosswalkByBinding = new Map(modelCrosswalk.records.map((record) => [record.legacy_binding_id, record]));
// Operational and testing families change state outside the platform.
const effectForDefinition = (definition) => (definition.kind === "operational" || definition.kind === "testing" ? "external" : "read");

// Bindings the platform already uses or advertises (KYC v2 package, gateway examples), and
// the direct live adapter for sanctions and PEP screening.
const DEFAULT_OVERRIDES = {
  "screening.sanctions": "opensanctions:sanctions",
  "screening.pep": "opensanctions:pep",
  "screening.adverse_media": "wiring:complyadvantage:screening.adverse_media",
  "business.registry.lookup": "wiring:companies-house:business.registry.lookup",
  "reference.identifier.lookup": "wiring:gleif:reference.identifier.lookup",
  "identity.document.verify": "wiring:persona:identity.document.verify",
};

// Providers the wiring service reaches through a documented-subset native HTTP connector
// (api-wiring/scripts/generate_inventory.py); adapter IDs as the atlas spells them.
const NATIVE_SUBSET = new Set(["persona", "companies_house", "opencorporates", "gleif", "opensanctions", "plaid"]);

// ---------------------------------------------------------------- canonical capabilities
const capabilities = new Map();
const addCapability = (capability) => {
  if (!CANONICAL.test(capability.capabilityId)) throw new Error(`not canonical: ${capability.capabilityId}`);
  if (capabilities.has(capability.capabilityId)) throw new Error(`duplicate capability: ${capability.capabilityId}`);
  capabilities.set(capability.capabilityId, { atlasCapability: null, resultFamily: null, dataClasses: ["pii"], defaultConnectorId: null, canonical: null, ...capability });
};

for (const entry of atlasCapabilities) {
  const name = entry.capability;
  const definition = definitionForLegacy.get(name);
  if (!definition) throw new Error(`atlas capability without a v2 definition: ${name}`);
  addCapability({
    capabilityId: `${name}.v1`,
    atlasCapability: name,
    resultFamily: entry.result_family,
    kind: "tool",
    effect: EXTERNAL_EFFECT.has(name) ? "external" : "read",
    description: ATLAS_DESCRIPTIONS[name] ?? `${name} (provider atlas capability).`,
    dataClasses: dataClassesFor(name),
    canonical: canonicalDefinition(definition),
  });
}

// The v2 families that have no legacy atlas name (account profiles, transactions, document
// artifacts, composite watchlists, platform controls, ...). No catalog binding serves them yet.
for (const definition of modelDefinitions.records.filter((record) => !record.legacy_aliases.length)) {
  addCapability({
    capabilityId: platformIdForPath(definition.capability_path),
    resultFamily: definition.result_family,
    kind: "tool",
    effect: effectForDefinition(definition),
    description: definition.definition,
    dataClasses: dataClassesFor(definition.capability_path),
    canonical: canonicalDefinition(definition),
  });
}

const platformCapabilities = [
  ["context.documents.search.v1", "tool", "read", "Search captured, authorized document text with exact citations.", ["pii"]],
  ["context.documents.citation.v1", "tool", "read", "Resolve a version-pinned citation after current access checks.", ["pii"]],
  ["context.records.fetch.v1", "tool", "read", "Fetch canonical records from an enabled, version-pinned context mapping.", ["pii"]],
  ["document.evidence.ingest.v1", "tool", "external", "Parse one case document into provisional, source-cited evidence.", ["pii", "confidential"]],
  ["document.evidence.package.v1", "tool", "read", "Export the canonical evidence package for a case.", ["pii", "confidential"]],
  ["document.ownership.graph.v1", "tool", "read", "Export a case's ownership and control graph from its evidence.", ["pii", "confidential"]],
  ["document.evidence.resume.v1", "tool", "external", "Submit a human review decision to a paused evidence run.", ["pii", "confidential"]],
  ["investigation.web.search.v1", "tool", "read", "Governed public-source search returning cited findings in the public-source format.", ["pii", "public-source"]],
  ["policy.kyc.lookup.v1", "tool", "read", "Look up the KYC policy rules that apply to a case.", ["confidential"]],
  ["knowledge.vector.search.v1", "tool", "read", "Search an approved vector index and return provenance-bearing passages.", ["internal"]],
  ["customer.internal.search.v1", "tool", "read", "Search approved internal customer systems with a purpose-bound query.", ["pii", "internal"]],
  ["identity.ocr.extract.v1", "tool", "read", "Extract structured identity-document fields with OCR.", ["pii"]],
  ["context.source.read.v1", "tool", "read", "Read a qualified enterprise context source into canonical records.", ["internal"]],
  ["integration.http.operation.v1", "tool", "read", "Invoke one allowlisted HTTP API operation.", ["internal"]],
  ["function.uc.invoke.v1", "tool", "read", "Invoke one governed Unity Catalog function with bound parameters and return its rows.", ["internal"]],
  ["skill.business.execute.v1", "tool", "read", "Execute one pinned business skill on an approved skill-host bundle (skill.execution.v1); records and effects come back as proposals.", ["pii", "confidential"]],
  ["procurement.vendor.lookup.v1", "tool", "read", "Look up a vendor record.", ["internal"]],
  ["procurement.purchase_order.lookup.v1", "tool", "read", "Look up a purchase order.", ["internal"]],
  ["foundry.agent.prompt.v1", "model", "paid", "A single inference through a deployment-qualified Azure Foundry prompt agent.", ["confidential"]],
  ["model.general.inference.v1", "model", "paid", "Structured inference through an administered model profile; the connector names the profile.", ["confidential"]],
  ["model.kyc.case_assessment.v2", "model", "paid", "Assess a KYC case from its screening, registry and evidence results.", ["pii", "confidential"]],
  ["model.kyc.investigation.v1", "model", "paid", "Plan and summarize a bounded, connector-driven KYC investigation (agent loop).", ["pii", "confidential"]],
  // The financial-crime skill library's provider dependencies (CR-8; request/response contracts in
  // @ehf/library-contracts). fraud.liveness maps to the existing identity.biometric.verify.v1.
  ["document.entities.extract.v1", "model", "paid", "Extract entity mentions with page offsets from document page text (skill library document.entities).", ["pii", "confidential"]],
  ["document.translate.v1", "model", "paid", "Translate document page text, keeping the source text beside each translation (skill library document.translate).", ["pii", "confidential"]],
  ["document.fields.extract.v1", "model", "paid", "Extract every field of a document field-catalog contract with exact page spans; the library validates the result and nothing is promoted (EHF extension document.fields).", ["pii", "confidential"]],
  ["decision.document.advisory.v1", "model", "paid", "Ask a pinned System 1 decision model bounded advisory questions about a document's extraction (catalog type, value equivalence, span support); answers only add review and abstentions change nothing (document factory plan §6.5).", ["pii", "confidential"]],
  ["document.model.extract.v1", "tool", "read", "Read a document artifact with a provider extraction model (Azure Document Intelligence prebuilt models first) and return catalog field candidates for the library to anchor and adjudicate; nothing is promoted (EHF extension document.model).", ["pii", "confidential"]],
  ["document.ocr.extract.v1", "tool", "read", "Decode a stored document artifact into numbered page text with parser lineage (EHF extension document.ocr).", ["pii", "confidential"]],
  ["document.forensics.assess.v1", "tool", "read", "Assess document authenticity from document hashes; the result is an assessment, never a decision (skill library document.forensics).", ["pii", "confidential"]],
  ["fraud.identity.synthetic.v1", "tool", "read", "Specialist synthetic-identity detector returning a scored, limited assessment (skill library fraud.synthetic_identity).", ["pii"]],
  ["fraud.identity.theft.v1", "tool", "read", "Specialist identity-theft detector returning a scored, limited assessment (skill library fraud.identity_theft).", ["pii"]],
  ["fraud.document.tamper.v1", "tool", "read", "Specialist document-tamper detector returning a scored, limited assessment (skill library fraud.document_tamper).", ["pii"]],
  ["fraud.media.deepfake.v1", "tool", "read", "Specialist deepfake detector for submitted media returning a scored, limited assessment (skill library fraud.deepfake).", ["pii"]],
  ["fraud.account_takeover.v1", "tool", "read", "Specialist account-takeover detector over sessions and device signals returning a scored, limited assessment (skill library fraud.account_takeover).", ["pii"]],
];
for (const [capabilityId, kind, effect, description, dataClasses] of platformCapabilities) {
  addCapability({ capabilityId, kind, effect, description, dataClasses });
}

// ---------------------------------------------------------------- connectors
const connectors = new Map();
const addConnector = (connector) => {
  if (connectors.has(connector.connectorId)) throw new Error(`duplicate connector: ${connector.connectorId}`);
  if (!capabilities.has(connector.capabilityId)) throw new Error(`unknown capability for ${connector.connectorId}: ${connector.capabilityId}`);
  connectors.set(connector.connectorId, connector);
};

// Wiring: one connector per atlas provider x capability record. Readiness follows the wiring
// service (wiring/core.py Registry.readiness/blockers) for a binding with no approved contract.
const NO_CONTRACT_BLOCKERS = [
  "approved_native_contract_missing", "vendor_credentials_missing", "entitlements_unvalidated",
  "country_and_residency_scope_missing", "vendor_sandbox_acceptance_missing",
];
const wiringRank = new Map();
const providersWithNormalizer = new Set(atlasOperations.filter((op) => op.adapter_id).map((op) => op.provider_id));
const nativeProviders = new Set(atlasOperations.filter((op) => NATIVE_SUBSET.has(op.adapter_id)).map((op) => op.provider_id));
// v2 dispositions other than a plain vocabulary alias: the connector keeps its legacy capability
// (its binding still calls the legacy wiring operation) but is never a default, and the gateway
// refuses to bind it (packages/adapters KYC_WIRING_BLOCKED_BINDINGS).
const CANONICAL_BLOCKERS = { migration_required: "canonical_semantic_correction_pending", quarantined: "quarantined_reference" };
const canonicalUsable = new Set();
for (const op of atlasOperations) {
  const provider = atlasProviders.get(op.provider_id);
  const quarantined = op.status.startsWith("quarantined")
    || String(provider?.routing_eligibility ?? "").startsWith("quarantined");
  const connectorId = `wiring:${op.provider_id}:${op.capability}`;
  const crosswalk = crosswalkByBinding.get(op.operation_id);
  if (!crosswalk) throw new Error(`atlas binding without a v2 crosswalk record: ${op.operation_id}`);
  if ((crosswalk.legacy_runtime_disposition === "quarantined") !== quarantined) throw new Error(`quarantine disagrees with v2 crosswalk: ${op.operation_id}`);
  const jurisdictions = [...new Set(crosswalk.capability_ids.map((id) => id.slice(id.lastIndexOf(".") + 1)))].sort();
  const canonicalBlockers = [
    ...(CANONICAL_BLOCKERS[crosswalk.legacy_runtime_disposition] && !quarantined ? [CANONICAL_BLOCKERS[crosswalk.legacy_runtime_disposition]] : []),
    jurisdictions.includes("unresolved") ? "canonical_jurisdiction_unresolved" : "canonical_jurisdiction_not_approved",
  ];
  if (crosswalk.legacy_runtime_disposition === "alias_pending_approval") canonicalUsable.add(connectorId);
  addConnector({
    connectorId,
    adapterId: "wiring",
    providerId: op.provider_id,
    providerName: provider?.name ?? null,
    capabilityId: `${op.capability}.v1`,
    operation: op.capability,
    resultFamily: op.result_family,
    status: quarantined ? "quarantined" : "available",
    demoSupported: !quarantined,
    liveBlockers: quarantined ? ["quarantined_reference"] : [...NO_CONTRACT_BLOCKERS, ...canonicalBlockers],
    source: { catalog: ATLAS_CATALOG, revision: atlasRevision },
    canonical: {
      legacyBindingId: crosswalk.legacy_binding_id,
      bindingIds: crosswalk.binding_ids,
      capabilityIds: crosswalk.capability_ids,
      capabilityPaths: crosswalk.capability_ids.map((id) => id.slice(0, id.indexOf(".intelligence."))),
      jurisdictions,
      migration: crosswalk.migration,
      runtimeDisposition: crosswalk.legacy_runtime_disposition,
    },
  });
  // Lower is preferred: a fixture normalizer on a native connector, any fixture normalizer,
  // a provider the wiring service already reaches natively, one with any normalizer, the rest.
  const rank = quarantined || !canonicalUsable.has(connectorId) ? 99
    : op.adapter_id && NATIVE_SUBSET.has(op.adapter_id) ? 0
      : op.adapter_id ? 1
        : nativeProviders.has(op.provider_id) ? 2
          : providersWithNormalizer.has(op.provider_id) ? 3 : 4;
  wiringRank.set(connectorId, rank);
}

const platform = (connector) => addConnector({
  providerId: null, providerName: null, resultFamily: null, status: "live_ready", demoSupported: false, liveBlockers: [], canonical: null,
  source: { catalog: PLATFORM_CATALOG, revision: "adapter-registry" },
  ...connector,
});

for (const [binding, capabilityId] of [["sanctions", "screening.sanctions.v1"], ["pep", "screening.pep.v1"]]) {
  platform({
    connectorId: `opensanctions:${binding}`, adapterId: "opensanctions", providerId: "opensanctions", providerName: "OpenSanctions",
    capabilityId, operation: binding, resultFamily: "screening",
  });
}

for (const [binding, capabilityId] of [
  ["ingest", "document.evidence.ingest.v1"], ["package", "document.evidence.package.v1"],
  ["ownership", "document.ownership.graph.v1"], ["resume", "document.evidence.resume.v1"],
  // The skill library's document.ocr (document.parse.artifact): a parsed document's decoded pages.
  ["pages", "document.ocr.extract.v1"],
]) {
  platform({
    connectorId: `evidence:${binding}`, adapterId: "evidence", providerId: "kyc-evidence-pipeline", providerName: "KYC evidence pipeline",
    capabilityId, operation: binding, demoSupported: true,
  });
}

// Route A for case document runs: the run's own original, read by the document model of the release in effect.
platform({
  connectorId: "document-model:azure_document_intelligence", adapterId: "document-model", providerId: "azure_document_intelligence",
  providerName: "Azure Document Intelligence", capabilityId: "document.model.extract.v1", operation: "azure_document_intelligence",
});

platform({
  connectorId: "pgvector:knowledge.search", adapterId: "pgvector", providerId: "postgresql", providerName: "PostgreSQL pgvector",
  capabilityId: "knowledge.vector.search.v1", operation: "knowledge.search",
});

const modelProfiles = readJson(resolve(repoRoot, "config/model-profiles.json")).profiles ?? [];
for (const profile of modelProfiles) {
  platform({
    connectorId: `openrouter:${profile.id}`, adapterId: "openrouter", providerId: profile.provider,
    providerName: profile.provider === "openrouter" ? "OpenRouter" : profile.provider,
    capabilityId: "model.general.inference.v1", operation: profile.id,
    // Without a provider credential the model adapter falls back to recorded responses (development only).
    demoSupported: true,
    source: { catalog: PLATFORM_CATALOG, revision: "config/model-profiles.json" },
  });
  // The skill library's document.fields (EHF document wrappers) through the same profile. Unlike
  // general inference there is no recorded fallback: without a credential the call fails.
  platform({
    connectorId: `openrouter:document_fields.${profile.id}`, adapterId: "openrouter", providerId: profile.provider,
    providerName: profile.provider === "openrouter" ? "OpenRouter" : profile.provider,
    capabilityId: "document.fields.extract.v1", operation: `document_fields.${profile.id}`,
    demoSupported: false,
    source: { catalog: PLATFORM_CATALOG, revision: "config/model-profiles.json" },
  });
}

for (const [binding, capabilityId] of [
  ["screening.sanctions.search", "screening.sanctions.v1"], ["screening.pep.search", "screening.pep.v1"],
  ["screening.adverse-media.search", "screening.adverse_media.v1"], ["investigation.web.search", "investigation.web.search.v1"],
  ["policy.kyc.lookup", "policy.kyc.lookup.v1"], ["vendor.lookup", "procurement.vendor.lookup.v1"],
  ["purchase_order.lookup", "procurement.purchase_order.lookup.v1"],
  // Skill library sandbox connectors (packages/adapters librarySandboxResponse): INCONCLUSIVE only.
  ["library.document.forensics", "document.forensics.assess.v1"], ["library.fraud.synthetic_identity", "fraud.identity.synthetic.v1"],
  ["library.fraud.identity_theft", "fraud.identity.theft.v1"], ["library.fraud.document_tamper", "fraud.document.tamper.v1"],
  ["library.fraud.deepfake", "fraud.media.deepfake.v1"], ["library.fraud.account_takeover", "fraud.account_takeover.v1"],
]) {
  platform({
    connectorId: `simulator:${binding}`, adapterId: "simulator", capabilityId, operation: binding,
    status: "available", demoSupported: true, liveBlockers: ["simulator_only"],
  });
}

// ---------------------------------------------------------------- connector templates
// Cloud adapters whose binding names are deployment-specific (an endpoint, an index, a
// deployment) publish a template instead of connectors; operators register concrete
// connectors from it (gateway POST /v1/connectors). These mirror the gateway modules in
// apps/capability-gateway/src/adapters/ (databricks.ts, http-operation.ts); the gateway's
// catalog-consistency test fails if they drift. Docs: docs/implementation/capability-adapters.md.
const DATABRICKS_ENV = ["DATABRICKS_HOST", "DATABRICKS_AUTH", "DATABRICKS_CLIENT_ID", "DATABRICKS_CLIENT_SECRET"];
const UC_NAME = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;
const connectorTemplates = [
  {
    adapterId: "foundry-agent", cloud: "vendor", bindingPattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$",
    capabilityIds: ["foundry.agent.prompt.v1"],
    configEnv: ["FOUNDRY_TRACE_BINDING_JSON", "FOUNDRY_AGENT_MANAGED_IDENTITY_CLIENT_ID"],
    description: "A deployment-qualified, version-pinned Azure Foundry prompt agent with no provider tools.",
  },
  { adapterId: "context-salesforce", cloud: "any", bindingPattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$", capabilityIds: ["context.records.fetch.v1"], configEnv: [], description: "On-demand case-scoped API reads through a reviewed subject binding and enabled ontology mapping." },
  { adapterId: "context-fenergo", cloud: "any", bindingPattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$", capabilityIds: ["context.records.fetch.v1"], configEnv: [], description: "On-demand case-scoped API reads through a reviewed subject binding and enabled ontology mapping." },
  { adapterId: "context-documents", cloud: "any", bindingPattern: "^(search|citation)$", capabilityIds: ["context.documents.search.v1", "context.documents.citation.v1"], configEnv: ["CASE_API_URL"], description: "Case-scoped lexical retrieval and exact citation resolution under signed read grants." },
  { adapterId: "context-postgres", cloud: "any", bindingPattern: "^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$", capabilityIds: ["context.records.fetch.v1"], configEnv: [], description: "Bounded approved-view reads through an enabled, version-pinned canonical mapping." },
  { adapterId: "context-source", cloud: "any", bindingPattern: "^([a-f0-9]{16}):([a-z][a-z0-9_-]{1,63})\\.r([1-9][0-9]*)$", capabilityIds: ["context.source.read.v1"], configEnv: ["CONTEXT_SOURCE_TARGETS_JSON"], description: "Read a qualified, revision-pinned enterprise context source." },
  {
    adapterId: "databricks-serving", cloud: "databricks", bindingPattern: /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}(:(chat|responses))?$/.source,
    capabilityIds: ["model.general.inference.v1"], configEnv: [...DATABRICKS_ENV, "DATABRICKS_SERVING_MAX_OUTPUT_TOKENS"],
    description: "A Mosaic AI model or agent serving endpoint: <endpoint> or <endpoint>:chat for OpenAI-compatible chat, <endpoint>:responses for a ResponsesAgent.",
  },
  {
    adapterId: "databricks-vector", cloud: "databricks", bindingPattern: UC_NAME.source,
    capabilityIds: ["knowledge.vector.search.v1"], configEnv: [...DATABRICKS_ENV, "DATABRICKS_VECTOR_COLUMNS"],
    description: "A Databricks Vector Search index with managed or self-managed embeddings, named catalog.schema.index.",
  },
  {
    adapterId: "databricks-uc", cloud: "databricks", bindingPattern: UC_NAME.source,
    capabilityIds: ["function.uc.invoke.v1"], configEnv: [...DATABRICKS_ENV, "DATABRICKS_WAREHOUSE_ID"],
    description: "A Unity Catalog function, named catalog.schema.function, executed on a SQL warehouse with bound parameters.",
  },
  {
    adapterId: "http-operation", cloud: "any", bindingPattern: /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.source,
    capabilityIds: ["integration.http.operation.v1"],
    configEnv: ["HTTP_OPERATIONS_BASE_URL", "HTTP_OPERATIONS_JSON", "HTTP_OPERATIONS_AUTH", "HTTP_OPERATIONS_API_KEY_HEADER", "HTTP_OPERATIONS_API_KEY"],
    description: "One operation from the HTTP_OPERATIONS_JSON allowlist; mutating methods require a non-read capability effect.",
  },
  {
    // apps/capability-gateway/src/adapters/decisions.ts; config/decision-bindings.json (plan §6.6).
    adapterId: "decisions", cloud: "any", bindingPattern: /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.source,
    capabilityIds: ["decision.document.advisory.v1"],
    configEnv: ["DECISION_BINDINGS_PATH", "OPENROUTER_API_KEY", "DECISION_FOUNDRY_ENDPOINT", "DECISION_FOUNDRY_AUTH"],
    description: "A pinned System 1 decision binding from config/decision-bindings.json (decisions:<binding id>): OpenRouter Decisions or an Azure AI Foundry deployment; answers only add review.",
  },
  {
    // apps/capability-gateway/src/adapters/skills.ts; docs/implementation/skill-library-integration-contract.md.
    adapterId: "skills", cloud: "any", bindingPattern: /^[a-z][a-z_]*(\.[a-z][a-z0-9_]*)+$/.source,
    capabilityIds: ["skill.business.execute.v1"],
    configEnv: ["SKILL_HOST_URL", "SKILL_HOST_AUTH", "SKILL_HOST_GATEWAY_URL", "GATEWAY_SERVICE_TOKEN"],
    description: "A business skill served by an approved skill-host bundle, named by its catalog skill ID (skills:<skill_id>); the plan pins version, manifest and bundle digests.",
  },
].map((template) => {
  for (const capabilityId of template.capabilityIds) {
    if (!capabilities.has(capabilityId)) throw new Error(`unknown capability for template ${template.adapterId}: ${capabilityId}`);
  }
  return { ...template, capabilityIds: [...template.capabilityIds].sort(), configEnv: [...template.configEnv].sort() };
});

// ---------------------------------------------------------------- defaults
const PLATFORM_DEFAULTS = {
  "document.evidence.ingest.v1": "evidence:ingest",
  "document.evidence.package.v1": "evidence:package",
  "document.ownership.graph.v1": "evidence:ownership",
  "document.evidence.resume.v1": "evidence:resume",
  "document.ocr.extract.v1": "evidence:pages",
  "document.model.extract.v1": "document-model:azure_document_intelligence",
  // A dedicated profile with an output budget sized for full field contracts (document factory Phase 0 baseline).
  "document.fields.extract.v1": "openrouter:document_fields.model.document.v1",
  "investigation.web.search.v1": "simulator:investigation.web.search",
  "policy.kyc.lookup.v1": "simulator:policy.kyc.lookup",
  "knowledge.vector.search.v1": "pgvector:knowledge.search",
  "procurement.vendor.lookup.v1": "simulator:vendor.lookup",
  "procurement.purchase_order.lookup.v1": "simulator:purchase_order.lookup",
  "document.forensics.assess.v1": "simulator:library.document.forensics",
  "fraud.identity.synthetic.v1": "simulator:library.fraud.synthetic_identity",
  "fraud.identity.theft.v1": "simulator:library.fraud.identity_theft",
  "fraud.document.tamper.v1": "simulator:library.fraud.document_tamper",
  "fraud.media.deepfake.v1": "simulator:library.fraud.deepfake",
  "fraud.account_takeover.v1": "simulator:library.fraud.account_takeover",
  "model.general.inference.v1": "openrouter:model.standard.v1",
  "model.kyc.case_assessment.v2": "openrouter:model.standard.v1",
  "model.kyc.investigation.v1": "openrouter:model.deep.v1",
};
for (const capability of capabilities.values()) {
  const explicit = (capability.atlasCapability && DEFAULT_OVERRIDES[capability.atlasCapability]) ?? PLATFORM_DEFAULTS[capability.capabilityId];
  if (explicit) {
    if (!connectors.has(explicit)) throw new Error(`default connector missing: ${explicit}`);
    if (explicit.startsWith("wiring:") && !canonicalUsable.has(explicit)) throw new Error(`default connector is not a plain v2 alias: ${explicit}`);
    capability.defaultConnectorId = explicit;
    continue;
  }
  const candidates = [...connectors.values()]
    .filter((connector) => connector.capabilityId === capability.capabilityId && connector.adapterId === "wiring" && canonicalUsable.has(connector.connectorId))
    .sort((left, right) => (wiringRank.get(left.connectorId) - wiringRank.get(right.connectorId))
      || (left.connectorId < right.connectorId ? -1 : left.connectorId > right.connectorId ? 1 : 0));
  capability.defaultConnectorId = candidates[0]?.connectorId ?? null;
}

// ---------------------------------------------------------------- output
const byKey = (key) => (left, right) => (left[key] < right[key] ? -1 : left[key] > right[key] ? 1 : 0);
const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
};
const catalog = canonicalize({
  apiVersion: "harness.factory/connector-catalog-v1",
  generatedFrom: { catalog: ATLAS_CATALOG, revision: atlasRevision, canonicalModelVersion: MODEL_VERSION },
  capabilities: [...capabilities.values()].sort(byKey("capabilityId")),
  connectors: [...connectors.values()].sort(byKey("connectorId")),
  connectorTemplates: connectorTemplates.sort(byKey("adapterId")),
});
const text = `${JSON.stringify(catalog, null, 2)}\n`;

if (check) {
  let current = "";
  try { current = readFileSync(out, "utf8"); } catch { /* missing counts as stale */ }
  if (current !== text) {
    process.stderr.write(`${out} is stale; run node scripts/sync-connector-catalog.mjs\n`);
    process.exit(1);
  }
  process.stdout.write(`${out} is current\n`);
} else {
  writeFileSync(out, text);
  process.stdout.write(`wrote ${out}: ${catalog.capabilities.length} capabilities, ${catalog.connectors.length} connectors (atlas ${atlasRevision}, canonical model ${MODEL_VERSION})\n`);
}
