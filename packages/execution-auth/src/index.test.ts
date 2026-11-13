import { createPublicKey, generateKeyPairSync } from "node:crypto";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import type { BusinessCommandType, EffectClass } from "@ehf/contracts";
import {
  isDelegatedEnvelope,
  mintDelegatedEnvelope,
  mintExecutionEnvelope,
  mintIntegrationEnvelope,
  mintRuntimeGrant,
  verifyExecutionEnvelope,
  verifyIntegrationEnvelope,
  verifyRuntimeGrant,
} from "./index.js";

const secret = "a-local-test-secret-that-is-long-enough";

describe("execution envelope", () => {
  it("round trips scoped authority", async () => {
    const token = await mintExecutionEnvelope({
      tenantId: "tenant_demo", caseId: "case_1",
      secret,
      invocationId: "inv-1",
      runId: "run-1",
      nodeId: "screen",
      attempt: 1,
      planDigest: "a".repeat(64),
      permissionDigest: "b".repeat(64),
      capabilities: ["screening.sanctions.search"],
      effects: ["read"],
      caseReads: [{ id: "subject", source: "case", path: "case.subject", purpose: "KYC_SCREENING", classification: "CONFIDENTIAL", required: true }],
      caseReadPolicies: [{ classification: "CONFIDENTIAL", action: "allow" }],
      fencingEpoch: 2,
    });
    const claims = await verifyExecutionEnvelope(token, secret);
    expect(claims).toMatchObject({
      jti: "inv-1",
      run_id: "run-1",
      node_id: "screen",
      capabilities: ["screening.sanctions.search"],
      case_reads: [expect.objectContaining({ id: "subject", purpose: "KYC_SCREENING" })],
      case_read_policies: [{ classification: "CONFIDENTIAL", action: "allow" }],
      fencing_epoch: 2,
    });
  });

  it("rejects a token under a different secret", async () => {
    const token = await mintExecutionEnvelope({
      tenantId: "tenant_demo", caseId: "case_1",
      secret,
      invocationId: "inv-2",
      runId: "run-1",
      nodeId: "screen",
      attempt: 1,
      planDigest: "a".repeat(64),
      permissionDigest: "b".repeat(64),
      capabilities: [],
      effects: [],
      fencingEpoch: 1,
    });
    await expect(verifyExecutionEnvelope(token, "another-secret-that-is-long-enough")).rejects.toThrow();
  });

  it("uses asymmetric keys for cloud execution envelopes and runtime grants", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    const envelope = await mintExecutionEnvelope({
      tenantId: "tenant_demo", caseId: "case_1",
      secret: privateKey,
      invocationId: "inv-rsa",
      runId: "run-rsa",
      nodeId: "screen",
      attempt: 1,
      planDigest: "a".repeat(64),
      permissionDigest: "b".repeat(64),
      capabilities: ["screening.sanctions.search"],
      effects: ["read"],
      fencingEpoch: 4,
    });
    await expect(verifyExecutionEnvelope(envelope, publicKey)).resolves.toMatchObject({
      jti: "inv-rsa",
      run_id: "run-rsa",
      fencing_epoch: 4,
    });

    const grant = await mintRuntimeGrant({
      secret: privateKey,
      grantId: "grant-rsa",
      runId: "run-rsa",
      attempt: 1,
      workerId: "worker-1",
      planDigest: "a".repeat(64),
      fencingEpoch: 4,
      ttlSeconds: 60,
    });
    await expect(verifyRuntimeGrant(grant, publicKey)).resolves.toMatchObject({
      jti: "grant-rsa",
      worker_id: "worker-1",
      fencing_epoch: 4,
    });
    // A key management service typically publishes only the public RSA components
    // (a JWK). The verifier must accept that JWK as well as a PEM.
    const { kty, n, e } = createPublicKey(publicKey).export({ format: "jwk" });
    await expect(verifyRuntimeGrant(grant, JSON.stringify({ kty, n, e }))).resolves.toMatchObject({
      jti: "grant-rsa",
      worker_id: "worker-1",
    });
    await expect(verifyExecutionEnvelope(envelope, secret)).rejects.toThrow();
  });
});

describe("integration envelope", () => {
  it("round trips deployment, binding, case and typed intent authority", async () => {
    const token = await mintIntegrationEnvelope({
      secret,
      envelopeId: "integration-1",
      tenantId: "tenant_demo",
      deploymentId: "development",
      bindingId: "partner-command",
      bindingRevision: 3,
      planDigest: "a".repeat(64),
      caseId: "case_1",
      intent: "submit_case_command",
      commandType: "AddSubject",
      nonce: "ingress_1",
      ttlSeconds: 30,
    });
    await expect(verifyIntegrationEnvelope(token, secret)).resolves.toMatchObject({
      jti: "integration-1",
      tenant_id: "tenant_demo",
      binding_id: "partner-command",
      binding_revision: 3,
      case_id: "case_1",
      intent: "submit_case_command",
      command_type: "AddSubject",
      nonce: "ingress_1",
    });
    await expect(verifyIntegrationEnvelope(token, "different-integration-secret-long-enough")).rejects.toThrow();
  });
});

