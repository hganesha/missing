import { z } from "zod";
export * from "./intelligence-adapters.js";

const id = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/);
const text = z.string().trim().max(400);
const ref = z.string().regex(/^[A-Z][A-Z0-9_]{2,64}$/).nullable();
const endpoint = z.string().url().max(400).refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash;
}, "Use HTTPS without credentials, query parameters or a fragment").nullable();

/** A proposal format; deliberately outside legacy model-profile and runtime digests. */
export const intelligenceConnectionSchema = z.object({
  cloud: z.enum(["azure", "aws", "gcp", "databricks", "saas", "gateway", "private"]),
  adapterId: z.string().regex(/^[a-z][a-z0-9_-]{1,59}$/),
  endpoint,
  account: text,
  resourceId: text,
  region: text,
  networkZone: text,
  auth: z.object({
    mode: z.enum(["unconfigured", "workload_identity", "aws_iam", "gcp_federation", "oauth_m2m", "oauth_delegated", "mtls", "provider_key", "platform_token"]),
    principal: text,
    audience: text,
    issuer: text,
    subject: text,
    credentialRef: ref,
    clientIdRef: ref,
    certificateRef: ref,
  }).strict(),
}).strict();

const base = {
  schemaVersion: z.literal("intelligence.binding.v1"),
  id,
  name: z.string().trim().min(1).max(120),
  owner: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000),
  connection: intelligenceConnectionSchema,
  dataClass: z.enum(["public", "internal", "confidential", "restricted"]),
};
export const reasoningConfigurationSchema = z.object({
  tier: z.enum(["low", "med", "high", "xhigh"]),
  profileId: id.nullable(),
  model: text,
  nativeEffort: z.enum(["provider_default", "none", "low", "medium", "high", "xhigh"]),
  maxOutputTokens: z.number().int().min(1).max(200_000),
  timeoutMs: z.number().int().min(1).max(600_000),
  maxConcurrency: z.number().int().min(1).max(64),
  outputMode: z.enum(["text", "json_schema"]),
  toolCalling: z.boolean(),
  evaluationRef: text,
}).strict();
export const runtimeConfigurationSchema = z.object({
  target: z.string().regex(/^[a-z][a-z0-9_]{1,39}(:[a-z0-9][a-z0-9._-]{0,99})?$/).nullable(),
  agentName: text,
  agentVersion: text,
  imageDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(),
  lifecycleEndpoint: endpoint,
  lifecycleAudience: text,
  maxConcurrency: z.number().int().min(1).max(1000),
  timeoutMs: z.number().int().min(1).max(3_600_000),
  callbackNetwork: text,
}).strict();
export const inferenceConfigurationSchema = z.object({
  capabilityId: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$/),
  modelVersion: text,
  featureSchemaRef: text,
  outputSchemaRef: text,
  preprocessingVersion: text,
  calibrationVersion: text,
  targetDefinition: text,
  predictionHorizon: text,
  scoreMin: z.number().finite(),
  scoreMax: z.number().finite(),
  scoreDirection: z.enum(["higher_risk", "lower_risk"]),
  maxFeatureAgeSeconds: z.number().int().min(1).max(31_536_000),
  timeoutMs: z.number().int().min(1).max(600_000),
  unavailableBehavior: z.literal("abstain"),
  validationRef: text,
}).strict().refine(value => value.scoreMin < value.scoreMax, { path: ["scoreMax"], message: "Maximum must exceed minimum" });

