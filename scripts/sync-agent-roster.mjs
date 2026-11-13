#!/usr/bin/env node
// The agent roster (agentic KYC/KYB plan phase 3): ten business agents, authored in domains/agents.
//
//   node scripts/sync-agent-roster.mjs [--check]
//
// Reads domains/agents/*.yaml and checks every agent against the skill library: imported agents keep
// their library mandate, personas and human gates, and every skill outside the library profile's
// allowed_skills is declared in `source.additions` with a reason; every skill exists, appears in one
// agent only, and loop (optional) skills are read-only; completion criteria come from the library task
// (`completion.libraryTask`, narrowed to the agent's own skills) or are authored over its own skills.
//
// Writes:
// - domains/agents/roster.json: the agents as platform agent profiles (package-agnostic; flows set
//   purposes and model capabilities), with their required and loop skills, tools and completion;
// - packages/contracts/test-fixtures/agent-roster/{package,workflow}.yaml: a roster package that runs
//   every agent once (required skills as skill nodes, a bounded loop per agent with its completion),
//   compiled by `make compile` to artifacts/agent-roster.plan.json so harnessc checks every profile.
// --check writes nothing and exits 1 when a committed file differs.
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { connectors as kybConnectors, connectorNode } from "./lib/kyb-connectors.mjs";
import { assertRegistrySnapshot, buildLibraryPackage, capabilityFor, createEmitter, json, readJson, recordSelectorsFor, registryEntries, repoRoot, toYaml, vendoredSkills } from "./lib/library-package.mjs";

const check = process.argv.includes("--check");
const { emit, state } = createEmitter(check);
const libraryRoot = resolve(repoRoot, "apps/fincrime-host");
const agentsRoot = resolve(repoRoot, "domains/agents");
const fixtureRoot = resolve(repoRoot, "packages/contracts/test-fixtures/agent-roster");
// The flow order: who works the case before whom.
const ORDER = ["agent.intake_profile", "agent.document_intelligence", "agent.identity_verification", "agent.identity_ownership", "agent.screening",
  "agent.investigation", "agent.risk_edd", "agent.relationship_product", "agent.decision_support", "agent.qa_assurance"];
