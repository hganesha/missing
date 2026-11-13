import { z } from "zod";
import { bankingProductSchema, bankingRelationshipSchema, legalFormSchema, partyRoleSchema } from "./financial-crime.js";
import type { CanonicalRecordInput } from "./index.js";

/**
 * Application intake (C2, docs/implementation/agentic-onboarding-delivery-plan.md).
 *
 * A submitted application — the case's process scope plus what the applicant declared: the
 * customer, its identifiers and addresses, the related parties of an entity or trust, the
 * expected activity per product and the declared source of funds — and the pure mapping from it
 * to the case's subjects and canonical records (`RecordCanonicalRecords`). Every record is
 * `applicant_supplied`: a declaration, never a verification (identifiers and the source of funds
 * are `verified: false`).
 *
 * Browser-safe on purpose (no node built-ins): the UI mock maps submissions with it too.
 */

const text = (max: number) => z.string().trim().min(1).max(max);
const country = z.string().regex(/^[A-Z]{2}$/, "ISO 3166 alpha-2");
const slug = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
/** A declared amount: an exact decimal string, never a float. */
const amount = z.string().regex(/^(?:0|[1-9][0-9]{0,14})(?:\.[0-9]{1,2})?$/, "decimal amount");
/** An ownership percentage, 0 to 100, as a decimal string ("60", "12.5"). */
const percent = z.string().regex(/^(?:100(?:\.0{1,4})?|[1-9]?[0-9](?:\.[0-9]{1,4})?)$/, "percentage 0-100 as a decimal string");

/** The case's process scope, exactly as the create-case form sends it (control-api caseScopeSchema). */
export const applicationScopeSchema = z.object({
  customerType: z.enum(["individual", "corporate", "trust"]),
  trigger: z.enum(["onboarding", "periodic_review", "event_review"]),
  dueDiligence: z.enum(["simplified", "standard", "enhanced"]).optional(),
  event: z.string().regex(/^[a-z][a-z_]{0,63}$/).optional(),
  jurisdiction: country,
  /** The relationship's products: banking products only, since they become the BankingRelationship's. */
  products: z.array(bankingProductSchema).min(1).max(20),
  institution: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/).max(120).optional(),
}).strict();

export const applicationIdentifierSchema = z.object({
  /** e.g. passport, national_id, drivers_licence, registration_number, lei, tax_id. */
  type: slug,
  /** Who issued it: a country, registry or authority. */
  issuer: text(120),
  value: text(120),
}).strict();

export const applicationAddressSchema = z.object({
  lines: z.array(text(200)).min(1).max(4),
  locality: text(120).optional(),
  region: text(120).optional(),
  postalCode: text(32).optional(),
  country,
}).strict();

const PERSON_FIELDS = ["dateOfBirth", "nationality", "politicallyExposed", "pepPosition", "relationToCustomer"] as const;
const ENTITY_FIELDS = ["legalForm", "registrationNumber", "registrationJurisdiction", "registrationAuthority"] as const;
/** A declared relative or close associate of the customer (the library's PEPRelationship relations). */
export const applicationRelationSchema = z.enum(["spouse", "partner", "parent", "child", "sibling", "other_family", "close_associate"]);
/** A person's declared political exposure: a declaration, never a screening result. */
export const applicationPoliticalExposureSchema = z.enum(["yes", "no", "unknown"]);
/** Ownership is an entity's or trust's: a person's relatives hold no ownership role. */
const OWNERSHIP_ROLES = new Set(["beneficial_owner", "control_person"]);
/** One uploaded document, at most 4 MiB decoded. */
export const APPLICATION_DOCUMENT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_BASE64 = Math.ceil(APPLICATION_DOCUMENT_MAX_BYTES / 3) * 4;
const TRUST_FORMS = ["ordinary_trust", "statutory_trust"] as const;
const NOT_CORPORATE = new Set(["individual", ...TRUST_FORMS, "estate"]);

export const applicationCustomerSchema = z.object({
  name: text(200),
  /** A person: date of birth and nationality. */
  dateOfBirth: z.iso.date().optional(),
  nationality: country.optional(),
  /** An entity or trust: legal form and registration. */
  legalForm: legalFormSchema.optional(),
  registrationNumber: text(64).optional(),
  registrationJurisdiction: country.optional(),
  /** The registry that issued the registration number, when the applicant names it. */
  registrationAuthority: text(120).optional(),
  /** A person only: whether they declare themself politically exposed, and the position. */
  politicallyExposed: applicationPoliticalExposureSchema.optional(),
  pepPosition: text(200).optional(),
  industry: slug.optional(),
  businessPurpose: text(1000).optional(),
  identifiers: z.array(applicationIdentifierSchema).max(10).default([]),
  addresses: z.array(applicationAddressSchema).max(5).default([]),
}).strict();

