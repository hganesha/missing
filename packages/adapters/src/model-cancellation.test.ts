import { describe, expect, it, vi } from "vitest";
import { invokeModel } from "./index.js";

describe.each(["openrouter", "anthropic"] as const)("%s cancellation", provider => {
  const providerBinding = { kind: provider, baseUrl: null, siteUrl: null, appName: null, status: "active" as const };
  it.each([undefined, { type: "object", properties: { answer: { type: "string" } } }])("propagates caller cancellation to model generation (schema=%j)", async outputSchema => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const controller = new AbortController(); controller.abort(new Error("draft_test.cancelled"));
    await expect(invokeModel({
      profile: { id: "test", provider: "openrouter", model: "test-model", maxOutputTokens: 50, timeoutMs: 1000, maxConcurrency: 1 },
      providerBinding, input: { prompt: "Test cancellation" }, apiKey: "test-only", fetch, signal: controller.signal,
      ...(outputSchema ? { outputSchema } : {}),
    })).rejects.toThrow(/cancelled|aborted/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts a model request already in flight", async () => {
    const controller = new AbortController();
    let arrived!: () => void;
    const started = new Promise<void>(resolve => { arrived = resolve; });
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      const signal = init?.signal;
      arrived();
      return new Promise<Response>((_resolve, reject) => {
        if (signal?.aborted) reject(signal.reason);
        else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const result = invokeModel({
      profile: { id: "test", provider: "openrouter", model: "test-model", maxOutputTokens: 50, timeoutMs: 1000, maxConcurrency: 1 },
      providerBinding, input: { prompt: "Test cancellation" }, apiKey: "test-only", fetch, signal: controller.signal,
    });
    await started;
    controller.abort(new Error("draft_test.cancelled"));
    await expect(result).rejects.toThrow(/cancelled|aborted/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

});
