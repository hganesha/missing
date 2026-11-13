import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { harnessPlanV2Schema, type RuntimeInvocationV2 } from "@ehf/contracts";
import { HostedHttpRuntimeProvider, LocalHttpRuntimeProvider } from "./index.js";

function invocation(executionProfileDigest: string): RuntimeInvocationV2 {
  const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(
    new URL("../../contracts/test-fixtures/conformance.plan.json", import.meta.url),
    "utf8",
  )));
  return {
    contractVersion: "runtime.invocation.v2",
    invocationId: "INV-conformance",
    runId: "RUN-conformance",
    attempt: 1,
    workerId: "worker-1",
    leaseId: "RUN-conformance:1:1",
    fencingEpoch: 1,
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    planDigest: plan.planDigest,
    executionProfileDigest,
    executionGrant: "short-lived-grant",
    plan,
    input: { caseId: "CASE-1" },
  };
}

function completed(request: RuntimeInvocationV2, providerMetadata: Record<string, string> = {}) {
  return {
    contractVersion: "runtime.result.v1" as const,
    invocationId: request.invocationId,
    runId: request.runId,
    status: "completed" as const,
    output: { ok: true },
    errorCode: null,
    checkpointId: null,
    providerMetadata,
  };
}

describe("RuntimeInvocation provider conformance", () => {
  it("preserves the local provider request and result wire contract", async () => {
    let received: unknown;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      received = JSON.parse(String(init.body));
      return Response.json(completed(received as RuntimeInvocationV2));
    }) as typeof globalThis.fetch;
    const provider = new LocalHttpRuntimeProvider("http://runtime/invocations", "token", fetchImpl);
    const request = invocation(provider.executionProfileDigest);

    await expect(provider.invoke(request, new AbortController().signal)).resolves.toMatchObject({
      invocationId: request.invocationId,
      status: "completed",
    });
    expect(received).toEqual(request);
  });

  it("speaks the same wire contract to a hosted runtime, with a fresh workload token per call", async () => {
    const calls: Array<{ url: string; authorization: string | null; body: unknown }> = [];
    let issued = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, authorization: new Headers(init.headers).get("authorization"), body });
      return Response.json(completed(body as RuntimeInvocationV2));
    }) as typeof globalThis.fetch;
    const provider = new HostedHttpRuntimeProvider("https://runtime.example.test/invocations", async () => `projected-${++issued}`, fetchImpl);
    const request = invocation(provider.executionProfileDigest);
    await provider.invoke(request, new AbortController().signal);
    await provider.invoke(request, new AbortController().signal);
    expect(calls.map((call) => call.authorization)).toEqual(["Bearer projected-1", "Bearer projected-2"]);
    expect(calls[0]?.body).toEqual(request);
    expect(provider.executionProfileDigest).not.toBe(new LocalHttpRuntimeProvider("https://runtime.example.test/invocations", "t").executionProfileDigest);
  });

  it("rejects a result correlated to another invocation", async () => {
    const fetchImpl = (async () => Response.json({
      contractVersion: "runtime.result.v1",
      invocationId: "INV-other",
      runId: "RUN-conformance",
      status: "completed",
      output: null,
      errorCode: null,
      checkpointId: null,
      providerMetadata: {},
    })) as typeof globalThis.fetch;
    const provider = new LocalHttpRuntimeProvider("http://runtime/invocations", "token", fetchImpl);
    await expect(provider.invoke(invocation(provider.executionProfileDigest), new AbortController().signal))
      .rejects.toThrow("runtime.result_correlation_mismatch");
  });
});
