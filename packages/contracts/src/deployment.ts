import { z } from "zod";
import { foundryProjectTraceSchema, foundryResponseIdSchema } from "./foundry.js";

const label = z.string().trim().min(1).max(120);
export const secretReference = z.string().regex(/^(env:[A-Z][A-Z0-9_]{1,100}|file:\/run\/secrets\/[a-zA-Z0-9_.-]{1,100})$/);
const optionalReference = z.union([secretReference, z.literal("")]);
export const secureEndpoint = z.string().max(2048).refine(value => {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash && !url.search; } catch { return false; }
}, "Use an HTTPS endpoint without credentials or fragments");
const optionalEndpoint = z.union([secureEndpoint, z.literal("")]);
const azureGroup = String.raw`/subscriptions/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/resourceGroups/[a-z0-9_.()-]{1,90}`;
export const applicationInsightsResourceId = z.string().regex(new RegExp(`^${azureGroup}/providers/Microsoft\\.Insights/components/[a-z0-9_.()-]{1,260}$`, "i"));
const foundryDraftSchema = z.object({
  projectEndpoint: foundryProjectTraceSchema.shape.projectEndpoint.or(z.literal("")),
  agentName: foundryProjectTraceSchema.shape.agentName.or(z.literal("")),
  agentVersion: foundryProjectTraceSchema.shape.agentVersion.or(z.literal("")),
  applicationInsightsResourceId: foundryProjectTraceSchema.shape.applicationInsightsResourceId.or(z.literal("")),
}).strict();
const datetime = z.iso.datetime();
const legacyJaeger = z.object({
  endpoint: secureEndpoint,
  cutoverAt: datetime,
  readUntil: datetime,
}).strict().refine(binding => {
  const elapsed = Date.parse(binding.readUntil) - Date.parse(binding.cutoverAt);
  return elapsed > 0 && elapsed <= 90 * 86_400_000;
}, "Set a Jaeger retention window of up to 90 days after cutover");
export const observabilityProfileSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("otlp") }).strict(),
  z.object({
    backend: z.literal("azure_monitor"),
    applicationInsightsResourceId: applicationInsightsResourceId.or(z.literal("")),
    retentionDays: z.number().int().min(1).max(730).optional(),
    samplerRatio: z.number().min(0).max(1).optional(),
    legacyJaeger: legacyJaeger.optional(),
    foundry: foundryDraftSchema.optional(),
  }).strict(),
]);
export const foundryTraceQualificationSchema = foundryProjectTraceSchema.extend({
  apiVersion: z.literal("integralflow/foundry-trace-qualification-v1"),
  tenantId: z.string().regex(/^[a-zA-Z0-9._-]{1,100}$/),
  workspaceResourceId: z.string().regex(new RegExp(`^${azureGroup}/providers/Microsoft\\.OperationalInsights/workspaces/[a-z0-9-]{1,63}$`, "i")),
  workspaceTransformationResourceId: z.string().regex(new RegExp(`^${azureGroup}/providers/Microsoft\\.Insights/dataCollectionRules/[a-z0-9_.()-]{1,260}$`, "i")),
  workspaceTransformationEtag: z.string().min(1).max(256),
  queryIdentityId: z.string().regex(new RegExp(`^${azureGroup}/providers/Microsoft\\.ManagedIdentity/userAssignedIdentities/[a-z0-9_-]{1,128}$`, "i")),
  queryIdentityClientId: z.string().uuid(),
  traceId: z.string().regex(/^[a-f0-9]{32}$/).refine(value => !/^0+$/.test(value)),
  responseId: foundryResponseIdSchema,
  unrelatedApplicationInsightsResourceId: applicationInsightsResourceId,
  checkedAt: datetime,
  expiresAt: datetime,
  contentProbePassed: z.literal(true),
  protectedContentDenied: z.literal(true),
  unrelatedComponentDenied: z.literal(true),
}).strict();
export type FoundryTraceQualification = z.infer<typeof foundryTraceQualificationSchema>;
export function telemetryConfigured(profile: DeploymentProfile) {
  const binding = profile.foundation.observability;
  return Boolean(profile.foundation.telemetryEndpoint && (binding?.backend !== "azure_monitor" || binding.applicationInsightsResourceId));
}