export const applicationRelatedPartyRoleSchema = partyRoleSchema.exclude(["customer"]);

export const applicationRelatedPartySchema = z.object({
  name: text(200),
  kind: z.enum(["individual", "company", "trust"]).default("individual"),
  /** director, beneficial_owner, trustee, settlor, beneficiary, protector, … (one party may hold several).
   * An entity's or trust's party holds at least one; a person's relative or associate holds none. */
  roles: z.array(applicationRelatedPartyRoleSchema).max(6).default([]),
  /** A person only: how they relate to the customer (a relative or close associate). */
  relationToCustomer: applicationRelationSchema.optional(),
  politicallyExposed: applicationPoliticalExposureSchema.optional(),
  pepPosition: text(200).optional(),
  /** The stated ownership of the customer, in percent. */
  ownershipPercent: percent.optional(),
  dateOfBirth: z.iso.date().optional(),
  nationality: country.optional(),
  legalForm: legalFormSchema.optional(),
  registrationNumber: text(64).optional(),
  registrationJurisdiction: country.optional(),
  registrationAuthority: text(120).optional(),
  identifiers: z.array(applicationIdentifierSchema).max(10).default([]),
  addresses: z.array(applicationAddressSchema).max(5).default([]),
}).strict();

export const applicationDocumentSchema = z.object({
  /** A document field catalog type id (the vocabulary document.classify.catalog classifies into), e.g. certificate_of_incorporation. */
  documentType: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/),
  filename: z.string().min(1).max(255).regex(/^[^/\\\u0000-\u001f]+$/, "a file name, no path"),
  mediaType: z.string().min(1).max(127).regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/),
  contentBase64: z.string().min(4).max(MAX_BASE64).regex(/^[A-Za-z0-9+/]+={0,2}$/, "base64"),
  /** Whom the document is about: a related party's index; absent means the customer. */
  relatedParty: z.number().int().min(0).max(49).optional(),
}).strict();

export const applicationExpectedActivitySchema = z.object({
  product: bankingProductSchema,
  currency: z.string().regex(/^[A-Z]{3}$/, "ISO 4217"),
  monthlyInflow: amount.optional(),
  monthlyOutflow: amount.optional(),
  counterpartyCountries: z.array(country).max(50).default([]),
}).strict();

function issue(ctx: z.RefinementCtx, path: (string | number)[], message: string) {
  ctx.addIssue({ code: "custom", path, message });
}

/** Percent string → integer units of 1/10000 percent (exact; no floats). */
function percentUnits(value: string): number {
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 10_000 + Number(fraction.padEnd(4, "0"));
}

