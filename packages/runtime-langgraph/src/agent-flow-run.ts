import { agentTaskCompletionSchema, evaluateTaskCompletion, type HarnessPlanV2, type TaskCompletionResult } from "@ehf/contracts";
import { assembleContextPack } from "@ehf/context-plane";
import { evaluateCondition, materializeTemplate } from "@ehf/runtime-core";
import { agentSkillResults } from "./agent-skill-results.js";
import { runAgentLoop } from "./agent-loop.js";
import { skillParametersFor } from "./hosted-skill.js";

/**
 * An agentic flow walked over a corpus hero (delivery plan wave 5), for the live harness and its
 * recorded replay in CI. The compiled plan's main path runs in order: every skill node with its
 * parameters bound from earlier payloads and the case, and the review of each wanted agent with its
 * context pack, bounded loop and completion check. Acquisition connectors, joins and checkpoints are
 * passed over (the hero's records stand in for what they acquire), and the walk ends at the person.
 *
 * Everything outside the plan comes through `io`: the library's skills (a bridge in the harness, a
 * recording in CI) and the agents' model calls. A skill's proposed ExtractedAssertion records reach
 * later skills and reviews directly, standing in for the commit path.
 */
export type CorpusRecord = { id: string; object_type: string; data: Record<string, unknown>; subject_ids?: string[]; observed_at?: string; version_id?: string };
export type SkillRun = { result: { status: string; payload: Record<string, unknown>; unresolved_items?: unknown[]; error?: unknown } } | { error: string };
export type FlowRunIo = {
  runSkill(skillId: string, parameters: Record<string, unknown>, extras: readonly CorpusRecord[]): Promise<SkillRun>;
  /** One agent-loop model call for the agent's review. */
  model(agentId: string, modelProfileId: string, input: unknown): Promise<unknown>;
};
export type AgentRunEntry = {
  agent: string; node: string; output?: Record<string, any>; error?: string;
  steps?: Array<{ step: number; action: string; tool: string | null; status: string; errorCode: string | null }>;
  completion?: TaskCompletionResult;
};
export type FlowRunReport = {
  /** Finding records the reviews proposed (committed as the platform's case writes would). */
  findingsProposed?: number;
  flow: string; party: string; asOf: string; planDigest: string;
  skills: Array<{ node: string; skillId: string; status: string; error?: string; unresolvedBindings?: string[] }>;
  agents: AgentRunEntry[];
  extractedAssertions: number;
};

/** The run's main path: intake to the person, never through the stop node. */
export function flowMainPath(plan: HarnessPlanV2): string[] {
  const path = [plan.graph.nodeOrder.find((id) => !plan.graph.edges.some((edge) => edge.to === id))!];
  while (true) {
    const next = plan.graph.edges.find((edge) => edge.from === path.at(-1) && edge.to !== "stopped");
    if (!next || path.includes(next.to)) return path;
    path.push(next.to);
  }
}

