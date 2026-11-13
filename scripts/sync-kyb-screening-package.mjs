#!/usr/bin/env node
// Generates domains/kyb-screening (package.yaml, workflow.yaml): production slice 1, corporate
// party screening and ownership for the US (docs/implementation/production-slice-1.md).
//
//   node scripts/sync-kyb-screening-package.mjs [--library <financial-crime skills checkout>] [--check]
//
// Sources: source/workflow.json (13-step topology), policy/slice-policy.json (the candidate slice
// policy, pinned into every policy-reading skill), the library's business agent profiles
// (apps/fincrime-host/profiles) and the shared KYB connector stages (scripts/lib/kyb-connectors.mjs).
// --library refreshes the vendored manifests in library/skills.json; --check writes nothing and
// exits 1 when a committed file differs.
//
// What this overlay adds to the shared library-package generator:
//   - every skill node runs as an agent profile (`config.agentRef`), imported from the library's
//     profile with the documented field mapping (docs/implementation/agent-profiles.md) and
//     narrowed to the slice: allowedSkills is the library profile's set intersected with the
//     slice, plus the explicit SLICE_PROFILE_ADDITIONS below;
//   - two advisory agent loops (ownership review, screening review) that may call read-only
//     connectors and write nothing but a link to their own AGENT_DERIVED evidence;
//   - the slice ends at decision.human.review, a human-gated skill followed by an independent
//     approval: the only disposition authority in the slice.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { connectorNode, connectors as kybConnectors } from "./lib/kyb-connectors.mjs";
import { assertRegistrySnapshot, buildLibraryPackage, capabilityFor, createEmitter, json, parseArgs, readJson, recordSelectorsFor, repoRoot, toYaml, vendoredSkills } from "./lib/library-package.mjs";

const { check, libraryRoot } = parseArgs(process.argv.slice(2));
const domainRoot = resolve(repoRoot, "domains/kyb-screening");
const vendorRoot = resolve(domainRoot, "library");
const { emit, state } = createEmitter(check);

const workflow = readJson(resolve(domainRoot, "source/workflow.json"));
// Business skills the review agents may choose to run (agent loop skills, phase 1 of the agentic
// plan): read-only, bound in the package, allowed by the agent's profile, no node of their own.
const LOOP_SKILLS = {
  "ownership-review": ["ownership.circular.detect", "ownership.control.resolve", "ownership.nominee.detect"],
  "screening-review": ["screening.pep.relationship.resolve", "screening.sanctions.control.evaluate"],
};
const loopSkillIds = Object.values(LOOP_SKILLS).flat();
if (libraryRoot) {
  emit(resolve(vendorRoot, "skills.json"), json(vendoredSkills({ libraryRoot, workflow, files: ["catalog/catalog.json"], extraSkillIds: loopSkillIds })));
}
const library = readJson(resolve(vendorRoot, "skills.json"));
assertRegistrySnapshot(library);

// The slice policy, pinned by digest. A case must be opened under this policy id with this
// digest as its bundle digest; a case pinned to anything else gets no policy section and its
// policy-reading skills are not called (POLICY_UNRESOLVED).
const POLICY_FILE = "policy/slice-policy.json";
const policyBytes = readFileSync(resolve(domainRoot, POLICY_FILE));
const policyPack = JSON.parse(policyBytes.toString("utf8"));
const policyDigest = createHash("sha256").update(policyBytes).digest("hex");

function skillPolicyFor(manifest) {
  const fields = [...new Set(manifest.policy_context_fields ?? [])].sort();
  const relevant = new Set([`skill:${manifest.id}`, `effect:${manifest.effects}`]);
  const resolved = fields.filter((field) => Object.hasOwn(policyPack, field));
  return {
    policyRef: policyPack.id,
    policyVersion: policyPack.version,
    bundleDigest: policyDigest,
    fields,
    values: Object.fromEntries(resolved.map((field) => [field, field === "permissions" ? policyPack.permissions.filter((permission) => relevant.has(permission)) : policyPack[field]])),
    sources: Object.fromEntries(resolved.map((field) => [field, `${POLICY_FILE} ${field}${policyPack.basis?.[field] ? ` (${policyPack.basis[field]})` : ""}`])),
    unresolved: fields.filter((field) => !Object.hasOwn(policyPack, field)),
  };
}

