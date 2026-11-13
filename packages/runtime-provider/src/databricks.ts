import { stableDigest, type RuntimeInvocationAnyVersion, type RuntimeInvocationResult, type RuntimeInvocationStatus } from "@ehf/contracts";
import { SpanKind, withSpan } from "@ehf/telemetry";
import { LocalHttpRuntimeProvider, type RuntimeProvider } from "./index.js";

type Fetch = typeof globalThis.fetch;

const DATABRICKS_HOST = /\.(cloud\.databricks\.com|azuredatabricks\.net|gcp\.databricks\.com|databricksapps\.com)$/;

function databricksUrl(value: string, code: string, allowLocal: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(code); }
  const local = allowLocal && url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname);
  if (!local && (url.protocol !== "https:" || !DATABRICKS_HOST.test(url.hostname))) throw new Error(code);
  if (url.username || url.password || url.hash) throw new Error(code);
  return url;
}

export type DatabricksTokenSource = { kind: "oauth_m2m"; workspaceHost: string; clientId: string; clientSecret: string };

/**
 * Databricks workspace token provider. OAuth M2M uses the workspace's client-credentials
 * endpoint with a service principal, which works on every cloud Databricks runs on. Tokens
 * are cached until a minute before expiry and never surface in
 * errors.
 */
export function createDatabricksTokenProvider(source: DatabricksTokenSource, options: { fetchImpl?: Fetch; allowLocal?: boolean; now?: () => number } = {}): () => Promise<string> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  let cached: { token: string; expiresAt: number } | null = null;
  return async () => {
    if (cached && cached.expiresAt - 60_000 > now()) return cached.token;
    const host = databricksUrl(source.workspaceHost, "runtime.databricks_workspace_invalid", options.allowLocal ?? false);
    const response = await fetchImpl(new URL("/oidc/v1/token", host), {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${source.clientId}:${source.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials", scope: "all-apis" }).toString(),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`runtime.databricks_token_http_${response.status}`);
    const body = await response.json() as { access_token?: unknown; expires_in?: unknown };
    if (typeof body.access_token !== "string" || !body.access_token) throw new Error("runtime.databricks_token_missing");
    const ttl = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3_600;
    cached = { token: body.access_token, expiresAt: now() + ttl * 1_000 };
    return body.access_token;
  };
}

/**
 * Runs the platform's per-node executor on Databricks.
 *
 * The runtime host is deployed as a Databricks App (or behind any Databricks-hosted HTTPS
 * endpoint) and speaks the same `runtime.invocation` protocol as the local host:
 * POST <endpoint>, GET <endpoint>/<invocationId>, POST <endpoint>/<invocationId>/cancel.
 * Authority is unchanged: the invocation carries a short-lived grant the host exchanges
 * at the envelope broker, and every capability call still goes through the gateway. Only
 * the hosting and the token audience differ.
 */
export class DatabricksRuntimeProvider implements RuntimeProvider {
  readonly kind = "databricks";
  readonly executionProfileDigest: string;
  private readonly delegate: LocalHttpRuntimeProvider;

  constructor(private readonly endpoint: string, token: () => Promise<string>, options: { fetchImpl?: Fetch; allowLocal?: boolean; bindingName?: string } = {}) {
    const url = databricksUrl(endpoint, "runtime.databricks_endpoint_invalid", options.allowLocal ?? false);
    this.delegate = new LocalHttpRuntimeProvider(url.toString(), token, options.fetchImpl);
    this.executionProfileDigest = stableDigest({
      contractVersion: "runtime.invocation.v1",
      provider: this.kind,
      endpoint: url.toString(),
      binding: options.bindingName ?? null,
    });
  }

  async invoke(request: RuntimeInvocationAnyVersion, signal: AbortSignal): Promise<RuntimeInvocationResult> {
    if (request.executionProfileDigest.replace(/^sha256:/, "") !== this.executionProfileDigest) {
      throw new Error("runtime.execution_profile_mismatch");
    }
    return withSpan("invoke_agent ehf-orchestrator", {
      kind: SpanKind.CLIENT,
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.provider.name": "databricks",
        "server.address": new URL(this.endpoint).hostname,
        "harness.execution.id": request.runId,
        "harness.invocation.id": request.invocationId,
      },
    }, () => this.delegate.invoke(request, signal));
  }

  getStatus(invocationId: string, signal?: AbortSignal): Promise<RuntimeInvocationStatus> {
    return this.delegate.getStatus(invocationId, signal);
  }

  cancel(invocationId: string, reason: string, signal?: AbortSignal): Promise<void> {
    return this.delegate.cancel(invocationId, reason, signal);
  }
}
