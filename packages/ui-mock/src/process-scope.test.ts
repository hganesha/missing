import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AGENTIC_KYC_DRAFT_ID, PERSONAL_SCOPE } from "./process-scope.js";
import { setup } from "./test-support.js";

const env = setup();
beforeAll(() => env.server.listen({ onUnhandledRequest: "error" }));
afterAll(() => env.server.close());
beforeEach(() => { env.at("ownership_review"); env.as("agent_architect"); });
afterEach(() => expect(env.state.violations).toEqual([]));

const path = { draftId: AGENTIC_KYC_DRAFT_ID };
const BUSINESS = { customerType: "corporate", trigger: "onboarding", jurisdictions: ["US", "GB"], products: ["deposit", "lending", "merchant_acquiring", "payments"] };
const preview = (scope: unknown) => env.call("postAuthoringDraftsDraftIdScopePreview", { path, body: { scope } });
const apply = (scope: unknown, expectedRevision: number) => env.call("postAuthoringDraftsDraftIdScopeApply", { path, body: { scope, expectedRevision } });

describe("process scope authoring (mock)", () => {
  it("lists the options and reads the seeded draft's scope from its pinned packs", async () => {
    const options = (await env.call("getAuthoringScopeOptions")).body;
    expect(options.triggers).toContainEqual({ value: "event_review", available: true });
    expect(options.customerTypes).toEqual([{ value: "individual", available: true }, { value: "corporate", available: true }, { value: "trust", available: true }]);
    expect(options.events).toContainEqual({ value: "ownership_change", customerTypes: ["corporate", "trust"] });
    expect(options.events).toContainEqual({ value: "trust_party_change", customerTypes: ["trust"] });
    expect(options.jurisdictions).toContainEqual({ code: "AU", available: true });
    expect(options.jurisdictions).toContainEqual({ code: "DE", available: false });
    expect(options.dueDiligence).toContainEqual(expect.objectContaining({ value: "simplified", customerTypes: ["corporate"] }));
    expect((await env.call("getAuthoringDraftsDraftIdScope", { path })).body).toEqual({ scope: PERSONAL_SCOPE });
  });

  it("previews individual → corporate with the reason for every added agent, step and connector", async () => {
    const response = await preview(BUSINESS);
    expect(response.status).toBe(200);
    const { changes, decisions } = response.body.preview;
    expect(changes.agents).toEqual({ added: ["agent.identity_ownership"], removed: [] });
    expect([...changes.connectors.added].sort()).toEqual(["acquire-lei", "acquire-officers", "acquire-ownership", "acquire-registry"]);
    expect(changes.skills.added).toEqual(expect.arrayContaining(["registry.company.verify", "screening.sanctions.ownership.evaluate"]));
    expect(changes.packs).toEqual({ added: ["policy.pack.us.bank-synthetic.business-banking", "policy.pack.gb.bank-synthetic.business-banking"], removed: ["policy.pack.us.bank-synthetic.personal-banking", "policy.pack.gb.bank-synthetic.personal-banking"] });
    expect(decisions.find((item: { id: string }) => item.id === "acquire-officers")).toMatchObject({ basis: { source: "pack", field: "screening_roles", value: "director" } });
    expect((await env.call("getAuthoringDraftsDraftId", { path })).body.revision).toBe(1);
  });

  it("applies the change as one revision, then previews the way back as removals", async () => {
    const applied = await apply(BUSINESS, 1);
    expect(applied.status).toBe(200);
    expect(applied.body.draft.revision).toBe(2);
    expect(applied.body.draft.parsedWorkflow.spec.nodes).toContainEqual(expect.objectContaining({ id: "identity-ownership-review", kind: "agent" }));
    expect((await env.call("getAuthoringDraftsDraftIdScope", { path })).body.scope).toMatchObject(BUSINESS);
    const back = (await preview(PERSONAL_SCOPE)).body.preview;
    expect(back.changes.agents).toEqual({ added: [], removed: ["agent.identity_ownership"] });
    expect(back.decisions).toContainEqual(expect.objectContaining({ id: "registry.company.verify", action: "exclude" }));
    expect((await apply(PERSONAL_SCOPE, 1)).status).toBe(409);
  });

  it("refuses a jurisdiction with no pack layer with a remedy", async () => {
    const germany = await preview({ ...PERSONAL_SCOPE, jurisdictions: ["DE"] });
    expect(germany.status).toBe(422);
    expect(germany.body).toMatchObject({ error: "scope.pack_layer_missing", remedy: expect.stringContaining("DE") });
    expect((await preview({ ...PERSONAL_SCOPE, jurisdictions: ["AU"] })).status).toBe(200);
    expect((await apply({ ...PERSONAL_SCOPE, jurisdictions: ["DE"] }, 1)).status).toBe(422);
    expect((await env.call("getAuthoringDraftsDraftId", { path })).body.revision).toBe(1);
  });

  it("previews due-diligence levels: enhanced adds the EDD steps, simplified is for legal entities only", async () => {
    const enhanced = (await preview({ ...PERSONAL_SCOPE, dueDiligence: "enhanced" })).body.preview;
    expect(enhanced.changes.skills.added).toEqual(["edd.scope.plan", "edd.source_of_funds.verify", "edd.source_of_wealth.assess"]);
    expect(enhanced.decisions).toContainEqual(expect.objectContaining({ kind: "due_diligence", id: "enhanced", basis: { source: "scope", field: "dueDiligence", value: "enhanced" } }));
    const ineligible = await preview({ ...PERSONAL_SCOPE, dueDiligence: "simplified" });
    expect(ineligible.status).toBe(422);
    expect(ineligible.body).toMatchObject({ error: "scope.due_diligence_ineligible", remedy: expect.stringContaining("standard") });
    const simplified = (await preview({ ...BUSINESS, dueDiligence: "simplified" })).body.preview;
    expect(simplified.changes.agents.added).toEqual([]);
    expect(simplified.changes.connectors.added).not.toContain("acquire-ownership");
    expect(simplified.decisions).toContainEqual(expect.objectContaining({ kind: "agent", id: "agent.identity_ownership", action: "exclude" }));
  });

  it("composes reviews: an event review re-runs only the agents its event can affect", async () => {
    expect((await preview({ ...PERSONAL_SCOPE, trigger: "periodic_review" })).body.preview.changes.agents).toEqual({ added: [], removed: [] });
    const review = (await preview({ ...PERSONAL_SCOPE, trigger: "event_review", event: "address_change" })).body.preview;
    expect(review.decisions[0]).toMatchObject({ kind: "trigger", id: "event_review", reason: expect.stringContaining("address change") });
    expect(review.changes.agents.removed).toEqual([]);
    const tax = (await preview({ ...PERSONAL_SCOPE, trigger: "event_review", event: "tax_circumstances_change" })).body.preview;
    expect(tax.changes.agents.removed).toEqual(["agent.identity_verification"]);
    expect(tax.decisions).toContainEqual(expect.objectContaining({ id: "agent.identity_verification", action: "exclude", basis: { source: "scope", field: "event", value: "tax_circumstances_change" } }));
    expect((await preview({ ...PERSONAL_SCOPE, trigger: "event_review" })).body.error).toBe("scope.event_required");
    expect((await preview({ ...PERSONAL_SCOPE, trigger: "event_review", event: "ownership_change" })).body.error).toBe("scope.event_ineligible");
    expect((await preview({ ...PERSONAL_SCOPE, event: "address_change" })).body.error).toBe("scope.event_unexpected");
  });

  it("composes a trust as a legal arrangement: entity agents and packs, trust documents, no company acquisition, never simplified", async () => {
    const TRUST = { ...BUSINESS, customerType: "trust" };
    const trust = (await preview(TRUST)).body.preview;
    expect(trust.changes.agents.added).toEqual(["agent.identity_ownership"]);
    expect(trust.changes.packs.added).toEqual(["policy.pack.us.bank-synthetic.business-banking", "policy.pack.gb.bank-synthetic.business-banking"]);
    expect(trust.changes.connectors.added).toEqual(["acquire-lei"]);
    expect(trust.changes.skills.added).toContain("screening.sanctions.ownership.evaluate");
    expect(trust.changes.skills.added).not.toContain("registry.company.verify");
    expect(trust.decisions).toContainEqual(expect.objectContaining({ kind: "requirements", id: "trust", action: "include" }));
    for (const connector of ["acquire-registry", "acquire-officers", "acquire-ownership"]) {
      expect(trust.decisions).toContainEqual(expect.objectContaining({ kind: "connector", id: connector, action: "exclude" }));
    }
    expect(trust.decisions.find((item: { id: string }) => item.id === "acquire-ownership").reason).toContain("trust deed");
    expect((await apply(TRUST, 1)).body.draft.parsedWorkflow.metadata).toMatchObject({ name: "kyb-trust-agentic" });
    const simplified = await preview({ ...TRUST, dueDiligence: "simplified" });
    expect(simplified.status).toBe(422);
    expect(simplified.body.error).toBe("scope.due_diligence_ineligible");
    expect((await preview({ ...TRUST, dueDiligence: "enhanced" })).status).toBe(200);
    expect((await preview({ ...TRUST, trigger: "event_review", event: "trust_party_change" })).status).toBe(200);
    expect((await preview({ ...BUSINESS, trigger: "event_review", event: "trust_party_change" })).body.error).toBe("scope.event_ineligible");
  });

  it("refuses a draft that is not a composed process", async () => {
    const other = await env.call("postAuthoringDraftsDraftIdScopePreview", { body: { scope: BUSINESS } });
    expect(other.status).toBe(422);
    expect(other.body.error).toBe("authoring.scope_unsupported_draft");
  });
});