const PURPOSE = "KYB_SCREENING_OWNERSHIP";
const MODEL_PROFILE = "model.standard.v1";
const RUNTIME_TARGET = "hosted_http";

// ---------------------------------------------------------------------------------------------
// Agent profiles

// Slice skills the library's profiles do not list. Each matches the profile's mandate and is a
// proposed library change (docs/implementation/production-slice-1.md section 4).
const SLICE_PROFILE_ADDITIONS = {
  "agent.identity_ownership": ["ownership.graph.build", "ownership.interest.calculate"],
  "agent.screening": ["screening.name.normalize", "screening.sanctions.ownership.evaluate"],
  "agent.decision_support": ["decision.policy.resolve"],
};
const manifests = new Map(library.skills.map((skill) => [skill.id, skill]));
const sliceSkills = new Set(workflow.steps.map((step) => step.skill_id));
const libraryProfiles = Object.keys(SLICE_PROFILE_ADDITIONS).map((id) => readJson(resolve(libraryRoot, `profiles/${id}.json`)));
const profileOfSkill = new Map();
for (const profile of libraryProfiles) {
  const skills = [...Object.keys(profile.execution.allowed_skills).filter((id) => sliceSkills.has(id)), ...SLICE_PROFILE_ADDITIONS[profile.id]];
  for (const skillId of skills) {
    if (profileOfSkill.has(skillId)) throw new Error(`slice.skill_in_two_profiles:${skillId}`);
    profileOfSkill.set(skillId, profile.id);
  }
}
const unowned = [...sliceSkills].filter((id) => !profileOfSkill.has(id));
if (unowned.length) throw new Error(`slice.skill_without_profile:${unowned.join(",")}`);
// Task completion criteria come from the library's task specs (completion_criteria,
// failure_policy), narrowed to the steps this slice runs.
const TASKS = { "agent.identity_ownership": "task.identity_ownership", "agent.screening": "task.screening" };
function completionFor(profileId) {
  const task = readJson(resolve(libraryRoot, `tasks/${TASKS[profileId]}.json`));
  const stepIds = new Set(workflow.steps.map((step) => step.id));
  return {
    criteria: task.completion_criteria.filter((criterion) => stepIds.has(criterion.step_id)).map((criterion) => ({
      nodeId: criterion.step_id.replaceAll("_", "-"), acceptedStatuses: criterion.accepted_statuses, requiredPayloadFields: criterion.required_payload_fields,
    })),
    failurePolicy: task.failure_policy,
  };
}

// The two advisory review loops.
const recordSelector = (id, objectType, fields) => ({ id, source: "case", path: `records.${objectType}`, purpose: PURPOSE, classification: "CONFIDENTIAL", required: false,
  record: { objectType, fields, minCount: 0, maxAgeSeconds: null } });