const TIERS = { fast: "model.fast.v1", standard: "model.standard.v1", deep: "model.deep.v1", judge: "model.judge.v1" };
const LIMITS = { maxSteps: 6, maxObservationChars: 24000 };
// Record types an agent's review may read beside its skills' results (`reads:`), with the fields the
// context plane projects (the library context schema's data fields).
const READ_FIELDS = {
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
const fail = (code) => { throw new Error(code); };

const catalog = new Map(readJson(resolve(repoRoot, "config/skill-library/catalog.json")).skills.map((skill) => [skill.id, skill]));
const registry = registryEntries();
const effectMode = (skillId) => {
  const skill = catalog.get(skillId);
  return registry.get(`${skillId}@${skill.semver}`)?.effects.mode ?? fail(`roster.registry_entry_missing:${skillId}`);
};
// `enum: CATALOG_DOCUMENT_TYPES` in an agent's output fields: the document field catalog's type ids.
const documentTypes = readJson(resolve(libraryRoot, "src/kyc_documents/resources/catalog.json")).document_types.map((type) => type.id).sort();
const withCatalogEnums = (schema) => JSON.parse(JSON.stringify(schema), (key, value) => key === "enum" && value === "CATALOG_DOCUMENT_TYPES" ? documentTypes : value);
const modelProfiles = new Set(readJson(resolve(repoRoot, "config/model-profiles.json")).profiles.map((profile) => profile.id));
const toolCapabilities = new Map(kybConnectors.map((connector) => [connector.capability, connector]));

// ---- Load and check -------------------------------------------------------------------------
const authored = readdirSync(agentsRoot).filter((name) => name.endsWith(".yaml")).sort().map((name) => parse(readFileSync(join(agentsRoot, name), "utf8")));
const byId = new Map(authored.map((agent) => [agent.id, agent]));
if (byId.size !== authored.length) fail("roster.agent_duplicate");
if ([...byId.keys()].sort().join() !== [...ORDER].sort().join()) fail(`roster.order_mismatch:${[...byId.keys()].sort().join(",")}`);
const owner = new Map();
const agents = ORDER.map((id) => {
  const agent = byId.get(id);
  // Hydration skills (delivery plan wave 4): optional, read-only checks the agent runs before its
  // required skills, outside its completion. Their results are shown to its review, never required.
  const hydration = agent.skills.hydration ?? [];
  const required = agent.skills.required ?? [];
  const optional = agent.skills.optional ?? [];
  const human = agent.skills.human ?? [];
  const all = [...hydration, ...required, ...optional, ...human];
  for (const skillId of all) {
    if (!catalog.has(skillId)) fail(`roster.skill_unknown:${id}:${skillId}`);
    if (owner.has(skillId)) fail(`roster.skill_in_two_agents:${skillId}:${owner.get(skillId)}:${id}`);
    owner.set(skillId, id);
  }
  for (const skillId of optional) if (effectMode(skillId) !== "read_only") fail(`roster.loop_skill_not_read_only:${id}:${skillId}`);
  for (const skillId of hydration) if (effectMode(skillId) !== "read_only") fail(`roster.hydration_skill_not_read_only:${id}:${skillId}`);
  for (const tool of agent.tools ?? []) {
    const connector = toolCapabilities.get(tool) ?? fail(`roster.tool_unknown:${id}:${tool}`);
    if (connector.stage === "screening" && tool !== "screening.adverse_media.v1") fail(`roster.tool_acquires_screening:${id}:${tool}`);
  }
  if (!TIERS[agent.modelTier] || !modelProfiles.has(TIERS[agent.modelTier])) fail(`roster.model_tier_invalid:${id}`);
  for (const type of agent.reads ?? []) if (!READ_FIELDS[type]) fail(`roster.read_type_unknown:${id}:${type}`);

  let mandate, personas, humanGates;
  if (agent.source.library) {
    const library = readJson(resolve(libraryRoot, `profiles/${agent.source.library}.json`));
    mandate = library.mandate; personas = library.personas; humanGates = library.human_gates;
    const allowed = new Set(Object.keys(library.execution.allowed_skills));
    const additions = agent.source.additions ?? {};
    for (const skillId of all) {
      if (!allowed.has(skillId) && !additions[skillId]) fail(`roster.skill_not_in_library_profile:${id}:${skillId}`);
    }
    for (const skillId of Object.keys(additions)) if (!all.includes(skillId) || allowed.has(skillId)) fail(`roster.addition_unused:${id}:${skillId}`);
  } else {
    if (!agent.source.new || !agent.mandate || !agent.personas || !agent.humanGates) fail(`roster.new_agent_incomplete:${id}`);
    mandate = agent.mandate; personas = agent.personas; humanGates = agent.humanGates;
  }

  // Completion over the agent's own skills: the library task narrowed to them, or authored.
  // The human step's outcome is a person's, not the agent's task: completion covers required skills only.
  let completion;
  const own = new Set(required);
  if (agent.completion.libraryTask) {
    const task = readJson(resolve(libraryRoot, `tasks/${agent.completion.libraryTask}.json`));
    const skillOfStep = new Map(task.steps.map((step) => [step.id, step.skill_id]));
    completion = {
      criteria: task.completion_criteria.map((criterion) => ({ skill: skillOfStep.get(criterion.step_id), acceptedStatuses: criterion.accepted_statuses, requiredPayloadFields: criterion.required_payload_fields }))
        .filter((criterion) => own.has(criterion.skill)),
      failurePolicy: task.failure_policy,
      source: agent.completion.libraryTask,
    };
  } else {
    completion = { criteria: agent.completion.criteria, failurePolicy: agent.completion.failurePolicy, source: "authored" };
  }
  if (!completion.criteria.length) fail(`roster.completion_empty:${id}`);
  for (const criterion of completion.criteria) if (!own.has(criterion.skill)) fail(`roster.completion_skill_not_owned:${id}:${criterion.skill}`);

  const finding = { type: "object", additionalProperties: false, required: ["type", "severity", "reason", "sourceRefs"], properties: {
    type: { type: "string", minLength: 1 }, severity: { type: "string", enum: ["INFO", "REVIEW", "BLOCKING"] },
    reason: { type: "string", minLength: 1 }, sourceRefs: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } } } };
  const outputSchema = {
    type: "object", additionalProperties: false,
    required: ["summary", "findings", "gaps", "requiresHumanReview", ...agent.outputFields.required],
    properties: {
      summary: { type: "string", minLength: 1 },
      findings: { type: "array", items: finding },
      gaps: { type: "array", items: { type: "string" } },
      requiresHumanReview: agent.requiresHumanReview === "always" ? { const: true } : { type: "boolean" },
      ...withCatalogEnums(agent.outputFields.properties),
    },
  };
  const short = id.replace(/^agent\./, "").replaceAll("_", "-");
  const semver = (skillId) => catalog.get(skillId).semver;
  return {
    id, version: agent.version, name: agent.name, description: mandate, role: agent.role, personas, humanGates,
    source: agent.source, customerTypes: agent.customerTypes, modelTier: agent.modelTier, modelProfileId: TIERS[agent.modelTier],
    loopCapability: `model.${short}.loop.v1`,
    prompt: `${agent.prompt.trim()} Escalate to a person on: ${humanGates.join(", ")}.`,
    instruction: agent.instruction.trim(),
    skills: { hydration, required, optional, human },
    allowedSkills: [...new Set(all)].sort().map((skillId) => ({ skillId, semver: semver(skillId) })),
    tools: agent.tools ?? [],
    reads: agent.reads ?? [],
    completion,
    outputSchema,
    example: agent.example,
    limits: LIMITS,
  };
});

