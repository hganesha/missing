import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { stableDigest, type HarnessPlanV2 } from "@ehf/contracts";
import { createDatabase, admitPlan, createRun, revokeArtifactEntry } from "./index.js";
import { registerSourceArtifact, approveSourceArtifact, getSourceArtifact, requireSourceContext } from "./source-policy.js";

const fixture = JSON.parse(readFileSync(new URL("../../contracts/test-fixtures/source-policy.json", import.meta.url), "utf8"));
const planFixture = JSON.parse(readFileSync(new URL("../../contracts/test-fixtures/skill-bound.plan.json", import.meta.url), "utf8"));

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("source authorization PostgreSQL authority", () => {
  it("requires independent approval, pins immutable artifacts, isolates tenants and checks live revocation", async () => {
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    const tenantId = `source-policy-${randomUUID()}`;
    const register = (artifact: unknown) => registerSourceArtifact(db, { tenantId, actor: "author", artifact, expectedDigest: stableDigest(artifact) });
    try {
      const binding = await register(fixture.binding);
      await expect(getSourceArtifact(db, tenantId, "source-binding", binding.digest)).rejects.toThrow("not_approved");
      await expect(approveSourceArtifact(db, { tenantId, actor: "author", kind: "source-binding", digest: binding.digest })).rejects.toThrow("separation_of_duties");
      await approveSourceArtifact(db, { tenantId, actor: "reviewer", kind: "source-binding", digest: binding.digest });
      expect(await getSourceArtifact(db, tenantId, "source-binding", binding.digest)).toEqual(fixture.binding);
      await expect(getSourceArtifact(db, tenantId + "-other", "source-binding", binding.digest)).rejects.toThrow("not_registered");
      await expect(registerSourceArtifact(db, { tenantId, actor: "author", artifact: { ...fixture.binding, product: "changed" }, expectedDigest: binding.digest })).rejects.toThrow("digest_mismatch");
      await expect(db.query("update harness_control.source_artifacts set artifact=artifact where tenant_id=$1", [tenantId])).rejects.toThrow("immutable");

      const access = await register(fixture.access);
      await approveSourceArtifact(db, { tenantId, actor: "reviewer", kind: "source-access", digest: access.digest });
      const policy = await register(fixture.policy);
      await approveSourceArtifact(db, { tenantId, actor: "reviewer", kind: "source-policy", digest: policy.digest });
      const plan = structuredClone(planFixture) as HarnessPlanV2;
      plan.sourceAuthorization = { policyDigests: [policy.digest], bindings: [{ capabilityId: fixture.binding.capabilityId, connectorId: fixture.binding.connectorId, bindingDigest: binding.digest, accessDigest: access.digest }] };
      const { planId: _id, planDigest: _digest, ...content } = plan;
      plan.planDigest = stableDigest(content);
      await admitPlan(db, plan, tenantId);
      const context = { ...fixture.context, tenantId, planDigest: plan.planDigest };
      await expect(register({ ...context, tenantId: "other-tenant" })).rejects.toThrow("tenant_denied");
      const registeredContext = await register(context);
      await approveSourceArtifact(db, { tenantId, actor: "reviewer", kind: "source-context", digest: registeredContext.digest });
      const scope = { tenantId, caseId: context.caseId, planDigest: plan.planDigest, digest: registeredContext.digest };
      expect(await requireSourceContext(db, scope)).toEqual(context);
      await expect(requireSourceContext(db, { ...scope, caseId: "other-case" })).rejects.toThrow("scope_denied");
      await expect(requireSourceContext(db, { ...scope, planDigest: "c".repeat(64) })).rejects.toThrow("scope_denied");
      await expect(createRun(db, { tenantId, planDigest: plan.planDigest, runInput: { tenantId, caseId: context.caseId }, idempotencyKey: randomUUID() })).rejects.toThrow("context_required");
      const idempotencyKey = randomUUID();
      const input = { tenantId, planDigest: plan.planDigest, sourceContextDigest: registeredContext.digest, runInput: { tenantId, caseId: context.caseId }, idempotencyKey };
      const run = await createRun(db, input);
      expect(run.run.sourceContextDigest).toBe(registeredContext.digest);
      expect((await createRun(db, input)).created).toBe(false);
      await expect(db.query("update harness_runtime.runs set source_context_digest=$2 where run_id=$1", [run.run.runId, "a".repeat(64)])).rejects.toThrow("immutable");
      await revokeArtifactEntry(db, { tenantId, actor: "reviewer", kind: "source-policy", digest: policy.digest, reasonCode: "source_changed" });
      await expect(createRun(db, { ...input, idempotencyKey: randomUUID() })).rejects.toThrow("revoked");
    } finally { await db.end(); }
  });
});