const reviewSelectors = [
  recordSelector("reviewEntities", "Entity", ["name", "identifiers", "entity_type"]),
  recordSelector("reviewOwnershipInterests", "OwnershipInterest", ["owner", "owned", "interest"]),
  recordSelector("reviewOwnershipRanges", "OwnershipRange", ["owner", "owned", "lower", "upper", "lower_inclusive", "upper_inclusive"]),
  recordSelector("reviewControlRights", "ControlRight", ["controller", "controlled", "basis", "verified"]),
  recordSelector("reviewBeneficialOwners", "BeneficialOwner", ["entity_id", "evidence_ids"]),
  recordSelector("reviewScreeningHits", "ScreeningHit", ["entity_id", "entry_id", "features"]),
  recordSelector("reviewWatchlistEntries", "WatchlistEntry", ["name", "identifiers", "list_type", "list_version", "coverage"]),
];
const sourceRefs = { type: "array", minItems: 1, items: { type: "string", minLength: 1 } };
const loops = [
  {
    nodeId: "ownership-review", before: "screening_name_normalize", profile: "agent.identity_ownership",
    capability: "model.kyb.ownership_review.v1", name: "Ownership review (advisory agent)", role: "Ownership analyst (advisory)",
    summary: "Bounded loop over read-only registry, officer, LEI and ownership connectors: explain what remains unresolved in the ownership structure (ranges, cycles, unaccounted interest, unverified owners) and what would resolve it. Proposes; decides nothing.",
    tools: ["business.registry.lookup.v1", "business.officers.lookup.v1", "business.ownership.discover.v1", "reference.identifier.lookup.v1"],
    selectors: ["kybSubjects", "reviewEntities", "reviewOwnershipInterests", "reviewOwnershipRanges", "reviewControlRights", "reviewBeneficialOwners"],
    instruction: "Start from the ownership records the skills used. Run an ownership skill (circular holdings, control rights, nominee indicators) only when its result could resolve an open item. For every unresolved item (an ownership range, a cycle, interest not accounted for, an owner without verification) look up only what could resolve it, and record each finding with the record or observation ids it rests on. Never compute a final UBO list, never treat a range as an exact interest, never treat a connector outcome of unknown, not_checked or inconclusive as resolved, and say plainly what remains open.",
    output: { type: "object", additionalProperties: false, required: ["summary", "findings", "gaps", "requiresHumanReview"], properties: {
      summary: { type: "string", minLength: 1 },
      findings: { type: "array", items: { type: "object", additionalProperties: false, required: ["type", "entityRef", "reason", "sourceRefs"], properties: {
        type: { type: "string", enum: ["UNRESOLVED_RANGE", "CYCLE", "UNACCOUNTED_INTEREST", "UNVERIFIED_OWNER", "CONTROL_WITHOUT_OWNERSHIP", "OTHER"] },
        entityRef: { type: "string", minLength: 1 }, reason: { type: "string", minLength: 1 }, sourceRefs } } },
      gaps: { type: "array", items: { type: "string" } },
      requiresHumanReview: { const: true },
    } },
  },
  {
    nodeId: "screening-review", before: "decision_human_review", profile: "agent.screening",
    capability: "model.kyb.screening_review.v1", name: "Screening candidate review (advisory agent)", role: "Sanctions analyst (advisory)",
    summary: "Bounded loop over read-only registry and identifier connectors: for each screening candidate, gather corroborating or contradicting identifying facts and propose a non-final disposition for the reviewer. Never clears a hit.",
    tools: ["business.registry.lookup.v1", "reference.identifier.lookup.v1"],
    selectors: ["kybSubjects", "reviewEntities", "reviewScreeningHits", "reviewWatchlistEntries"],
    instruction: "For each screening hit, compare the subject's identifying facts with the list entry's. Run the PEP relationship or sanctions control skill only when a hit or a controller makes it relevant: identifiers of the same type, date of birth or incorporation, nationality or jurisdiction. Look up a registry or identifier record only when it could confirm or contradict the match. Propose FALSE_MATCH_CANDIDATE only when a like-for-like identifying fact contradicts the entry, LIKELY_TRUE_MATCH only when one corroborates it, and REVIEW otherwise. Every proposal is final: false and cites the records or observations it rests on; a person makes every disposition.",
    output: { type: "object", additionalProperties: false, required: ["summary", "proposals", "gaps", "requiresHumanReview"], properties: {
      summary: { type: "string", minLength: 1 },
      proposals: { type: "array", items: { type: "object", additionalProperties: false, required: ["hitRef", "proposal", "final", "rationale", "sourceRefs"], properties: {
        hitRef: { type: "string", minLength: 1 }, proposal: { type: "string", enum: ["FALSE_MATCH_CANDIDATE", "REVIEW", "LIKELY_TRUE_MATCH"] },
        final: { const: false }, rationale: { type: "string", minLength: 1 }, sourceRefs } } },
      gaps: { type: "array", items: { type: "string" } },
      requiresHumanReview: { const: true },
    } },
  },
];
const LOOP_LIMITS = { maxSteps: 6, maxObservationChars: 24000 };
const loopSkillOwner = (nodeId, skillId) => `${nodeId}-${skillId.replaceAll(".", "-").replaceAll("_", "-")}`;
const loopSkillSelectors = Object.entries(LOOP_SKILLS).flatMap(([nodeId, skillIds]) =>
  skillIds.flatMap((skillId) => recordSelectorsFor(manifests.get(skillId), loopSkillOwner(nodeId, skillId), PURPOSE)));

