import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bankingPolicySchema, bankingRelationshipSchema, stableDigest } from "@ehf/contracts";
import { assessBankingRelationship, compileBankingRequirements } from "./banking.js";

const policy = bankingPolicySchema.parse(JSON.parse(readFileSync(new URL("../../../domains/fincrime/banking-policy.json", import.meta.url), "utf8")));
const relationship = () => bankingRelationshipSchema.parse({
  relationshipId: "R1", institutionId: "bank-a", bookingJurisdiction: "US", policyJurisdiction: "US", customerEntityId: "C1",
  event: "onboarding", asOf: "2026-11-08T12:00:00Z", entities: [{ entityId: "C1", name: "Example", legalForm: "llc", legalEntityCustomer: true, formationJurisdiction: "US" }],
  parties: [{ entityId: "C1", role: "customer", validFrom: null, validTo: null, authorityEvidenceRefs: [] }],
  products: [{ productId: "P1", productType: "deposit", currencies: ["USD"], countries: ["US"], channels: ["branch"],
    expectedActivity: { monthlyInflow: "1000", monthlyOutflow: "900", currency: "USD", transactionCount: 10, cashExposure: false,
      counterpartyCountries: ["US"], counterpartyTypes: ["employer"], paymentRails: ["ACH"] } }],
  riskTier: "LOW", ownershipComplete: true, boTreatment: null, priorBo: null,
});

describe("banking obligation applicability and product readiness", () => {
  it("does not apply legal-entity beneficial ownership to a sole proprietor", () => {
    const r = relationship(); r.entities[0]!.legalForm = "sole_proprietor"; r.entities[0]!.legalEntityCustomer = false;
    const compiled = compileBankingRequirements(r, policy);
    expect(compiled.requirements.map((q) => q.control)).not.toContain("beneficial_ownership");
    expect(compiled.requirements.map((q) => q.control)).toContain("identity");
  });
  it("requires both ownership and control determinations for an ordinary LLC", () => {
    expect(compileBankingRequirements(relationship(), policy).requirements.map((q) => q.control)).toEqual(expect.arrayContaining(["beneficial_ownership", "control_person"]));
  });
  it.each(["ordinary_trust", "estate", "association", "pension", "government"] as const)("requires legal capacity for %s without inferring a corporate ownership prong", (legalForm) => {
    const r = relationship(); r.entities[0]!.legalForm = legalForm; r.entities[0]!.legalEntityCustomer = false;
    const controls = compileBankingRequirements(r, policy).requirements.map((q) => q.control);
    expect(controls).toContain("structure_and_capacity"); expect(controls).not.toContain("beneficial_ownership");
  });
  it("supports evidenced control-only treatment without waiving other CDD", () => {
    const r = relationship(); r.boTreatment = { treatment: "CONTROL_ONLY", legalBasis: "qualified exemption", evidenceRefs: ["ev-1@v1"], determinedBy: "reviewer", validUntil: "2027-01-01T00:00:00Z" };
    const controls = compileBankingRequirements(r, policy).requirements.map((q) => q.control);
    expect(controls).not.toContain("beneficial_ownership"); expect(controls).toContain("control_person"); expect(controls).toContain("sanctions");
  });
  it("uses relief only for a reliable same-institution relationship after adoption", () => {
    const r = relationship(); r.event = "additional_product";
    r.priorBo = { institutionId: "bank-a", customerEntityId: "C1", evidenceRefs: ["ev-bo@v1"], verifiedAt: "2026-04-01T00:00:00Z", reliabilityQuestioned: false, refreshRequired: false };
    expect(compileBankingRequirements(r, policy).boReuse).toBe(false);
    const adopted = { ...policy, accountOpeningReliefAdopted: true };
    expect(compileBankingRequirements(r, adopted).boReuse).toBe(true);
    r.priorBo.institutionId = "other-bank";
    expect(compileBankingRequirements(r, adopted).boReuse).toBe(false);
    r.priorBo.institutionId = "bank-a"; r.priorBo.reliabilityQuestioned = true;
    expect(compileBankingRequirements(r, adopted).boReuse).toBe(false);
    r.priorBo.reliabilityQuestioned = false; r.event = "ownership_change";
    expect(compileBankingRequirements(r, adopted).boReuse).toBe(false);
  });
  it.each(Object.keys(policy.productControls))("compiles distinct controls for %s", (productType) => {
    const r = relationship(); r.products[0]!.productType = productType as typeof r.products[number]["productType"];
    const controls = compileBankingRequirements(r, policy).requirements.map((q) => q.control);
    expect(controls).toEqual(expect.arrayContaining([...policy.productControls[r.products[0]!.productType!], "monitoring_handoff"]));
  });
  it("scopes authority and screening to each active related party", () => {
    const r = relationship(); r.entities.push({ entityId: "T1", name: "Trustee", legalForm: "individual", legalEntityCustomer: false, formationJurisdiction: null });
    r.parties.push({ entityId: "T1", role: "trustee", validFrom: null, validTo: null, authorityEvidenceRefs: [], authorityScope: [] });
    const controls = compileBankingRequirements(r, policy).requirements.filter((q) => q.subjectId === "T1").map((q) => q.control);
    expect(controls).toEqual(expect.arrayContaining(["authority", "sanctions", "pep", "adverse_media"]));
  });
  it("binds control satisfaction to subject, product, policy and validity; preserves human authority", () => {
    const r = relationship(), approved = { ...policy, status: "APPROVED" as const };
    const compiled = compileBankingRequirements(r, approved);
    const { asOf: _asOf, ...basis } = r;
    const assessments = compiled.requirements.map((q) => ({ assessmentId: q.id, requirementId: q.id, subjectId: q.subjectId, productId: q.productId,
      policyId: approved.id, policyVersion: approved.version, policyDigest: stableDigest(approved), relationshipDigest: stableDigest(basis), outcome: "SATISFIED", evidenceRefs: ["ev@v1"],
      assessedBy: "reviewer", authority: "HUMAN", assessedAt: "2026-11-08T00:00:00Z", validUntil: "2026-12-01T00:00:00Z" }));
    expect(assessBankingRelationship(r, approved, assessments)).toMatchObject({ finalAcceptance: false, products: [{ recommendation: "READY_FOR_AUTHORIZED_DECISION" }] });
    assessments[0]!.subjectId = "wrong";
    expect(assessBankingRelationship(r, approved, assessments).products[0]!.recommendation).toBe("REVIEW");
    assessments[0]!.subjectId = "C1";
    r.products[0]!.countries.push("GB");
    expect(assessBankingRelationship(r, approved, assessments).products[0]!.recommendation).toBe("REVIEW");
  });
  it("never promotes a candidate or unresolved cross-border policy", () => {
    const r = relationship(); r.bookingJurisdiction = "GB";
    const result = assessBankingRelationship(r, policy, []);
    expect(result.products[0]!.gaps).toEqual(expect.arrayContaining(["JURISDICTION_POLICY_UNRESOLVED", "POLICY_NOT_APPROVED"]));
  });
});
