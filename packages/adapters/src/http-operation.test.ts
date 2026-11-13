import { describe, expect, it } from "vitest";
import { invokeHttpOperation, parseCloudEndpoint, parseHttpOperations } from "./index.js";

type Call = { url: URL; init: RequestInit; body: unknown };
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> } | Error;

function fakeFetch(responder: (call: Call, index: number) => Reply) {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const raw = typeof init.body === "string" ? init.body : undefined;
    const call = { url: new URL(String(input)), init, body: raw ? JSON.parse(raw) as unknown : undefined };
    calls.push(call);
    const reply = responder(call, calls.length - 1);
    if (reply instanceof Error) throw reply;
    return new Response(reply.body === undefined ? "" : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json", ...reply.headers },
    });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const header = (call: Call, name: string) => new Headers(call.init.headers).get(name);
const WORKLOAD = "workload-identity-token";

describe("cloud endpoint validation", () => {
  it("requires https, refuses credentials and query strings, and allows local http only when asked", () => {
    expect(parseCloudEndpoint("https://models.example.test/", { error: "e" }).hostname).toBe("models.example.test");
    expect(() => parseCloudEndpoint("http://models.example.test", { error: "e" })).toThrow("e");
    expect(() => parseCloudEndpoint("https://a:b@models.example.test", { error: "e" })).toThrow("e");
    expect(() => parseCloudEndpoint("https://models.example.test/?sig=1", { error: "e" })).toThrow("e");
    expect(() => parseCloudEndpoint("https://models.example.test/path", { error: "e" })).toThrow("e");
    expect(parseCloudEndpoint("https://api.example.test/kyc", { error: "e", allowPath: true }).pathname).toBe("/kyc");
    expect(() => parseCloudEndpoint("http://localhost:7000", { error: "e" })).toThrow("e");
    expect(parseCloudEndpoint("http://localhost:7000", { error: "e", allowLocalHttp: true }).port).toBe("7000");
    expect(() => parseCloudEndpoint("http://internal.corp", { error: "e", allowLocalHttp: true })).toThrow("e");
  });
});

describe("http operations", () => {
  const baseUrl = new URL("https://api.example.test/core");
  const operations = parseHttpOperations(JSON.stringify({
    getCustomer: { method: "GET", path: "/customers/{customerId}" },
    createCase: { method: "post", path: "/cases" },
  }));

  it("calls an allowlisted operation with encoded path parameters, an API key header and a workload token", async () => {
    const { fetch, calls } = fakeFetch(() => ({ body: { customerId: "a/b", tier: "gold" }, headers: { "x-request-id": "req-1" } }));
    const result = await invokeHttpOperation({
      baseUrl, operationId: "getCustomer", operations, input: { pathParams: { customerId: "a/b?c" }, query: { view: "full" } },
      effect: "read", token: async () => WORKLOAD, apiKey: { header: "x-api-key", value: "api-key-value" }, timeoutMs: 5_000, fetch,
    });
    const call = calls[0]!;
    expect(call.url.pathname).toBe("/core/customers/a%2Fb%3Fc");
    expect(call.url.searchParams.get("view")).toBe("full");
    expect(call.init.method).toBe("GET");
    expect(call.init.redirect).toBe("error");
    expect(header(call, "authorization")).toBe(`Bearer ${WORKLOAD}`);
    expect(header(call, "x-api-key")).toBe("api-key-value");
    expect(result.output).toEqual({ operationId: "getCustomer", status: 200, body: { customerId: "a/b", tier: "gold" } });
    expect(result.providerRequestId).toBe("req-1");
  });

  it("refuses unlisted operations, traversal, mutating methods on read capabilities and redirects", async () => {
    const { fetch } = fakeFetch(() => ({ status: 307, headers: { location: "https://elsewhere.example" } }));
    const base = { baseUrl, operations, effect: "read", apiKey: { header: "x-api-key", value: "k" }, timeoutMs: 1_000, fetch };
    await expect(invokeHttpOperation({ ...base, operationId: "deleteEverything", input: {} })).rejects.toThrow("adapter.http_operation_not_allowlisted");
    await expect(invokeHttpOperation({ ...base, operationId: "toString", input: {} })).rejects.toThrow("adapter.http_operation_not_allowlisted");
    await expect(invokeHttpOperation({ ...base, operationId: "getCustomer", input: { pathParams: { customerId: ".." } } })).rejects.toThrow("adapter.http_operation_path_parameter_invalid");
    await expect(invokeHttpOperation({ ...base, operationId: "getCustomer", input: {} })).rejects.toThrow("adapter.http_operation_path_parameter_invalid");
    await expect(invokeHttpOperation({ ...base, operationId: "createCase", input: { body: {} } })).rejects.toThrow("adapter.http_operation_effect_insufficient");
    await expect(invokeHttpOperation({ ...base, operationId: "getCustomer", input: { pathParams: { customerId: "1" } } })).rejects.toThrow("adapter.http_operation_redirect_refused");
    await expect(invokeHttpOperation({ baseUrl, operations, effect: "read", timeoutMs: 1_000, fetch, operationId: "getCustomer", input: { pathParams: { customerId: "1" } } }))
      .rejects.toThrow("adapter.http_operation_credential_missing");
    const posted = fakeFetch(() => ({ status: 201, body: { caseId: "c-1" } }));
    const created = await invokeHttpOperation({ ...base, fetch: posted.fetch, effect: "external", operationId: "createCase", input: { body: { subject: "Jane" } } });
    expect(posted.calls[0]!.body).toEqual({ subject: "Jane" });
    expect(created.output).toMatchObject({ status: 201, body: { caseId: "c-1" } });
    const html = fakeFetch(() => ({ body: "<html>login</html>" }));
    await expect(invokeHttpOperation({ ...base, fetch: html.fetch, operationId: "getCustomer", input: { pathParams: { customerId: "1" } } }))
      .rejects.toThrow("adapter.http_operation_response_invalid");
  });

  it("validates the operations allowlist", () => {
    expect(parseHttpOperations(undefined)).toEqual({});
    expect(operations.createCase).toEqual({ method: "POST", path: "/cases" });
    for (const bad of ["[]", "{", JSON.stringify({ x: { method: "TRACE", path: "/a" } }), JSON.stringify({ x: { method: "GET", path: "/a/../b" } }),
      JSON.stringify({ x: { method: "GET", path: "https://evil.example/a" } }), JSON.stringify({ x: { method: "GET", path: "/a?b=1" } }), JSON.stringify({ "bad id": { method: "GET", path: "/a" } })]) {
      expect(() => parseHttpOperations(bad)).toThrow("adapter.http_operations_invalid");
    }
  });
});
