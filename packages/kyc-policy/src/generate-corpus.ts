import type { EvidenceObligation, PolicyCatalog } from "@ehf/policy-engine";

import { kycPolicyCatalog } from "./catalog.js";
import { GATE_ORDER, type CorpusCase, type CorpusExpectation, type GateId } from "./corpus.js";
import { CASE_SNAPSHOT_SCHEMA_VERSION, kycCaseAggregateSchema, type KycCaseAggregate } from "./snapshot.js";

type PolicyOutcome = "ALLOW" | "BLOCK" | "REVIEW" | "UNKNOWN" | "ERROR";

/**
 * Builds the golden corpus.
 *
 * The corpus is not a recording of what the evaluator does. Each case is adjudicated here
 * by a rubric written independently of the decision tables — plain nested reasoning about
 * what a policy owner would say, in the documented precedence order — and the test suite
 * then demands that the table-driven evaluator and the compiled Rego both reproduce it. If
 * the tables are encoded wrongly, the two disagree and the suite fails; if the precedence
 * itself is wrong, a human reading these rationales is the one who catches it.
 *
 * Generation is deterministic: no randomness, no clock, fixed timestamps. Re-running it on
 * an unchanged catalog reproduces the file byte for byte, which is what lets the manifest
 * digest mean anything.
 */

const EVALUATED_AT = "2026-03-02T12:00:00.000Z";
const PINNED_DIGEST = "a".repeat(64);
const OTHER_DIGEST = "b".repeat(64);
export const CORPUS_SEED = 20260302;

type ProviderStatus = "OK" | "DEGRADED" | "UNAVAILABLE";

interface CaseSpec {
  id: string;
  riskCohort: string;
  failureCohorts: string[];
  tags: string[];
  targetGate: GateId;
  customerType: "individual" | "sole_proprietor";
  riskTier: "standard" | "elevated" | "high";
  jurisdictionRisk: "LOW" | "MEDIUM" | "HIGH";
  productRisk: "LOW" | "MEDIUM" | "HIGH";
  pepExposure: boolean;
  omitPolicyEvidence?: boolean;
  omitPolicyClaim?: boolean;
  claimDigestMismatch?: boolean;
  policyEvidenceAgeDays?: number;
  evidenceAgeDays?: number;
  omitCipAttribute?: "legalName" | "dateOfBirth" | "address" | "taxpayerIdentificationNumber";
  investigationWorkItem?: "COMPLETED" | "IN_PROGRESS" | "ABSENT";
  omitInvestigationEvidence?: boolean;
  providerStatus?: { sanctions?: ProviderStatus; pep?: ProviderStatus; adverseMedia?: ProviderStatus };
  omitScreeningBlock?: boolean;
  sanctionsListAgeDays?: number;
  omitObligations?: string[];
  contradiction?: "HIGH_OPEN" | "HIGH_RESOLVED" | "MEDIUM_OPEN";
  findings?: { findingType: string; status: "OPEN" | "RESOLVED" }[];
  recommendation?: "APPROVE" | "REVIEW" | "DECLINE" | "ABSENT";
  requiresHumanReview?: boolean | null;
  confidence?: number | null;
  citations?: "COMPLETE" | "NO_POLICY" | "NO_EVIDENCE" | "NO_FINDING";
  attestation?: "VALID" | "MISSING" | "EXPIRED" | "WRONG_COHORT";
  staleSnapshot?: boolean;
  evaluationError?: string;
  productionReady?: boolean | null;
}

// ------------------------------------------------------------------ snapshot construction

function daysBefore(iso: string, days: number): string {
  return new Date(Date.parse(iso) - days * 86_400_000).toISOString();
}

function obligationsForCohort(catalog: PolicyCatalog, cohortId: string): EvidenceObligation[] {
  return [...catalog.obligations.values()].filter(
    (obligation) => obligation.requiredFor.includes("*") || obligation.requiredFor.includes(cohortId),
  );
}

