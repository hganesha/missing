/**
 * Transport rules shared by the platform capability adapters (Databricks, OpenAI-compatible
 * models, allowlisted HTTP operations).
 *
 * Every call is bounded by an AbortSignal timeout, refuses redirects (a redirect could carry
 * a bearer token to another host), and fails closed: any transport, status or shape problem
 * becomes a thrown `adapter.*` error code. Error codes never carry a response body, a URL
 * query string or a credential, because the gateway logs and returns them.
 */

export type Fetch = typeof globalThis.fetch;

/** Returns a bearer token for one audience. Implementations cache; callers never log it. */
export type AccessTokenProvider = () => Promise<string>;

/** Largest response body an adapter will read before failing closed. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export type JsonRequest = {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  /** Already form- or otherwise-encoded body; sent verbatim. */
  rawBody?: string;
  timeoutMs: number;
  /** Error-code prefix, e.g. `adapter.databricks_serving`. */
  errorPrefix: string;
};

export type JsonResponse = { payload: unknown; status: number; headers: Headers };

function boundedTimeout(timeoutMs: number): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return 1;
  return Math.min(Math.floor(timeoutMs), 600_000);
}

/** One JSON request with the shared transport rules. A 2xx with an empty body yields `null`. */
export async function requestJson(fetch: Fetch, url: URL, request: JsonRequest): Promise<JsonResponse> {
  const headers: Record<string, string> = { accept: "application/json", ...request.headers };
  let body: string | undefined;
  if (request.rawBody !== undefined) body = request.rawBody;
  else if (request.body !== undefined) {
    body = JSON.stringify(request.body);
    headers["content-type"] ??= "application/json";
  }
  let response: Response;
  try {
    response = await fetch(url, {
      method: request.method,
      headers,
      ...(body === undefined ? {} : { body }),
      redirect: "error",
      signal: AbortSignal.timeout(boundedTimeout(request.timeoutMs)),
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("gateway.source_policy_denied:")) throw error;
    const name = error instanceof Error ? error.name : "";
    throw new Error(name === "TimeoutError" || name === "AbortError" ? `${request.errorPrefix}_timeout` : `${request.errorPrefix}_unreachable`);
  }
  if (response.status >= 300 && response.status < 400) throw new Error(`${request.errorPrefix}_redirect_refused`);
  if (!response.ok) {
    // Drain without reading the body into any message.
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`${request.errorPrefix}_http_${response.status}`);
  }
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE_BYTES) throw new Error(`${request.errorPrefix}_response_too_large`);
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new Error(`${request.errorPrefix}_timeout`);
  }
  if (text.length > MAX_RESPONSE_BYTES) throw new Error(`${request.errorPrefix}_response_too_large`);
  if (!text.trim()) return { payload: null, status: response.status, headers: response.headers };
  try {
    return { payload: JSON.parse(text) as unknown, status: response.status, headers: response.headers };
  } catch {
    throw new Error(`${request.errorPrefix}_response_invalid`);
  }
}

/**
 * Cache a token until `skewMs` before it expires, and share one in-flight fetch between
 * concurrent callers so a burst of invocations asks the identity provider once.
 */
export function cachedTokenProvider(
  fetchToken: () => Promise<{ token: string; expiresAt: number }>,
  options: { now?: () => number; skewMs?: number } = {},
): AccessTokenProvider {
  const now = options.now ?? Date.now;
  const skewMs = options.skewMs ?? 60_000;
  let cached: { token: string; expiresAt: number } | undefined;
  let pending: Promise<{ token: string; expiresAt: number }> | undefined;
  return async () => {
    if (cached && now() < cached.expiresAt - skewMs) return cached.token;
    pending ??= fetchToken().finally(() => { pending = undefined; });
    cached = await pending;
    return cached.token;
  };
}

export type EndpointRules = {
  /** Error code thrown for any invalid value. */
  error: string;
  /** Hostname suffixes accepted over https; omitted means any https host. */
  hostSuffixes?: readonly string[];
  /** Development profile only: accept http://localhost and http://127.0.0.1 (tests, emulators). */
  allowLocalHttp?: boolean;
  /** Whether a path is allowed (an API base path such as `/v1`). */
  allowPath?: boolean;
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Parse an operator-configured endpoint. A bare hostname is read as https. */
export function parseCloudEndpoint(value: string | undefined, rules: EndpointRules): URL {
  const raw = value?.trim() ?? "";
  if (!raw) throw new Error(rules.error);
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    throw new Error(rules.error);
  }
  if (url.username || url.password || url.search || url.hash) throw new Error(rules.error);
  if (!rules.allowPath && url.pathname !== "/" && url.pathname !== "") throw new Error(rules.error);
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol === "http:") {
    if (!(rules.allowLocalHttp && local)) throw new Error(rules.error);
    return url;
  }
  if (url.protocol !== "https:") throw new Error(rules.error);
  if (local && rules.allowLocalHttp) return url;
  const host = url.hostname.toLowerCase();
  if (rules.hostSuffixes && !rules.hostSuffixes.some((suffix) => host.endsWith(suffix) && host.length > suffix.length)) {
    throw new Error(rules.error);
  }
  return url;
}

/** `base` joined with a relative path, keeping the base's own path. */
export function joinEndpoint(base: URL, path: string, query: Record<string, string> = {}): URL {
  const url = new URL(base.toString());
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
  return url;
}

/** The record a capability input carries its fields in (`input.input` when enveloped). */
export function inputFields(input: unknown): Record<string, unknown> {
  const envelope = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  return envelope.input && typeof envelope.input === "object" && !Array.isArray(envelope.input)
    ? envelope.input as Record<string, unknown>
    : envelope;
}

/** The free-text query a search input carries. */
export function queryText(input: unknown, errorCode: string): string {
  const fields = inputFields(input);
  const outer = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const value = typeof input === "string" ? input
    : [fields.query, fields.queryText, fields.text, outer.query, outer.prompt].find((item) => typeof item === "string");
  const query = typeof value === "string" ? value.trim() : "";
  if (!query || query.length > 8_000) throw new Error(errorCode);
  return query;
}

/** A bounded integer from an input field, clamped to [min, max]. */
export function boundedCount(fields: Record<string, unknown>, names: string[], fallback: number, min: number, max: number): number {
  for (const name of names) {
    const value = fields[name];
    if (typeof value === "number" && Number.isInteger(value)) return Math.min(max, Math.max(min, value));
  }
  return fallback;
}

export function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Results from an outside index or agent are data, never instructions. */
export const UNTRUSTED_EXTERNAL = "UNTRUSTED_EXTERNAL" as const;
