import { deploymentModelName, telemetryConfigured, type DeploymentCatalog, type DeploymentProfile, type SetupDocument } from "./deployment.js";

// Logical principals, not cloud resource IDs. Recipes bind each one to a distinct
// projected identity and database login; no identity is minted for a model or connector.
// This table is the single description of the runtime topology:
//   port   the port each entrypoint listens on by default; health probes target it
//   alias  the short name recipes use for resource names
//   size   CPU and memory per replica. The control API bundles the plan compiler, the case
//          API runs OPA servers and the gateway and runtime host hold model calls, so they
//          get more than the edge and the workers.
//   scale  how replicas follow load. HTTP services scale on concurrent requests per
//          replica. Workers scale on ready queue depth (their claims use SKIP LOCKED and
//          fencing epochs, so any number may run). `maxReplicas` is a conservative default
//          a deployment can override; set it from load tests and the connection budget
//          (deploy/performance.md).
export const RUNTIME_SERVICES = [
  { entrypoint: "experience-bff", identity: "control-surface-edge", databases: [], port: 4200, alias: "web",
    size: { cpu: 0.25, memory: "0.5Gi" }, scale: { trigger: "http", concurrentRequests: 50, maxReplicas: 3 } },
  { entrypoint: "control-api", identity: "control-api", databases: ["control", "context"], port: 4100, alias: "control",
    size: { cpu: 0.5, memory: "1Gi" }, scale: { trigger: "http", concurrentRequests: 30, maxReplicas: 4 } },
  { entrypoint: "case-api", identity: "case-api", databases: ["case", "control"], port: 4102, alias: "case",
    size: { cpu: 0.5, memory: "1Gi" }, scale: { trigger: "http", concurrentRequests: 20, maxReplicas: 4 } },
  { entrypoint: "capability-gateway", identity: "capability-gateway", databases: ["control", "context"], port: 4101, alias: "gateway",
    size: { cpu: 0.5, memory: "1Gi" }, scale: { trigger: "http", concurrentRequests: 30, maxReplicas: 4 } },
  { entrypoint: "runtime-host", identity: "harness-runtime", databases: [], port: 8088, alias: "runtime",
    size: { cpu: 0.5, memory: "1Gi" }, scale: { trigger: "http", concurrentRequests: 10, maxReplicas: 6 } },
  { entrypoint: "runtime-worker", identity: "runtime-dispatcher", databases: ["control"], port: 9090, alias: "dispatch",
    size: { cpu: 0.25, memory: "0.5Gi" }, scale: { trigger: "queue", queue: "runs", readyPerReplica: 4, maxReplicas: 6 } },
  { entrypoint: "integration-worker", identity: "integration-worker", databases: ["control"], port: 9091, alias: "integration",
    size: { cpu: 0.25, memory: "0.5Gi" }, scale: { trigger: "queue", queue: "integration", readyPerReplica: 10, maxReplicas: 3 } },
] as const;
export type RuntimeService = typeof RUNTIME_SERVICES[number];
export type RuntimeEntrypoint = RuntimeService["entrypoint"];
export const RUNTIME_ENTRYPOINTS = RUNTIME_SERVICES.map(service => service.entrypoint) as [RuntimeEntrypoint, ...RuntimeEntrypoint[]];
/** Queue-depth functions an autoscaler calls (packages/persistence/migrations/044_queue_metrics.sql). */
export const QUEUE_DEPTH_QUERIES = { runs: "select harness_runtime.ready_run_count()", integration: "select integration.ready_work_count()" } as const;

/**
 * Replica range for a service. HTTP services keep two warm replicas under the resilient
 * posture; workers keep one, which also holds the dispatcher's LISTEN connection.
 */
export function serviceReplicas(service: RuntimeService, posture: DeploymentProfile["foundation"]["posture"], maxOverride?: number) {
  const max = maxOverride ?? service.scale.maxReplicas;
  const min = Math.min(max, posture === "resilient" && service.scale.trigger === "http" ? 2 : 1);
  return { min, max };
}