function agentProfile(libraryProfile) {
  const loop = loops.find((item) => item.profile === libraryProfile.id);
  const loopSkillList = loop ? LOOP_SKILLS[loop.nodeId] : [];
  const skills = [...[...profileOfSkill].filter(([, owner]) => owner === libraryProfile.id).map(([skillId]) => skillId), ...loopSkillList].sort();
  const skillCapabilities = skills.map((skillId) => capabilityFor(skillId, manifests.get(skillId).semver));
  const humanGates = libraryProfile.human_gates.join(", ");
  return {
    id: libraryProfile.id,
    version: libraryProfile.version,
    name: libraryProfile.id.replace(/^agent\./, "").split("_").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ") + " agent",
    description: libraryProfile.mandate,
    role: libraryProfile.personas.join(", "),
    prompt: `${libraryProfile.execution.instructions} Scope: production slice 1, US corporate onboarding. Escalate to a person on: ${humanGates}.`,
    instructions: [
      { id: `${libraryProfile.id}.skills`, version: libraryProfile.version, name: "Run the slice's business skills",
        description: `The deterministic ${libraryProfile.id} skills of the slice, each pinned to its manifest.`,
        text: "Run each business skill exactly as the workflow binds it, over the records the platform selects. A skill's payload is evidence for review, not a decision.",
        allowedCapabilityIds: skillCapabilities },
      ...(loop ? [{ id: `${libraryProfile.id}.review`, version: "1.0.0", name: loop.name, description: loop.summary, text: loop.instruction,
        allowedCapabilityIds: [loop.capability, ...loop.tools, ...loopSkillList.map((skillId) => capabilityFor(skillId, manifests.get(skillId).semver))] }] : []),
    ],
    allowedSkills: skills.map((skillId) => ({ skillId, semver: manifests.get(skillId).semver })),
    modelProfileId: MODEL_PROFILE,
    runtimeTarget: RUNTIME_TARGET,
    ...(loop ? { primaryCapabilityId: loop.capability } : {}),
    inputSchema: { type: "object" },
    outputSchema: loop ? loop.output : { type: "object" },
    purposes: [PURPOSE],
    limits: LOOP_LIMITS,
  };
}

