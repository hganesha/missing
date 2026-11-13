import { describe, expect, it } from "vitest";
import { Command, MemorySaver } from "@langchain/langgraph";
import { harnessPlanV2Schema, stableDigest, type GraphEdgeV2, type GraphNodeV2, type HarnessPlanV2 } from "@ehf/contracts";
import type { RuntimeContext } from "@ehf/runtime-core";
import {
  lowerHarnessPlanV2,
  type V2ExecutionAdapters,
} from "./index.js";

const v2Digest = "a".repeat(64);

function v2Plan(nodes: GraphNodeV2[], edges: GraphEdgeV2[]): HarnessPlanV2 {
  const content = {
    apiVersion: "harness.factory/plan-v2" as const, kind: "HarnessPlan" as const, packageDigest: v2Digest,
    compiler: { name: "harnessc" as const, version: "2.0.0", digest: v2Digest, compatibilityVersion: "4", lgirCoreRevision: "abcdef0" },
    metadata: { name: "runtime-test", version: "2.0.0", domain: "test", objective: "Exercise lowering" },
    execution: {
      engine: { kind: "harness-runtime" as const, adapterVersion: "harness-runtime-v2", profile: "production-v2" },
      coordinationMode: "caseStore" as const, maxTransitions: 100, maxConcurrency: 4, durability: "durable" as const,
    },
    budgets: { maxDurationMs: 60_000, maxCostUsd: 1, maxModelCalls: 5, maxCapabilityCalls: 10 },
    schemas: { input: { type: "object" }, output: { type: "object" }, schemaSetDigest: v2Digest },
    modelProfiles: [], agentProfiles: [],
    capabilities: [{
      id: "model.review", kind: "model" as const, effect: "none" as const, adapterBindingId: "test:model",
      inputSchema: {}, outputSchema: {}, timeoutMs: 1_000, maxAttempts: 1, idempotent: true,
    }],
    permissionEnvelopes: [{ nodeId: "review", capabilities: ["model.review"], effects: ["none" as const], digest: v2Digest }],
    policyBundles: [{ policyId: "policy.test", bundleDigest: v2Digest }],
    contextSelectors: [{ id: "subject", source: "case" as const, path: "case.subject", purpose: "TEST", classification: "CONFIDENTIAL", required: true }],
    contextClassificationPolicies: [{ classification: "CONFIDENTIAL", action: "allow" as const }],
    graph: { apiVersion: "ladder.dev/v1alpha1" as const, name: "runtime-test", nodes, edges, nodeOrder: nodes.map((node) => node.id) },
    releaseConstraints: { regions: ["US"], dataClasses: ["CONFIDENTIAL"], evaluationRequirementIds: ["runtime"] },
    dependencyManifest: [{ kind: "policy", id: "policy.test", digest: v2Digest }], dependencyManifestDigest: v2Digest,
    createdAt: "2026-09-19T12:00:00.000Z", buildProvenanceDigest: v2Digest,
  };
  return harnessPlanV2Schema.parse({ ...content, planId: "plan_runtime_v2", planDigest: stableDigest(content) });
}

function v2Snapshot(plan: HarnessPlanV2) {
  const canonical = {
    apiVersion: "harness.factory/case-snapshot-v1" as const, kind: "CaseSnapshot" as const,
    tenantId: "tenant-1", caseId: "case-1", caseSequence: 3,
    dependencyDigest: "c".repeat(64), planDigest: plan.planDigest,
    policyAuthority: { policyId: "policy.test", policyVersion: "1", policySnapshotDigest: "d".repeat(64), policyBundleDigest: v2Digest },
    consistency: "strong" as const, classification: "CONFIDENTIAL",
    data: { case: { subject: { id: "subject-1" }, secret: "case-secret" }, evidence: [{ secret: "evidence-secret" }] },
  };
  const snapshotDigest = stableDigest(canonical);
  return {
    ...canonical,
    snapshotId: `snapshot_${snapshotDigest}`,
    snapshotDigest,
    capturedAt: "2026-09-19T12:00:00.000Z",
  };
}

function v2Context(plan: HarnessPlanV2): RuntimeContext {
  return {
    state: { nodeStarted: async () => {}, nodeFinished: async () => {}, appendEvent: async () => {}, markCheckpoint: async () => {} },
    plan, runId: "RUN-V2", runAttempt: 1, workerId: "worker-1", fencingEpoch: 1,
    gatewayUrl: "http://gateway", envelopeBrokerUrl: "http://control", executionGrant: "grant", serviceToken: "service-token",
  };
}

