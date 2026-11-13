import { describe, expect, it } from "vitest";
import { system1DecisionResultSchema, type System1DecisionRequest } from "@ehf/contracts/intelligence-adapters";
import { codeDistribution, decideSystem1, MAX_SYSTEM1_RESPONSE_BYTES, parseSystem1Bindings, resolveSystem1Binding, type System1AdapterId, type System1Binding } from "./decision-system1.js";

/**
 * The System 1 conformance suite (document factory plan §6.6). Every adapter runs the same fixtures through
 * its own wire format: a provider simulator answers each scenario the way that provider would. An adapter
 * is `implemented` in the switchboard only while it passes all of them.
 */
const request: System1DecisionRequest = {
  state: { left: "ACME HOLDINGS LIMITED", right: "Acme Holdings Ltd", field: "entity_name" },
  questions: {
    same_value: { type: "choice", instructions: "Do the two values name the same entity?", criteria: { same: "Same entity", different: "Different entities", cannot_tell: "Not decidable" } },
    span_support: { type: "choice", instructions: "Does the quoted span state this value?", criteria: { supported: "Stated", not_supported: "Not stated", cannot_tell: "Not decidable" } },
  },
};
const good = { same_value: "same", span_support: "supported" };
const distribution: Record<string, Record<string, number>> = { same_value: { same: 0.9, different: 0.05, cannot_tell: 0.05 }, span_support: { supported: 0.8, not_supported: 0.15, cannot_tell: 0.05 } };

type Scenario = {
  answers?: Record<string, string>; model?: string; probabilities?: Record<string, Record<string, number>> | "none";
  status?: number; error?: string; refusal?: boolean; contentFilter?: boolean; size?: number; hang?: boolean;
};

const BINDINGS: Record<System1AdapterId, System1Binding> = {
  openrouter_decisions: { id: "document.advisory.jev", adapter: "openrouter_decisions", model: "typesafe/jev-1.13", returnedModel: "typesafe/jev-1.13-20260917", timeoutMs: 200, maxQuestions: 12 },
  foundry_openai: { id: "document.advisory.foundry_openai", adapter: "foundry_openai", model: "advisory-gpt", returnedModel: "gpt-4.1-2025-04-14", endpoint: "https://ehf-ai.services.ai.azure.com", timeoutMs: 200, maxQuestions: 12 },
  foundry_anthropic: { id: "document.advisory.foundry_anthropic", adapter: "foundry_anthropic", model: "advisory-claude", returnedModel: "claude-sonnet-5-5", endpoint: "https://ehf-ai.services.ai.azure.com", timeoutMs: 200, maxQuestions: 12 },
};
const URLS: Record<System1AdapterId, string> = {
  openrouter_decisions: "https://openrouter.ai/api/alpha/decisions",
  foundry_openai: "https://ehf-ai.services.ai.azure.com/openai/v1/chat/completions",
  foundry_anthropic: "https://ehf-ai.services.ai.azure.com/anthropic/v1/messages",
};
const CODE: Record<string, string> = { same: "A", different: "B", supported: "A", not_supported: "B", cannot_tell: "C" };

/** The provider's wire answer for a scenario. */
function wire(adapter: System1AdapterId, scenario: Scenario): unknown {
  const answers = scenario.answers ?? good, model = scenario.model ?? BINDINGS[adapter].returnedModel;
  if (adapter === "openrouter_decisions") {
    const probabilities = scenario.probabilities === "none" ? undefined : scenario.probabilities ?? distribution;
    return { id: "gen-dec-1", model, provider: "TypeSafe", usage: { input_tokens: 300, output_tokens: 30, cost: 0.00001 },
      answers: Object.fromEntries(Object.entries(answers).map(([id, choice]) => [id, { type: "choice", choice, probabilities: probabilities?.[id] ?? {}, confidence: 0.9 }])) };
  }
  if (adapter === "foundry_openai") {
    // Tokens: `{"`, `<id>`, `":"`, `<code>`, `","` ... `"}` with alternatives on each code token.
    const tokens: Array<{ token: string; logprob: number; top_logprobs?: Array<{ token: string; logprob: number }> }> = [];
    const entries = Object.entries(answers);
    entries.forEach(([id, label], index) => {
      tokens.push({ token: index === 0 ? "{\"" : "\",\"", logprob: 0 }, { token: id, logprob: 0 }, { token: "\":\"", logprob: 0 });
      const code = CODE[label] ?? label;
      const dist = scenario.probabilities === "none" ? null : (scenario.probabilities ?? distribution)[id];
      const top = dist ? Object.entries(dist).map(([option, p]) => ({ token: CODE[option]!, logprob: Math.log(p) })) : undefined;
      tokens.push({ token: code, logprob: top?.find(t => t.token === code)?.logprob ?? 0, ...(top ? { top_logprobs: top } : {}) });
    });
    tokens.push({ token: "\"}", logprob: 0 });
    const content = tokens.map(t => t.token).join("");
    return { id: "chatcmpl-1", model, usage: { prompt_tokens: 300, completion_tokens: 20 },
      choices: [{ finish_reason: scenario.contentFilter ? "content_filter" : "stop", message: { content: scenario.contentFilter ? null : content, refusal: scenario.refusal ? "I can't help with that." : null },
        logprobs: scenario.probabilities === "none" ? null : { content: tokens } }] };
  }
  return { id: "msg_1", model, stop_reason: scenario.refusal ? "refusal" : "tool_use", usage: { input_tokens: 300, output_tokens: 20 },
    content: scenario.refusal ? [] : [{ type: "tool_use", name: "record_answers", input: answers }] };
}

