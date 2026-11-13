import { discoveryRunInputSchema, validateDiscoveryAdvisoryOutput } from "@ehf/contracts";
import { sandboxDocumentsObservation, sandboxObservationSink, sandboxSkillObservation } from "./sandbox-observations.js";
import { prepareSkillContext } from "./prepare-context.js";
import { Annotation, END, START, StateGraph, interrupt, isGraphInterrupt } from "@langchain/langgraph";
import {
  businessDecisionSchema, agentTaskCompletionSchema, evaluateTaskCompletion, loopSkillForNode, nodeShowsModelContext, stableDigest, type CaseSnapshot as CaseSnapshotV2, type HarnessPlanV2 } from "@ehf/contracts";
import { assembleContextPack, buildSkillCapabilityInput, chooseSkillPolicy, contextPackSummary, renderContextPrompt, resolveSkillPolicySection, type ContextEnvelopeInput, type ContextPack } from "@ehf/context-plane";
import { contextGapSkillResult, hostedSkillCandidate, skillParametersFor, skillPurposeFor } from "./hosted-skill.js";
export { contextGapSkillResult, bindingValue, hostedSkillCandidate, skillParametersFor, skillPurposeFor } from "./hosted-skill.js";
import { loopConfigFor, runAgentLoop } from "./agent-loop.js";
import { acquireSubjects } from "./subject-acquisition.js";
import { evaluatePackCheckpoint, type PackGateConfig } from "./pack-gate.js";
import { agentSkillResults } from "./agent-skill-results.js";
export { agentSkillResults } from "./agent-skill-results.js";
export { flowMainPath, recordingFlowIo, replayFlowIo, runAgentFlow, type AgentRunEntry, type FlowRecording, type ReplayDrift, type CorpusRecord, type FlowRunIo, type FlowRunReport, type SkillRun } from "./agent-flow-run.js";
export { scoreAgentAnswers, type AgentAnswer, type AnswerKeyCheck, type AnswerKeyResult, type DocumentExpectations, type HeroExpectations } from "./agent-answer-key.js";
export { evaluatePackCheckpoint, type PackGateConfig } from "./pack-gate.js";
import { assessBankingRelationshipWithOpa } from "@ehf/policy-engine";
import { bankingPolicySchema, bankingRelationshipSchema } from "@ehf/contracts";
export { loopConfigFor, renderLoopPrompt, runAgentLoop, LOOP_PROTOCOL_HEADING, type AgentLoopResult, type LoopSkillResult, type LoopStepRecord } from "./agent-loop.js";
import {
  admitCaseSnapshotV2,
  admitHarnessPlanV2,
  authorizeSourceEvidenceSelection,
  evaluateCondition,
  aggregateValue,
  executeBoundedFanout,
  executeCaseWrites,
  executeObservedNode,
  executePolicyGate,
  getPath,
  invokeCapability,
  skillCapabilityOutput,
  skillExecutionId,
  skillPlanForNode,
  skillResultFromExecution,
  commitSkillComputation,
  releaseHeldSkillEffects,
  type SkillCommitReceipt,
  toSkillResult,
  renderTemplate,
  selectV2CaseContext,
  transformValue,
  v2ExecutionEdges,
  type FanoutJoinMode,
  type GateEvaluator,
  type RuntimeContext,
} from "@ehf/runtime-core";

const stateSchema = Annotation.Root({
  input: Annotation<unknown>(),
  values: Annotation<Record<string, unknown>>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),
  output: Annotation<unknown>(),
  settlements: Annotation<Record<string, SettledResult>>({
    reducer: (current, update) => ({ ...current, ...update }),
    default: () => ({}),
  }),
});
export type HarnessState = typeof stateSchema.State;
export type SettledResult =
  | { status: "fulfilled"; value: unknown }
  | { status: "rejected"; reason: { code: string; message: string } };

function joinMode(node: HarnessPlanV2["graph"]["nodes"][number] | undefined): string {
  return String(node?.config.mode ?? node?.config.operation ?? "all");
}

export type V2SnapshotRequest = Readonly<{
  tenantId: string;
  caseId: string;
  planDigest: string;
  nodeId: string;
  selectorIds: readonly string[];
  purposes: readonly string[];
  execution?: Readonly<{
    grant: string;
    invocationId: string;
    runId: string;
    attempt: number;
    workerId: string;
    fencingEpoch: number;
  }>;
  /** The node's case-read envelope, when the control plane issued it with the node's start. */
  caseReadEnvelope?: string;
}>;

export type V2FanoutBodyRequest = Readonly<{
  planDigest: string;
  nodeId: string;
  bodyRef: string;
  index: number;
  item: unknown;
  context: Readonly<Record<string, unknown>>;
  caseSnapshotId: string | null;
  caseSnapshotDigest: string | null;
}>;

export type V2ExecutionAdapters = {
  loadCaseSnapshot(request: V2SnapshotRequest, signal?: AbortSignal): Promise<unknown>;
  evaluateGate: GateEvaluator;
  executeFanoutBody?: (request: V2FanoutBodyRequest, signal: AbortSignal) => Promise<unknown>;
  executeSubgraph?: (request: V2SubgraphRequest, signal?: AbortSignal) => Promise<unknown>;
};

export type V2SubgraphRequest = Readonly<{
  planDigest: string;
  nodeId: string;
  ref: string;
  input: Readonly<Record<string, unknown>>;
  checkpointer: "inherit" | "perInvocation" | "perThread" | "stateless";
  caseSnapshotId: string | null;
  caseSnapshotDigest: string | null;
}>;

export type ApprovalDecision = Readonly<{
  decision: "APPROVE" | "REJECT";
  authority: "HUMAN";
  decisionId: string;
  principalId: string;
  decidedAt: string;
  reasonCode?: string;
}>;

/**
 * What the run itself can establish for a node's ContextEnvelope: tenant and case from the
 * run's root identity, subjects and as-of time from the admitted snapshot, the policy
 * snapshot the case is pinned to, and the executing workload as actor. Anything it cannot
 * establish is left out so the context plane reports it as a gap instead of a default.
 */
