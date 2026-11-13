import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { META, setup } from "./test-support.js";

const env = setup();
beforeAll(() => env.server.listen({ onUnhandledRequest: "error" }));
afterAll(() => env.server.close());
beforeEach(() => {
  env.at("ownership_review");
  env.as("cdd_analyst");
});
afterEach(() => expect(env.state.violations, "every response must satisfy the contract").toEqual([]));

let seq = 0;
function decisionBody(decision: string, overrides: Record<string, unknown> = {}) {
  seq += 1;
  return {
    caseId: "KYB-1042",
    decisionId: `dec-test-${seq}`,
    decision,
    reasonCode: "test.reason",
    rationale: "Reviewed the cited evidence.",
    evidenceRefs: [],
    basis: { caseSequence: env.state.store.caseSummary.caseSequence, snapshotDigest: env.state.store.snapshot.snapshotDigest },
    ...overrides,
  };
}
const decide = (workItemId: string, body: Record<string, unknown>) => env.call("postOperationsHumanWorkWorkItemIdDecisions", { path: { workItemId }, body });
const claim = (workItemId: string) => env.call("postOperationsHumanWorkWorkItemIdClaim", { path: { workItemId } });
const draftId = () => env.state.platform.drafts[0].draftId as string;

describe("§6.4 drafts", () => {
  it("refuses approve/publish by a principal who authored the draft (separation of duties)", async () => {
    env.as("agent_architect");
    expect((await env.call("postAuthoringDraftsDraftIdEvaluate")).body.status).toBe("EVALUATED");
    env.as("harness_approver");
    env.state.draftActors.get(draftId())!.add("e.kowalski"); // the approver had compiled it earlier
    const refused = await env.call("postAuthoringDraftsDraftIdApprove");
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("authorization.separation_of_duties");
  });

  it("lets an independent approver approve and publish an evaluated draft", async () => {
    env.as("agent_architect");
    await env.call("postAuthoringDraftsDraftIdEvaluate");
    env.as("harness_approver");
    expect((await env.call("postAuthoringDraftsDraftIdApprove")).body).toMatchObject({ status: "APPROVED", approvedBy: "e.kowalski" });
    expect((await env.call("postAuthoringDraftsDraftIdPublish")).body.status).toBe("PUBLISHED");
  });

  it("refuses a stale expectedRevision and any change to a published draft; success bumps revision and resets status", async () => {
    env.as("agent_architect");
    const draft = env.state.platform.drafts[0];
    const stale = await env.call("putAuthoringDraftsDraftId", { body: { expectedRevision: draft.revision - 1, packageSource: "x", workflowSource: "y" } });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe("authoring.revision_conflict_or_published");
    const saved = await env.call("putAuthoringDraftsDraftId", { body: { expectedRevision: draft.revision, packageSource: "x", workflowSource: "y" } });
    expect(saved.body).toMatchObject({ revision: 8, status: "DRAFT", compiledPlan: null });
    draft.status = "PUBLISHED";
    const published = await env.call("putAuthoringDraftsDraftId", { body: { expectedRevision: draft.revision, packageSource: "x", workflowSource: "y" } });
    expect(published.body.error).toBe("authoring.revision_conflict_or_published");
  });
});

