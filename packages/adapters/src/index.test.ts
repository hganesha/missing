import { describe, expect, it } from "vitest";
import { validateProviderPayload } from "@ehf/library-contracts";
import { invokeDocumentFieldsModel, invokeModel, invokeOpenSanctions, invokeSimulator, modelCallCost } from "./index.js";

const recordedProfile = {
  id: "model.standard.v1",
  provider: "openrouter" as const,
  model: "openai/gpt-4.1-mini",
  maxOutputTokens: 1024,
  timeoutMs: 30_000,
  maxConcurrency: 1,
};

describe("Foundry through the compatible runtime adapter", () => {
  it("uses deployment names, bearer credentials and JSON mode without OpenRouter request fields", async () => {
    const calls: Array<{ url: string; headers: Headers; body: any }> = [];
    const result = await invokeModel({
      profile: { ...recordedProfile, model: "ehf-low" }, apiKey: "foundry-test-key", input: { instruction: "Return the answer." },
      outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
      providerBinding: { kind: "openai_compatible", baseUrl: "https://test.services.ai.azure.com/openai/v1/", siteUrl: "https://should-not-be-sent.example.com", appName: "should-not-be-sent", status: "active" },
      fetch: async (url, init) => {
        calls.push({ url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
        return Response.json({ id: "chatcmpl-test", object: "chat.completion", created: 1, model: "ehf-low", choices: [{ index: 0, message: { role: "assistant", content: '{"answer":"OK"}' }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
      },
    });
    expect(result).toMatchObject({ output: { answer: "OK" }, provider: "openai_compatible", model: "ehf-low", inputTokens: 10, outputTokens: 5 });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe("https://test.services.ai.azure.com/openai/v1/chat/completions");
    expect(call.headers.get("authorization")).toBe("Bearer foundry-test-key");
    expect(call.headers.has("http-referer")).toBe(false);
    expect(call.body).toMatchObject({ model: "ehf-low", response_format: { type: "json_object" } });
    expect(call.body).not.toHaveProperty("app_name");
    expect(call.body).not.toHaveProperty("provider");
    expect(JSON.stringify(call.body.messages)).toContain("JSON Schema");
    expect(JSON.stringify(call.body.messages)).toContain("answer");
  });
});

describe("adapters", () => {
  it("extracts nested provider cost", () => {
    expect(modelCallCost({ openrouter: { usage: { total_cost_usd: "0.012" } } })).toBe(0.012);
    expect(modelCallCost({ usage: {} })).toBeNull();
  });

  it("returns deterministic screening fixtures", async () => {
    await expect(invokeSimulator("screening.sanctions.search", { name: "Blocked Person" }))
      .resolves.toMatchObject({ output: { match: true } });
  });

  it("answers skill library capabilities in the library's contract, always INCONCLUSIVE", async () => {
    const deepfake = await invokeSimulator("library.fraud.deepfake", { records: [{ id: "media-1", artifact_hash: "a".repeat(64), modality: "video" }] });
    expect(deepfake.output).toMatchObject({ assessment: "INCONCLUSIVE", score: "0.5", limitations: [expect.stringContaining("no detector executed")] });
    expect(validateProviderPayload("fraud.deepfake", "response", deepfake.output).valid).toBe(true);
    // Requests are checked against the library's request schema before anything is answered.
    await expect(invokeSimulator("library.fraud.deepfake", { records: [{ id: "media-1", artifact_hash: "a".repeat(64), media_type: "video" }] })).rejects.toThrow("adapter.input_invalid");
    const forensics = await invokeSimulator("library.document.forensics", { document_hashes: ["b".repeat(64)] });
    expect(forensics.output).toMatchObject({ assessment: "INCONCLUSIVE", indicators: [], model_version: "sandbox-simulator-v1" });
    expect(validateProviderPayload("document.forensics", "response", forensics.output).valid).toBe(true);
    await expect(invokeSimulator("library.document.forensics", { document_hashes: ["not-a-hash"] })).rejects.toThrow("adapter.input_invalid");
    await expect(invokeSimulator("library.document.entities", { pages: [] })).rejects.toThrow("adapter.capability_unsupported");
  });

  it("returns a versioned PolicyDB fixture", async () => {
    await expect(invokeSimulator("policy.kyc.lookup", {
      country: "US",
      customerType: "individual",
      riskTier: "high",
    })).resolves.toMatchObject({
      output: {
        policyId: "kyc-us-individual",
        policyVersion: "2026.09-poc",
        source: "mock-policydb-v1",
      },
    });
  });

  it("returns provenance and a bounded finding from the mock web search", async () => {
    await expect(invokeSimulator("investigation.web.search", {
      name: "Blocked Official",
      country: "US",
    })).resolves.toMatchObject({
      output: {
        provider: "mock-web-search-v1",
        findings: [{ classification: "REVIEW", evidenceRefs: ["ev_mock_public_001"] }],
      },
    });
  });

  it("returns the KYC decision contract when OpenRouter is not configured", async () => {
    await expect(invokeModel({
      profile: recordedProfile,
      input: {
        prompt: "Act as a KYC analyst and cite policy rule IDs and finding IDs.",
        input: { name: "Clear Person", evidence: {} },
      },
    })).resolves.toMatchObject({
      provider: "recorded",
      output: {
        recommendationId: "recommendation_fixture_001",
        outcome: "APPROVE",
        requiresHumanReview: false,
      },
    });
  });
});

describe("model credential handling", () => {
  const profile = {
    id: "model.standard.v1", provider: "openrouter" as const, model: "test/model",
    maxOutputTokens: 256, timeoutMs: 1000, maxConcurrency: 1,
  };

  it("answers the agent loop protocol offline with a schema-shaped final action and no tool calls", async () => {
    const profile = { id: "model.standard.v1", provider: "openrouter", model: "x", maxOutputTokens: 100, timeoutMs: 1000, maxConcurrency: 1 } as never;
    const prompt = "# Task\nInvestigate.\n\nReturn only a JSON object that conforms to this schema:\n" + JSON.stringify({
      type: "object", required: ["summary", "findings", "requiresHumanReview"],
      properties: { summary: { type: "string", minLength: 3 }, findings: { type: "array" }, requiresHumanReview: { type: "boolean" } },
    }) + "\n\n# Agent loop protocol\n...";
    const result = await invokeModel({ profile, input: { prompt } });
    expect(result.provider).toBe("recorded");
    expect(result.output).toMatchObject({ action: "final", output: { summary: "recorded", findings: [], requiresHumanReview: false } });
  });

  it("falls back to the recorded adapter when that is permitted", async () => {
    const result = await invokeModel({ profile, input: { prompt: "kyc decision" } });
    expect(result.provider).toBe("recorded");
  });

  it("fails closed when a real provider is expected", async () => {
    // A silent fallback lets a deployment report model calls it never made.
    await expect(invokeModel({ profile, input: {}, allowRecordedFallback: false }))
      .rejects.toThrow("adapter.model_credential_missing");
  });
});

describe("provider bindings", () => {
  it("answers from the recorded adapter when the binding says recorded", async () => {
    // An operator taking a provider out of service should not need a credential change
    // or a recompilation, and should not depend on the credential being absent.
    const result = await invokeModel({
      profile: recordedProfile,
      input: { prompt: "screen the subject", input: {} },
      apiKey: "key-that-must-not-be-used",
      providerBinding: { kind: "recorded", baseUrl: null, siteUrl: null, appName: null, status: "active" },
    });
    expect(result.provider).toBe("recorded");
  });

  it("refuses a disabled binding instead of quietly recording it", async () => {
    // Falling back here would report a model call for a provider the deployment
    // deliberately took out of service.
    await expect(invokeModel({
      profile: recordedProfile,
      input: {},
      providerBinding: { kind: "openrouter", baseUrl: null, siteUrl: null, appName: null, status: "disabled" },
    })).rejects.toThrow("adapter.provider_disabled");
  });

  it("still fails closed on an absent credential when fallback is denied", async () => {
    await expect(invokeModel({
      profile: recordedProfile,
      input: {},
      allowRecordedFallback: false,
      providerBinding: { kind: "openrouter", baseUrl: "https://models.internal.test/v1", siteUrl: null, appName: null, status: "active" },
    })).rejects.toThrow("adapter.model_credential_missing");
  });
});

describe("OpenSanctions matching adapter", () => {
  it("authenticates a sanctions-scoped match request and normalizes alerts", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const fetcher: typeof fetch = async (url, init) => {
      requestedUrl = String(url);
      requestedInit = init;
      return new Response(JSON.stringify({
        responses: {
          subject: {
            status: 200,
            query: { schema: "Person", properties: { name: ["Example Person"] } },
            results: [{
              id: "NK-example",
              caption: "Example Person",
              schema: "Person",
              properties: { topics: ["sanction"], programId: ["US-EXAMPLE"] },
              datasets: ["us_ofac_sdn"],
              score: 0.92,
              match: true,
              last_seen: "2026-09-18T00:00:00",
              explanations: {
                name_match: { score: 0.92, query: "Example Person", candidate: "Example Person" },
                dob_year_disjoint: { score: 1, query: "1980", candidate: "1981" },
              },
            }],
          },
        },
        limit: 5,
      }), { status: 200, headers: { "x-request-id": "req-123" } });
    };

    const result = await invokeOpenSanctions({
      input: {
        name: "Example Person",
        aliases: ["E. Person"],
        dateOfBirth: "1980-01-01",
        country: "US",
      },
      apiKey: "test-secret",
      fetch: fetcher,
      now: () => new Date("2026-09-19T12:00:00.000Z"),
    });

    const url = new URL(requestedUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://api.opensanctions.org/match/default");
    expect(url.searchParams.getAll("topics")).toEqual(["sanction", "sanction.linked"]);
    expect(url.searchParams.get("threshold")).toBe("0.7");
    expect(new Headers(requestedInit?.headers).get("Authorization")).toBe("ApiKey test-secret");
    expect(JSON.parse(String(requestedInit?.body))).toEqual({
      queries: {
        subject: {
          schema: "Person",
          properties: {
            name: ["Example Person"],
            alias: ["E. Person"],
            birthDate: ["1980-01-01"],
            country: ["US"],
          },
        },
      },
    });
    expect(result).toMatchObject({
      provider: "opensanctions",
      model: "match/default",
      providerRequestId: "req-123",
      output: {
        status: "OK",
        provider: "OPENSANCTIONS",
        screenedAt: "2026-09-19T12:00:00.000Z",
        alerts: [{
          alertId: "opensanctions:NK-example",
          score: 0.92,
          scoreMeaning: "IDENTITY_MATCH_CONFIDENCE",
          programs: ["US-EXAMPLE"],
          matchedFields: ["name_match"],
          conflictingFields: ["dob_year_disjoint"],
        }],
      },
    });
  });

  it("rejects missing credentials before making a request", async () => {
    await expect(invokeOpenSanctions({ input: { name: "Example" }, apiKey: "" }))
      .rejects.toThrow("adapter.opensanctions_credential_missing");
  });

  it("supports a PEP-scoped match request", async () => {
    let requestedUrl = "";
    const result = await invokeOpenSanctions({
      input: { name: "Example Official" },
      apiKey: "test-secret",
      topics: ["role.pep"],
      screeningType: "PEP",
      fetch: async (url) => {
        requestedUrl = String(url);
        return new Response(JSON.stringify({
          responses: { subject: { status: 200, query: {}, results: [] } },
        }), { status: 200 });
      },
    });

    expect(new URL(requestedUrl).searchParams.getAll("topics")).toEqual(["role.pep"]);
    expect(result.output).toMatchObject({ screeningType: "PEP", alerts: [] });
  });
});

describe("document.fields through a model profile (EHF document wrappers)", () => {
  const profile = { id: "model.standard.v1", provider: "openrouter", model: "openai/gpt-test", maxOutputTokens: 4000, timeoutMs: 30_000 } as never;
  const request = {
    document_type: "certificate_of_incorporation", contract_hash: "c".repeat(64), instructions: "Extract the fields.",
    extraction_schema: { type: "object" }, pages: [{ page_id: "page-1", document_version: "doc-v1", text: "Name: Acme" }], source_digest: "d".repeat(64),
  };
  const answer = { document_type: "certificate_of_incorporation", profile_version: "0.1.0", contract_hash: "c".repeat(64), document_version: "doc-v1",
    source_digest: "d".repeat(64), extracted_fields: { entity_name: "Acme" },
    observations: [{ path: "/extracted_fields/entity_name", status: "present", confidence: null, spans: [{ page_id: "page-1", start: 6, end: 10, quote: "Acme" }], note: null }] };

  it("never answers without a model: no credential and a recorded binding both fail", async () => {
    await expect(invokeDocumentFieldsModel({ profile, input: request })).rejects.toThrow("adapter.document_fields_model_unavailable");
    await expect(invokeDocumentFieldsModel({ profile, input: request, apiKey: "k", providerBinding: { kind: "recorded", status: "active" } as never }))
      .rejects.toThrow("adapter.document_fields_model_unavailable");
  });

  it("sends the contract schema and the pages as data, and returns only an answer in the library contract", async () => {
    const calls: Array<{ schema: unknown; prompt: string }> = [];
    const result = await invokeDocumentFieldsModel({ profile, input: request, generate: async (call) => {
      calls.push(call);
      return { object: answer, responseId: "r1", inputTokens: 10, outputTokens: 5, costUsd: null };
    } });
    expect(result.output).toEqual(answer);
    expect(calls[0]!.schema).toEqual({ type: "object" });
    expect(calls[0]!.prompt).toContain("untrusted data");
    expect(calls[0]!.prompt).toContain("Name: Acme");
    await expect(invokeDocumentFieldsModel({ profile, input: request, generate: async () => ({ object: { status: "unknown" }, responseId: null, inputTokens: null, outputTokens: null, costUsd: null }) }))
      .rejects.toThrow("adapter.output_invalid");
    await expect(invokeDocumentFieldsModel({ profile, input: { pages: [] }, generate: async () => ({ object: answer, responseId: null, inputTokens: null, outputTokens: null, costUsd: null }) }))
      .rejects.toThrow("adapter.input_invalid");
  });
});