export const applicationSubmissionSchema = z.object({
  scope: applicationScopeSchema,
  customer: applicationCustomerSchema,
  relatedParties: z.array(applicationRelatedPartySchema).max(50).default([]),
  expectedActivity: z.array(applicationExpectedActivitySchema).max(20).default([]),
  /** Documents the applicant supplied; registered as case evidence, untrusted until parsed and reviewed. */
  documents: z.array(applicationDocumentSchema).max(5).default([]),
  /** The declared source of funds (recorded unverified). */
  sourceOfFunds: text(2000).optional(),
  /** Where the application came from (online, branch, mobile, relationship_manager, …). */
  channel: slug.default("online"),
  /** The submitting channel's own reference; also the Application's source id. */
  externalRef: text(200).optional(),
  /** The case's classification, as the create-case form sends it. */
  classification: z.enum(["confidential", "restricted", "internal"]).default("confidential"),
  /** Where the relationship is booked, when it differs from the policy jurisdiction. */
  bookingJurisdiction: country.optional(),
  /** Test and demo data says so; every record then carries `synthetic: true`. */
  synthetic: z.boolean().default(false),
  /** The plan the submitter reviewed; a different selection now is refused (case.plan_selection_changed). */
  harnessPlanDigest: z.string().regex(/^(sha256:)?[a-f0-9]{64}$/).optional(),
}).strict().superRefine((value, ctx) => {
  const { scope, customer, relatedParties } = value;
  if (new Set(scope.products).size !== scope.products.length) issue(ctx, ["scope", "products"], "application.products_duplicate");
  if ((scope.trigger === "event_review") !== (scope.event !== undefined)) issue(ctx, ["scope", "event"], "application.event_mismatch");
  const forbid = (path: (string | number)[], subject: Record<string, unknown>, fields: readonly string[], what: string) => {
    for (const field of fields) if (subject[field] !== undefined) issue(ctx, [...path, field], `application.${what}_field_not_applicable`);
  };
  if (scope.customerType === "individual") {
    if (!customer.dateOfBirth) issue(ctx, ["customer", "dateOfBirth"], "application.date_of_birth_required");
    if (!customer.nationality) issue(ctx, ["customer", "nationality"], "application.nationality_required");
    forbid(["customer"], customer, ENTITY_FIELDS, "entity");
    if (customer.pepPosition && customer.politicallyExposed !== "yes") issue(ctx, ["customer", "pepPosition"], "application.pep_position_without_exposure");
    // A person's related parties are their declared relatives and close associates only.
    relatedParties.forEach((party, index) => {
      if (party.kind !== "individual") issue(ctx, ["relatedParties", index, "kind"], "application.relative_must_be_person");
      if (!party.relationToCustomer) issue(ctx, ["relatedParties", index, "relationToCustomer"], "application.relation_required");
      if (party.roles.length) issue(ctx, ["relatedParties", index, "roles"], "application.roles_not_applicable");
      if (party.ownershipPercent) issue(ctx, ["relatedParties", index, "ownershipPercent"], "application.ownership_not_applicable");
    });
  } else {
    forbid(["customer"], customer, PERSON_FIELDS.filter((field) => field !== "relationToCustomer"), "person");
    relatedParties.forEach((party, index) => {
      if (!party.roles.length) issue(ctx, ["relatedParties", index, "roles"], "application.roles_required");
    });
    if (scope.customerType === "corporate") {
      if (!customer.legalForm) issue(ctx, ["customer", "legalForm"], "application.legal_form_required");
      else if (NOT_CORPORATE.has(customer.legalForm)) issue(ctx, ["customer", "legalForm"], "application.legal_form_not_corporate");
      if (!customer.registrationNumber) issue(ctx, ["customer", "registrationNumber"], "application.registration_number_required");
      if (!customer.registrationJurisdiction) issue(ctx, ["customer", "registrationJurisdiction"], "application.registration_jurisdiction_required");
    } else {
      if (customer.legalForm && !(TRUST_FORMS as readonly string[]).includes(customer.legalForm)) issue(ctx, ["customer", "legalForm"], "application.legal_form_not_trust");
      if (!relatedParties.some((party) => party.roles.includes("trustee"))) issue(ctx, ["relatedParties"], "application.trustee_required");
    }
  }
  relatedParties.forEach((party, index) => {
    if (new Set(party.roles).size !== party.roles.length) issue(ctx, ["relatedParties", index, "roles"], "application.roles_duplicate");
    if (party.kind === "individual") forbid(["relatedParties", index], party, ENTITY_FIELDS, "entity");
    else forbid(["relatedParties", index], party, PERSON_FIELDS, "person");
    if (party.pepPosition && party.politicallyExposed !== "yes") issue(ctx, ["relatedParties", index, "pepPosition"], "application.pep_position_without_exposure");
    if (scope.customerType === "individual" && party.roles.some((role) => OWNERSHIP_ROLES.has(role))) issue(ctx, ["relatedParties", index, "roles"], "application.ownership_role_not_applicable");
  });
  value.documents.forEach((document, index) => {
    if (document.relatedParty !== undefined && document.relatedParty >= relatedParties.length) issue(ctx, ["documents", index, "relatedParty"], "application.document_party_unknown");
    if (value.documents.findIndex((other) => other.contentBase64 === document.contentBase64) !== index) issue(ctx, ["documents", index, "contentBase64"], "application.document_duplicate");
  });
  const owned = relatedParties.reduce((sum, party) => sum + (party.ownershipPercent ? percentUnits(party.ownershipPercent) : 0), 0);
  if (owned > 100 * 10_000) issue(ctx, ["relatedParties"], "application.ownership_exceeds_100");
  const activityProducts = value.expectedActivity.map((activity) => activity.product);
  if (new Set(activityProducts).size !== activityProducts.length) issue(ctx, ["expectedActivity"], "application.expected_activity_duplicate");
  value.expectedActivity.forEach((activity, index) => {
    if (!scope.products.includes(activity.product)) issue(ctx, ["expectedActivity", index, "product"], "application.expected_activity_product_not_requested");
  });
});

