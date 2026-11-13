import { generateKeyPairSync, sign } from "node:crypto";
import { expect, it } from "vitest";
import { SignJWT } from "jose";
import { signCaseTraversalProof, verifyCaseTraversalProof, verifyExecutionEnvelope, verifyIntegrationEnvelope } from "./index.js";
it("uses the production RSA signer with a distinct audience and scoped expiring claims", async () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const scope = { tenantId: "tenant", actor: "author", requestDigest: "a".repeat(64) };
  const proof = await signCaseTraversalProof({ ...scope, signer: { algorithm: "RS256", keyId: "control", sign: async input => new Uint8Array(sign("RSA-SHA256", input, keys.privateKey)) }, expiresAt: new Date(Date.now() + 30000).toISOString() });
  await expect(verifyCaseTraversalProof(proof, publicKey, scope)).resolves.toBeUndefined();
  for (const field of ["tenantId", "actor", "requestDigest"] as const) await expect(verifyCaseTraversalProof(proof, publicKey, { ...scope, [field]: "other" })).rejects.toThrow();
  await expect(verifyExecutionEnvelope(proof, publicKey)).rejects.toThrow();
  await expect(verifyIntegrationEnvelope(proof, publicKey)).rejects.toThrow();
  await expect(signCaseTraversalProof({ ...scope, secret: "test-secret-that-is-at-least-24-chars", expiresAt: new Date(Date.now() - 1).toISOString() })).rejects.toThrow("context.traversal_authority_expired");
  const expired = await new SignJWT({ tenant_id: "tenant", actor: "author", request_digest: scope.requestDigest }).setProtectedHeader({ alg: "RS256" }).setIssuer("ehf-context-traversal").setAudience("ehf-case-traversal").setIssuedAt(Math.floor(Date.now()/1000)-60).setExpirationTime(Math.floor(Date.now()/1000)-30).sign(keys.privateKey);
  await expect(verifyCaseTraversalProof(expired, publicKey, scope)).rejects.toThrow();
});
