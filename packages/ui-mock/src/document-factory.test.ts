import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { setup } from "./test-support.js";

const env = setup();
beforeAll(() => env.server.listen({ onUnhandledRequest: "error" }));
afterAll(() => env.server.close());
beforeEach(() => env.at("ownership_review"));
afterEach(() => expect(env.state.violations).toEqual([]));

it("runs New release in mock mode with the platform planner and separation of duties at every step", async () => {
  env.as("agent_architect");
  const overview = (await env.call("getDocumentFactory")).body;
  expect(overview.datasets).toHaveLength(10);
  const preview = (await env.call("postDocumentFactoryReleasePlan", { body: { selection: ["w9", "passport", "utility_bill", "articles_of_association"] } })).body;
  const byType = Object.fromEntries(preview.plan.map((item: { documentType: string }) => [item.documentType, item]));
  expect(byType.w9.action).toBe("train");
  expect(byType.passport.action).toBe("prebuilt");
  expect(byType.articles_of_association.action).toBe("llm_only");
  expect(byType.utility_bill).toMatchObject({ action: "blocked", blockers: expect.arrayContaining(["Sealed test documents: 6 of 10 required."]) });
  const created = await env.call("postDocumentFactoryReleaseJobs", { body: { selection: ["w9", "passport", "substantial_shareholder_disclosure"] }, headers: { "idempotency-key": "mock-1" } });
  expect(created.status).toBe(200);
  const jobId = created.body.jobId;
  expect((await env.call("postDocumentFactoryReleaseJobsJobIdApproveSpend", { path: { jobId } })).status).toBe(403);

  env.as("ops_manager");
  const approved = (await env.call("postDocumentFactoryReleaseJobsJobIdApproveSpend", { path: { jobId } })).body;
  expect(approved).toMatchObject({ status: "completed", spendApprovedBy: "a.ruiz" });
  const report = (await env.call("getDocumentFactoryReportsDigest", { path: { digest: approved.reportDigest } })).body;
  expect(report.types.find((t: { documentType: string }) => t.documentType === "substantial_shareholder_disclosure").gatesMet).toBe(false);
  expect((await env.call("getDocumentFactoryReleaseJobsJobId", { path: { jobId } })).body.events.map((e: { kind: string }) => e.kind)).toContain("job.spend_approved");
  const digest = approved.releaseDigest;
  expect((await env.call("postDocumentFactoryReleasesDigestActivate", { path: { digest }, body: { environment: "test", reason: "First pilot" } })).status).toBe(409);

  env.as("harness_approver");
  expect((await env.call("postDocumentFactoryReleasesDigestApprove", { path: { digest } })).status).toBe(200);
  env.as("ops_manager");
  expect((await env.call("postDocumentFactoryReleasesDigestActivate", { path: { digest }, body: { environment: "test", reason: "First pilot" } })).body.kind).toBe("ACTIVATE");
  const releases = (await env.call("getDocumentFactoryReleases")).body;
  expect(releases.environments).toEqual([expect.objectContaining({ environment: "test", inEffect: digest })]);
  expect(releases.releases[0].manifest.types.map((t: { documentType: string }) => t.documentType)).toEqual(["passport", "w9"]);
  expect((await env.call("postDocumentFactoryEnvironmentsEnvironmentRollback", { path: { environment: "test" }, body: { reason: "Nothing earlier" } })).status).toBe(409);

  env.as("cdd_analyst");
  expect((await env.call("getDocumentFactory")).status).toBe(403);
});
