import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applicationSubmissionSchema, bankingRelationshipSchema, mapApplicationSubmission, percentToFraction, recordCanonicalRecordsPayloadSchema,
  sha256Hex, validateApplicationContext, APPLICATION_DOCUMENT_MAX_BYTES, type ApplicationSubmissionInput, type CanonicalRecordInput,
} from "./index.js";

const OBSERVED = "2026-11-11T09:30:00.000Z";
const TENANT = "tenant-a";

export const INDIVIDUAL: ApplicationSubmissionInput = {
  scope: { customerType: "individual", trigger: "onboarding", jurisdiction: "GB", products: ["deposit", "card"] },
  customer: {
    name: "Amelia Hart", dateOfBirth: "1988-04-12", nationality: "GB",
    identifiers: [{ type: "passport", issuer: "GB", value: "SPECIMEN-PP-1001" }],
    addresses: [{ lines: ["14 Orchard Row"], locality: "Leeds", postalCode: "LS1 4AB", country: "GB" }],
  },
  expectedActivity: [{ product: "deposit", currency: "GBP", monthlyInflow: "4200", monthlyOutflow: "3900", counterpartyCountries: ["GB"] }],
  sourceOfFunds: "Salary from employment as a structural engineer",
  externalRef: "APP-IND-1", channel: "online",
};

export const CORPORATE: ApplicationSubmissionInput = {
  scope: { customerType: "corporate", trigger: "onboarding", dueDiligence: "standard", jurisdiction: "GB", products: ["deposit", "payments"] },
  customer: {
    name: "Thistle Fabrication Ltd", legalForm: "corporation", registrationNumber: "SC401042", registrationJurisdiction: "GB",
    industry: "metal_fabrication", businessPurpose: "Sheet-metal fabrication for UK manufacturers",
    identifiers: [{ type: "lei", issuer: "GLEIF", value: "5493001KJTIIGC8Y1R12" }],
    addresses: [{ lines: ["Unit 4, Mill Lane"], locality: "Sheffield", postalCode: "S3 8AA", country: "GB" }],
  },
  relatedParties: [
    { name: "Gareth Thistle", roles: ["beneficial_owner", "director"], ownershipPercent: "60", dateOfBirth: "1971-11-08", nationality: "GB",
      identifiers: [{ type: "passport", issuer: "GB", value: "SPECIMEN-PP-0001" }] },
    { name: "Priya Nair", roles: ["beneficial_owner"], ownershipPercent: "40", nationality: "GB" },
  ],
  expectedActivity: [
    { product: "deposit", currency: "GBP", monthlyInflow: "310000", monthlyOutflow: "295000", counterpartyCountries: ["GB", "IE"] },
    { product: "payments", currency: "EUR", monthlyOutflow: "14500", counterpartyCountries: ["DE"] },
  ],
  sourceOfFunds: "Revenue from fabrication contracts",
  externalRef: "APP-CORP-1", channel: "relationship_manager",
};

export const TRUST: ApplicationSubmissionInput = {
  scope: { customerType: "trust", trigger: "onboarding", jurisdiction: "GB", products: ["deposit"] },
  customer: { name: "Hart Family Trust", legalForm: "ordinary_trust", registrationNumber: "TRS-88812", registrationJurisdiction: "GB" },
  relatedParties: [
    { name: "Northgate Trustees Ltd", kind: "company", roles: ["trustee"], legalForm: "corporation", registrationNumber: "09912345", registrationJurisdiction: "GB" },
    { name: "Edward Hart", roles: ["settlor"], dateOfBirth: "1950-02-01", nationality: "GB" },
    { name: "Lucy Hart", roles: ["beneficiary"], ownershipPercent: "100", nationality: "GB" },
  ],
  synthetic: true,
};

/** A person who declares a politically exposed sibling and a close associate. */
export const PEP_FAMILY: ApplicationSubmissionInput = {
  ...INDIVIDUAL,
  customer: { ...INDIVIDUAL.customer, politicallyExposed: "no" },
  relatedParties: [
    { name: "Oliver Hart", relationToCustomer: "sibling", politicallyExposed: "yes", pepPosition: "Member of Parliament", dateOfBirth: "1985-02-03", nationality: "GB" },
    { name: "Sam Okafor", relationToCustomer: "close_associate", politicallyExposed: "unknown" },
  ],
};

