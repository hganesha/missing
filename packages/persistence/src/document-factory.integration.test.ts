import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { stableDigest } from "@ehf/contracts";
import { DEFAULT_FACTORY_GATES, evaluateGates, type DocumentModelRelease, type EvaluationReport, type ReleaseJob } from "@ehf/contracts/document-factory";
import { createDatabase } from "./index.js";
import {
  activateFactoryRelease, approveFactoryRelease, releasedDocumentModel, approveReleaseSpend, cancelReleaseJob, claimReleaseJob, createReleaseJob, listFactoryEvents,
  listFactoryReleases, recordEvaluationReport, registerDatasetVersion, registerFactoryRelease, rollbackFactoryRelease, saveModelVersion,
  saveTypeStrategy, listTypeStrategies, updateReleaseJob,
} from "./document-factory.js";
import { revokeArtifactEntry } from "./artifact-registry.js";

const sha = (seed: string) => stableDigest({ seed });
const now = () => new Date().toISOString();

function job(jobId: string, status: ReleaseJob["status"] = "awaiting_approval"): ReleaseJob {
  return {
    jobId, status, stage: "approval", selection: ["w9"], gates: DEFAULT_FACTORY_GATES,
    plan: [{ documentType: "w9", strategy: "azure_template", action: "train", blockers: [], datasetDigest: sha("w9-data"), reuseModelVersionId: null }],
    estimate: { neuralTrainingHours: 0, trainingCostUsd: 0, layoutPages: 40, evaluationCostUsd: 0.4, durationMinutes: 20, basis: "Azure: template training is free" },
    createdBy: "author", createdAt: now(), spendApprovedBy: null, spendApprovedAt: null, budgetOwnerApprovedBy: null,
    progress: { w9: { status: "pending", detail: null } }, reportDigest: null, releaseDigest: null, error: null, updatedAt: now(),
  };
}

function report(jobId: string, met = true): EvaluationReport {
  const release = { documents: 12, allKeyFieldsCorrect: met ? 12 : 3, keyPrecision: met ? 1 : 0.5, keyRecall: met ? 0.98 : 0.4, wrongKeyValues: met ? 0 : 6, integrityFailures: 0 };
  const gates = evaluateGates(DEFAULT_FACTORY_GATES, release);
  const body = { jobId, gates: DEFAULT_FACTORY_GATES, classification: null, regressions: [], createdAt: now(),
    types: [{ documentType: "w9", datasetDigest: sha("w9-data"), route: "custom" as const, release, baseline: null, activeRelease: null, gates, gatesMet: gates.every(g => g.met) }] };
  return { ...body, reportDigest: stableDigest(body) };
}

function manifest(releaseId: string, reportDigest: string, previous: string | null = null): DocumentModelRelease {
  return {
    apiVersion: "document-factory/v1", kind: "DocumentModelRelease", releaseId, provider: "azure_document_intelligence",
    classifier: { classifierVersionId: "cls-1", providerClassifierId: "ehf-cls-1" }, composedModelId: `ehf-${releaseId}`,
    types: [{ documentType: "w9", route: "custom", mode: "shadow", modelVersionId: "w9-1", providerModelId: "ehf-w9-1", datasetDigest: sha("w9-data"), evaluationDigest: reportDigest, gatesMet: true }],
    routePolicyDigest: sha("routes"), adjudicationPolicyDigest: sha("adjudication"), evaluationReportDigest: reportDigest, previousReleaseDigest: previous, createdAt: now(),
  };
}

