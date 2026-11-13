// A run of an agentic flow's agents over a corpus hero (delivery plan wave 5): live with real models,
// recorded for CI, or replayed from a recording.
//
//   NODE_USE_ENV_PROXY=1 node --import tsx scripts/live-agent-run.ts --flow kyb-agentic --party H04 \
//     [--agents all | agent.document_intelligence,agent.identity_verification] \
//     [--profiles config/model-profiles.claude-openrouter.json] [--python <python with the library's deps>] \
//     [--record fixtures/agent-recordings/kyb-agentic.H04.json | --replay <recording> [--strict]] [--out report.json]
//
// What runs as in production (packages/runtime-langgraph agent-flow-run.ts):
// - the compiled plan (artifacts/<flow>.plan.json), walked along its main path: every skill node with
//   its bindings, each wanted agent's review with its context pack, bounded loop, output schema and
//   completion check;
// - the skill library's own skills over the hero's records and documents, through
//   tools/context-corpus skill_bridge.py; a provider request is answered by the platform's connector:
//   document.fields by the model connector, the authenticity detectors by their sandbox connectors;
// - model calls through the platform's model connectors (@ehf/adapters) for the profile set given.
//
// What is stood in for: the case store (the hero's corpus records), the gateway (connector calls run
// in-process; the agents' acquisition tools are reported unavailable), the commit path (proposed
// ExtractedAssertion records and skill nodes' canonical record writes, such as Control, reach later skills directly) and the checkpoints (passed over).
//
// The report scores the agents against the hero's answer key (agent-answer-key.ts), derived from the
// hero's scenario facts: expectations.yaml and documents.expected.yaml.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";
import { invokeDocumentFieldsModel, invokeModel, invokeSimulator, isAgentLoopCall, LIBRARY_SANDBOX_CAPABILITIES, loadModelProfiles } from "../packages/adapters/src/index.js";
import { harnessPlanV2Schema, type HarnessPlanV2 } from "../packages/contracts/src/index.js";
import {
  recordingFlowIo, replayFlowIo, runAgentFlow, scoreAgentAnswers,
  type CorpusRecord, type FlowRecording, type FlowRunIo, type ReplayDrift,
} from "../packages/runtime-langgraph/src/index.js";

const repo = resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1]! : fallback; };
const flow = arg("flow", "kyc-agentic")!;
const party = arg("party", "H03")!;
const profilesPath = arg("profiles", "config/model-profiles.claude-openrouter.json")!;
const python = arg("python", process.env.CORPUS_PYTHON ?? "python3")!;
const out = arg("out");
const recordTo = arg("record");
const replayFrom = arg("replay");
const strict = argv.includes("--strict");
const AS_OF = "2026-09-30T00:00:00Z";

const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(resolve(repo, `artifacts/${flow}.plan.json`), "utf8"))) as HarnessPlanV2;
const roster = plan.agentProfiles.map((profile) => profile.id);
const agentsArg = arg("agents", "all")!;
const wanted = agentsArg === "all" ? roster : agentsArg.split(",");
for (const id of wanted) if (!roster.includes(id)) throw new Error(`agent not in ${flow}: ${id}`);
const customerType = flow === "kyc-agentic" ? "individual" : "corporate";

// ---- The hero ---------------------------------------------------------------------------------
const heroRoot = resolve(repo, `fixtures/context-corpus/parties/${party}`);
const readLines = (file: string): CorpusRecord[] => existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
const records = [...readLines(resolve(heroRoot, "records.jsonl")), ...readLines(resolve(heroRoot, "documents.jsonl"))];
const caseFile = JSON.parse(readFileSync(resolve(heroRoot, "case.json"), "utf8")) as { customer_entity_id: string; subjects: Array<{ entity_id: string }> };
const nameOf = (id: string) => String((records.find((record) => record.id === id)?.data as { name?: string } | undefined)?.name ?? id);
const subjects = caseFile.subjects.map((subject) => ({ subject_id: subject.entity_id, display_name: nameOf(subject.entity_id) }));
const facts = parse(readFileSync(resolve(heroRoot, "expectations.yaml"), "utf8"));
const documents = existsSync(resolve(heroRoot, "documents.expected.yaml")) ? parse(readFileSync(resolve(heroRoot, "documents.expected.yaml"), "utf8")) : null;

