import {
  runtimeInvocationResultSchema,
  runtimeInvocationAnyVersionSchema,
  runtimeInvocationStatusSchema,
  stableDigest,
  type RuntimeInvocationAnyVersion,
  type RuntimeInvocationResult,
  type RuntimeInvocationStatus,
  type PlatformSettings,
  type RuntimeProviderKind,
} from "@ehf/contracts";
import { allowsInsecureEndpoints, createWorkloadTokenProvider, isProductionProfile, workloadAuth } from "@ehf/identity";
import { injectTraceContext } from "@ehf/telemetry";

export interface RuntimeProvider {
  readonly kind: RuntimeProviderKind;
  readonly executionProfileDigest: string;
  invoke(request: RuntimeInvocationAnyVersion, signal: AbortSignal): Promise<RuntimeInvocationResult>;
  /**
   * What the provider believes happened to an invocation.
   *
   * A dispatcher that timed out or lost its connection cannot distinguish an invocation
   * that is still running from one that finished with a result it never received. That
   * distinction decides whether retrying is safe, so it cannot be guessed.
   */
  getStatus(invocationId: string, signal?: AbortSignal): Promise<RuntimeInvocationStatus>;
  /**
   * Ask the provider to stop an invocation.
   *
   * Cancellation is best-effort by nature: it cannot unmake an effect the runtime has
   * already committed. The durable record distinguishes requested from effective
   * cancellation; this call only carries the request.
   */
  cancel(invocationId: string, reason: string, signal?: AbortSignal): Promise<void>;
}

function unknownStatus(invocationId: string): RuntimeInvocationStatus {
  return {
    contractVersion: "runtime.status.v1",
    invocationId,
    state: "unknown",
    providerMetadata: {},
  };
}

async function fetchStatus(input: {
  endpoint: string;
  token: string;
  invocationId: string;
  fetchImpl: Fetch;
  signal?: AbortSignal | undefined;
  headers?: Record<string, string> | undefined;
}): Promise<RuntimeInvocationStatus> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.token}`,
    ...input.headers,
  };
  injectTraceContext(headers);
  let response: Response;
  try {
    response = await input.fetchImpl(appendPath(input.endpoint, input.invocationId), {
      method: "GET",
      headers,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch {
    return unknownStatus(input.invocationId);
  }
  // A provider that cannot answer leaves the outcome genuinely unknown; reporting it as
  // failed would licence a retry that may duplicate an effect already committed.
  if (!response.ok) return unknownStatus(input.invocationId);
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return unknownStatus(input.invocationId);
  }
  const parsed = runtimeInvocationStatusSchema.safeParse(body);
  if (!parsed.success || parsed.data.invocationId !== input.invocationId) return unknownStatus(input.invocationId);
  return parsed.data;
}

async function postCancel(input: {
  endpoint: string;
  token: string;
  invocationId: string;
  reason: string;
  fetchImpl: Fetch;
  signal?: AbortSignal | undefined;
  headers?: Record<string, string> | undefined;
}): Promise<void> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.token}`,
    "content-type": "application/json",
    ...input.headers,
  };
  injectTraceContext(headers);
  const response = await input.fetchImpl(appendPath(input.endpoint, `${input.invocationId}/cancel`), {
    method: "POST",
    headers,
    body: JSON.stringify({ reason: input.reason }),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`runtime.cancel_http_${response.status}`);
  }
}

type Fetch = typeof globalThis.fetch;

function appendPath(endpoint: string, suffix: string): string {
  const url = new URL(endpoint);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${suffix.split("/").map(encodeURIComponent).join("/")}`;
  return url.toString();
}

async function postInvocation(input: {
  endpoint: string;
  token: string;
  request: RuntimeInvocationAnyVersion;
  signal: AbortSignal;
  fetchImpl: Fetch;
}): Promise<RuntimeInvocationResult> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${input.token}`,
    "content-type": "application/json",
  };
  injectTraceContext(headers);
  const response = await input.fetchImpl(input.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(input.request),
    signal: input.signal,
  });
  const body = await response.json() as unknown;
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      ? String((body as { error: unknown }).error)
      : `runtime.provider_http_${response.status}`;
    throw new Error(message);
  }
  const candidate = body && typeof body === "object" && "result" in body
    ? (body as { result: unknown }).result
    : body;
  const result = runtimeInvocationResultSchema.parse(candidate);
  if (result.invocationId !== input.request.invocationId || result.runId !== input.request.runId) {
    throw new Error("runtime.result_correlation_mismatch");
  }
  return result;
}

export class LocalHttpRuntimeProvider implements RuntimeProvider {
  readonly kind: RuntimeProviderKind = "local_http";
  readonly executionProfileDigest: string;

  constructor(
    private readonly endpoint: string,
    private readonly authToken: string | (() => Promise<string>),
    private readonly fetchImpl: Fetch = globalThis.fetch,
    provider: RuntimeProviderKind = "local_http",
  ) {
    // The profile digest seed keeps its original contract label so existing execution
    // profile digests (and the releases and deployments that pin them) stay stable; it
    // names the profile, not the invocation envelope, which is runtime.invocation.v2.
    this.executionProfileDigest = stableDigest({
      contractVersion: "runtime.invocation.v1",
      provider,
      endpoint,
    });
  }

