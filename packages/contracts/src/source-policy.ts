import { z } from "zod";

const text = z.string().min(1).max(200).refine((value) => value === value.trim(), "source_policy.text_invalid");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime();
const unique = <T extends z.ZodType>(item: T, min = 0, max = 300) => z.array(item).min(min).max(max)
  .refine((items) => new Set(items.map((value) => JSON.stringify(value))).size === items.length, "source_policy.duplicate");
// This vocabulary is the atlas registry, not a conversion of authority tokens into countries.
export const SOURCE_JURISDICTIONS = ["gb", "us", "ca", "fr", "de", "nl", "be", "se", "no", "fi", "dk", "it", "es", "ie", "lu", "ch", "au", "nz", "sg", "hk", "in", "my", "id", "ph", "cn", "jp", "tw", "kr", "br", "mx", "co", "ar", "cl", "za", "ng", "ke", "gh", "sa", "ae", "bh", "eu", "un", "global", "unresolved", "us_de"] as const;
export const sourceJurisdictionSchema = z.enum(SOURCE_JURISDICTIONS);
// ISO 3166 alpha-2 snapshot from the public-domain IANA iso3166.tab (2025-07-01).
const COUNTRIES = new Set("AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW".split(" "));
const country = z.string().refine((value) => COUNTRIES.has(value), "source_policy.country_invalid");
const endpoint = z.url().max(500).refine((value) => {
  const url = new URL(value);
  return ["https:", "postgresql:", "tds:"].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password && !url.search && !url.hash
    && !/%2f|%5c|\.\./i.test(url.pathname);
}, "source_policy.endpoint_invalid");
const validity = { validFrom: instant, expiresAt: instant };
const interval = (value: { validFrom: string; expiresAt: string }) => Date.parse(value.validFrom) < Date.parse(value.expiresAt);
export const sourceEvidenceRoleSchema = z.enum(["primary", "corroborating", "supplemental", "processing"]);
export const sourceJurisdictionBasisSchema = z.enum(["registry_authority", "issuer_authority", "dataset_authority", "policy_jurisdiction", "financial_source_authority", "account_servicing", "integration_scope"]);

export const sourceBindingSchema = z.object({
  kind: z.literal("source-binding"), schemaVersion: z.literal("source.binding.v1"),
  id: text, capabilityId: text, connectorId: text, connectorDigest: digest,
  providerId: text, product: text, operation: text, definitionVersion: text, mappingVersion: text,
  upstreamContractDigest: digest.nullable().optional(),
  jurisdiction: sourceJurisdictionSchema, jurisdictionBasis: sourceJurisdictionBasisSchema,
  globalScopeRef: text.nullable(),
  subjectCountries: unique(country), allowAnySubjectCountry: z.boolean(),
  datasetIds: unique(text), evidenceRoles: unique(sourceEvidenceRoleSchema, 1), fields: unique(text),
  transport: z.enum(["network", "local"]), approvedEndpoints: unique(endpoint),
  processingRegions: unique(text, 1), storageRegions: unique(text, 1), subprocessors: unique(text),
  transferBasisRef: text, evidenceRefs: unique(text, 1),
  readiness: z.enum(["proposed", "integration_verified"]), quarantined: z.boolean(),
  ...validity,
}).strict().refine(interval, "source_policy.interval_invalid").superRefine((binding, ctx) => {
  if ((binding.transport === "network") !== (binding.approvedEndpoints.length > 0)) ctx.addIssue({ code: "custom", message: "source_policy.transport_endpoints_invalid" });
  if (binding.jurisdiction === "global" && !binding.globalScopeRef) ctx.addIssue({ code: "custom", message: "source_policy.global_scope_required" });
  if (!binding.allowAnySubjectCountry && !binding.subjectCountries.length) ctx.addIssue({ code: "custom", message: "source_policy.subject_scope_required" });
  if (binding.connectorId.startsWith("wiring:") && !binding.upstreamContractDigest) ctx.addIssue({ code: "custom", message: "source_policy.upstream_contract_required" });
});

export const sourceAccessSchema = z.object({
  kind: z.literal("source-access"), schemaVersion: z.literal("source.access.v1"),
  id: text, bindingDigest: digest, institutionId: text, bookingEntityIds: unique(text, 1),
  products: unique(text, 1), purposes: unique(text, 1), datasetIds: unique(text),
  accessBasis: z.enum(["contract", "public_license", "statutory_access"]), accessBasisRef: text,
  legalBasisRef: text, consentRequired: z.boolean(),
  approvedEndpoints: unique(endpoint), processingRegions: unique(text, 1), storageRegions: unique(text, 1),
  subprocessors: unique(text), transferBasisRef: text, evidenceRefs: unique(text, 1), ...validity,
}).strict().refine(interval, "source_policy.interval_invalid");