describe("§6.4 human work", () => {
  it("refuses a claim on an item that is not pending", async () => {
    env.at("decided");
    const response = await claim("wi_decision");
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("workflow.human_assignment_not_pending");
  });

  it("refuses a decision by a non-assignee when the item has assignees", async () => {
    env.as("screening_analyst");
    await claim("wi_own_review");
    env.as("cdd_analyst");
    const response = await decide("wi_own_review", decisionBody("APPROVE"));
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("workflow.human_decision_not_assigned");
  });

  it("replays the same decisionId with the same body, and refuses it with a different body", async () => {
    const body = decisionBody("APPROVE");
    const first = await decide("wi_own_review", body);
    expect(first.status).toBe(201);
    const replay = await decide("wi_own_review", body);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    const conflicting = await decide("wi_own_review", { ...body, rationale: "Something else." });
    expect(conflicting.status).toBe(409);
    expect(conflicting.body.error).toBe("workflow.human_decision_idempotency_conflict");
  });

  it("refuses a decision whose basis is behind the case sequence", async () => {
    const response = await decide("wi_own_review", decisionBody("APPROVE", { basis: { caseSequence: 13, snapshotDigest: env.state.store.snapshot.snapshotDigest } }));
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("human.basis_stale");
  });

  it("refuses a second decision on a dual-control item by the same principal", async () => {
    env.at("decision_pending");
    env.as("compliance_officer");
    await claim("wi_decision");
    expect((await decide("wi_decision", decisionBody("APPROVE"))).status).toBe(201);
    expect(env.state.scenario).toBe("second_approval");
    const again = await decide("wi_decision", decisionBody("APPROVE"));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("workflow.human_decision_conflict");
  });

  it("leaves differing dual-control decisions in conflict until a non-deciding operator resolves them", async () => {
    env.at("second_approval");
    env.as("second_approver");
    await claim("wi_decision");
    expect((await decide("wi_decision", decisionBody("REJECT"))).status).toBe(201);
    const item = env.state.store.humanQueue.find((entry: { workItem: { workItemId: string } }) => entry.workItem.workItemId === "wi_decision");
    expect(item.workItem).toMatchObject({ status: "WAITING_HUMAN", reasonCode: "workflow.human_decision_conflict" });
    const resolveBody = { caseId: "KYB-1042", resolutionId: "res-1", decision: "APPROVE", reasonCode: "kyc.onboarding.approve", rationale: "Escalated and approved.", evidenceRefs: [] };
    // A principal who decided cannot resolve.
    item.decisions.push({ ...item.decisions[0], decisionId: "dec-ruiz", principalId: "a.ruiz", decision: "REJECT" });
    env.as("ops_manager");
    const refused = await env.call("postOperationsHumanWorkWorkItemIdResolve", { path: { workItemId: "wi_decision" }, body: resolveBody });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("workflow.human_resolution_separation_required");
    item.decisions.pop();
    const resolved = await env.call("postOperationsHumanWorkWorkItemIdResolve", { path: { workItemId: "wi_decision" }, body: resolveBody });
    expect(resolved.status).toBe(200);
    expect(env.state.scenario).toBe("decided");
  });

  it("completes the item at quorum and fires the scenario transition", async () => {
    const body = decisionBody("APPROVE");
    expect((await decide("wi_own_review", body)).status).toBe(201);
    expect(env.state.scenario).toBe("screening_review");
    expect(env.state.store.decisions.some((decision: { decisionId: string }) => decision.decisionId === body.decisionId)).toBe(true);
    const queue = await env.call("getOperationsHumanWork");
    expect(queue.body.items.map((item: { workItem: { workItemId: string } }) => item.workItem.workItemId)).toEqual(["wi_scr_review"]);
  });
});

describe("§6.4 commands and releases", () => {
  const command = (overrides: Record<string, unknown>) => ({
    commandType: "ResolveContradiction", commandVersion: "kyc.command.resolve_contradiction.v1",
    payload: { contradictionId: "cf-12", resolution: "ACCEPT_ASSERTION", assertionId: "as-reg", rationale: "Register is authoritative." },
    preconditions: { caseSequence: 14 }, idempotencyKey: `cmd-${Math.random()}`, ...overrides,
  });

  it("answers a stale precondition with a 200 CONFLICT receipt, not an exception", async () => {
    const response = await env.call("postCasesCaseIdCommands", { body: command({ preconditions: { caseSequence: 12 } }) });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ outcome: "CONFLICT", caseSequence: 14 });
  });

  it("refuses RecordPolicyEvaluation as a command", async () => {
    const response = await env.call("postCasesCaseIdCommands", { body: command({ commandType: "RecordPolicyEvaluation", payload: {} }) });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("policy.evaluator_endpoint_required");
  });

  it("refuses a release transition with a stale revision", async () => {
    env.as("ops_manager");
    const release = env.state.store.releases[1];
    const response = await env.call("postReleasesReleaseIdTransition", { path: { releaseId: release.releaseId }, body: { to: "active", expectedRevision: release.revision + 5, reasonCode: "release.operator_decision" } });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("release.transition_failed");
  });
});

