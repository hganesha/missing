import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { planDigestOf } from "./case-plans.js";
import { setup } from "./test-support.js";

const env = setup();
beforeAll(() => env.server.listen({ onUnhandledRequest: "error" }));
afterAll(() => env.server.close());
beforeEach(() => { env.at("ownership_review"); env.as("cdd_analyst"); });
afterEach(() => expect(env.state.violations).toEqual([]));

const select = (body: unknown) => env.call("postCasePlansSelect", { body });
const BUSINESS = { customerType: "corporate", trigger: "onboarding", jurisdiction: "GB", products: ["deposit", "payments"] };

describe("case plan selection by scope (mock)", () => {
  it("selects the released KYB plan and the GB business-banking pack for a GB business case", async () => {
    const response = await select(BUSINESS);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      planDigest: planDigestOf("kyb-agentic"),
      policyAuthority: { policyId: "policy.pack.gb.bank-synthetic.business-banking" },
      scope: { customerType: "corporate", trigger: "onboarding", dueDiligence: "standard", jurisdictions: ["US", "GB"] },
      pack: { id: "policy.pack.gb.bank-synthetic.business-banking", scope: { jurisdiction: "GB", customerTypes: ["corporate"] } },
    });
    expect(response.body.policyAuthority.policyBundleDigest).toMatch(/^[a-f0-9]{64}$/);
    expect((await select({ ...BUSINESS, dueDiligence: "simplified", jurisdiction: "AU" })).body.planDigest).toBe(planDigestOf("kyb-sdd-agentic"));
    expect((await select({ customerType: "individual", trigger: "onboarding", dueDiligence: "enhanced", jurisdiction: "AU", products: ["card"] })).body)
      .toMatchObject({ planDigest: planDigestOf("kyc-edd-agentic"), pack: { id: "policy.pack.au.bank-synthetic.personal-banking" } });
  });

  it("refuses with the reason: no plan, no pack, or an invalid scope", async () => {
    const australia = await select({ customerType: "individual", trigger: "onboarding", jurisdiction: "AU", products: ["card"] });
    expect(australia.status).toBe(422);
    expect(australia.body).toMatchObject({ error: "case.plan_no_pack", message: expect.stringContaining("AU"), details: { candidates: [planDigestOf("kyc-agentic")] } });
    expect((await select({ customerType: "individual", trigger: "onboarding", jurisdiction: "US", products: ["lending"] })).body.error).toBe("case.plan_no_pack");
    expect((await select({ ...BUSINESS, customerType: "trust" })).body.error).toBe("case.plan_no_plan");
    expect((await select({ ...BUSINESS, trigger: "periodic_review" })).body).toMatchObject({ error: "case.plan_no_plan", message: expect.stringContaining("periodic_review") });
    expect((await select({ ...BUSINESS, trigger: "event_review", event: "ownership_change" })).body.error).toBe("case.plan_no_plan");
    expect((await select({ ...BUSINESS, products: [] })).status).toBe(400);
    expect((await select({ ...BUSINESS, jurisdictions: ["GB"] })).body.error).toBe("case.scope_invalid");
  });

  it("opens a case by its scope in the scope's jurisdiction, and refuses a selection that changed", async () => {
    const selection = (await select(BUSINESS)).body;
    const created = await env.call("postCases", { body: { caseType: "kyc_onboarding", externalRef: "ACME-GB", harnessPlanDigest: selection.planDigest, classification: "confidential", scope: BUSINESS } });
    expect(created.status).toBe(201);
    const listed = (await env.call("getCases", { query: { query: "ACME-GB" } })).body.items;
    expect(listed).toEqual([expect.objectContaining({ caseId: created.body.caseId, jurisdiction: "GB", harnessPlanDigest: selection.planDigest })]);
    const changed = await env.call("postCases", { body: { caseType: "kyc_onboarding", externalRef: null, harnessPlanDigest: planDigestOf("kyc-agentic"), classification: "confidential", scope: BUSINESS } });
    expect(changed.status).toBe(409);
    expect(changed.body.error).toBe("case.plan_selection_changed");
    const refused = await env.call("postCases", { body: { caseType: "kyc_onboarding", externalRef: null, harnessPlanDigest: selection.planDigest, classification: "confidential", scope: { ...BUSINESS, jurisdiction: "AU", dueDiligence: "standard" } } });
    expect(refused.status).toBe(422);
    expect(refused.body.error).toBe("case.plan_no_pack");
  });
});
