import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PERSONAS, ROLE_ACTIONS } from "./fixtures.js";
import { actionTokens, sessionFor } from "./http.js";
import { META, setup } from "./test-support.js";

const env = setup();
beforeAll(() => env.server.listen({ onUnhandledRequest: "error" }));
afterAll(() => env.server.close());
afterEach(() => {
  expect(env.state.violations, "every response must satisfy the contract").toEqual([]);
  env.at("ownership_review");
  env.as("cdd_analyst");
});

describe("coverage (§11.2 item 1)", () => {
  it("registers one handler per operation", () => {
    expect(env.server.listHandlers()).toHaveLength(META.length);
  });

  it("implements every operation (nothing answers mock.not_implemented)", async () => {
    const missing: string[] = [];
    env.as("ops_manager");
    for (const op of META) {
      const response = await env.call(op.operationId, op.method === "GET" ? {} : { body: {} });
      if (response.body?.error === "mock.not_implemented") missing.push(op.operationId);
    }
    env.state.violations.length = 0; // empty bodies are expected to be refused; validity is covered elsewhere
    expect(missing).toEqual([]);
  });
});

describe("auth matrix (§11.2 item 3)", () => {
  it("refuses every operation with x-action to a persona lacking it", async () => {
    const failures: string[] = [];
    let checks = 0;
    for (const op of META.filter((entry) => actionTokens(entry.xAction).length > 0)) {
      const tokens = actionTokens(op.xAction);
      const persona = PERSONAS.find(({ persona: p }) => !p.roles.some((role) => tokens.some((action) => (ROLE_ACTIONS[role] ?? []).includes(action))));
      if (!persona) continue;
      env.at("ownership_review");
      env.as(persona.persona.personaId);
      const body = op.operationId === "postCasesCaseIdCommands" ? { commandType: "ProposeClaim", commandVersion: "1", payload: {}, preconditions: { caseSequence: 14 }, idempotencyKey: "k-auth" }
        : op.operationId === "postReleasesReleaseIdTransition" ? { to: "active", expectedRevision: 1, reasonCode: "x" }
          : op.method === "GET" ? undefined : {};
      const response = await env.call(op.operationId, body === undefined ? {} : { body });
      checks += 1;
      if (response.status !== 403 || response.body?.error !== "authorization.role_missing") failures.push(`${op.operationId} as ${persona.persona.personaId}: ${response.status} ${response.body?.error}`);
    }
    console.log(`auth matrix: ${checks} operations checked`);
    expect(failures).toEqual([]);
    // Every persona holds the common read actions, so operations gated only by those have no
    // persona to refuse; the rest (74 since the deployment-owner persona went with GAP-116) are checked.
    expect(checks).toBeGreaterThan(70);
  });

  it("uses roleActions, not persona names", () => {
    env.as("auditor");
    expect(sessionFor(env.state).actions).toEqual([...new Set(ROLE_ACTIONS["Platform.Auditor"])].sort());
  });
});

describe("session and CSRF", () => {
  it("rejects a mutation without the session's CSRF token", async () => {
    const response = await env.call("postOperationsHumanWorkWorkItemIdClaim", { csrf: "forged" });
    expect(response.status).toBe(403);
    expect(response.body.error).toBe("csrf.invalid");
  });

  it("answers ETag and 304 for unchanged reads", async () => {
    const first = await env.call("getFincrimeCasesCaseIdRoom");
    expect(first.headers.get("etag")).toMatch(/^"seq-14;/);
    const second = await env.call("getFincrimeCasesCaseIdRoom", { headers: { "if-none-match": first.headers.get("etag")! } });
    expect(second.status).toBe(304);
  });

  it("honours limit and cursor on lists", async () => {
    const first = await env.call("getFincrimeSkills", { query: { limit: "5" } });
    expect(first.body.items).toHaveLength(5);
    const next = await env.call("getFincrimeSkills", { query: { limit: "5", cursor: first.body.nextCursor } });
    expect(next.body.items[0].skill_id).not.toBe(first.body.items[0].skill_id);
  });

  it("switches persona through PUT /mock/session", async () => {
    const response = await env.call("putMockSession", { body: { personaId: "auditor" } });
    expect(response.body.subject.subjectId).toBe("p.lindgren");
    expect((await env.call("getSession")).body.roles).toEqual(["Platform.Auditor"]);
  });
});

describe("case documents (EHF document intelligence)", () => {
  it("lists the case's documents and lists an upload as stored but unparsed", async () => {
    env.as("cdd_analyst");
    const before = await env.call("getFincrimeCasesCaseIdDocuments", {});
    expect(before.status).toBe(200);
    expect((before.body.documents as unknown[]).length).toBe(3);
    const upload = await env.call("postFincrimeCasesCaseIdDocuments", { body: { filename: "certificate.txt", mediaType: "text/plain", contentBase64: btoa("Certificate of incorporation"), documentType: "certificate_of_incorporation" } });
    expect(upload.status).toBe(201);
    expect(upload.body).toMatchObject({ status: "UPLOADED_UNPARSED", documentType: "certificate_of_incorporation", documentId: expect.stringMatching(/^doc_[a-f0-9]{24}$/) });
    const after = await env.call("getFincrimeCasesCaseIdDocuments", {});
    expect(after.body.documents).toContainEqual(expect.objectContaining({ documentId: upload.body.documentId, extractionStatus: "NOT_EXTRACTED", documentType: null }));
  });

  it("refuses an upload to a person without evidence.write", async () => {
    env.as("qa_reviewer");
    const refused = await env.call("postFincrimeCasesCaseIdDocuments", { body: { filename: "x.txt", mediaType: "text/plain", contentBase64: btoa("x") } });
    expect(refused.status).toBe(403);
  });
});

it("requests a supplemental Recon brief without changing the case sequence", async () => {
  env.at("ownership_review");
  env.as("cdd_analyst");
  const before = (await env.call("getFincrimeCasesCaseIdRoom")).body.caseSequence;
  expect((await env.call("getFincrimeCasesCaseIdRecon")).body).toEqual({ status: "idle", canRequest: true, brief: null });
  expect((await env.call("postFincrimeCasesCaseIdRecon")).body).toEqual({ status: "queued", canRequest: false, brief: null });
  const ready = await env.call("getFincrimeCasesCaseIdRecon");
  expect(ready.status).toBe(200);
  expect(ready.body).toMatchObject({ status: "complete", brief: { signals: [{ verificationStatus: "UNVERIFIED" }] } });
  expect((await env.call("getFincrimeCasesCaseIdRoom")).body.caseSequence).toBe(before);
});