export type ApplicationScope = z.infer<typeof applicationScopeSchema>;
export type ApplicationSubmissionInput = z.input<typeof applicationSubmissionSchema>;
export type ApplicationSubmission = z.infer<typeof applicationSubmissionSchema>;

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** The case type and case schema an application opens: KYB for a business or trust, KYC for a person. */
export function applicationCaseType(customerType: ApplicationScope["customerType"]): { caseType: "kyc_onboarding" | "kyb_onboarding"; schemaVersion: "kyc.case.v1" | "kyb.case.v1" } {
  return customerType === "individual" ? { caseType: "kyc_onboarding", schemaVersion: "kyc.case.v1" } : { caseType: "kyb_onboarding", schemaVersion: "kyb.case.v1" };
}

/** A case subject (`AddSubject`), the customer first: the flows read `subjects.0` as the customer. */
export type ApplicationSubject = {
  subjectId: string;
  subjectType: "individual" | "legal_entity";
  displayName: string;
  attributes: Record<string, unknown>;
  identifiers: Array<{ identifierType: string; value: string; source: string }>;
};

export type ApplicationIntake = {
  caseType: "kyc_onboarding" | "kyb_onboarding";
  schemaVersion: "kyc.case.v1" | "kyb.case.v1";
  /** The Application's source id (the external reference, or one derived from the submission). */
  applicationId: string;
  /** sha256 of the parsed submission: the identity of what was applied for. */
  submissionDigest: string;
  customerEntityId: string;
  subjects: ApplicationSubject[];
  /** In dependency order: everything an Application references precedes it. */
  records: CanonicalRecordInput[];
};

export const APPLICATION_INTAKE_NORMALIZER = "application.intake@1";
export const APPLICATION_EXTENSION_NAMESPACE = "ehf.application";
const RECORD_SCHEMA_VERSION = "2.0.0";
const PURPOSES = ["CDD_ONBOARDING"];
const OWNERSHIP_ROLE = "beneficial_owner";
const DAY_MS = 86_400_000;

/** The BankingRelationship event a scope's trigger (and review event) is. */
function relationshipEvent(scope: ApplicationScope): z.infer<typeof bankingRelationshipSchema>["event"] {
  if (scope.trigger !== "event_review") return scope.trigger;
  switch (scope.event) {
    case "ownership_change": case "trust_party_change": return "ownership_change";
    case "authority_change": return "authority_change";
    case "new_product_or_geography": return "additional_product";
    case "account_closure_or_estate": return "exit";
    default: return "risk_change";
  }
}

/** "60" → "0.6", "12.5" → "0.125", "100" → "1": a percent string as a Fraction, exactly. */
export function percentToFraction(value: string): string {
  const [whole, fraction = ""] = value.split(".");
  const digits = whole!.padStart(3, "0");
  const integer = digits.slice(0, -2).replace(/^0+/, "") || "0";
  const decimals = (digits.slice(-2) + fraction).replace(/0+$/, "");
  return decimals ? `${integer}.${decimals}` : integer;
}

function addressLine(address: z.infer<typeof applicationAddressSchema>): string {
  return [...address.lines, address.locality, address.region, address.postalCode, address.country].filter(Boolean).join(", ");
}

type Party = {
  key: string;
  entityId: string;
  name: string;
  kind: "individual" | "company" | "trust";
  roles: string[];
  ownershipPercent?: string;
  relationToCustomer?: z.infer<typeof applicationRelationSchema>;
  politicallyExposed?: z.infer<typeof applicationPoliticalExposureSchema>;
  pepPosition?: string;
  dateOfBirth?: string;
  nationality?: string;
  legalForm?: z.infer<typeof legalFormSchema>;
  registrationNumber?: string;
  registrationJurisdiction?: string;
  registrationAuthority?: string;
  identifiers: Array<z.infer<typeof applicationIdentifierSchema>>;
  addresses: Array<z.infer<typeof applicationAddressSchema>>;
};

