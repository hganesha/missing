import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { traceFoundryModelFetch } from "./foundry-model.js";

const telemetry = vi.hoisted(() => ({
  span: { setAttribute: vi.fn(), setStatus: vi.fn() },
  withSpan: vi.fn(),
}));

vi.mock("@ehf/telemetry", () => ({
  withSpan: (name: unknown, options: unknown, callback: (span: typeof telemetry.span) => unknown) => {
    telemetry.withSpan(name, options);
    return callback(telemetry.span);
  },
  injectTraceContext: (headers: Record<string, string>) => {
    headers.traceparent = "00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01";
    headers.tracestate = "ehf=state";
    headers.baggage = "subject=secret";
  },
  SpanKind: { CLIENT: 2 },
  SpanStatusCode: { OK: 1, ERROR: 2 },
}));

const configuredEndpoint = "https://test.services.ai.azure.com/openai/v1";

describe("Foundry model transport", () => {
  it("instruments an outbound attempt while keeping request and response contents out of telemetry", async () => {
    const requestId = randomUUID();
    const response = Response.json({
      id: "chatcmpl-safe", content: "response contains a secret",
      usage: { prompt_tokens: 7, completion_tokens: 4 },
    }, { headers: { "apim-request-id": requestId } });
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const traced = traceFoundryModelFetch({ configuredEndpoint, bindingEndpoint: `${configuredEndpoint}/`, model: "test-deployment", fetch })!;
    const result = await traced(`${configuredEndpoint}/chat/completions`, {
      method: "POST", headers: { authorization: "Bearer key", baggage: "subject=secret" },
      body: JSON.stringify({ prompt: "input contains a secret" }),
    });
    const [, init] = fetch.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer key");
    expect(headers.get("traceparent")).toBe("00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01");
    expect(headers.get("tracestate")).toBe("ehf=state");
    expect(headers.has("baggage")).toBe(false);
    expect(init?.redirect).toBe("error");
    expect(await result.json()).toMatchObject({ id: "chatcmpl-safe" });
    expect(telemetry.withSpan).toHaveBeenCalledWith("foundry.model.call", expect.objectContaining({
      attributes: expect.objectContaining({ "gen_ai.provider.name": "azure.ai.openai", "gen_ai.request.model": "test-deployment" }),
    }));
    expect(telemetry.span.setAttribute).toHaveBeenCalledWith("gen_ai.response.id", "chatcmpl-safe");
    expect(telemetry.span.setAttribute).toHaveBeenCalledWith("gen_ai.request.id", requestId);
    expect(telemetry.span.setAttribute).toHaveBeenCalledWith("gen_ai.usage.input_tokens", 7);
    expect(telemetry.span.setAttribute).toHaveBeenCalledWith("gen_ai.usage.output_tokens", 4);
    expect(JSON.stringify(telemetry.span.setAttribute.mock.calls)).not.toContain("secret");
  });

  it("keeps generic compatible bindings unchanged and prevents context forwarding to another origin", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    expect(traceFoundryModelFetch({ configuredEndpoint, bindingEndpoint: "https://other.openai.azure.com/openai/v1", model: "m", fetch })).toBe(fetch);
    const traced = traceFoundryModelFetch({ configuredEndpoint, bindingEndpoint: configuredEndpoint, model: "m", fetch })!;
    await expect(traced("https://other.openai.azure.com/openai/v1/chat/completions")).rejects.toThrow("adapter.foundry_model_target_mismatch");
    expect(fetch).not.toHaveBeenCalled();
  });
});
