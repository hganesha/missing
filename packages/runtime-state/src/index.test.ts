import { describe, expect, it } from "vitest";
import { HttpRuntimeStateStore, RuntimeStateError, fencedRunSchema, nodeStartedSchema } from "./index.js";

const run = { runId: "RUN-1", attempt: 2, workerId: "worker-1", fencingEpoch: 4 };

function recordingFetch(response: Response) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      headers: init.headers as Record<string, string>,
      body: JSON.parse(String(init.body)),
    });
    return response.clone();
  }) as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

function store(response: Response) {
  const { calls, fetchImpl } = recordingFetch(response);
  return {
    calls,
    store: new HttpRuntimeStateStore({
      baseUrl: "http://control",
      serviceToken: "runtime-token",
      executionGrant: "grant-token",
      fetchImpl,
    }),
  };
}

describe("http runtime state store", () => {
  it("sends the fenced run and both credentials with every write", async () => {
    const { calls, store: subject } = store(new Response(null, { status: 204 }));
    await subject.nodeStarted(run, { nodeId: "lookup", inputDigest: "a".repeat(64) });
    expect(calls[0]?.url).toBe("http://control/v1/runtime/state/node-started");
    expect(calls[0]?.headers.authorization).toBe("Bearer runtime-token");
    expect(calls[0]?.headers["x-runtime-grant"]).toBe("grant-token");
    expect(calls[0]?.body).toEqual({ run, nodeId: "lookup", inputDigest: "a".repeat(64) });
  });

  it("refreshes a managed-identity token for every request", async () => {
    const { calls, fetchImpl } = recordingFetch(new Response(null, { status: 204 }));
    let issued = 0;
    const subject = new HttpRuntimeStateStore({
      baseUrl: "http://control",
      serviceToken: async () => `managed-${++issued}`,
      executionGrant: "grant-token",
      fetchImpl,
    });
    await subject.nodeStarted(run, { nodeId: "a", inputDigest: "a".repeat(64) });
    await subject.nodeStarted(run, { nodeId: "b", inputDigest: "b".repeat(64) });
    expect(calls.map((call) => call.headers.authorization)).toEqual(["Bearer managed-1", "Bearer managed-2"]);
  });

  it("asks for the node's case-read envelope with its start and returns it", async () => {
    const { calls, store: subject } = store(Response.json({ caseReadEnvelope: "case-read-envelope", expiresInSeconds: 60 }));
    const started = await subject.nodeStarted(run, { nodeId: "lookup", inputDigest: "a".repeat(64), issueCaseReadEnvelope: true });
    expect(calls[0]?.body).toMatchObject({ issueCaseReadEnvelope: true });
    expect(started).toEqual({ caseReadEnvelope: { envelope: "case-read-envelope", expiresInSeconds: 60 } });
    const plain = store(new Response(null, { status: 204 }));
    await expect(plain.store.nodeStarted(run, { nodeId: "lookup", inputDigest: "a".repeat(64) })).resolves.toBeUndefined();
  });

  it("surfaces a denial rather than continuing silently", async () => {
    // A runtime whose fence moved on must see its journal write refused, not assume it
    // landed and carry on producing effects.
    const { store: subject } = store(new Response(JSON.stringify({ error: "runtime_state.stale_fence" }), { status: 403 }));
    await expect(subject.nodeFinished(run, { nodeId: "lookup", status: "completed" }))
      .rejects.toThrow(RuntimeStateError);
  });

  it("carries digests rather than values across the boundary", () => {
    // The schema is the guarantee: node inputs and outputs never leave the runtime.
    expect(nodeStartedSchema.safeParse({ nodeId: "n", inputDigest: "a".repeat(64), value: { name: "Ada" } }).success)
      .toBe(false);
    expect(fencedRunSchema.safeParse(run).success).toBe(true);
  });
});