  async invoke(request: RuntimeInvocationAnyVersion, signal: AbortSignal): Promise<RuntimeInvocationResult> {
    runtimeInvocationAnyVersionSchema.parse(request);
    return postInvocation({
      endpoint: this.endpoint,
      token: await this.token(),
      request,
      signal,
      fetchImpl: this.fetchImpl,
    });
  }

  async getStatus(invocationId: string, signal?: AbortSignal): Promise<RuntimeInvocationStatus> {
    return fetchStatus({
      endpoint: this.statusEndpoint(), token: await this.token(), invocationId,
      fetchImpl: this.fetchImpl, signal,
    });
  }

  async cancel(invocationId: string, reason: string, signal?: AbortSignal): Promise<void> {
    return postCancel({
      endpoint: this.statusEndpoint(), token: await this.token(), invocationId, reason,
      fetchImpl: this.fetchImpl, signal,
    });
  }

  /** Sibling of the invocation endpoint: .../invocations -> .../invocations */
  private statusEndpoint(): string {
    return this.endpoint.replace(/\/$/, "");
  }

  private token(): Promise<string> {
    return typeof this.authToken === "string" ? Promise.resolve(this.authToken) : this.authToken();
  }
}

/**
 * The platform's runtime host deployed as its own HTTPS service -- a separate Kubernetes
 * deployment, VM or any container platform -- outside the dispatcher's network. It speaks
 * the same `runtime.invocation` protocol as the local host; it differs in being reached
 * over verified TLS only and in counting as a hosted runtime for production agents.
 */
export class HostedHttpRuntimeProvider extends LocalHttpRuntimeProvider {
  override readonly kind = "hosted_http" as const;

  constructor(endpoint: string, authToken: string | (() => Promise<string>), fetchImpl: Fetch = globalThis.fetch, options: { allowLocal?: boolean } = {}) {
    super(hostedEndpoint(endpoint, options.allowLocal ?? false), authToken, fetchImpl, "hosted_http");
  }
}

function hostedEndpoint(endpoint: string, allowLocal: boolean): string {
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new Error("runtime.hosted_endpoint_invalid"); }
  const local = allowLocal && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || url.username || url.password || url.hash) throw new Error("runtime.hosted_endpoint_invalid");
  return url.toString();
}

/**
 * Project an administered runtime binding onto the environment shape this module reads.
 *
 * The binding carries where a runtime is reached, never a credential: the dispatcher's
 * service token or workload identity stays in the process environment, so administering
 * the binding cannot hand anyone a way in. A null field is
 * left out rather than written as an empty string, so it falls through to whatever the
 * environment already configured instead of blanking it.
 */
export function runtimeEnvOverlay(settings: Omit<PlatformSettings["runtime"], "bindings"> & { bindings?: PlatformSettings["runtime"]["bindings"] }): NodeJS.ProcessEnv {
  return {
    RUNTIME_PROVIDER: settings.provider,
    RUNTIME_LOCAL_ENDPOINT: settings.localEndpoint,
  };
}
function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`runtime.config_missing:${name}`);
  return value;
}

/** The dispatcher's own credential for a runtime host: its service token or workload identity. */
export function runtimeHostCredential(env: NodeJS.ProcessEnv): () => Promise<string> {
  // Fail when the provider is built, not on the first invocation.
  if (workloadAuth(env) === "static_token") requiredEnv(env, "RUNTIME_HOST_AUTH_TOKEN");
  return createWorkloadTokenProvider({ staticTokenEnv: "RUNTIME_HOST_AUTH_TOKEN" }, env);
}

export function createRuntimeProviderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { fetchImpl?: Fetch } = {},
): RuntimeProvider {
  const kind = env.RUNTIME_PROVIDER ?? "local_http";
  if (kind === "local_http") {
    // Production dispatches only to an explicitly hosted runtime endpoint; development
    // may use the local runtime host container.
    return new LocalHttpRuntimeProvider(
      isProductionProfile(env)
        ? requiredEnv(env, "RUNTIME_HOSTED_ENDPOINT")
        : env.RUNTIME_LOCAL_ENDPOINT ?? "http://runtime-host-local:8088/invocations",
      runtimeHostCredential(env),
      options.fetchImpl,
    );
  }
  if (kind === "hosted_http") {
    return new HostedHttpRuntimeProvider(requiredEnv(env, "RUNTIME_HOSTED_ENDPOINT"), runtimeHostCredential(env), options.fetchImpl,
      { allowLocal: allowsInsecureEndpoints(env) });
  }
  throw new Error(`runtime.provider_unsupported:${kind}`);
}

export * from "./registry.js";
export { createDatabricksTokenProvider, DatabricksRuntimeProvider, type DatabricksTokenSource } from "./databricks.js";
