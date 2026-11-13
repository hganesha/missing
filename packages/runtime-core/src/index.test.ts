import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { harnessPlanV2Schema, stableDigest, type HarnessPlanV2 } from "@ehf/contracts";
import {
  executeObservedNode,
  admitHarnessPlanV2, aggregateValue, evaluateCondition, executeBoundedFanout, executePolicyGate,
  getPath, invokeCapability, materializeTemplate, renderTemplate, transformValue,
  v2ExecutionEdges, type RuntimeContext,
} from "./index.js";

const digest = "a".repeat(64);

function v2Plan(
  nodes: HarnessPlanV2["graph"]["nodes"],
  options: {
    adapterVersion?: string;
    edges?: HarnessPlanV2["graph"]["edges"];
  } = {},
): HarnessPlanV2 {
  const content = {
    apiVersion: "harness.factory/plan-v2" as const,
    kind: "HarnessPlan" as const,
    packageDigest: digest,
    compiler: { name: "harnessc" as const, version: "2.0.0", digest, compatibilityVersion: "4", lgirCoreRevision: "abcdef0" },
    metadata: { name: "runtime-test", version: "2.0.0", domain: "test", objective: "Exercise v2 runtime" },
    execution: {
      engine: {
        kind: "harness-runtime" as const,
        adapterVersion: options.adapterVersion ?? "harness-runtime-v2",
        profile: "production-v2",
      },
      coordinationMode: "caseStore" as const,
      maxTransitions: 100,
      maxConcurrency: 4,
      durability: "durable" as const,
    },
    budgets: { maxDurationMs: 60_000, maxCostUsd: 1, maxModelCalls: 4, maxCapabilityCalls: 8 },
    schemas: { input: { type: "object" }, output: { type: "object" }, schemaSetDigest: digest },
    modelProfiles: [], agentProfiles: [], capabilities: [], permissionEnvelopes: [],
    policyBundles: [{ policyId: "policy.test", bundleDigest: digest }],
    contextSelectors: [{ id: "subject", source: "case" as const, path: "case.subject", purpose: "TEST", classification: "CONFIDENTIAL", required: true }],
    contextClassificationPolicies: [{ classification: "CONFIDENTIAL", action: "allow" as const }],
    graph: { apiVersion: "ladder.dev/v1alpha1" as const, name: "runtime-test", nodes, edges: options.edges ?? [], nodeOrder: nodes.map((node) => node.id) },
    releaseConstraints: { regions: ["US"], dataClasses: ["CONFIDENTIAL"], evaluationRequirementIds: ["runtime"] },
    dependencyManifest: [{ kind: "policy", id: "policy.test", digest }],
    dependencyManifestDigest: digest,
    createdAt: "2026-09-19T12:00:00.000Z",
    buildProvenanceDigest: digest,
  };
  return harnessPlanV2Schema.parse({ ...content, planId: "plan_runtime_v2", planDigest: stableDigest(content) });
}

