import {
  jurisdictionSourcePolicySchema, sourceBindingSchema, sourceAccessSchema, sourceContextSchema,
  sourceUseRequestSchema, sourcePolicyDecisionSchema, stableDigest,
  type JurisdictionSourcePolicy, type SourceBinding, type SourceAccess, type SourceContext,
  type SourceUseRequest, type SourcePolicyDecision,
} from "@ehf/contracts";

export type SourceEvaluationInput = {
  context: SourceContext | null;
  policies: JurisdictionSourcePolicy[];
  binding: SourceBinding | null;
  access: SourceAccess | null;
  capabilityId: string;
  connectorId: string;
  connectorDigest: string | null;
  request: SourceUseRequest;
  evaluatedAt: string;
};
const sorted = <T extends string>(values: T[]): T[] => [...new Set(values)].sort();
const subset = (values: string[], allowed: string[]) => values.every((value) => allowed.includes(value));
const intersection = <T extends string>(sets: T[][]): T[] => sets.length ? sorted(sets[0]!.filter((value) => sets.every((set) => set.includes(value)))) : [];
const current = (value: { validFrom: string; expiresAt: string }, now: number) => Date.parse(value.validFrom) <= now && now < Date.parse(value.expiresAt);

/** Frozen compatibility oracle. Services use evaluateSourceAuthorizationWithOpa; this function confers no authority. */
export function evaluateSourceAuthorization(input: SourceEvaluationInput): SourcePolicyDecision {
  const now = Date.parse(input.evaluatedAt);
  if (!Number.isFinite(now)) throw new Error("source_policy.evaluation_time_invalid");
  const policies = [...input.policies].sort((a, b) => stableDigest(a).localeCompare(stableDigest(b)));
  const context = input.context;
  const binding = input.binding;
  const access = input.access;
  const decision: SourcePolicyDecision = {
    schemaVersion: "source.decision.v1", outcome: "UNRESOLVED", reasonCodes: [], ruleIds: [],
    inputDigest: stableDigest({ ...input, policies }), contextDigest: context ? stableDigest(context) : null,
    policyDigests: sorted(policies.map(stableDigest)), bindingDigest: binding ? stableDigest(binding) : null,
    accessDigest: access ? stableDigest(access) : null, evaluatedAt: input.evaluatedAt,
    validUntil: new Date(now + 60_000).toISOString(),
    obligations: { datasetIds: [], requiredFields: [], evidenceRoles: [], maxAgeSeconds: null, maxRetentionSeconds: null, allowRedistribution: false, recipientIds: [] },
  };
  const result = (outcome: SourcePolicyDecision["outcome"], reason: string): SourcePolicyDecision => sourcePolicyDecisionSchema.parse({
    ...decision, outcome, reasonCodes: [reason], ruleIds: sorted(decision.ruleIds),
  });
  if (!sourceUseRequestSchema.safeParse(input.request).success || !sourceContextSchema.safeParse(context).success
    || !sourceBindingSchema.safeParse(binding).success || !sourceAccessSchema.safeParse(access).success
    || !policies.length || policies.some((policy) => !jurisdictionSourcePolicySchema.safeParse(policy).success)) {
    return result("UNRESOLVED", "source_policy.context_or_artifact_missing");
  }
  // Parsing above establishes these references; keep null-safe types at the public boundary.
  if (!context || !binding || !access) return result("UNRESOLVED", "source_policy.context_or_artifact_missing");
  const expiries = [context, binding, access, ...policies].map((value) => Date.parse(value.expiresAt));
  decision.validUntil = new Date(Math.min(now + 60_000, ...expiries)).toISOString();
  if ([context, binding, access, ...policies].some((value) => !current(value, now))) return result("DENY", "source_policy.artifact_not_current");
  if (binding.quarantined) return result("DENY", "source_policy.source_quarantined");
  if (binding.readiness !== "integration_verified" || binding.jurisdiction === "unresolved") return result("UNRESOLVED", "source_policy.source_scope_unresolved");
  if (binding.capabilityId !== input.capabilityId || binding.connectorId !== input.connectorId || binding.connectorDigest !== input.connectorDigest) return result("DENY", "source_policy.binding_changed");
  if (access.bindingDigest !== stableDigest(binding) || access.institutionId !== context.institutionId
    || !access.bookingEntityIds.includes(context.bookingEntityId) || !access.products.includes(context.product) || !access.purposes.includes(context.purpose)) return result("DENY", "source_policy.access_scope_denied");
  if (access.consentRequired && !context.consentRef) return result("UNRESOLVED", "source_policy.consent_missing");
  if (!binding.allowAnySubjectCountry && !subset(context.subjectCountries, binding.subjectCountries)) return result("DENY", "source_policy.subject_not_covered");
  const subjectJurisdictions = binding.jurisdictionBasis === "registry_authority" ? context.registrationJurisdictions
    : binding.jurisdictionBasis === "issuer_authority" ? context.issuerJurisdictions
    : binding.jurisdictionBasis === "account_servicing" ? context.accountJurisdictions : null;
  if (subjectJurisdictions && binding.jurisdiction !== "global") {
    if (!subjectJurisdictions.length || subjectJurisdictions.includes("unresolved")) return result("UNRESOLVED", "source_policy.subject_jurisdiction_missing");
    if (subjectJurisdictions.some((value) => value !== binding.jurisdiction)) return result("DENY", "source_policy.source_authority_mismatch");
  }
  if (!subset(binding.approvedEndpoints, access.approvedEndpoints) || !subset(binding.processingRegions, access.processingRegions)
    || !subset(binding.storageRegions, access.storageRegions) || !subset(binding.subprocessors, access.subprocessors)
    || binding.transferBasisRef !== access.transferBasisRef) return result("DENY", "source_policy.data_flow_denied");
  const applicable = policies.filter((policy) => policy.scope.institutionId === context.institutionId
    && policy.scope.bookingEntityIds.includes(context.bookingEntityId) && policy.scope.products.includes(context.product)
    && policy.scope.purposes.includes(context.purpose) && policy.scope.policyJurisdictions.some((value) => context.policyJurisdictions.includes(value)));
  if (applicable.length !== policies.length || !subset(context.policyJurisdictions, applicable.flatMap((policy) => policy.scope.policyJurisdictions))) return result("UNRESOLVED", "source_policy.applicability_unresolved");
  const matching = applicable.map((policy) => ({ policy, rules: policy.rules.filter((rule) => rule.capabilityIds.includes(input.capabilityId)
    && (!rule.bindingDigests.length || rule.bindingDigests.includes(stableDigest(binding))) && rule.sourceJurisdictions.includes(binding.jurisdiction)) }));
  decision.ruleIds = matching.flatMap(({ policy, rules }) => rules.map((rule) => `${policy.id}@${policy.version}:${rule.id}`));
  if (matching.some(({ rules }) => rules.some((rule) => rule.effect === "DENY"))) return result("DENY", "source_policy.explicit_deny");
  if (matching.some(({ rules }) => rules.some((rule) => rule.effect === "REVIEW_REQUIRED"))) return result("REVIEW_REQUIRED", "source_policy.review_required");
  if (matching.some(({ rules }) => !rules.some((rule) => rule.effect === "ALLOW"))) return result("DENY", "source_policy.no_allow_rule");
  const allows = matching.flatMap(({ rules }) => rules.filter((rule) => rule.effect === "ALLOW"));
  const maxAges = allows.flatMap((rule) => rule.maxAgeSeconds === null ? [] : [rule.maxAgeSeconds]);
  decision.obligations = {
    datasetIds: sorted(allows.flatMap((rule) => rule.datasetIds)), requiredFields: sorted(allows.flatMap((rule) => rule.requiredFields)),
    evidenceRoles: intersection(allows.map((rule) => rule.evidenceRoles)),
    maxAgeSeconds: maxAges.length ? Math.min(...maxAges) : null,
    maxRetentionSeconds: Math.min(...allows.map((rule) => rule.maxRetentionSeconds)),
    allowRedistribution: allows.every((rule) => rule.allowRedistribution), recipientIds: intersection(allows.map((rule) => rule.recipientIds)),
  };
  const obligations = decision.obligations;
  if (!obligations.evidenceRoles.length || !obligations.recipientIds.length) return result("REVIEW_REQUIRED", "source_policy.obligations_conflict");
  if (!obligations.recipientIds.includes(input.request.recipientId) || input.request.redistribute && !obligations.allowRedistribution) return result("DENY", "source_policy.use_denied");
  if (allows.some((rule) => !subset(binding.processingRegions, rule.processingRegions) || !subset(binding.storageRegions, rule.storageRegions))) return result("DENY", "source_policy.processing_region_denied");
  if (!subset(obligations.datasetIds, binding.datasetIds) || !subset(obligations.datasetIds, access.datasetIds)
    || !subset(obligations.requiredFields, binding.fields) || !obligations.evidenceRoles.some((role) => binding.evidenceRoles.includes(role))) return result("UNRESOLVED", "source_policy.required_scope_not_supported");
  if (input.request.stage === "use") {
    const observation = input.request.observation;
    if (!observation || !observation.complete || !subset(obligations.datasetIds, observation.datasetIds)
      || !subset(obligations.requiredFields, observation.fields) || !obligations.evidenceRoles.includes(observation.role)
      || !binding.evidenceRoles.includes(observation.role) || !subset(observation.datasetIds, binding.datasetIds)
      || !subset(observation.datasetIds, access.datasetIds) || !subset(observation.fields, binding.fields)) return result("UNRESOLVED", "source_policy.evidence_incomplete");
    const age = now - Date.parse(observation.observedAt);
    if (age < 0 || obligations.maxAgeSeconds !== null && age > obligations.maxAgeSeconds * 1000) return result("UNRESOLVED", "source_policy.evidence_stale");
    if (age >= obligations.maxRetentionSeconds! * 1000) return result("DENY", "source_policy.retention_expired");
    decision.validUntil = new Date(Math.min(Date.parse(decision.validUntil), Date.parse(observation.observedAt) + obligations.maxRetentionSeconds! * 1000,
      obligations.maxAgeSeconds === null ? Infinity : Date.parse(observation.observedAt) + obligations.maxAgeSeconds * 1000)).toISOString();
  }
  return result("ALLOW", input.request.stage === "acquire" ? "source_policy.acquisition_allowed" : "source_policy.evidence_use_allowed");
}

/** Candidate compilation is content-addressed; registration/approval still happens separately. */
export function compileJurisdictionSourcePolicy(raw: unknown) {
  const policy = jurisdictionSourcePolicySchema.parse(raw);
  return { policy, digest: stableDigest(policy), evaluator: "opa.source.v2" as const };
}
