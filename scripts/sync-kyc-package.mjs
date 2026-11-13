#!/usr/bin/env node
// ARCHIVED: the deterministic KYC flow is frozen (domains/archive/README.md). This generator is kept so
// the archived package regenerates byte-identically; its GENERATED header text is frozen with it.
// Generates domains/archive/kyc-v2-deterministic (package.yaml, workflow.yaml) — individual KYC (CDD onboarding) on the
// financial-crime skill library — from the library-format workflow in
// domains/archive/kyc-v2-deterministic/source/kyc-workflow.json, the vendored manifests of the skills it uses
// (domains/archive/kyc-v2-deterministic/library/skills.json) and the platform overlay below.
//
//   node scripts/sync-kyc-package.mjs [--library <financial-crime skills checkout>] [--check]
//
// --library  refresh domains/archive/kyc-v2-deterministic/library/skills.json from the library's catalog/catalog.json
//            (the workflow is authored on the platform side; every step's skill must exist in
//            the catalog). Without it the vendored snapshot is the source.
// --check    write nothing; exit 1 when the committed package differs from what would be generated.
//
// Platform overlay (domains/archive/kyc-v2-deterministic/README.md):
// - connector acquisition stages that write canonical records (identity, screening);
// - the pinned US KYC policy bundle (policy.kyc.customer-acceptance.v1) used twice: as OPA
//   decision-table gates between the library stages (screening-ready, decision-ready,
//   disposition), and to hydrate each library skill's `policy` context section
//   (`config.skillPolicy`: the bundle's values projected to the manifest's
//   policy_context_fields, resolved at run time by packages/context-plane/src/policy.ts);
// - a durable dual-control approval after the human-gated disposition skill.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { assertRegistrySnapshot, buildLibraryPackage, createEmitter, json, nodeId, parseArgs, readJson, repoRoot, toYaml, vendoredSkills } from "./lib/library-package.mjs";

const { check, libraryRoot } = parseArgs(process.argv.slice(2));
const domainRoot = resolve(repoRoot, "domains/archive/kyc-v2-deterministic");
const vendorRoot = resolve(domainRoot, "library");
const { emit, state } = createEmitter(check);

const workflow = readJson(resolve(domainRoot, "source/kyc-workflow.json"));
if (libraryRoot) { // always set: --library or apps/fincrime-host
  emit(resolve(vendorRoot, "skills.json"), json(vendoredSkills({ libraryRoot, workflow, files: ["catalog/catalog.json"] })));
}
const library = readJson(resolve(vendorRoot, "skills.json"));
assertRegistrySnapshot(library);
const libraryIds = new Set(library.skills.map((skill) => skill.id));
for (const step of workflow.steps) {
  if (!libraryIds.has(step.skill_id)) throw new Error(`kyc.library_skill_missing:${step.skill_id} (refresh with --library)`);
}

// ---------------------------------------------------------------------------
// The pinned policy bundle (the same one the OPA gates evaluate).
// ---------------------------------------------------------------------------
const binding = parseYaml(readFileSync(resolve(domainRoot, "policy-binding.yaml"), "utf8"));
const bundleManifest = readJson(resolve(repoRoot, "artifacts/policy/kyc/manifest.unsigned.json"));
const bundleData = readJson(resolve(repoRoot, "artifacts/policy/kyc/data.json")).harness.decision_table.catalog;
const policySource = parseYaml(readFileSync(resolve(repoRoot, "domains/kyc/policy/policy.yaml"), "utf8"));
if (bundleManifest.bundleDigest !== binding.bundleDigest || bundleManifest.policyId !== binding.policyId || bundleData.policy_id !== binding.policyId) {
  throw new Error("kyc.policy_bundle_mismatch: artifacts/policy/kyc does not match domains/archive/kyc-v2-deterministic/policy-binding.yaml");
}
const DAY = 86_400;
const owner = (id) => bundleData.owner_inputs[id] ?? (() => { throw new Error(`kyc.owner_input_missing:${id}`); })();
const effects = [...new Set(library.skills.map((skill) => skill.effects).filter((effect) => effect !== "read_only"))].sort();