const capabilityId = z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$/);
export const documentConfigurationSchema = z.object({
  capabilityId,
  operation: z.enum(["ocr", "layout", "extract", "classify", "split"]),
  model: text, modelVersion: text, apiVersion: text,
  outputSchemaRef: text, locale: text,
  features: z.array(z.enum(["tables", "key_values", "selection_marks", "barcodes", "languages"])).max(5),
  executionMode: z.enum(["synchronous", "asynchronous"]),
  maxPages: z.number().int().min(1).max(10000),
  maxBytes: z.number().int().min(1).max(536870912),
  timeoutMs: z.number().int().min(1).max(600000),
  pollIntervalMs: z.number().int().min(100).max(60000),
  resultStoreRef: text,
  provenanceRequired: z.literal(true),
  minConfidence: z.number().min(0).max(1),
  unavailableBehavior: z.literal("review"),
  evaluationRef: text,
}).strict();
export const decisionConfigurationSchema = z.object({
  capabilityId,
  primitive: z.enum(["choice", "score", "noul", "box"]),
  model: text, modelVersion: text,
  stateSchemaRef: text, questionSetRef: text, outputSchemaRef: text,
  options: z.array(z.string().trim().min(1).max(120)).max(100),
  confidenceMode: z.enum(["none", "provider", "validated"]),
  minConfidence: z.number().min(0).max(1),
  calibrationRef: text, policyRef: text, evaluationRef: text,
  maxQuestions: z.number().int().min(1).max(100),
  timeoutMs: z.number().int().min(1).max(600000),
  unavailableBehavior: z.literal("abstain"),
}).strict().superRefine((value, context) => {
  if (["choice", "score"].includes(value.primitive) && value.options.length < 2) context.addIssue({ code: "custom", path: ["options"], message: "Choice and score require at least two labels or rubric levels" });
  if (new Set(value.options).size !== value.options.length) context.addIssue({ code: "custom", path: ["options"], message: "Options must be unique" });
  if (value.confidenceMode === "none" && value.minConfidence !== 0) context.addIssue({ code: "custom", path: ["minConfidence"], message: "A confidence threshold requires a declared confidence source" });
});

