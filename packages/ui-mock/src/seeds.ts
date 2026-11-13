import { EHF, PLATFORM, type Rec } from "./fixtures.js";
import catalogSnapshot from "../../ui-contracts/vendor/docs/ui/contracts/fixtures/catalogs.json" with { type: "json" };

// The tree and YAML editor share the same canonical policy sources as the catalog.
const policyFiles = Object.fromEntries(catalogSnapshot.entries.filter(entry => entry.kind === "policies" && ["Policy", "DecisionTable"].includes(String((entry.contract as Rec).kind))).map(entry => [entry.source.replace(/^domains\/kyc\/policy\//, ""), JSON.stringify(entry.contract, null, 2)]));

/**
 * Platform seeds the vendored platform.json does not carry: a compiled plan, registries,
 * gateway receipts, integrations and traces. Every row is synthetic, shaped
 * by the control-ui view models in the contract, and validated by the mock's own response
 * validation. Kept here (not in vendor/) because vendor/ is generated and never edited.
 */
const T0 = "2026-11-06T08:00:00Z";
const DIGEST = (seed: string) => seed.repeat(64).slice(0, 64);
const PLAN_DIGEST: string = EHF.planDigest;
const TRACE_ID: string = EHF.traceId;
const RUN_ID: string = EHF.runId;

function planNode(id: string, name: string, primitive: string, x: number, extra: Rec = {}): Rec {
  return {
    id,
    name,
    primitive,
    purpose: name,
    allowedEffects: [],
    caseWrites: [],
    effectClass: "none",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    maxCostUsd: 0.5,
    maxRetries: 1,
    permissionEnvelopeDigest: DIGEST("e"),
    timeoutMs: 120_000,
    x,
    y: 80,
    ...extra,
  };
}

/** The compiled FinCrime KYB plan the scenario run executes (shape: CompiledHarnessPlan). */
export function compiledPlan(): Rec {
  const harness = (PLATFORM.harnesses as Rec[])[0]!;
  const nodes = [
    planNode("intake", "Intake", "input", 0),
    planNode("intake_profile", "Intake profile", "agent", 180, { agentRef: "agent.intake_profile", modelTier: "analysis" }),
    planNode("identity_ownership", "Identity and ownership", "agent", 360, { agentRef: "agent.identity_ownership", modelTier: "analysis" }),
    planNode("identity_ownership.review", "Ownership review", "approval", 540),
    planNode("screening", "Screening", "agent", 720, { agentRef: "agent.screening", modelTier: "analysis" }),
    planNode("screening.review", "Screening review", "approval", 900),
    planNode("decision_support", "Decision support", "agent", 1080, { agentRef: "agent.decision_support", modelTier: "analysis" }),
    planNode("decision_human_review", "Decision review (dual control)", "approval", 1260),
    planNode("result", "Result", "output", 1440),
  ];
  const edges = nodes.slice(1).map((node, index) => ({ id: `e${index + 1}`, from: nodes[index]!.id, to: node.id, mappingSummary: "state" }));
  return {
    admittedAt: harness.admittedAt,
    budgets: { maxCapabilityCalls: 40, maxConcurrency: 4, maxCostUsd: 5, maxDurationMs: 86_400_000, maxModelCalls: 60, maxRetries: 2 },
    compilerVersion: harness.compilerVersion,
    dependencies: [{ digest: DIGEST("d"), kind: "policy_envelope", packageId: "policy:kyc", version: "2026.11" }],
    domain: harness.domain,
    edges,
    failurePolicy: { defaultAction: "stop", effectSafeGuard: "no external effects without a gateway receipt", fencingMode: "epoch", retryBackoff: "exponential" },
    inputSchema: { type: "object", properties: { tenantId: { type: "string" }, caseId: { type: "string" } }, required: ["tenantId", "caseId"] },
    name: harness.name,
    nodes,
    objective: harness.objective,
    outputSchema: { type: "object" },
    packageVersion: harness.packageVersion,
    planDigest: PLAN_DIGEST,
    schemaVersion: "harness.factory/plan-v2",
    terminalOutcomes: [
      { category: "completed", code: "approved", description: "Onboarding approved by two distinct approvers", label: "Approved" },
      { category: "manual_review", code: "manual_review", description: "Waiting for a human decision", label: "Manual review" },
      { category: "denied", code: "declined", description: "Onboarding declined", label: "Declined" },
    ],
  };
}

export function platformSeeds(): Rec {
  return {
    plan: compiledPlan(),
    templates: [
      { id: "fincrime-kyb", name: "FinCrime KYB", packageSource: "name: fincrime-kyb\nversion: 1.0.0\n", workflowSource: "nodes: []\n", sourceFiles: {} },
    ],
    agentRegistry: [{
      agent: {
        caseWrites: [], description: "Identity and ownership specialist (synthetic)", id: "agent.identity_ownership", inputSchema: { type: "object" },
        modelProfileId: "analysis", name: "Identity & ownership", outputSchema: { type: "object" }, prompt: "Resolve ownership with cited evidence.",
        role: "specialist", runtimeTarget: "local_http", skillIds: ["ownership.ubo.resolve"], source: { type: "manual" }, status: "active", version: "0.3.0",
      },
      createdAt: T0, digest: DIGEST("a"), updatedAt: T0,
    }],
    skillRegistry: [{
      skill: {
        allowedCapabilityIds: ["registry.lookup"], description: "Resolve beneficial owners", id: "ownership.ubo.resolve", instructions: "Follow the pinned ownership policy.",
        name: "Resolve beneficial owners", source: { type: "manual" }, status: "active", version: "0.3.0",
      },
      createdAt: T0, digest: DIGEST("b"), updatedAt: T0,
    }],
    policyTemplate: { id: "kyc", files: policyFiles },
    capabilityRegistry: [{
      capability: {
        adapterBindingId: "simulator:registry.lookup", dataClasses: ["internal"], description: "Company registry lookup (simulated)", effect: "read",
        id: "registry.lookup", idempotent: true, inputSchema: { type: "object" }, kind: "tool", maxAttempts: 2, outputSchema: { type: "object" },
        owner: "platform", status: "active", timeoutMs: 10_000,
      },
      createdAt: T0, digest: DIGEST("c"), updatedAt: T0,
    }],
    adapters: [
      { id: "simulator", label: "Simulator", credentialState: "Not required", supportedKinds: ["tool", "deterministic"], bindingOptions: [{ label: "Registry lookup", value: "simulator:registry.lookup" }] },
      { id: "openrouter", label: "OpenRouter", credentialState: "Configured", supportedKinds: ["model"], bindingOptions: [{ label: "Analysis tier", value: "openrouter:analysis" }] },
    ],
    toolCapabilities: [{
      adapterBindingId: "simulator:registry.lookup", adapterVersion: "1.0.0", capabilityId: "registry.lookup", credentialState: "Not required",
      effectClass: "read_only", health: "Healthy", requestSchemaVersion: "1.0.0", resultSchemaVersion: "1.0.0", retryPolicy: "2 attempts, exponential", timeoutMs: 10_000,
    }],
    gatewayDecisions: [{
      adapterBindingId: "simulator:registry.lookup", attempt: 1, capabilityId: "registry.lookup", decision: "allowed", effect: "read", envelopeDigest: DIGEST("e"),
      fencingEpoch: 1, idempotencyKey: "rcpt-kyb-1042-reg", latencyMs: 84, nodeId: "identity_ownership", occurredAt: "2026-11-07T09:12:11Z",
      reasonCode: "authority.granted", receiptId: "rcpt_0001", requestDigest: DIGEST("f"), resultDigest: DIGEST("1"), resultStatus: "ok",
      runId: RUN_ID, spanId: "2bc3e2d0bf178f65", traceId: TRACE_ID,
    }],
    trace: {
      traceId: TRACE_ID,
      startedAt: "2026-11-07T09:12:04Z",
      generatedAt: "2026-11-07T14:05:00Z",
      durationMs: 26_000,
      rawViewerUrl: null,
      services: ["control-api", "runtime-host", "capability-gateway"],
      spanCount: 3,
      spans: [
        { depth: 0, durationMs: 26_000, operationName: "run.execute", parentSpanId: null, serviceName: "control-api", spanId: "2bc3e2d0bf178f64", startOffsetMs: 0, startTime: "2026-11-07T09:12:04Z", status: "ok", tags: {} },
        { depth: 1, durationMs: 2_100, operationName: "node.execute identity_ownership", parentSpanId: "2bc3e2d0bf178f64", serviceName: "runtime-host", spanId: "2bc3e2d0bf178f66", startOffsetMs: 5_000, startTime: "2026-11-07T09:12:09Z", status: "ok", tags: {} },
        { depth: 2, durationMs: 84, operationName: "capability.invoke registry.lookup", parentSpanId: "2bc3e2d0bf178f66", serviceName: "capability-gateway", spanId: "2bc3e2d0bf178f65", startOffsetMs: 7_000, startTime: "2026-11-07T09:12:11Z", status: "ok", tags: {} },
      ],
    },
    connectors: [{
      allowedClassifications: ["internal", "confidential"], authentication: { audience: "ehf-intake", clientId: null, credentialRef: "INTAKE_HMAC", kind: "hmac", tokenUrl: null },
      channel: "inbound_http", enabled: true, endpoint: null, id: "crm-intake", name: "CRM onboarding intake",
    }],
    bindings: [{
      connectorId: "crm-intake", contractId: "fincrime.onboarding.v1", deploymentId: "DEP-0001", filters: {}, id: "crm-intake-kyb",
      planDigest: PLAN_DIGEST, routeId: "route_crm_intake_kyb", status: "ACTIVE",
    }],
    deliveries: [{ deliveryId: "dlv_0001", bindingId: "crm-intake-kyb", status: "DELIVERED", attempts: 1, occurredAt: "2026-11-07T09:12:01Z" }],
    humanActions: [{
      allowedCaseStatuses: ["INVESTIGATING", "HUMAN_REVIEW"], allowedRoles: ["Case.Analyst"], commandType: "RequestHumanReview", confirmation: "typed_reason",
      description: "Ask the relationship manager for missing ownership documents.", effect: "external", id: "request-documents",
      inputSchema: { type: "object" }, label: "Request documents", payload: {}, ui: {},
    }],
  };
}

/**
 * The upstream platform fixture fills some strings with their own field names (GAP-022).
 * Replace those with honest synthetic values so screens never show "window" or
 * "envelopeVerifierStatus" as data. Only values change; no fields are added.
 */
export function replaceFixturePlaceholders(platform: Record<string, any>): void {
  const set = (target: Record<string, any> | undefined, key: string, value: unknown) => {
    if (target && target[key] === key) target[key] = value;
  };
  set(platform.overview, "window", "24h");
  const system = platform.system;
  if (system) {
    const build = system.buildMetadata ?? {};
    set(build, "uiVersion", "web 0.1.0 (mock)");
    set(build, "apiVersion", "v1");
    set(build, "runtimeVersion", "langgraph-js (mock)");
    set(build, "compilerVersion", "harnessc 0.1.0 (mock)");
    set(build, "adapterBundleVersion", "simulator adapters (mock)");
    set(build, "commitSha", "0000000");
    set(system, "databaseMigrationVersion", "mock (no database)");
    set(system.queueWorkState, "fencingAuthority", "PostgreSQL monotonic fencing_epoch");
    set(system.runtimeIsolation, "selectionAuthority", "Agent runtimeTarget in the immutable compiled plan; environment default when absent");
  }
  set(platform.gatewayStatus, "envelopeVerifierStatus", "verifying");
  set(platform.gatewayStatus, "lastConnectionMessage", null);
}
