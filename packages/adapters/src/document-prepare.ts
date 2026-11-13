import type { DocumentLayout, DocumentModelFields } from "@ehf/contracts";
import { cachedTokenProvider, type AccessTokenProvider } from "./cloud-http.js";
import { AZURE_COGNITIVE_SERVICES_SCOPE, analyzeLayoutAzure, azureLayoutEndpoint } from "./document-layout-azure.js";
import { AZURE_PREBUILT_ROUTES, extractModelFieldsAzure, extractReleasedModelFieldsAzure } from "./document-model-azure.js";
import { invokeEvidencePipeline, type EvidencePipelineInvocation } from "./evidence-pipeline.js";
import type { AdapterResult } from "./index.js";

/**
 * Document preparation with an optional layout provider (document factory plan, Phase 1).
 *
 * The evidence pipeline decodes text natively and never calls a provider. When the original is an
 * image, or the pipeline reports that native parsing found image-only or text-poor pages
 * (`layout_recommended`), the bound layout provider analyzes the original here, in the platform, and
 * the pipeline prepares again from that canonical layout. Without a provider an image fails closed
 * (`adapter.document_layout_not_configured`) and a recommended PDF keeps its native result, flagged.
 *
 * Sending a document to a remote provider needs two settings: a provider, and the explicit
 * `DOCUMENT_LAYOUT_REMOTE_ALLOWED=true`. Both default off.
 */
export type LayoutProvider = { id: string; analyze: (content: Uint8Array) => Promise<DocumentLayout> };

const IMAGE = /\.(png|jpe?g|tiff?|bmp|heif)$/i;

export async function prepareDocument(invocation: Omit<EvidencePipelineInvocation, "operation">, layoutProvider: LayoutProvider | null): Promise<AdapterResult> {
  const input = invocation.input && typeof invocation.input === "object" ? invocation.input as Record<string, unknown> : {};
  const filename = typeof input.filename === "string" ? input.filename : "";
  const bytes = () => Uint8Array.from(Buffer.from(String(input.contentBase64 ?? ""), "base64"));
  const withLayout = async (reason: "image" | "native_text_insufficient") => {
    const layout = await layoutProvider!.analyze(bytes());
    const result = await invokeEvidencePipeline({ ...invocation, operation: "prepare", input: { ...input, layout } });
    (result.output as Record<string, unknown>).layout = { provider: layoutProvider!.id, model: layout.model, modelVersion: layout.model_version ?? null, reason };
    return result;
  };
  if (IMAGE.test(filename)) {
    if (!layoutProvider) throw new Error("adapter.document_layout_not_configured");
    return withLayout("image");
  }
  const native = await invokeEvidencePipeline({ ...invocation, operation: "prepare", input });
  const data = (native.output as { data?: Record<string, unknown> }).data ?? {};
  if (data.layout_recommended !== true) return native;
  if (layoutProvider) return withLayout("native_text_insufficient");
  (native.output as Record<string, unknown>).layout = { provider: null, reason: "native_text_insufficient", recommended: true };
  return native;
}

type Env = Record<string, string | undefined>;

/** The Azure Document Intelligence resource settings an environment configures: endpoint, authentication and timeout. */
function azureDocumentIntelligenceOptions(env: Env, fetch: typeof globalThis.fetch, timeoutVariable: string, defaultTimeoutMs: number) {
  const endpoint = azureLayoutEndpoint(env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT ?? "");
  const mode = (env.AZURE_DOCUMENT_INTELLIGENCE_AUTH ?? "managed_identity").trim();
  let auth: Parameters<typeof analyzeLayoutAzure>[1]["auth"];
  if (mode === "key") {
    const name = env.AZURE_DOCUMENT_INTELLIGENCE_KEY_ENV ?? "AZURE_DOCUMENT_INTELLIGENCE_KEY";
    if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name) || !env[name]) throw new Error("adapter.document_layout_credential_missing");
    auth = { kind: "api_key", key: env[name]! };
  } else if (mode === "managed_identity") {
    auth = { kind: "bearer", token: azureManagedIdentityToken(env, fetch, AZURE_COGNITIVE_SERVICES_SCOPE) };
  } else throw new Error("adapter.document_layout_auth_unsupported");
  const timeoutMs = Number(env[timeoutVariable] ?? defaultTimeoutMs);
  return { endpoint, auth, fetch, timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(timeoutMs, 300_000) : defaultTimeoutMs };
}

/**
 * The layout provider an environment configures, or null. `DOCUMENT_LAYOUT_PROVIDER` names it
 * (`azure_document_intelligence`; default none) and `DOCUMENT_LAYOUT_REMOTE_ALLOWED=true` consents to
 * sending originals to it. Azure authenticates with managed identity by default
 * (`AZURE_DOCUMENT_INTELLIGENCE_AUTH=managed_identity`), or a resource key from the variable named by
 * `AZURE_DOCUMENT_INTELLIGENCE_KEY_ENV` when `AZURE_DOCUMENT_INTELLIGENCE_AUTH=key`.
 */
