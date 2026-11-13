import {
  businessDecisionSchema,
  type BusinessDecision,
  businessCommandSchema,
  canonicalRecordObjectType,
  capabilityResultSchema,
  caseSnapshotSchema as caseSnapshotV2Schema,
  harnessPlanV2Schema,
  policyEvaluationSchema,
  registerEvidenceRequestSchema,
  stableDigest,
  verifyPlanV2Digest,
  isSkillCaseWriteGrant,
  skillEffectReleaseRequestSchema,
  type BusinessCommand,
  type SkillCapabilityOutputV1,
  type HarnessPlanV2,
  type CaseSnapshot as CaseSnapshotV2,
  type PolicyEvaluation,
  type CapabilityResult,
} from "@ehf/contracts";
import {
  coverageReasonFromError,
  isTransientSkillError,
  normalizeJurisdiction,
  type SkillErrorCode,
  type SkillSelectionRecord,
} from "@ehf/contracts";
import type { FencedRun, RuntimeStateStore, WorkloadCredential } from "@ehf/runtime-state";
import {
  admitSkillBindings,
  nextEligibleCandidate,
  nextSourcePolicyCandidate,
  nextEquivalentCandidate,
  selectionRecord,
  skillErrorCodeFor,
  skillPlanForNode,
} from "./business-skills.js";

export * from "./business-skills.js";
export * from "./skill-execution.js";
export * from "./skill-commit.js";
import {
  planSkillCommit,
  routedExternalActions,
  skillApprovalDecisionFrom,
  skillOutputCommitsRecords,
  skillOutputNeedsCommit,
} from "./skill-commit.js";
import {
  SpanKind,
  injectTraceContext,
  traceReference,
  withSpan,
} from "@ehf/telemetry";

export type RuntimeContext = {
  /** In-process draft rehearsal boundary. Never accepted from a runtime invocation. */
  draftTest?: {
    invoke(nodeId: string, capabilityId: string, input: unknown, step?: number): Promise<CapabilityResult>;
    observe(nodeId: string, input: unknown, output?: unknown): void;
    failed?(nodeId: string, error: unknown): void;
    beforeNode?(nodeId: string, nodeKind: string): Promise<void>;
    suppressEffect?(nodeId: string, command: string, conditional: boolean): void;
  };
  /**
   * Durable journal. The runtime describes what happened and the control plane decides
   * whether to record it; the runtime holds no database credential of its own.
   */
  state: RuntimeStateStore;
  plan: HarnessPlanV2;
  runId: string;
  runAttempt: number;
  workerId: string;
  fencingEpoch: number;
  gatewayUrl: string;
  caseApiUrl?: string;
  /** Control-plane endpoint that exchanges the runtime grant for a node-scoped envelope. */
  envelopeBrokerUrl: string;
  /**
   * Authority for this invocation, issued by the dispatcher. The runtime holds no signing
   * key: it cannot mint an envelope, only ask for one and be refused.
   */
  executionGrant: string;
  /**
   * Credential proving which workload is calling the internal services. It answers a
   * different question than the execution envelope, which says what this run, node and
   * attempt may do; both are required at the gateway.
   */
  serviceToken: WorkloadCredential;
  /**
   * Case-read envelopes the control plane issued with each node's start, by node ID, so the
   * snapshot read needs no separate exchange. Absent, every read asks for its own.
   */
  caseReadEnvelopes?: Map<string, { envelope: string; expiresAt: number }>;
};

const V2_UNSUPPORTED_NODE_KINDS = new Set(["loop", "teacher"]);
const V2_TRANSFORMS = new Set(["identity", "select", "project", "merge", "deduplicate", "sort", "slice"]);
const V2_AGGREGATORS = new Set(["collect", "merge", "concat", "vote"]);
const V2_RUNTIME_ADAPTERS = new Map([
  ["harness-runtime", "harness-runtime-v2"],
]);

export type AdmittedHarnessPlanV2 = HarnessPlanV2 & {
  readonly __runtimeAdmission: "harness-v2";
};

function digestValue(value: string): string {
  return value.replace(/^sha256:/, "");
}

function requirePositiveInteger(value: unknown, code: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(code);
  return value;
}

type V2Edge = HarnessPlanV2["graph"]["edges"][number];

function groupMembers(node: HarnessPlanV2["graph"]["nodes"][number]): string[] {
  return Array.isArray(node.config.members)
    ? node.config.members.filter((member): member is string => typeof member === "string" && member.length > 0)
    : [];
}

/**
 * Expand a native group boundary into the dependency edges the durable scheduler and
 * LangGraph lowering execute. The authored plan stays immutable: these edges exist only
 * in the runtime view of the graph.
 */
export function v2ExecutionEdges(plan: HarnessPlanV2): V2Edge[] {
  const groups = plan.graph.nodes.filter((node) => node.kind === "group");
  const membership = new Map<string, string>();
  for (const group of groups) {
    for (const member of groupMembers(group)) membership.set(member, group.id);
  }

  const result: V2Edge[] = [];
  for (const edge of plan.graph.edges) {
    const sourceGroup = membership.get(edge.from);
    const targetGroup = membership.get(edge.to);
    if (sourceGroup && sourceGroup === targetGroup) continue;
    if (groups.some((group) => group.id === edge.to)) continue;
    result.push(edge);
  }

  for (const group of groups) {
    const members = groupMembers(group);
    const incoming = plan.graph.edges.filter((edge) => edge.to === group.id);
    const execution = String(group.config.execution);
    const starters = execution === "sequential" ? members.slice(0, 1) : members;
    for (const target of starters) {
      for (const edge of incoming) {
        result.push({ ...edge, id: `__group_${group.id}_enter_${edge.id}_${target}`, to: target });
      }
    }
    if (execution === "sequential") {
      for (let index = 1; index < members.length; index += 1) {
        const from = members[index - 1]!;
        const to = members[index]!;
        const authored = plan.graph.edges.find((edge) => edge.from === from && edge.to === to);
        result.push(authored ?? { id: `__group_${group.id}_sequence_${index}`, from, to, kind: "data" });
      }
    }
    for (const member of members) {
      result.push({ id: `__group_${group.id}_exit_${member}`, from: member, to: group.id, kind: "dependency" });
    }
  }
  return result;
}

export function v2ExecutionPredecessors(plan: HarnessPlanV2, nodeId: string): string[] {
  return [...new Set(v2ExecutionEdges(plan).filter((edge) => edge.to === nodeId).map((edge) => edge.from))];
}

/**
 * Fail-closed admission for the v2 semantics implemented by this execution kernel.
 *
 * Schema validation alone is not runtime admission: the v2 contract intentionally
 * describes semantics which may be compiled before every adapter can execute them.
 */