const CERTIFICATE = "CERTIFICATE OF INCORPORATION\nCompany name: Thistle Fabrication Ltd\nCompany number: SC401042\n";
/** A company that uploads its certificate of incorporation. */
export const WITH_DOCUMENT: ApplicationSubmissionInput = {
  ...CORPORATE,
  documents: [{ documentType: "certificate_of_incorporation", filename: "certificate.txt", mediaType: "text/plain", contentBase64: Buffer.from(CERTIFICATE).toString("base64") }],
};
const CERTIFICATE_SHA = createHash("sha256").update(CERTIFICATE).digest("hex");
const REGISTRATION = { evidenceId: "evidence_1", artifactRef: `artifact://postgres/tenant-a/${CERTIFICATE_SHA}`, sha256: `sha256:${CERTIFICATE_SHA}` };

const map = (input: ApplicationSubmissionInput) => mapApplicationSubmission(input, { tenantId: TENANT, observedAt: OBSERVED });
const types = (records: CanonicalRecordInput[]) => records.reduce<Record<string, number>>((counts, record) => ({ ...counts, [record.object_type]: (counts[record.object_type] ?? 0) + 1 }), {});
const one = (records: CanonicalRecordInput[], type: string) => records.filter((record) => record.object_type === type);

function wellFormed(records: CanonicalRecordInput[]) {
  expect(recordCanonicalRecordsPayloadSchema.safeParse({ records }).success).toBe(true);
  for (const record of records) {
    expect(record.provenance).toEqual({ method: "applicant_supplied", normalizer: "application.intake@1" });
    expect(record.observed_at).toBe(OBSERVED);
    expect(validateApplicationContext(record.object_type, record.data)).toEqual([]);
  }
  // Every reference an Application makes resolves to a record version in the same batch.
  const application = one(records, "Application")[0]!.data as { applicants: Array<{ party_ref: Record<string, string> }>; requested_products: Array<Record<string, string>> };
  for (const ref of [...application.applicants.map((a) => a.party_ref), ...application.requested_products]) {
    expect(records.some((record) => record.object_type === ref.object_type && record.object_id === ref.object_id && record.version_id === ref.version_id && ref.tenant_id === TENANT)).toBe(true);
  }
  expect(bankingRelationshipSchema.safeParse(one(records, "BankingRelationship")[0]!.data).success).toBe(true);
}

