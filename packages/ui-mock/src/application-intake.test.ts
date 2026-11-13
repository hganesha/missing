import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { planDigestOf } from "./case-plans.js";
import { setup } from "./test-support.js";

const env = setup();
beforeAll(() => env.server.listen({ onUnhandledRequest: "error" }));
afterAll(() => env.server.close());
beforeEach(() => { env.at("ownership_review"); env.as("cdd_analyst"); });
afterEach(() => expect(env.state.violations).toEqual([]));

const COMPANY = {
  scope: { customerType: "corporate", trigger: "onboarding", dueDiligence: "standard", jurisdiction: "GB", products: ["deposit", "payments"] },
  customer: { name: "Thistle Fabrication Ltd", legalForm: "corporation", registrationNumber: "SC401042", registrationJurisdiction: "GB",
    addresses: [{ lines: ["Unit 4, Mill Lane"], country: "GB" }] },
  relatedParties: [
    { name: "Gareth Thistle", roles: ["beneficial_owner", "director"], ownershipPercent: "60" },
    { name: "Priya Nair", roles: ["beneficial_owner"], ownershipPercent: "40" },
  ],
  expectedActivity: [{ product: "deposit", currency: "GBP", monthlyInflow: "310000" }],
  sourceOfFunds: "Revenue from fabrication contracts", externalRef: "APP-MOCK-GB",
};
const submit = (body: unknown, key = "mock-application-1") => env.call("postApplications", { body, headers: { "idempotency-key": key } });