export const DEPLOYMENT_ROLES = ["Platform.Admin", "Harness.Author", "Harness.Approver", "Harness.Operator", "Case.Analyst", "Case.Reviewer", "Case.Manager", "Platform.Auditor", "Data.Owner"] as const;
export const CONNECTOR_TEMPLATES = [
  { id: "postgresql", name: "PostgreSQL", group: "context", protocol: "postgresql", support: "configuration" },
  { id: "databricks", name: "Databricks", group: "context", protocol: "https", support: "configuration" },
  { id: "snowflake", name: "Snowflake", group: "context", protocol: "https", support: "configuration" },
  { id: "bigquery", name: "BigQuery", group: "context", protocol: "https", support: "configuration" },
  { id: "fabric", name: "Microsoft Fabric", group: "context", protocol: "https", support: "configuration" },
  { id: "sqlserver", name: "SQL Server", group: "context", protocol: "tds", support: "configuration" },
  { id: "object_store", name: "Object storage", group: "context", protocol: "https", support: "configuration" },
  { id: "kafka", name: "Kafka", group: "context", protocol: "kafka", support: "configuration" },
  { id: "openapi", name: "OpenAPI / REST", group: "context", protocol: "https", support: "configuration" },
  { id: "http_capability", name: "HTTP capability", group: "capability", protocol: "https", support: "configuration" },
  { id: "mcp", name: "MCP server", group: "capability", protocol: "https", support: "configuration" },
  { id: "webhook_in", name: "Inbound webhook", group: "input", protocol: "https", support: "configuration" },
  { id: "webhook_out", name: "Outbound webhook", group: "output", protocol: "https", support: "configuration" },
] as const;

export const azureDocumentAccountId = z.string().regex(new RegExp(`^${azureGroup}/providers/Microsoft\\.CognitiveServices/accounts/[a-z0-9-]{2,64}$`, "i"));
export const azureTrainingContainerId = z.string().regex(new RegExp(`^${azureGroup}/providers/Microsoft\\.Storage/storageAccounts/[a-z0-9]{3,24}/blobServices/default/containers/[a-z0-9-]{3,63}$`, "i"));
export const documentServicesSchema = z.object({
  modelTier: z.enum(["low", "med", "high", "xhigh"]),
  extractionPlanDigest: z.string().regex(/^$|^[a-f0-9]{64}$/),
  azure: z.object({
    resourceId: azureDocumentAccountId.or(z.literal("")),
    layout: z.boolean(),
    modelExtraction: z.boolean(),
    factory: z.boolean(),
    trainingContainerId: azureTrainingContainerId.or(z.literal("")).optional(),
  }).strict().optional(),
}).strict();