describe("runtime primitives", () => {
  const state = { input: { name: "Ada", risk: "high" }, values: [1, 2] };
  it("selects paths and renders prompts", () => {
    expect(getPath(state, "input.name")).toBe("Ada");
    expect(renderTemplate("Review {{ input.name }}", state)).toBe("Review Ada");
  });
  it("does not resolve inherited properties or backtrack over malformed templates", () => {
    expect(getPath({}, "constructor.prototype")).toBeUndefined();
    expect(getPath(Object.create({ hidden: "not-own" }), "hidden")).toBeUndefined();
    const malformed = "{{".repeat(20_000) + " ".repeat(20_000);
    expect(renderTemplate(malformed, {})).toBe(malformed);
    expect(materializeTemplate(malformed, {})).toBe(malformed);
    expect(renderTemplate("{{ input.name }} {{ values }}", state)).toBe("Ada [1,2]");
    expect(evaluateCondition("input.name == " + " ".repeat(20_000), state)).toBe(false);
    expect(evaluateCondition("input.name == \"Ada\"", state)).toBe(true);
    // A conjunction holds only when every comparison does.
    expect(evaluateCondition("input.name == \"Ada\" && input.name != \"Bob\"", state)).toBe(true);
    expect(evaluateCondition("input.name == \"Ada\" && input.missing == \"x\"", state)).toBe(false);
  });
  it("evaluates the constrained condition language", () => {
    expect(evaluateCondition("input.risk == high", state)).toBe(true);
    expect(evaluateCondition("input.risk != low", state)).toBe(true);
  });
  it("runs deterministic transforms", () => {
    expect(transformValue({ operation: "select", path: "input.name" }, state)).toBe("Ada");
    expect(transformValue({ operation: "deduplicate", path: "id" }, [{ id: 2 }, { id: 1 }, { id: 2 }])).toEqual([{ id: 2 }, { id: 1 }]);
    expect(transformValue({ operation: "sort", path: "score", direction: "desc" }, [{ score: 2 }, { score: 5 }, { score: 1 }])).toEqual([{ score: 5 }, { score: 2 }, { score: 1 }]);
    expect(transformValue({ operation: "slice", start: 1, end: 3 }, ["a", "b", "c", "d"])).toEqual(["b", "c"]);
  });
  it("runs deterministic aggregators", () => {
    expect(aggregateValue({ operation: "collect" }, { left: 1, right: 2 })).toEqual([1, 2]);
    expect(aggregateValue({ operation: "merge" }, [{ a: 1 }, { b: 2 }])).toEqual({ a: 1, b: 2 });
    expect(aggregateValue({ operation: "concat" }, { left: [1, 2], right: [3] })).toEqual([1, 2, 3]);
    expect(aggregateValue({ operation: "vote", path: "decision" }, [{ decision: "approve" }, { decision: "deny" }, { decision: "approve" }])).toBe("approve");
  });
  it("materializes native case-write payload values", () => {
    expect(materializeTemplate({
      subjectRef: "{{ case.subjectId }}",
      findingRefs: "{{ output.findingRefs }}",
      evidenceRefs: ["{{ evidence.evidenceId }}"],
      rationale: "Decision for {{ case.subjectId }}",
    }, {
      case: { subjectId: "subject_1" },
      output: { findingRefs: ["finding_1"] },
      evidence: { evidenceId: "ev_1" },
    })).toEqual({
      subjectRef: "subject_1",
      findingRefs: ["finding_1"],
      evidenceRefs: ["ev_1"],
      rationale: "Decision for subject_1",
    });
  });
});

describe("capability invocation authority", () => {
  const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(
    new URL("../../contracts/test-fixtures/conformance.plan.json", import.meta.url),
    "utf8",
  )));

  function context(): RuntimeContext {
    return {
      state: {
        nodeStarted: async () => {},
        nodeFinished: async () => {},
        appendEvent: async () => {},
        markCheckpoint: async () => {},
      },
      plan,
      runId: "RUN-1",
      runAttempt: 2,
      workerId: "worker-1",
      fencingEpoch: 4,
      gatewayUrl: "http://gateway",
      envelopeBrokerUrl: "http://control",
      executionGrant: "grant-token",
      serviceToken: "runtime-service-token",
    };
  }

  it("exchanges the grant for an envelope and presents both credentials", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), headers: init.headers as Record<string, string> });
      if (String(url).includes("/v1/runtime/envelopes")) {
        return new Response(JSON.stringify({ envelope: "envelope-token", expiresInSeconds: 60, caseWrites: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        invocationId: "x", capabilityId: "vendor.lookup", status: "succeeded", output: {},
        errorCode: null, provider: "simulator", model: "vendor.lookup", providerRequestId: null,
        usage: { inputTokens: null, outputTokens: null, costUsd: 0 }, latencyMs: 1, receiptDigest: "a".repeat(64),
      }), { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      const result = await invokeCapability(context(), "lookup", { vendorName: "acme" });
      expect(result.status).toBe("succeeded");
    } finally {
      globalThis.fetch = original;
    }
    // The runtime holds no signing key: authority is fetched, and the gateway receives
    // the workload credential and the envelope in separate headers.
    expect(calls[0]?.url).toContain("/v1/runtime/envelopes");
    expect(calls[0]?.headers["x-runtime-grant"]).toBe("grant-token");
    expect(calls[1]?.url).toContain("/v1/invoke");
    expect(calls[1]?.headers.authorization).toBe("Bearer runtime-service-token");
    expect(calls[1]?.headers["x-execution-envelope"]).toBe("envelope-token");
  });

  it("resolves an async workload credential for both broker and gateway calls", async () => {
    const authorizations: string[] = [];
    let tokenCalls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      authorizations.push(String((init.headers as Record<string, string>).authorization));
      if (String(url).includes("/v1/runtime/envelopes")) {
        return new Response(JSON.stringify({ envelope: "envelope-token", expiresInSeconds: 60, caseWrites: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        invocationId: "x", capabilityId: "vendor.lookup", status: "succeeded", output: {},
        errorCode: null, provider: "simulator", model: "vendor.lookup", providerRequestId: null,
        usage: { inputTokens: null, outputTokens: null, costUsd: 0 }, latencyMs: 1, receiptDigest: "a".repeat(64),
      }), { status: 200 });
    }) as typeof globalThis.fetch;
    const runtimeContext = context();
    runtimeContext.serviceToken = async () => `managed-token-${++tokenCalls}`;
    try {
      await invokeCapability(runtimeContext, "lookup", { vendorName: "acme" });
    } finally {
      globalThis.fetch = original;
    }
    expect(authorizations).toEqual(["Bearer managed-token-1", "Bearer managed-token-2"]);
  });

  it("does not call the gateway when the broker refuses", async () => {
    const original = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ error: "broker.stale_fence" }), { status: 403 });
    }) as typeof globalThis.fetch;
    try {
      await expect(invokeCapability(context(), "lookup", { vendorName: "acme" })).rejects.toThrow("broker.stale_fence");
    } finally {
      globalThis.fetch = original;
    }
    expect(urls.filter((url) => url.includes("/v1/invoke"))).toEqual([]);
  });
});

