import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { harnessPlanV2Schema, type HarnessPlanV2 } from "@ehf/contracts";
import { replayFlowIo, runAgentFlow, scoreAgentAnswers, type CorpusRecord, type FlowRecording, type ReplayDrift } from "./index.js";

// Delivery plan wave 5: every agent of both flows, exercised in CI without a model. Each recording
// (fixtures/agent-recordings, made by `scripts/live-agent-run.ts --record` with real models) holds the
// library's skill results and the agents' model answers for one hero. The replay walks today's
// compiled plan: packs, loops, output schemas and completion run for real; the answers come from the
// recording. The answer key is derived from the hero's scenario facts, never from the recording.
//
// Drift (a prompt, a binding or a skill changed since recording) is reported, not failed: the replayed
// answers must still be accepted by today's schemas and still pass the checks the live run passed.
// Re-record after a deliberate agent change; `--replay <file> --strict` fails on drift.
const root = new URL("../../../", import.meta.url);
const recordings = readdirSync(new URL("fixtures/agent-recordings/", root)).filter((name) => name.endsWith(".json")).sort();
const plans = new Map<string, HarnessPlanV2>();
const planFor = (flow: string) => {
  if (!plans.has(flow)) plans.set(flow, harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL(`artifacts/${flow}.plan.json`, root), "utf8"))) as HarnessPlanV2);
  return plans.get(flow)!;
};
const lines = (url: URL): CorpusRecord[] => existsSync(url) ? readFileSync(url, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

async function replay(file: string) {
  const recording = JSON.parse(readFileSync(new URL(`fixtures/agent-recordings/${file}`, root), "utf8")) as FlowRecording;
  const hero = new URL(`fixtures/context-corpus/parties/${recording.party}/`, root);
  const records = [...lines(new URL("records.jsonl", hero)), ...lines(new URL("documents.jsonl", hero))];
  const caseFile = JSON.parse(readFileSync(new URL("case.json", hero), "utf8")) as { customer_entity_id: string; subjects: Array<{ entity_id: string }> };
  const nameOf = (id: string) => String((records.find((record) => record.id === id)?.data as { name?: string } | undefined)?.name ?? id);
  const plan = planFor(recording.flow);
  const customerType = recording.flow === "kyc-agentic" ? "individual" as const : "corporate" as const;
  const drift: ReplayDrift[] = [];
  const report = await runAgentFlow({
    plan, flow: recording.flow, party: recording.party, asOf: "2026-09-30T00:00:00Z", customerType, records,
    subjects: caseFile.subjects.map((subject) => ({ subject_id: subject.entity_id, display_name: nameOf(subject.entity_id) })),
    customer: caseFile.customer_entity_id, agents: plan.agentProfiles.map((profile) => profile.id), io: replayFlowIo(recording, drift),
  });
  const facts = parse(readFileSync(new URL("expectations.yaml", hero), "utf8"));
  const documents = existsSync(new URL("documents.expected.yaml", hero)) ? parse(readFileSync(new URL("documents.expected.yaml", hero), "utf8")) : null;
  return { recording, report, drift, plan, key: scoreAgentAnswers({ customerType, facts, documents, answers: report.agents }) };
}

describe("recorded agent runs (delivery plan wave 5)", () => {
  it("has a recording of every agent of both flows", () => {
    const covered = new Set(recordings.flatMap((file) => {
      const recording = JSON.parse(readFileSync(new URL(`fixtures/agent-recordings/${file}`, root), "utf8")) as FlowRecording;
      return recording.models.map((call) => `${recording.flow}:${call.agent}`);
    }));
    for (const flow of ["kyc-agentic", "kyb-agentic"]) {
      for (const profile of planFor(flow).agentProfiles) expect(covered.has(`${flow}:${profile.id}`), `${flow}:${profile.id}`).toBe(true);
    }
  });

  it.each(recordings)("%s replays through today's plan and still meets its answer key", async (file) => {
    const { recording, report, drift, plan, key } = await replay(file);
    if (drift.length) console.warn(`${file}: ${drift.length} drifted request(s) since recording; re-record after a deliberate change`, drift.slice(0, 5));
    // Every agent answered within today's output schema, and its completion was judged.
    expect(report.agents.map((entry) => entry.agent)).toEqual(plan.agentProfiles.map((profile) => profile.id));
    for (const entry of report.agents) {
      expect(entry.error, `${entry.agent}: ${entry.error}`).toBeUndefined();
      expect(entry.completion?.status, entry.agent).toBeDefined();
      // No agent decides: a completed task never comes from an agent that declares itself final.
      expect(entry.output?.final ?? false, entry.agent).toBe(false);
    }
    // The checks the live run passed still pass (a regression in schema, pack or scoring shows here).
    const passing = new Set(key.checks.filter((check) => check.passed).map((check) => `${check.agent}: ${check.check}`));
    for (const check of recording.answerKey?.passed ?? []) expect(passing.has(check), check).toBe(true);
  });
});