export const deploymentProfileSchema = z.object({
  apiVersion: z.literal("integralflow/deployment-v1"),
  environmentId: z.string().regex(/^[a-z][a-z0-9-]{1,39}$/),
  displayName: label,
  target: z.object({ provider: z.enum(["azure", "aws", "gcp", "kubernetes", "container"]), scopeId: z.string().max(1000), region: z.string().max(100), recipe: label }).strict(),
  foundation: z.object({
    posture: z.enum(["minimal", "resilient"]),
    database: z.object({ host: z.string().max(253).regex(/^$|^[a-zA-Z0-9][a-zA-Z0-9.-]*$/), port: z.number().int().min(1).max(65535), credentialRef: optionalReference }).strict(),
    objectStore: z.object({ provider: z.enum(["s3", "adls_gen2"]).optional(), endpoint: optionalEndpoint, bucket: z.string().max(200), credentialRef: optionalReference }).strict(),
    telemetryEndpoint: optionalEndpoint,
    observability: observabilityProfileSchema.optional(),
  }).strict(),
  intelligence: z.object({
    provider: z.enum(["openrouter", "openai", "azure_foundry", "databricks", "openai_compatible"]),
    endpoint: optionalEndpoint,
    credentialRef: optionalReference,
    models: z.object({ low: z.string().max(150), med: z.string().max(150), high: z.string().max(150), xhigh: z.string().max(150) }).strict(),
    deployments: z.object({ low: z.string().max(64).regex(/^$|^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).optional(), med: z.string().max(64).regex(/^$|^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).optional(), high: z.string().max(64).regex(/^$|^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).optional(), xhigh: z.string().max(64).regex(/^$|^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).optional() }).strict().optional(),
    runtimeEndpoint: optionalEndpoint,
    documentServices: documentServicesSchema.optional(),
    documentIntelligence: z.object({ endpoint: optionalEndpoint, credentialRef: optionalReference }).strict().optional(),
  }).strict(),
  access: z.object({ issuer: optionalEndpoint, clientId: z.string().max(256), clientSecretRef: optionalReference, rolesClaim: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/), mappings: z.array(z.object({ group: label, role: z.enum(DEPLOYMENT_ROLES) }).strict()).max(100) }).strict(),
  connections: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{1,80}$/), name: label,
    template: z.enum(CONNECTOR_TEMPLATES.map(item => item.id) as [typeof CONNECTOR_TEMPLATES[number]["id"], ...typeof CONNECTOR_TEMPLATES[number]["id"][]]),
    endpoint: z.string().max(2048).refine(value => { try { const url = new URL(value); return ["https:", "postgresql:", "kafka:", "tds:"].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search; } catch { return false; } }, "Use a supported endpoint without credentials or query parameters"),
    resource: z.string().max(500), credentialRef: optionalReference,
    identityMode: z.enum(["service", "delegated"]), freshnessMinutes: z.number().int().min(1).max(525600),
  }).strict()).max(100),
  schedules: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]{1,80}$/), connectionId: z.string().max(80),
    intervalMinutes: z.number().int().min(1).max(525600), timezone: z.string().max(100).refine(value => { try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; } }, "Choose a valid IANA timezone"),
    overlap: z.enum(["skip", "queue"]), enabled: z.literal(false),
  }).strict()).max(100),
}).strict().superRefine((profile, ctx) => {
  const observability = profile.foundation.observability;
  if (observability?.backend === "azure_monitor") {
    const ids = [observability.applicationInsightsResourceId, observability.foundry?.applicationInsightsResourceId].filter(Boolean) as string[];
    if (profile.target.provider !== "azure" || ids.some(id => !id.toLowerCase().startsWith(`${profile.target.scopeId.toLowerCase()}/providers/microsoft.insights/components/`))) {
      ctx.addIssue({ code: "custom", message: "Application Insights components must be in the selected Azure resource group", path: ["foundation", "observability"] });
    }
    if (ids.length === 2 && ids[0]?.toLowerCase() === ids[1]?.toLowerCase()) {
      ctx.addIssue({ code: "custom", message: "Select a dedicated Application Insights component for Foundry", path: ["foundation", "observability", "foundry", "applicationInsightsResourceId"] });
    }
  }
  if (profile.intelligence.provider === "azure_foundry" && profile.intelligence.endpoint) {
    try {
      if (!/^\/openai\/v1\/?$/.test(new URL(profile.intelligence.endpoint).pathname)) ctx.addIssue({ code: "custom", message: "Use your Foundry resource endpoint ending in /openai/v1", path: ["intelligence", "endpoint"] });
    } catch { /* The field validator reports malformed endpoints. */ }
  }
  if (profile.intelligence.provider !== "azure_foundry" && Object.values(profile.intelligence.deployments ?? {}).some(Boolean)) ctx.addIssue({ code: "custom", message: "Deployment name overrides apply only to Azure Foundry", path: ["intelligence", "deployments"] });
  const storage = profile.foundation.objectStore;
  if (storage.provider === "adls_gen2") {
    if (storage.endpoint) {
      try {
        const url = new URL(storage.endpoint);
        if (!/^[a-z0-9]{3,24}\.(dfs|blob)\.core\.windows\.net$/.test(url.hostname) || url.port || url.pathname !== "/") ctx.addIssue({ code: "custom", message: "Use the Azure account's HTTPS dfs or blob endpoint without a filesystem path", path: ["foundation", "objectStore", "endpoint"] });
      } catch { /* The field validator reports malformed endpoints. */ }
    }
    if (storage.bucket && !/^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/.test(storage.bucket)) ctx.addIssue({ code: "custom", message: "Use a valid ADLS filesystem name", path: ["foundation", "objectStore", "bucket"] });
  }
  const documentServices = profile.intelligence.documentServices;
  if (documentServices && profile.target.provider !== "azure") ctx.addIssue({ code: "custom", message: "Document services setup uses the Azure hosting recipe", path: ["intelligence", "documentServices"] });
  for (const id of [documentServices?.azure?.resourceId, documentServices?.azure?.trainingContainerId]) {
    if (id && !id.toLowerCase().startsWith(`${profile.target.scopeId.toLowerCase()}/providers/`)) {
      ctx.addIssue({ code: "custom", message: "Choose document resources in the selected Azure resource group", path: ["intelligence", "documentServices", "azure"] });
    }
  }
  const documents = profile.intelligence.documentIntelligence;
  if (documents && Boolean(documents.endpoint) !== Boolean(documents.credentialRef)) ctx.addIssue({ code: "custom", message: "Document intelligence requires both an HTTPS endpoint and credential reference", path: ["intelligence", "documentIntelligence"] });
  for (const [index, connection] of profile.connections.entries()) {
    const template = CONNECTOR_TEMPLATES.find(item => item.id === connection.template)!;
    try { if (new URL(connection.endpoint).protocol !== `${template.protocol}:`) ctx.addIssue({ code: "custom", message: `This connector requires ${template.protocol}`, path: ["connections", index, "endpoint"] }); } catch { /* The field validator reports malformed endpoints. */ }
  }
  for (const collection of [profile.connections, profile.schedules]) if (new Set(collection.map(item => item.id)).size !== collection.length) ctx.addIssue({ code: "custom", message: "IDs must be unique", path: [collection === profile.connections ? "connections" : "schedules"] });
  for (const [index, schedule] of profile.schedules.entries()) {
    const connection = profile.connections.find(item => item.id === schedule.connectionId);
    if (!connection) ctx.addIssue({ code: "custom", message: "Select an existing connection", path: ["schedules", index, "connectionId"] });
    if (connection?.identityMode === "delegated") ctx.addIssue({ code: "custom", message: "Schedules require an explicit service identity", path: ["schedules", index] });
  }
});

