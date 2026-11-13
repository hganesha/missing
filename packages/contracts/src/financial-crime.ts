import { z } from "zod";
import { PARTY_PRODUCT_ROLES, productIdSchema } from "./products.js";

const id = z.string().min(1);
const time = z.iso.datetime({ offset: true });
export const partyRoleSchema = z.enum(["customer", "joint_holder", "beneficial_owner", "control_person", "director", "signatory", "attorney", "guardian", "settlor", "trustee", "protector", "beneficiary", "executor", "intermediary", "underlying_client", "guarantor"]);
export const bankingProductSchema = z.enum(["deposit", "card", "payments", "lending", "trade_finance", "merchant_acquiring", "private_banking", "correspondent", "fbo", "digital_assets", "custody"]);
export const legalFormSchema = z.enum(["individual", "sole_proprietor", "corporation", "llc", "general_partnership", "limited_partnership", "ordinary_trust", "statutory_trust", "estate", "foundation", "association", "charity", "fund", "pension", "government", "unknown"]);

/** Legal identity, legal capacity, product access and control outcomes remain separate. */
export const bankingRelationshipSchema = z.object({
  relationshipId: id,
  institutionId: id,
  bookingJurisdiction: id,
  policyJurisdiction: id,
  customerEntityId: id,
  event: z.enum(["onboarding", "additional_product", "periodic_review", "ownership_change", "authority_change", "risk_change", "exit"]),
  asOf: time,
  entities: z.array(z.object({ entityId: id, name: id, legalForm: legalFormSchema, legalEntityCustomer: z.boolean().nullable().default(null), formationJurisdiction: id.nullable() }).strict()).min(1).max(200),
  parties: z.array(z.object({
    entityId: id, role: partyRoleSchema, validFrom: time.nullable(), validTo: time.nullable(),
    authorityEvidenceRefs: z.array(id), authorityScope: z.array(id).default([]),
  }).strict()).min(1).max(500),
  products: z.array(z.object({ productId: id,
    /** Today's banking product type. Optional since products resolve through the taxonomy (decision 2): a product names a type, a canonical product or an offering. */
    productType: bankingProductSchema.optional(),
    /** The canonical product (taxonomy id), when the source knows it. */
    canonicalProductId: productIdSchema.optional(),
    /** The institution's own offering (SKU), resolved through its published catalog. */
    offeringId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/).optional(),
    currencies: z.array(id), countries: z.array(id), channels: z.array(id),
    expectedActivity: z.object({
      monthlyInflow: z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/).nullable(),
      monthlyOutflow: z.string().regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/).nullable(),
      currency: id, transactionCount: z.number().int().nonnegative().nullable(), cashExposure: z.boolean().nullable(),
      counterpartyCountries: z.array(id), counterpartyTypes: z.array(id), paymentRails: z.array(id),
    }).strict().nullable().default(null),
  }).strict()).min(1).max(100),
  /**
   * Each party's role in a product, when it is not simply the customer's own product: one party can be
   * the customer for one offering and an underlying investor for another. Absent: every product is the customer's.
   */
  productRoles: z.array(z.object({ entityId: id, productId: id, role: z.enum(PARTY_PRODUCT_ROLES) }).strict()).max(500).optional(),
  riskTier: z.enum(["LOW", "MEDIUM", "HIGH", "UNKNOWN"]),
  ownershipComplete: z.boolean().nullable(),
  // An exemption is an independently evidenced determination, not a customer label.
  boTreatment: z.object({ treatment: z.enum(["FULL", "CONTROL_ONLY", "EXCLUDED", "UNKNOWN"]), legalBasis: id, evidenceRefs: z.array(id).min(1), determinedBy: id, validUntil: time }).strict().nullable(),
  priorBo: z.object({ institutionId: id, customerEntityId: id, evidenceRefs: z.array(id).min(1), verifiedAt: time, reliabilityQuestioned: z.boolean(), refreshRequired: z.boolean() }).strict().nullable(),
}).strict().superRefine((value, ctx) => {
  const entities = new Set(value.entities.map((e) => e.entityId));
  if (entities.size !== value.entities.length || !entities.has(value.customerEntityId)) ctx.addIssue({ code: "custom", message: "Customer and unique entity identities must resolve." });
  if (new Set(value.products.map((p) => p.productId)).size !== value.products.length) ctx.addIssue({ code: "custom", message: "Product identities must be unique." });
  for (const product of value.products) if (!product.productType && !product.canonicalProductId && !product.offeringId) ctx.addIssue({ code: "custom", message: "A product names a productType, a canonicalProductId or an offeringId." });
  const productIds = new Set(value.products.map((p) => p.productId));
  for (const role of value.productRoles ?? []) if (!entities.has(role.entityId) || !productIds.has(role.productId)) ctx.addIssue({ code: "custom", message: "A product role names an unknown entity or product." });
  for (const party of value.parties) {
    if (!entities.has(party.entityId) || (party.validFrom && party.validTo && Date.parse(party.validFrom) >= Date.parse(party.validTo))) ctx.addIssue({ code: "custom", message: "Party identity or validity interval is invalid." });
  }
});

export const controlAssessmentSchema = z.object({
  assessmentId: id, requirementId: id, subjectId: id, productId: id.nullable(),
  policyId: id, policyVersion: id, policyDigest: z.string().regex(/^[a-f0-9]{64}$/),
  relationshipDigest: z.string().regex(/^[a-f0-9]{64}$/),
  outcome: z.enum(["SATISFIED", "FAILED", "UNKNOWN"]),
  evidenceRefs: z.array(id).min(1), assessedBy: id, authority: z.enum(["HUMAN", "SYSTEM"]),
  assessedAt: time, validUntil: time,
}).strict();

export const screeningExecutionSchema = z.object({
  subject: id, screening_type: z.enum(["sanctions", "pep", "watchlist", "adverse_media"]), provider: id,
  query: id, query_time: time, status: z.enum(["COMPLETED", "PARTIAL", "FAILED"]),
  dataset_versions: z.array(id), scope: z.array(id), list_published_at: time.nullable(),
  candidate_count: z.number().int().nonnegative(), truncated: z.boolean(), limitations: z.array(id),
}).strict();

export const bankingPolicySchema = z.object({
  id, version: id, jurisdiction: z.literal("US"), effectiveFrom: time, status: z.enum(["CANDIDATE", "APPROVED"]),
  accountOpeningReliefAdopted: z.boolean().nullable(),
  screeningRoles: z.array(partyRoleSchema).min(1),
  productControls: z.record(bankingProductSchema, z.array(id).min(1)),
  documentAlternatives: z.record(id, z.array(id).min(1)),
  legalSources: z.array(z.string().url()).min(1),
}).strict();

export type BankingRelationship = z.infer<typeof bankingRelationshipSchema>;
export type BankingPolicy = z.infer<typeof bankingPolicySchema>;
export type ControlAssessment = z.infer<typeof controlAssessmentSchema>;
export type ScreeningExecution = z.infer<typeof screeningExecutionSchema>;
export const bankingRelationshipJsonSchema = z.toJSONSchema(bankingRelationshipSchema);
export const controlAssessmentJsonSchema = z.toJSONSchema(controlAssessmentSchema);
