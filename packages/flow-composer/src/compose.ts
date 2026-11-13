// Flow composition: the agentic KYC/KYB process for a flow definition (its customer type, agents,
// policy packs and acquisition connectors), as a v2 domain package, workflow and business policy.
// Pure: every input (agent roster, effective packs, skill catalog and registry, synthetic policy
// content) is an argument, so the offline generator (scripts/sync-agentic-flows.ts) and the
// authoring service compose the same thing from the same inputs.
// @ts-nocheck -- moved verbatim from scripts/sync-agentic-flows.ts; its outputs are pinned byte for
// byte by the generated domains/{kyc,kyb}-agentic packages (CI drift checks).
import { DILIGENCE_LEVEL_FACT, DILIGENCE_REQUIREMENTS_FACT, projectInstallationContent, type EffectivePolicyPack } from "@ehf/policy-engine";
import { platformCapabilityId } from "@ehf/contracts";
import { PROVIDER_SCHEMAS } from "@ehf/library-contracts";
import { agenticBusinessPolicy, type DiligenceInputs, type SyntheticContent } from "./business-policy.js";
import { EDD_REQUIRED } from "./gate-rules.js";
import { connectors as kybConnectors, connectorNode } from "./connectors.js";
import { buildLibraryPackage, capabilityFor, recordSelectorsFor } from "./library-package.js";

export type Agent = {
  id: string; version: string; name: string; description: string; role: string; prompt: string; instruction: string;
  customerTypes: string[]; modelProfileId: string; loopCapability: string;
  skills: { hydration: string[]; required: string[]; optional: string[]; human: string[] }; allowedSkills: Array<{ skillId: string; semver: string }>;
  tools: string[]; reads: string[]; outputSchema: Record<string, unknown>; limits: Record<string, number>;
  completion: { criteria: Array<{ skill: string; acceptedStatuses: string[]; requiredPayloadFields: string[] }>; failurePolicy: Record<string, string> };
};
export type Flow = {
  id: string; domain: string; title: string; objective: string; customerType: "individual" | "corporate";
  agents: string[]; excludedSkills: string[]; packs: string[]; requirementsPackage: string;
  /** Due-diligence level: simplified (SDD), standard (CDD, the default) or enhanced (EDD). */
  dueDiligence?: "simplified" | "standard" | "enhanced";
  /** Agents' optional (loop) skills this flow runs as required steps, e.g. EDD's source-of-funds verification. */
  promotedSkills?: string[];
  /** A review's event (the library's review events: periodic_review, ownership_change, ...); null for onboarding. */
  reviewEvent?: string;
  /** The process scope this flow was composed for, recorded on its checkpoints so a case can find its plan. */
  scope?: { customerType: string; trigger: string; dueDiligence: string; event?: string; jurisdictions: string[]; products: string[]; institution: string };
  /** Regions the composed package admits (the packs' jurisdictions). */
  allowedRegions?: string[];
  /** Acquisition connectors (scripts/lib/kyb-connectors.mjs) run as the hydration stages (delivery plan W3/W4). */
  connectors: string[];
};


/** Everything composition reads, loaded by the caller. */
export type ComposerInputs = {
  /** domains/agents/roster.json agents. */
  roster: Agent[];
  /** Effective policy packs (artifacts/policy/packs), by id. */
  packs: Map<string, EffectivePolicyPack>;
  /** config/skill-library/catalog.json skills (id, semver), the registry's catalog. */
  catalogSkills: Array<{ id: string; semver: string }>;
  /** config/business-skills.json entries keyed `skill_id@semver`. */
  registry: Map<string, any>;
  /** The vendored manifests for a workflow's skills plus extra (loop) skills, checked against the registry. */
  vendor: (workflow: { steps: Array<{ skill_id: string }> }, extraSkillIds: string[]) => any;
  /** domains/policy/synthetic-installation-content.yaml, parsed. */
  synthetic: SyntheticContent;
  /** The institutions' diligence designs and the taxonomy's legacy mapping; a flow whose institution has one gets the diligence gate. */
  diligence?: DiligenceInputs;
};

// The diligence gate's node, and the skills that read the level it derives (their policy content is
// derived from the same diligence block: packages/policy-engine/src/diligence/derive.ts).
export const DILIGENCE_NODE = "diligence-level";
const DILIGENCE_READERS = ["edd.trigger.evaluate", "decision.requirements.compile"];