// ---- Live IO: the library through the bridge, models through the platform's connectors -----------
type Usage = { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
const usage: Usage = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
const tally = (result: { inputTokens: number | null; outputTokens: number | null; costUsd: number | null }) => {
  usage.calls += 1; usage.inputTokens += result.inputTokens ?? 0; usage.outputTokens += result.outputTokens ?? 0; usage.costUsd += result.costUsd ?? 0;
};
async function liveIo(): Promise<{ io: FlowRunIo; close: () => void }> {
  const profiles = await loadModelProfiles(resolve(repo, profilesPath));
  const profileOf = (id: string) => profiles.find((profile) => profile.id === id) ?? (() => { throw new Error(`profile_missing:${id}`); })();
  const bindingFor = (provider: string) => ({ kind: provider === "anthropic" ? "anthropic" as const : "openrouter" as const, baseUrl: null, siteUrl: null, appName: null, status: "active" as const });
  // The session's network proxy injects the OpenRouter key; the Claude connector reads its own.
  const keyFor = (provider: string) => provider === "anthropic" ? process.env.ANTHROPIC_API_KEY ?? (() => { throw new Error("ANTHROPIC_API_KEY is required for an anthropic profile"); })() : process.env.OPENROUTER_API_KEY ?? "proxy-injected";
  const bridge = spawn(python, ["-m", "context_corpus.skill_bridge"], {
    cwd: resolve(repo, "tools/context-corpus"), stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, PYTHONPATH: [resolve(repo, "tools/context-corpus/src"), resolve(repo, "apps/fincrime-host/src")].join(":") },
  });
  const pending = new Map<string, (value: any) => void>();
  createInterface({ input: bridge.stdout! }).on("line", (line) => { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); });
  let sequence = 0;
  const callBridge = (skill: string, parameters: Record<string, unknown>, extras: readonly CorpusRecord[], recordings: unknown[]) => new Promise<any>((done) => {
    const id = `call-${++sequence}`;
    pending.set(id, done);
    bridge.stdin!.write(JSON.stringify({ id, party, skill, parameters, customer_type: customerType, subject_ids: caseFile.subjects.map((subject) => subject.entity_id), extra_records: extras, recordings }) + "\n");
  });
  const answerProvider = async (capability: string, request: Record<string, unknown>) => {
    if (capability === "document.fields") {
      const profile = profileOf("model.standard.v1");
      const answer = await invokeDocumentFieldsModel({ profile, input: request, apiKey: keyFor(profile.provider), providerBinding: bindingFor(profile.provider) });
      tally(answer);
      return answer.output;
    }
    // The flows bind the detectors to their sandbox connectors (wave 4): always INCONCLUSIVE.
    if ((LIBRARY_SANDBOX_CAPABILITIES as readonly string[]).includes(capability)) return (await invokeSimulator(`library.${capability}`, request)).output;
    throw new Error(`harness.provider_unavailable:${capability}`);
  };
  const io: FlowRunIo = {
    // A skill stops at its first unanswered provider request, so answer each and run again.
    async runSkill(skill, parameters, extras) {
      const recordings: unknown[] = [];
      for (let round = 0; round < 10; round += 1) {
        const response = await callBridge(skill, parameters, extras, recordings);
        if (response.error) return { error: String(response.error) };
        const requests = response.provider_requests as Array<{ capability: string; request: Record<string, unknown> }>;
        if (!requests.length) return { result: response.result };
        for (const { capability, request } of requests) {
          try {
            recordings.push({ capability, request, payload: await answerProvider(capability, request) });
          } catch (error) {
            return { error: `connector:${error instanceof Error ? error.message.slice(0, 300) : String(error)}` };
          }
        }
      }
      return { error: "harness.provider_rounds_exhausted" };
    },
    async model(_agentId, modelProfileId, input) {
      if (!isAgentLoopCall(input)) throw new Error("harness.unexpected_model_call");
      const profile = profileOf(modelProfileId);
      const answer = await invokeModel({ profile, input, apiKey: keyFor(profile.provider), providerBinding: bindingFor(profile.provider), allowRecordedFallback: false, outputSchema: { type: "object", required: ["action"] } });
      tally(answer);
      return answer.output;
    },
  };
  return { io, close: () => bridge.stdin!.end() };
}

// ---- Run --------------------------------------------------------------------------------------
const drift: ReplayDrift[] = [];
let recording: FlowRecording | null = null;
let io: FlowRunIo;
let close = () => {};
if (replayFrom) {
  recording = JSON.parse(readFileSync(resolve(repo, replayFrom), "utf8")) as FlowRecording;
  io = replayFlowIo(recording, drift);
} else {
  ({ io, close } = await liveIo());
  if (recordTo) {
    recording = { apiVersion: "ehf.agent-flow-recording.v1", flow, party, planDigest: plan.planDigest, profiles: profilesPath, recordedAt: new Date().toISOString(), skills: [], models: [] };
    io = recordingFlowIo(io, recording);
  }
}
let last = { ...usage };
const report = await runAgentFlow({
  plan, flow, party, asOf: AS_OF, customerType, records, subjects, customer: caseFile.customer_entity_id, agents: wanted, io,
  onAgent: (entry) => {
    process.stderr.write(`${entry.agent}: ${entry.error ? `error ${entry.error}` : `completion ${entry.completion?.status}`} (${usage.calls - last.calls} model calls, $${(usage.costUsd - last.costUsd).toFixed(4)})\n`);
    last = { ...usage };
  },
});
close();
const answerKey = scoreAgentAnswers({ customerType, facts, documents, answers: report.agents });
if (recordTo && recording) recording.answerKey = { passed: answerKey.checks.filter((check) => check.passed).map((check) => `${check.agent}: ${check.check}`), total: answerKey.total, costUsd: +usage.costUsd.toFixed(4) };
if (recordTo && recording) writeFileSync(resolve(repo, recordTo), JSON.stringify(recording, null, 1) + "\n");
const serialized = JSON.stringify({ ...report, profiles: profilesPath, mode: replayFrom ? "replay" : recordTo ? "record" : "live", drift, answerKey, usage: { ...usage, costUsd: +usage.costUsd.toFixed(6) } }, null, 2) + "\n";
if (out) writeFileSync(out, serialized); else process.stdout.write(serialized);
process.stderr.write(`answer key: ${answerKey.passed}/${answerKey.total}${drift.length ? `; drift ${drift.length}` : ""}; $${usage.costUsd.toFixed(4)}\n`);
if (strict && drift.length) process.exit(1);
