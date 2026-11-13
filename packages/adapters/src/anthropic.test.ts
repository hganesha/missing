import { afterEach, describe, expect, it } from "vitest";
import { anthropicOutputSchema, invokeDocumentFieldsModel, invokeModel } from "./index.js";

/** A Messages API stream for one text answer, as the server sends it. */
function sse(text: string, stopReason = "end_turn") {
  const events = [
    ["message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 11, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 7 } }],
    ["message_stop", { type: "message_stop" }],
  ] as const;
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

function recorder(answer: string, stopReason?: string) {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    return new Response(sse(answer, stopReason), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const profile = { id: "model.standard.v1", provider: "anthropic", model: "claude-sonnet-5-5", maxOutputTokens: 16000, timeoutMs: 60000, maxConcurrency: 4 };
const binding = { kind: "anthropic" as const, baseUrl: null, siteUrl: null, appName: null, status: "active" as const };
const saved = { base: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY, token: process.env.ANTHROPIC_AUTH_TOKEN };
afterEach(() => {
  for (const [name, value] of [["ANTHROPIC_BASE_URL", saved.base], ["ANTHROPIC_API_KEY", saved.key], ["ANTHROPIC_AUTH_TOKEN", saved.token]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

describe("the Anthropic reasoning transport", () => {
  it("calls the binding's endpoint with the administered key only, never the process's own Anthropic settings", async () => {
    process.env.ANTHROPIC_BASE_URL = "https://elsewhere.invalid";
    process.env.ANTHROPIC_AUTH_TOKEN = "ambient-token";
    const { fetch, calls } = recorder(JSON.stringify({ recommendation: "manual_review" }));
    const result = await invokeModel({ fetch, profile, input: { prompt: "Review." }, apiKey: "administered-key", providerBinding: binding,
      outputSchema: { type: "object", required: ["recommendation"], properties: { recommendation: { type: "string", minLength: 1 } } } });
    expect(calls[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    // SDK 1.x sends an API key as a bearer token; the ambient token never appears.
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer administered-key");
    expect(calls[0]!.headers.get("x-api-key")).toBeNull();
    expect(calls[0]!.body.output_config).toEqual({ format: { type: "json_schema", schema: {
      type: "object", required: ["recommendation"], properties: { recommendation: { type: "string" } }, additionalProperties: false,
    } } });
    expect(result).toMatchObject({ output: { recommendation: "manual_review" }, provider: "anthropic", model: "claude-sonnet-5-5", providerRequestId: "msg_test", inputTokens: 11, outputTokens: 7 });
  });

  it("asks for JSON in the prompt when the schema is outside what Claude can enforce", async () => {
    const { fetch, calls } = recorder("```json\n{\"scores\":{\"a\":1}}\n```");
    const result = await invokeModel({ fetch, profile, input: { prompt: "Score." }, apiKey: "k", providerBinding: { ...binding, baseUrl: "https://claude.example.com" },
      outputSchema: { type: "object", properties: { scores: { type: "object", additionalProperties: { type: "number" } } } } });
    expect(calls[0]!.url).toBe("https://claude.example.com/v1/messages");
    expect(calls[0]!.body.output_config).toBeUndefined();
    expect(result.output).toEqual({ scores: { a: 1 } });
  });

  it("fails a refusal or a truncated answer rather than answering from another model", async () => {
    await expect(invokeModel({ fetch: recorder("", "refusal").fetch, profile, input: {}, apiKey: "k", providerBinding: binding })).rejects.toThrow("adapter.model_refused");
    await expect(invokeModel({ fetch: recorder("{\"a\":", "max_tokens").fetch, profile, input: {}, apiKey: "k", providerBinding: binding })).rejects.toThrow("adapter.model_output_truncated");
  });

  it("serves the document-fields contract through the same binding", async () => {
    const { fetch, calls } = recorder("{}");
    await expect(invokeDocumentFieldsModel({ fetch, profile, apiKey: "k", providerBinding: binding,
      input: { instructions: "Extract.", extraction_schema: { type: "object", properties: {} }, pages: [] } })).rejects.toThrow(/adapter\.(input|output)_invalid/);
    // Whatever the library's request contract refuses never reaches the provider.
    expect(calls.length).toBeLessThanOrEqual(1);
  });
});

describe("the structured-output subset", () => {
  it("closes objects, drops unenforced constraints and maps oneOf to anyOf", () => {
    expect(anthropicOutputSchema({
      type: "object", required: ["a"], properties: {
        a: { type: "string", minLength: 1, pattern: "^x", format: "date" },
        b: { type: "array", minItems: 2, maxItems: 4, items: { type: "object", properties: { c: { oneOf: [{ type: "string" }, { type: "null" }] } } } },
        n: { type: "integer", minimum: 0, maximum: 9 },
      },
    })).toEqual({
      type: "object", required: ["a"], additionalProperties: false, properties: {
        a: { type: "string", format: "date" },
        b: { type: "array", items: { type: "object", additionalProperties: false, properties: { c: { anyOf: [{ type: "string" }, { type: "null" }] } } } },
        n: { type: "integer" },
      },
    });
  });

  it("keeps references and definitions", () => {
    expect(anthropicOutputSchema({ $defs: { A: { type: "object", properties: { x: { type: "string", minLength: 2 } } } }, type: "object", properties: { a: { $ref: "#/$defs/A" } } }))
      .toEqual({ $defs: { A: { type: "object", additionalProperties: false, properties: { x: { type: "string" } } } }, type: "object", additionalProperties: false, properties: { a: { $ref: "#/$defs/A" } } });
  });

  it("refuses what it cannot express: open maps, any-value schemas, negation, objects without properties", () => {
    expect(anthropicOutputSchema({ type: "object", additionalProperties: { type: "string" } })).toBeNull();
    expect(anthropicOutputSchema({ $defs: { JsonValue: {} }, type: "object", properties: { a: { $ref: "#/$defs/JsonValue" } } })).toBeNull();
    expect(anthropicOutputSchema({ type: "object", properties: { a: { not: { type: "null" } } } })).toBeNull();
    expect(anthropicOutputSchema({ type: "object" })).toBeNull();
  });
});

describe("agent loop steps", () => {
  it("are never sent as provider-enforced structured output: the loop validates the action itself", async () => {
    const { fetch, calls } = recorder(JSON.stringify({ action: "final", output: { ok: true } }));
    const result = await invokeModel({ fetch, profile, apiKey: "k", providerBinding: binding,
      input: { prompt: "Decide.", contextPackDigest: "d", agentLoop: { step: 1, tools: [], skills: [] } },
      outputSchema: { type: "object", required: ["action"] } });
    expect(calls[0]!.body.output_config).toBeUndefined();
    expect(result.output).toEqual({ action: "final", output: { ok: true } });
  });
});

describe("document-fields provenance", () => {
  it("comes from the request the connector sent, while values and spans stay the model's", async () => {
    const { bindDocumentFieldsAnswer } = await import("./index.js");
    const request = { document_type: "passport", contract_hash: "c".repeat(64), source_digest: "s".repeat(64),
      extraction_schema: { properties: { profile_version: { const: "0.1.0" } } }, pages: [{ document_version: "v".repeat(64) }] };
    expect(bindDocumentFieldsAnswer(request, { document_type: "passport", document_version: "made-up", source_digest: "0".repeat(64), extracted_fields: { person_name: "A" }, observations: [] }))
      .toEqual({ document_type: "passport", profile_version: "0.1.0", contract_hash: "c".repeat(64), document_version: "v".repeat(64), source_digest: "s".repeat(64), extracted_fields: { person_name: "A" }, observations: [] });
    expect(bindDocumentFieldsAnswer(request, null)).toBeNull();
  });
});

describe("document-fields spans", () => {
  it("move to the quote's verbatim occurrence, counted in code points; a quote not on the page stays wrong", async () => {
    const { relocateDocumentSpans } = await import("./index.js");
    const text = "Name: Zoë Ábel\nDate of birth: 1984-02-11\nIssued: 1984-02-11";
    const request = { pages: [{ page_id: "p1", text }] };
    const answer = { observations: [
      { path: "/extracted_fields/date_of_birth", spans: [{ page_id: "p1", start: 30, end: 40, quote: "1984-02-11" }] },
      { path: "/extracted_fields/person_name", spans: [{ page_id: "p1", start: 0, end: 3, quote: "Zoë Ábel" }] },
      { path: "/extracted_fields/expiry_date", spans: [{ page_id: "p1", start: 0, end: 10, quote: "2031-01-01" }] },
      { path: "/extracted_fields/issue_date", spans: [{ page_id: "page:rebuilt-id", start: 45, end: 55, quote: "Issued: 1984-02-11" }] },
      { path: "/extracted_fields/notes", spans: [{ page_id: "page:rebuilt-id", start: 0, end: 4, quote: "absent" }] },
    ] };
    const out = relocateDocumentSpans(request, answer) as typeof answer;
    // The first "1984-02-11" (code point 30) is the nearest to the stated start.
    expect(out.observations[0]!.spans[0]).toEqual({ page_id: "p1", start: 30, end: 40, quote: "1984-02-11" });
    expect(Array.from(text).slice(30, 40).join("")).toBe("1984-02-11");
    expect(out.observations[1]!.spans[0]).toEqual({ page_id: "p1", start: 6, end: 14, quote: "Zoë Ábel" });
    expect(out.observations[2]!.spans[0]).toEqual({ page_id: "p1", start: 0, end: 10, quote: "2031-01-01" });
    // A rebuilt page id goes to the one page holding the quote; a quote on no page keeps its citation.
    expect(out.observations[3]!.spans[0]).toEqual({ page_id: "p1", start: 41, end: 59, quote: "Issued: 1984-02-11" });
    expect(out.observations[4]!.spans[0]).toEqual({ page_id: "page:rebuilt-id", start: 0, end: 4, quote: "absent" });
  });
});

describe("document-fields observation paths", () => {
  it("are rewritten from dot or bracket notation to JSON Pointers, and nothing else changes", async () => {
    const { normalizeObservationPaths } = await import("./index.js");
    const spans = [{ page_id: "p1", start: 0, end: 4, quote: "Alex" }];
    const answer = { extracted_fields: { person_name: "Alex" }, observations: [
      { path: "/extracted_fields/person_name", status: "present", spans },
      { path: "extracted_fields.person_name", status: "present", spans },
      { path: "extracted_fields.accounts[0].currency", status: "not_present", spans: [] },
      { path: "extracted_fields.accounts.1.closing_balance", status: "not_present", spans: [] },
      { path: "/extracted_fields.document_title", status: "not_present", spans: [] },
    ] };
    const out = normalizeObservationPaths(answer) as typeof answer;
    expect(out.observations.map((o) => o.path)).toEqual(["/extracted_fields/person_name", "/extracted_fields/person_name",
      "/extracted_fields/accounts/0/currency", "/extracted_fields/accounts/1/closing_balance", "/extracted_fields/document_title"]);
    expect(out.observations[1]!.spans).toBe(spans);
    expect(out.extracted_fields).toBe(answer.extracted_fields);
  });

  it("adds the prefix only to a bare path whose first segment is a field the request declares", async () => {
    const { normalizeObservationPaths, documentFieldNames } = await import("./index.js");
    const fields = documentFieldNames({ extraction_schema: { properties: { extracted_fields: { properties: { document_title: {}, ownership_interests: {} } } } } });
    const paths = ["document_title", "ownership_interests[0].share_class", "/ownership_interests/1/percentage", "not_declared", "Document_title"];
    const out = normalizeObservationPaths({ observations: paths.map((path) => ({ path })) }, fields) as { observations: Array<{ path: string }> };
    expect(out.observations.map((o) => o.path)).toEqual(["/extracted_fields/document_title", "/extracted_fields/ownership_interests/0/share_class",
      "/extracted_fields/ownership_interests/1/percentage", "not_declared", "Document_title"]);
  });

  it("leaves paths it cannot read unambiguously for the library to reject", async () => {
    const { normalizeObservationPaths } = await import("./index.js");
    const paths = ["person_name", "fields.person_name", "extracted_fields", "extracted_fields.Person Name", "extracted_fields.a[-1]", "extracted_fields..a"];
    const out = normalizeObservationPaths({ observations: paths.map((path) => ({ path })) }) as { observations: Array<{ path: string }> };
    expect(out.observations.map((o) => o.path)).toEqual(paths);
    expect(normalizeObservationPaths(null)).toBeNull();
    expect(normalizeObservationPaths({ observations: "x" })).toEqual({ observations: "x" });
  });
});