describe("application intake mapping", () => {
  it("maps an individual to a KYC case with the person's identity, identifier, address and declared activity", () => {
    const intake = map(INDIVIDUAL);
    expect(intake).toMatchObject({ caseType: "kyc_onboarding", schemaVersion: "kyc.case.v1", applicationId: "APP-IND-1", customerEntityId: "entity.customer" });
    expect(types(intake.records)).toEqual({ Entity: 1, Identity: 1, IdentityIdentifier: 1, Address: 1, Party: 1, Product: 2, ExpectedActivity: 1, BankingRelationship: 1, SourceOfFunds: 1, Application: 1 });
    wellFormed(intake.records);
    expect(intake.subjects).toEqual([{
      subjectId: "entity.customer", subjectType: "individual", displayName: "Amelia Hart",
      attributes: expect.objectContaining({ role: "customer", country: "GB", dateOfBirth: "1988-04-12", nationality: "GB", submissionDigest: intake.submissionDigest }),
      identifiers: [{ identifierType: "passport", value: "SPECIMEN-PP-1001", source: "GB" }],
    }]);
    expect(one(intake.records, "Identity")[0]).toMatchObject({ classification: "PII", data: { attributes: { name: "Amelia Hart", date_of_birth: "1988-04-12" }, extensions: { "ehf.application": { value: { nationality: "GB" } } } } });
    expect(one(intake.records, "IdentityIdentifier")[0]!.data).toEqual({ entity_id: "entity.customer", issuer: "GB", value: "SPECIMEN-PP-1001", identifier_type: "passport", verified: false });
    expect(one(intake.records, "Party")[0]).toMatchObject({ classification: "PII", data: { entity_id: "entity.customer", role: "customer", customer_type: "individual" } });
    expect(one(intake.records, "ExpectedActivity")[0]!.data).toMatchObject({ declared: { currency: "GBP", monthly_amount: "4200" }, window: { start: OBSERVED, end: "2027-11-11T09:30:00.000Z" } });
    expect(one(intake.records, "SourceOfFunds")[0]!.data).toEqual({ claim: "Salary from employment as a structural engineer", evidence_ids: [], verified: false });
    expect(one(intake.records, "Application")[0]!.data).toMatchObject({ status: "SUBMITTED", submitted_at: OBSERVED, channel: "online", source_application_id: "APP-IND-1", applicants: [{ role: "PRIMARY" }] });
    expect(one(intake.records, "BankingRelationship")[0]!.data).toMatchObject({ customerEntityId: "entity.customer", bookingJurisdiction: "GB", policyJurisdiction: "GB", event: "onboarding",
      entities: [{ entityId: "entity.customer", legalForm: "individual", legalEntityCustomer: false }], parties: [{ entityId: "entity.customer", role: "customer" }] });
    expect(intake.records.every((record) => record.synthetic === false)).toBe(true);
  });

  it("maps a corporate with two owners to a KYB case: an entity per party, stated ownership and officer roles", () => {
    const intake = map(CORPORATE);
    expect(intake.caseType).toBe("kyb_onboarding");
    expect(intake.schemaVersion).toBe("kyb.case.v1");
    expect(types(intake.records)).toEqual({
      Entity: 3, Identity: 2, IdentityIdentifier: 3, Address: 1, Registration: 1, Party: 1, Product: 2, ExpectedActivity: 2, BankingRelationship: 1,
      OwnershipInterest: 2, OfficerRole: 1, SourceOfFunds: 1, Application: 1,
    });
    wellFormed(intake.records);
    expect(intake.subjects.map((subject) => [subject.subjectId, subject.subjectType, subject.attributes.role])).toEqual([
      ["entity.customer", "legal_entity", "customer"], ["entity.party-1", "individual", "beneficial_owner"], ["entity.party-2", "individual", "beneficial_owner"],
    ]);
    // The registration number is an identifier too, so entity resolution can match it.
    expect(intake.subjects[0]!.identifiers).toEqual([
      { identifierType: "lei", value: "5493001KJTIIGC8Y1R12", source: "GLEIF" }, { identifierType: "registration_number", value: "SC401042", source: "GB" },
    ]);
    expect(intake.subjects[0]!.attributes).toMatchObject({ country: "GB", registrationNumber: "SC401042", legalForm: "corporation" });
    expect(one(intake.records, "OwnershipInterest").map((record) => record.data)).toEqual([
      { owner: "entity.party-1", owned: "entity.customer", interest: "0.6" }, { owner: "entity.party-2", owned: "entity.customer", interest: "0.4" },
    ]);
    expect(one(intake.records, "OfficerRole")[0]!.data).toEqual({ entity_id: "entity.party-1", organization_id: "entity.customer", role: "director" });
    // The registry was not named: the Registration says so rather than guessing one.
    expect(one(intake.records, "Registration")[0]).toMatchObject({ object_id: "registration.customer", subject_ids: ["entity.customer"], data: { jurisdiction: "GB", authority: "not_declared", registration_id: "SC401042" } });
    expect(one(intake.records, "Entity")[0]).toMatchObject({ classification: "CONFIDENTIAL", data: { name: "Thistle Fabrication Ltd", entity_type: "company", attributes: { registration_id: "SC401042" } } });
    expect(one(intake.records, "Entity")[1]!.classification).toBe("PII");
    const relationship = one(intake.records, "BankingRelationship")[0]!.data as Record<string, any>;
    expect(relationship.parties.map((party: { entityId: string; role: string }) => `${party.entityId}:${party.role}`)).toEqual([
      "entity.customer:customer", "entity.party-1:beneficial_owner", "entity.party-1:director", "entity.party-2:beneficial_owner",
    ]);
    expect(relationship.products).toEqual([
      expect.objectContaining({ productId: "product.deposit", productType: "deposit", currencies: ["GBP"], channels: ["relationship_manager"],
        expectedActivity: expect.objectContaining({ monthlyInflow: "310000", monthlyOutflow: "295000", counterpartyCountries: ["GB", "IE"] }) }),
      expect.objectContaining({ productId: "product.payments", expectedActivity: expect.objectContaining({ monthlyInflow: null, monthlyOutflow: "14500", currency: "EUR" }) }),
    ]);
    expect(relationship.entities[0]).toEqual({ entityId: "entity.customer", name: "Thistle Fabrication Ltd", legalForm: "corporation", legalEntityCustomer: true, formationJurisdiction: "GB" });
    expect(one(intake.records, "OwnershipInterest")[0]!.subject_ids).toEqual(["entity.party-1", "entity.customer"]);
  });

  it("maps a trust with a corporate trustee, a settlor and a beneficiary", () => {
    const intake = map(TRUST);
    expect(intake.caseType).toBe("kyb_onboarding");
    expect(intake.applicationId).toMatch(/^application-[a-f0-9]{24}$/);
    expect(types(intake.records)).toEqual({
      Entity: 4, Identity: 2, IdentityIdentifier: 2, Registration: 2, Party: 1, Product: 1, BankingRelationship: 1, OwnershipInterest: 1, OfficerRole: 3, Application: 1,
    });
    wellFormed(intake.records);
    expect(intake.subjects.map((subject) => subject.subjectType)).toEqual(["legal_entity", "legal_entity", "individual", "individual"]);
    expect(one(intake.records, "OfficerRole").map((record) => (record.data as { role: string }).role)).toEqual(["trustee", "settlor", "beneficiary"]);
    expect(one(intake.records, "OwnershipInterest")[0]!.data).toMatchObject({ owner: "entity.party-3", interest: "1" });
    const relationship = one(intake.records, "BankingRelationship")[0]!.data as Record<string, any>;
    expect(relationship.entities.map((entity: { legalForm: string }) => entity.legalForm)).toEqual(["ordinary_trust", "corporation", "individual", "individual"]);
    expect(intake.records.every((record) => record.synthetic)).toBe(true);
  });

  it("is deterministic: the same submission at the same time maps to the same versions; a change makes new ones", () => {
    expect(map(CORPORATE)).toEqual(map(CORPORATE));
    const changed = map({ ...CORPORATE, sourceOfFunds: "Revenue and a director's loan" });
    const before = map(CORPORATE);
    expect(changed.submissionDigest).not.toBe(before.submissionDigest);
    expect(one(changed.records, "SourceOfFunds")[0]!.version_id).not.toBe(one(before.records, "SourceOfFunds")[0]!.version_id);
    expect(mapApplicationSubmission(CORPORATE, { tenantId: TENANT, observedAt: "2026-11-12T00:00:00Z" }).records[0]!.version_id).not.toBe(before.records[0]!.version_id);
    expect(() => mapApplicationSubmission(CORPORATE, { tenantId: TENANT, observedAt: "not a time" })).toThrow("application.observed_at_invalid");
  });

  it("records a declared PEP sibling and a close associate as PEPRelationships, entities, identities and subjects", () => {
    const intake = map(PEP_FAMILY);
    expect(types(intake.records)).toEqual({ Entity: 3, Identity: 3, IdentityIdentifier: 1, Address: 1, Party: 1, Product: 2, ExpectedActivity: 1, BankingRelationship: 1, PEPRelationship: 2, SourceOfFunds: 1, Application: 1 });
    wellFormed(intake.records);
    expect(one(intake.records, "PEPRelationship").map((record) => record.data)).toEqual([
      { source: "entity.customer", target: "entity.party-1", relation: "sibling", verified: false,
        extensions: { "ehf.application": { schema_version: "1.0.0", value: { target_politically_exposed: "yes", target_pep_position: "Member of Parliament", customer_politically_exposed: "no" } } } },
      { source: "entity.customer", target: "entity.party-2", relation: "close_associate", verified: false,
        extensions: { "ehf.application": { schema_version: "1.0.0", value: { target_politically_exposed: "unknown", customer_politically_exposed: "no" } } } },
    ]);
    expect(one(intake.records, "PEPRelationship")[0]).toMatchObject({ classification: "PII", subject_ids: ["entity.party-1", "entity.customer"] });
    // Screening covers them: each is a case subject.
    expect(intake.subjects.map((subject) => [subject.subjectId, subject.subjectType, subject.attributes.role])).toEqual([
      ["entity.customer", "individual", "customer"], ["entity.party-1", "individual", "sibling"], ["entity.party-2", "individual", "close_associate"],
    ]);
    expect(intake.subjects[1]!.attributes).toMatchObject({ politicallyExposed: "yes", pepPosition: "Member of Parliament", relationToCustomer: "sibling" });
    expect(one(intake.records, "Identity")[1]!.data).toMatchObject({ attributes: { name: "Oliver Hart", date_of_birth: "1985-02-03" }, extensions: { "ehf.application": { value: { politically_exposed: "yes", pep_position: "Member of Parliament" } } } });
    // Relatives hold no role in the relationship.
    expect((one(intake.records, "BankingRelationship")[0]!.data as { parties: unknown[] }).parties).toHaveLength(1);
  });

  it("records a customer's own declared political exposure in the Party record's extensions (Party has no such field)", () => {
    const intake = map({ ...INDIVIDUAL, customer: { ...INDIVIDUAL.customer, politicallyExposed: "yes", pepPosition: "Mayor of Leeds" } });
    expect(one(intake.records, "Party")[0]!.data).toMatchObject({ customer_type: "individual", extensions: { "ehf.application": { schema_version: "1.0.0", value: { politically_exposed: "yes", pep_position: "Mayor of Leeds" } } } });
    expect(one(intake.records, "PEPRelationship")).toEqual([]);
    expect(intake.subjects[0]!.attributes).toMatchObject({ politicallyExposed: "yes" });
    // A PEP director of a business is related through their role.
    const business = map({ ...CORPORATE, relatedParties: [{ ...CORPORATE.relatedParties![0]!, politicallyExposed: "yes" }, CORPORATE.relatedParties![1]!] });
    expect(one(business.records, "PEPRelationship").map((record) => record.data)).toEqual([expect.objectContaining({ target: "entity.party-1", relation: "beneficial_owner" })]);
  });

  it("records an uploaded document as a DocumentVersion over its stored artifact, unparsed", () => {
    expect(() => map(WITH_DOCUMENT)).toThrow("application.document_registration_missing");
    const intake = mapApplicationSubmission(WITH_DOCUMENT, { tenantId: TENANT, observedAt: OBSERVED, documents: [REGISTRATION] });
    wellFormed(intake.records);
    expect(one(intake.records, "DocumentVersion")).toEqual([expect.objectContaining({
      object_id: `doc_${CERTIFICATE_SHA.slice(0, 24)}`, subject_ids: ["entity.customer"], classification: "CONFIDENTIAL",
      data: { document_id: `doc_${CERTIFICATE_SHA.slice(0, 24)}`, artifact_hash: CERTIFICATE_SHA, media_type: "text/plain", artifact_ref: REGISTRATION.artifactRef, page_count: 0,
        extensions: { "ehf.application": { schema_version: "1.0.0", value: { filename: "certificate.txt", document_type: "certificate_of_incorporation", evidence_id: "evidence_1", page_count_basis: "unparsed_upload" } } } },
    })]);
    const aboutOwner = mapApplicationSubmission({ ...WITH_DOCUMENT, documents: [{ ...WITH_DOCUMENT.documents![0]!, relatedParty: 1 }] }, { tenantId: TENANT, observedAt: OBSERVED, documents: [REGISTRATION] });
    expect(one(aboutOwner.records, "DocumentVersion")[0]).toMatchObject({ subject_ids: ["entity.party-2"], classification: "PII" });
    expect(sha256Hex(new TextEncoder().encode(CERTIFICATE))).toBe(CERTIFICATE_SHA);
  });

  it("converts ownership percentages to fractions exactly", () => {
    expect(["60", "12.5", "100", "0", "33.3333", "7", "100.00"].map(percentToFraction)).toEqual(["0.6", "0.125", "1", "0", "0.333333", "0.07", "1"]);
  });

  it("hashes like node's sha256", () => {
    for (const value of ["", "abc", "x".repeat(55), "y".repeat(56), "z".repeat(64), "Ünïcødé ✓ 🚀".repeat(9)]) {
      expect(sha256Hex(value)).toBe(createHash("sha256").update(value, "utf8").digest("hex"));
    }
  });
});