export async function runAgentFlow(input: {
  plan: HarnessPlanV2; flow: string; party: string; asOf: string;
  customerType: "individual" | "corporate";
  records: readonly CorpusRecord[];
  subjects: Array<{ subject_id: string; display_name: string }>;
  customer: string;
  /** The agents whose reviews run (all skills on the path run regardless: later bindings read them). */
  agents: readonly string[];
  io: FlowRunIo;
  onAgent?: (entry: AgentRunEntry) => void;
}): Promise<FlowRunReport> {
  const { plan, io, asOf } = input;
  const extras: CorpusRecord[] = [];
  const recordsOf = (type: string) => [...input.records, ...extras].filter((record) => record.object_type === type).map((record) => ({
    object_type: record.object_type, object_id: record.id, version_id: record.version_id ?? "v1", observed_at: record.observed_at ?? asOf, data: record.data,
  }));
  const caseSelection: Record<string, unknown> = {
    caseSubjects: input.subjects,
    subjectId: input.customer,
    subjectName: input.subjects.find((subject) => subject.subject_id === input.customer)?.display_name ?? input.customer,
  };
  const selectors = new Map(plan.contextSelectors.map((selector) => [selector.id, selector]));
  const selectionFor = (nodeId: string) => {
    const node = plan.graph.nodes.find((item) => item.id === nodeId)!;
    return Object.fromEntries(node.contextSelectorIds.map((id) => {
      const path = selectors.get(id)!.path;
      return [id, path.startsWith("records.") ? recordsOf(path.slice("records.".length)) : caseSelection[id]];
    }));
  };
  const commitProposals = (payload: Record<string, unknown>) => {
    for (const proposal of (payload.proposed_records as Array<Record<string, any>> | undefined) ?? []) {
      if (proposal.record_type !== undefined && proposal.record_type !== "CanonicalRecord") continue;
      const record = (proposal.body ?? proposal.record ?? proposal) as Record<string, any>;
      const type = record.object_type ?? proposal.object_type;
      if (type !== "ExtractedAssertion" || !record.data) continue;
      extras.push({ id: String(record.object_id ?? record.id ?? `assertion-${extras.length + 1}`), object_type: type, data: record.data,
        subject_ids: record.subject_ids ?? [String(record.data.subject ?? input.customer)], observed_at: asOf, version_id: "v1" });
    }
  };

  /**
   * A skill node's canonical record writes (`caseWrites` RecordCanonicalRecords, e.g. decision
   * controls and fraud signals), as the commit path would record them: later skills read them.
   */
  const commitRecordWrites = (node: HarnessPlanV2["graph"]["nodes"][number], value: Record<string, unknown>) => {
    const writes = Array.isArray(node.config.caseWrites) ? node.config.caseWrites as Array<Record<string, unknown>> : [];
    const scope: Record<string, unknown> = { case: { caseId: `case-${input.party}` }, output: value, run: { runId: `RUN-${input.flow}-${input.party}`, nodeId: node.id, at: asOf },
      subjects: input.subjects.map((subject) => subject.subject_id), evidence: { evidenceId: `evidence:${node.id}` }, syntheticCase: true };
    for (const write of writes) {
      if (write.commandType !== "RecordCanonicalRecords") continue;
      const items = write.forEach === undefined ? [undefined] : (getList(scope, String(write.forEach)) ?? []);
      items.forEach((item, itemIndex) => {
        const itemScope = write.forEach === undefined ? scope : { ...scope, item, itemIndex };
        const when = String(write.when ?? "success");
        if (when !== "success" && !evaluateCondition(when, itemScope)) return;
        const payload = materializeTemplate(write.payload ?? {}, itemScope) as { records?: Array<Record<string, any>> };
        for (const record of payload.records ?? []) {
          extras.push({ id: String(record.object_id), object_type: String(record.object_type), data: record.data, version_id: String(record.version_id ?? "v1"),
            subject_ids: Array.isArray(record.subject_ids) ? record.subject_ids.map(String) : [input.customer], observed_at: asOf });
        }
      });
    }
  };

  const values: Record<string, unknown> = {};
  const report: FlowRunReport = { flow: input.flow, party: input.party, asOf, planDigest: plan.planDigest, skills: [], agents: [], extractedAssertions: 0 };
  for (const nodeId of flowMainPath(plan)) {
    const node = plan.graph.nodes.find((item) => item.id === nodeId)!;
    // The person's step (a skill an approval follows) and what follows it are outside the walk.
    const kindOf = (id: string) => plan.graph.nodes.find((item) => item.id === id)?.kind;
    if (node.kind === "approval" || plan.graph.edges.some((edge) => edge.from === node.id && kindOf(edge.to) === "approval")) break;
    const skillId = typeof node.config.skillId === "string" ? node.config.skillId : null;
    if (skillId) {
      const { parameters, unresolvedBindings, required } = skillParametersFor(node, values, { ...selectionFor(node.id), ...caseSelection });
      if (required && unresolvedBindings.length) {
        // As the runtime answers it (contextGapSkillResult): the skill is not called and the node needs
        // evidence, so a case missing what an earlier step should have produced is held for evidence.
        values[node.id] = { status: "NEEDS_EVIDENCE", computation: null, parameterGaps: unresolvedBindings };
        report.skills.push({ node: node.id, skillId, status: "NEEDS_EVIDENCE", unresolvedBindings });
        continue;
      }
      const ran = await io.runSkill(skillId, parameters, extras);
      if ("error" in ran) {
        values[node.id] = { lifecycle: "FAILED_EXECUTION", computation: null, error: ran.error };
        report.skills.push({ node: node.id, skillId, status: "FAILED", error: ran.error });
        continue;
      }
      commitProposals(ran.result.payload ?? {});
      values[node.id] = {
        lifecycle: ran.result.status === "FAILED" ? "FAILED_EXECUTION" : "COMPLETED_EXECUTION",
        computation: { business_status: ran.result.status, payload: ran.result.payload ?? {}, unresolved_items: ran.result.unresolved_items ?? [] },
      };
      commitRecordWrites(node, values[node.id] as Record<string, unknown>);
      report.skills.push({ node: node.id, skillId, status: ran.result.status });
      continue;
    }
    const agentId = typeof node.config.agentRef === "string" ? node.config.agentRef : null;
    if (node.kind !== "agent" || !agentId || !input.agents.includes(agentId)) continue;
    const completion = agentTaskCompletionSchema.parse(node.config.completion);
    const profile = plan.agentProfiles.find((item) => item.id === agentId)!;
    const entry: AgentRunEntry = { agent: agentId, node: node.id };
    const pack = assembleContextPack({
      plan, nodeId: node.id, runId: `RUN-${input.flow}-${input.party}`, selection: selectionFor(node.id), ...(agentSkillResults(node, values) ?? {}),
      task: node.prompt ?? null, now: new Date(asOf),
      snapshot: { snapshotId: `snapshot_${"0".repeat(64)}`, snapshotDigest: "0".repeat(64), tenantId: "tenant-synthetic", caseId: `case-${input.party}`, caseSequence: 1 },
      envelope: { tenantId: "tenant-synthetic", caseId: `case-${input.party}`, jurisdiction: "GB", asOfTime: new Date(asOf).toISOString() },
    });
    try {
      const loop = await runAgentLoop({
        plan, nodeId: node.id, pack,
        // Tools are acquisition connectors outside this walk: reported unavailable, as a failed source is.
        invoke: async (capabilityId, modelInput) => capabilityId
          ? { status: "failed", errorCode: "harness.tool_unavailable" }
          : { status: "succeeded", output: await io.model(agentId, profile.modelProfileId, modelInput) },
        invokeSkill: async (loopSkillId, parameters) => {
          const ran = await io.runSkill(loopSkillId, parameters, extras);
          if ("error" in ran) return { status: "failed", errorCode: ran.error };
          return { status: "succeeded", output: { businessStatus: ran.result.status, payload: ran.result.payload, unresolved: ran.result.unresolved_items } };
        },
      });
      entry.output = loop.output as Record<string, any>;
      entry.steps = loop.steps.map((step) => ({ step: step.step, action: step.action, tool: step.tool, status: step.status, errorCode: step.errorCode }));
      entry.completion = evaluateTaskCompletion(completion, values, loop.output);
      values[node.id] = loop.output;
      // As the review's case writes do on the platform (wave 2): each finding above INFO becomes an
      // UNVERIFIED Finding record about the case's subjects, which later skills and reviews read.
      ((loop.output as { findings?: Array<{ type: string; severity: string; reason: string }> }).findings ?? []).forEach((finding, index) => {
        if (finding.severity === "INFO") return;
        extras.push({ id: `finding:RUN-${input.flow}-${input.party}:${node.id}:${index}`, object_type: "Finding",
          data: { claim: `${finding.type}: ${finding.reason}`, evidence_ids: [`ev_${node.id}`], status: "UNVERIFIED" },
          subject_ids: input.subjects.map((subject) => subject.subject_id), observed_at: asOf, version_id: "v1" });
      });
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
    report.agents.push(entry);
    input.onAgent?.(entry);
  }
  report.extractedAssertions = extras.filter((record) => record.object_type === "ExtractedAssertion").length;
  report.findingsProposed = extras.filter((record) => record.object_type === "Finding").length;
  return report;
}

// ---- Recorded runs ---------------------------------------------------------------------------------
// A live run's skill results and model answers, keyed by a digest of what was asked, so CI replays a
// flow deterministically without the library or a model. A request the recording does not hold is
// drift: the plan, a prompt or a skill changed since it was recorded. Skill results are matched by
// digest (falling back to the same skill's next recorded result); model answers by each agent's call
// order, with the request digest compared.
export type FlowRecording = {
  apiVersion: "ehf.agent-flow-recording.v1";
  flow: string; party: string; planDigest: string; profiles: string; recordedAt: string;
  skills: Array<{ skillId: string; digest: string; run: SkillRun }>;
  models: Array<{ agent: string; digest: string; output: unknown }>;
  /** The answer-key checks the recorded run passed (`<agent>: <check>`), which a replay must still pass. */
  answerKey?: { passed: string[]; total: number; costUsd: number };
};
export type ReplayDrift = { kind: "skill" | "model"; id: string; detail: string };

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().filter((key) => (value as Record<string, unknown>)[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
};
const sha256 = async (value: unknown) => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(canonical(value)).digest("hex");
};
const skillDigest = (skillId: string, parameters: Record<string, unknown>, extras: readonly CorpusRecord[]) =>
  sha256({ skillId, parameters, extras: extras.map((record) => record.id) });

/** Wrap live IO so every skill result and model answer is written to `recording`. */
export function recordingFlowIo(io: FlowRunIo, recording: FlowRecording): FlowRunIo {
  return {
    async runSkill(skillId, parameters, extras) {
      const run = await io.runSkill(skillId, parameters, extras);
      recording.skills.push({ skillId, digest: await skillDigest(skillId, parameters, extras), run: structuredClone(run) });
      return run;
    },
    async model(agentId, modelProfileId, input) {
      const output = await io.model(agentId, modelProfileId, input);
      recording.models.push({ agent: agentId, digest: await sha256(input), output: structuredClone(output) });
      return output;
    },
  };
}

/** IO that answers from a recording, collecting drift. An unrecorded model call fails the agent's loop. */
export function replayFlowIo(recording: FlowRecording, drift: ReplayDrift[]): FlowRunIo {
  const usedSkills = new Set<number>();
  const modelCalls = new Map<string, number>();
  return {
    async runSkill(skillId, parameters, extras) {
      const digest = await skillDigest(skillId, parameters, extras);
      let index = recording.skills.findIndex((entry, at) => !usedSkills.has(at) && entry.digest === digest);
      if (index < 0) {
        index = recording.skills.findIndex((entry, at) => !usedSkills.has(at) && entry.skillId === skillId);
        drift.push({ kind: "skill", id: skillId, detail: index < 0 ? "not recorded" : "parameters or upstream records changed" });
        if (index < 0) return { error: "replay.skill_not_recorded" };
      }
      usedSkills.add(index);
      return structuredClone(recording.skills[index]!.run);
    },
    async model(agentId, _modelProfileId, input) {
      const call = modelCalls.get(agentId) ?? 0;
      modelCalls.set(agentId, call + 1);
      const recorded = recording.models.filter((entry) => entry.agent === agentId)[call];
      if (!recorded) {
        drift.push({ kind: "model", id: `${agentId}#${call}`, detail: "not recorded" });
        throw new Error("replay.model_call_not_recorded");
      }
      if (recorded.digest !== await sha256(input)) drift.push({ kind: "model", id: `${agentId}#${call}`, detail: "request changed" });
      return structuredClone(recorded.output);
    },
  };
}

function getList(scope: Record<string, unknown>, path: string): unknown[] | undefined {
  const value = path.split(".").reduce<unknown>((at, key) => at && typeof at === "object" ? (at as Record<string, unknown>)[key] : undefined, scope);
  return Array.isArray(value) ? value : undefined;
}
