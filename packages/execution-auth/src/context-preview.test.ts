import { expect, it } from "vitest";
import {
  mintContextPreviewProof,
  verifyContextPreviewProof,
  verifyExecutionEnvelope,
} from "./index.js";
const secret = "context-preview-test-secret-00000000000001";
it("binds interactive preview to tenant, caller and exact prepared snapshot and cannot authorize execution", async () => {
  const scope = {
    tenantId: "tenant",
    actor: "reviewer",
    requestDigest: "a".repeat(64),
  };
  const proof = await mintContextPreviewProof({
    ...scope,
    secret,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  await expect(
    verifyContextPreviewProof(proof, secret, scope),
  ).resolves.toBeUndefined();
  for (const changed of [
    { ...scope, tenantId: "other" },
    { ...scope, actor: "other" },
    { ...scope, requestDigest: "b".repeat(64) },
  ])
    await expect(
      verifyContextPreviewProof(proof, secret, changed),
    ).rejects.toThrow();
  await expect(verifyExecutionEnvelope(proof, secret)).rejects.toThrow();
  await expect(
    mintContextPreviewProof({
      ...scope,
      secret,
      expiresAt: "2020-01-01T00:00:00Z",
    }),
  ).rejects.toThrow("context.preview_authority_expired");
});