export function layoutProviderFromEnv(env: Env, fetch: typeof globalThis.fetch = globalThis.fetch): LayoutProvider | null {
  const provider = (env.DOCUMENT_LAYOUT_PROVIDER ?? "none").trim();
  if (provider === "none" || provider === "") return null;
  if (provider !== "azure_document_intelligence") throw new Error("adapter.document_layout_provider_unsupported");
  if (env.DOCUMENT_LAYOUT_REMOTE_ALLOWED !== "true") return null;
  const options = azureDocumentIntelligenceOptions(env, fetch, "DOCUMENT_LAYOUT_TIMEOUT_MS", 90_000);
  return { id: "azure_document_intelligence", analyze: content => analyzeLayoutAzure(content, options) };
}

/** Route A: a provider extraction model that reads an original and returns catalog field candidates. */
export type DocumentModelProvider = {
  id: string;
  /** Whether the provider has a model for this catalog type. */
  supports: (documentType: string) => boolean;
  extract: (content: Uint8Array, documentType: string) => Promise<DocumentModelFields>;
  /** The same on a Document Factory release's model for the type (custom, composed or a released prebuilt). */
  extractReleased?: (content: Uint8Array, documentType: string, released: { route: "custom" | "prebuilt"; providerModelId: string }) => Promise<DocumentModelFields>;
};

/**
 * The extraction-model provider (Route A) an environment configures, or null. `DOCUMENT_MODEL_PROVIDER`
 * names it (`azure_document_intelligence`; default none) and its own consent,
 * `DOCUMENT_MODEL_REMOTE_ALLOWED=true`, allows sending originals to it. It uses the same Azure resource
 * settings as the layout provider.
 */
export function documentModelProviderFromEnv(env: Env, fetch: typeof globalThis.fetch = globalThis.fetch): DocumentModelProvider | null {
  const provider = (env.DOCUMENT_MODEL_PROVIDER ?? "none").trim();
  if (provider === "none" || provider === "") return null;
  if (provider !== "azure_document_intelligence") throw new Error("adapter.document_model_provider_unsupported");
  if (env.DOCUMENT_MODEL_REMOTE_ALLOWED !== "true") return null;
  const options = azureDocumentIntelligenceOptions(env, fetch, "DOCUMENT_MODEL_TIMEOUT_MS", 90_000);
  return {
    id: "azure_document_intelligence",
    supports: documentType => Object.hasOwn(AZURE_PREBUILT_ROUTES, documentType),
    extract: (content, documentType) => extractModelFieldsAzure(content, documentType, options),
    extractReleased: (content, documentType, released) => extractReleasedModelFieldsAzure(content, documentType, released, options),
  };
}

/**
 * An Azure managed identity token for one scope: the Container Apps / App Service identity endpoint
 * (`IDENTITY_ENDPOINT`, `IDENTITY_HEADER`) when present, else the instance metadata service. A
 * user-assigned identity is chosen with `AZURE_CLIENT_ID`. Tokens are cached until shortly before expiry.
 */
export function azureManagedIdentityToken(env: Env, fetch: typeof globalThis.fetch, scope: string): AccessTokenProvider {
  const resource = scope.replace(/\/\.default$/, "");
  return cachedTokenProvider(async () => {
    const query = new URLSearchParams({ resource, ...(env.AZURE_CLIENT_ID ? { client_id: env.AZURE_CLIENT_ID } : {}) });
    let url: string, headers: Record<string, string>;
    if (env.IDENTITY_ENDPOINT && env.IDENTITY_HEADER) {
      const base = new URL(env.IDENTITY_ENDPOINT);
      if (!["localhost", "127.0.0.1"].includes(base.hostname) && base.protocol !== "https:") throw new Error("adapter.managed_identity_endpoint_invalid");
      query.set("api-version", "2019-08-01");
      url = `${base.origin}${base.pathname}?${query}`;
      headers = { "X-IDENTITY-HEADER": env.IDENTITY_HEADER };
    } else {
      query.set("api-version", "2018-02-01");
      url = `http://169.254.169.254/metadata/identity/oauth2/token?${query}`;
      headers = { Metadata: "true" };
    }
    let response: Response;
    try {
      response = await fetch(url, { method: "GET", headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
    } catch {
      throw new Error("adapter.managed_identity_unreachable");
    }
    if (!response.ok) throw new Error(`adapter.managed_identity_http_${response.status}`);
    const body = await response.json().catch(() => ({})) as { access_token?: unknown; expires_on?: unknown };
    const expires = Number(body.expires_on);
    if (typeof body.access_token !== "string" || !body.access_token || !Number.isFinite(expires)) throw new Error("adapter.managed_identity_response_invalid");
    return { token: body.access_token, expiresAt: expires * 1000 };
  });
}