function buildSnapshot(spec: CaseSpec, catalog: PolicyCatalog): KycCaseAggregate {
  const evidence: KycCaseAggregate["evidence"] = [];
  const omitted = new Set(spec.omitObligations ?? []);

  for (const obligation of obligationsForCohort(catalog, spec.riskCohort)) {
    if (omitted.has(obligation.id)) continue;
    if (obligation.id === "EVD-POLICY-AUTHORITY" && spec.omitPolicyEvidence) continue;
    if (obligation.id === "EVD-PUBLIC-SOURCE-RESEARCH" && spec.omitInvestigationEvidence) continue;

    const ageDays = obligation.id === "EVD-POLICY-AUTHORITY"
      ? (spec.policyEvidenceAgeDays ?? 0)
      : (spec.evidenceAgeDays ?? 2);
    evidence.push({
      evidenceId: `evd_${spec.id}_${obligation.id.toLowerCase().replaceAll("-", "_")}`,
      purpose: obligation.purpose,
      sourceType: obligation.acceptableSourceTypes[0]!,
      trustTier: obligation.minimumTrustTier,
      instructionTrust: obligation.instructionTrust,
      recordedAt: daysBefore(EVALUATED_AT, ageDays),
      policySnapshotDigest: PINNED_DIGEST,
    });
  }

  const claims: KycCaseAggregate["claims"] = spec.omitPolicyClaim
    ? []
    : [{
        claimId: `claim_${spec.id}_policy`,
        predicate: "applicable_kyc_policy",
        value: { policySnapshotDigest: spec.claimDigestMismatch ? OTHER_DIGEST : PINNED_DIGEST },
        evidenceRefs: [`evd_${spec.id}_evd_policy_authority`],
      }];

  const findings: KycCaseAggregate["findings"] = (spec.findings ?? []).map((finding, index) => ({
    findingId: `find_${spec.id}_${index}`,
    findingType: finding.findingType,
    status: finding.status,
    evidenceRefs: [],
  }));

  const contradictions: KycCaseAggregate["contradictions"] = spec.contradiction
    ? [{
        contradictionId: `contra_${spec.id}`,
        materiality: spec.contradiction.startsWith("HIGH") ? "HIGH" : "MEDIUM",
        status: spec.contradiction.endsWith("RESOLVED") ? "RESOLVED" : "OPEN",
      }]
    : [];

  const workItemStatus = spec.investigationWorkItem ?? "COMPLETED";
  const workItems: KycCaseAggregate["workItems"] = workItemStatus === "ABSENT"
    ? []
    : [{
        workItemId: `work_${spec.id}_public_investigation`,
        workType: "PUBLIC_SOURCE_KYC_INVESTIGATION",
        status: workItemStatus,
      }];

  const recommendationOutcome = spec.recommendation ?? "APPROVE";
  const citations = spec.citations ?? "COMPLETE";
  const recommendation: KycCaseAggregate["recommendation"] = recommendationOutcome === "ABSENT"
    ? null
    : {
        recommendationId: `rec_${spec.id}`,
        outcome: recommendationOutcome,
        rationale: "Generated corpus recommendation.",
        policyRuleRefs: citations === "NO_POLICY" ? [] : ["KYC-CIP-002"],
        findingRefs: citations === "NO_FINDING" ? [] : findings.map((finding) => finding.findingId),
        evidenceRefs: citations === "NO_EVIDENCE" ? [] : [`evd_${spec.id}_evd_decision_recommendation`],
        confidence: spec.confidence === undefined ? 0.94 : spec.confidence,
        requiresHumanReview: spec.requiresHumanReview === undefined ? false : spec.requiresHumanReview,
      };

  const providerResult = (status: ProviderStatus, listAgeDays: number | null) => ({
    status,
    screenedAt: daysBefore(EVALUATED_AT, 1),
    listVersion: "fixture-list-2026-03-01",
    listPublishedAt: listAgeDays === null ? null : daysBefore(EVALUATED_AT, listAgeDays),
  });

  const screening: KycCaseAggregate["screening"] = spec.omitScreeningBlock
    ? null
    : {
        sanctions: providerResult(spec.providerStatus?.sanctions ?? "OK", spec.sanctionsListAgeDays ?? 0),
        pep: providerResult(spec.providerStatus?.pep ?? "OK", 1),
        adverseMedia: providerResult(spec.providerStatus?.adverseMedia ?? "OK", 1),
      };

  const cohort = catalog.riskCohorts.get(spec.riskCohort)!;
  const attestationMode = spec.attestation ?? (cohort.requiresAttestation ? "VALID" : "MISSING");
  const attestation: KycCaseAggregate["attestation"] =
    attestationMode === "MISSING"
      ? null
      : {
          cohortId: attestationMode === "WRONG_COHORT" ? "RC-STANDARD-INDIVIDUAL" : spec.riskCohort,
          status: attestationMode === "EXPIRED" ? "EXPIRED" : "VALID",
          expiresAt: attestationMode === "EXPIRED" ? daysBefore(EVALUATED_AT, 3) : "2026-12-31T00:00:00.000Z",
          signedBy: "chief-compliance-officer",
        };

  const caseSequence = 42;
  return kycCaseAggregateSchema.parse({
    schemaVersion: CASE_SNAPSHOT_SCHEMA_VERSION,
    tenantId: "tenant_corpus",
    caseId: spec.id,
    caseSequence,
    currentSequence: spec.staleSnapshot ? caseSequence + 3 : caseSequence,
    status: "READY_FOR_DECISION",
    evaluatedAt: EVALUATED_AT,
    policyAuthority: {
      policyId: "policy.kyc.customer-acceptance.v1",
      policyVersion: "1.0.0",
      policySnapshotDigest: PINNED_DIGEST,
    },
    subject: {
      subjectId: `subj_${spec.id}`,
      legalName: spec.omitCipAttribute === "legalName" ? null : "Corpus Subject",
      dateOfBirth: spec.omitCipAttribute === "dateOfBirth" ? null : "1984-06-11",
      address: spec.omitCipAttribute === "address" ? null : "100 Example Street, Springfield",
      taxpayerIdentificationNumber: spec.omitCipAttribute === "taxpayerIdentificationNumber" ? null : "***-**-0000",
      country: "US",
      customerType: spec.customerType,
    },
    risk: {
      riskTier: spec.riskTier,
      jurisdictionRisk: spec.jurisdictionRisk,
      productRisk: spec.productRisk,
      pepExposure: spec.pepExposure,
    },
    policyConfiguration: {
      productionReady: spec.productionReady === undefined ? true : spec.productionReady,
      automaticApprovalEnabled: true,
    },
    attestation,
    evidence,
    claims,
    findings,
    contradictions,
    workItems,
    recommendation,
    screening,
    evaluationError: spec.evaluationError ?? null,
  });
}

// ------------------------------------------------------------------ independent adjudication

interface Verdict { outcome: PolicyOutcome; reasonCode: string; rationale: string }

/**
 * A deliberately separate reading of the case. It does not import the evaluator, does not
 * consult the decision tables, and does its own evidence checking; it only follows the same
 * published precedence. Where it and the tables disagree, one of them is wrong and the test
 * suite says so rather than picking a winner.
 */
function evidenceMeets(snapshot: KycCaseAggregate, obligation: EvidenceObligation): boolean {
  const pinned = snapshot.policyAuthority?.policySnapshotDigest ?? null;
  for (const item of snapshot.evidence) {
    if (item.purpose !== obligation.purpose) continue;
    if (!obligation.acceptableSourceTypes.includes(item.sourceType)) continue;
    if (pinned !== null && item.policySnapshotDigest !== null && item.policySnapshotDigest !== pinned) continue;
    if (obligation.freshnessDays !== null) {
      const ageDays = (Date.parse(snapshot.evaluatedAt) - Date.parse(item.recordedAt)) / 86_400_000;
      if (ageDays < 0 || ageDays > obligation.freshnessDays) continue;
    }
    return true;
  }
  return false;
}

