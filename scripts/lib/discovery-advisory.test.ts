import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { compilePackage } from "../../packages/compiler/src/index.js";
import { invokeModel, invokeSimulator, loadModelProfiles } from "../../packages/adapters/src/index.js";
import { discoveryFixtureCompany, discoveryModelCapabilityId, stableDigest, validateDiscoveryAdvisoryOutput } from "../../packages/contracts/src/index.js";
import { admitHarnessPlanV2 } from "../../packages/runtime-core/src/index.js";
import { buildRuntimeHost } from "../../apps/runtime-host/src/app.js";
import { executeRuntimeInvocation } from "../../apps/runtime-host/src/executor.js";

const local = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const registry = local("../../config/model-profiles.json");
const plan = admitHarnessPlanV2(JSON.parse(compilePackage(local("../../domains/discovery-advisory"), { modelProfiles: registry }).document));

afterEach(() => vi.unstubAllGlobals());

it("runs hosted Recon from the synthetic search seed without loading or writing a case", async () => {
  expect(plan.agentProfiles[0]).toMatchObject({ id: "agent.reconnaissance", runtimeTarget: "hosted_http", caseWrites: [] });
  expect(plan.policyBundles).toEqual([]);
  expect(plan.contextSelectors).toEqual([]);

  const profile = (await loadModelProfiles(registry)).find(model => model.id === "model.standard.v1")!;
  const invoked: string[] = [];
  const attempts: Array<{ capabilityId: string; input: unknown }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    if (String(url).includes("/v1/runtime/envelopes")) return Response.json({ envelope: "advisory-envelope", expiresInSeconds: 60, caseWrites: [] });
    const request = JSON.parse(String(init.body)) as { capabilityId: string; input: unknown; invocationId: string };
    attempts.push(request);
    invoked.push(request.capabilityId);
    const result = request.capabilityId === discoveryModelCapabilityId
      ? await invokeModel({ profile, capabilityId: request.capabilityId, input: request.input, providerBinding: {
        kind: "recorded", baseUrl: null, siteUrl: null, appName: null, status: "active",
      } })
      : await invokeSimulator("discovery.public.search", request.input);
    const unsigned = {
      invocationId: request.invocationId, capabilityId: request.capabilityId, status: "succeeded",
      output: result.output, errorCode: null, provider: result.provider, model: result.model, providerRequestId: null,
      usage: { inputTokens: null, outputTokens: null, costUsd: 0 }, latencyMs: 1,
    };
    return Response.json({ ...unsigned, receiptDigest: stableDigest(unsigned) });
  });
  const forbidden = async () => { throw new Error("Unexpected case access or policy evaluation"); };
  const host = buildRuntimeHost({
    authToken: "test-runtime",
    execute: (request, signal) => executeRuntimeInvocation(request, {
      gatewayUrl: "http://gateway", controlPlaneUrl: "http://control", serviceToken: "service-token",
      createStateStore: () => ({ nodeStarted: async () => {}, nodeFinished: async () => {}, appendEvent: async () => {}, markCheckpoint: async () => {} }),
      v2Adapters: { loadCaseSnapshot: forbidden, evaluateGate: forbidden, executeFanoutBody: forbidden },
    }, signal),
  });
  const input = { tenantId: "demo-tenant", caseId: `recon_${"a".repeat(64)}`, seed: { companyName: discoveryFixtureCompany, country: "GB" } };
  const values: Record<string, unknown> = {};
  try {
    for (const nodeId of plan.graph.nodeOrder) {
      const response = await host.inject({ method: "POST", url: "/invocations", headers: { authorization: "Bearer test-runtime" },
        payload: {
          contractVersion: "runtime.invocation.v3", invocationId: `recon-${nodeId}`, runId: "recon-run", attempt: 1,
          workerId: "worker", leaseId: "lease", fencingEpoch: 1, deadlineAt: new Date(Date.now() + 30_000).toISOString(),
          planDigest: plan.planDigest, executionProfileDigest: "b".repeat(64), executionGrant: "grant", plan, input,
          nodeExecution: { nodeId, workItemId: `work-${nodeId}`, fencingEpoch: 1, predecessorValues: values, predecessorSettlements: {} },
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ status: "completed" });
      values[nodeId] = response.json().output;
    }
  } finally {
    await host.close();
  }
  expect(invoked).toEqual(["discovery.public.search.v1", discoveryModelCapabilityId]);
  expect(attempts[0]?.input).toEqual(input.seed);
  const synthesis = attempts[1]?.input as { prompt: string };
  expect(synthesis.prompt).toContain("optional analyst follow-up");
  expect(synthesis.prompt).toContain("operating loss");
  expect(synthesis.prompt).not.toContain(input.caseId);
  expect(synthesis.prompt).not.toContain(input.tenantId);
  const output = validateDiscoveryAdvisoryOutput(values["advisory-output"]);
  expect(output.search.queries).toHaveLength(4);
  for (const term of ["bankruptcy", "operating loss", "credit rating downgrade"]) {
    expect(output.search.queries.join(" ")).toContain(`"${term}"`);
  }
  expect(output.draft.signals.map(signal => signal.category)).toEqual(["bankruptcy", "financial_losses", "credit_rating"]);
  const inventedCitation = structuredClone(output);
  inventedCitation.draft.signals[0]!.sourceIds = ["fabricated"];
  expect(() => validateDiscoveryAdvisoryOutput(inventedCitation)).toThrow("discovery.source_reference_missing");
});

it("refuses a discovery plan with case evidence capture before execution", () => {
  const { planId, planDigest: _digest, ...content } = structuredClone(plan);
  content.graph.nodes.find(node => node.id === "synthesize")!.config.evidenceCapture = { type: "model_context" };
  expect(() => admitHarnessPlanV2({ ...content, planId, planDigest: stableDigest(content) }))
    .toThrow("runtime.v2.discovery_case_authority_forbidden");
});
