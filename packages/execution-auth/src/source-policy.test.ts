import { describe, expect, it } from "vitest";
import { jwtVerify } from "jose";
import { mintSourceAuthorizationProof, verifyExecutionEnvelope } from "./index.js";

describe("source authorization transport proof", () => {
  const secret = "synthetic-source-policy-signing-secret";
  const input = { secret, tenantId: "wiring-tenant", operationId: "companies-house:business.registry.lookup", requestDigest: "a".repeat(64),
    decisionId: "SD-synthetic", expiresAt: new Date(Date.now() + 300_000).toISOString(), scope: { approved_endpoints: ["https://source.test"] } };
  it("binds exact scope and request bytes to a separate audience with at most 60 seconds of authority", async () => {
    const token = await mintSourceAuthorizationProof(input);
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { algorithms: ["HS256"], audience: "ehf-kyc-wiring", issuer: "ehf-source-policy" });
    expect(payload.request_digest).toBe(input.requestDigest);
    expect(payload.scope).toEqual(input.scope);
    expect(Number(payload.exp) - Number(payload.iat)).toBeLessThanOrEqual(60);
    await expect(verifyExecutionEnvelope(token, secret)).rejects.toThrow();
  });
  it("refuses expired or malformed proof requests", async () => {
    await expect(mintSourceAuthorizationProof({ ...input, expiresAt: "2020-01-01T00:00:00Z" })).rejects.toThrow("proof_scope_invalid");
    await expect(mintSourceAuthorizationProof({ ...input, requestDigest: "not-a-digest" })).rejects.toThrow("proof_scope_invalid");
  });
});