export type DeploymentProfile = z.infer<typeof deploymentProfileSchema>;
export type CuratedModel = { id: string; name: string; publisher: string; family: "frontier" | "open-weight"; providers: Record<string, string> };
export type DeploymentCatalog = { revision: string; models: CuratedModel[] };
/** Keep discovery on curated base-model IDs; inference and runtime use Foundry deployment aliases. */
export function deploymentModelName(profile: DeploymentProfile, catalog: DeploymentCatalog, tier: string): string | undefined {
  const key = tier as keyof DeploymentProfile["intelligence"]["models"];
  const intelligence = profile.intelligence;
  const model = catalog.models.find(item => item.id === intelligence.models[key])?.providers[intelligence.provider];
  return model ? (intelligence.provider === "azure_foundry" ? intelligence.deployments?.[key] || model : model) : undefined;
}
export type SetupFinding = { path: string; severity: "error" | "pending"; message: string };
export type SetupDocument = { revision: number; phase: "draft" | "configured"; profile: DeploymentProfile; updatedAt: string; tests: Array<{ kind: string; catalogRevision?: string; revision: number; checkedAt: string; status: "passed" | "failed"; message: string }>; configuredAt?: string };

export function defaultDeploymentProfile(target: DeploymentProfile["target"]): DeploymentProfile {
  return { apiVersion: "integralflow/deployment-v1", environmentId: "integralflow", displayName: "My environment", target,
    foundation: { posture: "minimal", database: { host: "", port: 5432, credentialRef: "" }, objectStore: { provider: "s3", endpoint: "", bucket: "", credentialRef: "" }, telemetryEndpoint: "", ...(target.provider === "azure" ? { observability: { backend: "azure_monitor", applicationInsightsResourceId: "" } as const } : {}) },
    intelligence: { provider: "openrouter", endpoint: "https://openrouter.ai/api/v1", credentialRef: "", models: { low: "", med: "", high: "", xhigh: "" }, runtimeEndpoint: "", documentIntelligence: { endpoint: "", credentialRef: "" } },
    access: { issuer: "", clientId: "", clientSecretRef: "", rolesClaim: "groups", mappings: [] }, connections: [], schedules: [] };
}