/** A document's registration as case evidence (case-api POST /v1/cases/:caseId/documents). */
export type ApplicationDocumentRegistration = { evidenceId: string; artifactRef: string; sha256: string };

/** The submission's identifiers plus, for an entity, its registration number as an identifier. */
function identifiersOf(party: Party): Array<z.infer<typeof applicationIdentifierSchema>> {
  const declared = [...party.identifiers];
  if (party.registrationNumber && !declared.some((identifier) => identifier.value === party.registrationNumber)) {
    declared.push({ type: "registration_number", issuer: party.registrationJurisdiction ?? "unknown", value: party.registrationNumber });
  }
  return declared;
}

function legalFormOf(party: Party): z.infer<typeof legalFormSchema> {
  if (party.kind === "individual") return "individual";
  return party.legalForm ?? (party.kind === "trust" ? "ordinary_trust" : "unknown");
}

/** The entity (and case subject) id of the customer, or of a related party by its index. */
export const applicationPartyEntityId = (relatedParty?: number) => relatedParty === undefined ? "entity.customer" : `entity.party-${relatedParty + 1}`;

/** The document id the case store's uploads and extraction runs use for these bytes. */
export const applicationDocumentId = (sha256: string) => `doc_${sha256.replace(/^sha256:/, "").slice(0, 24)}`;

/**
 * Map a parsed submission to the case's subjects and canonical records. Pure and deterministic:
 * object ids follow the submission's structure and a version id is the digest of its content, so
 * mapping the same submission at the same observation time yields the same versions (a retried
 * submission re-records nothing). A submission with documents needs each one's registration as
 * case evidence (`context.documents`, in submission order): its DocumentVersion cites the stored
 * artifact.
 */
