import { describe, expect, it } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { browserOidcClient } from "./browser-oidc.js";
import { OidcJwtPrincipalResolver } from "./principal.js";
describe("browser OIDC", () => {
  it("maps verified Entra oid and tenant claims to a stable directory identity while retaining the pairwise subject", async () => {
    const tenant = "11111111-1111-4111-8111-111111111111";
    const oid = "c3d83044-8cf1-49c0-9a35-116bca61090e";
    const issuer = `https://login.microsoftonline.com/${tenant}/v2.0`;
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const resolver = new OidcJwtPrincipalResolver({ issuer, audience: "client", jwks: { keys: [{ ...await exportJWK(publicKey), kid: "key" }] }, resolveTenant: () => "platform-tenant" });
    const token = async (tid: string) => new SignJWT({ oid, tid }).setProtectedHeader({ alg: "RS256", kid: "key" }).setSubject("pairwise-app-subject").setIssuer(issuer).setAudience("client").setExpirationTime("5m").sign(privateKey);
    expect(await resolver.resolve({ headers: { authorization: `Bearer ${await token(tenant)}` } })).toMatchObject({ subjectId: "pairwise-app-subject", directorySubjectId: `entra:${tenant}:${oid}`, roles: [] });
    await expect(resolver.resolve({ headers: { authorization: `Bearer ${await token(oid)}` } })).rejects.toThrow("authorization.tenant_unassigned");
  });
  it("uses PKCE and verifies signed nonce-bound ID tokens while refusing replay and untrusted discovery origins", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...await exportJWK(publicKey), kid: "key", alg: "RS256" };
    let nonce = ""; let verifier = ""; let tokenEndpoint = "https://id.example.com/token";
    const transport: typeof fetch = async (url, init) => {
      if (String(url).includes("openid-configuration")) return Response.json({ issuer: "https://id.example.com", authorization_endpoint: "https://id.example.com/authorize", token_endpoint: tokenEndpoint, jwks_uri: "https://id.example.com/jwks", code_challenge_methods_supported: ["S256"] });
      if (String(url).endsWith("/jwks")) return Response.json({ keys: [jwk] });
      verifier = new URLSearchParams(String(init?.body)).get("code_verifier")!;
      return Response.json({ id_token: await new SignJWT({ nonce, groups: ["admins"] }).setProtectedHeader({ alg: "RS256", kid: "key" }).setSubject("owner").setIssuer("https://id.example.com").setAudience("client").setIssuedAt().setExpirationTime("5m").sign(privateKey) });
    };
    const client = browserOidcClient({ issuer: "https://id.example.com", clientId: "client", redirectUri: "https://app.example.com/auth/callback", allowedOrigins: ["https://id.example.com"] }, transport);
    const flow = await client.start(); nonce = new URL(flow.url).searchParams.get("nonce")!;
    expect(new URL(flow.url).searchParams.get("code_challenge_method")).toBe("S256");
    await expect(client.finish("code", flow.state, "wrong-cookie")).rejects.toThrow();
    expect((await client.finish("code", flow.state, flow.state)).idToken).toMatch(/^ey/);
    expect(verifier).toHaveLength(64);
    await expect(client.finish("code", flow.state, flow.state)).rejects.toThrow("identity.flow_expired");
    tokenEndpoint = "https://untrusted.example.com/token";
    await expect(client.start()).rejects.toThrow("identity.endpoint_not_allowed");
  });
  it("grants only mapped application roles when the issuer emits directory groups", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const token = await new SignJWT({ groups: ["operators", "Platform.Admin"] }).setProtectedHeader({ alg: "RS256", kid: "key" }).setSubject("owner").setIssuer("https://id.example.com").setAudience("client").setIssuedAt().setExpirationTime("5m").sign(privateKey);
    const resolver = new OidcJwtPrincipalResolver({ issuer: "https://id.example.com", audience: "client", jwks: { keys: [{ ...await exportJWK(publicKey), kid: "key" }] }, resolveTenant: () => "tenant", rolesClaim: "groups", roleMappings: [{ group: "operators", role: "Harness.Operator" }] });
    expect((await resolver.resolve({ headers: { authorization: `Bearer ${token}` } })).roles).toEqual(["Harness.Operator"]);
  });
});