describe("v2 runtime admission", () => {
  it("admits the certified adapter target and rejects a version mismatch", () => {
    const nodes = [{ id: "input", kind: "input" as const, name: "Input", contextSelectorIds: [], config: {} }];
    expect(admitHarnessPlanV2(v2Plan(nodes)).execution.engine.adapterVersion).toBe("harness-runtime-v2");
    expect(() => admitHarnessPlanV2(v2Plan(nodes, { adapterVersion: "harness-langgraph-v2" })))
      .toThrow("runtime.v2.adapter_unsupported");
  });

  it.each(["loop", "teacher"] as const)("fails closed for unsupported %s semantics", (kind) => {
    const plan = v2Plan([{ id: "unsupported", kind, name: kind, contextSelectorIds: [], config: {} }]);
    expect(() => admitHarnessPlanV2(plan)).toThrow(`runtime.v2.node_kind_unsupported:${kind}`);
  });

  it("admits native groups and expands their scheduler boundary", () => {
    const plan = v2Plan([
      { id: "input", kind: "input", name: "Input", contextSelectorIds: [], config: {} },
      { id: "left", kind: "transform", name: "Left", contextSelectorIds: [], config: { operation: "identity" } },
      { id: "right", kind: "transform", name: "Right", contextSelectorIds: [], config: { operation: "identity" } },
      { id: "checks", kind: "group", name: "Checks", contextSelectorIds: [], config: { members: ["left", "right"], execution: "parallel", exit: "aggregate" } },
      { id: "output", kind: "output", name: "Output", contextSelectorIds: [], config: {} },
    ], { edges: [
      { id: "e1", from: "input", to: "checks", kind: "data" },
      { id: "e2", from: "checks", to: "output", kind: "data" },
    ] });
    expect(admitHarnessPlanV2(plan)).toBeDefined();
    expect(v2ExecutionEdges(plan).map((edge) => `${edge.from}->${edge.to}`)).toEqual(expect.arrayContaining([
      "input->left", "input->right", "left->checks", "right->checks", "checks->output",
    ]));
  });

  it("admits an explicitly mapped native subgraph", () => {
    const plan = v2Plan([{
      id: "child", kind: "subgraph", name: "Child", contextSelectorIds: [],
      config: { subgraph: { ref: "host:verification", inputMap: { request: "/input" }, outputMap: { result: "/output" }, checkpointer: "inherit" } },
    }]);
    expect(admitHarnessPlanV2(plan)).toBeDefined();
  });

  it("rejects implicit cyclic loop semantics", () => {
    const nodes = [
      { id: "left", kind: "transform" as const, name: "Left", contextSelectorIds: [], config: { operation: "identity" } },
      { id: "right", kind: "transform" as const, name: "Right", contextSelectorIds: [], config: { operation: "identity" } },
    ];
    const plan = v2Plan(nodes, { edges: [
      { id: "e1", from: "left", to: "right", kind: "data" },
      { id: "e2", from: "right", to: "left", kind: "data" },
    ] });
    expect(() => admitHarnessPlanV2(plan)).toThrow("runtime.v2.graph_cycle_unsupported");
  });

  it("rejects fanout bounds wider than the plan concurrency envelope", () => {
    const plan = v2Plan([{
      id: "fan", kind: "fanout", name: "Fan", contextSelectorIds: [],
      config: { itemsPath: "items", bodyRef: "body", maxItems: 10, maxConcurrency: 5, joinMode: "all" },
    }]);
    expect(() => admitHarnessPlanV2(plan)).toThrow("runtime.v2.fanout_concurrency_exceeds_plan:fan");
  });

  it("admits v2 case writes for snapshot-authorized execution", () => {
    const plan = v2Plan([{
      id: "write", kind: "transform", name: "Write", contextSelectorIds: [],
      config: { operation: "identity", caseWrites: [{ commandType: "ProposeClaim", payload: {} }] },
    }]);
    expect(admitHarnessPlanV2(plan).graph.nodes[0]?.config.caseWrites).toHaveLength(1);
  });
});

