import { describe, expect, it } from "vitest";
import { LocalHttpRuntimeProvider } from "./index.js";

function provider(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET" });
    return handler(String(url), init);
  }) as typeof globalThis.fetch;
  return { calls, subject: new LocalHttpRuntimeProvider("http://host/invocations", "token", fetchImpl) };
}

describe("provider lifecycle", () => {
  it("reports the provider's view of an invocation", async () => {
    const { calls, subject } = provider(() => new Response(JSON.stringify({
      contractVersion: "runtime.status.v1", invocationId: "INV-1", state: "running", providerMetadata: {},
    }), { status: 200 }));
    const status = await subject.getStatus("INV-1");
    expect(status.state).toBe("running");
    expect(calls[0]).toEqual({ url: "http://host/invocations/INV-1", method: "GET" });
  });

  it("reports unknown rather than failed when the provider cannot answer", async () => {
    // "Failed" would licence a retry; the dispatcher must be able to tell the difference
    // between an invocation that failed and one whose outcome was never observed.
    const { subject } = provider(() => new Response("gateway timeout", { status: 504 }));
    expect((await subject.getStatus("INV-1")).state).toBe("unknown");
  });

  it("treats an unknown invocation as already stopped when cancelling", async () => {
    const { subject } = provider(() => new Response(JSON.stringify({ error: "unknown" }), { status: 404 }));
    await expect(subject.cancel("INV-1", "operator_request")).resolves.toBeUndefined();
  });

  it("surfaces a cancellation the provider refused", async () => {
    const { subject } = provider(() => new Response("nope", { status: 500 }));
    await expect(subject.cancel("INV-1", "operator_request")).rejects.toThrow("runtime.cancel_http_500");
  });
});