describe.skipIf(!process.env.EHF_TEST_DATABASE_URL)("document factory registry in PostgreSQL", () => {
  it("plans, approves spend, runs, registers, approves, activates and rolls back with separation of duties", async () => {
    const db = createDatabase(process.env.EHF_TEST_DATABASE_URL);
    const tenantId = `factory_${randomUUID()}`;
    try {
      await saveTypeStrategy(db, { tenantId, actor: "author", body: { documentType: "w9", contractHash: sha("w9"), strategy: "azure_template", modelFamily: null, rationale: "Fixed IRS form", owner: "author" } });
      expect((await listTypeStrategies(db, tenantId)).map(s => [s.documentType, s.revision])).toEqual([["w9", 1]]);
      await registerDatasetVersion(db, { tenantId, actor: "worker", body: { datasetDigest: sha("w9-data"), documentType: "w9", contractHash: sha("w9"), previousDigest: null,
        counts: { train: 20, validation: 5, test: 12 }, groups: { train: 10, validation: 3, test: 6 }, labelSetDigest: sha("labels"),
        readiness: { train: true, validation: true, test_pipeline_proof: true, test_qualification: false }, storageRef: "datasets/w9/v1", excluded: 0, registeredAt: now(), registeredBy: "worker" } });

      // Planning is idempotent per key; a different request under the same key conflicts.
      const planned = await createReleaseJob(db, { tenantId, actor: "author", idempotencyKey: "k1", requestDigest: sha("r1"), job: job("job-1") });
      expect(planned.created).toBe(true);
      expect((await createReleaseJob(db, { tenantId, actor: "author", idempotencyKey: "k1", requestDigest: sha("r1"), job: job("job-1") })).created).toBe(false);
      await expect(createReleaseJob(db, { tenantId, actor: "author", idempotencyKey: "k1", requestDigest: sha("r2"), job: job("job-x") })).rejects.toThrow("factory.idempotency_conflict");

      // Nothing runs before spend approval, and the planner cannot approve it.
      expect(await claimReleaseJob(db, { tenantId, owner: "worker-a" })).toBeNull();
      await expect(approveReleaseSpend(db, { tenantId, actor: "author", jobId: "job-1", budgetLimitUsd: 25 })).rejects.toThrow("factory.separation_of_duties");
      expect((await approveReleaseSpend(db, { tenantId, actor: "operator", jobId: "job-1", budgetLimitUsd: 25 })).status).toBe("queued");
      const claimed = await claimReleaseJob(db, { tenantId, owner: "worker-a" });
      expect(claimed?.status).toBe("running");
      await expect(updateReleaseJob(db, { tenantId, owner: "worker-b", jobId: "job-1", patch: { stage: "train" } })).rejects.toThrow("factory.job_lease_lost");
      await saveModelVersion(db, { tenantId, actor: "worker-a", body: { modelVersionId: "w9-1", documentType: "w9", kind: "template", providerModelId: "ehf-w9-1",
        datasetDigest: sha("w9-data"), contractHash: sha("w9"), trainingJobId: "job-1", trainingHours: null, costUsd: 0, status: "ready", createdAt: now() } });

      // A report whose gates fail cannot back a release; one that passes can.
      const failing = report("job-1", false);
      await recordEvaluationReport(db, { tenantId, actor: "worker-a", report: failing });
      await expect(registerFactoryRelease(db, { tenantId, registrant: "author", jobId: "job-1", manifest: manifest("rel-0", failing.reportDigest) }))
        .rejects.toThrow("factory.release_gates_unmet:w9");
      const passing = report("job-1");
      await recordEvaluationReport(db, { tenantId, actor: "worker-a", report: passing });
      await expect(recordEvaluationReport(db, { tenantId, actor: "worker-a", report: { ...passing, reportDigest: sha("forged") } })).rejects.toThrow("factory.report_digest_mismatch");
      const one = await registerFactoryRelease(db, { tenantId, registrant: "author", jobId: "job-1", manifest: manifest("rel-1", passing.reportDigest) });
      const done = await updateReleaseJob(db, { tenantId, owner: "worker-a", jobId: "job-1", patch: { stage: "report", status: "completed", reportDigest: passing.reportDigest, releaseDigest: one.digest } });
      expect(done.job.status).toBe("completed");

      // Activation needs a second-identity approval.
      await expect(activateFactoryRelease(db, { tenantId, actor: "operator", digest: one.digest, environment: "test", reason: "first" })).rejects.toThrow("factory.release_not_approved");
      await expect(approveFactoryRelease(db, { tenantId, actor: "author", digest: one.digest })).rejects.toThrow("factory.separation_of_duties");
      await approveFactoryRelease(db, { tenantId, actor: "approver", digest: one.digest });
      await activateFactoryRelease(db, { tenantId, actor: "operator", digest: one.digest, environment: "test", reason: "first release" });
      await expect(rollbackFactoryRelease(db, { tenantId, actor: "operator", environment: "test", reason: "nothing before" })).rejects.toThrow("factory.no_previous_release");

      // A second release supersedes the first; rollback puts the first back in effect.
      await createReleaseJob(db, { tenantId, actor: "author", idempotencyKey: "k2", requestDigest: sha("r3"), job: job("job-2") });
      const second = report("job-2");
      await recordEvaluationReport(db, { tenantId, actor: "worker-a", report: second });
      const two = await registerFactoryRelease(db, { tenantId, registrant: "author", jobId: "job-2", manifest: manifest("rel-2", second.reportDigest, one.digest) });
      await approveFactoryRelease(db, { tenantId, actor: "approver", digest: two.digest });
      await activateFactoryRelease(db, { tenantId, actor: "operator", digest: two.digest, environment: "test", reason: "second release" });
      expect((await listFactoryReleases(db, tenantId)).environments).toEqual([expect.objectContaining({ environment: "test", inEffect: two.digest })]);
      const rolled = await rollbackFactoryRelease(db, { tenantId, actor: "operator", environment: "test", reason: "rollback drill" });
      expect(rolled).toMatchObject({ kind: "ROLLBACK", releaseDigest: one.digest });
      const listed = await listFactoryReleases(db, tenantId);
      expect(listed.environments[0]?.inEffect).toBe(one.digest);
      expect(listed.releases.find(r => r.digest === one.digest)).toMatchObject({ status: "approved", approvedBy: "approver", registeredBy: "author" });
      // What the gateway's document-model connector reads: the release in effect's model for a type it releases.
      expect(await releasedDocumentModel(db, { tenantId, environment: "test", documentType: "w9" }))
        .toMatchObject({ releaseDigest: one.digest, releaseId: "rel-1", route: "custom", mode: "shadow", providerModelId: "ehf-rel-1" });
      expect(await releasedDocumentModel(db, { tenantId, environment: "test", documentType: "passport" })).toBeNull();
      expect(await releasedDocumentModel(db, { tenantId, environment: "production", documentType: "w9" })).toBeNull();

      // A revoked release can no longer be rolled back to or activated.
      await revokeArtifactEntry(db, { tenantId, kind: "document-model-release", digest: two.digest, actor: "operator", reasonCode: "drill" });
      await expect(activateFactoryRelease(db, { tenantId, actor: "operator", digest: two.digest, environment: "test", reason: "again" })).rejects.toThrow("factory.release_revoked");

      // History is immutable; cancellation stops a queued job at once.
      await expect(db.query("update harness_control.factory_events set kind='x' where tenant_id=$1", [tenantId])).rejects.toThrow();
      await createReleaseJob(db, { tenantId, actor: "author", idempotencyKey: "k3", requestDigest: sha("r4"), job: job("job-3") });
      expect((await cancelReleaseJob(db, { tenantId, actor: "author", jobId: "job-3" })).status).toBe("cancelled");

      // Over the budget limit, a budget owner (a third person) must approve too.
      await createReleaseJob(db, { tenantId, actor: "author", idempotencyKey: "k4", requestDigest: sha("r5"), job: job("job-4") });
      const first = await approveReleaseSpend(db, { tenantId, actor: "operator", jobId: "job-4", budgetLimitUsd: 0.1 });
      expect(first).toMatchObject({ status: "awaiting_approval", spendApprovedBy: "operator", budgetOwnerApprovedBy: null });
      await expect(approveReleaseSpend(db, { tenantId, actor: "operator", jobId: "job-4", budgetLimitUsd: 0.1 })).rejects.toThrow("factory.separation_of_duties");
      expect(await approveReleaseSpend(db, { tenantId, actor: "budget-owner", jobId: "job-4", budgetLimitUsd: 0.1 })).toMatchObject({ status: "queued", budgetOwnerApprovedBy: "budget-owner" });
      expect((await listFactoryEvents(db, tenantId)).map(e => e.kind)).toEqual(expect.arrayContaining(["job.spend_approved", "release.approved", "release.rollback", "job.completed"]));
    } finally {
      await db.end();
    }
  });
});
