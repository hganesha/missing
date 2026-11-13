import { supportsS256Pkce } from "./oidc-discovery.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createLocalJWKSet, jwtVerify, type JWTPayload } from "jose";

export type BrowserOidcConfig = { issuer: string; clientId: string; clientSecret?: string | undefined; redirectUri: string; allowedOrigins: string[] };

/**
 * Generic OIDC authorization-code/PKCE client. No provider-specific authority.
 *
 * `config` may be a function when the provider is itself editable (the setup console):
 * it is resolved when a flow starts and again, with the flow's `meta`, before the code is
 * exchanged, so the caller can refuse a flow whose configuration changed in between.
 */
export function browserOidcClient<Meta = undefined>(config: BrowserOidcConfig | ((meta?: Meta) => BrowserOidcConfig | Promise<BrowserOidcConfig>), transport: typeof fetch = fetch) {
  const flows = new Map<string, { verifier: string; nonce: string; expires: number; meta: Meta | undefined }>();
  const resolveConfig = async (meta?: Meta) => typeof config === "function" ? config(meta) : config;
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const allowed = (options: BrowserOidcConfig, value: string) => {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || !options.allowedOrigins.includes(url.origin)) throw new Error("identity.endpoint_not_allowed");
    return url;
  };
  const json = async (options: BrowserOidcConfig, url: string, init: RequestInit = {}) => {
    const response = await transport(allowed(options, url), { ...init, redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!response.ok || !response.body) throw new Error("identity.endpoint_failed");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 1000000) throw new Error("identity.response_too_large"); chunks.push(part.value); } return JSON.parse(Buffer.concat(chunks).toString()); }
    finally { await reader.cancel().catch(() => undefined); }
  };
  const discover = async (options: BrowserOidcConfig) => {
    const value = await json(options, `${options.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    if (value.issuer !== options.issuer || !supportsS256Pkce(options.issuer, value)) throw new Error("identity.discovery_invalid");
    for (const key of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) { if (typeof value[key] !== "string") throw new Error("identity.discovery_invalid"); allowed(options, value[key]); }
    return value as { authorization_endpoint: string; token_endpoint: string; jwks_uri: string; token_endpoint_auth_methods_supported?: string[] };
  };
  return {
    async start(meta?: Meta) {
      for (const [key, flow] of flows) if (flow.expires < Date.now()) flows.delete(key);
      if (flows.size >= 1000) throw new Error("identity.flow_capacity");
      const options = await resolveConfig(meta);
      const discovery = await discover(options);
      const state = randomBytes(32).toString("hex"); const verifier = randomBytes(32).toString("hex"); const nonce = randomBytes(32).toString("hex");
      flows.set(digest(state), { verifier, nonce, expires: Date.now() + 600000, meta });
      const url = new URL(discovery.authorization_endpoint);
      url.search = new URLSearchParams({ response_type: "code", client_id: options.clientId, redirect_uri: options.redirectUri, scope: "openid profile", state, nonce, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256" }).toString();
      return { state, url: url.toString() };
    },
    /** Exchanges the code and verifies the ID token; returns it with its verified claims and the flow's meta. */
    async finish(code: string, state: string, cookie: string): Promise<{ idToken: string; claims: JWTPayload; meta: Meta | undefined }> {
      if (!/^[a-f0-9]{64}$/.test(state) || cookie.length !== state.length || !timingSafeEqual(Buffer.from(state), Buffer.from(cookie)) || code.length > 4096) throw new Error("identity.state_invalid");
      const flow = flows.get(digest(state)); flows.delete(digest(state));
      if (!flow || flow.expires < Date.now()) throw new Error("identity.flow_expired");
      const options = await resolveConfig(flow.meta);
      const discovery = await discover(options);
      const form = new URLSearchParams({ grant_type: "authorization_code", code, client_id: options.clientId, redirect_uri: options.redirectUri, code_verifier: flow.verifier });
      const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
      if (options.clientSecret) {
        if (discovery.token_endpoint_auth_methods_supported?.includes("client_secret_post")) form.set("client_secret", options.clientSecret);
        else headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`).toString("base64")}`;
      }
      const tokens = await json(options, discovery.token_endpoint, { method: "POST", headers, body: form });
      if (typeof tokens.id_token !== "string") throw new Error("identity.id_token_required");
      const jwks = await json(options, discovery.jwks_uri);
      const { payload } = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), { issuer: options.issuer, audience: options.clientId, algorithms: ["RS256", "PS256", "ES256"], requiredClaims: ["sub", "exp", "iat", "nonce"], maxTokenAge: "10m" });
      if (payload.nonce !== flow.nonce || (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== options.clientId) || (payload.azp && payload.azp !== options.clientId)) throw new Error("identity.token_claims_invalid");
      return { idToken: tokens.id_token, claims: payload, meta: flow.meta };
    },
  };
}