export function admitHarnessPlanV2(raw: unknown): AdmittedHarnessPlanV2 {
  const plan = harnessPlanV2Schema.parse(raw);
  if (!verifyPlanV2Digest(plan)) throw new Error("runtime.v2.plan_digest_invalid");
  const requiredAdapter = V2_RUNTIME_ADAPTERS.get(plan.execution.engine.kind);
  if (!requiredAdapter || plan.execution.engine.adapterVersion !== requiredAdapter) {
    throw new Error("runtime.v2.adapter_unsupported");
  }
  const discovery = plan.metadata.domain === "discovery";
  if (discovery) {
    const supported = new Set(["input", "tool", "agent", "join", "output"]);
    if (plan.execution.coordinationMode !== "dataFlow" || plan.contextSelectors.length || plan.policyBundles.length
      || plan.integrations || plan.skillBindings?.length || plan.agentProfiles.some(profile => profile.caseWrites.length)
      || plan.graph.nodes.some(node => !supported.has(node.kind) || node.contextSelectorIds.length
        || node.config.caseWrites !== undefined || node.config.evidenceCapture !== undefined
        || node.config.skillId !== undefined || node.config.skillEffectRelease !== undefined)
      || plan.capabilities.some(capability => capability.effect !== "read" && capability.effect !== "none")) {
      throw new Error("runtime.v2.discovery_case_authority_forbidden");
    }
  } else if (plan.execution.coordinationMode !== "caseStore") {
    throw new Error("runtime.v2.coordination_mode_unsupported");
  }

  const nodes = new Map<string, HarnessPlanV2["graph"]["nodes"][number]>();
  for (const node of plan.graph.nodes) {
    if (nodes.has(node.id)) throw new Error(`runtime.v2.node_duplicate:${node.id}`);
    nodes.set(node.id, node);
    if (V2_UNSUPPORTED_NODE_KINDS.has(node.kind)) {
      throw new Error(`runtime.v2.node_kind_unsupported:${node.kind}`);
    }
    if (Array.isArray(node.config.caseWrites)) {
      for (const write of node.config.caseWrites) {
        if (!write || typeof write !== "object" || Array.isArray(write)) {
          throw new Error(`runtime.v2.case_write_invalid:${node.id}`);
        }
      }
    }
    if (!discovery && ["agent", "tool", "evaluate", "gate"].includes(node.kind) && !node.contextSelectorIds.length) {
      throw new Error(`runtime.v2.context_selectors_required:${node.id}`);
    }
    if (node.kind === "join") {
      const mode = String(node.config.mode ?? node.config.operation ?? "all");
      if (mode !== "all" && mode !== "allSettled") {
        throw new Error(`runtime.v2.join_mode_unsupported:${mode}`);
      }
    }
    if (node.kind === "transform") {
      const operation = String(node.config.operation ?? "identity");
      if (!V2_TRANSFORMS.has(operation)) throw new Error(`runtime.v2.transform_unsupported:${operation}`);
    }
    if (node.kind === "aggregator") {
      const operation = String(node.config.operation ?? "collect");
      if (!V2_AGGREGATORS.has(operation)) throw new Error(`runtime.v2.aggregator_unsupported:${operation}`);
    }
    if (node.kind === "fanout") {
      const maxItems = requirePositiveInteger(node.config.maxItems, "runtime.v2.fanout_max_items_invalid");
      const maxConcurrency = requirePositiveInteger(node.config.maxConcurrency, "runtime.v2.fanout_max_concurrency_invalid");
      if (maxConcurrency > plan.execution.maxConcurrency) {
        throw new Error(`runtime.v2.fanout_concurrency_exceeds_plan:${node.id}`);
      }
      if (maxItems > plan.execution.maxTransitions) {
        throw new Error(`runtime.v2.fanout_items_exceed_transition_budget:${node.id}`);
      }
    }
    if (node.kind === "group") {
      const members = groupMembers(node);
      if (!members.length) throw new Error(`runtime.v2.group_members_required:${node.id}`);
      if (new Set(members).size !== members.length) throw new Error(`runtime.v2.group_members_duplicate:${node.id}`);
      if (!new Set(["sequential", "parallel"]).has(String(node.config.execution))) {
        throw new Error(`runtime.v2.group_execution_invalid:${node.id}`);
      }
      if (!new Set(["serialize", "aggregate"]).has(String(node.config.exit))) {
        throw new Error(`runtime.v2.group_exit_invalid:${node.id}`);
      }
    }
    if (node.kind === "subgraph") {
      const subgraph = node.config.subgraph;
      if (!subgraph || typeof subgraph !== "object" || Array.isArray(subgraph)) {
        throw new Error(`runtime.v2.subgraph_contract_required:${node.id}`);
      }
      const contract = subgraph as Record<string, unknown>;
      if (typeof contract.ref !== "string" || !/^(?:ladder:\/\/|host:).+/.test(contract.ref)) {
        throw new Error(`runtime.v2.subgraph_ref_invalid:${node.id}`);
      }
      for (const field of ["inputMap", "outputMap"] as const) {
        const mapping = contract[field];
        if (!mapping || typeof mapping !== "object" || Array.isArray(mapping) || !Object.keys(mapping).length
          || Object.values(mapping).some((path) => typeof path !== "string" || !path.startsWith("/"))) {
          throw new Error(`runtime.v2.subgraph_${field}_invalid:${node.id}`);
        }
      }
      if (!new Set(["inherit", "perInvocation", "perThread", "stateless"]).has(String(contract.checkpointer))) {
        throw new Error(`runtime.v2.subgraph_checkpointer_invalid:${node.id}`);
      }
    }
  }

  if (plan.graph.nodeOrder.length !== nodes.size || new Set(plan.graph.nodeOrder).size !== nodes.size) {
    throw new Error("runtime.v2.node_order_invalid");
  }
  for (const id of plan.graph.nodeOrder) {
    if (!nodes.has(id)) throw new Error(`runtime.v2.node_order_unknown:${id}`);
  }
  const selectorIds = new Set(plan.contextSelectors.map((selector) => selector.id));
  if (selectorIds.size !== plan.contextSelectors.length) throw new Error("runtime.v2.context_selector_duplicate");
  const selectorsById = new Map(plan.contextSelectors.map((selector) => [selector.id, selector]));
  for (const node of plan.graph.nodes) {
    for (const selectorId of node.contextSelectorIds) {
      if (!selectorIds.has(selectorId)) throw new Error(`runtime.v2.context_selector_missing:${node.id}:${selectorId}`);
    }
    const purposes = new Set(node.contextSelectorIds.map((selectorId) => selectorsById.get(selectorId)?.purpose));
    if (purposes.size > 1) throw new Error(`runtime.v2.context_purpose_ambiguous:${node.id}`);
    if (node.kind === "gate") {
      const policyRef = String(node.config.policyRef);
      if (!plan.policyBundles.some((binding) => binding.policyId === policyRef)) {
        throw new Error(`runtime.v2.policy_binding_missing:${node.id}`);
      }
    }
  }
  const membership = new Map<string, string>();
  for (const group of plan.graph.nodes.filter((node) => node.kind === "group")) {
    for (const memberId of groupMembers(group)) {
      const member = nodes.get(memberId);
      if (!member) throw new Error(`runtime.v2.group_member_missing:${group.id}:${memberId}`);
      if (member.kind === "input" || member.kind === "output" || member.kind === "group") {
        throw new Error(`runtime.v2.group_member_kind_invalid:${group.id}:${memberId}`);
      }
      if (membership.has(memberId)) throw new Error(`runtime.v2.group_member_duplicated:${memberId}`);
      membership.set(memberId, group.id);
    }
    if (group.config.execution === "parallel" && plan.graph.edges.some((edge) =>
      membership.get(edge.from) === group.id && membership.get(edge.to) === group.id)) {
      throw new Error(`runtime.v2.group_parallel_member_edge:${group.id}`);
    }
  }
  admitSkillBindings(plan);
  const edgeIds = new Set<string>();
  for (const edge of plan.graph.edges) {
    if (edgeIds.has(edge.id)) throw new Error(`runtime.v2.edge_duplicate:${edge.id}`);
    edgeIds.add(edge.id);
    if (!nodes.has(edge.from)) throw new Error(`runtime.v2.edge_source_missing:${edge.from}`);
    if (!nodes.has(edge.to)) throw new Error(`runtime.v2.edge_target_missing:${edge.to}`);
    const sourceGroup = membership.get(edge.from);
    const targetGroup = membership.get(edge.to);
    if (sourceGroup !== targetGroup && (sourceGroup || targetGroup)) {
      throw new Error(`runtime.v2.group_boundary_invalid:${edge.id}`);
    }
  }
  for (const join of plan.graph.nodes.filter((node) => node.kind === "join"
    && String(node.config.mode ?? node.config.operation ?? "all") === "allSettled")) {
    const sources = new Set(plan.graph.edges.filter((edge) => edge.to === join.id && edge.kind !== "control").map((edge) => edge.from));
    for (const source of sources) {
      if (plan.graph.edges.some((edge) => edge.from === source && edge.to !== join.id)) {
        throw new Error(`runtime.v2.all_settled_mixed_fanout_unsupported:${source}`);
      }
    }
  }
  for (const node of plan.graph.nodes) {
    const outgoing = plan.graph.edges.filter((edge) => edge.from === node.id);
    const routed = outgoing.filter((edge) => edge.kind === "control" || edge.outcome !== undefined);
    if (routed.length && routed.length !== outgoing.length) {
      throw new Error(`runtime.v2.mixed_routing_unsupported:${node.id}`);
    }
  }
  const executionEdges = v2ExecutionEdges(plan);
  const inDegree = new Map(plan.graph.nodes.map((node) => [node.id, 0]));
  const outgoingByNode = new Map(plan.graph.nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of executionEdges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    outgoingByNode.get(edge.from)!.push(edge.to);
  }
  const ready = plan.graph.nodeOrder.filter((nodeId) => inDegree.get(nodeId) === 0);
  let visited = 0;
  for (let index = 0; index < ready.length; index += 1) {
    const nodeId = ready[index]!;
    visited += 1;
    for (const target of outgoingByNode.get(nodeId) ?? []) {
      const remaining = (inDegree.get(target) ?? 0) - 1;
      inDegree.set(target, remaining);
      if (remaining === 0) ready.push(target);
    }
  }
  if (visited !== plan.graph.nodes.length) throw new Error("runtime.v2.graph_cycle_unsupported");
  return plan as AdmittedHarnessPlanV2;
}

async function workloadToken(credential: WorkloadCredential): Promise<string> {
  return typeof credential === "string" ? credential : credential();
}

type IssuedEnvelope = { envelope: string; expiresInSeconds: number; caseWrites: string[] };

/**
 * Ask the control plane for authority to act as one node of this run.
 *
 * Every call re-derives the grant against durable run state, so an envelope cannot
 * outlive the lease it was issued under.
 */
async function requestExecutionEnvelope(
  context: RuntimeContext,
  nodeId: string,
  invocationId: string,
): Promise<IssuedEnvelope> {
  const token = await workloadToken(context.serviceToken);
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    "x-runtime-grant": context.executionGrant,
    "content-type": "application/json",
  };
  injectTraceContext(headers);
  const response = await fetch(`${context.envelopeBrokerUrl}/v1/runtime/envelopes`, {
    method: "POST",
    headers,
    body: JSON.stringify({ runId: context.runId, nodeId, attempt: context.runAttempt, invocationId }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error ?? "runtime.envelope_denied"));
  const envelope = typeof body.envelope === "string" ? body.envelope : "";
  if (!envelope) throw new Error("runtime.envelope_invalid");
  return {
    envelope,
    expiresInSeconds: Number(body.expiresInSeconds ?? 0),
    caseWrites: Array.isArray(body.caseWrites) ? body.caseWrites.map(String) : [],
  };
}