function evidencePresentButStale(snapshot: KycCaseAggregate, obligation: EvidenceObligation): boolean {
  if (obligation.freshnessDays === null) return false;
  const pinned = snapshot.policyAuthority?.policySnapshotDigest ?? null;
  return snapshot.evidence.some((item) => {
    if (item.purpose !== obligation.purpose) return false;
    if (!obligation.acceptableSourceTypes.includes(item.sourceType)) return false;
    if (pinned !== null && item.policySnapshotDigest !== null && item.policySnapshotDigest !== pinned) return false;
    const ageDays = (Date.parse(snapshot.evaluatedAt) - Date.parse(item.recordedAt)) / 86_400_000;
    return ageDays < 0 || ageDays > obligation.freshnessDays!;
  });
}

/** Missing evidence and aged-out evidence are separated, because they call for different work. */
function obligationGaps(
  snapshot: KycCaseAggregate,
  catalog: PolicyCatalog,
  cohortId: string,
  only: string[] | null,
  exclude: string[],
): { missing: string[]; expired: string[] } {
  const excluded = new Set(exclude);
  const missing: string[] = [];
  const expired: string[] = [];
  for (const obligation of obligationsForCohort(catalog, cohortId)) {
    if (only !== null && !only.includes(obligation.id)) continue;
    if (excluded.has(obligation.id)) continue;
    if (evidenceMeets(snapshot, obligation)) continue;
    if (evidencePresentButStale(snapshot, obligation)) expired.push(obligation.id);
    else missing.push(obligation.id);
  }
  return { missing, expired };
}

function adjudicateScreeningReady(snapshot: KycCaseAggregate, catalog: PolicyCatalog): Verdict {
  if (snapshot.evaluationError !== null) {
    return { outcome: "ERROR", reasonCode: "POLICY_EVALUATION_ERROR", rationale: "The engine failed, so there is no decision and the case does not move." };
  }
  if (snapshot.currentSequence === null) {
    return { outcome: "REVIEW", reasonCode: "POLICY_UNKNOWN_INPUT", rationale: "Whether this read is current cannot be established, so it fails closed." };
  }
  if (snapshot.currentSequence > snapshot.caseSequence) {
    return { outcome: "ERROR", reasonCode: "CASE_SNAPSHOT_STALE", rationale: "The case moved on after this read; a decision on a superseded view is not a decision at all." };
  }
  const policyEvidence = snapshot.evidence.filter((item) => item.purpose === "KYC_POLICY_AUTHORITY");
  if (policyEvidence.length === 0) {
    return { outcome: "BLOCK", reasonCode: "POLICY_AUTHORITY_MISSING", rationale: "Nothing pins this case to an authoritative policy, so screening has no standard to screen against." };
  }
  const claim = snapshot.claims.find((item) => item.predicate === "applicable_kyc_policy");
  if (!claim) {
    return { outcome: "BLOCK", reasonCode: "POLICY_CLAIM_MISSING", rationale: "Policy context was never resolved onto the case." };
  }
  const claimDigest = (claim.value as { policySnapshotDigest?: string } | null)?.policySnapshotDigest;
  const pinned = snapshot.policyAuthority?.policySnapshotDigest;
  if (typeof claimDigest !== "string" || typeof pinned !== "string") {
    return { outcome: "REVIEW", reasonCode: "POLICY_UNKNOWN_INPUT", rationale: "The policy digests cannot be compared, so the case fails closed." };
  }
  if (claimDigest !== pinned) {
    return { outcome: "BLOCK", reasonCode: "POLICY_SNAPSHOT_MISMATCH", rationale: "The resolved policy is not the policy this case is pinned to; every downstream finding is suspect." };
  }
  const authorityObligation = catalog.obligations.get("EVD-POLICY-AUTHORITY")!;
  const freshEnough = policyEvidence.some((item) => {
    if (authorityObligation.freshnessDays === null) return true;
    const ageDays = (Date.parse(snapshot.evaluatedAt) - Date.parse(item.recordedAt)) / 86_400_000;
    return ageDays >= 0 && ageDays <= authorityObligation.freshnessDays;
  });
  if (!freshEnough) {
    return { outcome: "REVIEW", reasonCode: "POLICY_SNAPSHOT_STALE", rationale: "The pinned policy evidence is older than the window allows; re-pin and re-screen." };
  }
  const subject = snapshot.subject;
  const cipComplete = subject !== null
    && subject.legalName !== null
    && subject.dateOfBirth !== null
    && subject.address !== null
    && subject.taxpayerIdentificationNumber !== null;
  if (!cipComplete) {
    return { outcome: "BLOCK", reasonCode: "CIP_CORE_ATTRIBUTES_INCOMPLETE", rationale: "Screening a subject whose identifying attributes are incomplete would screen the wrong person." };
  }
  return { outcome: "ALLOW", reasonCode: "SCREENING_PRECONDITIONS_SATISFIED", rationale: "Policy is pinned, verified and current, and the identifying attributes screening needs are present." };
}