describe("application submission validation", () => {
  const codes = (input: unknown) => {
    const result = applicationSubmissionSchema.safeParse(input);
    return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".")}:${issue.message}`);
  };

  it("accepts the three examples and applies defaults", () => {
    for (const input of [INDIVIDUAL, CORPORATE, TRUST]) expect(codes(input)).toEqual([]);
    expect(applicationSubmissionSchema.parse(TRUST)).toMatchObject({ channel: "online", classification: "confidential", expectedActivity: [] });
  });

  it("requires a person's date of birth and nationality and refuses entity fields for an individual", () => {
    const { dateOfBirth: _dob, nationality: _nationality, ...customer } = INDIVIDUAL.customer;
    expect(codes({ ...INDIVIDUAL, customer: { ...customer, legalForm: "corporation" } })).toEqual([
      "customer.dateOfBirth:application.date_of_birth_required", "customer.nationality:application.nationality_required",
      "customer.legalForm:application.entity_field_not_applicable",
    ]);
  });

  it("lets an individual declare only relatives and close associates: people, with a relation, no roles and no ownership", () => {
    expect(codes(PEP_FAMILY)).toEqual([]);
    expect(codes({ ...INDIVIDUAL, relatedParties: [{ name: "X", roles: ["beneficial_owner"], ownershipPercent: "10" }, { name: "Y Ltd", kind: "company", relationToCustomer: "close_associate" }] })).toEqual([
      "relatedParties.0.relationToCustomer:application.relation_required", "relatedParties.0.roles:application.roles_not_applicable",
      "relatedParties.0.ownershipPercent:application.ownership_not_applicable", "relatedParties.1.kind:application.relative_must_be_person",
      "relatedParties.0.roles:application.ownership_role_not_applicable", "relatedParties.1.relationToCustomer:application.person_field_not_applicable",
    ]);
    expect(codes({ ...INDIVIDUAL, customer: { ...INDIVIDUAL.customer, pepPosition: "Minister" } })).toEqual(["customer.pepPosition:application.pep_position_without_exposure"]);
  });

  it("still requires a business's or trust's parties to hold a role, and refuses a person's PEP fields on the business itself", () => {
    expect(codes({ ...CORPORATE, relatedParties: [{ name: "Ann", relationToCustomer: "close_associate" }] })).toEqual(["relatedParties.0.roles:application.roles_required"]);
    expect(codes({ ...CORPORATE, customer: { ...CORPORATE.customer, politicallyExposed: "yes" } })).toEqual(["customer.politicallyExposed:application.person_field_not_applicable"]);
    expect(codes({ ...CORPORATE, relatedParties: [{ ...CORPORATE.relatedParties![0]!, politicallyExposed: "yes", pepPosition: "Member of Parliament" }, CORPORATE.relatedParties![1]!] })).toEqual([]);
  });

  it("bounds documents: catalog-shaped type, a file name, base64 content of at most 4 MiB, a known party, no duplicates", () => {
    const document = WITH_DOCUMENT.documents![0]!;
    expect(codes(WITH_DOCUMENT)).toEqual([]);
    expect(codes({ ...WITH_DOCUMENT, documents: [{ ...document, documentType: "Certificate" }] })[0]).toMatch(/^documents\.0\.documentType:/);
    expect(codes({ ...WITH_DOCUMENT, documents: [{ ...document, filename: "../etc/passwd" }] })[0]).toMatch(/^documents\.0\.filename:/);
    expect(codes({ ...WITH_DOCUMENT, documents: [{ ...document, contentBase64: "not base64!" }] })[0]).toMatch(/^documents\.0\.contentBase64:/);
    expect(codes({ ...WITH_DOCUMENT, documents: [{ ...document, contentBase64: "A".repeat(Math.ceil(APPLICATION_DOCUMENT_MAX_BYTES / 3) * 4 + 4) }] })[0]).toMatch(/^documents\.0\.contentBase64:/);
    expect(codes({ ...WITH_DOCUMENT, documents: [{ ...document, relatedParty: 2 }] })).toEqual(["documents.0.relatedParty:application.document_party_unknown"]);
    expect(codes({ ...WITH_DOCUMENT, documents: [document, { ...document, filename: "copy.txt" }] })).toEqual(["documents.1.contentBase64:application.document_duplicate"]);
    expect(codes({ ...WITH_DOCUMENT, documents: Array.from({ length: 6 }, (_, i) => ({ ...document, contentBase64: btoa(`doc ${i}`) })) })[0]).toMatch(/^documents:/);
  });

  it("requires a corporate's legal form and registration, and refuses person fields", () => {
    const { registrationNumber: _number, ...customer } = CORPORATE.customer;
    expect(codes({ ...CORPORATE, customer: { ...customer, legalForm: "ordinary_trust", dateOfBirth: "1980-01-01" } })).toEqual([
      "customer.dateOfBirth:application.person_field_not_applicable", "customer.legalForm:application.legal_form_not_corporate",
      "customer.registrationNumber:application.registration_number_required",
    ]);
  });

  it("requires a trustee for a trust", () => {
    expect(codes({ ...TRUST, relatedParties: TRUST.relatedParties!.slice(1) })).toEqual(["relatedParties:application.trustee_required"]);
  });

  it("refuses ownership over 100%, malformed percentages and activity for a product not applied for", () => {
    const parties = CORPORATE.relatedParties!;
    expect(codes({ ...CORPORATE, relatedParties: [parties[0], { ...parties[1], ownershipPercent: "40.0001" }] })).toEqual(["relatedParties:application.ownership_exceeds_100"]);
    expect(codes({ ...CORPORATE, relatedParties: [{ ...parties[0], ownershipPercent: "0.6" }, parties[1]] })).toEqual([]);
    expect(codes({ ...CORPORATE, relatedParties: [{ ...parties[0], ownershipPercent: "60%" }] })[0]).toMatch(/^relatedParties\.0\.ownershipPercent:/);
    expect(codes({ ...CORPORATE, expectedActivity: [{ product: "lending", currency: "GBP" }] })).toEqual(["expectedActivity.0.product:application.expected_activity_product_not_requested"]);
  });

  it("is strict and bounded", () => {
    expect(codes({ ...CORPORATE, applicant: "x" })[0]).toMatch(/unrecognized/i);
    expect(codes({ ...CORPORATE, customer: { ...CORPORATE.customer, name: "x".repeat(201) } })[0]).toMatch(/^customer\.name:/);
    expect(codes({ ...CORPORATE, scope: { ...CORPORATE.scope, products: ["gold_bars"] } })[0]).toMatch(/^scope\.products\.0:/);
    expect(codes({ ...CORPORATE, scope: { ...CORPORATE.scope, trigger: "event_review" } })).toEqual(["scope.event:application.event_mismatch"]);
    expect(codes({ ...CORPORATE, relatedParties: Array.from({ length: 51 }, (_, i) => ({ name: `P${i}`, roles: ["director"] })) })[0]).toMatch(/^relatedParties:/);
    expect(codes({ ...CORPORATE, expectedActivity: [{ product: "deposit", currency: "GBP", monthlyInflow: "1.5e6" }] })[0]).toMatch(/^expectedActivity\.0\.monthlyInflow:/);
  });
});