type CaseWriteScope = {
  case: Record<string, unknown>;
  nodeInput: unknown;
  output: unknown;
  values: Record<string, unknown>;
  /** `at`: when the writes were made (an `observed_at` for records the node proposes). */
  run: { runId: string; attempt: number; planDigest: string; nodeId: string; at: string };
  /** The case's subject ids, for records about the case's subjects. */
  subjects: string[];
  /** Whether every canonical record of the case is synthetic (records proposed over them are too). */
  syntheticCase: boolean;
  evidence?: { evidenceId: string };
};

export type CaseWriteReceipt = {
  evidenceId?: string;
  /** The `model_context` evidence the commands cite: the pack the model answered from. */
  contextEvidenceId?: string;
  commands: Array<{ commandType: string; createdIdentifiers: Record<string, string> }>;
};

export function getPath(value: unknown, path?: string): unknown {
  if (!path || path === "/" || path === "$") return value;
  const parts = path.replace(/^\$\.?/, "").split(/[./]/).filter(Boolean);
  return parts.reduce<unknown>((current, key) => current && typeof current === "object"
    ? Object.hasOwn(current, key) ? (current as Record<string, unknown>)[key] : undefined
    : undefined, value);
}

export function renderTemplate(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{([^{}]+)\}\}/g, (_match, path: string) => {
    const value = getPath(values, path.trim());
    return typeof value === "string" ? value : JSON.stringify(value ?? null);
  });
}

export function materializeTemplate(value: unknown, values: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const exact = value.match(/^\{\{([^{}]+)\}\}$/);
    if (exact) return getPath(values, exact[1]!.trim());
    return renderTemplate(value, values);
  }
  if (Array.isArray(value)) return value.map((item) => materializeTemplate(item, values));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, materializeTemplate(item, values)]));
  }
  return value;
}