function loopNode(loop) {
  const skills = LOOP_SKILLS[loop.nodeId].map((skillId) => {
    const manifest = manifests.get(skillId);
    const selectors = recordSelectorsFor(manifest, loopSkillOwner(loop.nodeId, skillId), PURPOSE).map((selector) => selector.id);
    return { skillId, contextSelectorIds: selectors, parameters: {}, ...((manifest.policy_context_fields ?? []).length ? { skillPolicy: skillPolicyFor(manifest) } : {}), purpose: "onboarding" };
  });
  return {
    id: loop.nodeId, kind: "agent", name: loop.name, summary: loop.summary,
    role: loop.role,
    prompt: loop.instruction,
    contextSelectorIds: [...loop.selectors, ...skills.flatMap((skill) => skill.contextSelectorIds)],
    inputSchema: { type: "object" },
    outputSchema: loop.output,
    config: {
      agentRef: loop.profile,
      loop: { ...LOOP_LIMITS, tools: loop.tools, skills, repairAttempts: 1 },
      completion: completionFor(loop.profile),
      evidenceCapture: { type: `kyb_slice_${loop.nodeId.replaceAll("-", "_")}`, sourceType: "DERIVED", trustTier: "AGENT_DERIVED", instructionTrust: "UNTRUSTED_DATA" },
      caseWriteActor: "agent",
      caseWritePrincipalId: loop.profile,
      caseWrites: [{ commandType: "LinkEvidence", payload: { evidenceId: "{{ evidence.evidenceId }}", purpose: `KYB_SLICE_${loop.nodeId.replaceAll("-", "_").toUpperCase()}` }, payloadSchema: { type: "object", required: ["evidenceId", "purpose"] } }],
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Connectors: the KYB stages without documents and adverse media (out of slice scope).
const SLICE_CONNECTORS = ["acquire-registry", "acquire-lei", "acquire-officers", "acquire-ownership", "acquire-sanctions", "acquire-pep"];
const connectors = kybConnectors.filter((connector) => SLICE_CONNECTORS.includes(connector.id));
const modelCapability = (loop) => ({
  id: loop.capability, kind: "model", effect: "paid", adapterBindingId: `openrouter:${MODEL_PROFILE}`,
  inputSchema: { type: "object" },
  // The loop model returns protocol actions; the runtime validates them and the agent's final output.
  outputSchema: { type: "object", required: ["action"] },
  timeoutMs: 60000, maxAttempts: 1, idempotent: false,
});

const { packageDocument, workflowDocument } = buildLibraryPackage({
  workflow,
  library,
  overlay: {
    purpose: PURPOSE,
    subjectsSelectorId: "kybSubjects",
    contextSelectors: [
      { id: "kybSubjects", source: "case", path: "subjects", purpose: PURPOSE, classification: "PII", required: true },
      { id: "screeningEntities", source: "case", path: "records.Entity", purpose: PURPOSE, classification: "PII", required: false,
        record: { objectType: "Entity", fields: ["name", "identifiers", "entity_type"], minCount: 0, maxAgeSeconds: null } },
      { id: "name", source: "case", path: "subjects.0.display_name", purpose: PURPOSE, classification: "PII", required: true },
      { id: "country", source: "case", path: "subjects.0.attributes.country", purpose: PURPOSE, classification: "PII", required: false },
      { id: "registrationNumber", source: "case", path: "subjects.0.attributes.registrationNumber", purpose: PURPOSE, classification: "PII", required: false },
      { id: "lei", source: "case", path: "subjects.0.attributes.lei", purpose: PURPOSE, classification: "PII", required: false },
      ...reviewSelectors,
      ...loopSkillSelectors,
    ],
    connectors,
    connectorNode,
    extraSkills: loopSkillIds,
    inserts: [
      { before: "entity_resolve", stage: "identity" },
      { before: "screening_name_normalize", node: loopNode(loops[0]) },
      { before: "screening_sanctions_execute", stage: "screening" },
      { before: "decision_human_review", node: loopNode(loops[1]) },
    ],
    skillNode: (step, manifest, node) => {
      const bindings = { entity_resolve: { name: "name" }, screening_name_normalize: { name: "name" } }[step.id] ?? {};
      const parameters = structuredClone(step.parameters ?? {});
      for (const key of Object.keys(bindings)) delete parameters[key];
      const parameterBindings = { ...(node.config.skillParameterBindings ?? {}),
        ...({ ownership_interest_calculate: { target: "acquire-ownership.subjectEntityId" }, ownership_ubo_resolve: { target: "acquire-ownership.subjectEntityId" },
          screening_sanctions_ownership_evaluate: { target: "acquire-ownership.subjectEntityId" } }[step.id] ?? {}) };
      return {
        ...node,
        contextSelectorIds: [...node.contextSelectorIds, ...Object.values(bindings)],
        config: {
          ...node.config,
          agentRef: profileOfSkill.get(step.skill_id),
          ...((manifest.policy_context_fields ?? []).length ? { skillPolicy: skillPolicyFor(manifest) } : {}),
          skillParameters: parameters,
          ...(Object.keys(parameterBindings).length ? { skillParameterBindings: parameterBindings } : {}),
          ...(Object.keys(bindings).length ? { skillContextBindings: bindings } : {}),
          requireBoundParameters: true,
        },
      };
    },
    // Skill candidates are the in-house library host (`skills:<id>`), not licensed providers: entitlement
    // and coverage attestations belong to the connectors, which reach the gateway through their own bindings.
    skillBindingPolicy: { require_entitlement: false, require_list_freshness: false, require_jurisdiction_coverage: false, allow_fallback: false, log_selected_implementation: true },
    intake: { id: "intake", kind: "input", name: "Slice case identity", summary: "Accept only tenant and case identity; the subject and every record come from the canonical case store." },
    approval: {
      summary: "The slice's assessment is a proposal until a different, authorized person approves the review (dual control).",
      contextSelectorIds: ["kybSubjects"],
      config: { dualControlRequired: true, allowedDecisions: ["APPROVE", "REJECT"] },
      requireCompletedSkill: true,
    },
    stop: { id: "slice-stopped", kind: "output", name: "Slice stopped for handoff", summary: "The human review could not be requested or the reviewer rejected the assessment; the case stays open for handoff.", config: { usePredecessorInput: true } },
    result: { id: "result", kind: "output", name: "Screening and ownership assessment", summary: "Reached only after an independent person approved the review. It is an assessment, not customer acceptance.", config: { usePredecessorInput: true } },
    packageDocument: ({ capabilities, skillBindings, contextSelectors, connectorBindings, stepCount }) => ({
      apiVersion: "harness.factory/domain-package-v2",
      kind: "DomainPackage",
      metadata: {
        name: "KYB screening and ownership (production slice 1)",
        version: workflow.version,
        domain: "kyb",
        objective: "Corporate onboarding, US: establish legal-entity existence, ownership, control and beneficial owners, and screen the customer and its related parties for sanctions (including the OFAC 50 percent rule) and PEP status, ending at an independent human review. Candidate policy; not yet production-qualified.",
        owners: ["kyb-policy-owner", "financial-crime-platform"],
        riskClass: "high",
      },
      workflow: "workflow.yaml",
      coordinationMode: "caseStore",
      budgets: {
        maxDurationMs: 900000,
        maxCostUsd: 1,
        maxModelCalls: loops.length * (LOOP_LIMITS.maxSteps + 1),
        maxCapabilityCalls: stepCount + 4 + 2 * 50 + loops.length * LOOP_LIMITS.maxSteps + 3,
      },
      modelProfiles: [MODEL_PROFILE],
      agentProfiles: libraryProfiles.map(agentProfile),
      capabilities: [...capabilities, ...loops.map(modelCapability)],
      bindings: { ...connectorBindings, ...Object.fromEntries(loops.map((loop) => [loop.nodeId, loop.capability])) },
      skillBindings,
      policies: [],
      contextSelectors,
      contextClassificationPolicies: [{ classification: "PII", action: "allow" }, { classification: "CONFIDENTIAL", action: "allow" }],
      allowedRegions: ["US"],
      dataClasses: ["PII", "CONFIDENTIAL", "PUBLIC_SOURCE"],
      evaluationRequirements: ["slice-1-skill-evaluation", "slice-1-agent-evaluation", "canonical-record-normalizers", "independent-review"],
    }),
    workflowDocument: ({ nodes, edges }) => ({
      apiVersion: "ladder.dev/v1alpha1",
      kind: "Workflow",
      metadata: { name: "kyb-screening-ownership-us", title: "KYB screening and ownership (production slice 1)", description: workflow.description, version: workflow.version },
      spec: {
        objective: "Produce an evidence-cited screening and ownership assessment for independent human review, never claiming more than the records establish.",
        inputs: { type: "object", required: ["tenantId", "caseId"], properties: { tenantId: { type: "string" }, caseId: { type: "string" } } },
        outputs: { type: "object" },
        policies: { maxConcurrency: 4, onFailure: "stop" },
        nodes,
        edges,
      },
    }),
  },
});

const header = (title) => `# GENERATED by scripts/sync-kyb-screening-package.mjs from domains/kyb-screening/{source,policy,library}\n# and the library's agent profiles -- do not edit; regenerate.\n# ${title}\n`;
emit(resolve(domainRoot, "package.yaml"), header("Production slice 1 domain package (v2).") + toYaml(packageDocument));
emit(resolve(domainRoot, "workflow.yaml"), header("Production slice 1 workflow.") + toYaml(workflowDocument));
if (check && state.changed) process.exit(1);
process.stdout.write(check ? "domains/kyb-screening is up to date\n" : `domains/kyb-screening generated (${workflow.steps.length} skills, ${connectors.length} connectors, ${loops.length} agent loops)\n`);
