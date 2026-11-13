#!/usr/bin/env node
// ARCHIVED: the deterministic KYB flow is frozen (domains/archive/README.md). This generator is kept so
// the archived package regenerates byte-identically; its GENERATED header text is frozen with it.
// Generates domains/archive/kyb-deterministic (package.yaml, workflow.yaml) from the financial-crime skill library's
// synthetic KYB workflow (workflows/synthetic-kyb.json, 29 steps) and its skill manifests.
//
//   node scripts/sync-kyb-package.mjs [--library <financial-crime skills checkout>] [--check]
//
// --library  refresh the vendored snapshot in domains/archive/kyb-deterministic/library/ from a library checkout
//            (workflows/synthetic-kyb.json, the 29 workflow skills' manifests from
//            catalog/catalog.json and the synthetic policy pack policies/synthetic/neutral.json).
//            Without it the vendored snapshot is the source.
// --check    write nothing; exit 1 when the committed package differs from what would be generated.
//
// The generator itself is shared with domains/archive/kyc-v2-deterministic (scripts/lib/library-package.mjs); this
// file is the KYB platform overlay: its connector acquisition stages, package metadata and the
// policy projection. KYB has no OPA gate (domains/archive/kyb-deterministic/README.md#gates). Each skill node that
// declares `policy_context_fields` pins `config.skillPolicy`, the library's synthetic,
// jurisdiction-neutral policy pack projected to those fields (CR-4); the context plane resolves
// it against the case's pinned policy and sends it as the `policy` section
// (packages/context-plane/src/policy.ts, the same mechanism KYC uses for its OPA bundle).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { connectorNode, connectors } from "./lib/kyb-connectors.mjs";
import { assertRegistrySnapshot, buildLibraryPackage, createEmitter, json, parseArgs, readJson, repoRoot, toYaml, vendoredSkills } from "./lib/library-package.mjs";

const { check, libraryRoot } = parseArgs(process.argv.slice(2));
const domainRoot = resolve(repoRoot, "domains/archive/kyb-deterministic");
const vendorRoot = resolve(domainRoot, "library");
const { emit, state } = createEmitter(check);
// The library's synthetic, jurisdiction-neutral policy pack, vendored byte for byte. Its id is the
// policy a KYB case must be opened under (with the pack's digest as the policy bundle digest);
// a case pinned to any other policy gets no policy section and its policy-reading skills are
// not called (POLICY_UNRESOLVED).
const POLICY_FILE = "policy.synthetic-neutral.json";
const POLICY_ID = "policy.synthetic.neutral";
const bankingPolicy = readJson(resolve(repoRoot, "domains/fincrime/banking-policy.json"));

if (libraryRoot) { // always set: --library or apps/fincrime-host
  const workflow = readJson(resolve(libraryRoot, "workflows/synthetic-kyb.json"));
  emit(resolve(vendorRoot, "synthetic-kyb.json"), json(workflow));
  emit(resolve(vendorRoot, POLICY_FILE), readFileSync(resolve(libraryRoot, "policies/synthetic/neutral.json"), "utf8"));
  emit(resolve(vendorRoot, "skills.json"), json(vendoredSkills({ libraryRoot, workflow, files: ["workflows/synthetic-kyb.json", "catalog/catalog.json", "policies/synthetic/neutral.json"] })));
}
// Deployable topology is authored separately from the upstream demonstration.
const workflow = readJson(resolve(domainRoot, "source/kyb-workflow.json"));
const library = readJson(resolve(vendorRoot, "skills.json"));
assertRegistrySnapshot(library);
const policyBytes = readFileSync(resolve(vendorRoot, POLICY_FILE));
const policyPack = JSON.parse(policyBytes.toString("utf8"));
const policyDigest = createHash("sha256").update(policyBytes).digest("hex");

/**
 * The skill's `policy_context_fields` projection of the pinned pack, in the shape
 * packages/context-plane/src/policy.ts resolves (`skillPolicyConfigSchema`). Fields the pack
 * lacks are listed as `unresolved`, never invented: the skill is then not called. `permissions`
 * is scoped to the grants this execution's own check reads (`skill:<id>`, `effect:<effects>`
 * for a write skill, and `skill:<target_skill>` for case.context.hydrate) instead of the
 * tenant's whole grant list.
 */