describe("v2 LangGraph lowering", () => {
  it("keeps root and upstream fields outside a capability's compiled case context", async () => {
    const nodes: GraphNodeV2[] = [
      { id: "input", kind: "input", name: "Input", contextSelectorIds: [], config: {} },
      { id: "review", kind: "agent", name: "Review", prompt: "Review {{input.subject.id}} / {{input.secret}}", contextSelectorIds: ["subject"], config: { capabilityId: "model.review" } },
      { id: "output", kind: "output", name: "Output", contextSelectorIds: [], config: {} },
    ];
    const edges: GraphEdgeV2[] = [
      { id: "e1", from: "input", to: "review", kind: "data" },
      { id: "e2", from: "review", to: "output", kind: "data" },
    ];
    const plan = v2Plan(nodes, edges);
    const invoked: unknown[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (String(url).includes("/v1/runtime/envelopes")) {
        return new Response(JSON.stringify({ envelope: "envelope", expiresInSeconds: 60, caseWrites: [] }), { status: 200 });
      }
      invoked.push((JSON.parse(String(init.body)) as { input: unknown }).input);
      return new Response(JSON.stringify({
        invocationId: "x", capabilityId: "model.review", status: "succeeded", output: { reviewed: true }, errorCode: null,
        provider: "simulator", model: "test:model", providerRequestId: null,
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, latencyMs: 1, receiptDigest: v2Digest,
      }), { status: 200 });
    }) as typeof globalThis.fetch;
    const adapters: V2ExecutionAdapters = {
      loadCaseSnapshot: async (request) => {
        expect(request).toMatchObject({ tenantId: "tenant-1", caseId: "case-1", nodeId: "review", selectorIds: ["subject"] });
        return v2Snapshot(plan);
      },
      evaluateGate: async () => { throw new Error("unexpected gate"); },
      executeFanoutBody: async () => { throw new Error("unexpected fanout"); },
    };
    try {
      const graph = lowerHarnessPlanV2(plan, v2Context(plan), adapters);
      await graph.invoke({ input: { tenantId: "tenant-1", caseId: "case-1", secret: "root-secret" }, values: { injected: "upstream-secret" } });
    } finally {
      globalThis.fetch = original;
    }
    // Agent nodes are served by the context plane: the authored task is rendered into
    // a prompt whose only data is the trust-labelled, compiled selection.
    expect(invoked).toEqual([{
      input: { subject: { id: "subject-1" } },
      prompt: expect.stringContaining("# Task\nReview subject-1 / null"),
      contextPackDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      contextManifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    }]);
    expect((invoked[0] as { prompt: string }).prompt).toMatch(/<context id="subject" trust="TRUSTED_DATA"[^>]*>\n\{"id":"subject-1"\}\n<\/context>/);
    expect(JSON.stringify(invoked)).not.toContain("root-secret");
    expect(JSON.stringify(invoked)).not.toContain("upstream-secret");
    expect(JSON.stringify(invoked)).not.toContain("case-secret");
  });

  it("gives an allSettled join a branch the durable dispatcher committed as rejected", async () => {
    const nodes: GraphNodeV2[] = [
      { id: "input", kind: "input", name: "Input", contextSelectorIds: [], config: {} },
      { id: "left", kind: "transform", name: "Left", contextSelectorIds: [], config: {} },
      { id: "right", kind: "transform", name: "Right", contextSelectorIds: [], config: {} },
      { id: "settled", kind: "join", name: "Settled", contextSelectorIds: [], config: { mode: "allSettled" } },
      { id: "output", kind: "output", name: "Output", contextSelectorIds: [], config: {} },
    ];
    const edges: GraphEdgeV2[] = [
      { id: "e1", from: "input", to: "left", kind: "data" }, { id: "e2", from: "input", to: "right", kind: "data" },
      { id: "e3", from: "left", to: "settled", kind: "data" }, { id: "e4", from: "right", to: "settled", kind: "data" },
      { id: "e5", from: "settled", to: "output", kind: "data" },
    ];
    const plan = v2Plan(nodes, edges);
    const adapters = { loadCaseSnapshot: async () => { throw new Error("unused"); }, evaluateGate: async () => { throw new Error("unused"); }, executeFanoutBody: async () => { throw new Error("unused"); } } as V2ExecutionAdapters;
    const result = await lowerHarnessPlanV2(plan, v2Context(plan), adapters, undefined, "settled").invoke({
      input: {}, values: { left: { ok: true } },
      settlements: { right: { status: "rejected", reason: { code: "vendor.timeout", message: "vendor.timeout" } } },
    }) as { values: Record<string, unknown> };
    expect(result.values.settled).toEqual({
      left: { status: "fulfilled", value: { ok: true } },
      right: { status: "rejected", reason: { code: "vendor.timeout", message: "vendor.timeout" } },
    });
  });

  it("executes a bounded fanout body with ordered allSettled results", async () => {
    const nodes: GraphNodeV2[] = [
      { id: "input", kind: "input", name: "Input", contextSelectorIds: [], config: {} },
      { id: "fan", kind: "fanout", name: "Fan", contextSelectorIds: [], config: { itemsPath: "items", bodyRef: "screen-one", maxItems: 3, maxConcurrency: 2, joinMode: "allSettled" } },
      { id: "output", kind: "output", name: "Output", contextSelectorIds: [], config: {} },
    ];
    const plan = v2Plan(nodes, [
      { id: "e1", from: "input", to: "fan", kind: "data" },
      { id: "e2", from: "fan", to: "output", kind: "data" },
    ]);
    let active = 0;
    let highWater = 0;
    const adapters: V2ExecutionAdapters = {
      loadCaseSnapshot: async () => { throw new Error("unexpected snapshot"); },
      evaluateGate: async () => { throw new Error("unexpected gate"); },
      executeFanoutBody: async (request) => {
        active += 1;
        highWater = Math.max(highWater, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        if (request.index === 1) throw new Error("screen.failed");
        expect(request).not.toHaveProperty("rootInput");
        return `screened-${request.item}`;
      },
    };
    const result = await lowerHarnessPlanV2(plan, v2Context(plan), adapters).invoke({
      input: { tenantId: "tenant-1", caseId: "case-1", items: ["a", "b", "c"], secret: "root-secret" }, values: {},
    });
    expect(result.output).toEqual([
      { status: "fulfilled", value: "screened-a" },
      { status: "rejected", reason: { code: "screen.failed", message: "screen.failed" } },
      { status: "fulfilled", value: "screened-c" },
    ]);
    expect(highWater).toBe(2);
  });

  it("executes a parallel group behind an aggregate barrier", async () => {
    const nodes: GraphNodeV2[] = [
      { id: "input", kind: "input", name: "Input", contextSelectorIds: [], config: {} },
      { id: "left", kind: "transform", name: "Left", contextSelectorIds: [], config: { operation: "select", path: "value" } },
      { id: "right", kind: "transform", name: "Right", contextSelectorIds: [], config: { operation: "select", path: "value" } },
      { id: "checks", kind: "group", name: "Checks", contextSelectorIds: [], config: { members: ["left", "right"], execution: "parallel", exit: "aggregate" } },
      { id: "output", kind: "output", name: "Output", contextSelectorIds: [], config: {} },
    ];
    const plan = v2Plan(nodes, [
      { id: "e1", from: "input", to: "checks", kind: "data" },
      { id: "e2", from: "checks", to: "output", kind: "data" },
    ]);
    const result = await lowerHarnessPlanV2(plan, v2Context(plan), {
      loadCaseSnapshot: async () => { throw new Error("unexpected snapshot"); },
      evaluateGate: async () => { throw new Error("unexpected gate"); },
    }).invoke({ input: { value: 7 }, values: {} });
    expect(result.output).toEqual({ left: 7, right: 7 });
  });

  it("maps parent state into and child output out of a native subgraph", async () => {
    const nodes: GraphNodeV2[] = [
      { id: "input", kind: "input", name: "Input", contextSelectorIds: [], config: {} },
      { id: "child", kind: "subgraph", name: "Child", contextSelectorIds: [], config: { subgraph: {
        ref: "host:verification", inputMap: { request: "/input" }, outputMap: { result: "/verified" }, checkpointer: "perInvocation",
      } } },
      { id: "output", kind: "output", name: "Output", contextSelectorIds: [], config: {} },
    ];
    const plan = v2Plan(nodes, [
      { id: "e1", from: "input", to: "child", kind: "data" },
      { id: "e2", from: "child", to: "output", kind: "data" },
    ]);
    const result = await lowerHarnessPlanV2(plan, v2Context(plan), {
      loadCaseSnapshot: async () => { throw new Error("unexpected snapshot"); },
      evaluateGate: async () => { throw new Error("unexpected gate"); },
      executeSubgraph: async (request) => {
        expect(request).toMatchObject({ ref: "host:verification", input: { request: { subject: "Ada" } }, checkpointer: "perInvocation" });
        return { result: { status: "verified" } };
      },
    }).invoke({ input: { subject: "Ada" }, values: {} });
    expect(result.output).toEqual({ verified: { status: "verified" } });
  });

  it("routes gate outcomes using an authority-bound evaluation", async () => {
    const nodes: GraphNodeV2[] = [
      { id: "input", kind: "input", name: "Input", contextSelectorIds: [], config: {} },
      { id: "gate", kind: "gate", name: "Gate", contextSelectorIds: ["subject"], config: { policyRef: "policy.test", gateId: "disposition" } },
      { id: "allowed", kind: "output", name: "Allowed", contextSelectorIds: [], config: {} },
      { id: "review", kind: "output", name: "Review", contextSelectorIds: [], config: {} },
    ];
    const plan = v2Plan(nodes, [
      { id: "e1", from: "input", to: "gate", kind: "data" },
      { id: "e2", from: "gate", to: "allowed", kind: "control", outcome: "ALLOW" },
      { id: "e3", from: "gate", to: "review", kind: "control", outcome: "REVIEW" },
    ]);
    const snapshot = v2Snapshot(plan);
    const adapters: V2ExecutionAdapters = {
      loadCaseSnapshot: async () => snapshot,
      evaluateGate: async (request) => ({
        apiVersion: "harness.factory/policy-evaluation-v1", kind: "PolicyEvaluation", evaluationId: "evaluation-1",
        tenantId: snapshot.tenantId, caseId: snapshot.caseId, caseSequence: snapshot.caseSequence,
        caseSnapshotDigest: snapshot.snapshotDigest, dependencyDigest: snapshot.dependencyDigest,
        policyBundleDigest: v2Digest, gateId: "disposition", inputDigest: request.inputDigest,
        outcome: "ALLOW", ruleResults: [], reasonCodes: ["AUTHORIZED"], obligations: [], evidenceRefs: [],
        evaluatedAt: "2026-09-19T12:01:00.000Z", receiptDigest: "e".repeat(64),
      }),
      executeFanoutBody: async () => { throw new Error("unexpected fanout"); },
    };
    const result = await lowerHarnessPlanV2(plan, v2Context(plan), adapters).invoke({
      input: { tenantId: "tenant-1", caseId: "case-1" }, values: {},
    });
    expect(result.output).toMatchObject({ outcome: "ALLOW", gateId: "disposition" });
  });

  it("durably suspends approval and resumes only with a human decision", async () => {
    const nodes: GraphNodeV2[] = [
      { id: "input", kind: "input", name: "Input", contextSelectorIds: [], config: {} },
      { id: "approve", kind: "approval", name: "Approve", contextSelectorIds: ["subject"], config: { queue: "kyc-review" } },
      { id: "output", kind: "output", name: "Output", contextSelectorIds: [], config: {} },
    ];
    const plan = v2Plan(nodes, [
      { id: "e1", from: "input", to: "approve", kind: "data" },
      { id: "e2", from: "approve", to: "output", kind: "data" },
    ]);
    const snapshot = v2Snapshot(plan);
    const adapters: V2ExecutionAdapters = {
      loadCaseSnapshot: async () => snapshot,
      evaluateGate: async () => { throw new Error("unexpected gate"); },
      executeFanoutBody: async () => { throw new Error("unexpected fanout"); },
    };
    expect(() => lowerHarnessPlanV2(plan, v2Context(plan), adapters)).toThrow("runtime.v2.approval_checkpointer_required");
    const graph = lowerHarnessPlanV2(plan, v2Context(plan), adapters, new MemorySaver());
    const config = { configurable: { thread_id: "approval-1", checkpoint_ns: plan.planDigest } };
    const suspended = await graph.invoke({ input: { tenantId: "tenant-1", caseId: "case-1" }, values: {} }, config);
    expect(suspended.__interrupt__[0].value).toMatchObject({ type: "harness.approval.v2", nodeId: "approve", caseSnapshotId: snapshot.snapshotId });
    expect(JSON.stringify(suspended.__interrupt__)).not.toContain("case-secret");
    const resumed = await graph.invoke(new Command({ resume: {
      decision: "APPROVE", authority: "HUMAN", decisionId: "decision-1", principalId: "analyst-1", decidedAt: "2026-09-19T12:02:00.000Z",
    } }), config);
    expect(resumed.output).toMatchObject({ decision: "APPROVE", authority: "HUMAN", principalId: "analyst-1" });
  });
});