// Library policy field -> value from the pinned bundle. Fields absent here have no source in the
// US KYC bundle: a skill that needs one is not called (POLICY_UNRESOLVED), never given a guess.
const documentRequirements = parseYaml(readFileSync(resolve(repoRoot, "domains/kyc/policy/catalog/document-requirements.yaml"), "utf8"));
const POLICY_VALUES = {
  version: { value: bundleData.policy_version, source: "catalog.policy_version" },
  jurisdiction: { value: policySource.metadata.jurisdiction, source: "policy.yaml metadata.jurisdiction" },
  // The platform has already authorised exactly these skills for the case (plan skill bindings).
  permissions: { value: [...[...libraryIds].sort().map((id) => `skill:${id}`), ...effects.map((effect) => `effect:${effect}`)], source: "plan.skillBindings" },
  freshness_seconds: {
    value: { WatchlistEntry: owner("D01").listFreshnessDays * DAY, VerificationRecord: owner("D05").identityVerificationDays * DAY },
    source: "owner_inputs.D01.listFreshnessDays, owner_inputs.D05.identityVerificationDays (days to seconds)",
  },
  screening_threshold: { value: owner("D01").possibleMatchScore, source: "owner_inputs.D01.possibleMatchScore" },
  customer_types: {
    value: Object.fromEntries([...new Set(Object.values(bundleData.risk_cohorts).map((cohort) => cohort.selector.customerType).filter((type) => typeof type === "string"))].sort().map((type) => [type, "KYC"])),
    source: "risk_cohorts[].selector.customerType",
  },
  // Documentary obligations as catalog document types (domains/kyc/policy/catalog/document-requirements.yaml),
  // in the library policy's versioned extension: document.requirements.resolve reads them as
  // any-of groups. No flat required type: each obligation accepts alternatives.
  required_document_types: { value: [], source: "document-requirements.yaml (any-of groups only)" },
  extensions: {
    value: { "ehf.document": { schema_version: "1.0.0", value: { document_requirements: documentRequirements.requirements.map((item) => ({
      id: item.obligation, description: item.description, any_of: item.anyOf })) } } },
    source: `catalog/document-requirements.yaml (${documentRequirements.status})`,
  },
  requirements: {
    value: Object.values(bundleData.obligations).filter((obligation) => obligation.requiredFor.includes("*")).map((obligation) => ({ id: obligation.id, description: obligation.name })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    source: "obligations[requiredFor *]",
  },
};
// Library policy field -> value computed per case by the policy engine: the review interval
// depends on the case's risk cohort, which packages/policy-engine assigns from the case
// (assignRiskCohort, the same assignment the OPA gates use). A cohort without a risk-tier
// selector has no interval in the bundle and stays unresolved.
const reviewMonths = { standard: owner("D09").standardReviewMonths, elevated: owner("D09").elevatedReviewMonths, high: owner("D09").highReviewMonths };
const POLICY_COMPUTED = {
  review_interval_seconds: {
    kind: "cohortTable",
    table: Object.fromEntries(Object.values(bundleData.risk_cohorts)
      .filter((cohort) => typeof cohort.selector.riskTier === "string" && reviewMonths[cohort.selector.riskTier] !== undefined)
      .map((cohort) => [cohort.id, reviewMonths[cohort.selector.riskTier] * 30 * DAY])
      .sort(([a], [b]) => (a < b ? -1 : 1))),
    source: "owner_inputs.D09 by the cohort's riskTier (30-day months, to seconds)",
  },
};
const cohortCatalog = {
  precedence: bundleData.cohort_precedence,
  requiredAttributes: bundleData.cohort_required_attributes,
  attributePaths: bundleData.cohort_attribute_paths,
  selectors: Object.fromEntries(Object.values(bundleData.risk_cohorts).map((cohort) => [cohort.id, cohort.selector]).sort(([a], [b]) => (a < b ? -1 : 1))),
};

function skillPolicyFor(manifest) {
  const fields = [...(manifest.policy_context_fields ?? [])].sort();
  const values = {};
  const computed = {};
  const sources = {};
  for (const field of fields) {
    if (POLICY_VALUES[field]) {
      values[field] = POLICY_VALUES[field].value;
      sources[field] = POLICY_VALUES[field].source;
    } else if (POLICY_COMPUTED[field]) {
      const { source, ...rule } = POLICY_COMPUTED[field];
      computed[field] = rule;
      sources[field] = source;
    }
  }
  return {
    policyRef: binding.policyId,
    policyVersion: binding.policyVersion,
    bundleDigest: binding.bundleDigest,
    fields,
    values,
    ...(Object.keys(computed).length ? {
      computed,
      cohorts: cohortCatalog,
      // Where the cohort attributes live in the case: subject attributes and the single active
      // kyc_risk_profile fact (the same reading as the gate input mapping in apps/case-api).
      cohortInputs: { subject: { selector: "kycSubjects", path: "0.attributes" }, risk: { selector: "policyFacts", fact: "kyc_risk_profile" } },
    } : {}),
    sources,
    unresolved: fields.filter((field) => !POLICY_VALUES[field] && !POLICY_COMPUTED[field]),
  };
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------
const PURPOSE = "KYC_ONBOARDING";
const bankingPolicy = readJson(resolve(repoRoot, "domains/fincrime/banking-policy.json"));
const ACQUIRE = "KYC_SCREENING";
const recordsAndGap = { records: { type: "array", items: { type: "object" } }, recordGap: { type: ["object", "null"] } };
const wiringOutput = {
  type: "object",
  required: ["operationId", "outcome", "bankDecision", "coverage", "evidenceRefs", "warnings", "records", "recordGap"],
  properties: {
    operationId: { type: "string" },
    outcome: { type: "string", enum: ["passed", "failed", "review", "resubmit", "inconclusive", "not_checked", "not_applicable", "unknown"] },
    bankDecision: { type: "string", const: "not_evaluated" },
    coverage: { type: "object" },
    evidenceRefs: { type: "array", items: { type: "object" } },
    warnings: { type: "array", items: { type: "string" } },
    ...recordsAndGap,
  },
};
const personInput = { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1 }, country: { type: "string" }, dateOfBirth: { type: "string" } } };
const openSanctionsOutput = (screeningType) => ({
  type: "object", required: ["status", "provider", "screeningType", "screenedAt", "alerts", "records", "recordGap"],
  properties: { status: { type: "string" }, provider: { type: "string" }, screeningType: { type: "string", const: screeningType }, screenedAt: { type: "string", format: "date-time" }, alerts: { type: "array", items: { type: "object" } }, ...recordsAndGap },
});
const finding = (connectorId, findingType, classification, reason, policyRelevance, when, confidence = 0.8) => ({
  commandType: "RecordScreeningFinding", when,
  payload: {
    findingId: `finding_${findingType.toLowerCase()}_${connectorId.replaceAll("-", "_")}_{{ run.runId }}`, findingType, classification,
    confidence: { value: confidence, method: "connector_outcome" }, reason, evidenceRefs: ["{{ evidence.evidenceId }}"], factRefs: [], policyRelevance,
  },
  payloadSchema: { type: "object", required: ["findingId", "findingType", "reason", "evidenceRefs"] },
});
const link = (purpose, when) => ({ commandType: "LinkEvidence", ...(when ? { when } : {}), payload: { evidenceId: "{{ evidence.evidenceId }}", purpose }, payloadSchema: { type: "object", required: ["evidenceId", "purpose"] } });
const recordWrite = { commandType: "RecordCanonicalRecords", when: "output.records.0", payload: { records: "{{ output.records }}", evidenceRefs: ["{{ evidence.evidenceId }}"] }, payloadSchema: { type: "object", required: ["records", "evidenceRefs"] } };