describe("delegated envelope", () => {
  const parentInput = {
    tenantId: "tenant_demo", caseId: "case_1", secret, invocationId: "inv-skill", runId: "run-1", nodeId: "verify",
    attempt: 1, planDigest: "a".repeat(64), permissionDigest: "b".repeat(64), workItemId: "work-1", workFencingEpoch: 3,
    capabilities: ["skill.sample.registry.verify.v1", "business.registry.lookup.v1", "reference.identifier.lookup.v1"],
    effects: ["read", "paid"] as EffectClass[],
    caseWrites: ["ProposeClaim"] as BusinessCommandType[],
    fencingEpoch: 2, ttlSeconds: 60,
  };

  it("narrows the parent and keeps its bindings", async () => {
    const parent = await verifyExecutionEnvelope(await mintExecutionEnvelope(parentInput), secret);
    const now = Math.floor(Date.now() / 1000);
    const minted = await mintDelegatedEnvelope({
      secret, parent, delegatedTo: "skills:sample.registry.verify@0.1.0",
      capabilities: ["business.registry.lookup.v1"], effects: ["read"], deadlineAt: now + 20,
    });
    const claims = await verifyExecutionEnvelope(minted.envelope, secret);
    expect(claims).toMatchObject({
      jti: "dlg:inv-skill", parent_jti: "inv-skill", delegated_to: "skills:sample.registry.verify@0.1.0",
      tenant_id: "tenant_demo", case_id: "case_1", run_id: "run-1", node_id: "verify", attempt: 1,
      work_item_id: "work-1", work_fencing_epoch: 3, fencing_epoch: 2,
      plan_digest: parent.plan_digest, permission_digest: parent.permission_digest,
      capabilities: ["business.registry.lookup.v1"], effects: ["read"], case_writes: [], case_reads: [],
    });
    expect(isDelegatedEnvelope(claims)).toBe(true);
    // TTL never exceeds the requested deadline...
    expect(claims.exp).toBeLessThanOrEqual(now + 20);
    // ...nor the parent's remaining lifetime.
    const longer = await verifyExecutionEnvelope((await mintDelegatedEnvelope({
      secret, parent, delegatedTo: "skills:sample.registry.verify@0.1.0", capabilities: [], effects: [], deadlineAt: now + 3_600,
    })).envelope, secret);
    expect(longer.exp).toBe(parent.exp);
  });

  it("refuses widening, chains and an expired deadline", async () => {
    const parent = await verifyExecutionEnvelope(await mintExecutionEnvelope(parentInput), secret);
    const now = Math.floor(Date.now() / 1000);
    const base = { secret, parent, delegatedTo: "skills:sample.registry.verify@0.1.0", effects: ["read"] as EffectClass[], deadlineAt: now + 20 };
    await expect(mintDelegatedEnvelope({ ...base, capabilities: ["screening.sanctions.v1"] })).rejects.toThrow("execution_auth.delegation_capability_not_in_parent");
    await expect(mintDelegatedEnvelope({ ...base, capabilities: [], effects: ["destructive"] })).rejects.toThrow("execution_auth.delegation_effect_not_in_parent");
    await expect(mintDelegatedEnvelope({ ...base, capabilities: [], deadlineAt: now - 1 })).rejects.toThrow("execution_auth.delegation_expired");
    await expect(mintDelegatedEnvelope({ ...base, capabilities: [], delegatedTo: "registry.verify" })).rejects.toThrow("execution_auth.delegated_to_invalid");
    const delegated = await verifyExecutionEnvelope((await mintDelegatedEnvelope({ ...base, capabilities: [] })).envelope, secret);
    await expect(mintDelegatedEnvelope({ ...base, parent: delegated, capabilities: [] })).rejects.toThrow("execution_auth.delegation_chain_refused");
  });

  it("rejects a token that carries only half of the delegation claims", async () => {
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({
      tenant_id: "t", case_id: null, run_id: "r", node_id: "n", attempt: 1, plan_digest: "a".repeat(64), permission_digest: "b".repeat(64),
      capabilities: [], effects: [], fencing_epoch: 1, delegated_to: "skills:sample.registry.verify@0.1.0",
    }).setProtectedHeader({ alg: "HS256" }).setIssuer("ehf-runtime").setAudience("ehf-capability-gateway").setJti("x")
      .setIssuedAt(now).setExpirationTime(now + 30).sign(new TextEncoder().encode(secret));
    await expect(verifyExecutionEnvelope(forged, secret)).rejects.toThrow();
  });
});