export function contextEnvelopeInputFor(
  rootInput: unknown,
  snapshot: CaseSnapshotV2 | null,
  runtime: { runId: string; workerId: string },
  nodeId: string,
): ContextEnvelopeInput {
  const root = rootInput && typeof rootInput === "object" && !Array.isArray(rootInput) ? rootInput as Record<string, unknown> : {};
  const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const subjects = Array.isArray((snapshot?.data as Record<string, unknown> | undefined)?.subjects)
    ? ((snapshot!.data as Record<string, unknown>).subjects as Array<Record<string, unknown>>) : [];
  const subjectRefs = [
    ...subjects.map((subject) => text(subject.subject_id) ?? text(subject.subjectId)).filter((id): id is string => Boolean(id)).map((id) => `subject:${id}`),
    ...(Array.isArray(root.subjectRefs) ? root.subjectRefs.map(text).filter((ref): ref is string => Boolean(ref)) : []),
  ];
  const firstSubjectCountry = text((subjects[0]?.attributes as Record<string, unknown> | undefined)?.country);
  const jurisdiction = text(root.jurisdiction) ?? firstSubjectCountry;
  const policySnapshotRef = text(snapshot?.policyAuthority?.policySnapshotDigest) ? `policy-snapshot:${snapshot!.policyAuthority!.policySnapshotDigest}` : text(root.policySnapshotRef);
  const asOfTime = text(root.asOfTime) ?? text(snapshot?.capturedAt);
  return {
    ...(text(root.tenantId) ?? text(snapshot?.tenantId) ? { tenantId: (text(root.tenantId) ?? text(snapshot?.tenantId))! } : {}),
    ...(text(root.caseId) ?? text(snapshot?.caseId) ? { caseId: (text(root.caseId) ?? text(snapshot?.caseId))! } : {}),
    ...(subjectRefs.length ? { subjectRefs: [...new Set(subjectRefs)] } : {}),
    ...(jurisdiction ? { jurisdiction } : {}),
    actor: `workload:runtime/${runtime.workerId}`,
    ...(policySnapshotRef ? { policySnapshotRef } : {}),
    ...(asOfTime ? { asOfTime } : {}),
    correlationId: `${runtime.runId}:${nodeId}`,
  };
}

/** The run's case, as the run was admitted with it (the context store checks the same field). */
function runCaseId(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const caseId = (input as Record<string, unknown>).caseId;
  return typeof caseId === "string" && caseId.trim() ? caseId : null;
}

function rootCaseIdentity(input: unknown): { tenantId: string; caseId: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("runtime.v2.case_identity_missing");
  const record = input as Record<string, unknown>;
  const tenantId = typeof record.tenantId === "string" ? record.tenantId.trim() : "";
  const caseId = typeof record.caseId === "string" ? record.caseId.trim() : "";
  if (!tenantId || !caseId) throw new Error("runtime.v2.case_identity_missing");
  return { tenantId, caseId };
}

function validateApprovalDecision(value: unknown): ApprovalDecision {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("runtime.v2.approval_decision_invalid");
  const decision = value as Record<string, unknown>;
  if (
    (decision.decision !== "APPROVE" && decision.decision !== "REJECT")
    || decision.authority !== "HUMAN"
    || typeof decision.decisionId !== "string" || !decision.decisionId
    || typeof decision.principalId !== "string" || !decision.principalId
    || typeof decision.decidedAt !== "string" || !decision.decidedAt
    || (decision.reasonCode !== undefined && (typeof decision.reasonCode !== "string" || !decision.reasonCode))
  ) throw new Error("runtime.v2.approval_decision_invalid");
  if (Number.isNaN(Date.parse(decision.decidedAt))) throw new Error("runtime.v2.approval_decision_invalid");
  return Object.freeze({
    decision: decision.decision,
    authority: "HUMAN",
    decisionId: decision.decisionId,
    principalId: decision.principalId,
    decidedAt: decision.decidedAt,
    ...(typeof decision.reasonCode === "string" ? { reasonCode: decision.reasonCode } : {}),
  });
}