export const sourcePolicyRuleSchema = z.object({
  id: text, effect: z.enum(["ALLOW", "DENY", "REVIEW_REQUIRED"]),
  capabilityIds: unique(text, 1), bindingDigests: unique(digest), sourceJurisdictions: unique(sourceJurisdictionSchema, 1),
  datasetIds: unique(text), evidenceRoles: unique(sourceEvidenceRoleSchema, 1), requiredFields: unique(text),
  processingRegions: unique(text, 1), storageRegions: unique(text, 1),
  maxAgeSeconds: z.number().int().positive().nullable(), maxRetentionSeconds: z.number().int().positive(),
  allowRedistribution: z.boolean(), recipientIds: unique(text, 1),
}).strict();
export const jurisdictionSourcePolicySchema = z.object({
  kind: z.literal("source-policy"), schemaVersion: z.literal("jurisdiction.source-policy.v1"),
  id: text, version: text, owner: text, legalBasisRefs: unique(text, 1),
  scope: z.object({ institutionId: text, bookingEntityIds: unique(text, 1), policyJurisdictions: unique(sourceJurisdictionSchema, 1), products: unique(text, 1), purposes: unique(text, 1) }).strict(),
  rules: z.array(sourcePolicyRuleSchema).min(1).max(300).refine((rules) => new Set(rules.map((rule) => rule.id)).size === rules.length, "source_policy.duplicate_rule"),
  ...validity,
}).strict().refine(interval, "source_policy.interval_invalid").refine((policy) => !policy.scope.policyJurisdictions.some((value) => value === "unresolved" || value === "global"), "source_policy.applicability_required");

/** Approved institution/case facts. Never assembled from an invocation's free-form input. */
export const sourceContextSchema = z.object({
  kind: z.literal("source-context"), schemaVersion: z.literal("source.context.v1"),
  tenantId: text, caseId: text, planDigest: digest,
  institutionId: text, bookingEntityId: text, branchId: text,
  product: text, purpose: text, policyJurisdictions: unique(sourceJurisdictionSchema, 1),
  subjectCountries: unique(country, 1), registrationJurisdictions: unique(sourceJurisdictionSchema),
  issuerJurisdictions: unique(sourceJurisdictionSchema), accountJurisdictions: unique(sourceJurisdictionSchema),
  consentRef: text.nullable(), factsProvenanceRefs: unique(text, 1), ...validity,
}).strict().refine(interval, "source_policy.interval_invalid").refine((context) => !context.policyJurisdictions.some((value) => value === "unresolved" || value === "global"), "source_policy.applicability_required");

export const sourceArtifactSchema = z.discriminatedUnion("kind", [sourceBindingSchema, sourceAccessSchema, jurisdictionSourcePolicySchema, sourceContextSchema]);
export const sourceArtifactKindSchema = z.enum(["source-binding", "source-access", "source-policy", "source-context"]);
export const planSourceAuthorizationSchema = z.object({
  policyDigests: unique(digest, 1, 32),
  internalCapabilityIds: unique(text).optional(),
  bindings: z.array(z.object({ capabilityId: text, connectorId: text, bindingDigest: digest, accessDigest: digest }).strict()).min(1).max(500)
    .refine((items) => new Set(items.map((item) => `${item.capabilityId}\0${item.connectorId}`)).size === items.length, "source_policy.duplicate_binding"),
}).strict();

export const sourceEvidenceObservationSchema = z.object({
  datasetIds: unique(text), fields: unique(text), role: sourceEvidenceRoleSchema,
  observedAt: instant, complete: z.boolean(),
}).strict();
export const sourceUseRequestSchema = z.object({
  stage: z.enum(["acquire", "use"]), recipientId: text, redistribute: z.boolean(),
  observation: sourceEvidenceObservationSchema.optional(),
}).strict();
export const sourcePolicyDecisionSchema = z.object({
  schemaVersion: z.literal("source.decision.v1"), outcome: z.enum(["ALLOW", "DENY", "REVIEW_REQUIRED", "UNRESOLVED"]),
  reasonCodes: unique(text, 1), ruleIds: unique(text), inputDigest: digest, contextDigest: digest.nullable(),
  policyDigests: unique(digest), bindingDigest: digest.nullable(), accessDigest: digest.nullable(),
  evaluatedAt: instant, validUntil: instant,
  evaluator: z.object({kind:z.literal("OPA"),version:text,bundleDigest:digest}).strict().optional(),
  obligations: z.object({ datasetIds: unique(text), requiredFields: unique(text), evidenceRoles: unique(sourceEvidenceRoleSchema),
    maxAgeSeconds: z.number().int().positive().nullable(), maxRetentionSeconds: z.number().int().positive().nullable(),
    allowRedistribution: z.boolean(), recipientIds: unique(text),
  }).strict(),
}).strict();

export type SourceBinding = z.infer<typeof sourceBindingSchema>;
export type SourceAccess = z.infer<typeof sourceAccessSchema>;
export type JurisdictionSourcePolicy = z.infer<typeof jurisdictionSourcePolicySchema>;
export type SourceContext = z.infer<typeof sourceContextSchema>;
export type SourceArtifact = z.infer<typeof sourceArtifactSchema>;
export type SourceArtifactKind = z.infer<typeof sourceArtifactKindSchema>;
export type PlanSourceAuthorization = z.infer<typeof planSourceAuthorizationSchema>;
export type SourceEvidenceObservation = z.infer<typeof sourceEvidenceObservationSchema>;
export type SourceUseRequest = z.infer<typeof sourceUseRequestSchema>;
export type SourcePolicyDecision = z.infer<typeof sourcePolicyDecisionSchema>;
