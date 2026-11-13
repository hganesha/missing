import { fail, ok, type Impl } from "../http.js";

// The mock has no trust anchor: never fabricate an institution's source approvals or live eligibility.
const backendRequired: Impl = (ctx) => fail(ctx, 409, "source_policy.live_backend_required", "Source policy authoring and eligibility require the live control API.");
export const sourcePolicies: Record<string, Impl> = {
  getSourcePoliciesArtifacts: (ctx) => ok(ctx, { artifacts: [] }),
  getSourcePoliciesDecisionsRunId: (ctx) => ok(ctx, { decisions: [] }),
  postAuthoringSourcePoliciesCompile: backendRequired,
  postAuthoringSourcePoliciesSimulate: backendRequired,
  postSourcePoliciesArtifacts: backendRequired,
  postSourcePoliciesArtifactsKindDigestApprove: backendRequired,
  postSourcePoliciesArtifactsKindDigestRevoke: backendRequired,
  postSourcePoliciesEligibility: backendRequired,
};