function skillPolicyFor(manifest, step) {
  const fields = [...new Set(manifest.policy_context_fields ?? [])].sort();
  const relevant = new Set([`skill:${manifest.id}`, `effect:${manifest.effects}`, ...(manifest.id === "case.context.hydrate" && step.parameters?.target_skill ? [`skill:${step.parameters.target_skill}`] : [])]);
  const resolved = fields.filter((field) => Object.hasOwn(policyPack, field));
  return {
    policyRef: POLICY_ID,
    policyVersion: policyPack.version,
    bundleDigest: policyDigest,
    fields,
    values: Object.fromEntries(resolved.map((field) => [field, field === "permissions" ? policyPack.permissions.filter((permission) => relevant.has(permission)) : policyPack[field]])),
    sources: Object.fromEntries(resolved.map((field) => [field, `${POLICY_FILE} ${field}${field === "permissions" ? " (scoped to this execution)" : ""}`])),
    unresolved: fields.filter((field) => !Object.hasOwn(policyPack, field)),
  };
}

const PURPOSE = "KYB_ONBOARDING";

const { packageDocument, workflowDocument, manifests: _manifests } = buildLibraryPackage({
  workflow,
  library,
  overlay: {
    purpose: PURPOSE,
    subjectsSelectorId: "kybSubjects",
    contextSelectors: [
      { id: "kybSubjects", source: "case", path: "subjects", purpose: PURPOSE, classification: "PII", required: true },
      { id: "screeningEntities", source: "case", path: "records.Entity", purpose: PURPOSE, classification: "PII", required: false,
        record: { objectType: "Entity", fields: ["name", "identifiers", "entity_type"], minCount: 0, maxAgeSeconds: null } },
      { id: "bankingRelationships", source: "case", path: "records.BankingRelationship", purpose: PURPOSE, classification: "CONFIDENTIAL", required: true },
      { id: "bankingControls", source: "case", path: "records.ControlAssessment", purpose: PURPOSE, classification: "CONFIDENTIAL", required: false },
      { id: "name", source: "case", path: "subjects.0.display_name", purpose: PURPOSE, classification: "PII", required: true },
      { id: "country", source: "case", path: "subjects.0.attributes.country", purpose: PURPOSE, classification: "PII", required: false },
      { id: "registrationNumber", source: "case", path: "subjects.0.attributes.registrationNumber", purpose: PURPOSE, classification: "PII", required: false },
      { id: "lei", source: "case", path: "subjects.0.attributes.lei", purpose: PURPOSE, classification: "PII", required: false },
      { id: "caseId", source: "case", path: "case.caseId", purpose: PURPOSE, classification: "CONFIDENTIAL", required: true },
      { id: "subjectId", source: "case", path: "subjects.0.subject_id", purpose: PURPOSE, classification: "CONFIDENTIAL", required: true },
    ],
    connectors,
    connectorNode,
    inserts: [{ before: "entity_resolve", stage: "identity" }, { before: "screening_sanctions_execute", stage: "screening" },
      { before: "decision_requirements_compile", checkpoint: { id: "banking-product-readiness", kind: "transform", name: "Banking product control readiness",
        contextSelectorIds: ["bankingRelationships", "bankingControls"], config: { operation: "select", path: "/", bankingAssessment: bankingPolicy } } }],
    // The pinned policy pack projected to each policy-reading skill (the `policy` section).
    skillNode: (step, manifest, node) => {
      let authored = (manifest.policy_context_fields ?? []).length
        ? { ...node, config: { ...node.config, skillPolicy: skillPolicyFor(manifest, step) } }
        : node;
      // The source is a demonstration workflow. Keep its step topology, but never let
      // demonstration identities or optimistic facts become case authority.
      const bindings = {
        entity_resolve: { name: "name" },
        screening_adverse_media_execute: { name: "name" },
        document_fields_contract_extract: { subject: "subjectId" },
      }[step.id] ?? {};
      const parameters = structuredClone(step.parameters ?? {});
      if (parameters.facts) parameters.facts = {};
      for (const key of Object.keys(bindings)) delete parameters[key];
      const parameterBindings = { ...(authored.config.skillParameterBindings ?? {}) };
      Object.assign(parameterBindings, {
        entity_match: { left: "acquire-registry.records.0.data", right: "acquire-lei.records.0.data" },
        ownership_interest_calculate: { target: "acquire-ownership.subjectEntityId" },
        ownership_ubo_resolve: { target: "acquire-ownership.subjectEntityId" },
      }[step.id] ?? {});
      authored = { ...authored, contextSelectorIds: [...authored.contextSelectorIds, ...Object.values(bindings)],
        config: { ...authored.config, skillParameters: parameters, skillParameterBindings: parameterBindings,
          ...(Object.keys(bindings).length ? { skillContextBindings: bindings } : {}), requireBoundParameters: true } };
      return authored;
    },
    skillBindingPolicy: { require_entitlement: false, require_list_freshness: false, require_jurisdiction_coverage: false, allow_fallback: false, log_selected_implementation: true },
    intake: { id: "intake", kind: "input", name: "KYB case identity", summary: "Accept only tenant and case identity; the subject and every record come from the canonical case store." },
    approval: {
      summary: "The skill's payload is a proposal until a different, authorized human approves it (library approval flow).",
      contextSelectorIds: ["kybSubjects"],
      config: { dualControlRequired: false, allowedDecisions: ["APPROVE", "REJECT"] },
    },
    stop: { id: "kyb-stopped", kind: "output", name: "KYB stopped for handoff", summary: "A library success condition did not hold (EDD required, evidence insufficient, rules not PASS) or a human rejected the disposition; the case stays open for workflow handoff.", config: { usePredecessorInput: true } },
    result: { id: "result", kind: "output", name: "KYB result", summary: "The last library step's output, reached only after the independent approval of the disposition.", config: { usePredecessorInput: true } },
    packageDocument: ({ capabilities, skillBindings, contextSelectors, connectorBindings, stepCount }) => ({
      apiVersion: "harness.factory/domain-package-v2",
      kind: "DomainPackage",
      metadata: {
        name: "KYB synthetic",
        version: library.source.catalogVersion,
        domain: "kyb",
        objective: "Run the financial-crime skill library's 29-step synthetic KYB workflow on the platform: connectors acquire data into canonical records, library skills reason over them, and an independent human approves the disposition. Synthetic reference only; not production-qualified.",
        owners: ["financial-crime-platform", "financial-crime-skills"],
        riskClass: "high",
      },
      workflow: "workflow.yaml",
      coordinationMode: "caseStore",
      budgets: { maxDurationMs: 900000, maxCostUsd: 1, maxModelCalls: 0, maxCapabilityCalls: stepCount + 5 + 3 * 50 + 3 },
      modelProfiles: [],
      agentProfiles: [],
      capabilities,
      bindings: connectorBindings,
      skillBindings,
      policies: [],
      contextSelectors,
      contextClassificationPolicies: [{ classification: "PII", action: "allow" }, { classification: "CONFIDENTIAL", action: "allow" }],
      allowedRegions: ["US"],
      dataClasses: ["PII", "CONFIDENTIAL", "PUBLIC_SOURCE"],
      evaluationRequirements: ["skill-host-conformance", "kyb-synthetic-workflow", "canonical-record-normalizers"],
    }),
    workflowDocument: ({ nodes, edges }) => ({
      apiVersion: "ladder.dev/v1alpha1",
      kind: "Workflow",
      metadata: { name: "kyb-synthetic", title: "Synthetic KYB (skill library)", description: "The library's synthetic-kyb workflow, with connector acquisition stages and durable approval.", version: library.source.catalogVersion },
      spec: {
        objective: "Produce the library's KYB outcome from canonical records, never claiming more than the records establish.",
        inputs: { type: "object", required: ["tenantId", "caseId"], properties: { tenantId: { type: "string" }, caseId: { type: "string" } } },
        outputs: { type: "object" },
        policies: { maxConcurrency: 5, onFailure: "stop" },
        nodes,
        edges,
      },
    }),
  },
});

const header = (title) => `# GENERATED by scripts/sync-kyb-package.mjs from domains/kyb/library (the financial-crime skill\n# library's synthetic KYB workflow and manifests) -- do not edit; regenerate.\n# ${title}\n`;
emit(resolve(domainRoot, "package.yaml"), header("KYB domain package (v2).") + toYaml(packageDocument));
emit(resolve(domainRoot, "workflow.yaml"), header("KYB workflow.") + toYaml(workflowDocument));
if (check && state.changed) process.exit(1);
process.stdout.write(check ? "domains/archive/kyb-deterministic is up to date\n" : `domains/archive/kyb-deterministic generated (${workflow.steps.length} library steps, ${connectors.length} connectors)\n`);
