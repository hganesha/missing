/** Entra v2 supports S256 but can omit its optional discovery metadata. */
export function supportsS256Pkce(issuer: string, document: Record<string, unknown>): boolean {
  const methods = document.code_challenge_methods_supported;
  if (methods !== undefined) return Array.isArray(methods) && methods.includes("S256");
  // Keep the compatibility exception tenant-specific and pin all protocol endpoints.
  const match = /^https:\/\/login\.microsoftonline\.com\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/v2\.0$/i.exec(issuer);
  if (!match) return false;
  const authority = `https://login.microsoftonline.com/${match[1]}`;
  return document.authorization_endpoint === `${authority}/oauth2/v2.0/authorize`
    && document.token_endpoint === `${authority}/oauth2/v2.0/token`
    && document.jwks_uri === `${authority}/discovery/v2.0/keys`;
}