export const mcpToolRegistrationSchema = z.object({
  name: z.string().trim().min(1).max(128).refine(value => !/[\s*]/.test(value), "Use an exact tool name without wildcards"),
  capabilityId, inputSchemaRef: text, outputSchemaRef: text,
  effect: z.enum(["none", "read", "reversible", "paid", "external", "destructive"]),
  approval: z.enum(["always", "policy"]),
}).strict();
export const mcpConfigurationSchema = z.object({
  transport: z.enum(["streamable_http", "legacy_sse", "stdio"]),
  protocolVersion: z.string().regex(/^$|^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
  serverName: text, serverVersion: text,
  identityMode: z.enum(["workload", "delegated_user"]),
  scopes: z.array(z.string().trim().min(1).max(120)).max(30),
  catalogSource: z.enum(["pinned_snapshot", "review_discovery"]),
  catalogRef: text, catalogDigest: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  tools: z.array(mcpToolRegistrationSchema).max(50),
  launchProfileRef: text, policyRef: text, evaluationRef: text,
  catalogChangeBehavior: z.literal("block"),
  timeoutMs: z.number().int().min(1).max(600000),
  maxConcurrency: z.number().int().min(1).max(64),
  maxResultBytes: z.number().int().min(1).max(10485760),
  unavailableBehavior: z.literal("deny"),
}).strict().superRefine((value, context) => {
  if (new Set(value.tools.map(tool => tool.name)).size !== value.tools.length) context.addIssue({ code: "custom", path: ["tools"], message: "Tool names must be unique" });
  if (new Set(value.tools.map(tool => tool.capabilityId)).size !== value.tools.length) context.addIssue({ code: "custom", path: ["tools"], message: "Tool capability IDs must be unique" });
  if (new Set(value.scopes).size !== value.scopes.length) context.addIssue({ code: "custom", path: ["scopes"], message: "Scopes must be unique" });
});

/** Registration lookup only; execution still requires capability and approval policy. */
export function mcpRegisteredTool(configuration: z.infer<typeof mcpConfigurationSchema>, name: string, observedCatalogDigest: string):
  { status: "registered"; tool: z.infer<typeof mcpToolRegistrationSchema> } | { status: "denied"; reason: "catalog_unpinned" | "catalog_drift" | "tool_not_registered" } {
  if (!configuration.catalogDigest) return { status: "denied", reason: "catalog_unpinned" };
  if (observedCatalogDigest !== configuration.catalogDigest) return { status: "denied", reason: "catalog_drift" };
  const tool = configuration.tools.find(tool => tool.name === name);
  return tool ? { status: "registered", tool } : { status: "denied", reason: "tool_not_registered" };
}

export const intelligenceDefinitionSchema = z.discriminatedUnion("serviceClass", [
  z.object({ ...base, serviceClass: z.literal("reasoning"), configuration: reasoningConfigurationSchema }).strict(),
  z.object({ ...base, serviceClass: z.literal("runtime"), configuration: runtimeConfigurationSchema }).strict(),
  z.object({ ...base, serviceClass: z.literal("inference"), configuration: inferenceConfigurationSchema }).strict(),
  z.object({ ...base, serviceClass: z.literal("document"), configuration: documentConfigurationSchema }).strict(),
  z.object({ ...base, serviceClass: z.literal("decision"), configuration: decisionConfigurationSchema }).strict(),
  z.object({ ...base, serviceClass: z.literal("mcp"), configuration: mcpConfigurationSchema }).strict(),
]).superRefine((value, context) => {
  if (value.serviceClass === "reasoning" && value.id !== `reasoning.${value.configuration.tier}`) {
    context.addIssue({ code: "custom", path: ["id"], message: "A reasoning binding ID must match its canonical tier" });
  }
  const prefix = { reasoning: "reasoning.", runtime: "runtime.", inference: "ml.", document: "document.", decision: "decision.", mcp: "mcp." }[value.serviceClass];
  if (!value.id.startsWith(prefix) || value.id.length === prefix.length) {
    context.addIssue({ code: "custom", path: ["id"], message: `Use a named binding in the ${prefix} namespace` });
  }
});
export const intelligenceSaveSchema = z.object({
  definition: intelligenceDefinitionSchema,
  expectedRevision: z.number().int().positive().nullable(),
  reason: z.string().trim().min(1).max(500),
}).strict();
export const intelligenceCheckRequestSchema = z.object({ expectedRevision: z.number().int().positive() }).strict();
export type IntelligenceDefinition = z.infer<typeof intelligenceDefinitionSchema>;
export type IntelligenceSave = z.infer<typeof intelligenceSaveSchema>;
export type IntelligenceCheck = { id: string; label: string; status: "passed" | "failed" | "unknown"; detail: string };
export type IntelligenceRecord = { definition: IntelligenceDefinition; revision: number; digest: string; createdAt: string; createdBy: string; reason: string };
export type IntelligenceActivity = { bindingId: string; revision: number; action: string; actor: string; at: string; reason: string };
export type IntelligenceCheckReport = { bindingId: string; revision: number; digest: string; checkedAt: string; checkedBy: string; checks: IntelligenceCheck[]; executionVerified: false };
const adapters = [
  { id: "azure_foundry", name: "Azure AI Foundry models (OpenAI v1)", cloud: "azure", serviceClass: "reasoning", implemented: true },
  { id: "azure_foundry_agents", name: "Azure AI Foundry Agent Service", cloud: "azure", serviceClass: "runtime", implemented: false },
  { id: "azure_ml", name: "Azure Machine Learning endpoint", cloud: "azure", serviceClass: "inference", implemented: false },
  { id: "azure_document_intelligence", name: "Azure AI Document Intelligence", cloud: "azure", serviceClass: "document", implemented: false },
  // System 1 adapters pass the shared conformance suite (packages/adapters decision-system1.conformance.test.ts):
  // azure_decision serves the foundry_openai and foundry_anthropic modes; jev runs through OpenRouter Decisions.
  { id: "azure_decision", name: "Azure Foundry structured decisions", cloud: "azure", serviceClass: "decision", implemented: true },
  { id: "mcp_azure", name: "Azure-hosted MCP server", cloud: "azure", serviceClass: "mcp", implemented: false },
  { id: "openrouter", name: "OpenRouter", cloud: "saas", serviceClass: "reasoning", implemented: true },
  { id: "openai_compatible", name: "OpenAI-compatible API", cloud: "saas", serviceClass: "reasoning", implemented: true },
  { id: "anthropic", name: "Anthropic Claude API", cloud: "saas", serviceClass: "reasoning", implemented: true },
  { id: "local_http", name: "Self-hosted EHF runtime", cloud: "private", serviceClass: "runtime", implemented: true },
  { id: "hosted_http", name: "Hosted EHF runtime (HTTPS service)", cloud: "private", serviceClass: "runtime", implemented: true },
  { id: "databricks", name: "Databricks App runtime", cloud: "databricks", serviceClass: "runtime", implemented: true },
  { id: "databricks-serving", name: "Databricks Model Serving", cloud: "databricks", serviceClass: "reasoning", implemented: true },
  { id: "aws_bedrock", name: "Amazon Bedrock", cloud: "aws", serviceClass: "reasoning", implemented: false },
  { id: "aws_agentcore", name: "AWS AgentCore runtime", cloud: "aws", serviceClass: "runtime", implemented: false },
  { id: "aws_sagemaker", name: "SageMaker prediction", cloud: "aws", serviceClass: "inference", implemented: false },
  { id: "gcp_vertex", name: "Vertex model deployment", cloud: "gcp", serviceClass: "reasoning", implemented: false },
  { id: "gcp_agent_engine", name: "Google Agent Engine runtime", cloud: "gcp", serviceClass: "runtime", implemented: false },
  { id: "gcp_prediction", name: "Vertex prediction", cloud: "gcp", serviceClass: "inference", implemented: false },
  { id: "private_inference", name: "Private inference service", cloud: "private", serviceClass: "inference", implemented: false },
  { id: "enterprise_gateway", name: "Enterprise model gateway", cloud: "gateway", serviceClass: "reasoning", implemented: false },
  { id: "aws_textract", name: "Amazon Textract", cloud: "aws", serviceClass: "document", implemented: false },
  { id: "databricks_document", name: "Databricks document parsing", cloud: "databricks", serviceClass: "document", implemented: false },
  { id: "llamaparse", name: "LlamaIndex / LlamaParse", cloud: "saas", serviceClass: "document", implemented: false },
  { id: "gcp_document_ai", name: "Google Document AI", cloud: "gcp", serviceClass: "document", implemented: false },
  { id: "private_document", name: "Private document service", cloud: "private", serviceClass: "document", implemented: false },
  { id: "jev", name: "TypeSafe Jev · System One", cloud: "saas", serviceClass: "decision", implemented: true },
  { id: "openai_decision", name: "OpenAI structured decisions", cloud: "saas", serviceClass: "decision", implemented: false },
  { id: "databricks_decision", name: "Databricks decision endpoint", cloud: "databricks", serviceClass: "decision", implemented: false },
  { id: "private_decision", name: "Private System 1 endpoint", cloud: "private", serviceClass: "decision", implemented: false },
  { id: "document_gateway", name: "Enterprise document gateway", cloud: "gateway", serviceClass: "document", implemented: false },
  { id: "decision_gateway", name: "Enterprise decision gateway", cloud: "gateway", serviceClass: "decision", implemented: false },
  { id: "mcp_aws", name: "AWS-hosted MCP server", cloud: "aws", serviceClass: "mcp", implemented: false },
  { id: "mcp_gcp", name: "Google Cloud-hosted MCP server", cloud: "gcp", serviceClass: "mcp", implemented: false },
  { id: "mcp_databricks", name: "Databricks-hosted MCP server", cloud: "databricks", serviceClass: "mcp", implemented: false },
  { id: "mcp_saas", name: "Remote MCP server", cloud: "saas", serviceClass: "mcp", implemented: false },
  { id: "mcp_private", name: "Private MCP server", cloud: "private", serviceClass: "mcp", implemented: false },
  { id: "mcp_gateway", name: "Enterprise gateway MCP server", cloud: "gateway", serviceClass: "mcp", implemented: false },
  { id: "mcp_stdio", name: "Managed stdio MCP process", cloud: "private", serviceClass: "mcp", implemented: false },
] as const;
export const INTELLIGENCE_COMMON_ADAPTERS = {
  mcp: { id: "mcp.tools.v1", name: "Governed MCP tools", lifecycle: "request_response", detail: "Protocol-aware discovery, pinned tool allowlist and schemas, per-tool effects, identity scopes and approval policy." },
  reasoning: { id: "reasoning.request.v1", name: "Model request", lifecycle: "request_response", detail: "Model, effort, token budget and structured-output capability negotiation." },
  runtime: { id: "runtime.invocation.v1", name: "Runtime lifecycle", lifecycle: "runtime", detail: "Invoke, status and cancellation with dispatch and callback identities." },
  inference: { id: "inference.prediction.v1", name: "Typed prediction", lifecycle: "request_response", detail: "Versioned features, score semantics, freshness and abstention." },
  document: { id: "document.analysis.v1", name: "Document analysis", lifecycle: "job", detail: "Submit and poll jobs; schema-bound fields, page provenance and review on missing confidence." },
  decision: { id: "decision.system1.v1", name: "System 1 decision", lifecycle: "request_response", detail: "Typed state and questions; choice, score, truth probability or box; explicit confidence and abstention." },
} as const;
export const INTELLIGENCE_ADAPTER_CATALOG = adapters.map(adapter => ({ ...adapter, commonAdapterId: INTELLIGENCE_COMMON_ADAPTERS[adapter.serviceClass].id, lifecycle: INTELLIGENCE_COMMON_ADAPTERS[adapter.serviceClass].lifecycle }));
export const intelligenceAdapterImplemented = (definition: IntelligenceDefinition): boolean => INTELLIGENCE_ADAPTER_CATALOG.some(adapter => adapter.id === definition.connection.adapterId && adapter.cloud === definition.connection.cloud && adapter.serviceClass === definition.serviceClass && adapter.implemented);

/**
 * Authentication a built-in runtime adapter accepts for dispatch, mirroring the runtime
 * binding's `platform_token` | `databricks_oauth_m2m` (packages/contracts runtimeBindingSchema).
 * `workload_identity` is the platform workload identity (WORKLOAD_AUTH=workload_identity):
 * principal is the logical service / token subject and audience the runtime host.
 */
const RUNTIME_DISPATCH_AUTH: Record<string, readonly IntelligenceDefinition["connection"]["auth"]["mode"][]> = {
  local_http: ["platform_token", "workload_identity"],
  hosted_http: ["platform_token", "workload_identity"],
  databricks: ["oauth_m2m"],
};

/** Offline validation is not live verification. Unknown gates always prevent activation. */
export function intelligenceConfigurationChecks(definition: IntelligenceDefinition, supported: boolean): IntelligenceCheck[] {
  const { connection } = definition;
  const required = (id: string, label: string, present: boolean, detail: string): IntelligenceCheck => ({ id, label, status: present ? "passed" : "failed", detail });
  const stdio = definition.serviceClass === "mcp" && definition.configuration.transport === "stdio";
  const authenticationComplete = (() => {
    if (stdio) return Boolean(connection.auth.principal && definition.configuration.launchProfileRef);
    const auth = connection.auth;
    switch (auth.mode) {
      case "workload_identity": return Boolean(auth.principal && auth.audience);
      case "aws_iam": return /^arn:[a-z-]+:iam::[0-9]{12}:role\/.+/.test(auth.principal);
      case "gcp_federation": return Boolean(auth.principal && auth.issuer && auth.subject && auth.audience);
      case "oauth_delegated": return Boolean(auth.clientIdRef && auth.issuer && auth.audience);
      case "oauth_m2m": return Boolean(auth.credentialRef && auth.clientIdRef && auth.issuer && auth.audience);
      case "mtls": return Boolean(auth.certificateRef);
      case "provider_key": case "platform_token": return Boolean(auth.credentialRef);
      default: return false;
    }
  })();
  const checks = [
    required("adapter", "Installed adapter", supported, supported ? "Installed transport; target-environment conformance remains unverified." : "Adapter implementation or installed connector required."),
    required("endpoint", stdio ? "Managed process launch profile" : "Resource endpoint", stdio ? Boolean(definition.configuration.launchProfileRef) : Boolean(connection.endpoint), stdio ? "Reference a reviewed deployment launch profile; this page never accepts or executes shell commands." : "An explicit HTTPS resource endpoint is required; saving never probes it."),
    required("region", "Processing location", Boolean(connection.region), "Declare the serving region or approved routing boundary."),
    required("identity", "Authentication configuration", authenticationComplete, "Complete the selected transport's principal, audience, trust conditions and credential references; these are configuration checks only."),
  ];
  if (connection.adapterId === "azure_foundry") {
    let validEndpoint = false;
    try { validEndpoint = /\/openai\/v1\/?$/.test(new URL(connection.endpoint ?? "").pathname); } catch {}
    checks.push(required("azure_endpoint", "Foundry OpenAI v1 endpoint", validEndpoint, "Use the resource's /openai/v1/ endpoint and its deployment name as the model. Project agent endpoints use a separate runtime protocol."));
    checks.push(required("azure_auth", "Foundry model authentication", connection.auth.mode === "provider_key", "The installed OpenAI-compatible transport uses a provider key reference. Entra workload identity requires a token-refresh adapter before execution."));
  }
  if (definition.serviceClass === "reasoning") {
    checks.push(required("model", "Model target", Boolean(definition.configuration.model), "Name the exact model or deployment."));
    checks.push(required("evaluation", "Qualification reference", Boolean(definition.configuration.evaluationRef), "Reference the workload evaluation evidence; its validity requires executor verification."));
    if (definition.configuration.nativeEffort !== "provider_default") checks.push({ id: "effort", label: "Native effort compatibility", status: "unknown", detail: "The selected model and API must independently support this parameter; tiers do not prove native effort support." });
  } else if (definition.serviceClass === "runtime") {
    checks.push(required("target", "Runtime target", Boolean(definition.configuration.target && definition.configuration.target.split(":")[0] === connection.adapterId), "The target must name the selected runtime adapter."));
    const dispatchAuth = RUNTIME_DISPATCH_AUTH[connection.adapterId];
    if (dispatchAuth) checks.push(required("dispatch_auth", "Runtime dispatch authentication", dispatchAuth.includes(connection.auth.mode), connection.adapterId === "databricks" ? "Databricks runtimes are dispatched with OAuth machine-to-machine credentials (databricks_oauth_m2m)." : "The platform runtime host accepts the dispatcher's platform token or workload identity token (platform_token)."));
    checks.push(required("callbacks", "Callback network", Boolean(definition.configuration.callbackNetwork), "Declare how the runtime reaches the envelope broker, gateway and case API."));
  } else if (definition.serviceClass === "inference") {
    const config = definition.configuration;
    checks.push(required("ml_contract", "Versioned ML contract", Boolean(config.modelVersion && config.featureSchemaRef && config.outputSchemaRef && config.preprocessingVersion && config.calibrationVersion), "Model, feature/output schemas, preprocessing and calibration must be versioned."));
    checks.push(required("score", "Prediction semantics", Boolean(config.targetDefinition && config.predictionHorizon), "Define the target event and prediction horizon; a score is not automatically a probability."));
    checks.push(required("validation", "Model validation reference", Boolean(config.validationRef), "Reference independent validation evidence for the intended population and use."));
  } else if (definition.serviceClass === "document") {
    const config = definition.configuration;
    checks.push(required("document_contract", "Document and extraction contract", Boolean(config.model && config.modelVersion && config.apiVersion && config.outputSchemaRef), "Pin the processor/model, API version and canonical output schema. Unsupported features require adapter conformance."));
    checks.push(required("document_jobs", "Document job result boundary", config.executionMode !== "asynchronous" || Boolean(config.resultStoreRef), "Asynchronous processing requires an approved result-store reference and bounded polling; no signed storage URLs are saved."));
    checks.push(required("textract_mode", "Provider processing mode", connection.adapterId !== "aws_textract" || config.executionMode === "asynchronous" || config.maxPages === 1, "Multipage Textract processing requires an asynchronous job."));
    checks.push(required("document_evaluation", "Document qualification", Boolean(config.evaluationRef), "Verify extraction accuracy, page/field provenance and confidence semantics on representative documents. Missing confidence routes to review."));
  } else if (definition.serviceClass === "decision") {
    const config = definition.configuration;
    checks.push(required("decision_contract", "Typed state and questions", Boolean(config.model && config.modelVersion && config.stateSchemaRef && config.questionSetRef && config.outputSchemaRef), "Pin model, state schema, question/rubric artifact and output schema. System 1 questions must be atomic."));
    checks.push(required("decision_policy", "Decision policy and evaluation", Boolean(config.policyRef && config.evaluationRef), "Policy controls how typed answers are used. Evaluation must cover abstention and review; a saved binding cannot perform business actions."));
    checks.push(required("decision_confidence", "Confidence qualification", config.confidenceMode === "none" || Boolean(config.calibrationRef) && (connection.adapterId !== "openai_decision" || config.confidenceMode === "validated"), "Confidence requires evidence for the workload. Structured LLM output does not establish calibrated confidence; unavailable confidence must abstain when a threshold is set."));
  } else if (definition.serviceClass === "mcp") {
    const config = definition.configuration;
    checks.push(required("mcp_protocol", "Server and protocol revision", Boolean(config.serverName && config.serverVersion && config.protocolVersion), "Declare the server revision and exact MCP protocol version. Transport behavior and discovery negotiation require live conformance."));
    checks.push(required("mcp_catalog", "Pinned tool catalog", Boolean(config.catalogRef && config.catalogDigest && config.tools.length), "Register exact tools and pin the reviewed catalog artifact/digest. Discovery does not auto-enable tools; list/schema changes block eligibility."));
    checks.push(required("mcp_tools", "Tool contracts and approval policy", config.tools.length > 0 && config.tools.every(tool => Boolean(tool.inputSchemaRef && tool.outputSchemaRef)) && Boolean(config.policyRef && config.evaluationRef), "Every allowlisted tool needs schema references and an EHF effect classification. Provider annotations do not grant authority; approval policy and evaluation evidence must be reviewed."));
    checks.push(required("mcp_identity", "MCP identity boundary", stdio ? connection.cloud === "private" && connection.adapterId === "mcp_stdio" && config.identityMode === "workload" && connection.auth.mode === "unconfigured" : connection.adapterId !== "mcp_stdio" && (config.identityMode === "delegated_user" ? connection.auth.mode === "oauth_delegated" && config.scopes.length > 0 : connection.auth.mode !== "oauth_delegated"), "Delegated OAuth needs the MCP resource audience, requested scopes and user authorization. Stdio uses its private workload launch profile; HTTP credentials cannot be forwarded to a child process."));
    checks.push({ id: "mcp_discovery", label: "Live discovery and schema agreement", status: "unknown", detail: "No server discovery has run. Verify the full paginated tool list under the intended identity/scopes, compare the pinned catalog digest and validate tools without executing business actions." });
  }
  checks.push(
    { id: "workload_identity", label: "Execution identity and permissions", status: "unknown", detail: "Not tested from the actual dispatcher/gateway workload. Credential presence is not authentication evidence." },
    { id: "network", label: "Execution network and TLS", status: "unknown", detail: "DNS, private routes, TLS and required callbacks have not been tested from the execution network." },
    { id: "contract", label: "Live contract and entitlement", status: "unknown", detail: "A bounded synthetic invocation, resource revision, entitlement and quota checks require a verification worker." },
    { id: "activation", label: "Approval and activation authority", status: "unknown", detail: "Requires exact-digest approval, deployment evidence and execution-service generation acknowledgment." },
  );
  return checks;
}
