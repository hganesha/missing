import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PERSONAS, SCENARIOS } from "./fixtures.js";
import { sessionFor } from "./http.js";
import { META, permitted, setup } from "./test-support.js";

/**
 * §11.2 item 2: every GET × S1–S5 × every persona permitted by x-action answers 2xx with a
 * contract-valid body. A projection that is empty in a scenario state (e.g. the decision
 * desk before S3) answers the contract's 404 instead; that is listed, not counted as a pass.
 */
const env = setup();
beforeAll(() => env.server.listen({ onUnhandledRequest: "error" }));
afterAll(() => env.server.close());

const NON_JSON = new Set(["getAuthLogin", "getAuthCallback", "getCasesCaseIdExportsDigestFormat"]);
const SANDBOX_RUN_READS = new Set([
  "getAuthoringSandboxRunsRunId",
  "getAuthoringSandboxRunsRunIdContextResults",
  "getAuthoringSandboxRunsRunIdObservations",
  "getAuthoringSandboxRunsRunIdPolicy",
]);

describe("response validity matrix", () => {
  it("serves contract-valid bodies for every GET in every scenario state to every permitted persona", async () => {
    const failures: string[] = [];
    const unavailable = new Set<string>();
    let calls = 0;
    for (const scenario of SCENARIOS) {
      for (const { persona } of PERSONAS) {
        env.at(scenario);
        env.as(persona.personaId);
        const actions = sessionFor(env.state).actions as string[];
        for (const op of META.filter((entry) => entry.method === "GET" && !entry.mockOnly && !entry.public)) {
          if (!permitted(op, actions)) continue;
          const before = env.state.violations.length;
          const response = await env.call(op.operationId);
          calls += 1;
          const fresh = env.state.violations.slice(before);
          if (fresh.length) failures.push(`${scenario} ${persona.personaId} ${op.operationId} ${response.status}: ${fresh.map((v) => v.message).join(" | ")}`);
          else if (op.operationId === "getFincrimeCasesCaseIdRecon" && persona.personaId === "case_manager") {
            // The fixture manager has discovery.read and no standing on this case.
            if (response.status === 403 && response.body?.error === "authorization.discovery_standing_missing") unavailable.add(`${scenario} ${op.operationId} (case standing)`);
            else failures.push(`${scenario} ${persona.personaId} ${op.operationId}: expected a case-standing denial`);
          }
          else if (response.status === 404 && (response.body?.error === "fincrime.not_available" || op.operationId === "getCasesCaseIdBusinessDecisionsDecisionId" && response.body?.error === "policy.not_available")) unavailable.add(`${scenario} ${op.operationId}`);
          // Mock mode has no invented workflow executions.
          else if (op.operationId === "getAuthoringDraftsDraftIdTestRunsTestRunId" && response.status === 404 && response.body?.error === "draft_test.not_found") unavailable.add(`${scenario} ${op.operationId}`);
          else if (SANDBOX_RUN_READS.has(op.operationId) && response.status === 404 && response.body?.error === "sandbox.run_not_found") unavailable.add(`${scenario} ${op.operationId}`);
          // Only a composed KYC/KYB draft has a process scope; the default fixture draft is not one.
          else if (op.operationId === "getAuthoringDraftsDraftIdScope" && response.status === 422 && response.body?.error === "authoring.scope_unsupported_draft") unavailable.add(`${scenario} ${op.operationId}`);
          else if (op.operationId === "getDocumentStudioTestsTestId" && response.status === 404 && response.body?.error === "document_studio.test_not_found") unavailable.add(`${scenario} ${op.operationId}`);
          // A Document Factory job or report exists only after someone plans a release (document-factory.test.ts covers them).
          else if ((op.operationId === "getDocumentFactoryReleaseJobsJobId" && response.body?.error === "factory.job_not_found"
            || op.operationId === "getDocumentFactoryReportsDigest" && response.body?.error === "factory.report_not_found") && response.status === 404) unavailable.add(`${scenario} ${op.operationId}`);
          else if (response.status < 200 || response.status >= 300) failures.push(`${scenario} ${persona.personaId} ${op.operationId} → ${response.status} ${response.body?.error ?? response.text.slice(0, 80)}`);
          else if (!NON_JSON.has(op.operationId) && response.body === undefined) failures.push(`${scenario} ${persona.personaId} ${op.operationId}: no JSON body`);
        }
      }
    }
    console.log(`validity matrix: ${calls} calls, ${failures.length} failures, ${env.state.violations.length} violations; not available by design: ${[...unavailable].sort().join(", ") || "none"}`);
    expect(failures.slice(0, 40)).toEqual([]);
  }, 120_000);
});
