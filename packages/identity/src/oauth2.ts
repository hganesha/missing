/**
 * OAuth 2.0 client-credentials grant (RFC 6749 §4.4) against any authorization server.
 *
 * Used for outbound integration deliveries whose receiver expects a bearer token: the
 * connector names the token endpoint, the client and the requested scope, and the client
 * secret is resolved from a secret reference at call time. Tokens are cached per
 * (endpoint, client, scope) until a minute before they expire and never appear in errors.
 */
export type ClientCredentials = { tokenUrl: string; clientId: string; clientSecret: string; scope: string };

type Cached = { token: string; expiresAt: number };
const cache = new Map<string, Cached>();

export async function clientCredentialsToken(
  input: ClientCredentials,
  options: { fetch?: typeof fetch; now?: () => number } = {},
): Promise<string> {
  const url = new URL(input.tokenUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("oauth2.token_url_invalid");
  const now = options.now ?? Date.now;
  const key = JSON.stringify([url.href, input.clientId, input.scope]);
  const hit = cache.get(key);
  if (hit && hit.expiresAt - 60_000 > now()) return hit.token;
  const response = await (options.fetch ?? fetch)(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${Buffer.from(`${encodeURIComponent(input.clientId)}:${encodeURIComponent(input.clientSecret)}`).toString("base64")}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({ grant_type: "client_credentials", scope: input.scope }).toString(),
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`oauth2.token_http_${response.status}`);
  const body = await response.json().catch(() => ({})) as { access_token?: unknown; expires_in?: unknown; token_type?: unknown };
  if (typeof body.access_token !== "string" || !body.access_token) throw new Error("oauth2.token_missing");
  if (typeof body.token_type === "string" && body.token_type.toLowerCase() !== "bearer") throw new Error("oauth2.token_type_unsupported");
  const ttl = typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 300;
  cache.set(key, { token: body.access_token, expiresAt: now() + ttl * 1_000 });
  return body.access_token;
}
