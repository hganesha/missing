import { readFileSync } from "node:fs";
import { afterEach, expect, it } from "vitest";
import { harnessPlanV2Schema } from "@ehf/contracts";
import { executeCaseWrites, type RuntimeContext } from "./index.js";

// Phase 4c (docs/implementation/data-stores-plan.md §3.3): before an agent node's case writes,
// the runtime promotes the pack its model answered from as `model_context` evidence and every
// command cites it.

const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../contracts/test-fixtures/conformance.plan.json", import.meta.url), "utf8")));
const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

function fakePlatform() {
  const requests: Array<{ path: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ path, headers: init.headers as Record<string, string>, body });
    if (path === "/v1/runtime/envelopes") return new Response(JSON.stringify({ envelope: "envelope", expiresInSeconds: 60, caseWrites: ["LinkEvidence", "ProposeClaim"] }), { status: 200 });
    if (path === "/v1/evidence:register") return new Response(JSON.stringify({ created: true, evidence: { evidenceId: `ev_${String(body.type)}` } }), { status: 201 });
    if (path === "/v2/cases/CASE-1/sequence" && init.method === "GET") return new Response(JSON.stringify({ caseSequence: 3 }), { status: 200 });
    if (path === "/v1/cases/CASE-1/commands") return new Response(JSON.stringify({ createdIdentifiers: {} }), { status: 200 });
    return new Response(JSON.stringify({ error: `unexpected ${path}` }), { status: 404 });
  }) as typeof globalThis.fetch;
  return requests;
}

const context: RuntimeContext = {
  state: { nodeStarted: async () => {}, nodeFinished: async () => {}, appendEvent: async () => {}, markCheckpoint: async () => {} },
  plan, runId: "RUN-1", runAttempt: 1, workerId: "worker-1", fencingEpoch: 1,
  gatewayUrl: "http://gateway", envelopeBrokerUrl: "http://control", caseApiUrl: "http://case", executionGrant: "grant", serviceToken: "service-token",
};
const root = { tenantId: "tenant_demo", caseId: "CASE-1", policySnapshotDigest: "d".repeat(64) };
const pack = { apiVersion: "harness.factory/context-pack-v1", packDigest: "e".repeat(64), runId: "RUN-1", nodeId: "lookup", sections: [] };

it("promotes the pack the model answered from before any command, and cites it on every command", async () => {
  const requests = fakePlatform();
  const receipt = await executeCaseWrites(context, "lookup", root, {}, { vendor: "Acme" }, {}, undefined, pack);
  const paths = requests.map((request) => request.path);
  const promotion = requests.find((request) => request.path === "/v1/evidence:register")!;
  expect(promotion.body).toMatchObject({ type: "model_context", retentionClass: "DECISION_RECORD", trust: { instructionTrust: "UNTRUSTED_DATA" } });
  expect(JSON.parse(Buffer.from(String(promotion.body.contentBase64), "base64").toString("utf8"))).toEqual(pack);
  expect(promotion.headers["idempotency-key"]).toBe(`RUN-1:1:lookup:model-context:${"e".repeat(24)}`);
  const sequenceReads = requests.filter(r => r.path === "/v2/cases/CASE-1/sequence");
  expect(sequenceReads).toHaveLength(2);
  expect(sequenceReads.every(r => r.headers["x-execution-envelope"] === "envelope")).toBe(true);
  expect(requests.some(r => r.path === "/v1/cases/CASE-1")).toBe(false);
  const commands = requests.filter((request) => request.path === "/v1/cases/CASE-1/commands");
  expect(commands).toHaveLength(2);
  expect(paths.indexOf("/v1/evidence:register")).toBeLessThan(paths.indexOf("/v1/cases/CASE-1/commands"));
  for (const command of commands) {
    expect(command.body.authority).toMatchObject({ contextEvidenceId: "ev_model_context", contextPackDigest: "e".repeat(64) });
  }
  expect(receipt?.contextEvidenceId).toBe("ev_model_context");
});

it("promotes nothing and cites nothing for a node that showed no model a pack", async () => {
  const requests = fakePlatform();
  await executeCaseWrites(context, "lookup", root, {}, { vendor: "Acme" }, {});
  expect(requests.some((request) => request.path === "/v1/evidence:register")).toBe(false);
  for (const command of requests.filter((request) => request.path === "/v1/cases/CASE-1/commands")) {
    expect(command.body.authority).not.toHaveProperty("contextEvidenceId");
  }
});