describe("§6.5 scenario effects", () => {
  it("RETURN on wi_own_review creates wi_own_rework and moves the case to prepared by agents", async () => {
    expect((await decide("wi_own_review", decisionBody("RETURN"))).status).toBe(201);
    expect(env.state.scenario).toBe("ownership_review");
    const rework = env.state.store.workItems.find((item: { workItemId: string }) => item.workItemId === "wi_own_rework");
    expect(rework).toMatchObject({ status: "READY" });
    expect(rework.constraints.agentProfile).toBe("agent.identity_ownership");
    const work = await env.call("getFincrimeWork");
    const prepared = work.body.groups.find((group: { group: string }) => group.group === "prepared_by_agents");
    expect(prepared.items.map((item: { workItemId: string }) => item.workItemId)).toEqual(["wi_own_rework"]);
  });

  it("REJECT on wi_scr_review sets the case to INVESTIGATING with an EDD attention item", async () => {
    env.at("screening_review");
    env.as("screening_analyst");
    expect((await decide("wi_scr_review", decisionBody("REJECT"))).status).toBe(201);
    expect(env.state.store.caseSummary.status).toBe("INVESTIGATING");
    const work = await env.call("getFincrimeWork");
    const escalated = work.body.groups.find((group: { group: string }) => group.group === "escalated_or_blocked");
    expect(escalated.items[0]).toMatchObject({ gate: "edd.required", caseStatus: "INVESTIGATING" });
  });

  it("ResolveContradiction on cf-12 bumps the sequence 14 → 15 and resolves it", async () => {
    const response = await env.call("postCasesCaseIdCommands", {
      body: { commandType: "ResolveContradiction", commandVersion: "v1", payload: { contradictionId: "cf-12", resolution: "ACCEPT_ASSERTION", assertionId: "as-reg" }, preconditions: { caseSequence: 14 }, idempotencyKey: "cmd-cf12" },
    });
    expect(response.body).toMatchObject({ outcome: "ACCEPTED", caseSequence: 15 });
    expect((await env.call("getFincrimeCasesCaseIdContradictionsContradictionId")).body.status).toBe("RESOLVED");
    const room = await env.call("getFincrimeCasesCaseIdRoom");
    expect(room.body.caseSequence).toBe(15);
    expect(room.headers.get("etag")).toMatch(/^"seq-15;/);
    expect(env.state.scenario).toBe("ownership_review");
    // BIZ-03-AC4: the ownership edge, the claim and the lens badge follow the case event.
    const ownership = await env.call("getFincrimeCasesCaseIdOwnership");
    expect(ownership.body.edges.find((edge: { id: string }) => edge.id === "e3")).toMatchObject({ status: "verified", interest: "0.12", interestAlternative: null, label: "12%" });
    const claims = await env.call("getFincrimeCasesCaseIdClaims");
    expect(claims.body.items.find((item: { id: string }) => item.id === "c-bram")).toMatchObject({ status: "resolved", epistemic: "fact", acceptedBy: { principalId: "r.okafor" } });
    expect(room.body.lenses.find((lens: { lens: string }) => lens.lens === "ownership").badge).toBeNull();
  });

  it("GAP-074: a human decision without a case event still changes the case room ETag", async () => {
    const before = await env.call("getFincrimeCasesCaseIdRoom");
    expect(before.headers.get("etag")).toMatch(/^"seq-14;s0"$/);
    await decide("wi_own_review", decisionBody("RETURN"));
    const after = await env.call("getFincrimeCasesCaseIdRoom", { headers: { "if-none-match": before.headers.get("etag")! } });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).toMatch(/^"seq-14;s0\.\d+"$/);
    expect(after.body.humanWork.some((item: { workItem: { workItemId: string } }) => item.workItem.workItemId === "wi_own_review")).toBe(false);
  });

  it("previews a command with the session actor and refuses a stale preview", async () => {
    const body = { commandType: "ResolveContradiction", commandVersion: "v1", payload: { contradictionId: "cf-12" }, preconditions: { caseSequence: 14 }, idempotencyKey: "prev-1" };
    const preview = await env.call("postFincrimeCasesCaseIdCommandsPreview", { body });
    expect(preview.body.command.actor).toMatchObject({ type: "HUMAN", principalId: "r.okafor" });
    expect(preview.body.diff[0]).toMatchObject({ before: "OPEN", after: "RESOLVED" });
    const stale = await env.call("postFincrimeCasesCaseIdCommandsPreview", { body: { ...body, preconditions: { caseSequence: 3 } } });
    expect(stale.status).toBe(409);
  });

  it("jumps scenario through PUT /mock/scenario", async () => {
    const response = await env.call("putMockScenario", { body: { scenario: "decided" } });
    expect(response.body.scenario).toBe("decided");
    expect((await env.call("getFincrimeCasesCaseIdRoom")).body.status).toBe("APPROVED");
  });
});