function adjudicateDecisionReady(snapshot: KycCaseAggregate, catalog: PolicyCatalog, cohortId: string | null): Verdict {
  if (snapshot.evaluationError !== null) {
    return { outcome: "ERROR", reasonCode: "POLICY_EVALUATION_ERROR", rationale: "The engine failed, so there is no decision and the case does not move." };
  }
  if (snapshot.currentSequence === null) {
    return { outcome: "REVIEW", reasonCode: "POLICY_UNKNOWN_INPUT", rationale: "Whether this read is current cannot be established, so it fails closed." };
  }
  if (snapshot.currentSequence > snapshot.caseSequence) {
    return { outcome: "ERROR", reasonCode: "CASE_SNAPSHOT_STALE", rationale: "The case moved on after this read; a decision on a superseded view is not a decision at all." };
  }
  if (cohortId === null) {
    return { outcome: "REVIEW", reasonCode: "POLICY_UNKNOWN_INPUT", rationale: "The risk cohort cannot be determined, so which obligations apply is unknown." };
  }
  if (!snapshot.claims.some((item) => item.predicate === "applicable_kyc_policy")) {
    return { outcome: "BLOCK", reasonCode: "POLICY_CONTEXT_MISSING", rationale: "The case reached decision readiness with no resolved policy context." };
  }
  const workItem = snapshot.workItems.find((item) => item.workType === "PUBLIC_SOURCE_KYC_INVESTIGATION");
  if (!workItem || workItem.status !== "COMPLETED") {
    return { outcome: "BLOCK", reasonCode: "INVESTIGATION_INCOMPLETE", rationale: "The investigation that the decision would rest on has not finished." };
  }
  if (!snapshot.evidence.some((item) => item.purpose === "KYC_PUBLIC_SOURCE_RESEARCH")) {
    return { outcome: "BLOCK", reasonCode: "INVESTIGATION_EVIDENCE_MISSING", rationale: "A completed investigation with no evidence attached is not a result." };
  }
  const screening = snapshot.screening;
  if (screening === null || screening.sanctions === null || screening.pep === null || screening.adverseMedia === null) {
    return { outcome: "REVIEW", reasonCode: "POLICY_UNKNOWN_INPUT", rationale: "Screening coverage cannot be established from the case." };
  }
  const statuses = [screening.sanctions.status, screening.pep.status, screening.adverseMedia.status];
  if (statuses.includes("UNAVAILABLE") || statuses.includes("DEGRADED")) {
    return { outcome: "REVIEW", reasonCode: "SCREENING_PROVIDER_OUTAGE", rationale: "Screening coverage is incomplete; a partial screen is not a clean screen." };
  }
  const listMaxAge = catalog.ownerInputs.get("D01")!.placeholder.listFreshnessDays as number;
  if (screening.sanctions.listPublishedAt === null) {
    return { outcome: "REVIEW", reasonCode: "POLICY_UNKNOWN_INPUT", rationale: "The sanctions list version behind this screen is unknown." };
  }
  const listAgeDays = (Date.parse(snapshot.evaluatedAt) - Date.parse(screening.sanctions.listPublishedAt)) / 86_400_000;
  if (listAgeDays < 0 || listAgeDays > listMaxAge) {
    return { outcome: "REVIEW", reasonCode: "SANCTIONS_LIST_STALE", rationale: "The screen ran against a list old enough that a recent designation could have been missed." };
  }
  const ownership = ["EVD-BENEFICIAL-OWNERSHIP", "EVD-BUSINESS-REGISTRATION"];
  const ownershipGaps = obligationGaps(snapshot, catalog, cohortId, ownership, []);
  if (ownershipGaps.missing.length > 0) {
    return { outcome: "BLOCK", reasonCode: "BENEFICIAL_OWNERSHIP_INCOMPLETE", rationale: "An entity customer whose owners are unknown has not been identified." };
  }
  const edd = ["EVD-SOURCE-OF-FUNDS", "EVD-EDD-NARRATIVE"];
  const eddGaps = obligationGaps(snapshot, catalog, cohortId, edd, []);
  if (eddGaps.missing.length > 0) {
    return { outcome: "BLOCK", reasonCode: "EDD_OBLIGATIONS_INCOMPLETE", rationale: "A higher-risk relationship has not had the enhanced diligence that risk rating calls for." };
  }
  const rest = obligationGaps(snapshot, catalog, cohortId, null, [...ownership, ...edd, "EVD-DECISION-RECOMMENDATION"]);
  if (rest.missing.length > 0) {
    return { outcome: "BLOCK", reasonCode: "REQUIRED_EVIDENCE_MISSING", rationale: `Evidence obligations for this cohort are unmet: ${rest.missing.join(", ")}.` };
  }
  const staleObligations = [...ownershipGaps.expired, ...eddGaps.expired, ...rest.expired];
  if (staleObligations.length > 0) {
    return { outcome: "REVIEW", reasonCode: "EVIDENCE_EXPIRED", rationale: `Evidence has aged out of its window and needs refreshing: ${staleObligations.join(", ")}.` };
  }
  if (snapshot.contradictions.some((item) => item.materiality === "HIGH" && item.status === "OPEN")) {
    return { outcome: "REVIEW", reasonCode: "MATERIAL_CONTRADICTION", rationale: "The case contradicts itself on something that matters; a recommendation would be built on sand." };
  }
  return { outcome: "ALLOW", reasonCode: "DECISION_PRECONDITIONS_SATISFIED", rationale: "Policy, screening, investigation and evidence are complete enough for a recommendation to be worth making." };
}