describe("bounded v2 fanout", () => {
  it("enforces maxItems before starting work and caps live concurrency", async () => {
    let calls = 0;
    await expect(executeBoundedFanout({
      items: [1, 2, 3], maxItems: 2, maxConcurrency: 1, joinMode: "all",
      execute: async () => { calls += 1; },
    })).rejects.toThrow("runtime.fanout_max_items_exceeded");
    expect(calls).toBe(0);

    let active = 0;
    let highWater = 0;
    const values = await executeBoundedFanout({
      items: [0, 1, 2, 3, 4], maxItems: 5, maxConcurrency: 2, joinMode: "all",
      execute: async (item) => {
        active += 1;
        highWater = Math.max(highWater, active);
        await new Promise((resolve) => setTimeout(resolve, 3));
        active -= 1;
        return item * 2;
      },
    });
    expect(values).toEqual([0, 2, 4, 6, 8]);
    expect(highWater).toBe(2);
  });

  it("preserves index order for allSettled and fails all with the lowest-index started error", async () => {
    const settled = await executeBoundedFanout({
      items: [0, 1, 2], maxItems: 3, maxConcurrency: 3, joinMode: "allSettled",
      execute: async (item) => {
        if (item === 1) throw new Error("vendor.timeout");
        return `ok-${item}`;
      },
    });
    expect(settled).toEqual([
      { status: "fulfilled", value: "ok-0" },
      { status: "rejected", reason: { code: "vendor.timeout", message: "vendor.timeout" } },
      { status: "fulfilled", value: "ok-2" },
    ]);

    await expect(executeBoundedFanout({
      items: [0, 1, 2], maxItems: 3, maxConcurrency: 3, joinMode: "all",
      execute: async (item) => {
        if (item === 0) { await new Promise((resolve) => setTimeout(resolve, 4)); throw new Error("failure.zero"); }
        if (item === 1) throw new Error("failure.one");
        return item;
      },
    })).rejects.toThrow("failure.zero");
  });

  it("returns the first successful result, cancels siblings, and honors external cancellation", async () => {
    let siblingCancelled = false;
    const first = await executeBoundedFanout({
      items: [0, 1], maxItems: 2, maxConcurrency: 2, joinMode: "first",
      execute: async (item, _index, signal) => {
        if (item === 1) return "winner";
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => { siblingCancelled = true; resolve(); }, { once: true }));
        throw new Error("runtime.cancelled");
      },
    });
    expect(first).toBe("winner");
    expect(siblingCancelled).toBe(true);

    const controller = new AbortController();
    const pending = executeBoundedFanout({
      items: [0, 1], maxItems: 2, maxConcurrency: 2, joinMode: "allSettled", signal: controller.signal,
      execute: async (_item, _index, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("cancelled item")), { once: true });
      }),
    });
    controller.abort();
    await expect(pending).rejects.toThrow("runtime.cancelled");
  });
});