describe("§6.6 faults", () => {
  const faults = (body: Record<string, unknown>) => env.call("putMockFaults", { body });

  it("applies latency", async () => {
    await faults({ latencyMs: 60 });
    const started = Date.now();
    await env.call("getSession");
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    await faults({ latencyMs: null });
  });

  it("goes offline for one request", async () => {
    await faults({ offline: true });
    await expect(env.call("getSession")).rejects.toThrow();
    expect((await env.call("getSession")).status).toBe(200);
  });

  it("fails the next request with the given status and code, once", async () => {
    await faults({ failNext: { status: 502, error: "bff.upstream_failed" } });
    const failed = await env.call("getRuns");
    expect(failed.status).toBe(502);
    expect(failed.body.error).toBe("bff.upstream_failed");
    expect((await env.call("getRuns")).status).toBe(200);
  });

  it("keeps a sticky fault armed", async () => {
    env.state.faults.sticky = ["failNext"];
    await faults({ failNext: { status: 503, error: "bff.upstream_unavailable" } });
    expect((await env.call("getRuns")).status).toBe(503);
    expect((await env.call("getRuns")).status).toBe(503);
    env.state.faults.sticky = [];
    env.state.faults.failNext = null;
  });

  it("makes the next decision stale", async () => {
    await faults({ staleBasisNext: true });
    expect((await decide("wi_own_review", decisionBody("APPROVE"))).body.error).toBe("human.basis_stale");
    expect((await decide("wi_own_review", decisionBody("APPROVE"))).status).toBe(201);
  });

  it("expires the session until the user signs in again", async () => {
    await faults({ expireSessionNext: true });
    expect((await env.call("getSession")).body.error).toBe("session.expired");
    expect((await env.call("getRuns")).status).toBe(401);
    await env.call("getAuthLogin", { query: { returnTo: "/work" } });
    expect((await env.call("getSession")).status).toBe(200);
  });

  it("rejects the next CSRF token", async () => {
    await faults({ csrfRejectNext: true });
    expect((await claim("wi_own_review")).body.error).toBe("csrf.invalid");
    expect((await claim("wi_own_review")).status).toBe(200);
  });

  it("revokes a role at the next mutation; the session shows it", async () => {
    await faults({ revokeRoleNext: "Case.Reviewer" });
    expect((await env.call("getSession")).body.roles).toContain("Case.Reviewer");
    const refused = await decide("wi_own_review", decisionBody("APPROVE"));
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("authorization.role_missing");
    expect((await env.call("getSession")).body.roles).not.toContain("Case.Reviewer");
  });

  it("takes an upstream service down for its operations only", async () => {
    await faults({ upstreamDown: ["case-api"] });
    const down = await env.call("getCases");
    expect(down.status).toBe(503);
    expect(down.body.error).toBe("bff.upstream_unavailable");
    expect((await env.call("getRuns")).status).toBe(200);
    await faults({ upstreamDown: [] });
  });

  it("resets the store", async () => {
    await claim("wi_own_review");
    await env.call("postMockReset");
    expect(env.state.store.humanQueue[0].assignedTo).toEqual([]);
  });
});

it("covers every mock-only operation in the contract", () => {
  expect(META.filter((op) => op.mockOnly).map((op) => op.operationId).sort()).toEqual(
    ["getMockPersonas", "getMockScenario", "postMockReset", "putMockClock", "putMockFaults", "putMockScenario", "putMockSession"],
  );
});
