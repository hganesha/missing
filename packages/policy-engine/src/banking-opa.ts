import { z } from "zod";
import { bankingPolicySchema, bankingRelationshipSchema, controlAssessmentSchema, stableDigest } from "@ehf/contracts";
import { evaluateOpaModule, opaModuleBundle } from "./opa-module.js";
import type { BankingRequirement } from "./banking.js";

// Frozen US banking v1 applicability module. New installations author their business-v2
// applicability in their released policy source, without these legacy scope literals.
const rego=String.raw`package harness.banking
import rego.v1
r:=input.relationship
p:=input.policy
at:=time.parse_rfc3339_ns(r.asOf)
customer:=[e|some e in r.entities;e.entityId==r.customerEntityId][0]
starts(party) if {party.validFrom==null}
starts(party) if {time.parse_rfc3339_ns(party.validFrom)<=at}
ends(party) if {party.validTo==null}
ends(party) if {at<time.parse_rfc3339_ns(party.validTo)}
active:=[party|some party in r.parties;starts(party);ends(party)]
authority_roles:={"signatory","attorney","guardian","trustee","executor","protector"}
identity_roles:={"beneficial_owner","control_person","trustee","settlor","protector","executor"}
notes:={
 "customer_classification":"Resolve customer status, legal form, CIP and CDD applicability under 31 CFR 1020.100 and 1010.230",
 "identity_regulatory":"31 CFR 1020.220; customer status must be resolved under 1020.100",
 "identity_institutional":"Role-specific identity verification under applicable CDD rules and the approved bank policy",
 "authority":"Evidenced capacity and scope under the applicable account mandate",
 "screening":"Risk-based screening scope under the admitted bank policy; sanctions prohibitions remain independent",
 "beneficial_ownership":"31 CFR 1010.230 ownership prong and applicable trust treatment",
 "control_person":"31 CFR 1010.230 control prong",
 "structure_and_capacity":"Determine legal customer, governing instrument, relevant parties and any applicable exemption",
 "relationship_purpose":"31 CFR 1020.210(b)(5)",
 "customer_risk":"31 CFR 1020.210(b)(5); evidenced customer risk profile",
 "provider_qualification":"Approved operation contracts, jurisdiction coverage, entitlements and source qualification",
 "edd":"Approved risk-based enhanced due diligence scope and acceptance authority",
 "expected_activity":"Product-specific activity profile, currencies, counterparties, payment rails and cash exposure",
 "product":"Approved product-specific controls",
 "monitoring_handoff":"31 CFR 1020.210(b)(5); durable ongoing-monitoring responsibility"}
entry(control,subject,product,basis,note):={"control":control,"subjectId":subject,"productId":product,"basis":basis,"legalBasis":notes[note]}
raw_requirements contains entry("customer_classification",customer.entityId,null,"REGULATORY","customer_classification")
raw_requirements contains entry("identity",party.entityId,null,"REGULATORY","identity_regulatory") if {some party in active;party.role in {"customer","joint_holder"}}
raw_requirements contains entry("identity",party.entityId,null,"INSTITUTIONAL","identity_institutional") if {some party in active;party.role in identity_roles}
raw_requirements contains entry("authority",party.entityId,null,"INSTITUTIONAL","authority") if {some party in active;party.role in authority_roles}
raw_requirements contains entry(control,party.entityId,null,"INSTITUTIONAL","screening") if {some party in active;party.role in p.screeningRoles;some control in ["sanctions","pep","adverse_media"]}
corporate if {customer.legalEntityCustomer==true;not customer.legalForm in {"individual","sole_proprietor"}}
treatment_effective if {r.boTreatment!=null;time.parse_rfc3339_ns(r.boTreatment.validUntil)>at}
reuse_event if {r.event=="periodic_review"}
reuse_event if {p.accountOpeningReliefAdopted==true;r.event=="additional_product";at>=time.parse_rfc3339_ns("2026-02-13T00:00:00Z")}
default bo_reuse:=false
bo_reuse:=true if {corporate;reuse_event;r.priorBo!=null;r.priorBo.institutionId==r.institutionId;
 r.priorBo.customerEntityId==customer.entityId;time.parse_rfc3339_ns(r.priorBo.verifiedAt)<=at;
 not r.priorBo.reliabilityQuestioned;not r.priorBo.refreshRequired}
excluded if {treatment_effective;r.boTreatment.treatment=="EXCLUDED"}
control_only if {treatment_effective;r.boTreatment.treatment=="CONTROL_ONLY"}
raw_requirements contains entry("beneficial_ownership",customer.entityId,null,"REGULATORY","beneficial_ownership") if {corporate;not bo_reuse;not excluded;not control_only}
raw_requirements contains entry("control_person",customer.entityId,null,"REGULATORY","control_person") if {corporate;not bo_reuse;not excluded}
raw_requirements contains entry("structure_and_capacity",customer.entityId,null,"INSTITUTIONAL","structure_and_capacity") if {not corporate;customer.legalForm in {"ordinary_trust","estate","association","pension","government"}}
raw_requirements contains entry("relationship_purpose",customer.entityId,null,"REGULATORY","relationship_purpose")
raw_requirements contains entry("customer_risk",customer.entityId,null,"REGULATORY","customer_risk")
raw_requirements contains entry("provider_qualification",customer.entityId,null,"INSTITUTIONAL","provider_qualification")
raw_requirements contains entry("edd",customer.entityId,null,"INSTITUTIONAL","edd") if {r.riskTier=="HIGH"}
raw_requirements contains entry("expected_activity",customer.entityId,product.productId,"INSTITUTIONAL","expected_activity") if {some product in r.products}
raw_requirements contains entry(control,customer.entityId,product.productId,"INSTITUTIONAL","product") if {some product in r.products;some control in p.productControls[product.productType]}
raw_requirements contains entry("monitoring_handoff",customer.entityId,product.productId,"REGULATORY","monitoring_handoff") if {some product in r.products}
key(q):=[q.control,q.subjectId,q.productId]
keys:={key(q)|some q in raw_requirements}
basis(k):="REGULATORY" if {some q in raw_requirements;key(q)==k;q.basis=="REGULATORY"}
default basis(_):="INSTITUTIONAL"
requirement(k):={"id":concat("",["req_",substring(crypto.sha256(json.marshal(k)),0,32)]),"control":k[0],"subjectId":k[1],"productId":k[2],
 "basis":basis(k),"legalBasis":concat("; ",sort({q.legalBasis|some q in raw_requirements;key(q)==k})),"alternatives":object.get(p.documentAlternatives,k[0],[])}
by_id:={q.id:q|some k in keys;q:=requirement(k)}
requirements:=[by_id[id]|some id in sort(object.keys(by_id))]
gap_set contains "JURISDICTION_POLICY_UNRESOLVED" if {r.policyJurisdiction!=p.jurisdiction}
gap_set contains "JURISDICTION_POLICY_UNRESOLVED" if {r.bookingJurisdiction!="US"}
gap_set contains "POLICY_NOT_EFFECTIVE" if {at<time.parse_rfc3339_ns(p.effectiveFrom)}
customer_capacity if {some party in active;party.entityId==r.customerEntityId;party.role=="customer"}
gap_set contains "CUSTOMER_CAPACITY_UNRESOLVED" if {not customer_capacity}
gap_set contains "RISK_ASSESSMENT_MISSING" if {r.riskTier=="UNKNOWN"}
gap_set contains "LEGAL_FORM_UNRESOLVED" if {customer.legalForm=="unknown"}
gap_set contains "LEGAL_ENTITY_APPLICABILITY_UNRESOLVED" if {customer.legalEntityCustomer==null}
gap_set contains "LEGAL_ENTITY_APPLICABILITY_CONFLICT" if {customer.legalForm in {"individual","sole_proprietor"};customer.legalEntityCustomer==true}
gap_set contains concat("",["AUTHORITY_SCOPE_UNRESOLVED:",party.entityId]) if {some party in active;party.role in authority_roles;count(party.authorityEvidenceRefs)==0}
gap_set contains concat("",["AUTHORITY_SCOPE_UNRESOLVED:",party.entityId]) if {some party in active;party.role in authority_roles;count(party.authorityScope)==0}
gap_set contains "BO_TREATMENT_UNRESOLVED" if {corporate;r.boTreatment!=null;not treatment_effective}
gap_set contains "BO_TREATMENT_UNRESOLVED" if {corporate;r.boTreatment!=null;r.boTreatment.treatment=="UNKNOWN"}
gap_set contains "OWNERSHIP_INCOMPLETE" if {corporate;not bo_reuse;not excluded;not control_only;r.ownershipComplete!=true}
candidates(q):=[a|some a in input.assessments;a.requirementId==q.id;a.subjectId==q.subjectId;a.productId==q.productId;
 a.policyId==p.id;a.policyVersion==p.version;a.policyDigest==input.policyDigest;a.relationshipDigest==input.relationshipDigest;
 time.parse_rfc3339_ns(a.assessedAt)<=at;time.parse_rfc3339_ns(a.validUntil)>at]
control_outcome(q):=candidates(q)[0].outcome if {count(candidates(q))==1}
default control_outcome(_):="UNKNOWN"
controls:=[{"requirement":q,"outcome":control_outcome(q),"assessmentIds":[a.assessmentId|some a in candidates(q)]}|some q in requirements]
applies(q,_) if {q.productId==null}
applies(q,product) if {q.productId==product.productId}
product_gaps(product):=union({gap_set,
 {control.requirement.id|some control in controls;applies(control.requirement,product);control.outcome!="SATISFIED"},
 {concat("",["EXPECTED_ACTIVITY_UNRESOLVED:",product.productId])|product.expectedActivity==null},
 {"POLICY_NOT_APPROVED"|p.status!="APPROVED"}})
recommendation(product):="READY_FOR_AUTHORIZED_DECISION" if {count(product_gaps(product))==0}
default recommendation(_):="REVIEW"
compiled:={"boReuse":bo_reuse,"gaps":sort(gap_set),"requirements":requirements}
assessment:={"policyDigest":input.policyDigest,"relationshipDigest":input.relationshipDigest,"boReuse":bo_reuse,"controls":controls,
 "products":[{"productId":product.productId,"recommendation":recommendation(product),"gaps":sort(product_gaps(product))}|some product in r.products],"finalAcceptance":false}
`;
export const BANKING_OPA_BUNDLE=opaModuleBundle("harness/banking/policy.rego",rego);
const compiledResult=z.object({boReuse:z.boolean(),gaps:z.array(z.string()),requirements:z.array(z.object({
  id:z.string(),control:z.string(),subjectId:z.string(),productId:z.string().nullable(),basis:z.enum(["REGULATORY","INSTITUTIONAL"]),legalBasis:z.string(),alternatives:z.array(z.string()),
}).strict())}).strict();
const assessmentResult=z.object({policyDigest:z.string(),relationshipDigest:z.string(),boReuse:z.boolean(),finalAcceptance:z.literal(false),
  controls:z.array(z.object({requirement:compiledResult.shape.requirements.element,outcome:z.enum(["SATISFIED","FAILED","UNKNOWN"]),assessmentIds:z.array(z.string())}).strict()),
  products:z.array(z.object({productId:z.string(),recommendation:z.enum(["REVIEW","READY_FOR_AUTHORIZED_DECISION"]),gaps:z.array(z.string())}).strict())}).strict();
function input(rawRelationship:unknown,rawPolicy:unknown,assessments:unknown[]) {
  const relationship=bankingRelationshipSchema.parse(rawRelationship),policy=bankingPolicySchema.parse(rawPolicy);
  const {asOf:_at,...basis}=relationship;
  return {relationship,policy,assessments:assessments.map(a=>controlAssessmentSchema.parse(a)),policyDigest:stableDigest(policy),relationshipDigest:stableDigest(basis)};
}
export async function compileBankingRequirementsWithOpa(rawRelationship:unknown,rawPolicy:unknown) {
  const data=input(rawRelationship,rawPolicy,[]);
  const compiled=compiledResult.parse(await evaluateOpaModule(BANKING_OPA_BUNDLE,"data.harness.banking.compiled",data));
  return {...compiled,relationship:data.relationship,policy:data.policy,policyDigest:data.policyDigest,requirements:compiled.requirements as BankingRequirement[]};
}
export async function assessBankingRelationshipWithOpa(rawRelationship:unknown,rawPolicy:unknown,assessments:unknown[]) {
  return assessmentResult.parse(await evaluateOpaModule(BANKING_OPA_BUNDLE,"data.harness.banking.assessment",input(rawRelationship,rawPolicy,assessments)));
}
