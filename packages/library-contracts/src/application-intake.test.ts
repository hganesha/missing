import { mapApplicationSubmission, type ApplicationSubmissionInput } from "@ehf/contracts";
import { describe, expect, it } from "vitest";
import { validateRecordData } from "./index.js";

// Application intake records are read by the library's skills: every one must satisfy the closed
// context contract (library types) or the platform record schema (Application, BankingRelationship).
const SUBMISSIONS: Record<string, ApplicationSubmissionInput> = {
  individual: {
    scope: { customerType: "individual", trigger: "onboarding", jurisdiction: "US", products: ["deposit"] },
    customer: { name: "Dana Reyes", dateOfBirth: "1990-06-30", nationality: "US", politicallyExposed: "yes", pepPosition: "State senator", identifiers: [{ type: "passport", issuer: "US", value: "SPECIMEN-9" }],
      addresses: [{ lines: ["1 Main St", "Apt 2"], locality: "Austin", region: "TX", postalCode: "78701", country: "US" }] },
    relatedParties: [
      { name: "Lee Reyes", relationToCustomer: "spouse", politicallyExposed: "no", nationality: "US" },
      { name: "Kim Reyes", relationToCustomer: "sibling", politicallyExposed: "yes", pepPosition: "Ambassador", dateOfBirth: "1988-01-01" },
    ],
    expectedActivity: [{ product: "deposit", currency: "USD", monthlyInflow: "5000.50" }],
    sourceOfFunds: "Employment income",
    documents: [{ documentType: "passport", filename: "passport.pdf", mediaType: "application/pdf", contentBase64: "JVBERi0xLjQK", relatedParty: 1 }],
  },
  corporate: {
    scope: { customerType: "corporate", trigger: "event_review", event: "ownership_change", jurisdiction: "GB", products: ["deposit", "payments"] },
    customer: { name: "Acme Widgets Ltd", legalForm: "llc", registrationNumber: "01234567", registrationJurisdiction: "GB", registrationAuthority: "Companies House", industry: "manufacturing",
      addresses: [{ lines: ["2 Dock Road"], country: "GB" }] },
    relatedParties: [
      { name: "Sam Owner", roles: ["beneficial_owner", "director"], ownershipPercent: "75", politicallyExposed: "yes", pepPosition: "Councillor", dateOfBirth: "1970-01-01", nationality: "GB",
        identifiers: [{ type: "national_id", issuer: "GB", value: "QQ123456C" }], addresses: [{ lines: ["3 High St"], country: "GB" }] },
      { name: "Holdco SARL", kind: "company", roles: ["beneficial_owner"], ownershipPercent: "25", legalForm: "corporation", registrationNumber: "B-998", registrationJurisdiction: "LU" },
    ],
    expectedActivity: [{ product: "payments", currency: "EUR", monthlyOutflow: "12000", counterpartyCountries: ["LU", "FR"] }],
    sourceOfFunds: "Trading revenue", synthetic: true,
    documents: [{ documentType: "certificate_of_incorporation", filename: "certificate.txt", mediaType: "text/plain", contentBase64: "Q0VSVElGSUNBVEU=" }],
  },
  trust: {
    scope: { customerType: "trust", trigger: "onboarding", jurisdiction: "GB", products: ["deposit"] },
    customer: { name: "Willow Trust" },
    relatedParties: [
      { name: "Ann Trustee", roles: ["trustee"], nationality: "GB", politicallyExposed: "yes" }, { name: "Bob Settlor", roles: ["settlor"] },
      { name: "Cara Beneficiary", roles: ["beneficiary", "protector"], ownershipPercent: "50" },
    ],
  },
};

// The newer record types each submission must produce (and so have validated above).
const EXPECTED: Record<string, string[]> = {
  individual: ["PEPRelationship", "DocumentVersion", "Identity"],
  corporate: ["Registration", "PEPRelationship", "DocumentVersion", "OwnershipInterest", "OfficerRole"],
  trust: ["PEPRelationship", "OfficerRole", "OwnershipInterest"],
};

describe("application intake records", () => {
  for (const [name, submission] of Object.entries(SUBMISSIONS)) {
    it(`conform to the library and platform record contracts (${name})`, () => {
      const documents = (submission.documents ?? []).map((_, index) => ({ evidenceId: `evidence_${index}`, artifactRef: `artifact://postgres/tenant/${"a".repeat(63)}${index}`, sha256: `${"a".repeat(63)}${index}` }));
      const { records } = mapApplicationSubmission(submission, { tenantId: "tenant", observedAt: "2026-11-11T00:00:00Z", documents });
      const failures = records.map((record) => ({ type: record.object_type, id: record.object_id, ...validateRecordData(record.object_type, record.data) }))
        .filter((result) => !result.valid);
      expect(failures).toEqual([]);
      expect(new Set(records.map((record) => validateRecordData(record.object_type, record.data).contract))).toEqual(new Set(["library", "platform"]));
      const produced = new Set(records.map((record) => record.object_type));
      for (const type of EXPECTED[name]!) expect(produced, type).toContain(type);
    });
  }
});