/** A composer over one set of inputs: `compose(flow)` returns the package, workflow and business policy. */
export function createComposer(inputs: ComposerInputs) {
  const roster = inputs.roster;
  const byId = new Map(roster.map((agent) => [agent.id, agent]));
  const pack = (id: string) => inputs.packs.get(id) ?? (() => { throw new Error(`flow.pack_unknown:${id}`); })();
  const catalog = new Map(inputs.catalogSkills.map((skill) => [skill.id, skill]));
  const registryDependencies = new Map([...inputs.registry.values()].map((entry: any) => [`${entry.skillId}@${entry.semver}`, entry.dependencies.capabilities]));
  // Record fields an agent's `reads` projects (the library context schema's data fields).
  const READ_FIELDS: Record<string, string[]> = {
    DocumentVersion: ["document_id", "artifact_hash", "media_type", "artifact_ref", "page_count"],
    DocumentPage: ["text", "page", "document_version"],
    ExtractedAssertion: ["subject", "field", "value", "document_version"],
    Identity: ["attributes"],
    IdentityIdentifier: ["entity_id", "issuer", "value", "identifier_type", "verified"],
    VerificationRecord: ["subject", "status", "method", "evidence_ids"],
    RegistryRecord: ["name", "registration_id", "status", "coverage", "address", "attributes"],
    Address: ["lines", "country", "postal_code", "locality", "region", "normalized"],
    FraudSignal: ["score", "kind", "model_version", "evidence_ids"],
    // Its camelCase keys (customerEntityId, ...) are not projectable: entities carries each party's legal form.
    BankingRelationship: ["entities", "parties", "products", "event"],
    Product: ["active", "channel", "product_type"],
    PEPRelationship: ["source", "target", "relation", "verified"],
    ScreeningHit: ["entity_id", "entry_id", "features"],
    Finding: ["claim", "evidence_ids", "status"],
  };

  const PURPOSE = "CDD_ONBOARDING";
  const stepId = (skillId: string) => skillId.replaceAll(".", "_");
  const nodeOf = (skillId: string) => stepId(skillId).replaceAll("_", "-");
  const short = (agentId: string) => agentId.replace(/^agent\./, "").replaceAll("_", "-");

  // Parameters fixed by the flow, bindings from earlier payloads (`<step>.payload...`), and bindings from
  // the case (selector ids). Every binding is required: an unresolved one fails the node closed.
  const parametersFor = (flow: Flow): Record<string, Record<string, unknown>> => ({
    "document.requirements.resolve": { package: flow.requirementsPackage, event: flow.reviewEvent ?? null },
    "edd.trigger.evaluate": { facts: {} },
    "decision.requirements.compile": { facts: { due_diligence: flow.dueDiligence ?? "standard" } },
    "decision.controls.assess": { facts: { due_diligence: flow.dueDiligence ?? "standard" } },
    "decision.rules.evaluate": { facts: {} },
    "decision.human.review": { action: "REVIEW_CASE" },
  });
  /**
   * Facts for decision.controls.assess. Every one is optional: a fact the flow cannot bind (its step
   * is not in this process, or answered without a payload) is absent, and the controls that read it
   * stay UNKNOWN; nothing defaults to a pass.
   */
  const CONTROL_FACTS: Record<string, string> = {
    "facts.tier": "risk_tier_assign.payload.tier",
    "facts.identity_verified": "entity_identity_verify.payload.verifications[*].verified",
    "facts.documents_required": "document_requirements_resolve.payload.requirements[*].id",
    "facts.documents_missing": "document_requirements_resolve.payload.missing",
    "facts.sanctions_hits": "screening_sanctions_execute.payload.hits[*].entity_id",
    "facts.pep_hits": "screening_pep_execute.payload.hits[*].entity_id",
    "facts.adverse_media_events": "screening_adverse_media_execute.payload.events[*].id",
    "facts.registry_verified": "registry_company_verify.payload.verifications[*].verified",
    "facts.owners_verified": "ownership_ubo_verify.payload.owners[*].verified",
    "facts.profile_complete": "party_profile_completeness.payload.profiles[*].complete",
    "facts.funds_verified": "edd_source_of_funds_verify.payload.claims[*].verified",
  };
  const STEP_BINDINGS: Record<string, Record<string, string>> = {
    "document.fields.contract_extract": { classifications: "document_classify_catalog.payload.classifications" },
    "document.fields.adjudicated_extract": { classifications: "document_classify_catalog.payload.classifications" },
    "document.requirements.resolve": { classifications: "document_classify_catalog.payload.classifications" },
    "screening.sanctions.ownership.evaluate": { blocked_ids: "screening_sanctions_execute.payload.hits[*].entity_id" },
    "risk.tier.assign": { score: "risk_customer_assess.payload.assessment.score" },
    // EDD sees the screening outcomes directly, not only through the risk tier.
    "edd.trigger.evaluate": { "facts.tier": "risk_tier_assign.payload.tier",
      "facts.sanctions_hits": "screening_sanctions_execute.payload.hits[*].entity_id",
      "facts.pep_hits": "screening_pep_execute.payload.hits[*].entity_id",
      "facts.adverse_media_events": "screening_adverse_media_execute.payload.events[*].id" },
    "decision.requirements.compile": { "facts.tier": "risk_tier_assign.payload.tier", "facts.identity_verified": "entity_identity_verify.payload.verifications.0.verified" },
    "decision.rules.evaluate": { "facts.tier": "risk_tier_assign.payload.tier", "facts.identity_verified": "entity_identity_verify.payload.verifications.0.verified" },
    // The evidence each requirement's control reads (domains/policy/synthetic-installation-content.yaml).
    "decision.controls.assess": CONTROL_FACTS,
    // Enhanced due diligence scopes every configured trigger (the full EDD scope, never a subset).
    "edd.scope.plan": { trigger_ids: "edd_trigger_evaluate.payload.triggers[*].id" },
  };
  const CASE_BINDINGS: Record<string, Record<string, string>> = {
    "document.fields.contract_extract": { subject: "subjectId" },
    "document.fields.adjudicated_extract": { subject: "subjectId" },
    // The case subject's own identifier values (the case store keeps only digests of subject identifiers).
    "entity.resolve": { name: "subjectName", identifiers: "subjectIdentifiers[*].data.value | data.entity_id == subjectId" },
    "ownership.interest.calculate": { target: "subjectId" },
    "ownership.ubo.resolve": { target: "subjectId" },
    "screening.sanctions.ownership.evaluate": { target: "subjectId" },
    "screening.adverse_media.execute": { name: "subjectName" },
  };
  const CASE_SELECTORS = [
    { id: "caseSubjects", source: "case", path: "subjects", purpose: PURPOSE, classification: "PII", required: true },
    { id: "subjectName", source: "case", path: "subjects.0.display_name", purpose: PURPOSE, classification: "PII", required: true },
    { id: "subjectId", source: "case", path: "subjects.0.subject_id", purpose: PURPOSE, classification: "CONFIDENTIAL", required: true },
    // What the acquisition connectors read (scripts/lib/kyb-connectors.mjs connectorNode).
    { id: "kybSubjects", source: "case", path: "subjects", purpose: PURPOSE, classification: "PII", required: true },
    { id: "screeningEntities", source: "case", path: "records.Entity", purpose: PURPOSE, classification: "PII", required: false,
      record: { objectType: "Entity", fields: ["name", "identifiers", "entity_type"], minCount: 0, maxAgeSeconds: null } },
    { id: "name", source: "case", path: "subjects.0.display_name", purpose: PURPOSE, classification: "PII", required: true },
    { id: "country", source: "case", path: "subjects.0.attributes.country", purpose: PURPOSE, classification: "PII", required: false },
    { id: "registrationNumber", source: "case", path: "subjects.0.attributes.registrationNumber", purpose: PURPOSE, classification: "PII", required: false },
    { id: "lei", source: "case", path: "subjects.0.attributes.lei", purpose: PURPOSE, classification: "PII", required: false },
    { id: "caseId", source: "case", path: "case.caseId", purpose: PURPOSE, classification: "CONFIDENTIAL", required: true },
    { id: "subjectIdentifiers", source: "case", path: "records.IdentityIdentifier", purpose: PURPOSE, classification: "PII", required: false,
      record: { objectType: "IdentityIdentifier", fields: ["entity_id", "issuer", "value", "identifier_type", "verified"], minCount: 0, maxAgeSeconds: null } },
  ];
  // What the pack checkpoints read (pack-gate.ts: record type -> selector id).
  const PACK_RECORDS = { BankingRelationship: "packRelationship", ScreeningExecution: "packScreening", OwnershipInterest: "packOwnership", BeneficialOwner: "packBeneficialOwners", VerificationRecord: "packVerification" };
  const PACK_SELECTORS = Object.entries(PACK_RECORDS).map(([type, id]) => ({
    id, source: "case", path: `records.${type}`, purpose: PURPOSE, classification: "CONFIDENTIAL", required: type === "BankingRelationship",
  }));

  /** The selector ids a context binding reads (`a`, or `a[*].field | field == b`). */
  const selectorsOf = (binding: string) => [...binding.matchAll(/^\s*(\w+)|==\s*(\w+)\s*$/g)].map((match) => match[1] ?? match[2]!).filter(Boolean);

  // CR-8: the provider capabilities a flow's skills call back through the gateway, each served by its
  // platform connector. A skill's library dependency (`document.fields`) becomes the platform capability
  // (`document.fields.extract.v1`) in its binding's dependencyCapabilities, so the compiler puts it in
  // the node's permission envelope and the gateway can delegate it. Detector capabilities join with the
  // optional authenticity checks (delivery plan wave 4).
  // The skill host calls every provider capability back with effect `read` (skill_host.py call_gateway), and the
  // gateway requires the plan's effect to match exactly.
  const PROVIDER_CAPABILITIES: Record<string, { library: string; kind: "model" | "tool"; effect: string; adapterBindingId: string; timeoutMs: number }> = {
    "document.fields.extract.v1": { library: "document.fields", kind: "model", effect: "read", adapterBindingId: "openrouter:document_fields.model.document.v1", timeoutMs: 150000 },
    "document.ocr.extract.v1": { library: "document.ocr", kind: "tool", effect: "read", adapterBindingId: "evidence:pages", timeoutMs: 60000 },
    // Wave 4: the optional authenticity detectors. The sandbox connectors answer INCONCLUSIVE with a
    // limitation (never a pass, never a signal); a qualified vendor connector replaces the binding.
    "document.forensics.assess.v1": { library: "document.forensics", kind: "tool", effect: "read", adapterBindingId: "simulator:library.document.forensics", timeoutMs: 30000 },
    "fraud.document.tamper.v1": { library: "fraud.document_tamper", kind: "tool", effect: "read", adapterBindingId: "simulator:library.fraud.document_tamper", timeoutMs: 30000 },
  };
  /** The platform provider capabilities a skill reaches, among those a flow serves. */
  const providersOf = (skillId: string) => (registryDependencies.get(`${skillId}@${catalog.get(skillId)!.semver}`) ?? [])
    .map(platformCapabilityId).filter((id) => PROVIDER_CAPABILITIES[id]);
  /**
   * A provider-backed skill's `permitted_providers` names the platform gateway for the capabilities its
   * plan admits: a technical binding (the host calls back through the gateway), as the document
   * re-extraction plan does. The policy layer may narrow it; it never widens what the plan admits.
   */

  /**
   * Delivery plan wave 2 (W6): an agent's output becomes non-authoritative case proposals and
   * observations, attributed to the agent and citing its output evidence. Nothing here adopts a fact,
   * decides, transitions the case or creates human work: those are protected actions owned by the
   * policy layer (policy plan R01, R04-R05).
   * - findings (not INFO) -> ProposeClaim `finding:<type>`, pending adoption by a gate;
   * - identity documentChecks with CONFLICT -> RaiseContradiction between the two cited sources;
   * - decision support's recommendation -> SubmitDecisionRecommendation (DECLINE for RECOMMEND_DECLINE,
   *   REVIEW otherwise; an agent never proposes APPROVE), an input to the decision gate.
   */
  /** The claim predicate the runtime's task-completion outcome is recorded under, read by the checkpoints. */
  const AGENT_TASK_OUTCOME = "agent_task_outcome";

  function agentOutputWrites(agent: { id: string }) {
    const detection = `agent:${agent.id}`;
    const writes: Array<Record<string, unknown>> = [{
      // The same findings as canonical, UNVERIFIED Finding records about the case's subjects, so later
      // skills read them (investigation.findings.synthesize, quality.findings.verify).
      commandType: "RecordCanonicalRecords", forEach: "output.findings", when: 'item.severity != "INFO"',
      payload: { evidenceRefs: ["{{ evidence.evidenceId }}"], records: [{
        object_type: "Finding", object_id: "finding:{{ run.runId }}:{{ run.nodeId }}:{{ itemIndex }}", version_id: "v1",
        data: { claim: "{{ item.type }}: {{ item.reason }}", evidence_ids: ["{{ evidence.evidenceId }}"], status: "UNVERIFIED" },
        subject_ids: "{{ subjects }}", observed_at: "{{ run.at }}", source_refs: [],
        provenance: { method: "agent_proposal", agent_id: agent.id, execution_mode: "agent_review" },
        classification: "CONFIDENTIAL", purposes: ["onboarding", "investigation", "review"], synthetic: "{{ syntheticCase }}",
      }] },
      payloadSchema: { type: "object", required: ["records"] },
    }, {
      commandType: "ProposeClaim", forEach: "output.findings", when: 'item.severity != "INFO"',
      payload: { predicate: "finding:{{ item.type }}", value: { severity: "{{ item.severity }}", reason: "{{ item.reason }}", sourceRefs: "{{ item.sourceRefs }}", proposedBy: detection },
        evidenceRefs: ["{{ evidence.evidenceId }}"] },
      payloadSchema: { type: "object", required: ["predicate", "value", "evidenceRefs"] },
    }];
    if (agent.id === "agent.identity_verification") writes.push({
      commandType: "RaiseContradiction", forEach: "output.documentChecks", when: 'item.outcome == "CONFLICT"',
      payload: { objectRefs: "{{ item.sourceRefs }}", materiality: "REVIEW", detectionMethod: detection,
        description: "{{ item.entityRef }} {{ item.field }}: the document states {{ item.documentValue }}; the record holds {{ item.recordValue }}." },
      payloadSchema: { type: "object", required: ["objectRefs", "description", "materiality", "detectionMethod"] },
    });
    if (agent.id === "agent.decision_support") {
      for (const [when, outcome] of [['output.recommendation == "RECOMMEND_DECLINE"', "DECLINE"], ['output.recommendation != "RECOMMEND_DECLINE"', "REVIEW"]] as const) writes.push({
        commandType: "SubmitDecisionRecommendation", when,
        payload: { recommendationId: "recommendation_{{ run.runId }}", outcome, rationale: "{{ output.rationale }}", evidenceRefs: ["{{ evidence.evidenceId }}"],
          findingRefs: [], policyRuleRefs: [], requiresHumanReview: true },
        payloadSchema: { type: "object", required: ["recommendationId", "outcome", "rationale"] },
      });
    }
    return writes;
  }

  /**
   * Delivery plan wave 4: a tamper detector's answer becomes a canonical FraudSignal about the case's
   * subjects, citing the detector's output as evidence, for the document and identity agents to read.
   * Only a completed, informative answer is written: an INCONCLUSIVE one (every sandbox answer) is no
   * signal, and stays visible to the document agent's review as a gap.
   */
  const SIGNAL_WRITES: Record<string, { kind: string; capabilityId: string }> = {
    "fraud.document.tamper.detect": { kind: "document_tamper", capabilityId: "fraud.document.tamper.v1" },
  };
  function signalWrite(node: { config: Record<string, unknown> }, signal: { kind: string; capabilityId: string }) {
    const assessment = "output.computation.payload.assessment";
    return {
      evidenceCapture: { type: `authenticity_${signal.kind}`, sourceType: "DERIVED", trustTier: "PLATFORM_DERIVED", instructionTrust: "UNTRUSTED_DATA" },
      caseWrites: [...(Array.isArray(node.config.caseWrites) ? node.config.caseWrites : []), {
        commandType: "RecordCanonicalRecords",
        when: `output.computation.business_status == "COMPLETED" && ${assessment}.assessment != "INCONCLUSIVE"`,
        payload: { evidenceRefs: ["{{ evidence.evidenceId }}"], records: [{
          object_type: "FraudSignal", object_id: `fraud-signal:{{ run.runId }}:${signal.kind}`, version_id: "v1",
          data: { score: `{{ ${assessment}.score }}`, kind: signal.kind, model_version: `{{ ${assessment}.model_version }}`, evidence_ids: ["{{ evidence.evidenceId }}"] },
          subject_ids: "{{ subjects }}", observed_at: "{{ run.at }}", source_refs: [],
          provenance: { method: "platform", capability_id: signal.capabilityId, execution_mode: "hydration" },
          classification: "CONFIDENTIAL", purposes: ["onboarding", "investigation", "review"], synthetic: "{{ syntheticCase }}",
        }] },
        payloadSchema: { type: "object", required: ["records"] },
      }],
    };
  }

  /**
   * Each requirement's control outcome becomes a canonical Control record about the case's subjects,
   * citing the assessment as evidence: what decision support's recommendation and gap skills and QA's
   * policy-compliance skill read. Only a completed assessment is written.
   */
  function controlsWrite(node: { config: Record<string, unknown> }) {
    return {
      evidenceCapture: { type: "requirement_controls", sourceType: "DERIVED", trustTier: "PLATFORM_DERIVED", instructionTrust: "UNTRUSTED_DATA" },
      optionalParameterBindings: Object.keys(CONTROL_FACTS),
      caseWrites: [...(Array.isArray(node.config.caseWrites) ? node.config.caseWrites : []), {
        commandType: "RecordCanonicalRecords", forEach: "output.computation.payload.controls", when: 'output.computation.business_status == "COMPLETED"',
        payload: { evidenceRefs: ["{{ evidence.evidenceId }}"], records: [{
          object_type: "Control", object_id: "control:{{ run.runId }}:{{ item.requirement_id }}", version_id: "v1",
          data: { requirement_id: "{{ item.requirement_id }}", outcome: "{{ item.outcome }}" },
          subject_ids: "{{ subjects }}", observed_at: "{{ run.at }}", source_refs: [],
          provenance: { method: "platform", skill_id: "decision.controls.assess", execution_mode: "workflow" },
          classification: "CONFIDENTIAL", purposes: ["onboarding", "investigation", "review"], synthetic: "{{ syntheticCase }}",
        }] },
        payloadSchema: { type: "object", required: ["records"] },
      }],
    };
  }

  /**
   * Context producers: a skill's output recorded as the canonical records later steps and the
   * checkpoints read, about the case's subjects and citing the skill's execution as evidence. Each
   * record has a stable id per case, versioned by run, so a re-run supersedes it.
   * - risk.factors.derive -> RiskFactor (the scored factors risk.customer.assess weighs; an unscored
   *   factor is not written, so the assessment stays open);
   * - ownership.ubo.resolve -> BeneficialOwner (the candidates ownership.ubo.verify corroborates).
   */
  const RECORD_WRITES: Record<string, { objectType: string; items: string; key: string; when: string; data: Record<string, unknown> }> = {
    "risk.factors.derive": { objectType: "RiskFactor", items: "output.computation.payload.factors", key: "item.name",
      when: "item.score != null", data: { name: "{{ item.name }}", score: "{{ item.score }}" } },
    "ownership.ubo.resolve": { objectType: "BeneficialOwner", items: "output.computation.payload.candidates", key: "item.entity_id",
      when: "always", data: { entity_id: "{{ item.entity_id }}", evidence_ids: ["{{ evidence.evidenceId }}"] } },
  };
  function recordWrite(node: { config: Record<string, unknown> }, skillId: string, spec: (typeof RECORD_WRITES)[string]) {
    return {
      evidenceCapture: { type: `${skillId.replaceAll(".", "_")}_records`, sourceType: "DERIVED", trustTier: "PLATFORM_DERIVED", instructionTrust: "UNTRUSTED_DATA" },
      caseWrites: [...(Array.isArray(node.config.caseWrites) ? node.config.caseWrites : []), {
        commandType: "RecordCanonicalRecords", forEach: spec.items, when: spec.when,
        payload: { evidenceRefs: ["{{ evidence.evidenceId }}"], records: [{
          object_type: spec.objectType, object_id: `${spec.objectType.toLowerCase()}:{{ case.caseId }}:{{ ${spec.key} }}`, version_id: "{{ run.runId }}",
          data: spec.data, subject_ids: "{{ subjects }}", observed_at: "{{ run.at }}", source_refs: [],
          provenance: { method: "platform", skill_id: skillId, execution_mode: "workflow" },
          classification: "CONFIDENTIAL", purposes: ["onboarding", "investigation", "review"], synthetic: "{{ syntheticCase }}",
        }] },
        payloadSchema: { type: "object", required: ["records"] },
      }],
    };
  }

  /**
   * When the EDD triggers fire, the case records it (an `edd_required` claim, citing the trigger
   * evaluation): a standard or simplified process's decision-ready checkpoint then escalates the case
   * to enhanced due diligence instead of deciding it at the wrong level.
   */
  function eddRequiredWrite(node: { config: Record<string, unknown> }) {
    return {
      evidenceCapture: { type: "edd_trigger_outcome", sourceType: "DERIVED", trustTier: "PLATFORM_DERIVED", instructionTrust: "UNTRUSTED_DATA" },
      caseWrites: [...(Array.isArray(node.config.caseWrites) ? node.config.caseWrites : []),
        { commandType: "LinkEvidence", payload: { evidenceId: "{{ evidence.evidenceId }}", purpose: "EDD_TRIGGER_OUTCOME" }, payloadSchema: { type: "object", required: ["evidenceId", "purpose"] } },
        { commandType: "ProposeClaim", when: "output.computation.payload.required == true",
          payload: { predicate: EDD_REQUIRED, value: { triggers: "{{ output.computation.payload.triggers }}", proposedBy: "skill:edd.trigger.evaluate" }, evidenceRefs: ["{{ evidence.evidenceId }}"] },
          payloadSchema: { type: "object", required: ["predicate", "value", "evidenceRefs"] } },
      ],
    };
  }

  function platformProfile(agent: Agent, purposes: string[]) {
    const skillCapability = (skillId: string) => capabilityFor(skillId, catalog.get(skillId)!.semver);
    return {
      id: agent.id, version: agent.version, name: agent.name, description: agent.description, role: agent.role, prompt: agent.prompt,
      instructions: [
        { id: `${agent.id}.skills`, version: agent.version, name: "Run the agent's business skills", description: `The deterministic skills ${agent.id} runs, each pinned to its manifest.`,
          text: "Run each business skill exactly as the workflow binds it, over the records the platform selects. A skill's payload is evidence for review, not a decision.",
          allowedCapabilityIds: [...agent.skills.hydration,...agent.skills.required].map(skillCapability) },
        { id: `${agent.id}.review`, version: agent.version, name: `${agent.name}: review`, description: agent.description, text: agent.instruction,
          allowedCapabilityIds: [agent.loopCapability, ...agent.tools, ...agent.skills.optional.map(skillCapability)] },
      ],
      allowedSkills: agent.allowedSkills, modelProfileId: agent.modelProfileId, runtimeTarget: "hosted_http", primaryCapabilityId: agent.loopCapability,
      inputSchema: { type: "object" }, outputSchema: agent.outputSchema, purposes, limits: agent.limits,
    };
  }

  function build(flow: Flow) {
    const packs = flow.packs.map(pack);
    if (!flow.allowedRegions) flow = { ...flow, allowedRegions: [...new Set(packs.map((item) => item.scope.jurisdiction))] };
    const excluded = new Set(flow.excludedSkills);
    // The flow's view of each agent: excluded skills gone from its steps, completion and allowed skills.
    const promoted = new Set(flow.promotedSkills ?? []);
    const agents = flow.agents.map((id) => {
      const agent = byId.get(id)!;
      if (!agent.customerTypes.includes(flow.customerType)) throw new Error(`flow.agent_customer_type:${flow.id}:${id}`);
      const keep = (skillId: string) => !excluded.has(skillId) && skillId !== "decision.human.review";
      return {
        ...agent,
        skills: { hydration: agent.skills.hydration.filter(keep),
          required: [...agent.skills.required.filter(keep), ...agent.skills.optional.filter((skillId) => keep(skillId) && promoted.has(skillId))],
          optional: agent.skills.optional.filter((skillId) => keep(skillId) && !promoted.has(skillId)), human: agent.skills.human.filter(keep) },
        allowedSkills: agent.allowedSkills.filter((skill) => keep(skill.skillId)),
        completion: { ...agent.completion, criteria: agent.completion.criteria.filter((criterion) => keep(criterion.skill)) },
      };
    });
    for (const agent of agents) if (!agent.completion.criteria.length) throw new Error(`flow.completion_empty:${flow.id}:${agent.id}`);
    const parameters = parametersFor(flow);
    const segment = (agent: Agent) => [...agent.skills.hydration, ...agent.skills.required];
    const required = agents.flatMap(segment);

    const ordered = [...required];
    const workflow = { id: flow.id, version: "2.0.0", steps: ordered.map((skillId, index) => ({
      id: stepId(skillId), skill_id: skillId, parameters: parameters[skillId] ?? {},
      // A fact bound from a step the flow does not run (a review that skips identity) stays unbound: the
      // skill sees it as unknown, which is never a pass.
      bindings: Object.fromEntries(Object.entries(STEP_BINDINGS[skillId] ?? {}).filter(([, source]) => ordered.map(stepId).includes(source.split(".")[0]!))),
      dependencies: index === 0 ? [] : [stepId(ordered[index - 1]!)], condition: null, success_condition: null,
    })) };
    const optionalSkills = agents.flatMap((agent) => agent.skills.optional);
    const library = inputs.vendor(workflow, optionalSkills);
    const manifests = new Map<string, any>(library.skills.map((skill: any) => [skill.id, skill]));
    // The gate consumes the same canonical observations the enabled agents/skills can
    // produce or inspect, plus case proposals and prior policy adoptions. Five legacy
    // pack inputs alone omit document, risk, finding and recommendation evidence.
    const policyRecordTypes=[...new Set<string>([
      "ControlAssessment","Application","Product","Party",
      ...library.skills.flatMap((skill:any)=>[...(skill.required_context??[]),...(skill.optional_context??[])].map((requirement:any)=>requirement.object_type)),
      ...agents.flatMap(agent=>agent.reads),
    ])].sort().filter(type=>!Object.hasOwn(PACK_RECORDS,type));
    const policySelectors=[...PACK_SELECTORS,
      ...policyRecordTypes.map(type=>({id:`policyRecord${type}`,source:"case",path:`records.${type}`,purpose:PURPOSE,classification:"CONFIDENTIAL",required:false})),
      ...["case","subjects","claims","facts","contradictions","findings","decisionRecommendations","workItems","adoptedAssessments","evidenceLinks","evidence"].map(path=>({
        id:`policyCase${path[0]!.toUpperCase()+path.slice(1)}`,source:"case",path,purpose:PURPOSE,classification:path==="subjects"?"PII":"CONFIDENTIAL",required:false,
      })),
    ];
    const businessPolicy = agenticBusinessPolicy(flow.id, packs, library.skills.flatMap((skill: any) => skill.policy_context_fields ?? []), inputs.synthetic, {
      dueDiligence: flow.dueDiligence ?? "standard",
      // Ownership is established by the ownership agent's completed task, when the process runs it.
      ownershipAgent: agents.some((agent) => agent.id === "agent.identity_ownership") ? "agent.identity_ownership" : null,
      ...(inputs.diligence ? { diligence: inputs.diligence } : {}),
    });
    const diligenceGate = Boolean(businessPolicy.source.diligence);
    // One projection per pinned pack for every skill that reads policy; the case's pin chooses at run time.
    const skillPolicies = (manifest: any) => {
      const fields = [...new Set<string>(manifest.policy_context_fields ?? [])];
      return fields.length ? businessPolicy.compiled.policySets.map((set) => projectInstallationContent(set, fields, [`skill:${manifest.id}`, `effect:${manifest.effects}`])) : undefined;
    };
    const reviewId = (agent: Agent) => `${short(agent.id)}-review`;
    const loopOwner = (agent: Agent, skillId: string) => `${reviewId(agent)}-${nodeOf(skillId)}`;
    const readSelectors = (agent: Agent) => agent.reads.map((type) => ({
      id: `read${type}-${reviewId(agent)}`, source: "case", path: `records.${type}`, purpose: PURPOSE, classification: "CONFIDENTIAL", required: false,
      record: { objectType: type, fields: READ_FIELDS[type] ?? (() => { throw new Error(`flow.read_type_unknown:${type}`); })(), minCount: 0, maxAgeSeconds: null },
    }));
    // C5: an agent sees a record only within the pinned packs' freshness for its type (the strictest
    // of the plan's packs); an older one is a STALE gap it reports, never evidence it relies on. The
    // checkpoints' own selectors stay unfiltered: their rules judge freshness and say why.
    const packFreshness = new Map<string, number>();
    for (const effective of packs) {
      for (const [type, seconds] of Object.entries(((effective as any).values?.freshness_seconds ?? {}) as Record<string, number>)) {
        if (typeof seconds === "number" && seconds > 0) packFreshness.set(type, Math.min(seconds, packFreshness.get(type) ?? Infinity));
      }
    }
    const withFreshness = (selector: any) => selector.record && packFreshness.has(selector.record.objectType) && selector.record.maxAgeSeconds == null
      ? { ...selector, record: { ...selector.record, maxAgeSeconds: packFreshness.get(selector.record.objectType)! } } : selector;
    const loopSelectors = agents.flatMap((agent) => [
      ...agent.skills.optional.flatMap((skillId) => recordSelectorsFor(manifests.get(skillId), loopOwner(agent, skillId), PURPOSE)),
      ...readSelectors(agent),
    ]).map(withFreshness);
    const reviewNode = (agent: Agent) => {
      const skills = agent.skills.optional.map((skillId) => {
        const policies = skillPolicies(manifests.get(skillId));
        return { skillId, contextSelectorIds: recordSelectorsFor(manifests.get(skillId), loopOwner(agent, skillId), PURPOSE).map((selector: { id: string }) => selector.id),
          parameters: {}, purpose: "onboarding", ...(policies ? { skillPolicies: policies } : {}) };
      });
      return {
        id: reviewId(agent), kind: "agent", name: `${agent.name} (review)`, summary: agent.description, role: agent.role, prompt: agent.instruction,
        contextSelectorIds: [...new Set(["caseSubjects", ...skills.flatMap((skill) => skill.contextSelectorIds), ...readSelectors(agent).map((selector) => selector.id)])],
        inputSchema: { type: "object" }, outputSchema: agent.outputSchema,
        config: {
          agentRef: agent.id,
          loop: { ...agent.limits, tools: agent.tools, skills, repairAttempts: 1 },
          // The hydration checks' results are shown to the review beside its own skills', outside completion.
          ...(agent.skills.hydration.length ? { observedSkillNodes: agent.skills.hydration.map(nodeOf) } : {}),
          completion: { criteria: agent.completion.criteria.map((criterion) => ({ nodeId: nodeOf(criterion.skill), acceptedStatuses: criterion.acceptedStatuses, requiredPayloadFields: criterion.requiredPayloadFields })), failurePolicy: agent.completion.failurePolicy },
          evidenceCapture: { type: `${flow.id.replace("-", "_")}_${reviewId(agent).replaceAll("-", "_")}`, sourceType: "DERIVED", trustTier: "AGENT_DERIVED", instructionTrust: "UNTRUSTED_DATA" },
          caseWriteActor: "agent", caseWritePrincipalId: agent.id,
          caseWrites: [
            { commandType: "LinkEvidence", payload: { evidenceId: "{{ evidence.evidenceId }}", purpose: `${flow.id.replace("-", "_").toUpperCase()}_${reviewId(agent).replaceAll("-", "_").toUpperCase()}` }, payloadSchema: { type: "object", required: ["evidenceId", "purpose"] } },
            ...agentOutputWrites(agent),
            // The runtime's task-completion judgment over the agent's skills becomes a claim the
            // checkpoints read: a BLOCKED or NEEDS_EVIDENCE task stops the case before any decision,
            // whatever the agent's own answer says.
            {
              commandType: "ProposeClaim", when: "output.__taskCompletion.status",
              payload: { predicate: AGENT_TASK_OUTCOME, value: { agent: agent.id, status: "{{ output.__taskCompletion.status }}",
                reasons: "{{ output.__taskCompletion.reasons }}", proposedBy: "runtime:task-completion" }, evidenceRefs: ["{{ evidence.evidenceId }}"] },
              payloadSchema: { type: "object", required: ["predicate", "value", "evidenceRefs"] },
            },
          ],
        },
      };
    };
    const checkpoint = (gateId: "intake-ready" | "decision-ready" | "disposition" | "diligence-level", summary: string) => ({
      id: gateId === "diligence-level" ? DILIGENCE_NODE : `pack-${gateId}`, kind: "gate", name: gateId === "diligence-level" ? "Diligence level" : `Policy pack: ${gateId}`, summary,
      contextSelectorIds: policySelectors.map((selector) => selector.id),
      config: { businessDecision: "v2", inputProfile: "canonical.onboarding.v2", scopeSelectorId: "packRelationship", gateId, policyRef: businessPolicy.compiled.manifest.policyId, policyPacks: packs,
        ...(flow.scope ? { processScope: flow.scope } : {}) },
    });
    // Each agent's review runs after its own required skills, before the next agent's first one; the
    // checkpoints sit after intake's review, before decision support's skills, and before the person.
    const firstOf = (agentId: string) => stepId(segment(agents.find((agent) => agent.id === agentId)!)[0]!);
    const inserts: Array<Record<string, unknown>> = [];
    agents.forEach((agent, index) => {
      const next = agents.slice(index + 1).find((candidate) => segment(candidate).length);
      if(next) inserts.push({ before: stepId(segment(next)[0]!), node: reviewNode(agent) });
      if (agent.id === "agent.intake_profile") inserts.push({ before: firstOf(agents[index + 1]!.id), gate: checkpoint("intake-ready", "The pinned pack's intake requirements: a resolved relationship and an in-scope customer type. Anything else stops for a person."), continueOn: ["DECIDED"] });
      // The diligence level is derived once screening and investigation have recorded what its rules
      // read, before the risk agent's skills, which read the level.
      if (diligenceGate && agents[index + 1]?.id === "agent.risk_edd") inserts.push({ before: firstOf("agent.risk_edd"), gate: checkpoint("diligence-level", "The released policy's diligence level for this party type and these products, raised by any rule that holds. Missing inputs stop for a person."), continueOn: ["DECIDED"] });
      if (agents[index + 1]?.id === "agent.decision_support") inserts.push({ before: firstOf("agent.decision_support"), gate: checkpoint("decision-ready", "The pinned pack's evidence for a decision: required screening executed and current, ownership resolved for a business."), continueOn: ["DECIDED"] });
    });


    const flowConnectors = (kybConnectors as Array<{ id: string; stage: string }>).filter((connector) => flow.connectors.includes(connector.id));
    // Identity acquisition runs before the first agent that reads it (documents, identity or ownership).
    const identityReader = ["agent.document_intelligence", "agent.identity_verification", "agent.identity_ownership"].find((id) => agents.some((agent) => agent.id === id && segment(agent).length));
    if (identityReader && flowConnectors.some((connector) => connector.stage === "identity")) inserts.push({ before: firstOf(identityReader), stage: "identity" });
    if (flowConnectors.some((connector) => connector.stage === "screening")) inserts.push({ before: stepId("screening.sanctions.execute"), stage: "screening" });
    const ownerOf = new Map(agents.flatMap((agent) => segment(agent).map((skillId) => [skillId, agent.id] as const)));
    const usedTools = [...new Set(agents.flatMap((agent) => agent.tools))];
    const toolCapabilityDefs = (kybConnectors as any[]).filter((connector) => usedTools.includes(connector.capability)).map((connector) => ({
      id: connector.capability, kind: "tool", effect: "read", adapterBindingId: connector.connector, inputSchema: connector.input, outputSchema: connector.output, timeoutMs: connector.timeoutMs, maxAttempts: 1, idempotent: true,
    }));
    const limits = agents[0]!.limits as { maxSteps: number };
    const built = buildLibraryPackage({
      workflow, library, registry: inputs.registry,
      overlay: {
        policyOwnedActions: true,
        postNodes: [reviewNode(agents.at(-1)!)],
        postGates: [checkpoint("disposition", "The released installation policy authorizes disposition or requests scoped human evidence.")],
        purpose: PURPOSE, subjectsSelectorId: "caseSubjects",
        contextSelectors: [...CASE_SELECTORS, ...policySelectors, ...loopSelectors,
          {id:"finalDispositions",source:"case",path:"finalDispositions",purpose:PURPOSE,classification:"CONFIDENTIAL",required:false}],
        connectors: flowConnectors, connectorNode, inserts, extraSkills: optionalSkills,
        skillNode: (step: any, manifest: any, node: any) => {
          const caseBindings = CASE_BINDINGS[step.skill_id] ?? {};
          const params = structuredClone(step.parameters ?? {});
          for (const key of Object.keys(caseBindings)) delete params[key];
          const policies = skillPolicies(manifest);
          // The readers plan from the decision: its level and the requirements it resolved (level, rules and roles).
          const levelBinding = diligenceGate && DILIGENCE_READERS.includes(step.skill_id) ? {
            [`facts.${DILIGENCE_LEVEL_FACT}`]: `${DILIGENCE_NODE}.result.outputs.diligence.level`,
            [`facts.${DILIGENCE_REQUIREMENTS_FACT}`]: `${DILIGENCE_NODE}.result.outputs.diligence.requirements`,
          } : {};
          const parameterBindings = { ...(node.config.skillParameterBindings ?? {}), ...levelBinding };
          const bound = Object.keys(caseBindings).length || Object.keys(parameterBindings).length;
          return {
            ...node,
            contextSelectorIds: [...new Set([...node.contextSelectorIds, ...Object.values(caseBindings).flatMap(selectorsOf)])],
            config: {
              ...node.config, agentRef: ownerOf.get(step.skill_id), skillParameters: params,
              ...(Object.keys(parameterBindings).length ? { skillParameterBindings: parameterBindings } : {}),
              ...(Object.keys(caseBindings).length ? { skillContextBindings: caseBindings } : {}),
              ...(policies ? { skillPolicies: policies } : {}),
              ...(bound ? { requireBoundParameters: true } : {}),
              ...(SIGNAL_WRITES[step.skill_id] ? signalWrite(node, SIGNAL_WRITES[step.skill_id]!) : {}),
              ...(step.skill_id === "edd.trigger.evaluate" ? eddRequiredWrite(node) : {}),
              ...(step.skill_id === "decision.controls.assess" ? controlsWrite(node) : {}),
              ...(RECORD_WRITES[step.skill_id] ? recordWrite(node, step.skill_id, RECORD_WRITES[step.skill_id]!) : {}),
            },
          };
        },
        skillBindingPolicy: { require_entitlement: false, require_list_freshness: false, require_jurisdiction_coverage: false, allow_fallback: false, log_selected_implementation: true },
        intake: { id: "intake", kind: "input", name: "Case identity", summary: "Tenant and case identity only; the case's records, documents and policy pin come from the case store." },
        approval: { summary: "A different, authorized person decides the case (dual control).", contextSelectorIds: ["caseSubjects"], config: { dualControlRequired: true, allowedDecisions: ["APPROVE", "REJECT"] }, requireCompletedSkill: true },
        stop: { id: "stopped", kind: "output", name: "Policy handoff", summary: "The policy result and any authorized next actions are recorded. Missing evidence and unresolved installation policy remain explicit.", config: { usePredecessorInput: true,
          evidenceCapture: { type: `${flow.id.replace("-", "_")}_checkpoint_stop`, sourceType: "DERIVED", trustTier: "PLATFORM_DERIVED", instructionTrust: "UNTRUSTED_DATA" },
          caseWriteActor: "agent", caseWritePrincipalId: `flow:${flow.id}`,
          caseWrites: [
            { commandType: "LinkEvidence", payload: { evidenceId: "{{ evidence.evidenceId }}", purpose: "CHECKPOINT_STOP" }, payloadSchema: { type: "object", required: ["evidenceId", "purpose"] } },
            { commandType: "LinkExecution", payload: { runId: "{{ run.runId }}", planDigest: "{{ run.planDigest }}", purpose: `${flow.id.replace("-", "_").toUpperCase()}_STOPPED` }, payloadSchema: { type: "object", required: ["runId", "planDigest", "purpose"] } },
          ] } },
        result: { id: "result", kind: "output", name: "Result", contextSelectorIds:["finalDispositions"], summary: "A disposition applied by the released policy gate.", config: { usePredecessorInput: true, requireFinalDisposition:true,
          caseWriteActor: "agent", caseWritePrincipalId: `flow:${flow.id}`,
          caseWrites: [{ commandType: "LinkExecution", payload: { runId: "{{ run.runId }}", planDigest: "{{ run.planDigest }}", purpose: `${flow.id.replace("-", "_").toUpperCase()}_COMPLETED` }, payloadSchema: { type: "object", required: ["runId", "planDigest", "purpose"] } }],
        } },
        packageDocument: ({ capabilities, skillBindings, contextSelectors, connectorBindings }: any) => ({
          apiVersion: "harness.factory/domain-package-v2", kind: "DomainPackage",
          metadata: { name: flow.title, version: "2.0.0", domain: flow.domain, objective: flow.objective, owners: ["financial-crime-platform"], riskClass: "high" },
          workflow: "workflow.yaml", coordinationMode: "caseStore",
          budgets: { maxDurationMs: 3600000, maxCostUsd: 5, maxModelCalls: agents.length * (limits.maxSteps + 1), maxCapabilityCalls: ordered.length + agents.length * limits.maxSteps + 10 },
          modelProfiles: [...new Set(agents.map((agent) => agent.modelProfileId))].sort(),
          agentProfiles: agents.map((agent) => platformProfile(agent, [PURPOSE])),
          capabilities: [...capabilities, ...toolCapabilityDefs.filter((tool) => !capabilities.some((capability: { id: string }) => capability.id === tool.id)), ...agents.map((agent) => ({
            id: agent.loopCapability, kind: "model", effect: "paid", adapterBindingId: `openrouter:${agent.modelProfileId}`, inputSchema: { type: "object" }, outputSchema: { type: "object", required: ["action"] }, timeoutMs: 300000, maxAttempts: 1, idempotent: false,
          }))],
          bindings: {...connectorBindings,...Object.fromEntries(agents.map((agent) => [reviewId(agent), agent.loopCapability]))},
          skillBindings, policies: [{policyId:businessPolicy.compiled.manifest.policyId,policyVersion:businessPolicy.compiled.manifest.policyVersion,source:"policy.yaml",digest:businessPolicy.compiled.manifest.bundleDigest}], contextSelectors,
          contextClassificationPolicies: [{ classification: "PII", action: "allow" }, { classification: "CONFIDENTIAL", action: "allow" }],
          allowedRegions: flow.allowedRegions, dataClasses: ["PII", "CONFIDENTIAL", "PUBLIC_SOURCE"], evaluationRequirements: [`${flow.id}-corpus`],
        }),
        workflowDocument: ({ nodes, edges }: any) => ({
          apiVersion: "ladder.dev/v1alpha1", kind: "Workflow",
          metadata: { name: flow.id, title: flow.title, description: flow.objective, version: "2.0.0" },
          spec: { objective: flow.objective, inputs: { type: "object", required: ["tenantId", "caseId"], properties: { tenantId: { type: "string" }, caseId: { type: "string" } } }, outputs: { type: "object" }, policies: { maxConcurrency: 4, onFailure: "stop" }, nodes, edges },
        }),
      },
    });
    // Provider capabilities the flow's skills reach, and each binding's platform dependencies (CR-8).
    const pkg = built.packageDocument as { capabilities: Array<Record<string, unknown>>; skillBindings: Array<Record<string, unknown>> };
    for (const binding of pkg.skillBindings) {
      const providers = providersOf(String(binding.skillId));
      if (!providers.length) continue;
      binding.dependencyCapabilities = providers;
      for (const id of providers) {
        if (pkg.capabilities.some((capability) => capability.id === id)) continue;
        const { library, ...definition } = PROVIDER_CAPABILITIES[id]!;
        pkg.capabilities.push({ id, ...definition, inputSchema: PROVIDER_SCHEMAS[library]!.request, outputSchema: PROVIDER_SCHEMAS[library]!.response, maxAttempts: 1, idempotent: true });
      }
    }
    return { ...built, businessPolicy };
  }


  return { compose: build, roster, byId };
}

export { kybConnectors as acquisitionConnectors };