function adjudicateDisposition(snapshot: KycCaseAggregate, catalog: PolicyCatalog, cohortId: string | null): Verdict {
  if (snapshot.evaluationError !== null) {
    return { outcome: "ERROR", reasonCode: "POLICY_EVALUATION_ERROR", rationale: "The engine failed, so there is no decision and the case does not move." };
  }
  if (snapshot.policyConfiguration?.productionReady !== true) {
    return { outcome: "ERROR", reasonCode: "PRODUCTION_POLICY_CONFIGURATION_UNRESOLVED", rationale: "The bundle is still a candidate; an undecided policy decides nothing about a customer." };
  }
  if (snapshot.currentSequence === null) {
    return { outcome: "REVIEW", reasonCode: "POLICY_UNKNOWN_INPUT", rationale: "Whether this read is current cannot be established, so it fails closed." };
  }
  if (snapshot.currentSequence > snapshot.caseSequence) {
    return { outcome: "ERROR", reasonCode: "CASE_SNAPSHOT_STALE", rationale: "The case moved on after this read; a disposition on a superseded view is not a decision at all." };
  }
  const open = snapshot.findings.filter((finding) => finding.status === "OPEN");
  if (open.some((finding) => finding.findingType === "CONFIRMED_SANCTIONS_MATCH")) {
    return { outcome: "REVIEW", reasonCode: "CONFIRMED_SANCTIONS_MATCH", rationale: "A confirmed match is escalated to sanctions authority; the platform decides nothing here, including decline." };
  }
  if (open.some((finding) => finding.findingType === "POSSIBLE_SANCTIONS_MATCH")) {
    return { outcome: "REVIEW", reasonCode: "POSSIBLE_SANCTIONS_MATCH", rationale: "An unadjudicated sanctions alert outranks everything else on the case." };
  }
  if (open.some((finding) => finding.findingType === "IDENTITY_CONFLICT")) {
    return { outcome: "REVIEW", reasonCode: "IDENTITY_CONFLICT", rationale: "If it is unclear who the customer is, nothing else about the case can be relied on." };
  }
  if (snapshot.contradictions.some((item) => item.materiality === "HIGH" && item.status === "OPEN")) {
    return { outcome: "REVIEW", reasonCode: "MATERIAL_CONTRADICTION", rationale: "An open material contradiction has to be resolved by a person before any disposition." };
  }
  const recommendation = snapshot.recommendation;
  if (recommendation === null) {
    return { outcome: "BLOCK", reasonCode: "RECOMMENDATION_MISSING", rationale: "There is nothing to dispose of; no recommendation was produced." };
  }
  if (!["APPROVE", "REVIEW", "DECLINE"].includes(recommendation.outcome)) {
    return { outcome: "REVIEW", reasonCode: "POLICY_UNKNOWN_INPUT", rationale: "The recommendation is not one the policy recognises." };
  }
  if (recommendation.outcome === "DECLINE") {
    return { outcome: "REVIEW", reasonCode: "DECLINE_REQUIRES_HUMAN_AUTHORITY", rationale: "An agent may recommend a decline; only a person under dual control may make one." };
  }
  if (recommendation.requiresHumanReview === null) {
    return { outcome: "REVIEW", reasonCode: "POLICY_UNKNOWN_INPUT", rationale: "Whether the recommendation wanted a human is undetermined, so it gets one." };
  }
  if (recommendation.requiresHumanReview === true) {
    return { outcome: "REVIEW", reasonCode: "HUMAN_REVIEW_REQUIRED", rationale: "The recommendation asked for a human; that request is honoured." };
  }
  if (recommendation.outcome === "REVIEW") {
    return { outcome: "REVIEW", reasonCode: "HUMAN_REVIEW_REQUIRED", rationale: "The recommendation is itself a request for review." };
  }
  if (open.some((finding) => finding.findingType === "PEP_SIGNAL")) {
    return { outcome: "REVIEW", reasonCode: "PEP_REVIEW_REQUIRED", rationale: "A politically exposed relationship takes the review path however clean the rest looks." };
  }
  if (open.some((finding) => finding.findingType === "ADVERSE_MEDIA")) {
    return { outcome: "REVIEW", reasonCode: "ADVERSE_MEDIA_REVIEW_REQUIRED", rationale: "Adverse media needs a person to judge relevance and attribution." };
  }
  const jurisdictionRisk = snapshot.risk?.jurisdictionRisk ?? null;
  if (jurisdictionRisk === "HIGH") {
    return { outcome: "REVIEW", reasonCode: "HIGH_RISK_JURISDICTION_REVIEW", rationale: "High-risk jurisdiction exposure is reviewed by a person, not by a gate." };
  }
  if (jurisdictionRisk === null) {
    return { outcome: "REVIEW", reasonCode: "POLICY_UNKNOWN_INPUT", rationale: "Jurisdiction risk is undetermined, so the case fails closed." };
  }
  // From here the recommendation is a clean APPROVE; everything left is the approval bar.
  if (cohortId === null) {
    return { outcome: "REVIEW", reasonCode: "POLICY_UNKNOWN_INPUT", rationale: "The cohort is undetermined, so automatic-approval scope cannot be established." };
  }
  const cohort = catalog.riskCohorts.get(cohortId)!;
  if (!cohort.automaticApprovalEligible) {
    return { outcome: "REVIEW", reasonCode: "COHORT_NOT_ELIGIBLE_FOR_AUTOMATIC_APPROVAL", rationale: `${cohortId} is outside the attested automatic-approval scope, so a person approves it.` };
  }
  const attestation = snapshot.attestation;
  const attestationValid = attestation !== null
    && attestation.cohortId === cohortId
    && attestation.status === "VALID"
    && (attestation.expiresAt === null || Date.parse(attestation.expiresAt) >= Date.parse(snapshot.evaluatedAt));
  if (cohort.requiresAttestation && !attestationValid) {
    return { outcome: "REVIEW", reasonCode: "AUTOMATIC_APPROVAL_ATTESTATION_MISSING", rationale: "Without a current attestation covering this cohort, automatic approval has no mandate." };
  }
  const citationsComplete = recommendation.policyRuleRefs.length > 0 && recommendation.evidenceRefs.length > 0;
  if (!citationsComplete) {
    return { outcome: "REVIEW", reasonCode: "RECOMMENDATION_CITATIONS_INCOMPLETE", rationale: "An uncited recommendation cannot be checked, so it cannot be acted on automatically." };
  }
  const minimumConfidence = catalog.ownerInputs.get("D07")!.placeholder.minimumConfidence as number;
  if (recommendation.confidence === null) {
    return { outcome: "REVIEW", reasonCode: "POLICY_UNKNOWN_INPUT", rationale: "Recommendation confidence is undetermined." };
  }
  if (recommendation.confidence < minimumConfidence) {
    return { outcome: "REVIEW", reasonCode: "CONFIDENCE_BELOW_THRESHOLD", rationale: "Below the threshold the recommendation is advisory, not dispositive." };
  }
  const gaps = obligationGaps(snapshot, catalog, cohortId, null, ["EVD-QA-REVIEW"]);
  if (gaps.missing.length > 0) {
    return { outcome: "REVIEW", reasonCode: "APPROVAL_REQUIREMENTS_NOT_MET", rationale: `Approval requirements are unmet: ${gaps.missing.join(", ")}.` };
  }
  if (gaps.expired.length > 0) {
    return { outcome: "REVIEW", reasonCode: "EVIDENCE_EXPIRED", rationale: `Approval evidence has aged out and needs refreshing: ${gaps.expired.join(", ")}.` };
  }
  return { outcome: "ALLOW", reasonCode: "KYC_REQUIREMENTS_SATISFIED", rationale: "Every obligation is satisfied, nothing adverse is open, and an attestation covers this cohort, so the gate may approve." };
}

