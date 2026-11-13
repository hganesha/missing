import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Rec } from "./fixtures.js";
import { setup } from "./test-support.js";

const env = setup();
beforeAll(() => env.server.listen({ onUnhandledRequest: "error" }));
afterAll(() => env.server.close());

describe("installation policy templates", () => {
  it("serves the agentic business policies by default and the archived catalog on request", async () => {
    env.as("agent_architect");
    const kyc = await env.call("getAuthoringPolicies");
    expect(kyc.status).toBe(200);
    expect(kyc.body.id).toBe("kyc-agentic");
    expect(Object.keys(kyc.body.files as Rec)).toEqual(["policy.yaml"]);
    expect((kyc.body.files as Rec)["policy.yaml"]).toContain("kind: BusinessPolicy");
    const kyb = await env.call("getAuthoringPolicies", { query: { template: "kyb-agentic" } });
    expect((kyb.body.files as Rec)["policy.yaml"]).toContain("policy.kyb-agentic.business.v2");
    const archived = await env.call("getAuthoringPolicies", { query: { template: "kyc" } });
    expect(Object.keys(archived.body.files as Rec)).toContain("policy.yaml");
    expect(Object.keys(archived.body.files as Rec).some((path) => path.startsWith("catalog/decision-tables/"))).toBe(true);
  });

  it("compiles, refuses production with blockers and evaluates a sample with contract-valid bodies", async () => {
    env.as("agent_architect");
    const before = env.state.violations.length;
    const files = (await env.call("getAuthoringPolicies")).body.files as Rec;
    const compiled = await env.call("postAuthoringPoliciesCompile", { body: { files, release: "candidate" } });
    expect(compiled.status).toBe(200);
    expect(compiled.body.manifest).toMatchObject({ decisionContract: "business-v2", policyId: "policy.kyc-agentic.business.v2" });
    expect((compiled.body.manifest as Rec).gates.map((gate: Rec) => gate.gateId)).toEqual(["decision-ready", "diligence-level", "disposition", "intake-ready"]);
    const sets = compiled.body.policySets as Rec[];
    expect(sets.map((set) => set.scope.jurisdiction)).toEqual(["US", "GB"]);
    const reasons = new Set((compiled.body.releaseBlockers as Rec[]).map((blocker) => blocker.reasonCode));
    // The checkpoint rules are SYNTHETIC placeholders; provider permission stays unresolved.
    expect([...reasons].sort()).toEqual(["INSTALLATION_CONTENT_UNRESOLVED", "POLICY_SET_NOT_APPROVED"]);

    const production = await env.call("postAuthoringPoliciesCompile", { body: { files, release: "production" } });
    expect(production.status).toBe(422);
    expect(production.body.details.blockers).toContain(
      "Approve installation policy set policy.pack.us.bank-synthetic.personal-banking.v2 (POLICY_SET_NOT_APPROVED)");

    const zero = "0".repeat(64);
    const at = "2026-11-11T00:00:00.000Z";
    const decision = await env.call("postAuthoringPoliciesEvaluate", { body: { files, facts: { asOf: at }, observations: {}, basis: {
      tenantId: "simulation", caseId: "what-if", planDigest: zero, releaseDigest: zero, caseSequence: 0, snapshotDigest: zero, dependencyDigest: zero,
      selectedInputDigest: zero, effectivePolicySetDigest: sets[0]!.setDigest, policyBundleDigest: (compiled.body.manifest as Rec).bundleDigest,
      inputProfile: "canonical.onboarding.v2", gateId: "intake-ready", purpose: "CDD_ONBOARDING", subjectIds: [], proposerPrincipalIds: [],
      evaluatedAt: at, knowledgeCutoff: at, scope: { jurisdiction: "US", institution: "bank.synthetic", products: ["deposit"], customerType: "individual" },
    } } });
    expect(decision.status).toBe(200);
    // An empty sample has no banking relationship: the SYNTHETIC intake rules ask for more evidence.
    expect(decision.body.result).toMatchObject({ state: "NEEDS_EVIDENCE", ruleIds: [], reasonCodes: ["BANKING_RELATIONSHIP_MISSING"] });
    expect(decision.body.expiresAt).toBe("2026-11-11T00:01:00.000Z");
    expect(env.state.violations.slice(before)).toEqual([]);
  });

  it("derives a due-diligence level with its contributors, and stays unresolved without its inputs", async () => {
    env.as("agent_architect");
    const before = env.state.violations.length;
    const files = (await env.call("getAuthoringPolicies", { query: { template: "kyb-agentic" } })).body.files as Rec;
    const compiled = (await env.call("postAuthoringPoliciesCompile", { body: { files, release: "candidate" } })).body;
    const gb = (compiled.policySets as Rec[]).find((set) => set.scope.jurisdiction === "GB")!;
    const zero = "0".repeat(64), at = "2026-11-11T00:00:00.000Z";
    const evaluate = (legalForm: string, products: string[], selected: Rec) => env.call("postAuthoringPoliciesEvaluate", { body: { files, observations: {},
      facts: { asOf: at, selected }, basis: {
        tenantId: "simulation", caseId: "what-if", planDigest: zero, releaseDigest: zero, caseSequence: 0, snapshotDigest: zero, dependencyDigest: zero, selectedInputDigest: zero,
        effectivePolicySetDigest: gb.setDigest, policyBundleDigest: (compiled.manifest as Rec).bundleDigest, inputProfile: "canonical.onboarding.v2", gateId: "diligence-level",
        purpose: "CDD_ONBOARDING", subjectIds: [], proposerPrincipalIds: [], evaluatedAt: at, knowledgeCutoff: at,
        scope: { jurisdiction: "GB", institution: "bank.synthetic", products, customerType: "corporate", legalForm } } } });
    const complete = { policyRecordPEPRelationship: [], policyCaseFindings: [], policyRecordGeographyExposure: [{ data: { country: "IR" } }], packOwnership: [] };
    const decided = await evaluate("corporation", ["deposit"], complete);
    expect(decided.status).toBe(200);
    expect(decided.body.result).toMatchObject({ state: "DECIDED", reasonCodes: ["DILIGENCE_LEVEL_EDD"], ruleIds: ["diligence.cell.company.deposit", "overlay.high-risk-geography"],
      outputs: { diligence: { level: "EDD", baseLevel: "CDD", partyType: "company" } } });
    const missing = await evaluate("corporation", ["deposit"], { policyRecordPEPRelationship: [] });
    expect(missing.body.result).toMatchObject({ state: "UNRESOLVED", reasonCodes: ["DILIGENCE_INPUT_MISSING"] });
    expect(env.state.violations.slice(before)).toEqual([]);
  });

  it("refuses a diligence block the engine would refuse", async () => {
    env.as("agent_architect");
    const files = (await env.call("getAuthoringPolicies")).body.files as Rec;
    const broken = String(files["policy.yaml"]).replace(/legalForms:\n(\s+)- individual/, "legalForms: []");
    expect(broken).not.toBe(files["policy.yaml"]);
    const refused = await env.call("postAuthoringPoliciesCompile", { body: { files: { "policy.yaml": broken }, release: "candidate" } });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("policy.compile_failed");
  });

  it("serves a synthetic, contract-valid diligence monitoring summary", async () => {
    env.as("agent_architect");
    const before = env.state.violations.length;
    const response = await env.call("getAuthoringPoliciesMonitoringDiligence", { query: { levels: "SDD,CDD,EDD" } });
    expect(response.status).toBe(200);
    const summary = response.body.summary as Rec;
    expect(summary.total).toBe(14);
    expect(summary.unresolved).toBe(1);
    expect(summary.decided + summary.unresolved).toBe(summary.total);
    expect(summary.byLevel.EDD).toBeGreaterThan(0);
    expect((summary.overlays as Rec[]).map((overlay) => overlay.id)).toContain("overlay.pep");
    const corporate = await env.call("getAuthoringPoliciesMonitoringDiligence", { query: { levels: "SDD,CDD,EDD", customerTypes: "corporate" } });
    expect((corporate.body.summary as Rec).total).toBe(8);
    expect(((corporate.body.summary as Rec).cells as Rec[]).some((cell) => cell.partyType === "individual")).toBe(false);
    expect(env.state.violations.slice(before)).toEqual([]);
  });

  it("runs the impact simulation over the bank's regression set, with what changed", async () => {
    env.as("agent_architect");
    const before = env.state.violations.length;
    const files = (await env.call("getAuthoringPolicies", { query: { template: "kyb-agentic" } })).body.files as Rec;
    const changed = String(files["policy.yaml"]).replace(/(\n    trust:\n(?: {6}\w+: \w+\n){3} {6}payments: )EDD/, "$1CDD");
    const response = await env.call("postAuthoringPoliciesImpact", { body: { baseline: { files }, candidate: { files: { "policy.yaml": changed } } } });
    expect(response.status).toBe(200);
    const report = response.body.report as Rec;
    expect(report.summary).toMatchObject({ cases: 10, changed: 1 });
    expect((report.rows as Rec[]).find((row) => row.caseId === "us-trust-payments")!.changes).toEqual(["LEVEL_LOWERED", "REQUIREMENTS_REMOVED"]);
    const again = await env.call("postAuthoringPoliciesImpact", { body: { baseline: { files }, candidate: { files: { "policy.yaml": changed } } } });
    expect(again.body.digest).toBe(response.body.digest);
    expect(env.state.violations.slice(before)).toEqual([]);
  });

  it("publishes now or on a date, and rolls back to an earlier revision with its history", async () => {
    const before = env.state.violations.length;
    const files = (await env.call("getAuthoringPolicies")).body.files as Rec;
    const path = (revision: number) => ({ workspaceId: "kyc-activation", revision: String(revision) });
    const release = async (text: string, publish: Rec) => {
      env.as("agent_architect");
      const saved = await env.call("postAuthoringPoliciesWorkspacesWorkspaceIdRevisions", { path: { workspaceId: "kyc-activation" }, body: { files: { "policy.yaml": `${String(files["policy.yaml"])}\n# ${text}\n` } } });
      const revision = saved.body.revision as number;
      await env.call("postAuthoringPoliciesWorkspacesWorkspaceIdRevisionsRevisionCompile", { path: path(revision) });
      env.as("harness_approver");
      await env.call("postAuthoringPoliciesWorkspacesWorkspaceIdRevisionsRevisionApprove", { path: path(revision) });
      return env.call("postAuthoringPoliciesWorkspacesWorkspaceIdRevisionsRevisionPublish", { path: path(revision), body: publish });
    };
    expect((await release("one", {})).status).toBe(200);
    const later = new Date(Date.now() + 86_400_000).toISOString();
    expect((await release("two", { effectiveFrom: later, reason: "Next quarter" })).status).toBe(200);
    const view = (await env.call("getAuthoringPoliciesWorkspacesWorkspaceIdRevisions", { path: { workspaceId: "kyc-activation" } })).body;
    expect(view).toMatchObject({ active: { revision: 1, kind: "PUBLISH" }, scheduled: [{ revision: 2, kind: "SCHEDULE", effectiveFrom: later }] });
    expect((await env.call("postAuthoringPoliciesWorkspacesWorkspaceIdRevisionsRevisionPublish", { path: path(1), body: { effectiveFrom: "2020-01-01T00:00:00Z" } })).status).toBe(409);
    expect((await env.call("postAuthoringPoliciesWorkspacesWorkspaceIdRevisionsRevisionRollback", { path: path(1), body: { reason: "" } })).status).toBe(400);
    expect((await env.call("postAuthoringPoliciesWorkspacesWorkspaceIdRevisionsRevisionRollback", { path: path(1), body: { reason: "Cancel the scheduled change" } })).status).toBe(200);
    const after = (await env.call("getAuthoringPoliciesWorkspacesWorkspaceIdRevisions", { path: { workspaceId: "kyc-activation" } })).body;
    expect(after).toMatchObject({ active: { revision: 1, kind: "ROLLBACK", reason: "Cancel the scheduled change" }, scheduled: [] });
    expect((after.revisions as Rec[]).map((entry) => entry.status)).toEqual(["published", "superseded"]);
    expect((after.activations as Rec[]).map((entry) => entry.kind)).toEqual(["SCHEDULE", "ROLLBACK", "PUBLISH"]);
    expect(env.state.violations.slice(before)).toEqual([]);
  });
});