describe("application intake (mock)", () => {
  it("opens a populated KYB case for a GB company with two owners, pinned to the GB business-banking pack", async () => {
    const response = await submit(COMPANY);
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      caseType: "kyb_onboarding", planDigest: planDigestOf("kyb-agentic"), subjectsAdded: 3,
      pack: { id: "policy.pack.gb.bank-synthetic.business-banking", scope: { jurisdiction: "GB" } },
    });
    // Entity ×3, Identity ×2, IdentityIdentifier (registration), Address, Registration, Party, Product ×2,
    // ExpectedActivity, BankingRelationship, OwnershipInterest ×2, OfficerRole, SourceOfFunds, Application.
    expect(response.body.recordsRecorded).toBe(18);
    expect(response.body.documentsUploaded).toBe(0);
    const listed = (await env.call("getCases", { query: { query: "APP-MOCK-GB" } })).body.items;
    expect(listed).toEqual([expect.objectContaining({ caseId: response.body.caseId, caseType: "kyb_onboarding", jurisdiction: "GB", harnessPlanDigest: planDigestOf("kyb-agentic") })]);
  });

  it("answers a retry as the original did, and refuses the same key for a different application", async () => {
    const first = await submit(COMPANY, "mock-application-2");
    const retry = await submit(COMPANY, "mock-application-2");
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect((await env.call("getCases", { query: { query: "APP-MOCK-GB" } })).body.items).toHaveLength(1);
    const changed = await submit({ ...COMPANY, sourceOfFunds: "A director's loan" }, "mock-application-2");
    expect(changed.status).toBe(409);
    expect(changed.body.error).toBe("command.idempotency_conflict");
  });

  it("opens a KYC case for a person", async () => {
    const person = await submit({
      scope: { customerType: "individual", trigger: "onboarding", jurisdiction: "US", products: ["deposit"] },
      customer: { name: "Dana Reyes", dateOfBirth: "1990-06-30", nationality: "US", identifiers: [{ type: "passport", issuer: "US", value: "SPECIMEN-9" }] },
    }, "mock-application-person");
    expect(person.status).toBe(201);
    expect(person.body).toMatchObject({ caseType: "kyc_onboarding", planDigest: planDigestOf("kyc-agentic"), subjectsAdded: 1, recordsRecorded: 7 });
    expect(person.body.caseId).toMatch(/^KYC-/);
  });

  it("keeps a refused selection's reason, refuses an invalid application and a changed selection", async () => {
    const refused = await submit({ ...COMPANY, scope: { ...COMPANY.scope, jurisdiction: "AU" } }, "mock-application-au");
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ error: "case.plan_no_pack", message: expect.stringContaining("AU") });
    const invalid = await submit({ ...COMPANY, customer: { name: "No Registration Ltd", legalForm: "corporation" } }, "mock-application-invalid");
    expect(invalid.status).toBe(400);
    expect(invalid.body).toMatchObject({ error: "application.request_invalid", details: { issues: expect.arrayContaining([expect.objectContaining({ path: "customer.registrationNumber" })]) } });
    const changed = await submit({ ...COMPANY, harnessPlanDigest: planDigestOf("kyc-agentic") }, "mock-application-changed");
    expect(changed.status).toBe(409);
    expect(changed.body.error).toBe("case.plan_selection_changed");
    expect((await env.call("postApplications", { body: COMPANY })).body.error).toBe("application.idempotency_key_required");
  });

  it("records a person's declared PEP sibling: one more subject, Entity, Identity and PEPRelationship", async () => {
    const person = await submit({
      scope: { customerType: "individual", trigger: "onboarding", jurisdiction: "US", products: ["deposit"] },
      customer: { name: "Dana Reyes", dateOfBirth: "1990-06-30", nationality: "US", politicallyExposed: "no" },
      relatedParties: [{ name: "Kim Reyes", relationToCustomer: "sibling", politicallyExposed: "yes", pepPosition: "Ambassador" }],
    }, "mock-application-pep");
    expect(person.status).toBe(201);
    // Entity ×2, Identity ×2, Party, Product, BankingRelationship, PEPRelationship, Application.
    expect(person.body).toMatchObject({ caseType: "kyc_onboarding", subjectsAdded: 2, recordsRecorded: 9 });
    const owner = await submit({ ...COMPANY, scope: { ...COMPANY.scope, customerType: "individual" }, customer: { name: "X", dateOfBirth: "1990-01-01", nationality: "US" } }, "mock-application-owner-person");
    expect(owner.status).toBe(400);
    expect(owner.body.details.issues).toEqual(expect.arrayContaining([expect.objectContaining({ message: "application.relation_required" })]));
  });

  it("uploads a company's document as case evidence and records it, refusing a type outside the document field catalog", async () => {
    const document = { documentType: "certificate_of_incorporation", filename: "certificate.txt", mediaType: "text/plain", contentBase64: btoa("CERTIFICATE OF INCORPORATION\nThistle Fabrication Ltd\n") };
    const response = await submit({ ...COMPANY, externalRef: "APP-MOCK-DOC", documents: [document] }, "mock-application-document");
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ documentsUploaded: 1, recordsRecorded: 19 });
    const unknown = await submit({ ...COMPANY, documents: [{ ...document, documentType: "napkin_sketch" }] }, "mock-application-napkin");
    expect(unknown.status).toBe(400);
    expect(unknown.body.details.issues).toEqual([expect.objectContaining({ path: "documents.0.documentType", message: "application.document_type_unknown" })]);
  });

  it("opens a scope-only business case as KYB, as the BFF does", async () => {
    const selection = (await env.call("postCasePlansSelect", { body: COMPANY.scope })).body;
    const created = await env.call("postCases", { body: { caseType: "kyb_onboarding", externalRef: "SCOPE-ONLY-GB", harnessPlanDigest: selection.planDigest, classification: "confidential", scope: COMPANY.scope } });
    expect(created.status).toBe(201);
    expect((await env.call("getCases", { query: { query: "SCOPE-ONLY-GB" } })).body.items).toEqual([expect.objectContaining({ caseType: "kyb_onboarding" })]);
  });

  it("refuses a role without case.write", async () => {
    env.as("auditor");
    const forbidden = await submit(COMPANY, "mock-application-auditor");
    expect(forbidden.status).toBe(403);
  });
});