export function evaluateCondition(expression: string | undefined, state: Record<string, unknown>): boolean {
  if (!expression || expression === "always") return true;
  // A conjunction of comparisons (`a == "x" && b != "y"`): every term must hold.
  if (expression.includes(" && ")) return expression.split(" && ").every((term) => evaluateCondition(term.trim(), state));
  const match = /==|!=/.exec(expression);
  if (!match) return Boolean(getPath(state, expression));
  const path = expression.slice(0, match.index).trim();
  const operator = match[0];
  const raw = expression.slice(match.index + operator.length).trim();
  if (!/^[\w./$-]+$/.test(path) || !raw) return Boolean(getPath(state, expression));
  let expected: unknown = raw;
  try { expected = JSON.parse(raw!); } catch { expected = raw!.replace(/^['"]|['"]$/g, ""); }
  const actual = getPath(state, path);
  return operator === "==" ? actual === expected : actual !== expected;
}

export function transformValue(config: Record<string, unknown>, input: unknown): unknown {
  const operation = String(config.operation ?? "identity");
  if (operation === "identity") return input;
  if (operation === "select") return getPath(input, String(config.path ?? "/"));
  if (operation === "project") {
    const fields = Array.isArray(config.fields) ? config.fields.map(String) : [];
    return Object.fromEntries(fields.map((field) => [field, getPath(input, field)]));
  }
  if (operation === "merge") return Object.fromEntries((Array.isArray(input) ? input : [input]).flatMap((value) => value && typeof value === "object" ? Object.entries(value) : []));
  if (operation === "deduplicate") {
    if (!Array.isArray(input)) throw new Error("runtime.transform_deduplicate_array_required");
    const path = typeof config.path === "string" ? config.path : undefined;
    const seen = new Set<string>();
    return input.filter((item) => {
      const key = stableDigest((path ? getPath(item, path) : item) ?? null);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  if (operation === "sort") {
    if (!Array.isArray(input)) throw new Error("runtime.transform_sort_array_required");
    const path = typeof config.path === "string" ? config.path : undefined;
    const direction = config.direction === "desc" ? -1 : 1;
    const comparable = (value: unknown): string | number => typeof value === "number" ? value : JSON.stringify(value ?? null);
    return input.toSorted((left, right) => {
      const a = comparable(path ? getPath(left, path) : left);
      const b = comparable(path ? getPath(right, path) : right);
      if (typeof a === "number" && typeof b === "number") return (a - b) * direction;
      return (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0) * direction;
    });
  }
  if (operation === "slice") {
    if (!Array.isArray(input) && typeof input !== "string") throw new Error("runtime.transform_slice_sequence_required");
    const start = Number.isInteger(config.start) ? Number(config.start) : 0;
    const end = Number.isInteger(config.end) ? Number(config.end) : undefined;
    return input.slice(start, end);
  }
  throw new Error(`runtime.transform_unsupported:${operation}`);
}

function collectedValues(input: unknown): unknown[] {
  if (Array.isArray(input)) return [...input];
  if (input && typeof input === "object") return Object.values(input as Record<string, unknown>);
  return [input];
}

export function aggregateValue(config: Record<string, unknown>, input: unknown): unknown {
  const operation = String(config.operation ?? "collect");
  const values = collectedValues(input);
  if (operation === "collect") return values;
  if (operation === "merge") {
    if (!values.every((value) => value && typeof value === "object" && !Array.isArray(value))) {
      throw new Error("runtime.aggregator_merge_objects_required");
    }
    return Object.assign({}, ...values as Record<string, unknown>[]);
  }
  if (operation === "concat") {
    if (!values.every(Array.isArray)) throw new Error("runtime.aggregator_concat_arrays_required");
    return (values as unknown[][]).flat();
  }
  if (operation === "vote") {
    if (!values.length) return null;
    const path = typeof config.path === "string" ? config.path : undefined;
    const counts = new Map<string, { value: unknown; count: number; first: number }>();
    values.forEach((item, index) => {
      const value = path ? getPath(item, path) : item;
      const key = stableDigest(value ?? null);
      const current = counts.get(key);
      counts.set(key, current ? { ...current, count: current.count + 1 } : { value, count: 1, first: index });
    });
    return [...counts.values()].sort((a, b) => b.count - a.count || a.first - b.first)[0]?.value ?? null;
  }
  throw new Error(`runtime.aggregator_unsupported:${operation}`);
}

function cloneFrozen<T>(value: T): T {
  const cloned = structuredClone(value);
  const freeze = (current: unknown): void => {
    if (!current || typeof current !== "object" || Object.isFrozen(current)) return;
    Object.freeze(current);
    for (const nested of Object.values(current as Record<string, unknown>)) freeze(nested);
  };
  freeze(cloned);
  return cloned;
}

/** Verify the canonical digest and content-addressed ID before exposing snapshot data. */
export function admitCaseSnapshotV2(rawSnapshot: unknown): CaseSnapshotV2 {
  const snapshot = caseSnapshotV2Schema.parse(rawSnapshot);
  const { snapshotId: _snapshotId, snapshotDigest: _snapshotDigest, capturedAt: _capturedAt, readReceiptId:_readReceiptId, ...canonical } = snapshot;
  const calculated = stableDigest(canonical);
  if (digestValue(snapshot.snapshotDigest) !== calculated) throw new Error("runtime.v2.snapshot_digest_invalid");
  if (snapshot.snapshotId !== `snapshot_${calculated}`) throw new Error("runtime.v2.snapshot_id_invalid");
  return snapshot;
}

/** Select only the case-store fields compiled for a v2 node. */
export function selectV2CaseContext(
  plan: HarnessPlanV2,
  nodeId: string,
  rawSnapshot: unknown,
): Readonly<Record<string, unknown>> {
  const snapshot = admitCaseSnapshotV2(rawSnapshot);
  if (digestValue(snapshot.planDigest) !== digestValue(plan.planDigest)) {
    throw new Error("runtime.v2.snapshot_plan_digest_mismatch");
  }
  const node = plan.graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`runtime.v2.node_missing:${nodeId}`);
  const selectors = new Map(plan.contextSelectors.map((selector) => [selector.id, selector]));
  const selected: Record<string, unknown> = {};
  for (const selectorId of node.contextSelectorIds) {
    const selector = selectors.get(selectorId);
    if (!selector) throw new Error(`runtime.v2.context_selector_missing:${nodeId}:${selectorId}`);
    // Selectors may be authored relative to their source collection or from the
    // snapshot data root. Prefer the explicit root path, then the source collection.
    let value = getPath(snapshot.data, selector.path);
    if (value === undefined) {
      const source = snapshot.data[selector.source];
      value = getPath(source, selector.path);
    }
    // No records of a type is an answer, not a failed read: the context plane reports it
    // against the skill's requirement (CONTEXT_MISSING) instead of failing the node here.
    if (value === undefined && canonicalRecordObjectType(selector)) value = [];
    if (value === undefined && selector.required) {
      throw new Error(`runtime.v2.context_required_missing:${selectorId}`);
    }
    selected[selectorId] = value;
  }
  return cloneFrozen(selected);
}

export type GateSnapshotAuthority = Readonly<Pick<CaseSnapshotV2,
  "readReceiptId" | "snapshotId" | "snapshotDigest" | "tenantId" | "caseId" | "caseSequence" |
  "dependencyDigest" | "planDigest" | "policyAuthority" | "consistency" | "capturedAt"
>>;

export type GateEvaluationRequest = Readonly<{
  execution?: { grant: string; runId: string; attempt: number; workerId: string; fencingEpoch: number };
  planDigest: string;
  nodeId: string;
  policyRef: string;
  policyBundleDigest: string;
  gateId: string;
  input: Readonly<Record<string, unknown>>;
  inputDigest: string;
  snapshot: GateSnapshotAuthority;
}>;

export type GateEvaluator = (request: GateEvaluationRequest, signal?: AbortSignal) => Promise<unknown>;

/**
 * Execute a policy gate through an injected deterministic evaluator and bind its
 * receipt back to the exact plan, snapshot, bundle, gate and selected input.
 */
export async function executePolicyGate(
  plan: HarnessPlanV2,
  nodeId: string,
  rawSnapshot: unknown,
  evaluate: GateEvaluator,
  signal?: AbortSignal,
): Promise<PolicyEvaluation | BusinessDecision> {
  if (signal?.aborted) throw new Error("runtime.cancelled");
  const snapshot = admitCaseSnapshotV2(rawSnapshot);
  const input = selectV2CaseContext(plan, nodeId, snapshot);
  const node = plan.graph.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.kind !== "gate") throw new Error(`runtime.v2.gate_node_invalid:${nodeId}`);
  const policyRef = String(node.config.policyRef ?? "");
  const gateId = String(node.config.gateId ?? "");
  const binding = plan.policyBundles.find((candidate) => candidate.policyId === policyRef);
  if (!binding) throw new Error(`runtime.v2.policy_binding_missing:${nodeId}`);
  if (node.config.businessDecision !== "v2" && (
    snapshot.policyAuthority.policyId !== policyRef
    || digestValue(snapshot.policyAuthority.policyBundleDigest) !== digestValue(binding.bundleDigest)
  )) throw new Error("runtime.v2.snapshot_policy_authority_mismatch");
  const inputDigest = stableDigest(input);
  // Deliberately omit snapshot.data. A gate receives its compiled projection and
  // immutable authority metadata, never the root invocation or upstream node values.
  const { data: _data, classification: _classification, apiVersion: _apiVersion, kind: _kind, ...authority } = snapshot;
  const request = cloneFrozen({
    planDigest: plan.planDigest,
    nodeId,
    policyRef,
    policyBundleDigest: binding.bundleDigest,
    gateId,
    input,
    inputDigest,
    snapshot: authority,
  });
  const raw = await evaluate(request, signal);
  if (node.config.businessDecision === "v2") {
    const decision = businessDecisionSchema.parse(raw);
    const { receiptDigest, ...unsigned } = decision;
    if (stableDigest(unsigned) !== receiptDigest || decision.tenantId !== snapshot.tenantId || decision.caseId !== snapshot.caseId
      || decision.caseSequence !== snapshot.caseSequence || decision.snapshotDigest !== digestValue(snapshot.snapshotDigest)
      || decision.planDigest !== digestValue(plan.planDigest) || decision.dependencyDigest !== digestValue(snapshot.dependencyDigest)
      || decision.policyBundleDigest !== digestValue(binding.bundleDigest) || decision.gateId !== gateId
      || decision.inputProfile !== node.config.inputProfile || decision.selectedInputDigest !== inputDigest)
      throw new Error("runtime.v2.gate_evaluation_authority_mismatch");
    return decision;
  }
  const evaluation = policyEvaluationSchema.parse(raw);
  if (
    evaluation.tenantId !== snapshot.tenantId
    || evaluation.caseId !== snapshot.caseId
    || evaluation.caseSequence !== snapshot.caseSequence
    || digestValue(evaluation.caseSnapshotDigest) !== digestValue(snapshot.snapshotDigest)
    || digestValue(evaluation.dependencyDigest) !== digestValue(snapshot.dependencyDigest)
    || digestValue(evaluation.policyBundleDigest) !== digestValue(binding.bundleDigest)
    || evaluation.gateId !== gateId
    || digestValue(evaluation.inputDigest) !== inputDigest
  ) throw new Error("runtime.v2.gate_evaluation_authority_mismatch");
  return evaluation;
}

export type FanoutJoinMode = "all" | "allSettled" | "first";
export type FanoutSettledResult =
  | { status: "fulfilled"; value: unknown }
  | { status: "rejected"; reason: { code: string; message: string } };

export type BoundedFanoutOptions<T, R> = {
  items: readonly T[];
  maxItems: number;
  maxConcurrency: number;
  joinMode: FanoutJoinMode;
  execute: (item: T, index: number, signal: AbortSignal) => Promise<R>;
  signal?: AbortSignal;
};

function fanoutFailure(error: unknown): { code: string; message: string } {
  const code = error instanceof Error && error.message ? error.message : "runtime.fanout_item_failed";
  return { code, message: code };
}

/** Execute a collection without ever exceeding the compiled item or concurrency bounds. */
export async function executeBoundedFanout<T, R>(options: BoundedFanoutOptions<T, R>): Promise<R[] | FanoutSettledResult[] | R> {
  const maxItems = requirePositiveInteger(options.maxItems, "runtime.fanout_max_items_invalid");
  const maxConcurrency = requirePositiveInteger(options.maxConcurrency, "runtime.fanout_max_concurrency_invalid");
  if (!new Set(["all", "allSettled", "first"]).has(options.joinMode)) {
    throw new Error(`runtime.fanout_join_mode_unsupported:${String(options.joinMode)}`);
  }
  if (options.items.length > maxItems) throw new Error("runtime.fanout_max_items_exceeded");
  if (options.signal?.aborted) throw new Error("runtime.cancelled");
  if (!options.items.length) {
    if (options.joinMode === "first") throw new Error("runtime.fanout_first_empty");
    return [];
  }

  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason ?? new Error("runtime.cancelled"));
  options.signal?.addEventListener("abort", cancel, { once: true });
  const results: Array<FanoutSettledResult | undefined> = new Array(options.items.length);
  let nextIndex = 0;
  let winner: { index: number; value: R } | undefined;
  let stopped = false;

  const worker = async (): Promise<void> => {
    while (!stopped) {
      if (options.signal?.aborted) { stopped = true; controller.abort(); return; }
      const index = nextIndex++;
      if (index >= options.items.length) return;
      try {
        const value = await options.execute(options.items[index]!, index, controller.signal);
        results[index] = { status: "fulfilled", value };
        if (options.joinMode === "first" && !winner) {
          winner = { index, value };
          stopped = true;
          controller.abort(new Error("runtime.fanout_join_satisfied"));
        }
      } catch (error) {
        results[index] = { status: "rejected", reason: fanoutFailure(error) };
        if (options.joinMode === "all") {
          stopped = true;
          controller.abort(error);
        }
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(maxConcurrency, options.items.length) }, () => worker()));
  } finally {
    options.signal?.removeEventListener("abort", cancel);
  }
  if (options.signal?.aborted) throw new Error("runtime.cancelled");
  if (options.joinMode === "first") {
    if (winner) return winner.value;
    const firstFailure = results.find((result) => result?.status === "rejected") as Extract<FanoutSettledResult, { status: "rejected" }> | undefined;
    throw new Error(firstFailure?.reason.code ?? "runtime.fanout_all_failed");
  }
  if (options.joinMode === "allSettled") return results.filter((result): result is FanoutSettledResult => Boolean(result));
  const firstFailure = results.find((result) => result?.status === "rejected") as Extract<FanoutSettledResult, { status: "rejected" }> | undefined;
  if (firstFailure) throw new Error(firstFailure.reason.code);
  return results.map((result) => (result as Extract<FanoutSettledResult, { status: "fulfilled" }>).value as R);
}

export type SkillAttempt = {
  candidateIndex: number;
  capabilityId: string;
  connectorId: string;
  invocationId: string;
  /** §4.3 code of a failed attempt; null for the attempt that produced the result. */
  errorCode: SkillErrorCode | null;
};

export type SkillInvocation = {
  result: CapabilityResult;
  selection: SkillSelectionRecord;
  /** Every candidate tried, in order; more than one only after an equivalent-coverage fallback. */
  attempts: SkillAttempt[];
};

/**
 * Invoke a skill-bound node: select a pinned candidate, call it through the gateway with the
 * selection record (the gateway re-checks it against the admitted plan and stores it on the
 * receipt), and fall back only as `nextEquivalentCandidate` allows. Throws the last failure
 * when no permitted fallback remains.
 */
export async function invokeSkill(
  context: RuntimeContext,
  nodeId: string,
  input: unknown,
  options: { jurisdiction?: string | null } = {},
): Promise<SkillInvocation> {
  const skill = skillPlanForNode(context.plan, nodeId);
  if (!skill) throw new Error("runtime.skill_binding_missing");
  let primary = skill.permitted[0];
  if (!primary) throw new Error("runtime.skill_no_permitted_candidate");
  const jurisdiction = normalizeJurisdiction(options.jurisdiction);
  const attempts: SkillAttempt[] = [];
  let current = primary;
  let reason = primary.index === 0 ? "first_candidate" : "first_permitted_candidate";
  for (;;) {
    const selection = selectionRecord(skill.binding, current, reason, jurisdiction);
    // The primary keeps the node's ordinary invocation ID, so replay is unchanged; a
    // fallback is a distinct, equally deterministic invocation.
    const invocationId = current === primary
      ? `${context.runId}:${nodeId}:${stableDigest(input).slice(0, 24)}`
      : `${context.runId}:${nodeId}:skill${current.index}:${stableDigest(input).slice(0, 24)}`;
    const attempt: SkillAttempt = { candidateIndex: current.index, capabilityId: current.capabilityId, connectorId: current.connectorId, invocationId, errorCode: null };
    attempts.push(attempt);
    let failure: { code: SkillErrorCode; error: unknown } | null = null;
    let result: CapabilityResult | null = null;
    try {
      result = await callGateway(context, nodeId, current.capabilityId, input, invocationId, selection);
      if (result.status === "failed" && isTransientSkillError(skillErrorCodeFor(result.errorCode))) {
        failure = { code: skillErrorCodeFor(result.errorCode), error: null };
      }
    } catch (error) {
      failure = { code: skillErrorCodeFor(error instanceof Error ? error.message : String(error)), error };
    }
    if (!failure) return { result: result!, selection, attempts };
    attempt.errorCode = failure.code;
    const sourceCandidate = nextSourcePolicyCandidate(skill, primary, current, failure.error instanceof Error ? failure.error.message : "");
    if (sourceCandidate) {
      reason = `source_scope_fallback:candidate_${current.index}`;
      current = sourceCandidate;
      continue;
    }
    // A coverage refusal means this candidate may not serve the subject at all; the next
    // permitted candidate becomes the primary that later fallbacks are measured against.
    const refused = coverageReasonFromError(failure.error instanceof Error ? failure.error.message : "");
    if (refused) {
      const eligible = nextEligibleCandidate(skill, current);
      if (!eligible) throw failure.error;
      reason = `skipped_${refused}:candidate_${current.index}`;
      primary = eligible;
      current = eligible;
      continue;
    }
    const next = nextEquivalentCandidate(skill, primary, current, failure.code);
    if (!next) {
      if (result) return { result, selection, attempts };
      throw failure.error;
    }
    reason = `fallback_after_${failure.code.toLowerCase()}:candidate_${current.index}`;
    current = next;
  }
}

/** Source lineage follows admitted canonical records and predecessor outputs into each context. */
export function sourceDecisionIdsForSelection(selection: unknown): string[] {
  const ids = new Set<string>();
  const visited = new WeakSet<object>();
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) { value.forEach(visit); return; }
    const row = value as Record<string, unknown>;
    const provenance = row.provenance as Record<string, unknown> | undefined;
    if (provenance?.method === "connector_normalizer") {
      if (typeof provenance.source_decision_id !== "string") throw new Error("context.source_authorization_missing");
      ids.add(provenance.source_decision_id);
    }
    const source = row.sourceAuthorization as Record<string, unknown> | undefined;
    if (typeof source?.decisionId === "string") ids.add(source.decisionId);
    Object.values(row).forEach(visit);
  };
  visit(selection);
  return [...ids].sort();
}

