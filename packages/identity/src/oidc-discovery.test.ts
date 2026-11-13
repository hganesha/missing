import { describe, expect, it } from "vitest";
import { supportsS256Pkce } from "./oidc-discovery.js";
import { browserOidcClient } from "./browser-oidc.js";

const authority = "https://login.microsoftonline.com/fa3163fa-f1c7-4b8c-ab66-f6a62d3e38bd";
const issuer = `${authority}/v2.0`;
const document = { issuer, authorization_endpoint: `${authority}/oauth2/v2.0/authorize`, token_endpoint: `${authority}/oauth2/v2.0/token`, jwks_uri: `${authority}/discovery/v2.0/keys` };

describe("OIDC PKCE discovery", () => {
  it("accepts Entra's omitted metadata while still initiating S256", async () => {
    const client = browserOidcClient({ issuer, clientId: "client", redirectUri: "https://app.example.com/auth/callback", allowedOrigins: ["https://login.microsoftonline.com"] }, async () => Response.json(document));
    const url = new URL((await client.start()).url);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it("requires explicit S256 outside the pinned Entra tenant endpoints", () => {
    expect(supportsS256Pkce("https://id.example.com", {})).toBe(false);
    expect(supportsS256Pkce(issuer, { ...document, token_endpoint: "https://evil.example.com/token" })).toBe(false);
    expect(supportsS256Pkce(issuer.replace(".com/", ".com.evil.example/"), document)).toBe(false);
    expect(supportsS256Pkce("https://login.microsoftonline.com/common/v2.0", document)).toBe(false);
    expect(supportsS256Pkce(issuer, { ...document, code_challenge_methods_supported: ["plain"] })).toBe(false);
    expect(supportsS256Pkce(issuer, { ...document, code_challenge_methods_supported: null })).toBe(false);
    expect(supportsS256Pkce("https://id.example.com", { code_challenge_methods_supported: ["S256"] })).toBe(true);
  });
});