function adjudicate(spec: CaseSpec, snapshot: KycCaseAggregate, catalog: PolicyCatalog): CorpusExpectation[] {
  const cohortId = spec.riskCohort;
  const upTo = GATE_ORDER.indexOf(spec.targetGate);
  const verdicts: Record<GateId, Verdict> = {
    "screening-ready": adjudicateScreeningReady(snapshot, catalog),
    "decision-ready": adjudicateDecisionReady(snapshot, catalog, cohortId),
    disposition: adjudicateDisposition(snapshot, catalog, cohortId),
  };
  return GATE_ORDER.slice(0, upTo + 1).map((gate) => ({ gate, ...verdicts[gate] }));
}

// ------------------------------------------------------------------ case specifications

const RISK_PROFILES: Record<string, Omit<CaseSpec, "id" | "riskCohort" | "failureCohorts" | "tags" | "targetGate">> = {
  "RC-LOW-STANDARD-INDIVIDUAL": { customerType: "individual", riskTier: "standard", jurisdictionRisk: "LOW", productRisk: "LOW", pepExposure: false },
  "RC-STANDARD-INDIVIDUAL": { customerType: "individual", riskTier: "standard", jurisdictionRisk: "MEDIUM", productRisk: "MEDIUM", pepExposure: false },
  "RC-ELEVATED-INDIVIDUAL": { customerType: "individual", riskTier: "elevated", jurisdictionRisk: "MEDIUM", productRisk: "MEDIUM", pepExposure: false },
  "RC-HIGH-INDIVIDUAL": { customerType: "individual", riskTier: "high", jurisdictionRisk: "MEDIUM", productRisk: "HIGH", pepExposure: false },
  "RC-SOLE-PROPRIETOR-STANDARD": { customerType: "sole_proprietor", riskTier: "standard", jurisdictionRisk: "LOW", productRisk: "LOW", pepExposure: false },
  "RC-SOLE-PROPRIETOR-ELEVATED": { customerType: "sole_proprietor", riskTier: "elevated", jurisdictionRisk: "MEDIUM", productRisk: "MEDIUM", pepExposure: false },
  "RC-HIGH-RISK-JURISDICTION": { customerType: "individual", riskTier: "elevated", jurisdictionRisk: "HIGH", productRisk: "MEDIUM", pepExposure: false },
  "RC-PEP-ADJACENT": { customerType: "individual", riskTier: "elevated", jurisdictionRisk: "MEDIUM", productRisk: "MEDIUM", pepExposure: true },
};

/** Cohorts whose disposition can reach the approval path, used by the approval-bar failures. */
const ELIGIBLE_COHORTS = ["RC-LOW-STANDARD-INDIVIDUAL"];
const INELIGIBLE_COHORTS = [
  "RC-STANDARD-INDIVIDUAL",
  "RC-ELEVATED-INDIVIDUAL",
  "RC-HIGH-INDIVIDUAL",
  "RC-SOLE-PROPRIETOR-STANDARD",
  "RC-SOLE-PROPRIETOR-ELEVATED",
];
const ALL_COHORTS = Object.keys(RISK_PROFILES);

interface FailureRecipe {
  cohortPool: string[];
  targetGate: GateId;
  /** index lets a recipe vary its cases so the corpus is not N copies of one row. */
  mutate: (index: number) => Partial<CaseSpec>;
}