// The platform profile of an agent, given the purposes and model capability of the package it joins.
function platformProfile(agent, purposes) {
  const skillCapability = (skillId) => capabilityFor(skillId, catalog.get(skillId).semver);
  return {
    id: agent.id, version: agent.version, name: agent.name, description: agent.description, role: agent.role, prompt: agent.prompt,
    instructions: [
      { id: `${agent.id}.skills`, version: agent.version, name: "Run the agent's business skills", description: `The deterministic skills ${agent.id} runs, each pinned to its manifest.`,
        text: "Run each business skill exactly as the workflow binds it, over the records the platform selects. A skill's payload is evidence for review, not a decision.",
        allowedCapabilityIds: [...agent.skills.hydration, ...agent.skills.required, ...agent.skills.human].map(skillCapability) },
      { id: `${agent.id}.review`, version: agent.version, name: `${agent.name}: review`, description: agent.description, text: agent.instruction,
        allowedCapabilityIds: [agent.loopCapability, ...agent.tools, ...agent.skills.optional.map(skillCapability)] },
    ],
    allowedSkills: agent.allowedSkills, modelProfileId: agent.modelProfileId, runtimeTarget: "hosted_http", primaryCapabilityId: agent.loopCapability,
    inputSchema: { type: "object" }, outputSchema: agent.outputSchema, purposes, limits: agent.limits,
  };
}

emit(join(agentsRoot, "roster.json"), json({
  apiVersion: "harness.factory/agent-roster-v1",
  description: "GENERATED by scripts/sync-agent-roster.mjs from domains/agents/*.yaml -- do not edit; regenerate.",
  agents,
}));