function v2NodeInput(plan: HarnessPlanV2, executionEdges: HarnessPlanV2["graph"]["edges"], nodeId: string, state: HarnessState): unknown {
  const target = plan.graph.nodes.find((node) => node.id === nodeId);
  const allIncoming = executionEdges.filter((edge) => edge.to === nodeId);
  const incoming = executionEdges.filter((edge) => edge.to === nodeId && edge.kind !== "control");
  if (!incoming.length) {
    if (allIncoming.length === 1) return state.values[allIncoming[0]!.from];
    return state.input;
  }
  if (target?.kind === "join" && joinMode(target) === "allSettled") {
    return Object.fromEntries(incoming.map((edge) => [
      edge.targetPath?.replace(/^\//, "") || edge.from,
      state.settlements[edge.from] ?? { status: "fulfilled", value: getPath(state.values[edge.from], edge.sourcePath) },
    ]));
  }
  if (incoming.length === 1) {
    const edge = incoming[0]!;
    return getPath(state.values[edge.from], edge.sourcePath);
  }
  return Object.fromEntries(incoming.map((edge) => [
    edge.targetPath?.replace(/^\//, "") || edge.from,
    getPath(state.values[edge.from], edge.sourcePath),
  ]));
}

function v2Route(plan: HarnessPlanV2, executionEdges: HarnessPlanV2["graph"]["edges"], nodeId: string, state: HarnessState): string {
  const edges = executionEdges.filter((edge) => edge.from === nodeId && (edge.kind === "control" || edge.outcome !== undefined));
  const node = plan.graph.nodes.find((candidate) => candidate.id === nodeId);
  const value = state.values[nodeId];
  const typedState = node?.config.businessDecision === "v2" && value && typeof value === "object"
    ? (value as { result?: { state?: string } }).result?.state : undefined;
  const outcome = typedState ?? (value && typeof value === "object" && typeof (value as Record<string, unknown>).outcome === "string"
    ? String((value as Record<string, unknown>).outcome)
    : undefined);
  const expression = typeof node?.config.expression === "string" ? node.config.expression : undefined;
  const routedValue = expression ? getPath({ ...state, ...state.values }, expression) : undefined;
  return edges.find((edge) =>
    (edge.outcome !== undefined && edge.outcome === outcome)
    || (edge.condition !== undefined && (edge.condition === String(routedValue)
      || evaluateCondition(edge.condition, { ...state, ...state.values }))))?.to ?? END;
}

function objectRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function setJsonPointer(target: Record<string, unknown>, pointer: string, value: unknown): void {
  const parts = pointer.split("/").slice(1).map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  if (!parts.length) throw new Error("runtime.v2.subgraph_output_pointer_root_unsupported");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    const existing = current[part];
    if (!existing || typeof existing !== "object" || Array.isArray(existing)) current[part] = {};
    current = current[part] as Record<string, unknown>;
  }
  current[parts.at(-1)!] = structuredClone(value);
}

function signalFromConfig(config: unknown): AbortSignal | undefined {
  if (!config || typeof config !== "object") return undefined;
  const signal = (config as { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}

/**
 * Lower an admitted v2 plan into the local conformance kernel. Every plan uses this
 * exact lowering in tests; production dispatch may execute it on a hosted runtime, but does not
 * get a different interpretation of gates, fanout bounds or suspension.
 */
export function lowerHarnessPlanV2(
  rawPlan: HarnessPlanV2,
  context: RuntimeContext,
  adapters: V2ExecutionAdapters,
  checkpointer?: unknown,
  executionNodeId?: string,
) {
  const plan = admitHarnessPlanV2(rawPlan);
  if (context.plan.planDigest !== plan.planDigest) throw new Error("runtime.v2.context_plan_mismatch");
  if (!executionNodeId && plan.graph.nodes.some((node) => node.kind === "approval") && !checkpointer) {
    throw new Error("runtime.v2.approval_checkpointer_required");
  }
  const graph: any = new StateGraph(stateSchema);
  const nodes = new Map(plan.graph.nodes.map((node) => [node.id, node]));
  const executionEdges = v2ExecutionEdges(plan);
  if (executionNodeId && (!nodes.has(executionNodeId) || nodes.get(executionNodeId)?.kind === "approval")) {
    throw new Error("runtime.v2.node_execution_invalid");
  }
  // Ladder identifiers may legitimately be named "input", "output" or "values",
  // which are state-channel names. Keep adapter node names in a separate namespace.
  const graphNodeId = (nodeId: string): string => `__harness_v2__${nodeId}`;
  const allSettledJoins = new Set(plan.graph.nodes
    .filter((node) => node.kind === "join" && String(node.config.mode ?? node.config.operation ?? "all") === "allSettled")
    .map((node) => node.id));
  const settledSourceIds = new Set(executionEdges
    .filter((edge) => allSettledJoins.has(edge.to) && edge.kind !== "control")
    .map((edge) => edge.from));

  const snapshotFor = async (nodeId: string, state: HarnessState, signal?: AbortSignal): Promise<CaseSnapshotV2> => {
    const node = nodes.get(nodeId);
    if (!node) throw new Error(`runtime.v2.node_missing:${nodeId}`);
    const identity = rootCaseIdentity(state.input);
    const selectorById = new Map(plan.contextSelectors.map((selector) => [selector.id, selector]));
    const purposes = [...new Set(node.contextSelectorIds.map((id) => selectorById.get(id)?.purpose)
      .filter((purpose): purpose is string => Boolean(purpose)))].sort();
    const snapshot = admitCaseSnapshotV2(await adapters.loadCaseSnapshot(Object.freeze({
      ...identity,
      planDigest: plan.planDigest,
      nodeId,
      selectorIds: Object.freeze([...node.contextSelectorIds]),
      purposes: Object.freeze(purposes),
    }), signal));
    if (snapshot.tenantId !== identity.tenantId || snapshot.caseId !== identity.caseId) {
      throw new Error("runtime.v2.snapshot_case_identity_mismatch");
    }
    await authorizeSourceEvidenceSelection(context, nodeId, selectV2CaseContext(plan, nodeId, snapshot));
    return snapshot;
  };

  for (const node of plan.graph.nodes) {
    if (executionNodeId && node.id !== executionNodeId) continue;
    graph.addNode(graphNodeId(node.id), async (state: HarnessState, runnableConfig: unknown) => {
      const signal = signalFromConfig(runnableConfig);
      if (signal?.aborted) throw new Error("runtime.cancelled");
      await context.draftTest?.beforeNode?.(node.id, node.kind);

      if (node.kind === "approval") {
        const snapshot = node.contextSelectorIds.length ? await snapshotFor(node.id, state, signal) : null;
        const contextSelection = snapshot ? selectV2CaseContext(plan, node.id, snapshot) : {};
        const request = Object.freeze({
          type: "harness.approval.v2",
          runId: context.runId,
          nodeId: node.id,
          planDigest: plan.planDigest,
          requestDigest: stableDigest({ nodeId: node.id, config: node.config, context: contextSelection }),
          caseSnapshotId: snapshot?.snapshotId ?? null,
          caseSnapshotDigest: snapshot?.snapshotDigest ?? null,
        });
        await context.state.appendEvent({
          runId: context.runId, attempt: context.runAttempt, workerId: context.workerId, fencingEpoch: context.fencingEpoch,
        }, {
          eventKey: `approval:${node.id}:${context.runAttempt}:suspended`,
          code: "approval.suspended", nodeId: node.id, status: "observed", values: { requestDigest: request.requestDigest },
        });
        const decision = validateApprovalDecision(interrupt(request));
        return { values: { [node.id]: decision } };
      }

      try {
        const snapshot = node.contextSelectorIds.length ? await snapshotFor(node.id, state, signal) : null;
        const authorityInput = snapshot ? selectV2CaseContext(plan, node.id, snapshot) : undefined;
        const input = authorityInput && node.config.usePredecessorInput !== true
          ? authorityInput
          : v2NodeInput(plan, executionEdges, node.id, state);
        if (input !== authorityInput) await authorizeSourceEvidenceSelection(context, node.id, input);
        const update = await executeObservedNode(context, node.id, input, async () => {
          let value: unknown;
          const observe = sandboxObservationSink(context, state.input);
          const captureSkill = async (observation: Parameters<typeof sandboxSkillObservation>[0]) => {
            const safe = sandboxSkillObservation(observation);
            if (safe) await observe?.(safe);
          };
          // The pack the model's answer came from, when this node shows a model context;
          // the node's case writes cite it (data-stores-plan.md §3.3).
          let shownPack: ContextPack | undefined;
          if (node.kind === "input") {
            value = plan.metadata.domain === "discovery" ? discoveryRunInputSchema.parse(state.input) : state.input;
          }
          else if (node.kind === "output") {
            if(node.config.requireFinalDisposition===true) {
              const decision=businessDecisionSchema.parse(input);
              const actions=decision.result.actions;
              const index=actions.findIndex(action=>action.kind==="case_command" && action.commandType==="FinalizeDisposition");
              const dispositions=authorityInput?.finalDispositions;
              if(index<0 || !Array.isArray(dispositions) || !dispositions.some(row=>row.gate_result_ref===`${decision.decisionId}:${index}`))
                throw new Error("runtime.business_disposition_not_applied");
            }
            value = plan.metadata.domain === "discovery" && node.id === "advisory-output"
              ? validateDiscoveryAdvisoryOutput(input) : input;
          }
          else if (["agent", "tool", "evaluate"].includes(node.kind)) {
            let capabilityInput: unknown = node.prompt
              ? { input, prompt: renderTemplate(node.prompt, { input }) }
              : input;
            if (node.config.subjectAcquisition !== undefined) {
              if (!authorityInput || node.config.skillId || node.kind !== "tool") throw new Error("runtime.subject_scope_authority_invalid");
              value = await acquireSubjects(node.config.subjectAcquisition, authorityInput, async (subject, index) => {
                const result = await invokeCapability(context, node.id, subject, { step: index });
                if (result.status !== "succeeded") throw new Error(result.errorCode ?? "runtime.subject_acquisition_failed");
                return result.output;
              });
            }
            // Agent reasoning nodes receive context only through the context plane: the
            // compiled agent prompt and skills, the task, and trust-labelled,
            // provenance-bearing sections from the purpose-bound snapshot selection.
            if (nodeShowsModelContext(node)) {
              const pack = assembleContextPack({
                plan,
                nodeId: node.id,
                runId: context.runId,
                ...(authorityInput ? { selection: authorityInput } : {}),
                snapshot,
                ...(input !== authorityInput ? { upstream: input } : {}),
                ...(agentSkillResults(node, state.values) ?? {}),
                task: node.prompt ? renderTemplate(node.prompt, { input }) : null,
                envelope: contextEnvelopeInputFor(state.input, snapshot, context, node.id),
              });
              await context.state.appendEvent({
                runId: context.runId, attempt: context.runAttempt, workerId: context.workerId, fencingEpoch: context.fencingEpoch,
              }, {
                eventKey: `context:${node.id}:${context.runAttempt}:${pack.packDigest.slice(0, 16)}`,
                code: pack.signals.length ? "context.resolved_with_quarantine" : "context.resolved",
                nodeId: node.id, status: "observed", values: contextPackSummary(pack),
              });
              const fence = { runId: context.runId, attempt: context.runAttempt, workerId: context.workerId, fencingEpoch: context.fencingEpoch };
              // What the model is about to see goes to the context store first; a pack that
              // cannot be recorded is not shown, so no model output exists without its context.
              const recordPack = (shown: typeof pack) => context.state.recordContextPack?.(fence, {
                caseId: runCaseId(state.input), nodeId: node.id, pack: shown as unknown as Record<string, unknown>,
              }) ?? Promise.resolve();
              await recordPack(pack);
              shownPack = pack;
              if (loopConfigFor(plan, node.id)) {
                const loopEnvelope = contextEnvelopeInputFor(state.input, snapshot, context, node.id);
                const loop = await runAgentLoop({
                  plan, nodeId: node.id, pack, recordPack,
                  ...(signal ? { signal } : {}),
                  invoke: (capabilityId, loopInput, step) => invokeCapability(context, node.id, loopInput, {
                    ...(capabilityId ? { capabilityId } : {}), step,
                    jurisdiction: loopEnvelope.jurisdiction ?? null,
                  }),
                  // A loop skill gets the same input a skill node would: its own selectors' records,
                  // the case's pinned policy projected to its fields, and the context envelope. The
                  // model supplied only the parameters. The result is an observation; a loop skill is
                  // read-only (harnessc), so nothing is committed.
                  invokeSkill: async (skillId, parameters, step) => {
                    const entry = loopSkillForNode(plan, node.id, skillId);
                    const skillPlan = skillPlanForNode(plan, node.id, skillId);
                    const candidate = skillPlan?.permitted[0];
                    if (!entry || !candidate) return { status: "failed", errorCode: "runtime.loop_skill_not_permitted" };
                    const skillPack = assembleContextPack({
                      plan, nodeId: node.id, runId: context.runId,
                      ...(authorityInput ? { selection: authorityInput } : {}),
                      snapshot, envelope: loopEnvelope,
                      loopSkill: { skillId, contextSelectorIds: entry.contextSelectorIds },
                    });
                    await recordPack(skillPack);
                    const entryPolicy = chooseSkillPolicy(entry.skillPolicy, entry.skillPolicies, snapshot?.policyAuthority);
                    const policy = entryPolicy === undefined ? undefined : resolveSkillPolicySection({
                      config: entryPolicy,
                      authority: snapshot?.policyAuthority,
                      selection: authorityInput ?? {},
                      purpose: plan.contextSelectors.find((selector) => entry.contextSelectorIds.includes(selector.id))?.purpose ?? "workflow.skill",
                      ...(loopEnvelope.asOfTime ? { asOfTime: loopEnvelope.asOfTime } : {}),
                    });
                    const key = `${context.runId}:${node.id}:${context.runAttempt}:loop:${step}:${skillId}`;
                    const built = buildSkillCapabilityInput(skillPack, {
                      executionId: skillExecutionId(key), parameters, purpose: entry.purpose,
                      idempotencyKey: key, traceId: context.runId, ...(policy ? { policy } : {}),
                    });
                    if (built.status === "blocked") {
                      if (observe) await captureSkill({ nodeId: node.id, skillId, skillVersion: skillPlan.binding.semver, step,
                        status: "NEEDS_EVIDENCE", contextHash: skillPack.contextHash, output: { status: "NEEDS_EVIDENCE", code: built.code, recordGaps: built.recordGaps,
                          policyGaps: built.policyGaps, parameterGaps: built.parameterGaps } });
                      await context.state.appendEvent(fence, {
                        eventKey: `loop-skill:${node.id}:${context.runAttempt}:${step}`, code: "skill.loop.needs_evidence", nodeId: node.id, status: "observed",
                        values: { skillId, code: built.code, skillCalled: false },
                      });
                      return { status: "blocked", errorCode: built.code, output: {
                        status: "NEEDS_EVIDENCE", code: built.code, explanation: built.explanation,
                        recordGaps: built.recordGaps.map((gap) => ({ objectType: gap.objectType, code: gap.code, required: gap.required })),
                        policyGaps: built.policyGaps, parameterGaps: built.parameterGaps,
                      } };
                    }
                    let result: Awaited<ReturnType<typeof invokeCapability>>;
                    try {
                      result = await invokeCapability(context, node.id, built.input, {
                        capabilityId: candidate.capabilityId, step, skillId, jurisdiction: loopEnvelope.jurisdiction ?? null,
                      });
                    } catch (error) {
                      if (observe) await captureSkill({ nodeId: node.id, skillId, skillVersion: skillPlan.binding.semver, step,
                        status: "FAILED", contextHash: skillPack.contextHash, input: built.input });
                      return { status: "failed", errorCode: error instanceof Error ? error.message : "skill.failed" };
                    }
                    const hostedOutput = result.status === "succeeded" ? skillCapabilityOutput(result) : null;
                    const computation = hostedOutput?.computation ?? null;
                    if (observe) await captureSkill({ nodeId: node.id, skillId, skillVersion: skillPlan.binding.semver, step,
                      status: computation?.business_status ?? (result.status === "succeeded" ? "COMPLETED" : "FAILED"),
                      contextHash: skillPack.contextHash, invocationId: result.invocationId, resultDigest: result.receiptDigest,
                      input: built.input, output: computation?.payload ?? result.output });
                    await context.state.appendEvent(fence, {
                      eventKey: `loop-skill:${node.id}:${context.runAttempt}:${step}`,
                      code: `skill.loop.${(computation?.business_status ?? (result.status === "succeeded" ? "completed" : "failed")).toLowerCase()}`,
                      nodeId: node.id, status: result.status === "succeeded" ? "observed" : "failed",
                      values: { skillId, receiptDigest: result.receiptDigest ?? null, outputDigest: hostedOutput ? stableDigest(hostedOutput) : null },
                    });
                    if (result.status !== "succeeded") return { status: "failed", errorCode: result.errorCode ?? "skill.failed", receiptDigest: result.receiptDigest ?? null };
                    return {
                      status: "succeeded", receiptDigest: result.receiptDigest ?? null,
                      output: {
                        skill: skillId, lifecycle: hostedOutput?.lifecycle ?? null,
                        businessStatus: computation?.business_status ?? null,
                        payload: computation?.payload ?? null,
                        unresolved: (computation as { unresolved_items?: unknown } | null)?.unresolved_items ?? [],
                      },
                    };
                  },
                  record: (entry) => context.state.appendEvent(fence, {
                    eventKey: `agent-step:${node.id}:${context.runAttempt}:${entry.step}:${entry.action}`,
                    code: `agent.step.${entry.action}`,
                    nodeId: node.id,
                    status: entry.status === "succeeded" || entry.status === "accepted" ? "passed" : entry.status === "refused" ? "denied" : "observed",
                    values: { ...entry },
                  }),
                });
                value = loop.output;
                shownPack = loop.finalPack;
                // Task completion is the runtime's judgment over the agent's skill nodes, never the
                // model's: the agent can raise the outcome to NEEDS_REVIEW, it cannot lower it.
                if (node.config.completion !== undefined) {
                  const completion = evaluateTaskCompletion(agentTaskCompletionSchema.parse(node.config.completion), state.values, loop.output);
                  await context.state.appendEvent(fence, {
                    eventKey: `task:${node.id}:${context.runAttempt}`, code: `agent.task.${completion.status.toLowerCase()}`, nodeId: node.id,
                    status: completion.status === "COMPLETED" ? "passed" : completion.status === "BLOCKED" ? "denied" : "observed",
                    values: { status: completion.status, criteria: completion.criteria, reasons: completion.reasons },
                  });
                  value = { ...loop.output, __taskCompletion: completion };
                }
              } else {
                capabilityInput = {
                  input,
                  prompt: renderContextPrompt(pack),
                  contextPackDigest: pack.packDigest,
                  contextManifestDigest: pack.manifest?.manifestDigest ?? null,
                };
              }
            }
            // A skill served by the skill host gets SkillCapabilityInput.v1 assembled by the
            // context plane, including canonical-record sections. When required records are
            // missing or stale the skill is not called: the node answers NEEDS_EVIDENCE.
            const hosted = value === undefined ? hostedSkillCandidate(plan, node.id) : null;
            if (hosted) {
              const envelopeInput = contextEnvelopeInputFor(state.input, snapshot, context, node.id);
              const executionId = skillExecutionId(`${context.runId}:${node.id}:${context.runAttempt}`);
              const { pack, built, policy } = prepareSkillContext({
                plan, nodeId: node.id, runId: context.runId,
                ...(authorityInput ? { selection: authorityInput } : {}), snapshot, envelope: envelopeInput,
                executionId, idempotencyKey: `${context.runId}:${node.id}:${context.runAttempt}`,
                traceId: context.runId, predecessors: state.values,
              });
              const fence = { runId: context.runId, attempt: context.runAttempt, workerId: context.workerId, fencingEpoch: context.fencingEpoch };
              await context.state.appendEvent(fence, {
                eventKey: `context:${node.id}:${context.runAttempt}:${pack.packDigest.slice(0, 16)}`,
                code: "context.resolved", nodeId: node.id, status: "observed",
                values: { ...contextPackSummary(pack), recordGaps: (pack.recordGaps ?? []).map((gap) => ({ selector: gap.selector, objectType: gap.objectType, code: gap.code, required: gap.required })) },
              });
              await context.state.recordContextPack?.(fence, { caseId: runCaseId(state.input), nodeId: node.id, pack: pack as unknown as Record<string, unknown> });
              if (built.status === "blocked") {
                const skillResult = contextGapSkillResult({
                  skillId: hosted.binding.skillId, skillVersion: hosted.binding.semver, executionId, code: built.code,
                  recordGaps: built.recordGaps, envelopeGaps: built.envelopeGaps, policyGaps: built.policyGaps, parameterGaps: built.parameterGaps,
                  ...(policy?.status === "unresolved" ? { policyExplanation: policy.explanation } : {}),
                  explanation: built.explanation,
                  ...(envelopeInput.subjectRefs?.[0] ? { subjectRef: envelopeInput.subjectRefs[0] } : {}),
                  policySnapshotRef: envelopeInput.policySnapshotRef ?? `plan:${plan.planDigest}`,
                  contextHash: pack.contextHash, traceRef: `run:${context.runId}/node:${node.id}/attempt:${context.runAttempt}`,
                });
                await context.state.appendEvent(fence, {
                  eventKey: `skill:${node.id}:${context.runAttempt}`,
                  code: "skill.result.needs_evidence", nodeId: node.id, status: "observed",
                  values: {
                    skillId: skillResult.skill_id, skillVersion: skillResult.skill_version, status: skillResult.status,
                    errorCode: skillResult.error?.code ?? null, unresolvedCodes: skillResult.unresolved_items.map((item) => item.code),
                    resultDigest: stableDigest(skillResult), contextHash: skillResult.context_hash, skillCalled: false,
                  },
                });
                value = { status: "NEEDS_EVIDENCE", skillId: skillResult.skill_id, skillVersion: skillResult.skill_version, code: built.code,
                  recordGaps: built.recordGaps, envelopeGaps: built.envelopeGaps, policyGaps: built.policyGaps, parameterGaps: built.parameterGaps, skillResult };
                if (observe) await captureSkill({ nodeId: node.id, skillId: skillResult.skill_id, skillVersion: skillResult.skill_version,
                  status: skillResult.status, contextHash: pack.contextHash, resultDigest: stableDigest(skillResult),
                  output: { status: skillResult.status, code: built.code, recordGaps: built.recordGaps, envelopeGaps: built.envelopeGaps,
                    policyGaps: built.policyGaps, parameterGaps: built.parameterGaps } });
              } else {
                capabilityInput = built.input;
              }
            }
            if (value === undefined) {
              const skill = skillPlanForNode(plan, node.id);
              // The subject jurisdiction selects among pinned candidates: the gateway refuses
              // a connector the operator has not attested for it, and the runtime moves on.
              const envelope = contextEnvelopeInputFor(state.input, snapshot, context, node.id);
              const started = Date.now();
              let result: Awaited<ReturnType<typeof invokeCapability>> | undefined;
              let failure: unknown;
              let skillCommit: SkillCommitReceipt | null = null;
              try {
                result = await invokeCapability(context, node.id, capabilityInput, skill ? { jurisdiction: envelope.jurisdiction ?? null } : {});
              } catch (error) { failure = error; }
              if (skill) {
                // A skill-bound node always produces SkillResult.v1, including when the
                // implementation failed. It is journalled with digests and codes only; the
                // node output stays the implementation's payload for case writes and gates.
                // A skill served by the skill host returns its own validated computation;
                // its business status is authoritative. Anything else is mapped generically.
                const hosted = result && result.status === "succeeded" ? skillCapabilityOutput(result) : null;
                // What the skill proposed or requested becomes case state only here, through the
                // case API with this node's envelope, before SkillResult.v1 cites it (§3 step 5).
                if (!context.draftTest && hosted && hosted.lifecycle === "COMPLETED_EXECUTION" && hosted.computation
                  && hosted.computation.business_status !== "BLOCKED" && hosted.computation.business_status !== "FAILED") {
                  try {
                    const contextHash = String((capabilityInput as { context?: { context_hash?: unknown } })?.context?.context_hash ?? snapshot?.snapshotDigest ?? "");
                    skillCommit = await commitSkillComputation(context, node.id, {
                      result: result!, output: hosted, capabilityInput, contextHash, rootInput: state.input, snapshot,
                    });
                  } catch (error) {
                    if (observe) await captureSkill({ nodeId: node.id, skillId: skill.binding.skillId, skillVersion: skill.binding.semver,
                      status: "FAILED", contextHash: snapshot?.snapshotDigest ?? null, invocationId: result?.invocationId ?? null,
                      resultDigest: result?.receiptDigest ?? null, input: capabilityInput, output: hosted.computation.payload });
                    await context.state.appendEvent({
                      runId: context.runId, attempt: context.runAttempt, workerId: context.workerId, fencingEpoch: context.fencingEpoch,
                    }, {
                      eventKey: `skill-commit:${node.id}:${context.runAttempt}`, code: "skill.commit.failed", nodeId: node.id, status: "failed",
                      values: { executionId: hosted.execution_id, errorCode: error instanceof Error ? error.message : "skill.commit_failed" },
                    });
                    throw error;
                  }
                }
                const committedRefs = skillCommit ? {
                  findings: skillCommit.committed.flatMap((item) => item.createdIdentifiers.findingId ? [`finding:${item.createdIdentifiers.findingId}`] : []),
                  evidence: skillCommit.evidenceId ? [`evidence:${skillCommit.evidenceId}`] : [],
                } : undefined;
                const skillResult = hosted ? skillResultFromExecution({
                  ...(committedRefs ? { committedRefs } : {}),
                  result: result!,
                  executionId: skillExecutionId(`${context.runId}:${node.id}:${context.runAttempt}`),
                  policySnapshotRef: envelope.policySnapshotRef ?? `plan:${plan.planDigest}`,
                  contextHash: snapshot?.snapshotDigest ?? stableDigest({ input: capabilityInput }),
                  traceRef: `run:${context.runId}/node:${node.id}/attempt:${context.runAttempt}`,
                  ...(envelope.subjectRefs?.[0] ? { subjectRef: envelope.subjectRefs[0] } : {}),
                }) : toSkillResult({
                  skillId: skill.binding.skillId,
                  skillVersion: skill.binding.semver,
                  outcome: result ? { result } : { error: failure },
                  executionId: skillExecutionId(`${context.runId}:${node.id}:${context.runAttempt}`),
                  ...(envelope.subjectRefs?.[0] ? { subjectRef: envelope.subjectRefs[0] } : {}),
                  policySnapshotRef: envelope.policySnapshotRef ?? `plan:${plan.planDigest}`,
                  contextHash: snapshot?.snapshotDigest ?? stableDigest({ input: capabilityInput }),
                  traceRef: `run:${context.runId}/node:${node.id}/attempt:${context.runAttempt}`,
                  durationMs: Date.now() - started,
                  providerCalls: result ? 1 : 0,
                });
                await context.state.appendEvent({
                  runId: context.runId, attempt: context.runAttempt, workerId: context.workerId, fencingEpoch: context.fencingEpoch,
                }, {
                  eventKey: `skill:${node.id}:${context.runAttempt}`,
                  code: `skill.result.${skillResult.status.toLowerCase()}`,
                  nodeId: node.id,
                  status: skillResult.status === "COMPLETED" ? "passed" : skillResult.status === "BLOCKED" ? "denied" : skillResult.status === "FAILED" ? "failed" : "observed",
                  values: {
                    skillId: skillResult.skill_id, skillVersion: skillResult.skill_version, status: skillResult.status,
                    errorCode: skillResult.error?.code ?? null, unresolvedCodes: skillResult.unresolved_items.map((item) => item.code),
                    resultDigest: stableDigest(skillResult), contextHash: skillResult.context_hash,
                  },
                });
                if (observe) await captureSkill({ nodeId: node.id, skillId: skillResult.skill_id, skillVersion: skillResult.skill_version,
                  status: skillResult.status, contextHash: skillResult.context_hash, invocationId: result?.invocationId ?? null,
                  resultDigest: stableDigest(skillResult), input: capabilityInput, output: hosted?.computation?.payload ?? result?.output });
                // BLOCKED (access, policy or context) is a control outcome, not a business
                // finding: the node fails closed rather than handing a payload downstream.
                if (skillResult.status === "BLOCKED") throw new Error(`skill.blocked:${skillResult.error?.code ?? "UNKNOWN"}`);
              }
              if (failure) throw failure;
              if (result!.status !== "succeeded") throw new Error(result!.errorCode ?? "runtime.capability_failed");
              if (observe && result!.capabilityId === "document.evidence.package.v1") {
                const documents = sandboxDocumentsObservation(node.id, result!);
                if (documents) await observe(documents);
              }
              value = skillCommit && result!.output && typeof result!.output === "object" && !Array.isArray(result!.output)
                ? { ...(result!.output as Record<string, unknown>), __skillCommit: skillCommit }
                : result!.output;
            }
          } else if (node.kind === "transform") {
            value = transformValue(node.config, input);
            if (node.config.bankingAssessment !== undefined) {
              if (!authorityInput) throw new Error("runtime.banking_context_missing");
              const records = authorityInput.bankingRelationships as Array<{ data: unknown }> | undefined;
              const controls = authorityInput.bankingControls as Array<{ data: unknown }> | undefined;
              if (records?.length !== 1) value = { outcome: "REVIEW", gaps: ["BANKING_RELATIONSHIP_UNRESOLVED"] };
              else {
                const relationship = bankingRelationshipSchema.parse(records[0]!.data);
                // Context time is supplied by the canonical snapshot, never the record's author.
                relationship.asOf = snapshot!.capturedAt;
                const assessment = await assessBankingRelationshipWithOpa(relationship, bankingPolicySchema.parse(node.config.bankingAssessment), (controls ?? []).map((r) => r.data));
                value = { ...assessment, outcome: assessment.products.every((p) => p.recommendation === "READY_FOR_AUTHORIZED_DECISION") ? "ALLOW" : "REVIEW" };
              }
            }
            // A policy-pack checkpoint: the case's pinned pack over its canonical records (pack-gate.ts).
            if (node.config.packGate !== undefined) {
              if (!authorityInput || !snapshot) throw new Error("runtime.pack_gate_context_missing");
              value = evaluatePackCheckpoint(node.config.packGate as PackGateConfig, authorityInput, snapshot);
            }
            // The release node after a durable approval commits or discards the skill's held effects.
            if (node.config.skillEffectRelease !== undefined) {
              if (context.draftTest) throw new Error("draft_test.effect_release_requires_live_run");
              const released = await releaseHeldSkillEffects(context, node.id, state.input, state.values);
              const base = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
              value = { ...base, decision: released.decision, __skillEffects: released };
            }
          }
          else if (node.kind === "aggregator") value = aggregateValue(node.config, input);
          else if (node.kind === "condition" || node.kind === "join") value = input;
          else if (node.kind === "gate") {
            if (!snapshot) throw new Error("runtime.v2.gate_snapshot_missing");
            value = await executePolicyGate(plan, node.id, snapshot, adapters.evaluateGate, signal);
          } else if (node.kind === "fanout") {
            const items = getPath(input, String(node.config.itemsPath));
            if (!Array.isArray(items)) throw new Error("runtime.v2.fanout_items_array_required");
            const bodyRef = String(node.config.bodyRef);
            value = await executeBoundedFanout({
              items,
              maxItems: Number(node.config.maxItems),
              maxConcurrency: Number(node.config.maxConcurrency),
              joinMode: String(node.config.joinMode) as FanoutJoinMode,
              ...(signal ? { signal } : {}),
              execute: async (item, index, itemSignal) => {
                const request = Object.freeze({
                planDigest: plan.planDigest,
                nodeId: node.id,
                bodyRef,
                index,
                item: structuredClone(item),
                context: authorityInput ?? Object.freeze({}),
                caseSnapshotId: snapshot?.snapshotId ?? null,
                caseSnapshotDigest: snapshot?.snapshotDigest ?? null,
                });
                if (adapters.executeFanoutBody) return adapters.executeFanoutBody(request, itemSignal);
                const result = await invokeCapability(context, node.id, request);
                if (result.status !== "succeeded") throw new Error(result.errorCode ?? "runtime.fanout_body_failed");
                return result.output;
              },
            });
          } else if (node.kind === "group") {
            const members = (node.config.members as unknown[]).map(String);
            value = node.config.exit === "aggregate"
              ? Object.fromEntries(members.map((member) => [member, structuredClone(state.values[member])]))
              : members.map((member) => ({ memberId: member, value: structuredClone(state.values[member]) }));
          } else if (node.kind === "subgraph") {
            const contract = objectRecord(node.config.subgraph, `runtime.v2.subgraph_contract_required:${node.id}`);
            const inputMap = objectRecord(contract.inputMap, `runtime.v2.subgraph_inputMap_invalid:${node.id}`);
            const outputMap = objectRecord(contract.outputMap, `runtime.v2.subgraph_outputMap_invalid:${node.id}`);
            const parentState = { input: state.input, nodeInput: input, values: state.values };
            const childInput = Object.freeze(Object.fromEntries(Object.entries(inputMap)
              .map(([childKey, pointer]) => [childKey, structuredClone(getPath(parentState, String(pointer)))])));
            const request: V2SubgraphRequest = Object.freeze({
              planDigest: plan.planDigest,
              nodeId: node.id,
              ref: String(contract.ref),
              input: childInput,
              checkpointer: String(contract.checkpointer) as V2SubgraphRequest["checkpointer"],
              caseSnapshotId: snapshot?.snapshotId ?? null,
              caseSnapshotDigest: snapshot?.snapshotDigest ?? null,
            });
            let childOutput: unknown;
            if (adapters.executeSubgraph) childOutput = await adapters.executeSubgraph(request, signal);
            else {
              const result = await invokeCapability(context, node.id, request);
              if (result.status !== "succeeded") throw new Error(result.errorCode ?? "runtime.subgraph_failed");
              childOutput = result.output;
            }
            const childRecord = objectRecord(childOutput, "runtime.v2.subgraph_output_invalid");
            const mapped: Record<string, unknown> = {};
            for (const [childKey, pointer] of Object.entries(outputMap)) {
              setJsonPointer(mapped, String(pointer), childRecord[childKey]);
            }
            value = mapped;
          } else throw new Error(`runtime.v2.node_kind_unsupported:${node.kind}`);
          const caseWriteReceipt = await executeCaseWrites(
            context,
            node.id,
            state.input,
            input,
            value,
            state.values,
            snapshot ?? undefined,
            shownPack,
          );
          if (caseWriteReceipt) {
            value = value && typeof value === "object" && !Array.isArray(value)
              ? { ...(value as Record<string, unknown>), __caseWrite: caseWriteReceipt }
              : { value, __caseWrite: caseWriteReceipt };
          }
          return { values: { [node.id]: value }, ...(node.kind === "output" || executionNodeId ? { output: value } : {}) };
        });
        return settledSourceIds.has(node.id)
          ? { ...update, settlements: { [node.id]: { status: "fulfilled", value: update.values[node.id] } satisfies SettledResult } }
          : update;
      } catch (error) {
        context.draftTest?.failed?.(node.id, error);
        if (isGraphInterrupt(error) || !settledSourceIds.has(node.id)) throw error;
        const code = error instanceof Error ? error.message : "runtime.node_failed";
        return { settlements: { [node.id]: { status: "rejected", reason: { code, message: code } } satisfies SettledResult } };
      }
    });
  }

  if (executionNodeId) {
    graph.addEdge(START, graphNodeId(executionNodeId));
    graph.addEdge(graphNodeId(executionNodeId), END);
    return graph.compile();
  }
  const incomingCount = new Map(plan.graph.nodes.map((node) => [node.id, 0]));
  for (const edge of executionEdges) incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
  const starts = plan.graph.nodeOrder.filter((id) => incomingCount.get(id) === 0);
  if (!starts.length) throw new Error("runtime.v2.entry_required");
  for (const start of starts) graph.addEdge(START, graphNodeId(start));

  const barrierTargets = new Set<string>();
  for (const barrier of plan.graph.nodes.filter((node) => node.kind === "join" || node.kind === "group")) {
    const sources = executionEdges.filter((edge) => edge.to === barrier.id && edge.kind !== "control").map((edge) => edge.from);
    if (sources.length > 1) {
      graph.addEdge(sources.map(graphNodeId), graphNodeId(barrier.id));
      barrierTargets.add(barrier.id);
    }
  }
  for (const node of plan.graph.nodes) {
    const outgoing = executionEdges.filter((edge) => edge.from === node.id);
    const routes = outgoing.filter((edge) => edge.kind === "control" || edge.outcome !== undefined);
    if (routes.length) {
      graph.addConditionalEdges(graphNodeId(node.id), (state: HarnessState) => {
        const target = v2Route(plan, executionEdges, node.id, state);
        return target === END ? END : graphNodeId(target);
      }, Object.fromEntries(routes.map((edge) => [graphNodeId(edge.to), graphNodeId(edge.to)])));
    } else if (!outgoing.length || node.kind === "output") graph.addEdge(graphNodeId(node.id), END);
    else {
      for (const edge of outgoing) {
        if (barrierTargets.has(edge.to) && edge.kind !== "control") continue;
        graph.addEdge(graphNodeId(node.id), graphNodeId(edge.to));
      }
    }
  }
  return graph.compile({ ...(checkpointer ? { checkpointer: checkpointer as never } : {}) });
}