const FAILURE_RECIPES: Record<string, FailureRecipe> = {
  "FC-PROVIDER-OUTAGE": {
    cohortPool: ALL_COHORTS,
    targetGate: "decision-ready",
    mutate: (index) => {
      const provider = (["sanctions", "pep", "adverseMedia"] as const)[index % 3]!;
      const status: ProviderStatus = index % 2 === 0 ? "UNAVAILABLE" : "DEGRADED";
      return { providerStatus: { [provider]: status } };
    },
  },
  "FC-SANCTIONS-LIST-STALE": {
    cohortPool: ALL_COHORTS,
    targetGate: "decision-ready",
    mutate: (index) => ({ sanctionsListAgeDays: 3 + index }),
  },
  "FC-POLICY-DIGEST-MISMATCH": {
    cohortPool: ALL_COHORTS,
    targetGate: "screening-ready",
    mutate: () => ({ claimDigestMismatch: true }),
  },
  "FC-MISSING-POLICY-AUTHORITY": {
    cohortPool: ALL_COHORTS,
    targetGate: "screening-ready",
    mutate: () => ({ omitPolicyEvidence: true }),
  },
  "FC-MISSING-EVIDENCE": {
    cohortPool: ALL_COHORTS,
    targetGate: "decision-ready",
    mutate: (index) => {
      const pool = ["EVD-IDENTITY-VERIFICATION", "EVD-CIP-ADDRESS", "EVD-RELATIONSHIP-PURPOSE", "EVD-CIP-TIN"];
      return { omitObligations: [pool[index % pool.length]!] };
    },
  },
  "FC-EVIDENCE-EXPIRED": {
    cohortPool: ALL_COHORTS,
    targetGate: "decision-ready",
    // Old enough to age out the 30-day screening evidence while the longer-lived
    // obligations stay comfortably inside their windows.
    mutate: (index) => ({ evidenceAgeDays: 45 + index }),
  },
  "FC-INVESTIGATION-INCOMPLETE": {
    cohortPool: ALL_COHORTS,
    targetGate: "decision-ready",
    mutate: (index) => ({ investigationWorkItem: index % 2 === 0 ? "IN_PROGRESS" : "ABSENT" }),
  },
  "FC-CONTRADICTION": {
    cohortPool: ALL_COHORTS,
    targetGate: "decision-ready",
    mutate: () => ({ contradiction: "HIGH_OPEN" }),
  },
  "FC-IDENTITY-CONFLICT": {
    cohortPool: ALL_COHORTS,
    targetGate: "disposition",
    mutate: () => ({ findings: [{ findingType: "IDENTITY_CONFLICT", status: "OPEN" }] }),
  },
  "FC-SANCTIONS-POSSIBLE": {
    cohortPool: ALL_COHORTS,
    targetGate: "disposition",
    mutate: () => ({ findings: [{ findingType: "POSSIBLE_SANCTIONS_MATCH", status: "OPEN" }] }),
  },
  "FC-SANCTIONS-CONFIRMED": {
    cohortPool: ALL_COHORTS,
    targetGate: "disposition",
    // A confirmed match alongside a decline recommendation: the sanctions row must still win,
    // and neither row may produce an automatic decline.
    mutate: (index) => ({
      findings: [{ findingType: "CONFIRMED_SANCTIONS_MATCH", status: "OPEN" }],
      ...(index % 2 === 0 ? { recommendation: "DECLINE" as const, citations: "COMPLETE" as const } : {}),
    }),
  },
  "FC-PEP-SIGNAL": {
    cohortPool: ALL_COHORTS,
    targetGate: "disposition",
    mutate: () => ({ findings: [{ findingType: "PEP_SIGNAL", status: "OPEN" }] }),
  },
  "FC-ADVERSE-MEDIA": {
    cohortPool: ALL_COHORTS,
    targetGate: "disposition",
    mutate: () => ({ findings: [{ findingType: "ADVERSE_MEDIA", status: "OPEN" }] }),
  },
  "FC-AGENT-DECLINE-RECOMMENDATION": {
    cohortPool: ALL_COHORTS,
    targetGate: "disposition",
    mutate: () => ({ recommendation: "DECLINE" }),
  },
  "FC-MALFORMED-RECOMMENDATION": {
    cohortPool: ELIGIBLE_COHORTS,
    targetGate: "disposition",
    mutate: (index) => ({ citations: index % 2 === 0 ? "NO_POLICY" : "NO_EVIDENCE" }),
  },
  "FC-MISSING-RECOMMENDATION": {
    cohortPool: ALL_COHORTS,
    targetGate: "disposition",
    mutate: () => ({ recommendation: "ABSENT" }),
  },
  "FC-LOW-CONFIDENCE": {
    cohortPool: ELIGIBLE_COHORTS,
    targetGate: "disposition",
    mutate: (index) => ({ confidence: 0.5 + index * 0.02 }),
  },
  "FC-APPROVAL-REQUIREMENTS-UNMET": {
    cohortPool: ELIGIBLE_COHORTS,
    targetGate: "disposition",
    // Decision readiness excludes the recommendation evidence because at that point there is
    // no recommendation to evidence. The approval bar does not, so a recommendation that was
    // never evidenced passes the earlier gate and fails this one.
    mutate: () => ({ omitObligations: ["EVD-DECISION-RECOMMENDATION"] }),
  },
  "FC-UNATTESTED-COHORT": {
    cohortPool: ELIGIBLE_COHORTS,
    targetGate: "disposition",
    mutate: (index) => ({ attestation: (["MISSING", "EXPIRED", "WRONG_COHORT"] as const)[index % 3]! }),
  },
  "FC-INELIGIBLE-COHORT": {
    cohortPool: INELIGIBLE_COHORTS,
    targetGate: "disposition",
    mutate: () => ({}),
  },
  "FC-UNKNOWN-INPUT": {
    cohortPool: ALL_COHORTS,
    targetGate: "disposition",
    mutate: () => ({ requiresHumanReview: null }),
  },
  "FC-STALE-SNAPSHOT": {
    cohortPool: ALL_COHORTS,
    targetGate: "disposition",
    mutate: () => ({ staleSnapshot: true }),
  },
  "FC-UNRESOLVED-CONFIGURATION": {
    cohortPool: ALL_COHORTS,
    targetGate: "disposition",
    mutate: (index) => ({ productionReady: index % 2 === 0 ? false : null }),
  },
  "FC-EVALUATION-ERROR": {
    cohortPool: ALL_COHORTS,
    targetGate: "disposition",
    mutate: () => ({ evaluationError: "case_snapshot_assembly_failed" }),
  },
};

/**
 * Near-misses and boundaries. Each one is a case a reader might expect to trip a rule and
 * which must not, or a value sitting exactly on a limit where a `>` in place of a `>=`
 * would change the answer.
 */