export type DeploymentPlan = ReturnType<typeof createDeploymentPlan>;
export function createDeploymentPlan(input: { document: SetupDocument; catalog: DeploymentCatalog; identityVerified: boolean; image: string | null; deploymentVerified?: boolean }) {
  const { document, catalog, identityVerified, image } = input;
  const p: DeploymentProfile = document.profile;
  const checked = (kind: string) => document.tests.some(test => test.kind === kind && test.catalogRevision === catalog.revision && test.revision === document.revision && test.status === "passed");
  const immutableImage = Boolean(image && /^.+@sha256:[a-f0-9]{64}$/.test(image));
  const selected = Object.entries(p.intelligence.models).filter(([, id]) => id);
  const runtimeReady = input.deploymentVerified === true;
  const documents = p.intelligence.documentServices;
  const azureDocuments = documents?.azure;
  const externalRuntime = Boolean(p.intelligence.runtimeEndpoint);
  const adls = p.foundation.objectStore.provider === "adls_gen2";
  const gates = [
    { id: "configuration", passed: document.phase === "configured", message: "Prepare the current configuration revision." },
    { id: "image", passed: immutableImage, message: "Pin the single application artifact by SHA-256 digest." },
    { id: "administrator", passed: identityVerified, message: "Complete a verified administrator sign-in." },
    { id: "database", passed: runtimeReady, message: "Run the image's database check and migrations against three distinct databases. Case requires pgvector; context requires pgvector and Apache AGE, including AGE session loading." },
    { id: "object-storage", passed: Boolean(p.foundation.objectStore.endpoint && p.foundation.objectStore.bucket && p.foundation.objectStore.credentialRef), message: adls ? "Provide an ADLS Gen2 filesystem with locked container retention. Per-file policy changes are not supported by ADLS." : "Provide a versioned S3-compatible evidence bucket with object lock. The production case service requires protected object storage." },
    { id: "telemetry", passed: telemetryConfigured(p), message: p.foundation.observability?.backend === "azure_monitor" ? "Provide the internal HTTPS collector and its workspace-based Application Insights component." : "Provide an HTTPS OTLP collector." },
    { id: "inference", passed: selected.length > 0 && checked("inference"), message: "Qualify the selected curated models with a bounded inference request." },
    ...(documents ? [{ id: "document-model", passed: Boolean(deploymentModelName(p, catalog, documents.modelTier)), message: "Assign a curated model to the selected document fields tier." }] : []),
    ...(azureDocuments && (azureDocuments.layout || azureDocuments.modelExtraction || azureDocuments.factory) ? [{ id: "document-account", passed: Boolean(azureDocuments.resourceId), message: "Create or select the Azure Document Intelligence account in Intelligence." }] : []),
    { id: "runtime", passed: runtimeReady, message: "Apply a qualified runtime hosting recipe, project distinct workload tokens, and verify authenticated invocation and callbacks. Health alone does not satisfy this gate." },
  ];
  const hosting = ({ azure: "Container Apps", aws: "ECS / Fargate", gcp: "Cloud Run", kubernetes: "Deployments and Jobs", container: "OCI container platform" })[p.target.provider];
  return {
    apiVersion: "integralflow/deployment-plan-v1" as const,
    revision: document.revision, catalogRevision: catalog.revision,
    environmentId: p.environmentId, target: p.target, image,
    status: runtimeReady ? "deployed" : "requires-runtime-recipe", runtimeReady,
    resources: [
      { id: "console", kind: "application", operation: "reuse", service: hosting, count: 1, detail: "Existing onboarding console and persistent setup state." },
      { id: "runtime", kind: "application", operation: "deploy", service: hosting, count: RUNTIME_SERVICES.length - (externalRuntime ? 1 : 0), detail: externalRuntime ? "Reuse the selected external runtime; deploy six application entrypoints from the same artifact." : "Deploy seven application entrypoints from the same artifact." },
      ...(externalRuntime ? [{ id: "external-runtime", kind: "application", operation: "bind", service: "Hosted HTTP runtime", count: 1, detail: "Bind the selected endpoint to the harness-runtime principal and verify invocation and callback conformance." }] : []),
      { id: "databases", kind: "database", operation: "reuse-or-provision", service: "PostgreSQL", count: 3, detail: "Separate control, case and context databases; a single compatible server is sufficient for the minimal footprint. Managed offerings require extension checks." },
      { id: "identities", kind: "identity", operation: "bind", service: "Projected workload JWTs", count: RUNTIME_SERVICES.length, detail: "One principal per calling service; human access uses generic OIDC." },
      { id: "signing", kind: "security", operation: "bind", service: "Asymmetric signing keys", count: 4, detail: "Execution envelopes, runtime grants, integration envelopes and gateway delegation use separate signing authorities." },
      { id: "objects", kind: "storage", operation: "reuse", service: adls ? "Azure Data Lake Storage Gen2" : "S3-compatible object storage", count: 1, detail: adls ? "Verify hierarchical namespace and locked container retention before schema changes. Retention and legal holds apply to the entire filesystem; individual file policy changes report NOT_ENFORCED." : "Production evidence requires an existing versioned bucket with object lock. Qualification runs before schema changes." },
      { id: "telemetry", kind: "observability", operation: "bind", service: p.foundation.observability?.backend === "azure_monitor" ? "Application Insights and Log Analytics" : "OTLP", count: 1, detail: p.foundation.observability?.backend === "azure_monitor" ? "Internal OTLP collector with a resource-scoped trace reader identity." : "Existing collector." },
      ...(documents ? [
        { id: "document-studio", kind: "application", operation: "deploy", service: "Document Studio skill host", count: 1, detail: "Private host with the selected document fields model." },
        ...(!p.intelligence.documentIntelligence?.endpoint ? [{ id: "evidence-pipeline", kind: "application", operation: "deploy", service: "Evidence pipeline", count: 1, detail: "Private text preparation service with persistent storage." }] : []),
        ...(azureDocuments?.resourceId ? [{ id: "azure-documents", kind: "capability", operation: "bind", service: "Azure Document Intelligence", count: 1, detail: "Managed identity access for the selected document routes." }] : []),
        ...(azureDocuments?.factory ? [{ id: "document-factory", kind: "application", operation: "deploy", service: "Document Factory worker", count: 1, detail: "Private worker with persistent datasets and a dedicated workload identity." }] : []),
      ] : []),
      ...(p.intelligence.documentIntelligence?.endpoint ? [{ id: "document-intelligence", kind: "capability", operation: "bind", service: "Document intelligence HTTP endpoint", count: 1, detail: "Reuse an evidence-pipeline-compatible service through the capability gateway. Processing requires a qualified binding." }] : []),
    ] satisfies Array<{ id: string; kind: string; operation: string; service: string; count: number; detail: string }>,
    services: RUNTIME_SERVICES.map(service => {
      const external = externalRuntime && service.entrypoint === "runtime-host";
      const range = serviceReplicas(service, p.foundation.posture);
      return { entrypoint: service.entrypoint, identity: service.identity, databases: service.databases, image, operation: external ? "bind-external" : "deploy", replicas: external ? 0 : range.min, maxReplicas: external ? 0 : range.max, size: service.size, scaling: service.scale.trigger };
    }),
    database: { host: p.foundation.database.host, port: p.foundation.database.port, credentialRef: p.foundation.database.credentialRef,
      stores: [{ id: "control", extensions: [] }, { id: "case", extensions: ["vector"] }, { id: "context", extensions: ["vector", "age"] }],
      entrypoint: "migrate", actions: ["check", "apply"], createsDatabases: false, createsServiceLogins: p.target.provider === "azure" && p.target.recipe === "azure-container-apps-bootstrap-v1" },
    modelBindings: selected.map(([tier, id]) => ({ tier, catalogId: id, provider: p.intelligence.provider, model: deploymentModelName(p, catalog, tier) ?? null, endpoint: p.intelligence.endpoint, credentialRef: p.intelligence.credentialRef, state: runtimeReady ? "published" : "proposed" })),
    connections: p.connections.map(connection => ({ id: connection.id, template: connection.template, identityMode: connection.identityMode, state: "proposed" })),
    documentIntelligence: p.intelligence.documentIntelligence?.endpoint ? { adapter: "evidence", ...p.intelligence.documentIntelligence, state: runtimeReady ? "configured" : "proposed", qualified: false } : null,
    schedules: p.schedules.map(schedule => ({ ...schedule, enabled: false as const, state: "disabled" })),
    resilience: p.foundation.posture === "resilient" ? "Two warm replicas per API, autoscaling on concurrent requests and queue depth, and database failover from the data service; hosting, worker fencing and recovery still require qualification." : "One warm replica per service, autoscaling on concurrent requests and queue depth, separate stores, existing services where compatible.",
    gates,
    operations: [{ id: "database-check", command: "SERVICE_NAME=migrate <image> check", effect: "Read-only compatibility check; creates no resources." }, { id: "database-migrate", command: "SERVICE_NAME=migrate <image> apply --environment <environmentId>", effect: "Applies schema migrations and grants to pre-provisioned stores; leaves service logins to the hosting recipe." }],
  };
}
