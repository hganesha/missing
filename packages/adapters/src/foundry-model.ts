import { injectTraceContext, SpanKind, SpanStatusCode, withSpan } from "@ehf/telemetry";

const MODEL_ENDPOINT = /^https:\/\/[a-z0-9-]+\.(?:services\.ai|openai|cognitiveservices)\.azure\.com\/openai\/v1\/?$/i;
const MODEL_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/i;
const PROVIDER_ID = /^(?:chatcmpl[-_]|resp_)[a-z0-9_-]{1,191}$/i;
const REQUEST_ID = /^[a-f0-9-]{16,64}$/i;
const METADATA_LIMIT = 256 * 1024;

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function modelMetadata(response: Response) {
  if (!response.headers.get("content-type")?.includes("application/json")) return null;
  const reader = response.clone().body?.getReader();
  if (!reader) return null;
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > METADATA_LIMIT) return null;
      chunks.push(chunk.value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      id?: unknown;
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    return {
      responseId: typeof data.id === "string" && PROVIDER_ID.test(data.id) ? data.id : undefined,
      inputTokens: tokenCount(data.usage?.prompt_tokens),
      outputTokens: tokenCount(data.usage?.completion_tokens),
    };
  } catch {
    return null;
  } finally {
    // The clone's cancellation can wait for the SDK's branch to finish reading.
    void reader.cancel().catch(() => undefined);
  }
}

/** A reviewed Foundry endpoint enables tracing only for requests to that model origin. */
export function traceFoundryModelFetch(input: {
  configuredEndpoint?: string | undefined;
  bindingEndpoint: string;
  model: string;
  fetch?: typeof globalThis.fetch | undefined;
}): typeof globalThis.fetch | undefined {
  if (!input.configuredEndpoint || !MODEL_ENDPOINT.test(input.configuredEndpoint)
    || !MODEL_ENDPOINT.test(input.bindingEndpoint)) return input.fetch;
  const configured = new URL(input.configuredEndpoint);
  const actual = new URL(input.bindingEndpoint);
  if (configured.origin !== actual.origin) return input.fetch;
  const fetcher = input.fetch ?? globalThis.fetch;
  return async (resource, init) => {
    const url = new URL(resource instanceof Request ? resource.url : resource.toString());
    if (url.origin !== configured.origin || url.pathname !== "/openai/v1/chat/completions"
      || url.username || url.password || url.search || url.hash) throw new Error("adapter.foundry_model_target_mismatch");
    return withSpan("foundry.model.call", { kind: SpanKind.CLIENT, attributes: {
      "gen_ai.provider.name": "azure.ai.openai",
      "gen_ai.operation.name": "chat",
      ...(MODEL_NAME.test(input.model) ? { "gen_ai.request.model": input.model } : {}),
    } }, async (span) => {
      const carrier: Record<string, string> = {};
      injectTraceContext(carrier);
      const headers = new Headers(init?.headers ?? (resource instanceof Request ? resource.headers : undefined));
      headers.delete("baggage");
      headers.delete("traceparent");
      headers.delete("tracestate");
      for (const key of ["traceparent", "tracestate"]) {
        const value = carrier[key];
        if (value) headers.set(key, value);
      }
      const response = await fetcher(resource, { ...init, headers, redirect: "error" });
      span.setAttribute("http.response.status_code", response.status);
      span.setStatus({ code: response.ok ? SpanStatusCode.OK : SpanStatusCode.ERROR });
      if (!response.ok) span.setAttribute("error.type", String(response.status));
      const requestId = response.headers.get("apim-request-id") ?? response.headers.get("x-ms-request-id");
      if (requestId && REQUEST_ID.test(requestId)) span.setAttribute("gen_ai.request.id", requestId);
      if (response.ok) {
        const metadata = await modelMetadata(response);
        if (metadata?.responseId) span.setAttribute("gen_ai.response.id", metadata.responseId);
        if (metadata?.inputTokens !== undefined) span.setAttribute("gen_ai.usage.input_tokens", metadata.inputTokens);
        if (metadata?.outputTokens !== undefined) span.setAttribute("gen_ai.usage.output_tokens", metadata.outputTokens);
      }
      return response;
    });
  };
}