export async function authorizeSourceEvidenceSelection(context: RuntimeContext, nodeId: string, selection: unknown): Promise<void> {
  if (context.draftTest) return; // Test context is supplied explicitly; no live source reads.
  if (!context.plan.sourceAuthorization) return;
  const decisionIds = sourceDecisionIdsForSelection(selection);
  if (!decisionIds.length) return;
  const invocationId = `${context.runId}:${nodeId}:source-use:${stableDigest(decisionIds).slice(0, 24)}`;
  const issued = await requestExecutionEnvelope(context, nodeId, invocationId);
  const response = await fetch(`${context.gatewayUrl}/v1/evidence/use`, { method: "POST",
    headers: { authorization: `Bearer ${await workloadToken(context.serviceToken)}`, "x-execution-envelope": issued.envelope, "content-type": "application/json" },
    body: JSON.stringify({ decisionIds }), signal: AbortSignal.timeout(20_000), redirect: "error" });
  const body = await response.json() as { authorized?: boolean; error?: string };
  if (!response.ok || body.authorized !== true) throw new Error(body.error ?? "context.source_use_denied");
}

export async function invokeCapability(
  context: RuntimeContext,
  nodeId: string,
  input: unknown,
  options: { capabilityId?: string; step?: number; jurisdiction?: string | null; skillId?: string } = {},
): Promise<CapabilityResult> {
  const binding = context.plan.graph.nodes.find((node) => node.id === nodeId);
  const capabilityId = options.capabilityId ?? String(binding?.config.capabilityId ?? "");
  // An agent loop's skill call names the skill: its plan is the node's pinned binding for that
  // skill, never the node's own skill, and never one the node may not invoke.
  const skill = skillPlanForNode(context.plan, nodeId, options.skillId);
  if (options.skillId && !skill) throw new Error("runtime.loop_skill_not_permitted");
  const candidate = skill?.permitted.find((item) => item.capabilityId === capabilityId);
  if (options.skillId && !candidate) throw new Error("runtime.loop_skill_candidate_not_permitted");
  // A skill-bound node's own call selects among its pinned candidates. An agent loop that
  // names one of them explicitly gets that candidate, recorded as the agent's choice.
  if (skill && candidate && !options.capabilityId && options.step === undefined) {
    return (await invokeSkill(context, nodeId, input, { jurisdiction: options.jurisdiction ?? null })).result;
  }
  // Stable across worker crashes so a resumed checkpoint replays the gateway receipt
  // instead of repeating a paid or externally-visible operation. Loop steps add the
  // capability and step so two steps with equal input are still distinct invocations.
  const invocationId = options.capabilityId || options.step !== undefined
    ? `${context.runId}:${nodeId}:${options.step ?? 0}:${stableDigest({ capabilityId, input }).slice(0, 24)}`
    : `${context.runId}:${nodeId}:${stableDigest(input).slice(0, 24)}`;
  const selection = skill && candidate
    ? selectionRecord(skill.binding, candidate, "agent_selected", normalizeJurisdiction(options.jurisdiction))
    : undefined;
  return callGateway(context, nodeId, capabilityId, input, invocationId, selection);
}

async function callGateway(
  context: RuntimeContext,
  nodeId: string,
  capabilityId: string,
  input: unknown,
  invocationId: string,
  skill?: SkillSelectionRecord,
): Promise<CapabilityResult> {
  const capability = context.plan.capabilities.find((item) => item.id === capabilityId);
  const permission = context.plan.permissionEnvelopes.find((item) => item.nodeId === nodeId);
  if (!capability || !permission) throw new Error("runtime.capability_binding_missing");
  // A loop tool is any other capability in the node's compiled envelope; the gateway
  // re-checks this, but refusing here keeps an unpermitted call off the wire.
  if (!permission.capabilities.includes(capabilityId)) throw new Error("runtime.capability_not_permitted");
  if (context.draftTest) return context.draftTest.invoke(nodeId, capabilityId, input);
  const issued = await requestExecutionEnvelope(context, nodeId, invocationId);
  const token = await workloadToken(context.serviceToken);
  return withSpan("capability.request", {
    kind: SpanKind.CLIENT,
    attributes: {
      "server.address": "capability-gateway",
      "http.request.method": "POST",
      "harness.execution.id": context.runId,
      "harness.node.id": nodeId,
      "harness.capability.id": capabilityId,
      "harness.capability.effect": capability.effect,
      "harness.plan.digest_prefix": context.plan.planDigest.slice(0, 12),
      ...(skill ? {
        "harness.skill.id": skill.skillId,
        "harness.skill.version": skill.skillVersion,
        "harness.skill.candidate_index": skill.candidateIndex,
      } : {}),
    },
  }, async (span) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "x-execution-envelope": issued.envelope,
      "content-type": "application/json",
    };
    injectTraceContext(headers);
    const response = await fetch(`${context.gatewayUrl}/v1/invoke`, {
      method: "POST",
      headers,
      body: JSON.stringify({ invocationId, capabilityId, effect: capability.effect, input, ...(skill ? { skill } : {}) }),
      signal: AbortSignal.timeout(capability.timeoutMs + 2_000),
    });
    span.setAttribute("http.response.status_code", response.status);
    const body = await response.json();
    if (!response.ok) throw new Error(String((body as { error?: string }).error ?? "runtime.gateway_failed"));
    const result = capabilityResultSchema.parse(body);
    span.setAttributes({
      "harness.outcome": result.status.toUpperCase(),
      "harness.provider": result.provider ?? "unknown",
      "harness.model.profile": capability.kind === "model" ? capability.adapterBindingId.replace(/^openrouter:/, "") : "none",
    });
    return result;
  });
}