export function mapApplicationSubmission(submission: ApplicationSubmissionInput, context: { tenantId: string; observedAt: string; documents?: readonly ApplicationDocumentRegistration[] }): ApplicationIntake {
  const parsed = applicationSubmissionSchema.parse(submission);
  const { scope, customer } = parsed;
  if (!Number.isFinite(Date.parse(context.observedAt))) throw new Error("application.observed_at_invalid");
  if (parsed.documents.length !== (context.documents?.length ?? 0)) throw new Error("application.document_registration_missing");
  const observedAt = new Date(Date.parse(context.observedAt)).toISOString();
  const submissionDigest = sha256Hex(canonicalJson(parsed));
  const applicationId = parsed.externalRef ?? `application-${submissionDigest.slice(0, 24)}`;
  const individual = scope.customerType === "individual";
  const kind = individual ? "individual" : scope.customerType === "trust" ? "trust" : "company";
  const customerParty: Party = { key: "customer", entityId: applicationPartyEntityId(), name: customer.name, kind, roles: ["customer"], ...pick(customer), identifiers: customer.identifiers, addresses: customer.addresses };
  const related: Party[] = parsed.relatedParties.map((party, index) => ({
    key: `party-${index + 1}`, entityId: applicationPartyEntityId(index), name: party.name, kind: party.kind, roles: [...party.roles],
    ...(party.ownershipPercent ? { ownershipPercent: party.ownershipPercent } : {}),
    ...(party.relationToCustomer ? { relationToCustomer: party.relationToCustomer } : {}),
    ...pick(party), identifiers: party.identifiers, addresses: party.addresses,
  }));
  const parties = [customerParty, ...related];
  const customerId = customerParty.entityId;
  const tenant = context.tenantId;
  const sourceRef = { tenant_id: tenant, object_type: "ApplicationSubmission", object_id: applicationId, version_id: `sha256:${submissionDigest}` };
  const records: CanonicalRecordInput[] = [];
  const add = (objectType: string, objectId: string, data: Record<string, unknown>, subjectIds: string[], classification: "PII" | "CONFIDENTIAL") => {
    const content = { objectType, objectId, data, subjectIds, observedAt, synthetic: parsed.synthetic, sourceRef };
    const versionId = `v-${sha256Hex(canonicalJson(content)).slice(0, 32)}`;
    records.push({
      schema_version: RECORD_SCHEMA_VERSION, object_type: objectType, object_id: objectId, version_id: versionId, data,
      subject_ids: subjectIds, valid_from: null, valid_to: null, observed_at: observedAt, source_refs: [sourceRef],
      provenance: { method: "applicant_supplied", normalizer: APPLICATION_INTAKE_NORMALIZER },
      classification, purposes: [...PURPOSES], synthetic: parsed.synthetic,
    });
    return { tenant_id: tenant, object_type: objectType, object_id: objectId, version_id: versionId };
  };
  const extension = (value: Record<string, unknown>) => {
    const kept = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && !(Array.isArray(item) && item.length === 0)));
    return Object.keys(kept).length ? { extensions: { [APPLICATION_EXTENSION_NAMESPACE]: { schema_version: "1.0.0", value: kept } } } : {};
  };
  const exposure = (party: Party) => ({ politically_exposed: party.politicallyExposed, pep_position: party.pepPosition });

  // Who: an Entity per party, with its identity, identifiers, addresses and registration.
  for (const party of parties) {
    const pii = party.kind === "individual" ? "PII" : "CONFIDENTIAL";
    const identifiers = identifiersOf(party);
    const address = party.addresses[0];
    add("Entity", party.entityId, {
      name: party.name, identifiers: identifiers.map((identifier) => identifier.value),
      entity_type: party.kind === "individual" ? "individual" : party.kind,
      ...(address || party.registrationNumber ? { attributes: { ...(address ? { address: addressLine(address) } : {}), ...(party.registrationNumber ? { registration_id: party.registrationNumber } : {}) } } : {}),
      ...extension({ legal_form: party.kind === "individual" ? undefined : legalFormOf(party), registration_jurisdiction: party.registrationJurisdiction }),
    }, [party.entityId], pii);
    if (party.kind === "individual") {
      add("Identity", `identity.${party.key}`, {
        attributes: { name: party.name, identifiers: identifiers.map((identifier) => identifier.value), ...(party.dateOfBirth ? { date_of_birth: party.dateOfBirth } : {}), ...(parsed.synthetic ? { synthetic: true } : {}) },
        ...extension({ nationality: party.nationality, ...exposure(party) }),
      }, [party.entityId], "PII");
    }
    identifiers.forEach((identifier, index) => add("IdentityIdentifier", `identifier.${party.key}-${index + 1}`, {
      entity_id: party.entityId, issuer: identifier.issuer, value: identifier.value, identifier_type: identifier.type, verified: false,
    }, [party.entityId], pii));
    party.addresses.forEach((entry, index) => add("Address", `address.${party.key}-${index + 1}`, {
      lines: entry.lines, country: entry.country, ...(entry.postalCode ? { postal_code: entry.postalCode } : {}),
      ...(entry.locality ? { locality: entry.locality } : {}), ...(entry.region ? { region: entry.region } : {}), normalized: addressLine(entry),
    }, [party.entityId], pii));
    if (party.kind !== "individual" && party.registrationNumber && party.registrationJurisdiction) {
      // The registry, when the applicant did not name it, stays visibly undeclared.
      add("Registration", `registration.${party.key}`, {
        jurisdiction: party.registrationJurisdiction, authority: party.registrationAuthority ?? "not_declared", registration_id: party.registrationNumber,
      }, [party.entityId], "CONFIDENTIAL");
    }
  }

  // The customer and what it applies for. Party has no political-exposure field: a person's
  // declaration goes in the record's extensions (and on their Identity).
  const partyRef = add("Party", "party.customer", {
    entity_id: customerId, role: "customer", customer_type: scope.customerType,
    profile: { legal_name: customer.name, ...(customer.businessPurpose ? { business_purpose: customer.businessPurpose } : {}) },
    ...(customer.industry ? { industry: customer.industry } : {}),
    ...extension(exposure(customerParty)),
  }, [customerId], individual ? "PII" : "CONFIDENTIAL");
  const productRefs = scope.products.map((product) => add("Product", `product.${product}`, { product_type: product, channel: parsed.channel, active: true }, [customerId], "CONFIDENTIAL"));
  const windowEnd = new Date(Date.parse(observedAt) + 365 * DAY_MS).toISOString();
  for (const activity of parsed.expectedActivity) {
    const monthly = activity.monthlyInflow ?? activity.monthlyOutflow;
    add("ExpectedActivity", `expected-activity.${activity.product}`, {
      declared: { currency: activity.currency, ...(monthly ? { monthly_amount: monthly } : {}) },
      window: { start: observedAt, end: windowEnd }, behavior_category: "declared",
      ...extension({ product: activity.product, monthly_inflow: activity.monthlyInflow, monthly_outflow: activity.monthlyOutflow, counterparty_countries: activity.counterpartyCountries }),
    }, [customerId], "CONFIDENTIAL");
  }
  const booking = parsed.bookingJurisdiction ?? scope.jurisdiction;
  const relationship = bankingRelationshipSchema.parse({
    relationshipId: `relationship.${applicationId}`, institutionId: scope.institution ?? "bank.synthetic",
    bookingJurisdiction: booking, policyJurisdiction: scope.jurisdiction, customerEntityId: customerId,
    event: relationshipEvent(scope), asOf: observedAt,
    entities: parties.map((party) => ({ entityId: party.entityId, name: party.name, legalForm: legalFormOf(party), legalEntityCustomer: party === customerParty ? !individual : null, formationJurisdiction: party.kind === "individual" ? null : party.registrationJurisdiction ?? null })),
    parties: parties.flatMap((party) => party.roles.map((role) => ({ entityId: party.entityId, role, validFrom: null, validTo: null, authorityEvidenceRefs: [], authorityScope: [] }))),
    products: scope.products.map((product) => {
      const activity = parsed.expectedActivity.find((entry) => entry.product === product);
      return {
        productId: `product.${product}`, productType: product, currencies: activity ? [activity.currency] : [], countries: [booking], channels: [parsed.channel],
        expectedActivity: activity ? {
          monthlyInflow: activity.monthlyInflow ?? null, monthlyOutflow: activity.monthlyOutflow ?? null, currency: activity.currency,
          transactionCount: null, cashExposure: null, counterpartyCountries: activity.counterpartyCountries, counterpartyTypes: [], paymentRails: [],
        } : null,
      };
    }),
    // Nothing here is established yet: the applicant declared it.
    riskTier: "UNKNOWN", ownershipComplete: null, boTreatment: null, priorBo: null,
  });
  add("BankingRelationship", "banking-relationship", relationship as unknown as Record<string, unknown>, [customerId], "CONFIDENTIAL");

  // How the related parties stand to the customer.
  for (const party of related) {
    const subjects = [party.entityId, customerId];
    const pii = party.kind === "individual" ? "PII" : "CONFIDENTIAL";
    if (party.ownershipPercent) add("OwnershipInterest", `ownership.${party.key}`, { owner: party.entityId, owned: customerId, interest: percentToFraction(party.ownershipPercent) }, subjects, pii);
    for (const role of party.roles.filter((value) => value !== OWNERSHIP_ROLE)) {
      add("OfficerRole", `officer-role.${party.key}-${role}`, { entity_id: party.entityId, organization_id: customerId, role }, subjects, pii);
    }
    // A declared relative or close associate, or a politically exposed party: screening covers them.
    if (party.kind === "individual" && (party.relationToCustomer || party.politicallyExposed === "yes")) {
      add("PEPRelationship", `pep-relationship.${party.key}`, {
        source: customerId, target: party.entityId, relation: party.relationToCustomer ?? party.roles[0] ?? "related_party", verified: false,
        ...extension({ target_politically_exposed: party.politicallyExposed, target_pep_position: party.pepPosition, customer_politically_exposed: customerParty.politicallyExposed }),
      }, subjects, "PII");
    }
  }
  if (parsed.sourceOfFunds) add("SourceOfFunds", "source-of-funds.customer", { claim: parsed.sourceOfFunds, evidence_ids: [], verified: false }, [customerId], "CONFIDENTIAL");

  // Documents: each a DocumentVersion over its stored upload, unparsed (no pages) until a document
  // run parses it. Ids follow the case store's upload ids, so the run's records supersede these.
  parsed.documents.forEach((document, index) => {
    const registration = context.documents![index]!;
    const sha256 = registration.sha256.replace(/^sha256:/, "");
    const party = document.relatedParty === undefined ? customerParty : related[document.relatedParty]!;
    add("DocumentVersion", applicationDocumentId(sha256), {
      document_id: applicationDocumentId(sha256), artifact_hash: sha256, media_type: document.mediaType, artifact_ref: registration.artifactRef, page_count: 0,
      ...extension({ filename: document.filename, document_type: document.documentType, evidence_id: registration.evidenceId, page_count_basis: "unparsed_upload" }),
    }, [party.entityId], party.kind === "individual" ? "PII" : "CONFIDENTIAL");
  });

  // The application itself, last: it references the Party and Product versions above.
  add("Application", "application", {
    contract_version: "1.0.0", source_application_id: applicationId,
    applicants: [{ party_ref: partyRef, role: "PRIMARY" }], requested_products: productRefs,
    channel: parsed.channel, status: "SUBMITTED", submitted_at: observedAt, effective_from: observedAt, effective_to: null,
    evidence_refs: [], historical_decisions: [],
  }, [customerId], "CONFIDENTIAL");

  const subjects: ApplicationSubject[] = parties.map((party) => {
    const address = party.addresses[0];
    const country = party.registrationJurisdiction ?? address?.country ?? party.nationality;
    return {
      subjectId: party.entityId,
      subjectType: party.kind === "individual" ? "individual" : "legal_entity",
      displayName: party.name,
      attributes: {
        role: party === customerParty ? "customer" : party.roles[0] ?? party.relationToCustomer, roles: party.roles, applicationId,
        ...(country ? { country } : {}),
        ...(party.registrationNumber ? { registrationNumber: party.registrationNumber } : {}),
        ...(party.kind !== "individual" ? { legalForm: legalFormOf(party) } : {}),
        ...(party.dateOfBirth ? { dateOfBirth: party.dateOfBirth } : {}),
        ...(party.nationality ? { nationality: party.nationality } : {}),
        ...(party.ownershipPercent ? { ownershipPercent: party.ownershipPercent } : {}),
        ...(party.relationToCustomer ? { relationToCustomer: party.relationToCustomer } : {}),
        ...(party.politicallyExposed ? { politicallyExposed: party.politicallyExposed } : {}),
        ...(party.pepPosition ? { pepPosition: party.pepPosition } : {}),
        // The customer carries the submission's digest: a retry that changed anything conflicts.
        ...(party === customerParty ? { submissionDigest } : {}),
      },
      identifiers: identifiersOf(party).map((identifier) => ({ identifierType: identifier.type, value: identifier.value, source: identifier.issuer })),
    };
  });
  return { ...applicationCaseType(scope.customerType), applicationId, submissionDigest, customerEntityId: customerId, subjects, records };
}