// Each connector links its captured output under the policy evidence purpose the OPA gates read
// (domains/kyc/policy/catalog/evidence-obligations.yaml), writes the normalized records, and
// records an incomplete-screen finding when it established nothing — the gate input mapping
// (apps/case-api/src/policy-evaluator.ts policyAggregate) then treats that screen as missing,
// never as clear. Provider alerts are REVIEW findings the disposition gate escalates.
const connectors = [
  {
    id: "acquire-identity", stage: "identity", capability: "identity.document.verify.v1", connector: "wiring:persona:identity.document.verify",
    name: "Identity document verification", records: "VerificationRecord", input: personInput, output: wiringOutput, timeoutMs: 60000,
    selectors: ["name", "country", "dateOfBirth"],
    writes: (id) => [
      // Only a positive verification discharges EVD-IDENTITY-VERIFICATION; anything else is kept
      // as an attempt and an open finding.
      link("KYC_IDENTITY_VERIFICATION", "output.outcome == \"passed\""),
      link("KYC_IDENTITY_VERIFICATION_ATTEMPT", "output.outcome != \"passed\""),
      recordWrite,
      finding(id, "IDENTITY_DOCUMENT_NOT_VERIFIED", "REVIEW", "The identity connector did not positively verify the document (outcome {{ output.outcome }}).", "KYC-CIP-001", "output.outcome != \"passed\""),
    ],
  },
  {
    id: "acquire-documents", stage: "identity", capability: "document.evidence.package.v1", connector: "evidence:package",
    name: "Document evidence package", records: "DocumentVersion, DocumentPage, Evidence", selectors: ["caseId"], timeoutMs: 30000,
    input: { type: "object", required: ["caseId"], properties: { caseId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$" } } },
    output: { type: "object", required: ["operation", "status", "bankDecision", "data", "records", "recordGap"], properties: { operation: { type: "string" }, status: { type: "string" }, bankDecision: { type: "string", const: "not_evaluated" }, data: { type: "object" }, ...recordsAndGap } },
    // Pipeline output is TOOL evidence: it cannot discharge the CIP document obligations, which
    // accept only UPLOAD, HUMAN or INTERNAL_SYSTEM sources.
    writes: (id) => [link("KYC_DOCUMENT_EVIDENCE"), recordWrite, finding(id, "EVIDENCE_GAP", "REVIEW", "{{ output.recordGap.reason }}", "KYC-CIP-002", "output.recordGap", 1)],
  },
  {
    id: "acquire-sanctions", stage: "screening", capability: "screening.sanctions.v1", connector: "opensanctions:sanctions",
    name: "OpenSanctions sanctions screen", records: "WatchlistEntry, ScreeningHit or NegativeSearchEvidence", input: personInput, output: openSanctionsOutput("SANCTIONS"), timeoutMs: 15000,
    selectors: ["name", "country", "dateOfBirth"],
    writes: (id) => [
      link("KYC_SANCTIONS_SCREENING"), recordWrite,
      finding(id, "SANCTIONS_SCREEN_INCOMPLETE", "REVIEW", "{{ output.recordGap.reason }}", "KYC-SCR-002", "output.recordGap", 1),
      finding(id, "POSSIBLE_SANCTIONS_MATCH", "REVIEW", "OpenSanctions returned at least one sanctions or linked-entity candidate.", "KYC-SCR-003", "output.alerts.0"),
    ],
  },
  {
    id: "acquire-pep", stage: "screening", capability: "screening.pep.v1", connector: "opensanctions:pep",
    name: "OpenSanctions PEP screen", records: "WatchlistEntry, ScreeningHit or NegativeSearchEvidence", input: personInput, output: openSanctionsOutput("PEP"), timeoutMs: 15000,
    selectors: ["name", "country", "dateOfBirth"],
    writes: (id) => [
      link("KYC_PEP_SCREENING"), recordWrite,
      finding(id, "PEP_SCREEN_INCOMPLETE", "REVIEW", "{{ output.recordGap.reason }}", "KYC-SCR-002", "output.recordGap", 1),
      finding(id, "PEP_SIGNAL", "REVIEW", "OpenSanctions returned at least one politically exposed person candidate.", "KYC-EDD-002", "output.alerts.0"),
    ],
  },
  {
    id: "acquire-adverse-media", stage: "screening", capability: "screening.adverse_media.v1", connector: "wiring:complyadvantage:screening.adverse_media",
    name: "Adverse-media screen", records: "AdverseMediaEvent or NegativeSearchEvidence", input: personInput, output: wiringOutput, timeoutMs: 30000,
    selectors: ["name", "country", "dateOfBirth"],
    writes: (id) => [
      link("KYC_ADVERSE_MEDIA"), recordWrite,
      finding(id, "ADVERSE_MEDIA_SCREEN_INCOMPLETE", "REVIEW", "{{ output.recordGap.reason }}", "KYC-SCR-005", "output.recordGap", 1),
      finding(id, "ADVERSE_MEDIA", "REVIEW", "The adverse-media connector returned material adverse media for review.", "KYC-SCR-005", "output.outcome == \"review\""),
      finding(id, "ADVERSE_MEDIA", "REVIEW", "The adverse-media connector reported a failed screen; the subject needs review.", "KYC-SCR-005", "output.outcome == \"failed\""),
    ],
  },
];

function connectorNode(connector) {
  return {
    id: connector.id, kind: "tool", name: connector.name,
    summary: `Acquire through ${connector.connector}; write the normalized ${connector.records} records, or an incomplete-check finding when the check established nothing.`,
    contextSelectorIds: connector.stage === "screening" ? ["screeningSubjects"] : connector.selectors,
    capabilities: { tools: [connector.capability] },
    config: {
      ...(connector.stage === "screening" ? { subjectAcquisition: { subjectsSelector: "screeningSubjects", maxSubjects: 50 } } : {}),
      evidenceCapture: { type: `kyc_${connector.id.replaceAll("-", "_")}`, sourceType: "TOOL", trustTier: "VERIFIED_PROVIDER", instructionTrust: "UNTRUSTED_EXTERNAL" },
      caseWriteActor: "system",
      caseWritePrincipalId: "kyc-connector-normalizer",
      caseWrites: connector.writes(connector.id),
    },
  };
}

// ---------------------------------------------------------------------------
// OPA gates (decision-table gates of the pinned bundle) between the library stages.
// ---------------------------------------------------------------------------
const gate = (id, name, summary, caseWrites) => ({
  id, kind: "gate", name, summary, contextSelectorIds: ["policyGateContext"],
  config: { policyRef: binding.policyId, gateId: id, caseWriteActor: "system", caseWritePrincipalId: "policy-gate", caseWrites },
});
const transition = (toStatus, reason) => ({ commandType: "TransitionCaseStatus", when: "output.outcome == \"ALLOW\"", payload: { toStatus, reason }, payloadSchema: { type: "object", required: ["toStatus", "reason"] } });
const inserts = [
  { before: "entity_identity_verify", stage: "identity" },
  {
    before: "entity_resolve",
    gate: gate("screening-ready", "Screening readiness gate (OPA)", "Before screening: pinned policy authority, claim digest and CIP attributes on the canonical case. Anything but ALLOW ends the run.",
      [transition("SCREENING", "Screening readiness policy gate allowed the case to proceed.")]),
  },
  { before: "entity_resolve", stage: "screening" },
  {
    before: "decision_requirements_compile",
    checkpoint: { id: "banking-product-readiness", kind: "transform", name: "Banking product control readiness",
      contextSelectorIds: ["bankingRelationships", "bankingControls"], config: { operation: "select", path: "/", bankingAssessment: bankingPolicy } },
  },
  {
    before: "decision_requirements_compile",
    gate: gate("decision-ready", "Decision readiness gate (OPA)", "Before the library decision skills: policy context, screening coverage and freshness, investigation, evidence obligations and contradictions. Anything but ALLOW ends the run.",
      [transition("READY_FOR_DECISION", "Decision readiness policy gate confirmed a complete KYC packet.")]),
  },
  {
    before: "decision_disposition_record",
    // ALLOW stays subject to independent review; REVIEW and a configuration ERROR (a candidate
    // bundle) escalate to the same dual-control human approval; BLOCK and UNKNOWN end the run.
    continueOn: ["ALLOW", "REVIEW", "ERROR"],
    gate: gate("disposition", "Policy disposition gate (OPA)", "Before recording a disposition: what, if anything, the platform may reach without a human. No automatic decline; ALLOW, REVIEW and ERROR all go to dual-control human approval.", [
      {
        commandType: "RequestHumanReview", when: "output.outcome != \"BLOCK\"",
        payload: { objectRef: "case:{{ case.caseId }}", reason: "Disposition gate requires independent human review: {{ output.reasonCode }}", priority: "HIGH", evidenceRefs: [] },
        payloadSchema: { type: "object", required: ["objectRef", "reason", "evidenceRefs"] },
      },
    ]),
  },
];

// ---------------------------------------------------------------------------
// Skill nodes: policy section, parameters from case context, library output -> case.
// ---------------------------------------------------------------------------
// Library parameters a case value supplies (selector ids, read from the node's context).
const CONTEXT_BINDINGS = {
  entity_resolve: { name: "subjectName" },
  screening_name_normalize: { name: "subjectName" },
  screening_adverse_media_execute: { name: "subjectName" },
  risk_factor_evaluate: { value: "subjectCountry" },
  document_fields_contract_extract: { subject: "subjectId" },
};
function skillNode(step, manifest, node) {
  const contextBindings = CONTEXT_BINDINGS[step.id] ?? {};
  const skillPolicy = skillPolicyFor(manifest);
  const extraSelectors = [...new Set([...Object.values(contextBindings), ...(skillPolicy.cohortInputs ? ["policyFacts"] : [])])];
  const config = {
    ...node.config,
    ...(Object.keys(contextBindings).length ? { skillContextBindings: contextBindings } : {}),
    // Fail closed: a binding (step payload or case value) that resolves to nothing means the
    // skill is not called, instead of running on the authored default.
    requireBoundParameters: true,
    skillPolicy,
  };
  if (step.skill_id === "decision.recommendation.generate") {
    // The minimum adapter from the library's recommendation to the disposition gate's input
    // (`recommendation` on the case aggregate): the library vocabulary (REVIEW_FOR_ACCEPTANCE,
    // ESCALATE, COLLECT_EVIDENCE) never authorises an automatic approval, so it is submitted as
    // REVIEW with requiresHumanReview, citing the captured skill output.
    const when = "output.computation.payload.recommendation";
    Object.assign(config, {
      evidenceCapture: { type: "kyc_library_decision_recommendation", sourceType: "DERIVED", trustTier: "AGENT_DERIVED", instructionTrust: "UNTRUSTED_DATA" },
      caseWrites: [
        link("KYC_DECISION_RECOMMENDATION", when),
        {
          commandType: "SubmitDecisionRecommendation", when,
          payload: {
            recommendationId: "recommendation_{{ run.runId }}", outcome: "REVIEW",
            rationale: "Library decision.recommendation.generate returned {{ output.computation.payload.recommendation }}; a library recommendation is never an automatic approval.",
            policyRuleRefs: [], findingRefs: [], evidenceRefs: ["{{ evidence.evidenceId }}"], requiresHumanReview: true,
          },
          payloadSchema: { type: "object", required: ["recommendationId", "outcome", "rationale", "evidenceRefs", "requiresHumanReview"] },
        },
      ],
    });
  }
  return { ...node, contextSelectorIds: [...node.contextSelectorIds, ...extraSelectors], config };
}

const selectors = [
  { id: "bankingRelationships", source: "case", path: "records.BankingRelationship", purpose: PURPOSE, classification: "CONFIDENTIAL", required: true },
  { id: "bankingControls", source: "case", path: "records.ControlAssessment", purpose: PURPOSE, classification: "CONFIDENTIAL", required: false },
  { id: "kycSubjects", source: "case", path: "subjects", purpose: PURPOSE, classification: "PII", required: true },
  { id: "subjectName", source: "case", path: "subjects.0.display_name", purpose: PURPOSE, classification: "PII", required: true },
  { id: "subjectCountry", source: "case", path: "subjects.0.attributes.country", purpose: PURPOSE, classification: "PII", required: false },
  { id: "subjectId", source: "case", path: "subjects.0.subject_id", purpose: PURPOSE, classification: "CONFIDENTIAL", required: true },
  { id: "policyFacts", source: "case", path: "facts", purpose: PURPOSE, classification: "CONFIDENTIAL", required: false },
  { id: "name", source: "case", path: "subjects.0.display_name", purpose: ACQUIRE, classification: "PII", required: true },
  { id: "screeningSubjects", source: "case", path: "subjects", purpose: ACQUIRE, classification: "PII", required: true },
  { id: "country", source: "case", path: "subjects.0.attributes.country", purpose: ACQUIRE, classification: "PII", required: false },
  { id: "dateOfBirth", source: "case", path: "subjects.0.attributes.dateOfBirth", purpose: ACQUIRE, classification: "PII", required: false },
  { id: "caseId", source: "case", path: "case.caseId", purpose: ACQUIRE, classification: "CONFIDENTIAL", required: true },
  { id: "policyGateContext", source: "case", path: "$", purpose: "KYC_POLICY_EVALUATION", classification: "CONFIDENTIAL", required: true },
  { id: "reviewContext", source: "case", path: "$", purpose: "KYC_HUMAN_REVIEW", classification: "CONFIDENTIAL", required: true },
];

const policyAuthority = {
  id: "policy-authority", kind: "transform", name: "Pin policy authority evidence",
  summary: "Materialize the case's immutable policy binding as authoritative canonical evidence and a policy claim; the screening-ready gate checks both.",
  contextSelectorIds: ["policyGateContext"],
  config: {
    operation: "select", path: "/", caseWriteActor: "system", caseWritePrincipalId: "kyc-policy-context",
    evidenceCapture: { type: "kyc_policy_authority_binding", sourceType: "INTERNAL_SYSTEM", trustTier: "AUTHORITATIVE_POLICY", instructionTrust: "TRUSTED" },
    caseWrites: [
      link("KYC_POLICY_AUTHORITY"),
      {
        commandType: "ProposeClaim",
        payload: {
          claimId: "claim_policy_{{ run.runId }}", predicate: "applicable_kyc_policy",
          value: { policyId: "{{ case.policyAuthority.policyId }}", policyVersion: "{{ case.policyAuthority.policyVersion }}", policySnapshotDigest: "{{ case.policyAuthority.policySnapshotDigest }}" },
          evidenceRefs: ["{{ evidence.evidenceId }}"], confidence: { value: 1, method: "release_binding" },
        },
        payloadSchema: { type: "object", required: ["claimId", "predicate", "value", "evidenceRefs"] },
      },
      { commandType: "TransitionCaseStatus", payload: { toStatus: "VALIDATING", reason: "Authoritative policy context and intake prerequisites are being validated." }, payloadSchema: { type: "object", required: ["toStatus", "reason"] } },
    ],
  },
};

const { packageDocument, workflowDocument } = buildLibraryPackage({
  workflow,
  library,
  overlay: {
    purpose: PURPOSE,
    subjectsSelectorId: "kycSubjects",
    contextSelectors: selectors,
    connectors,
    connectorNode,
    inserts,
    preNodes: [policyAuthority],
    skillNode,
    skillBindingPolicy: { require_entitlement: false, require_list_freshness: false, require_jurisdiction_coverage: false, allow_fallback: false, log_selected_implementation: true },
    intake: { id: "intake", kind: "input", name: "KYC case identity", summary: "Accept only tenant and case identity; the subject, records and policy authority come from the canonical case store." },
    approval: {
      summary: "The disposition skill's payload is a proposal until two distinct authorized reviewers record the same decision (durable dual control).",
      contextSelectorIds: ["reviewContext"],
      config: { dualControlRequired: true, allowedDecisions: ["APPROVE", "REJECT"] },
      requireCompletedSkill: true,
    },
    stop: { id: "kyc-stopped", kind: "output", name: "KYC stopped for handoff", summary: "An OPA gate did not continue, a library success condition did not hold, or a reviewer rejected the disposition; the case stays open for workflow handoff.", config: { usePredecessorInput: true } },
    result: {
      id: "result", kind: "output", name: "KYC result",
      summary: "Reached only after dual-control approval of the disposition and the monitoring schedule; links the run to the case. Final disposition remains a separately authorized case command.",
      contextSelectorIds: ["reviewContext"],
      config: {
        usePredecessorInput: true, caseWriteActor: "system", caseWritePrincipalId: "kyc-workflow",
        caseWrites: [{ commandType: "LinkExecution", payload: { runId: "{{ run.runId }}", planDigest: "{{ run.planDigest }}", purpose: "KYC_LIBRARY_ONBOARDING" }, payloadSchema: { type: "object", required: ["runId", "planDigest", "purpose"] } }],
      },
    },
    packageDocument: ({ capabilities, skillBindings, contextSelectors, connectorBindings, stepCount }) => ({
      apiVersion: "harness.factory/domain-package-v2",
      kind: "DomainPackage",
      metadata: {
        name: "KYC v2",
        version: "3.0.0",
        domain: "kyc",
        objective: "Individual KYC (CDD onboarding) on the financial-crime skill library: connectors acquire data into canonical records, library skills reason over them with the pinned US KYC policy as their policy context, OPA decision-table gates guard each stage, and two independent humans approve the disposition. Synthetic library skills; not production-qualified.",
        owners: ["kyc-policy-owner", "kyc-operations", "financial-crime-skills"],
        riskClass: "high",
      },
      workflow: "workflow.yaml",
      coordinationMode: "caseStore",
      budgets: { maxDurationMs: 900000, maxCostUsd: 1, maxModelCalls: 0, maxCapabilityCalls: stepCount + 2 + 3 * 50 + 3 },
      modelProfiles: [],
      agentProfiles: [],
      capabilities,
      bindings: connectorBindings,
      skillBindings,
      policies: [{ policyId: binding.policyId, policyVersion: binding.policyVersion, source: "policy-binding.yaml", digest: binding.bundleDigest }],
      contextSelectors,
      contextClassificationPolicies: [{ classification: "PII", action: "allow" }, { classification: "CONFIDENTIAL", action: "allow" }],
      allowedRegions: ["US"],
      dataClasses: ["PII", "CONFIDENTIAL", "PUBLIC_SOURCE"],
      evaluationRequirements: ["kyc-gate-corpus", "sanctions-provider-contract", "pep-provider-contract", "independent-review", "skill-host-conformance", "canonical-record-normalizers"],
    }),
    workflowDocument: ({ nodes, edges }) => ({
      apiVersion: "ladder.dev/v1alpha1",
      kind: "Workflow",
      metadata: { name: "kyc-cdd-onboarding", title: "Individual KYC (skill library)", description: "CDD onboarding on library skills, with connector acquisition stages, OPA decision-table gates and durable dual-control approval.", version: "3.0.0" },
      spec: {
        objective: "Produce an auditable KYC case from canonical records and library reasoning, never claiming more than the records establish and never granting a skill or provider disposition authority.",
        inputs: { type: "object", required: ["tenantId", "caseId"], properties: { tenantId: { type: "string" }, caseId: { type: "string" } } },
        outputs: { type: "object" },
        policies: { maxConcurrency: 5, onFailure: "stop" },
        nodes,
        edges,
      },
    }),
  },
});

// Every library binding must name an earlier step's payload, and each step id maps to one node.
for (const step of workflow.steps) {
  if (!workflowDocument.spec.nodes.some((node) => node.id === nodeId(step.id))) throw new Error(`kyc.step_node_missing:${step.id}`);
}
const header = (title) => `# GENERATED by scripts/sync-kyc-package.mjs from domains/kyc/v2/source/kyc-workflow.json, the vendored\n# library manifests (library/skills.json) and the pinned policy bundle -- do not edit; regenerate.\n# ${title}\n`;
emit(resolve(domainRoot, "package.yaml"), header("KYC domain package (v2, skill library).") + toYaml(packageDocument));
emit(resolve(domainRoot, "workflow.yaml"), header("KYC workflow.") + toYaml(workflowDocument));
if (check && state.changed) process.exit(1);
process.stdout.write(check ? "domains/archive/kyc-v2-deterministic is up to date\n" : `domains/archive/kyc-v2-deterministic generated (${workflow.steps.length} library steps, ${connectors.length} connectors, ${inserts.filter((item) => item.gate).length} OPA gates)\n`);