const VOLUME_VARIANTS: { name: string; targetGate?: GateId; mutate: Partial<CaseSpec> }[] = [
  { name: "clean", mutate: {} },
  { name: "contradiction_resolved", targetGate: "disposition", mutate: { contradiction: "HIGH_RESOLVED" } },
  { name: "contradiction_medium_open", targetGate: "disposition", mutate: { contradiction: "MEDIUM_OPEN" } },
  { name: "sanctions_finding_resolved", targetGate: "disposition", mutate: { findings: [{ findingType: "POSSIBLE_SANCTIONS_MATCH", status: "RESOLVED" }] } },
  { name: "pep_finding_resolved", targetGate: "disposition", mutate: { findings: [{ findingType: "PEP_SIGNAL", status: "RESOLVED" }] } },
  { name: "no_material_match_finding", targetGate: "disposition", mutate: { findings: [{ findingType: "NO_MATERIAL_MATCH", status: "OPEN" }] } },
  { name: "confidence_at_threshold", targetGate: "disposition", mutate: { confidence: 0.85 } },
  { name: "evidence_at_freshness_limit", targetGate: "disposition", mutate: { evidenceAgeDays: 30 } },
  { name: "policy_evidence_at_limit", targetGate: "screening-ready", mutate: { policyEvidenceAgeDays: 1 } },
  { name: "sanctions_list_at_limit", targetGate: "decision-ready", mutate: { sanctionsListAgeDays: 1 } },
  { name: "recommendation_review", targetGate: "disposition", mutate: { recommendation: "REVIEW" } },
  { name: "requires_human_review", targetGate: "disposition", mutate: { requiresHumanReview: true } },
];

function specsFor(catalog: PolicyCatalog): CaseSpec[] {
  const specs: CaseSpec[] = [];
  const riskCounts = new Map<string, number>(ALL_COHORTS.map((cohort) => [cohort, 0]));
  let ordinal = 0;

  const push = (spec: CaseSpec) => {
    specs.push(spec);
    riskCounts.set(spec.riskCohort, (riskCounts.get(spec.riskCohort) ?? 0) + 1);
  };

  // Clean cases first, one per cohort at each gate depth, so the corpus opens with what a
  // correct case looks like rather than with the exceptions.
  for (const cohortId of ALL_COHORTS) {
    for (const targetGate of GATE_ORDER) {
      ordinal += 1;
      push({
        id: `corpus_${String(ordinal).padStart(4, "0")}_clean_${cohortId.toLowerCase()}_${targetGate}`,
        riskCohort: cohortId,
        failureCohorts: [],
        tags: ["clean", targetGate],
        targetGate,
        ...RISK_PROFILES[cohortId]!,
      });
    }
  }

  // Then every failure cohort, at least to its declared minimum.
  for (const [failureId, recipe] of Object.entries(FAILURE_RECIPES)) {
    const required = catalog.failureCohorts.get(failureId)?.minimumCorpusCases ?? 0;
    for (let index = 0; index < required; index += 1) {
      const cohortId = recipe.cohortPool[index % recipe.cohortPool.length]!;
      ordinal += 1;
      push({
        id: `corpus_${String(ordinal).padStart(4, "0")}_${failureId.toLowerCase()}_${index}`,
        riskCohort: cohortId,
        failureCohorts: [failureId],
        tags: ["failure", failureId, recipe.targetGate],
        targetGate: recipe.targetGate,
        ...RISK_PROFILES[cohortId]!,
        ...recipe.mutate(index),
      });
    }
  }

  // Every boundary and near-miss, in every cohort. These are the cases that ought NOT to
  // change an outcome -- a contradiction that was resolved, a finding that was dismissed,
  // evidence sitting exactly on its freshness limit, confidence exactly at the threshold --
  // and a table that is one comparison out fails these and nothing else. They run for every
  // cohort rather than only where the count is short, because the failure recipes cluster in
  // some cohorts and would otherwise leave the clean approval path barely exercised.
  for (const cohortId of ALL_COHORTS) {
    for (const [index, variant] of VOLUME_VARIANTS.entries()) {
      const targetGate = variant.targetGate ?? GATE_ORDER[index % GATE_ORDER.length]!;
      ordinal += 1;
      push({
        id: `corpus_${String(ordinal).padStart(4, "0")}_${variant.name}_${cohortId.toLowerCase()}`,
        riskCohort: cohortId,
        failureCohorts: [],
        tags: ["boundary", variant.name, targetGate],
        targetGate,
        ...RISK_PROFILES[cohortId]!,
        ...variant.mutate,
      });
    }
  }

  // Then top any cohort still short of its declared minimum up with plain clean cases.
  for (const cohortId of ALL_COHORTS) {
    const required = catalog.riskCohorts.get(cohortId)?.minimumCorpusCases ?? 0;
    let index = 0;
    while ((riskCounts.get(cohortId) ?? 0) < required) {
      const targetGate = GATE_ORDER[index % GATE_ORDER.length]!;
      ordinal += 1;
      push({
        id: `corpus_${String(ordinal).padStart(4, "0")}_volume_${cohortId.toLowerCase()}_${index}`,
        riskCohort: cohortId,
        failureCohorts: [],
        tags: ["clean", "volume", targetGate],
        targetGate,
        ...RISK_PROFILES[cohortId]!,
      });
      index += 1;
    }
  }

  return specs;
}

// ------------------------------------------------------------------ entry point

export function buildCorpus(catalog: PolicyCatalog = kycPolicyCatalog()): CorpusCase[] {
  return specsFor(catalog).map((spec) => {
    const snapshot = buildSnapshot(spec, catalog);
    return {
      caseId: spec.id,
      riskCohort: spec.riskCohort,
      failureCohorts: spec.failureCohorts,
      tags: spec.tags,
      adjudication: {
        adjudicatedBy: "kyc-policy-operations",
        adjudicatedAt: EVALUATED_AT,
        method: "policy-owner rubric, independent of the decision tables",
      },
      snapshot,
      expectations: adjudicate(spec, snapshot, catalog),
    };
  });
}