describe("v2 gate authority isolation", () => {
  it("passes only compiled selectors and rejects a receipt bound to another snapshot", async () => {
    const plan = v2Plan([{
      id: "gate", kind: "gate", name: "Gate", contextSelectorIds: ["subject"],
      config: { policyRef: "policy.test", gateId: "disposition" },
    }]);
    const snapshotCanonical = {
      apiVersion: "harness.factory/case-snapshot-v1" as const,
      kind: "CaseSnapshot" as const,
      tenantId: "tenant-1", caseId: "case-1",
      caseSequence: 7, dependencyDigest: "c".repeat(64), planDigest: plan.planDigest,
      policyAuthority: { policyId: "policy.test", policyVersion: "1", policySnapshotDigest: "d".repeat(64), policyBundleDigest: digest },
      consistency: "strong" as const, classification: "CONFIDENTIAL",
      data: { case: { subject: { id: "subject-1" }, secret: "never-forward" }, evidence: [{ secret: "also-hidden" }] },
    };
    const snapshotDigest = stableDigest(snapshotCanonical);
    const snapshot = {
      ...snapshotCanonical,
      snapshotId: `snapshot_${snapshotDigest}`,
      snapshotDigest,
      capturedAt: "2026-09-19T12:00:00.000Z",
    };
    let observed = "";
    const evaluator = async (request: Parameters<typeof executePolicyGate>[3] extends (...args: infer A) => unknown ? A[0] : never) => {
      observed = JSON.stringify(request);
      expect(Object.isFrozen(request)).toBe(true);
      expect(request.input).toEqual({ subject: { id: "subject-1" } });
      return {
        apiVersion: "harness.factory/policy-evaluation-v1", kind: "PolicyEvaluation", evaluationId: "evaluation-1",
        tenantId: "tenant-1", caseId: "case-1", caseSequence: 7, caseSnapshotDigest: snapshot.snapshotDigest,
        dependencyDigest: snapshot.dependencyDigest, policyBundleDigest: digest, gateId: "disposition",
        inputDigest: request.inputDigest, outcome: "ALLOW", ruleResults: [], reasonCodes: ["AUTHORIZED"],
        obligations: [], evidenceRefs: [], evaluatedAt: "2026-09-19T12:01:00.000Z", receiptDigest: "e".repeat(64),
      };
    };
    expect(await executePolicyGate(plan, "gate", snapshot, evaluator)).toMatchObject({ outcome: "ALLOW" });
    expect(observed).not.toContain("never-forward");
    expect(observed).not.toContain("also-hidden");

    await expect(executePolicyGate(plan, "gate", snapshot, async (request) => ({
      ...(await evaluator(request)), caseSnapshotDigest: "f".repeat(64),
    }))).rejects.toThrow("runtime.v2.gate_evaluation_authority_mismatch");

    await expect(executePolicyGate(plan, "gate", {
      ...snapshot, data: { ...snapshot.data, case: { subject: { id: "tampered" } } },
    }, evaluator)).rejects.toThrow("runtime.v2.snapshot_digest_invalid");
  });
});

describe("case-read envelope issued with the node's start", () => {
  const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../../artifacts/archive/kyc-v2.plan.json", import.meta.url), "utf8")));

  function context(requests: unknown[], response?: { envelope: string; expiresInSeconds: number }) {
    const caseReadEnvelopes = new Map<string, { envelope: string; expiresAt: number }>();
    const ctx: RuntimeContext = {
      state: {
        nodeStarted: async (_run, input) => { requests.push(input); return response ? { caseReadEnvelope: response } : undefined; },
        nodeFinished: async () => {},
        appendEvent: async () => {},
        markCheckpoint: async () => {},
      },
      plan, runId: "RUN-1", runAttempt: 1, workerId: "worker-1", fencingEpoch: 1,
      gatewayUrl: "http://gateway", envelopeBrokerUrl: "http://control", executionGrant: "grant-token",
      serviceToken: "runtime-service-token", caseReadEnvelopes,
    };
    return { ctx, caseReadEnvelopes };
  }

  it("asks for it only on nodes that read the case, and keeps it for the read", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const { ctx, caseReadEnvelopes } = context(requests, { envelope: "read-envelope", expiresInSeconds: 60 });
    await executeObservedNode(ctx, "policy-authority", {}, async () => "ok");
    await executeObservedNode(ctx, "intake", {}, async () => "ok");
    expect(requests.map((request) => request.issueCaseReadEnvelope)).toEqual([true, undefined]);
    expect(caseReadEnvelopes.get("policy-authority")?.envelope).toBe("read-envelope");
    expect(caseReadEnvelopes.get("policy-authority")!.expiresAt).toBeGreaterThan(Date.now() + 50_000);
  });

  it("does not ask when the runtime keeps no envelope cache", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const { ctx } = context(requests);
    delete ctx.caseReadEnvelopes;
    await executeObservedNode(ctx, "policy-authority", {}, async () => "ok");
    expect(requests[0]?.issueCaseReadEnvelope).toBeUndefined();
  });
});