// ---- The roster package ---------------------------------------------------------------------
const PURPOSE = "CDD_ONBOARDING";
// Placeholder parameters so the roster package compiles; flows bind the real values (phase 4).
const PARAMETERS = {
  "document.fields.contract_extract": { classifications: [], subject: "case-subject" },
  "document.fields.adjudicated_extract": { classifications: [], subject: "case-subject" },
  "document.requirements.resolve": { classifications: [], package: "corporate", event: null },
  "entity.resolve": { name: "case-subject", identifiers: [] },
  "ownership.interest.calculate": { target: "case-subject" },
  "ownership.ubo.resolve": { target: "case-subject" },
  "screening.sanctions.ownership.evaluate": { target: "case-subject", blocked_ids: [] },
  "screening.adverse_media.execute": { name: "case-subject" },
  "risk.tier.assign": { score: "0" },
  "edd.trigger.evaluate": { facts: {} },
  "decision.requirements.compile": { facts: {} },
  "decision.rules.evaluate": { facts: {} },
  "decision.human.review": { action: "REVIEW_CASE" },
};
const stepId = (skillId) => skillId.replaceAll(".", "_");
const nodeOf = (skillId) => stepId(skillId).replaceAll("_", "-");
/** An agent's run segment: its hydration checks, then its required skills. */
const segment = (agent) => [...agent.skills.hydration, ...agent.skills.required];
const flowSkills = agents.flatMap(segment);
const humanSkills = agents.flatMap((agent) => agent.skills.human);
const ordered = [...flowSkills, ...humanSkills];
const workflow = { id: "agent-roster", version: "1.0.0", steps: ordered.map((skillId, index) => ({
  id: stepId(skillId), skill_id: skillId, parameters: PARAMETERS[skillId] ?? {}, bindings: {},
  dependencies: index === 0 ? [] : [stepId(ordered[index - 1])], condition: null, success_condition: null,
})) };
const optionalSkills = agents.flatMap((agent) => agent.skills.optional);
const library = vendoredSkills({ libraryRoot, workflow, files: ["catalog/catalog.json"], extraSkillIds: optionalSkills });
assertRegistrySnapshot(library);
const manifests = new Map(library.skills.map((skill) => [skill.id, skill]));
const loopOwner = (agentId, skillId) => `${agentId.replace(/^agent\./, "").replaceAll("_", "-")}-review-${nodeOf(skillId)}`;
/** The review's own reads: optional record selectors (a missing type is an absence the agent reports, not a failure). */
const readSelectors = (agent, nodeId, purpose) => agent.reads.map((type) => ({
  id: `read${type}-${nodeId}`, source: "case", path: `records.${type}`, purpose, classification: "CONFIDENTIAL", required: false,
  record: { objectType: type, fields: READ_FIELDS[type], minCount: 0, maxAgeSeconds: null },
}));
const reviewNodeId = (agent) => `${agent.id.replace(/^agent\./, "").replaceAll("_", "-")}-review`;
const loopSelectors = agents.flatMap((agent) => [
  ...agent.skills.optional.flatMap((skillId) => recordSelectorsFor(manifests.get(skillId), loopOwner(agent.id, skillId), PURPOSE)),
  ...readSelectors(agent, reviewNodeId(agent), PURPOSE),
]);
const loopNode = (agent) => {
  const nodeId = `${agent.id.replace(/^agent\./, "").replaceAll("_", "-")}-review`;
  const skills = agent.skills.optional.map((skillId) => ({ skillId, contextSelectorIds: recordSelectorsFor(manifests.get(skillId), loopOwner(agent.id, skillId), PURPOSE).map((s) => s.id), parameters: {}, purpose: "onboarding" }));
  return {
    id: nodeId, kind: "agent", name: `${agent.name} (review)`, summary: agent.description, role: agent.role, prompt: agent.instruction,
    contextSelectorIds: [...new Set(["caseSubjects", ...skills.flatMap((skill) => skill.contextSelectorIds), ...readSelectors(agent, nodeId, PURPOSE).map((selector) => selector.id)])],
    inputSchema: { type: "object" }, outputSchema: agent.outputSchema,
    config: {
      agentRef: agent.id,
      loop: { ...agent.limits, tools: agent.tools, skills, repairAttempts: 1 },
      completion: { criteria: agent.completion.criteria.map((criterion) => ({ nodeId: nodeOf(criterion.skill), acceptedStatuses: criterion.acceptedStatuses, requiredPayloadFields: criterion.requiredPayloadFields })), failurePolicy: agent.completion.failurePolicy },
      evidenceCapture: { type: `roster_${nodeId.replaceAll("-", "_")}`, sourceType: "DERIVED", trustTier: "AGENT_DERIVED", instructionTrust: "UNTRUSTED_DATA" },
      caseWriteActor: "agent", caseWritePrincipalId: agent.id,
      caseWrites: [{ commandType: "LinkEvidence", payload: { evidenceId: "{{ evidence.evidenceId }}", purpose: `ROSTER_${nodeId.replaceAll("-", "_").toUpperCase()}` }, payloadSchema: { type: "object", required: ["evidenceId", "purpose"] } }],
    },
  };
};
// Each agent's review loop runs after its own required skills, before the next agent's first one.
const inserts = agents.flatMap((agent, index) => {
  const next = agents.slice(index + 1).find((candidate) => segment(candidate).length);
  const before = next ? stepId(segment(next)[0]) : stepId(humanSkills[0]);
  return [{ before, node: loopNode(agent) }];
});
const ownerOf = new Map(agents.flatMap((agent) => [...segment(agent), ...agent.skills.human].map((skillId) => [skillId, agent.id])));
const usedTools = [...new Set(agents.flatMap((agent) => agent.tools))];
const toolCapabilityDefs = kybConnectors.filter((connector) => usedTools.includes(connector.capability)).map((connector) => ({
  id: connector.capability, kind: "tool", effect: "read", adapterBindingId: connector.connector, inputSchema: connector.input, outputSchema: connector.output, timeoutMs: connector.timeoutMs, maxAttempts: 1, idempotent: true,
}));
const { packageDocument, workflowDocument } = buildLibraryPackage({
  workflow, library,
  overlay: {
    purpose: PURPOSE, subjectsSelectorId: "caseSubjects",
    contextSelectors: [{ id: "caseSubjects", source: "case", path: "subjects", purpose: PURPOSE, classification: "PII", required: true }, ...loopSelectors],
    connectors: [], connectorNode, inserts, extraSkills: optionalSkills,
    skillNode: (step, manifest, node) => ({ ...node, config: { ...node.config, agentRef: ownerOf.get(step.skill_id) } }),
    skillBindingPolicy: { require_entitlement: false, require_list_freshness: false, require_jurisdiction_coverage: false, allow_fallback: false, log_selected_implementation: true },
    intake: { id: "intake", kind: "input", name: "Case identity", summary: "Tenant and case identity only." },
    approval: { summary: "A different, authorized person approves the review (dual control).", contextSelectorIds: ["caseSubjects"], config: { dualControlRequired: true, allowedDecisions: ["APPROVE", "REJECT"] }, requireCompletedSkill: true },
    stop: { id: "stopped", kind: "output", name: "Stopped for handoff", summary: "Handoff.", config: { usePredecessorInput: true } },
    result: { id: "result", kind: "output", name: "Result", summary: "Reached only after an approved review.", config: { usePredecessorInput: true } },
    packageDocument: ({ capabilities, skillBindings, contextSelectors }) => ({
      apiVersion: "harness.factory/domain-package-v2", kind: "DomainPackage",
      metadata: { name: "Agent roster (test fixture)", version: "1.0.0", domain: "kyb", objective: "Run each of the ten business agents once so harnessc checks every agent profile, its skills, loop and completion. Not a flow: the agentic KYC and KYB flows are phase 4.", owners: ["financial-crime-platform"], riskClass: "high" },
      workflow: "workflow.yaml", coordinationMode: "caseStore",
      budgets: { maxDurationMs: 1800000, maxCostUsd: 2, maxModelCalls: agents.length * (LIMITS.maxSteps + 1), maxCapabilityCalls: ordered.length + agents.length * LIMITS.maxSteps + 5 },
      modelProfiles: [...new Set(agents.map((agent) => agent.modelProfileId))].sort(),
      agentProfiles: agents.map((agent) => platformProfile(agent, [PURPOSE])),
      capabilities: [...capabilities, ...toolCapabilityDefs, ...agents.map((agent) => ({
        id: agent.loopCapability, kind: "model", effect: "paid", adapterBindingId: `openrouter:${agent.modelProfileId}`, inputSchema: { type: "object" }, outputSchema: { type: "object", required: ["action"] }, timeoutMs: 60000, maxAttempts: 1, idempotent: false,
      }))],
      bindings: Object.fromEntries(agents.map((agent) => [`${agent.id.replace(/^agent\./, "").replaceAll("_", "-")}-review`, agent.loopCapability])),
      skillBindings, policies: [], contextSelectors,
      contextClassificationPolicies: [{ classification: "PII", action: "allow" }, { classification: "CONFIDENTIAL", action: "allow" }],
      allowedRegions: ["US"], dataClasses: ["PII", "CONFIDENTIAL", "PUBLIC_SOURCE"], evaluationRequirements: ["agent-roster-scripted"],
    }),
    workflowDocument: ({ nodes, edges }) => ({
      apiVersion: "ladder.dev/v1alpha1", kind: "Workflow",
      metadata: { name: "agent-roster", title: "Agent roster (test fixture)", description: "Each business agent once, in flow order.", version: "1.0.0" },
      spec: { objective: "Exercise every agent profile.", inputs: { type: "object", required: ["tenantId", "caseId"], properties: { tenantId: { type: "string" }, caseId: { type: "string" } } }, outputs: { type: "object" }, policies: { maxConcurrency: 4, onFailure: "stop" }, nodes, edges },
    }),
  },
});
const header = (title) => `# GENERATED by scripts/sync-agent-roster.mjs from domains/agents -- do not edit; regenerate.\n# ${title}\n`;
emit(join(fixtureRoot, "package.yaml"), header("Agent roster test package.") + toYaml(packageDocument));
emit(join(fixtureRoot, "workflow.yaml"), header("Agent roster workflow.") + toYaml(workflowDocument));
if (check && state.changed) process.exit(1);
process.stdout.write(check ? "agent roster is up to date\n" : `agent roster generated (${agents.length} agents, ${ordered.length} skill steps, ${optionalSkills.length} loop skills)\n`);