export function deploymentFindings(profile: DeploymentProfile, catalog: DeploymentCatalog): SetupFinding[] {
  const findings: SetupFinding[] = [];
  if (!telemetryConfigured(profile)) findings.push({ path: "foundation.observability", severity: "pending", message: "Configure a telemetry collector and, for Azure Monitor, its Application Insights component." });
  if (!profile.foundation.database.host) findings.push({ path: "foundation", severity: "pending", message: "Select a PostgreSQL service before deploying the runtime. Context storage requires pgvector and Apache AGE." });
  if (!profile.foundation.objectStore.endpoint || !profile.foundation.objectStore.bucket || !profile.foundation.objectStore.credentialRef) findings.push({ path: "foundation", severity: "pending", message: "Production evidence storage requires S3 object lock or an ADLS Gen2 filesystem with locked container retention." });
  if (!profile.access.issuer || !profile.access.clientId) findings.push({ path: "access", severity: "pending", message: "Configure OIDC and verify an administrator sign-in before retiring bootstrap access." });
  if (!profile.access.mappings.some(item => item.role === "Platform.Admin")) findings.push({ path: "access", severity: "pending", message: "Map an administrator group before completing identity handoff." });
  for (const [tier, id] of Object.entries(profile.intelligence.models)) {
    if (id && !catalog.models.some(model => model.id === id && model.providers[profile.intelligence.provider])) findings.push({ path: `intelligence.models.${tier}`, severity: "error", message: `The selected ${tier} model is not in the curated catalog for this provider.` });
  }
  if (Object.values(profile.intelligence.models).some(Boolean) && (!profile.intelligence.endpoint || !profile.intelligence.credentialRef)) findings.push({ path: "intelligence", severity: "error", message: "Selected models require a provider endpoint and credential reference." });
  if (Object.values(profile.intelligence.models).some(Boolean)) findings.push({ path: "intelligence", severity: "pending", message: "Activate and qualify selected model bindings in the deployed runtime; console inference tests do not activate bindings." });
  if (!profile.intelligence.runtimeEndpoint) findings.push({ path: "intelligence", severity: "pending", message: "The selected deployment recipe will host and verify the runtime before process flows start." });
  if (profile.intelligence.documentIntelligence?.endpoint) findings.push({ path: "intelligence.documentIntelligence", severity: "pending", message: "Document intelligence is configured for the evidence-pipeline HTTP adapter. Document processing requires a qualified capability binding; no documents are sent during setup." });
  if (profile.connections.length) findings.push({ path: "connections", severity: "pending", message: "Connection definitions need execution adapters and binding qualification in the runtime." });
  if (profile.schedules.length) findings.push({ path: "schedules", severity: "pending", message: "Schedules remain disabled until a runtime scheduler and tested bindings are deployed." });
  return findings;
}
