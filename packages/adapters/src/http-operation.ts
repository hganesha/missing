/**
 * Allowlisted HTTP operations: one capability binding per operation of an internal or
 * partner API, reached only through the capability gateway. Works in front of any API
 * gateway or service (Kong, NGINX, Envoy, Apigee, a cloud API gateway, or the API
 * itself), because it needs nothing from the gateway but HTTP.
 *
 * The operation map is deployment configuration (`HTTP_OPERATIONS_JSON`), so a capability
 * can only ever reach the method and path template an operator approved. The caller
 * authenticates with the gateway's workload-identity token and/or a static API key header;
 * credentials never appear in a result or an error.
 */
import { inputFields, joinEndpoint, requestJson, type AccessTokenProvider, type Fetch } from "./cloud-http.js";
import type { AdapterResult } from "./index.js";

/** Operation ids: also the binding names a connector registers. */
export const HTTP_OPERATION_BINDING_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export type HttpOperation = { method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; path: string };

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const PATH = /^\/(?:[A-Za-z0-9_.~-]+|\{[A-Za-z_][A-Za-z0-9_]*\})(?:\/(?:[A-Za-z0-9_.~-]+|\{[A-Za-z_][A-Za-z0-9_]*\}))*\/?$/;
const HEADER_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Parse the operation allowlist: `{ "<operationId>": { "method": "GET", "path":
 * "/customers/{customerId}" } }`. Anything malformed rejects the whole map.
 */
export function parseHttpOperations(json: string | undefined): Record<string, HttpOperation> {
  if (!json?.trim()) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { throw new Error("adapter.http_operations_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("adapter.http_operations_invalid");
  const operations: Record<string, HttpOperation> = {};
  for (const [operationId, value] of Object.entries(parsed as Record<string, unknown>)) {
    const operation = record(value);
    const method = typeof operation.method === "string" ? operation.method.toUpperCase() : "";
    const path = operation.path;
    if (!HTTP_OPERATION_BINDING_PATTERN.test(operationId) || !METHODS.has(method) || typeof path !== "string"
      || !PATH.test(path) || path.split("/").some((segment) => segment === "." || segment === "..")) {
      throw new Error("adapter.http_operations_invalid");
    }
    operations[operationId] = { method: method as HttpOperation["method"], path };
  }
  return operations;
}

export type HttpOperationInvocation = {
  baseUrl: URL;
  operationId: string;
  operations: Record<string, HttpOperation>;
  input: unknown;
  /** The capability's declared effect: only a non-read effect may use a mutating method. */
  effect: string;
  /** Bearer token for the API (the gateway's workload identity), and/or a static API key header. */
  token?: AccessTokenProvider;
  apiKey?: { header: string; value: string };
  timeoutMs: number;
  fetch: Fetch;
};

function primitive(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value));
}

/** Call one allowlisted operation. Path parameters are encoded; redirects are refused. */
export async function invokeHttpOperation(request: HttpOperationInvocation): Promise<AdapterResult> {
  const operation = Object.hasOwn(request.operations, request.operationId) ? request.operations[request.operationId] : undefined;
  if (!HTTP_OPERATION_BINDING_PATTERN.test(request.operationId) || !operation) throw new Error("adapter.http_operation_not_allowlisted");
  if (operation.method !== "GET" && (request.effect === "none" || request.effect === "read")) {
    throw new Error("adapter.http_operation_effect_insufficient");
  }
  if (!request.token && !request.apiKey) throw new Error("adapter.http_operation_credential_missing");
  if (request.apiKey && (!HEADER_NAME.test(request.apiKey.header) || !request.apiKey.value)) throw new Error("adapter.http_operation_credential_missing");
  const fields = inputFields(request.input);
  const pathParams = record(fields.pathParams ?? fields.params);
  const path = operation.path.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
    const value = Object.hasOwn(pathParams, name) ? pathParams[name] : undefined;
    if (!primitive(value) || String(value) === "" || String(value) === "." || String(value) === "..") {
      throw new Error("adapter.http_operation_path_parameter_invalid");
    }
    return encodeURIComponent(String(value));
  });
  const query: Record<string, string> = {};
  for (const [name, value] of Object.entries(record(fields.query))) {
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name) || !primitive(value)) throw new Error("adapter.http_operation_query_invalid");
    query[name] = String(value);
  }
  const headers: Record<string, string> = {};
  if (request.token) headers.authorization = `Bearer ${await request.token()}`;
  if (request.apiKey) headers[request.apiKey.header.toLowerCase()] = request.apiKey.value;
  const sendsBody = operation.method === "POST" || operation.method === "PUT" || operation.method === "PATCH";
  const { payload, status, headers: responseHeaders } = await requestJson(request.fetch, joinEndpoint(request.baseUrl, path, query), {
    method: operation.method,
    headers,
    ...(sendsBody && fields.body !== undefined ? { body: fields.body } : {}),
    timeoutMs: request.timeoutMs,
    errorPrefix: "adapter.http_operation",
  });
  return {
    output: { operationId: request.operationId, status, body: payload },
    provider: "http_operation",
    model: request.operationId,
    providerRequestId: responseHeaders.get("x-request-id") ?? responseHeaders.get("request-id"),
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };
}