function provider(adapter: System1AdapterId, scenario: Scenario) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    if (scenario.hang) return new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }))));
    if (scenario.size) return new Response("x".repeat(scenario.size), { status: 200 });
    if (scenario.status) return new Response(JSON.stringify({ error: { code: scenario.error ?? "rate_limited", message: "no" } }), { status: scenario.status });
    if (scenario.contentFilter && adapter !== "foundry_openai") return new Response(JSON.stringify({ error: { code: "content_filter", message: "filtered" } }), { status: 400 });
    return new Response(JSON.stringify(wire(adapter, scenario)), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

const decide = (adapter: System1AdapterId, scenario: Scenario, binding: Partial<System1Binding> = {}) => {
  const { fetch, calls } = provider(adapter, scenario);
  const auth = adapter === "openrouter_decisions" ? { kind: "bearer" as const, token: async () => "test-key" } : { kind: "api_key" as const, key: "test-key" };
  return decideSystem1({ binding: { ...BINDINGS[adapter], ...binding }, request, auth, fetch }).then(result => ({ result, calls }));
};

describe.each(Object.keys(BINDINGS) as System1AdapterId[])("System 1 conformance: %s", (adapter) => {
  it("answers in the canonical contract, on the pinned model, at the adapter's host", async () => {
    const { result, calls } = await decide(adapter, {});
    expect(system1DecisionResultSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({ status: "answered", abstention: null, adapter, model: BINDINGS[adapter].model, actualModel: BINDINGS[adapter].returnedModel });
    expect(result.answers.same_value).toMatchObject({ status: "answered", answer: { primitive: "choice", value: "same" } });
    expect(result.answers.span_support).toMatchObject({ status: "answered", answer: { value: "supported" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(URLS[adapter]);
    expect(calls[0]!.body.model).toBe(BINDINGS[adapter].model);
    if (adapter === "openrouter_decisions") expect(calls[0]!.headers.Authorization).toBe("Bearer test-key");
    else expect(calls[0]!.headers["api-key"]).toBe("test-key");
  });

  it("reports a distribution only where the provider gives one, and never synthesizes it", async () => {
    const { result } = await decide(adapter, {});
    const answer = result.answers.same_value;
    if (answer?.status !== "answered") throw new Error("expected an answer");
    if (adapter === "foundry_anthropic") expect(answer.answer.probabilities).toBeNull();
    else expect(answer.answer.probabilities!.same).toBeCloseTo(0.9, 3);
    if (adapter === "foundry_openai") {
      const { result: bare } = await decide(adapter, { probabilities: "none" });
      expect(bare.answers.same_value).toMatchObject({ status: "answered", answer: { probabilities: null } });
    }
  });

  it("refuses model substitution", async () => {
    const { result } = await decide(adapter, { model: "some-other-model" });
    expect(result).toMatchObject({ status: "abstained", abstention: { reason: "model_substitution" }, answers: {} });
  });

  it("refuses a missing or an unknown question as a whole batch", async () => {
    expect((await decide(adapter, { answers: { same_value: "same" } })).result.abstention?.reason).toBe("missing_or_unknown_questions");
    expect((await decide(adapter, { answers: { ...good, extra: "same" } })).result.abstention?.reason).toBe("missing_or_unknown_questions");
  });

  it("refuses an option the question does not declare", async () => {
    expect((await decide(adapter, { answers: { ...good, same_value: "maybe" } })).result.abstention?.reason).toBe("invalid_distribution");
  });

  it("refuses a distribution that does not favour the chosen option", async () => {
    if (adapter === "foundry_anthropic") return; // reports no distribution
    const { result } = await decide(adapter, { probabilities: { ...distribution, same_value: { same: 0.2, different: 0.75, cannot_tell: 0.05 } } });
    expect(result.abstention?.reason).toBe("invalid_distribution");
  });

  it("treats cannot_tell as that question's abstention, not an answer", async () => {
    const { result } = await decide(adapter, { answers: { ...good, span_support: "cannot_tell" }, probabilities: { ...distribution, span_support: { supported: 0.1, not_supported: 0.1, cannot_tell: 0.8 } } });
    expect(result.status).toBe("answered");
    expect(result.answers.span_support).toEqual({ status: "abstained", reason: "cannot_tell" });
  });

  it("abstains as unavailable on a refusal, a content filter or a rate limit, and as timeout on a deadline", async () => {
    if (adapter !== "openrouter_decisions") expect((await decide(adapter, { refusal: true })).result.abstention?.reason).toBe("unavailable");
    expect((await decide(adapter, { contentFilter: true })).result.abstention).toMatchObject({ reason: "unavailable", detail: "content_filter" });
    expect((await decide(adapter, { status: 429 })).result.abstention?.reason).toBe("unavailable");
    expect((await decide(adapter, { status: 503 })).result.abstention?.reason).toBe("unavailable");
    expect((await decide(adapter, { status: 401 })).result.abstention?.reason).toBe("not_configured");
    expect((await decide(adapter, { hang: true })).result.abstention?.reason).toBe("timeout");
  });

  it("bounds the response size", async () => {
    expect((await decide(adapter, { size: MAX_SYSTEM1_RESPONSE_BYTES + 1 })).result.abstention?.reason).toBe("response_limit");
  });

  it("sends a Foundry credential only to an allowlisted services.ai.azure.com host", async () => {
    if (adapter === "openrouter_decisions") return; // a fixed endpoint
    for (const endpoint of ["https://evil.example.com", "http://ehf-ai.services.ai.azure.com", "https://ehf-ai.services.ai.azure.com.evil.com", "https://ehf-ai.services.ai.azure.com/x"]) {
      const { result, calls } = await decide(adapter, {}, { endpoint });
      expect(result.abstention?.reason).toBe("not_configured");
      expect(calls).toHaveLength(0);
    }
  });
});

describe("System 1 bindings", () => {
  it("refuses an unpinned model, too many questions and an unknown adapter", async () => {
    const auth = { kind: "bearer" as const, token: async () => "k" };
    await expect(decideSystem1({ binding: { ...BINDINGS.openrouter_decisions, model: "typesafe/jev-latest" }, request, auth })).rejects.toThrow("adapter.decision_model_unpinned");
    await expect(decideSystem1({ binding: { ...BINDINGS.openrouter_decisions, maxQuestions: 1 }, request, auth })).rejects.toThrow("adapter.decision_too_many_questions");
    await expect(decideSystem1({ binding: { ...BINDINGS.openrouter_decisions, adapter: "other" as never }, request, auth })).rejects.toThrow("adapter.decision_adapter_unsupported");
  });

  it("parses the repository's bindings and resolves credentials from the environment only", async () => {
    const { readFileSync } = await import("node:fs");
    const bindings = parseSystem1Bindings(JSON.parse(readFileSync(new URL("../../../config/decision-bindings.json", import.meta.url), "utf8")));
    expect(bindings.map(b => b.adapter).sort()).toEqual(["foundry_anthropic", "foundry_openai", "openrouter_decisions"]);
    const identity = () => async () => "entra-token";
    for (const binding of bindings) {
      expect(resolveSystem1Binding(binding, {}, identity)).toHaveProperty("missing");
      if (binding.adapter === "openrouter_decisions") expect(resolveSystem1Binding(binding, { OPENROUTER_API_KEY: "k" }, identity)).toHaveProperty("auth.kind", "bearer");
      else {
        const resolved = resolveSystem1Binding(binding, { [binding.endpointEnv!]: "https://ehf-ai.services.ai.azure.com" }, identity);
        expect(resolved).toMatchObject({ binding: { endpoint: "https://ehf-ai.services.ai.azure.com" }, auth: { kind: "bearer" } });
        expect(() => resolveSystem1Binding(binding, { [binding.endpointEnv!]: "https://example.com" }, identity)).toThrow("adapter.decision_foundry_endpoint_invalid");
      }
    }
    expect(() => parseSystem1Bindings({ bindings: [{ ...bindings[0], model: "x/latest" }] })).toThrow("adapter.decision_binding_invalid");
  });

  it("reads a code's distribution only at the answer's own token", () => {
    const tokens = [{ token: "{\"q\":\"", logprob: 0 }, { token: "A", logprob: Math.log(0.7), top_logprobs: [{ token: "A", logprob: Math.log(0.7) }, { token: "B", logprob: Math.log(0.3) }] }, { token: "\"}", logprob: 0 }];
    expect(codeDistribution("{\"q\":\"A\"}", tokens, "q", [["A", "yes"], ["B", "no"]])).toEqual({ yes: 0.7, no: 0.3 });
    // Merged with the closing quote: not a single code token, so no distribution.
    expect(codeDistribution("{\"q\":\"A\"}", [{ token: "{\"q\":\"", logprob: 0 }, { token: "A\"}", logprob: 0 }], "q", [["A", "yes"], ["B", "no"]])).toBeNull();
  });
});