type PartyFields = Partial<Pick<Party, "dateOfBirth" | "nationality" | "legalForm" | "registrationNumber" | "registrationJurisdiction" | "registrationAuthority" | "politicallyExposed" | "pepPosition">>;
function pick(source: { [K in keyof PartyFields]?: PartyFields[K] | undefined }): PartyFields {
  const out: PartyFields = {};
  for (const field of ["dateOfBirth", "nationality", "legalForm", "registrationNumber", "registrationJurisdiction", "registrationAuthority", "politicallyExposed", "pepPosition"] as const) {
    if (source[field] !== undefined) (out as Record<string, unknown>)[field] = source[field];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Browser-safe canonical JSON and SHA-256 (the same canonical form as `canonicalJson`)
// ---------------------------------------------------------------------------

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, canonicalize(nested)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

const PRIMES = (() => {
  const primes: number[] = [];
  for (let candidate = 2; primes.length < 64; candidate += 1) if (primes.every((prime) => candidate % prime !== 0)) primes.push(candidate);
  return primes;
})();
const fractionBits = (value: number) => ((value - Math.floor(value)) * 0x100000000) >>> 0;
const ROUND = Uint32Array.from(PRIMES, (prime) => fractionBits(Math.cbrt(prime)));
const INITIAL = Uint32Array.from(PRIMES.slice(0, 8), (prime) => fractionBits(Math.sqrt(prime)));
const rotr = (value: number, bits: number) => (value >>> bits) | (value << (32 - bits));

/** SHA-256 of a string's UTF-8 bytes (or of raw bytes), as hex (equal to node's `createHash("sha256")`). */
export function sha256Hex(input: string | Uint8Array): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded.length - 4, bits >>> 0);
  const hash = Uint32Array.from(INITIAL);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const w15 = words[i - 15]!, w2 = words[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      words[i] = (words[i - 16]! + s0 + words[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash as unknown as number[];
    for (let i = 0; i < 64; i += 1) {
      const t1 = (h! + (rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)) + ((e! & f!) ^ (~e! & g!)) + ROUND[i]! + words[i]!) >>> 0;
      const t2 = ((rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)) + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) >>> 0;
      h = g; g = f; f = e; e = (d! + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((value, index) => { hash[index] = (hash[index]! + value!) >>> 0; });
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
}