async function caseRequest(
  context: RuntimeContext,
  operation: string,
  path: string,
  init: RequestInit,
): Promise<Record<string, unknown>> {
  if (!context.caseApiUrl) throw new Error("runtime.case_api_url_missing");
  return withSpan(operation, {
    kind: SpanKind.CLIENT,
    attributes: {
      "server.address": "case-api",
      "http.request.method": init.method ?? "GET",
      "url.path": path,
      "harness.execution.id": context.runId,
      "harness.plan.digest_prefix": context.plan.planDigest.slice(0, 12),
    },
  }, async (span) => {
    const token = await workloadToken(context.serviceToken);
    const headers: Record<string, string> = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...(init.headers as Record<string, string> ?? {}),
    };
    injectTraceContext(headers);
    const response = await fetch(`${context.caseApiUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(10_000) });
    span.setAttribute("http.response.status_code", response.status);
    const body = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(String(body.error ?? "runtime.case_api_failed"));
    return body;
  });
}

async function currentCaseSequence(context: RuntimeContext, tenantId: string, caseId: string, executionHeaders: Record<string, string>): Promise<number> {
  const view = await caseRequest(context, "case.sequence", `/v2/cases/${encodeURIComponent(caseId)}/sequence`, {
    method: "GET",
    headers: { ...executionHeaders, "x-tenant-id": tenantId },
  });
  const sequence = Number(view.caseSequence);
  if (!Number.isInteger(sequence) || sequence < 0) throw new Error("runtime.case_sequence_invalid");
  return sequence;
}

export async function executeCaseWrites(
  context: RuntimeContext,
  nodeId: string,
  rootInput: unknown,
  nodeInput: unknown,
  output: unknown,
  values: Record<string, unknown>,
  authoritySnapshot?: CaseSnapshotV2,
  /** The context pack the node's model answered from, when the node shows a model context. */
  contextPack?: { packDigest: string } & Record<string, unknown>,
): Promise<CaseWriteReceipt | null> {
  const node = context.plan.graph.nodes.find((candidate) => candidate.id === nodeId);
  // Skill grants authorize the skill commit path, not a declarative write: they are never materialized here.
  const writes = Array.isArray(node?.config.caseWrites)
    ? node.config.caseWrites.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry) && !isSkillCaseWriteGrant(entry))
    : [];
  const capture = node?.config.evidenceCapture;
  if (context.draftTest) {
    if (capture && typeof capture === "object" && !Array.isArray(capture)) {
      context.draftTest.suppressEffect?.(nodeId, "Register evidence", false);
    }
    for (const write of writes) {
      if (typeof write.commandType === "string") {
        context.draftTest.suppressEffect?.(nodeId, write.commandType, Boolean(write.forEach || (write.when && write.when !== "success")));
      }
    }
    return null;
  }
  if (!writes.length && (!capture || typeof capture !== "object" || Array.isArray(capture))) return null;
  const rawCaseInput = rootInput && typeof rootInput === "object" && !Array.isArray(rootInput)
    ? rootInput as Record<string, unknown>
    : {};
  const snapshotData = authoritySnapshot?.data && typeof authoritySnapshot.data === "object"
    ? authoritySnapshot.data as Record<string, unknown>
    : {};
  const caseInput: Record<string, unknown> = authoritySnapshot
    ? { ...rawCaseInput, ...snapshotData, ...authoritySnapshot }
    : rawCaseInput;
  const tenantId = String(caseInput.tenantId ?? "");
  const caseId = String(caseInput.caseId ?? "");
  const policySnapshotDigest = String(authoritySnapshot?.policyAuthority.policySnapshotDigest ?? caseInput.policySnapshotDigest ?? "");
  if (!tenantId || !caseId || !policySnapshotDigest) throw new Error("runtime.case_context_missing");
  const permission = context.plan.permissionEnvelopes.find((candidate) => candidate.nodeId === nodeId);
  if (!permission) throw new Error("runtime.case_write_permission_missing");
  const snapshotSubjects = Array.isArray(snapshotData.subjects) ? snapshotData.subjects as Array<Record<string, unknown>> : [];
  const snapshotRecords = snapshotData.records && typeof snapshotData.records === "object" && !Array.isArray(snapshotData.records)
    ? Object.values(snapshotData.records as Record<string, unknown>).flatMap((rows) => Array.isArray(rows) ? rows as Array<Record<string, unknown>> : []) : [];
  const scope: CaseWriteScope = {
    case: caseInput,
    nodeInput,
    output,
    values,
    run: { runId: context.runId, attempt: context.runAttempt, planDigest: context.plan.planDigest, nodeId, at: new Date().toISOString() },
    subjects: snapshotSubjects.map((subject) => String(subject.subject_id ?? subject.subjectId ?? "")).filter(Boolean),
    syntheticCase: snapshotRecords.length > 0 && snapshotRecords.every((record) => record.synthetic === true),
  };
  const actorMode = String(node?.config.caseWriteActor ?? "agent");
  const outputRecord = output && typeof output === "object" && !Array.isArray(output)
    ? output as Record<string, unknown>
    : {};
  const actor = actorMode === "humanDecision"
    ? {
        type: "HUMAN" as const,
        principalId: String(outputRecord.reviewerPrincipalId ?? "human-reviewer"),
        roles: ["Case.Reviewer"],
      }
    : actorMode === "system"
      // A step the plan marks as a system writer (a connector normalizer, a workflow step) still
      // writes as this runtime: the case service derives the actor from the verified caller and
      // accepts only AGENT from a runtime workload, attributing the write to the run and node of
      // the signed envelope. Claiming SYSTEM here was always refused (authorization.actor_type_invalid).
      ? {
          type: "AGENT" as const,
          principalId: String(node?.config.caseWritePrincipalId ?? `workflow:${nodeId}`),
          executionId: context.runId,
          roles: [],
        }
      : {
          type: "AGENT" as const,
          principalId: typeof node?.config.agentRef === "string" ? node.config.agentRef : nodeId,
          executionId: context.runId,
          roles: [],
        };
  // Case writes are an effect, so they carry the same node-scoped authority as a
  // capability call. The case service checks each command against the command types the
  // plan declared for this node rather than trusting the runtime to have read the plan.
  const issued = await requestExecutionEnvelope(context, nodeId, `${context.runId}:${nodeId}:case-writes:${context.runAttempt}`);
  const executionHeaders = { "x-execution-envelope": issued.envelope };
  const receipt: CaseWriteReceipt = { commands: [] };
  // An agent's proposal cites what its model was shown. The pack is promoted to the evidence
  // store as `model_context` before any command, so the case record and its basis commit
  // together and the context store can later be released (data-stores-plan.md §3.3).
  let contextAuthority: { contextEvidenceId: string; contextPackDigest: string } | null = null;
  if (contextPack && writes.length && actorMode === "agent") {
    const promoted = await caseRequest(context, "evidence.register", "/v1/evidence:register", {
      method: "POST",
      headers: { ...executionHeaders, "idempotency-key": `${context.runId}:${context.runAttempt}:${nodeId}:model-context:${contextPack.packDigest.slice(0, 24)}` },
      body: JSON.stringify(registerEvidenceRequestSchema.parse({
        tenantId,
        caseId,
        type: "model_context",
        mediaType: "application/json",
        contentBase64: Buffer.from(JSON.stringify(contextPack)).toString("base64"),
        source: {
          type: "DERIVED",
          capability: typeof node?.config.capabilityId === "string" ? node.config.capabilityId : undefined,
          retrievedAt: new Date().toISOString(),
        },
        // The pack quotes case data and untrusted evidence; it is never shown to a model again.
        trust: { tier: "PLATFORM_RECORD", instructionTrust: "UNTRUSTED_DATA" },
        classification: String(authoritySnapshot?.classification ?? caseInput.classification ?? "CONFIDENTIAL"),
        retentionClass: "DECISION_RECORD",
        residency: String(caseInput.residency ?? caseInput.country ?? "US"),
        createdBy: actor,
      })),
    });
    const evidence = promoted.evidence as Record<string, unknown> | undefined;
    if (!evidence || typeof evidence.evidenceId !== "string") throw new Error("runtime.context_promotion_invalid");
    contextAuthority = { contextEvidenceId: evidence.evidenceId, contextPackDigest: contextPack.packDigest };
    receipt.contextEvidenceId = evidence.evidenceId;
  }
  if (capture && typeof capture === "object" && !Array.isArray(capture)) {
    const captureConfig = capture as Record<string, unknown>;
    const retrievedAt = typeof outputRecord.retrievedAt === "string"
      ? outputRecord.retrievedAt
      : typeof outputRecord.screenedAt === "string"
        ? outputRecord.screenedAt
        : authoritySnapshot?.capturedAt ?? new Date().toISOString();
    const subjects = Array.isArray(snapshotData.subjects) ? snapshotData.subjects : [];
    const firstSubject = subjects[0] && typeof subjects[0] === "object"
      ? subjects[0] as Record<string, unknown>
      : {};
    const subjectId = caseInput.subjectId ?? firstSubject.subjectId ?? firstSubject.subject_id;
    const evidenceRequest = registerEvidenceRequestSchema.parse({
      tenantId,
      caseId,
      type: String(captureConfig.type ?? `${nodeId}.output`),
      mediaType: "application/json",
      contentBase64: Buffer.from(JSON.stringify(output)).toString("base64"),
      source: {
        type: String(captureConfig.sourceType ?? "DERIVED"),
        capability: typeof node?.config.capabilityId === "string" ? node.config.capabilityId : undefined,
        retrievedAt,
      },
      subjectRefs: subjectId ? [String(subjectId)] : [],
      trust: {
        tier: String(captureConfig.trustTier ?? "POC_PROVIDER"),
        instructionTrust: String(captureConfig.instructionTrust ?? "UNTRUSTED_DATA"),
      },
      classification: String(authoritySnapshot?.classification ?? caseInput.classification ?? "CONFIDENTIAL"),
      retentionClass: String(captureConfig.retentionClass ?? "KYC_REGULATED"),
      residency: String(caseInput.residency ?? caseInput.country ?? "US"),
      createdBy: actor,
    });
    const registered = await caseRequest(context, "evidence.register", "/v1/evidence:register", {
      method: "POST",
      headers: { ...executionHeaders, "idempotency-key": `${context.runId}:${context.runAttempt}:${nodeId}:evidence` },
      body: JSON.stringify(evidenceRequest),
    });
    const evidence = registered.evidence;
    if (!evidence || typeof evidence !== "object" || typeof (evidence as Record<string, unknown>).evidenceId !== "string") {
      throw new Error("runtime.evidence_registration_invalid");
    }
    receipt.evidenceId = String((evidence as Record<string, unknown>).evidenceId);
    scope.evidence = { evidenceId: receipt.evidenceId };
  }

  // A write may repeat over a list in the node's result (`forEach: "output.documentChecks"`): each
  // item is `item` (and `itemIndex`) in its template and `when` condition. A missing list writes
  // nothing; a list longer than CASE_WRITE_FOREACH_LIMIT fails the node rather than truncating.
  const expanded: Array<{ index: number; key: string; write: Record<string, unknown>; scope: Record<string, unknown> }> = [];
  for (const [index, write] of writes.entries()) {
    if (write.forEach === undefined) {
      expanded.push({ index, key: String(index), write, scope: scope as unknown as Record<string, unknown> });
      continue;
    }
    const items = getPath(scope, String(write.forEach));
    if (items === undefined || items === null) continue;
    if (!Array.isArray(items)) throw new Error("runtime.case_write_foreach_not_list");
    if (items.length > CASE_WRITE_FOREACH_LIMIT) throw new Error("runtime.case_write_foreach_too_many");
    items.forEach((item, itemIndex) => expanded.push({ index, key: `${index}:${itemIndex}`, write, scope: { ...scope, item, itemIndex } }));
  }
  for (const { key: index, write, scope: itemScope } of expanded) {
    const when = String(write.when ?? "success");
    if (when !== "success" && !evaluateCondition(when, itemScope)) continue;
    const commandType = String(write.commandType ?? "");
    const payload = materializeTemplate(write.payload ?? {}, itemScope);
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("runtime.case_write_payload_invalid");
    const sequence = await currentCaseSequence(context, tenantId, caseId, executionHeaders);
    const command: BusinessCommand = businessCommandSchema.parse({
      commandId: `cmd_${stableDigest(`${context.runId}:${nodeId}:${index}`).slice(0, 24)}`,
      commandType,
      commandVersion: "harness.case-write.v1",
      tenantId,
      caseId,
      actor,
      authority: {
        planDigest: context.plan.planDigest,
        permissionEnvelopeDigest: permission.digest,
        policySnapshotDigest,
        ...(contextAuthority ?? {}),
      },
      payload,
      preconditions: { caseSequence: sequence },
      idempotencyKey: `${tenantId}:${caseId}:${context.runId}:${context.runAttempt}:${nodeId}:${index}`,
    });
    const response = await caseRequest(context, "case.command", `/v1/cases/${encodeURIComponent(caseId)}/commands`, {
      method: "POST",
      headers: executionHeaders,
      body: JSON.stringify(command),
    });
    const identifiers = response.createdIdentifiers && typeof response.createdIdentifiers === "object" && !Array.isArray(response.createdIdentifiers)
      ? Object.fromEntries(Object.entries(response.createdIdentifiers as Record<string, unknown>).map(([key, value]) => [key, String(value)]))
      : {};
    receipt.commands.push({ commandType, createdIdentifiers: identifiers });
    await context.state.appendEvent(fencedRun(context), {
      eventKey: `case-write:${nodeId}:${context.runAttempt}:${index}`,
      code: "case.write.completed",
      nodeId,
      status: "passed",
      values: { commandType },
    });
  }
  return receipt;
}


/** The most items one `forEach` case write may expand to in a node attempt. */
export const CASE_WRITE_FOREACH_LIMIT = 50;

/** What the skill commit path did for one node attempt; attached to the node value as `__skillCommit`. */
export type SkillCommitReceipt = {
  executionId: string;
  bindingDigest: string;
  caseSequence: number;
  evidenceId: string | null;
  replayed: boolean;
  committed: Array<{ localRef: string; commandType: string; createdIdentifiers: Record<string, string> }>;
  held: Array<{ effectKey: string; type: string; commandType: string | null; action: string | null; expiresAt: string }>;
  releaseNodeId: string | null;
  approvalNodeId: string | null;
  uncommitted: Array<{ localRef: string; recordType: string; reason: string }>;
};

/**
 * Commit a hosted skill's proposed records and route its requested effects (skill.execution.v1
 * §6.2–6.3), after the gateway validated the computation and before SkillResult.v1 is built. One
 * request to the case API's skill-commit endpoint with this node's execution envelope applies
 * everything atomically; it is idempotent per skill execution, so a replayed attempt (same gateway
 * invocation, same execution id) changes nothing. The skill host never holds write credentials.
 * Returns null when the output has nothing to commit. Throws (failing the node) on a mapping the
 * plan does not grant or a refused commit, e.g. `skill_commit.case_sequence_stale`.
 */
export async function commitSkillComputation(
  context: RuntimeContext,
  nodeId: string,
  input: {
    result: CapabilityResult;
    output: SkillCapabilityOutputV1;
    capabilityInput: unknown;
    contextHash: string;
    rootInput: unknown;
    snapshot: CaseSnapshotV2 | null;
  },
): Promise<SkillCommitReceipt | null> {
  if (!skillOutputNeedsCommit(input.output)) return null;
  const skill = skillPlanForNode(context.plan, nodeId);
  if (!skill) throw new Error("skill.commit_binding_missing");
  const root = input.rootInput && typeof input.rootInput === "object" && !Array.isArray(input.rootInput) ? input.rootInput as Record<string, unknown> : {};
  const tenantId = String(input.snapshot?.tenantId ?? root.tenantId ?? "");
  const caseId = String(input.snapshot?.caseId ?? root.caseId ?? "");
  if (!tenantId || !caseId) throw new Error("runtime.case_context_missing");
  const fence = fencedRun(context);
  const planned = (evidenceId: string | null) => planSkillCommit({
    plan: context.plan, nodeId, binding: skill.binding, output: input.output, tenantId, caseId,
    receiptDigest: input.result.receiptDigest, requestDigest: stableDigest(input.capabilityInput), contextHash: input.contextHash,
    snapshotSequence: input.snapshot?.caseSequence ?? null, evidenceId, now: Date.now(),
  });
  // Refuse an output the plan does not grant before anything (even evidence) is written.
  planned(skillOutputCommitsRecords(input.output) ? "evidence_pending" : null);
  const issued = await requestExecutionEnvelope(context, nodeId, `${context.runId}:${nodeId}:skill-commit:${context.runAttempt}`);
  const executionHeaders = { "x-execution-envelope": issued.envelope };
  const executionId = input.output.execution_id;
  let evidenceId: string | null = null;
  if (skillOutputCommitsRecords(input.output)) {
    // The validated computation is the evidence every committed record cites (with its own
    // section and receipt citations inside); registration is idempotent per skill execution.
    const subjects = Array.isArray((input.snapshot?.data as Record<string, unknown> | undefined)?.subjects)
      ? ((input.snapshot!.data as Record<string, unknown>).subjects as Array<Record<string, unknown>>) : [];
    const subjectId = subjects[0]?.subject_id ?? subjects[0]?.subjectId;
    const registered = await caseRequest(context, "evidence.register", "/v1/evidence:register", {
      method: "POST",
      headers: { ...executionHeaders, "idempotency-key": `skill:${executionId}:evidence` },
      body: JSON.stringify(registerEvidenceRequestSchema.parse({
        tenantId, caseId,
        type: "skill_computation",
        mediaType: "application/json",
        contentBase64: Buffer.from(JSON.stringify({
          skillId: input.output.skill_id, skillVersion: input.output.skill_version, executionId,
          receiptDigest: input.result.receiptDigest, computation: input.output.computation,
        })).toString("base64"),
        source: { type: "DERIVED", capability: `skills:${input.output.skill_id}`, retrievedAt: input.snapshot?.capturedAt ?? new Date().toISOString() },
        subjectRefs: subjectId ? [String(subjectId)] : [],
        trust: { tier: "SKILL_COMPUTATION", instructionTrust: "UNTRUSTED_DATA" },
        classification: String(input.snapshot?.classification ?? "CONFIDENTIAL"),
        retentionClass: "KYC_REGULATED",
        residency: String(root.residency ?? "US"),
        createdBy: { type: "AGENT", principalId: `skills:${input.output.skill_id}@${input.output.skill_version}`, executionId: context.runId, roles: [] },
      })),
    });
    const evidence = registered.evidence as Record<string, unknown> | undefined;
    if (!evidence || typeof evidence.evidenceId !== "string") throw new Error("runtime.evidence_registration_invalid");
    evidenceId = evidence.evidenceId;
  }
  const request = planned(evidenceId);
  const response = await caseRequest(context, "case.skill.commit", `/v1/cases/${encodeURIComponent(caseId)}/skill-commits`, {
    method: "POST", headers: executionHeaders, body: JSON.stringify(request),
  });
  const receipt: SkillCommitReceipt = {
    executionId,
    bindingDigest: String(response.bindingDigest),
    caseSequence: Number(response.caseSequence),
    evidenceId,
    replayed: response.replayed === true,
    committed: (Array.isArray(response.commands) ? response.commands : []).map((item: Record<string, unknown>) => ({
      localRef: String(item.localRef), commandType: String(item.commandType),
      createdIdentifiers: Object.fromEntries(Object.entries((item.createdIdentifiers ?? {}) as Record<string, unknown>).map(([key, value]) => [key, String(value)])),
    })),
    held: request.held.map((effect) => ({ effectKey: effect.effectKey, type: effect.type, commandType: effect.commandType ?? null, action: effect.action ?? null, expiresAt: effect.expiresAt })),
    releaseNodeId: request.releaseNodeId,
    approvalNodeId: request.approvalNodeId,
    uncommitted: request.uncommitted,
  };
  await context.state.appendEvent(fence, {
    eventKey: `skill-commit:${nodeId}:${context.runAttempt}`,
    code: receipt.held.length ? "skill.commit.held" : "skill.commit.completed",
    nodeId, status: "passed",
    values: {
      executionId, bindingDigest: receipt.bindingDigest, caseSequence: receipt.caseSequence, replayed: receipt.replayed,
      committed: receipt.committed.map((item) => item.commandType), held: receipt.held.map((item) => item.commandType ?? item.action),
      uncommitted: receipt.uncommitted.map((item) => item.recordType), releaseNodeId: receipt.releaseNodeId,
    },
  });
  return receipt;
}

/**
 * The release node after a durable approval (`config.skillEffectRelease`): commit the effects held
 * for the skill node's execution when the approval is APPROVE, discard them (with an audit event)
 * when it is REJECT. The case API re-validates the binding, the case sequence and the expiry and
 * refuses a stale or expired release (the node fails; the skill must be re-run). An external action
 * is queued to the case outbox only when the plan publishes `external_action.<id>`; otherwise it
 * stays a pending intent with status NO_ROUTE, which this node reports and never treats as sent.
 */
export async function releaseHeldSkillEffects(
  context: RuntimeContext,
  nodeId: string,
  rootInput: unknown,
  values: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const node = context.plan.graph.nodes.find((candidate) => candidate.id === nodeId);
  const release = node?.config.skillEffectRelease as { skillNodeId?: unknown; approvalNodeId?: unknown } | undefined;
  if (!release || typeof release.skillNodeId !== "string" || typeof release.approvalNodeId !== "string") throw new Error("skill.release_config_invalid");
  const decision = skillApprovalDecisionFrom(values[release.approvalNodeId]);
  const fence = fencedRun(context);
  const skillValue = values[release.skillNodeId] as Record<string, unknown> | undefined;
  const commit = skillValue?.__skillCommit as SkillCommitReceipt | undefined;
  if (!commit || !commit.held.length) {
    await context.state.appendEvent(fence, {
      eventKey: `skill-release:${nodeId}:${context.runAttempt}`, code: "skill.effects.none_held", nodeId, status: "observed",
      values: { decision: decision.decision, skillNodeId: release.skillNodeId },
    });
    return { outcome: "NOTHING_HELD", decision: decision.decision, effects: [] };
  }
  const root = rootInput && typeof rootInput === "object" && !Array.isArray(rootInput) ? rootInput as Record<string, unknown> : {};
  const tenantId = String(root.tenantId ?? "");
  const caseId = String(root.caseId ?? "");
  if (!tenantId || !caseId) throw new Error("runtime.case_context_missing");
  const actions = commit.held.map((effect) => effect.action).filter((action): action is string => Boolean(action));
  const request = skillEffectReleaseRequestSchema.parse({
    tenantId, caseId, executionId: commit.executionId, skillNodeId: release.skillNodeId, approvalNodeId: release.approvalNodeId,
    bindingDigest: commit.bindingDigest, decision, routedActions: routedExternalActions(context.plan, actions),
  });
  const issued = await requestExecutionEnvelope(context, nodeId, `${context.runId}:${nodeId}:skill-release:${context.runAttempt}`);
  const response = await caseRequest(context, "case.skill.release",
    `/v1/cases/${encodeURIComponent(caseId)}/skill-executions/${encodeURIComponent(commit.executionId)}/release`, {
      method: "POST", headers: { "x-execution-envelope": issued.envelope }, body: JSON.stringify(request),
    });
  const effects = Array.isArray(response.effects) ? response.effects as Array<Record<string, unknown>> : [];
  const unrouted = effects.filter((effect) => effect.status === "NO_ROUTE").map((effect) => String(effect.action));
  await context.state.appendEvent(fence, {
    eventKey: `skill-release:${nodeId}:${context.runAttempt}`,
    code: response.outcome === "DISCARDED" ? "skill.effects.discarded" : "skill.effects.released",
    nodeId, status: "passed",
    values: { executionId: commit.executionId, decision: decision.decision, outcome: String(response.outcome), statuses: effects.map((effect) => String(effect.status)) },
  });
  if (unrouted.length) {
    await context.state.appendEvent(fence, {
      eventKey: `skill-release:${nodeId}:${context.runAttempt}:no-route`, code: "skill.effects.no_route", nodeId, status: "observed",
      values: { executionId: commit.executionId, actions: unrouted },
    });
  }
  return { ...response, decision: decision.decision };
}

/** Identity of the fenced attempt this runtime is journaling under. */
export function fencedRun(context: RuntimeContext): FencedRun {
  return {
    runId: context.runId,
    attempt: context.runAttempt,
    workerId: context.workerId,
    fencingEpoch: context.fencingEpoch,
  };
}

export async function executeObservedNode<T>(
  context: RuntimeContext,
  nodeId: string,
  input: unknown,
  execute: () => Promise<T>,
): Promise<T> {
  const node = context.plan.graph.nodes.find((item) => item.id === nodeId);
  const run = fencedRun(context);
  return withSpan("workflow.transition", {
    kind: SpanKind.INTERNAL,
    attributes: {
      "harness.execution.id": context.runId,
      "harness.node.id": nodeId,
      "harness.node.kind": node?.kind ?? "unknown",
      "harness.execution.attempt": context.runAttempt,
      "harness.fencing.epoch": context.fencingEpoch,
      "harness.plan.digest_prefix": context.plan.planDigest.slice(0, 12),
    },
  }, async (span) => {
    const spanRef = traceReference(span);
    // Only digests cross this boundary: the journal records that a node ran and what its
    // input and output hashed to, never the values themselves.
    // Each transition carries the event that announces it: one journal write, not two.
    const readsCase = Boolean(context.caseReadEnvelopes) && (node?.contextSelectorIds?.length ?? 0) > 0;
    const started = await context.state.nodeStarted(run, {
      nodeId,
      inputDigest: stableDigest(input),
      traceId: spanRef.traceId,
      spanId: spanRef.spanId,
      event: { eventKey: `node:${nodeId}:${context.runAttempt}:started`, code: "node.started", nodeId, status: "observed", values: {} },
      ...(readsCase ? { issueCaseReadEnvelope: true } : {}),
    });
    if (started?.caseReadEnvelope) {
      context.caseReadEnvelopes!.set(nodeId, {
        envelope: started.caseReadEnvelope.envelope,
        expiresAt: Date.now() + started.caseReadEnvelope.expiresInSeconds * 1_000,
      });
    }
    try {
      context.draftTest?.observe(nodeId, input);
      const result = await execute();
      context.draftTest?.observe(nodeId, input, result);
      span.setAttribute("harness.outcome", "COMPLETED");
      await context.state.nodeFinished(run, {
        nodeId, status: "completed", outputDigest: stableDigest(result),
        event: { eventKey: `node:${nodeId}:${context.runAttempt}:completed`, code: "node.completed", nodeId, status: "passed", values: {} },
      });
      return result;
    } catch (error) {
      const code = error instanceof Error ? error.message : "runtime.node_failed";
      await context.state.nodeFinished(run, {
        nodeId, status: "failed", errorCode: code,
        event: { eventKey: `node:${nodeId}:${context.runAttempt}:failed`, code: "node.failed", nodeId, status: "failed", values: { errorCode: code } },
      });
      throw error;
    }
  });
}
