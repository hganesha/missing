import { bankingPolicySchema, bankingRelationshipSchema, controlAssessmentSchema, stableDigest, type BankingPolicy, type BankingRelationship } from "@ehf/contracts";

export type BankingRequirement = {
  id: string; control: string; subjectId: string; productId: string | null;
  basis: "REGULATORY" | "INSTITUTIONAL"; legalBasis: string; alternatives: string[];
};
const AUTHORITY_ROLES = new Set(["signatory", "attorney", "guardian", "trustee", "executor", "protector"]);

/** Frozen compatibility oracle. Services use the OPA implementation. */
export function compileBankingRequirements(rawRelationship: unknown, rawPolicy: unknown) {
  const relationship = bankingRelationshipSchema.parse(rawRelationship);
  const policy = bankingPolicySchema.parse(rawPolicy);
  const gaps: string[] = [];
  const requirements = new Map<string, BankingRequirement>();
  const at = Date.parse(relationship.asOf);
  const active = relationship.parties.filter((p) => (!p.validFrom || Date.parse(p.validFrom) <= at) && (!p.validTo || at < Date.parse(p.validTo)));
  const add = (control: string, subjectId: string, productId: string | null, basis: BankingRequirement["basis"], legalBasis: string) => {
    const id = `req_${stableDigest([control, subjectId, productId]).slice(0, 32)}`;
    const prior = requirements.get(id);
    if (prior) {
      prior.basis = prior.basis === "REGULATORY" || basis === "REGULATORY" ? "REGULATORY" : "INSTITUTIONAL";
      prior.legalBasis = [...new Set([prior.legalBasis, legalBasis])].sort().join("; ");
      return;
    }
    requirements.set(id, { id, control, subjectId, productId, basis, legalBasis, alternatives: policy.documentAlternatives[control] ?? [] });
  };
  if (relationship.policyJurisdiction !== policy.jurisdiction || relationship.bookingJurisdiction !== "US") gaps.push("JURISDICTION_POLICY_UNRESOLVED");
  if (at < Date.parse(policy.effectiveFrom)) gaps.push("POLICY_NOT_EFFECTIVE");
  if (!active.some((p) => p.entityId === relationship.customerEntityId && p.role === "customer")) gaps.push("CUSTOMER_CAPACITY_UNRESOLVED");
  if (relationship.riskTier === "UNKNOWN") gaps.push("RISK_ASSESSMENT_MISSING");
  const customer = relationship.entities.find((e) => e.entityId === relationship.customerEntityId)!;
  add("customer_classification", customer.entityId, null, "REGULATORY", "Resolve customer status, legal form, CIP and CDD applicability under 31 CFR 1020.100 and 1010.230");
  if (customer.legalForm === "unknown") gaps.push("LEGAL_FORM_UNRESOLVED");
  if (customer.legalEntityCustomer === null) gaps.push("LEGAL_ENTITY_APPLICABILITY_UNRESOLVED");
  if (["individual", "sole_proprietor"].includes(customer.legalForm) && customer.legalEntityCustomer === true) gaps.push("LEGAL_ENTITY_APPLICABILITY_CONFLICT");
  for (const party of active) {
    if (["customer", "joint_holder"].includes(party.role)) add("identity", party.entityId, null, "REGULATORY", "31 CFR 1020.220; customer status must be resolved under 1020.100");
    if (["beneficial_owner", "control_person", "trustee", "settlor", "protector", "executor"].includes(party.role)) {
      add("identity", party.entityId, null, "INSTITUTIONAL", "Role-specific identity verification under applicable CDD rules and the approved bank policy");
    }
    if (AUTHORITY_ROLES.has(party.role)) {
      add("authority", party.entityId, null, "INSTITUTIONAL", "Evidenced capacity and scope under the applicable account mandate");
      if (!party.authorityEvidenceRefs.length || !party.authorityScope.length) gaps.push(`AUTHORITY_SCOPE_UNRESOLVED:${party.entityId}`);
    }
    if (policy.screeningRoles.includes(party.role)) {
      for (const control of ["sanctions", "pep", "adverse_media"]) add(control, party.entityId, null, "INSTITUTIONAL", "Risk-based screening scope under the admitted bank policy; sanctions prohibitions remain independent");
    }
  }
  let boReuse = false;
  if (customer.legalEntityCustomer === true && !["individual", "sole_proprietor"].includes(customer.legalForm)) {
    const treatment = relationship.boTreatment;
    const effective = treatment && Date.parse(treatment.validUntil) > at;
    if (treatment && (!effective || treatment.treatment === "UNKNOWN")) gaps.push("BO_TREATMENT_UNRESOLVED");
    const prior = relationship.priorBo;
    boReuse = (relationship.event === "periodic_review" || (policy.accountOpeningReliefAdopted === true && relationship.event === "additional_product"
      && at >= Date.parse("2026-02-13T00:00:00Z"))) && !!prior
      && prior.institutionId === relationship.institutionId && prior.customerEntityId === customer.entityId
      && Date.parse(prior.verifiedAt) <= at && !prior.reliabilityQuestioned && !prior.refreshRequired;
    if (!boReuse && (!effective || treatment!.treatment !== "EXCLUDED")) {
      if (!effective || treatment!.treatment !== "CONTROL_ONLY") {
        add("beneficial_ownership", customer.entityId, null, "REGULATORY", "31 CFR 1010.230 ownership prong and applicable trust treatment");
        if (relationship.ownershipComplete !== true) gaps.push("OWNERSHIP_INCOMPLETE");
      }
      add("control_person", customer.entityId, null, "REGULATORY", "31 CFR 1010.230 control prong");
    }
  } else if (["ordinary_trust", "estate", "association", "pension", "government"].includes(customer.legalForm)) {
    add("structure_and_capacity", customer.entityId, null, "INSTITUTIONAL", "Determine legal customer, governing instrument, relevant parties and any applicable exemption");
  }
  add("relationship_purpose", customer.entityId, null, "REGULATORY", "31 CFR 1020.210(b)(5)");
  add("customer_risk", customer.entityId, null, "REGULATORY", "31 CFR 1020.210(b)(5); evidenced customer risk profile");
  add("provider_qualification", customer.entityId, null, "INSTITUTIONAL", "Approved operation contracts, jurisdiction coverage, entitlements and source qualification");
  if (relationship.riskTier === "HIGH") add("edd", customer.entityId, null, "INSTITUTIONAL", "Approved risk-based enhanced due diligence scope and acceptance authority");
  for (const product of relationship.products) {
    add("expected_activity", customer.entityId, product.productId, "INSTITUTIONAL", "Product-specific activity profile, currencies, counterparties, payment rails and cash exposure");
    // Product controls are keyed by today's product types; a product known only by its canonical id has none here.
    for (const control of product.productType ? policy.productControls[product.productType] : []) add(control, customer.entityId, product.productId, "INSTITUTIONAL", "Approved product-specific controls");
    add("monitoring_handoff", customer.entityId, product.productId, "REGULATORY", "31 CFR 1020.210(b)(5); durable ongoing-monitoring responsibility");
  }
  return { relationship, policy, policyDigest: stableDigest(policy), boReuse, gaps: [...new Set(gaps)].sort(), requirements: [...requirements.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
}

/** A recommendation only. No assessment, exemption, or result authorizes a case command. */
export function assessBankingRelationship(relationship: BankingRelationship, policy: BankingPolicy, rawAssessments: unknown[]) {
  const compiled = compileBankingRequirements(relationship, policy);
  const assessments = rawAssessments.map((a) => controlAssessmentSchema.parse(a));
  const { asOf: _asOf, ...relationshipBasis } = compiled.relationship;
  const relationshipDigest = stableDigest(relationshipBasis);
  const at = Date.parse(compiled.relationship.asOf);
  const controls = compiled.requirements.map((requirement) => {
    const candidates = assessments.filter((a) => a.requirementId === requirement.id && a.subjectId === requirement.subjectId && a.productId === requirement.productId
      && a.policyId === policy.id && a.policyVersion === policy.version && a.policyDigest === compiled.policyDigest
      && a.relationshipDigest === relationshipDigest
      && Date.parse(a.assessedAt) <= at && Date.parse(a.validUntil) > at);
    // Conflicting/current duplicate determinations require reconciliation, not last-write-wins.
    return { requirement, outcome: candidates.length === 1 ? candidates[0]!.outcome : "UNKNOWN", assessmentIds: candidates.map((a) => a.assessmentId) };
  });
  const products = relationship.products.map((product) => {
    const applicable = controls.filter((c) => c.requirement.productId === null || c.requirement.productId === product.productId);
    const gaps = [...compiled.gaps, ...applicable.filter((c) => c.outcome !== "SATISFIED").map((c) => c.requirement.id)];
    if (product.expectedActivity === null) gaps.push(`EXPECTED_ACTIVITY_UNRESOLVED:${product.productId}`);
    if (policy.status !== "APPROVED") gaps.push("POLICY_NOT_APPROVED");
    return { productId: product.productId, recommendation: gaps.length ? "REVIEW" : "READY_FOR_AUTHORIZED_DECISION", gaps: [...new Set(gaps)].sort() };
  });
  return { policyDigest: compiled.policyDigest, relationshipDigest, boReuse: compiled.boReuse, controls, products, finalAcceptance: false as const };
}
