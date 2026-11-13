/**
 * Fixtures for the compiler tests: scratch packages and the refusal cases, each with the
 * exact diagnostic the compiler must emit. Kept apart from the tests so the same cases can
 * drive any other compiler run (they were used to prove parity with the previous compiler).
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
export const modelProfilesPath = join(repositoryRoot, "config/model-profiles.json");

/** A scratch package directory holding `files` (package-relative path to content). */
export function writeFixture(name: string, files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), `harnessc-${name}-`));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), content);
  }
  return directory;
}

/** Rust `str::replacen(from, to, 1)`. */
export const replaceFirst = (text: string, from: string, to: string) => text.replace(from, () => to);
/** Rust `str::replace(from, to)`: every occurrence. */
export const replaceAll = (text: string, from: string, to: string) => text.split(from).join(to);

/** A small v2 package (vendor and purchase-order checks, one model recommendation). */
export const INVOICE_PACKAGE = `apiVersion: harness.factory/domain-package-v2
kind: DomainPackage
metadata:
  name: invoice-match
  version: 0.1.0
  domain: accounts-payable
  objective: Verify a vendor and purchase order, then recommend invoice disposition.
  owners: [finance-platform]
  riskClass: controlled
workflow: workflow.yaml
budgets:
  maxDurationMs: 120000
  maxCostUsd: 0.25
  maxModelCalls: 2
  maxCapabilityCalls: 5
modelProfiles: [model.fast.v1]
agentProfiles: []
capabilities:
  - id: vendor.lookup
    kind: tool
    effect: read
    adapterBindingId: simulator:vendor.lookup
    inputSchema: { type: object }
    outputSchema: { type: object }
    timeoutMs: 5000
    maxAttempts: 2
    idempotent: true
  - id: purchase_order.lookup
    kind: tool
    effect: read
    adapterBindingId: simulator:purchase_order.lookup
    inputSchema: { type: object }
    outputSchema: { type: object }
    timeoutMs: 5000
    maxAttempts: 2
    idempotent: true
  - id: model.invoice.recommend
    kind: model
    effect: paid
    adapterBindingId: openrouter:model.fast.v1
    inputSchema: { type: object }
    outputSchema: { type: object }
    timeoutMs: 60000
    maxAttempts: 1
    idempotent: false
bindings:
  vendor-check: vendor.lookup
  po-check: purchase_order.lookup
  recommendation: model.invoice.recommend
coordinationMode: caseStore
policies:
  - policyId: policy.invoice.test
    policyVersion: 1.0.0
    source: policy.yaml
    digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
contextSelectors: []
allowedRegions: [US]
dataClasses: [CONFIDENTIAL]
evaluationRequirements: [golden]
`;

export const INVOICE_WORKFLOW = `apiVersion: ladder.dev/v1alpha1
kind: Workflow
metadata:
  name: invoice-match
  title: Invoice Match
  description: Minimal vendor and purchase-order verification harness.
  version: 0.1.0
spec:
  objective: Recommend pay or manual review using vendor and PO evidence.
  inputs:
    type: object
    required: [vendorName, purchaseOrderId, amount]
    properties:
      vendorName: { type: string }
      purchaseOrderId: { type: string }
      amount: { type: number }
  outputs: { type: object }
  policies: { maxConcurrency: 2, onFailure: stop, requireApprovalFor: [] }
  nodes:
    - { id: intake, kind: input, name: Invoice intake }
    - { id: vendor-check, kind: tool, name: Vendor lookup }
    - { id: po-check, kind: tool, name: Purchase order lookup }
    - id: recommendation
      kind: evaluate
      inlineRole: true
      name: Invoice recommendation
      role: Accounts payable reviewer
      prompt: Recommend pay or manual_review from the verification evidence and explain any mismatch.
    - { id: result, kind: output, name: Invoice disposition }
  edges:
    - { id: e1, from: intake, to: vendor-check, kind: data }
    - { id: e2, from: vendor-check, to: po-check, kind: data }
    - { id: e3, from: po-check, to: recommendation, kind: data }
    - { id: e4, from: recommendation, to: result, kind: data }
`;

/** The invoice workflow with a native subgraph and group around the checks. */
export function invoiceWorkflowWithGroupAndSubgraph(): string {
  let workflow = replaceAll(
    INVOICE_WORKFLOW,
    "    - { id: result, kind: output, name: Invoice disposition }",
    "    - id: verification-phase\n      kind: subgraph\n      name: Verification phase\n      config:\n        subgraph:\n          ref: ladder://workflows/verification\n          inputMap: { request: /input }\n          outputMap: { result: /output }\n          checkpointer: perInvocation\n    - id: checks\n      kind: group\n      name: Ordered checks\n      config:\n        members: [vendor-check, po-check]\n        execution: sequential\n        exit: serialize\n    - { id: result, kind: output, name: Invoice disposition }",
  );
  workflow = replaceAll(workflow, "from: intake, to: vendor-check", "from: intake, to: checks");
  workflow = replaceAll(workflow, "from: po-check, to: recommendation", "from: checks, to: recommendation");
  workflow = replaceAll(workflow, "from: recommendation, to: result", "from: recommendation, to: verification-phase");
  return `${workflow}    - { id: e5, from: verification-phase, to: result, kind: data }\n`;
}

export function invoiceFixture(name: string, packageSource = INVOICE_PACKAGE, workflow = INVOICE_WORKFLOW): string {
  return writeFixture(name, { "package.yaml": packageSource, "workflow.yaml": workflow, "policy.yaml": "kind: Policy\n" });
}

/** The pre-library KYC v2 package, kept as the agent-profile and skill-binding fixture. */
export const KYC_FIXTURE = join(repositoryRoot, "packages/contracts/test-fixtures/agent-profiles");
export const KYC_FIXTURE_PLAN = join(repositoryRoot, "packages/contracts/test-fixtures/agent-profiles.plan.json");
export const SKILL_HOSTED_FIXTURE = join(repositoryRoot, "packages/contracts/test-fixtures/skill-hosted");
export const SKILL_HOSTED_FIXTURE_PLAN = join(repositoryRoot, "packages/contracts/test-fixtures/skill-hosted.plan.json");

export type Edit = (pkg: string, workflow: string) => [string, string];
const unchanged: Edit = (pkg, workflow) => [pkg, workflow];

/** A copy of the KYC fixture with `packageExtra` appended to its package and `edit` applied. */
export function kycSkillFixture(name: string, packageExtra = "", edit: Edit = unchanged): string {
  const directory = mkdtempSync(join(tmpdir(), `harnessc-skill-${name}-`));
  copyFileSync(join(KYC_FIXTURE, "policy-binding.yaml"), join(directory, "policy-binding.yaml"));
  const pkg = readFileSync(join(KYC_FIXTURE, "package.yaml"), "utf8") + packageExtra;
  const workflow = readFileSync(join(KYC_FIXTURE, "workflow.yaml"), "utf8");
  const [editedPackage, editedWorkflow] = edit(pkg, workflow);
  writeFileSync(join(directory, "package.yaml"), editedPackage);
  writeFileSync(join(directory, "workflow.yaml"), editedWorkflow);
  return directory;
}

/** A copy of the skill-hosted fixture with `edit` applied to its package (and `editWorkflow` to its workflow). */
export function skillHostedFixture(name: string, edit: (pkg: string) => string = (pkg) => pkg, editWorkflow: (workflow: string) => string = (workflow) => workflow): string {
  const directory = mkdtempSync(join(tmpdir(), `harnessc-skill-hosted-${name}-`));
  writeFileSync(join(directory, "workflow.yaml"), editWorkflow(readFileSync(join(SKILL_HOSTED_FIXTURE, "workflow.yaml"), "utf8")));
  writeFileSync(join(directory, "package.yaml"), edit(readFileSync(join(SKILL_HOSTED_FIXTURE, "package.yaml"), "utf8")));
  return directory;
}

const HOSTED_EFFECTS = "    effects: { mode: proposal, approval: none, caseCommands: [] }\n";
const HOSTED_GRANT_ANCHOR = "          - { commandType: RecordCanonicalRecords, skillGrant: proposal }\n";
/** The skill-hosted fixture with its binding's pinned effects replaced and extra node grants or writes. */
function hostedGrantFixture(name: string, effects: string | null, extraWrites = ""): string {
  return skillHostedFixture(name,
    (p) => replaceAll(p, HOSTED_EFFECTS, effects === null ? "" : `    effects: ${effects}\n`),
    (w) => replaceAll(w, HOSTED_GRANT_ANCHOR, HOSTED_GRANT_ANCHOR + extraWrites));
}
const RELEASE_NODES = "    - id: registry-approval\n      kind: approval\n      name: Approval\n    - id: registry-effects\n      kind: transform\n      name: Release\n"
  + "      config:\n        operation: select\n        path: /\n        skillEffectRelease: { skillNodeId: registry-verify, approvalNodeId: registry-approval }\n";

export const SANCTIONS_SKILL = "\nskillBindings:\n  - skillId: screening.sanctions.execute\n    semver: 0.1.0\n    manifestDigest: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n    candidates:\n      - capabilityId: screening.sanctions.v1\n        equivalentCoverageGroup: opensanctions.sanctions\n      - capabilityId: screening.sanctions.v1\n        connectorId: wiring:opensanctions:screening.sanctions\n        equivalentCoverageGroup: opensanctions.sanctions\n      - screening.enforcement.v1\n    policy:\n      require_entitlement: true\n      require_list_freshness: true\n      require_jurisdiction_coverage: true\n      allow_fallback: true\n      log_selected_implementation: true\n";

export function bindSanctionsNode(workflow: string): string {
  return replaceFirst(
    workflow,
    "      capabilities: {tools: [screening.sanctions.v1]}\n      config:\n",
    "      capabilities: {tools: [screening.sanctions.v1]}\n      config:\n        skillId: screening.sanctions.execute\n",
  );
}

export function investigationSkillNode(workflow: string): string {
  return replaceFirst(
    workflow,
    "        agentRef: agent.kyc.investigation.v1\n",
    "        agentRef: agent.kyc.investigation.v1\n        skillId: screening.sanctions.execute\n",
  );
}

export const INVESTIGATION_TOOLS = "        allowedCapabilityIds: [model.kyc.investigation.v1, business.registry.lookup.v1, business.ownership.discover.v1, business.officers.lookup.v1, reference.identifier.lookup.v1, screening.enforcement.v1, screening.adverse_media.v1, identity.document.verify.v1, document.evidence.package.v1]\n";
export const INVESTIGATION_LIMITS = "    limits: {maxSteps: 8, maxObservationChars: 12000}\n";

const allowSkill = (semver: string, skillId: string) => `${INVESTIGATION_LIMITS}    allowedSkills: [{skillId: ${skillId}, semver: ${semver}}]\n`;

/** Skill binding with an unbound node (its first candidate becomes the binding). */
export function unboundSanctionsSkill(): string {
  const skill = replaceAll(
    SANCTIONS_SKILL,
    "      - capabilityId: screening.sanctions.v1\n        equivalentCoverageGroup: opensanctions.sanctions\n      - capabilityId: screening.sanctions.v1\n        connectorId",
    "      - screening.enforcement.v1\n      - capabilityId: screening.sanctions.v1\n        connectorId",
  );
  return replaceFirst(skill, "      - screening.enforcement.v1\n    policy", "    policy");
}

export interface RefusalCase {
  name: string;
  fixture: () => string;
  /** Text the diagnostic must contain. */
  expected: string[];
}

const HOSTED_BUNDLE = "sha256:c0e0ba20bd921f24f6a1b095f5fd049bfcb5cb79a66208f0acea870ef29e852f";

/** Every refusal the compiler tests pin, with the diagnostic it must produce. */
export const refusalCases: RefusalCase[] = [
  {
    name: "v1-package",
    fixture: () => invoiceFixture("v1-refused", replaceAll(INVOICE_PACKAGE, "harness.factory/domain-package-v2", "harness.factory/domain-package-v1")),
    expected: ["package.v1_removed", "harness.factory/domain-package-v2"],
  },
  // Business skill bindings.
  { name: "skill-undeclared", fixture: () => kycSkillFixture("undeclared", "", (p, w) => [p, bindSanctionsNode(w)]), expected: ["workflow.skill_undeclared:sanctions-screen:screening.sanctions.execute"] },
  {
    name: "skill-missing-capability",
    fixture: () => kycSkillFixture("missing-capability", replaceAll(SANCTIONS_SKILL, "      - screening.enforcement.v1\n", "      - screening.unknown.v1\n"), (p, w) => [p, bindSanctionsNode(w)]),
    expected: ["package.skill_binding_capability_missing:screening.sanctions.execute:screening.unknown.v1"],
  },
  { name: "skill-bad-id", fixture: () => kycSkillFixture("bad-id", replaceAll(SANCTIONS_SKILL, "skillId: screening.sanctions.execute", "skillId: Screening.v1")), expected: ["package.skill_binding_skill_id_invalid:Screening.v1"] },
  { name: "skill-bad-digest", fixture: () => kycSkillFixture("bad-digest", replaceAll(SANCTIONS_SKILL, "b".repeat(64), "not-a-digest")), expected: ["package.skill_binding_manifest_digest_invalid:screening.sanctions.execute"] },
  { name: "skill-bad-policy", fixture: () => kycSkillFixture("bad-policy", replaceAll(SANCTIONS_SKILL, "      log_selected_implementation: true\n", "")), expected: ["package.skill_binding_policy_invalid:screening.sanctions.execute"] },
  { name: "skill-duplicate", fixture: () => kycSkillFixture("duplicate", SANCTIONS_SKILL + replaceAll(SANCTIONS_SKILL, "\nskillBindings:\n", "")), expected: ["package.skill_binding_duplicate:screening.sanctions.execute"] },
  {
    name: "skill-incompatible-group",
    fixture: () => kycSkillFixture("incompatible-group", replaceAll(SANCTIONS_SKILL, "      - screening.enforcement.v1\n", "      - capabilityId: model.kyc.investigation.v1\n        equivalentCoverageGroup: opensanctions.sanctions\n")),
    expected: ["package.skill_binding_coverage_group_incompatible:screening.sanctions.execute:opensanctions.sanctions"],
  },
  {
    name: "skill-conflict",
    fixture: () => kycSkillFixture("conflict", replaceAll(SANCTIONS_SKILL,
      "      - capabilityId: screening.sanctions.v1\n        equivalentCoverageGroup: opensanctions.sanctions\n      - capabilityId: screening.sanctions.v1\n        connectorId: wiring:opensanctions:screening.sanctions\n        equivalentCoverageGroup: opensanctions.sanctions\n", ""), (p, w) => [p, bindSanctionsNode(w)]),
    expected: ["workflow.skill_binding_conflict:sanctions-screen:screening.sanctions.v1"],
  },
  // Skill-host bundles and dependency capabilities.
  { name: "hosted-no-bundle", fixture: () => skillHostedFixture("no-bundle", (p) => replaceAll(p, `    bundleDigest: ${HOSTED_BUNDLE}\n`, "")), expected: ["package.skill_binding_bundle_digest_required:sample.registry.verify"] },
  { name: "hosted-bad-bundle", fixture: () => skillHostedFixture("bad-bundle", (p) => replaceAll(p, "bundleDigest: sha256:c0e0", "bundleDigest: sha256:Z0e0")), expected: ["package.skill_binding_bundle_digest_invalid:sample.registry.verify"] },
  {
    name: "hosted-recursive",
    fixture: () => skillHostedFixture("recursive", (p) => replaceAll(p, "dependencyCapabilities: [business.registry.lookup.v1]", "dependencyCapabilities: [skill.sample.registry.verify.v1]")),
    expected: ["package.skill_binding_dependency_skill_forbidden:sample.registry.verify:skill.sample.registry.verify.v1"],
  },
  {
    name: "hosted-undeclared",
    fixture: () => skillHostedFixture("undeclared", (p) => replaceAll(p, "dependencyCapabilities: [business.registry.lookup.v1]", "dependencyCapabilities: [business.unknown.v1]")),
    expected: ["package.skill_binding_dependency_missing:sample.registry.verify:business.unknown.v1"],
  },
  {
    name: "hosted-not-hosted",
    fixture: () => skillHostedFixture("not-hosted", (p) => replaceAll(p, "      - skill.sample.registry.verify.v1\n", "      - business.registry.lookup.v1\n")),
    expected: ["package.skill_binding_bundle_digest_requires_skill_host:sample.registry.verify"],
  },
  // Skill grants (skill.execution.v1 §6.2–6.3): never beyond the binding's pinned registry effects.
  { name: "hosted-grant-unpinned", fixture: () => hostedGrantFixture("grant-unpinned", null), expected: ["workflow.skill_grant_exceeds_manifest:registry-verify:LinkEvidence"] },
  { name: "hosted-grant-read-only", fixture: () => hostedGrantFixture("grant-read-only", "{ mode: read_only, approval: none, caseCommands: [] }"), expected: ["workflow.skill_grant_exceeds_manifest:registry-verify:LinkEvidence"] },
  {
    name: "hosted-grant-effect-undeclared",
    fixture: () => hostedGrantFixture("grant-effect-undeclared", "{ mode: internal_write, approval: none, caseCommands: [ProposeWorkItem] }", "          - { commandType: RequestHumanReview, skillGrant: effect }\n"),
    expected: ["workflow.skill_grant_exceeds_manifest:registry-verify:RequestHumanReview"],
  },
  {
    name: "hosted-grant-held-without-approval",
    fixture: () => hostedGrantFixture("grant-held", "{ mode: internal_write, approval: none, caseCommands: [RequestHumanReview] }", "          - { commandType: RequestHumanReview, skillGrant: held }\n"),
    expected: ["workflow.skill_grant_exceeds_manifest:registry-verify:RequestHumanReview"],
  },
  {
    name: "hosted-grant-effect-needs-approval",
    fixture: () => hostedGrantFixture("grant-effect-approval", "{ mode: internal_write, approval: required, caseCommands: [RequestHumanReview] }", "          - { commandType: RequestHumanReview, skillGrant: effect }\n"),
    expected: ["workflow.skill_grant_exceeds_manifest:registry-verify:RequestHumanReview"],
  },
  {
    name: "hosted-grant-forbidden",
    fixture: () => hostedGrantFixture("grant-forbidden", "{ mode: internal_write, approval: none, caseCommands: [] }", "          - { commandType: FinalizeDisposition, skillGrant: effect }\n"),
    expected: ["workflow.skill_grant_forbidden:registry-verify:FinalizeDisposition"],
  },
  {
    name: "hosted-protected-write",
    fixture: () => hostedGrantFixture("protected-write", "{ mode: proposal, approval: none, caseCommands: [] }", "          - { commandType: RecordReview, payload: {}, payloadSchema: { type: object } }\n"),
    expected: ["workflow.skill_node_protected_write:registry-verify:RecordReview"],
  },
  {
    name: "hosted-grant-held-overlap",
    fixture: () => hostedGrantFixture("held-overlap", "{ mode: internal_write, approval: required, caseCommands: [ProposeWorkItem] }", "          - { commandType: ProposeWorkItem, skillGrant: held }\n"),
    expected: ["workflow.skill_grant_held_overlap:registry-verify:ProposeWorkItem"],
  },
  {
    name: "hosted-grant-no-skill",
    fixture: () => skillHostedFixture("grant-no-skill", (p) => p, (w) => replaceAll(w, "      name: Sanctions screen\n", "      name: Sanctions screen\n      config:\n        caseWrites:\n          - { commandType: ProposeClaim, skillGrant: proposal }\n")),
    expected: ["workflow.skill_grant_requires_skill:sanctions-screen"],
  },
  { name: "hosted-effects-forbidden-command", fixture: () => hostedGrantFixture("effects-forbidden", "{ mode: internal_write, approval: none, caseCommands: [RecordReview] }"), expected: ["package.skill_binding_effects_command_forbidden:sample.registry.verify:RecordReview"] },
  { name: "hosted-effects-commands-need-write", fixture: () => hostedGrantFixture("effects-mode", "{ mode: proposal, approval: none, caseCommands: [RequestHumanReview] }"), expected: ["package.skill_binding_effects_commands_require_write_mode:sample.registry.verify"] },
  {
    name: "hosted-release-without-approval",
    fixture: () => skillHostedFixture("release-no-approval", (p) => p, (w) => replaceAll(w, "    - { id: result, kind: output, name: Result }\n", RELEASE_NODES + "    - { id: result, kind: output, name: Result }\n")),
    expected: ["workflow.skill_release_without_approval:registry-effects"],
  },
  {
    name: "hosted-release-beyond-held",
    fixture: () => skillHostedFixture("release-beyond",
      (p) => replaceAll(p, HOSTED_EFFECTS, "    effects: { mode: internal_write, approval: required, caseCommands: [RequestHumanReview] }\n"),
      (w) => replaceAll(w, "    - { id: result, kind: output, name: Result }\n", RELEASE_NODES
        + "        caseWrites:\n          - { commandType: TransitionCaseStatus, skillGrant: release }\n    - { id: result, kind: output, name: Result }\n")),
    expected: ["workflow.skill_grant_exceeds_manifest:registry-effects:TransitionCaseStatus"],
  },
  // Retired keys.
  {
    name: "retired-skills",
    fixture: () => kycSkillFixture("retired-skills", "", (p, w) => [replaceAll(p, "agentProfiles:\n", "skills: []\nagentProfiles:\n"), w]),
    expected: ["package.agent_profiles_required:skills", "agentProfiles"],
  },
  { name: "retired-agents", fixture: () => kycSkillFixture("retired-agents", "", (p, w) => [replaceAll(p, "agentProfiles:\n", "agents: []\nagentProfiles:\n"), w]), expected: ["package.agent_profiles_required:agents"] },
  {
    name: "retired-skill-refs",
    fixture: () => kycSkillFixture("retired-skill-refs", "", (p, w) => [p, replaceFirst(w, "        agentRef: agent.kyc.investigation.v1\n", "        agentRef: agent.kyc.investigation.v1\n        skillRefs: [skill.kyc.investigation.v1]\n")]),
    expected: ["workflow.skill_refs_retired:kyc-investigation"],
  },
  {
    name: "computed-capabilities",
    fixture: () => kycSkillFixture("computed-capabilities", "", (p, w) => [replaceFirst(p, INVESTIGATION_LIMITS, `${INVESTIGATION_LIMITS}    allowedCapabilities: [model.kyc.investigation.v1]\n`), w]),
    expected: ["package.agent_profile_allowed_capabilities_computed:agent.kyc.investigation.v1"],
  },
  // Rule 1: profile and instruction ids are unique.
  {
    name: "rule1-duplicate-profile",
    fixture: () => kycSkillFixture("duplicate-profile", "", (p, w) => [replaceAll(p, "  - id: agent.kyc.case-assessment.v2\n", "  - id: agent.kyc.investigation.v1\n"), w]),
    expected: ["package.agent_profile_duplicate:agent.kyc.investigation.v1"],
  },
  {
    name: "rule1-duplicate-instruction",
    fixture: () => kycSkillFixture("duplicate-instruction", "", (p, w) => [replaceAll(p, "      - id: skill.kyc.case-assessment.v2\n", "      - id: skill.kyc.case-assessment.v2\n        name: Copy\n        description: Copy\n        version: 1.0.0\n        text: Copy\n      - id: skill.kyc.case-assessment.v2\n"), w]),
    expected: ["package.agent_profile_instruction_duplicate:agent.kyc.case-assessment.v2:skill.kyc.case-assessment.v2"],
  },
  {
    name: "rule1-instruction-text",
    fixture: () => kycSkillFixture("instruction-text", "", (p, w) => [replaceAll(p, "        text: >-\n          Use only the purpose-bound", "        body: >-\n          Use only the purpose-bound"), w]),
    expected: ["package.agent_profile_instruction_field_unknown:agent.kyc.case-assessment.v2:skill.kyc.case-assessment.v2:body"],
  },
  // Rule 2: profile capabilities are declared; production agents are hosted.
  {
    name: "rule2-undeclared-instruction-capability",
    fixture: () => kycSkillFixture("undeclared-instruction-capability", "", (p, w) => [replaceAll(p, "        allowedCapabilityIds: [model.kyc.case_assessment.v2]\n", "        allowedCapabilityIds: [model.kyc.case_assessment.v2, model.unknown.v1]\n"), w]),
    expected: ["package.agent_profile_capability_undeclared:agent.kyc.case-assessment.v2:model.unknown.v1"],
  },
  {
    name: "rule2-undeclared-primary",
    fixture: () => kycSkillFixture("undeclared-primary", "", (p, w) => [replaceAll(p, "    primaryCapabilityId: model.kyc.case_assessment.v2\n", "    primaryCapabilityId: model.unknown.v1\n"), w]),
    expected: ["package.agent_profile_capability_undeclared:agent.kyc.case-assessment.v2:model.unknown.v1"],
  },
  {
    name: "rule2-local-runtime",
    fixture: () => kycSkillFixture("local-runtime", "", (p, w) => [replaceFirst(p, "    runtimeTarget: hosted_http\n", "    runtimeTarget: local_http\n"), w]),
    expected: ["package.production_agent_profile_requires_hosted_runtime:agent.kyc.investigation.v1"],
  },
  // Rule 3: agent refs resolve to a profile version.
  {
    name: "rule3-missing-profile",
    fixture: () => kycSkillFixture("missing-profile", "", (p, w) => [p, replaceAll(w, "        agentRef: agent.kyc.case-assessment.v2\n", "        agentRef: agent.kyc.missing.v1\n")]),
    expected: ["workflow.agent_profile_missing:case-assessment:agent.kyc.missing.v1"],
  },
  {
    name: "rule3-version-mismatch",
    fixture: () => kycSkillFixture("version-mismatch", "", (p, w) => [p, replaceAll(w, "        agentRef: agent.kyc.case-assessment.v2\n", "        agentRef: agent.kyc.case-assessment.v2\n        agentVersion: 2.0.0\n")]),
    expected: ["workflow.agent_profile_version_mismatch:case-assessment:agent.kyc.case-assessment.v2"],
  },
  // Rule 4: bound capability and loop tools are within the profile.
  {
    name: "rule4-tool-not-allowed",
    fixture: () => kycSkillFixture("tool-not-allowed", "", (p, w) => [replaceAll(p, INVESTIGATION_TOOLS, replaceAll(INVESTIGATION_TOOLS, ", document.evidence.package.v1]", "]")), w]),
    expected: ["workflow.loop_tool_not_allowed_by_agent_profile:kyc-investigation:document.evidence.package.v1"],
  },
  {
    // Fail closed: no instruction capabilities and no primary capability allow nothing.
    name: "rule4-capability-not-allowed",
    fixture: () => kycSkillFixture("capability-not-allowed", "", (p, w) => [
      replaceAll(replaceAll(p, "    primaryCapabilityId: model.kyc.case_assessment.v2\n", ""), "        allowedCapabilityIds: [model.kyc.case_assessment.v2]\n", ""), w]),
    expected: ["workflow.capability_not_allowed_by_agent_profile:case-assessment:model.kyc.case_assessment.v2"],
  },
  // Rule 5: business skills are allowed by the profile.
  { name: "rule5-skill-not-allowed", fixture: () => kycSkillFixture("skill-not-allowed", SANCTIONS_SKILL, (p, w) => [p, investigationSkillNode(w)]), expected: ["workflow.skill_not_allowed_by_agent_profile:kyc-investigation:screening.sanctions.execute"] },
  {
    name: "rule5-skill-semver",
    fixture: () => kycSkillFixture("skill-semver", SANCTIONS_SKILL, (p, w) => [replaceFirst(p, INVESTIGATION_LIMITS, allowSkill("0.2.0", "screening.sanctions.execute")), w]),
    expected: ["package.agent_profile_skill_semver_mismatch:agent.kyc.investigation.v1:screening.sanctions.execute"],
  },
  {
    name: "rule5-skill-unbound",
    fixture: () => kycSkillFixture("skill-unbound", "", (p, w) => [replaceFirst(p, INVESTIGATION_LIMITS, allowSkill("0.1.0", "screening.sanctions.execute")), w]),
    expected: ["package.agent_profile_skill_unbound:agent.kyc.investigation.v1:screening.sanctions.execute"],
  },
  // Rule 6: context purposes are allowed by the profile.
  {
    name: "rule6-purpose",
    fixture: () => kycSkillFixture("purpose", "", (p, w) => [replaceAll(p, "    purposes: [KYC_INVESTIGATION]\n", "    purposes: [KYC_SCREENING]\n"), w]),
    expected: ["workflow.context_purpose_not_allowed_by_agent_profile:kyc-investigation:KYC_INVESTIGATION"],
  },
  {
    name: "rule6-no-purposes",
    fixture: () => kycSkillFixture("no-purposes", "", (p, w) => [replaceAll(p, "    purposes: [KYC_DECISION_SUPPORT]\n", ""), w]),
    expected: ["workflow.context_purpose_not_allowed_by_agent_profile:case-assessment:KYC_DECISION_SUPPORT"],
  },
  // Rule 7: loop limits narrow and inherit the profile.
  {
    name: "rule7-steps-exceed",
    fixture: () => kycSkillFixture("steps-exceed", "", (p, w) => [replaceAll(p, INVESTIGATION_LIMITS, "    limits: {maxSteps: 4, maxObservationChars: 12000}\n"), w]),
    expected: ["workflow.loop_max_steps_exceeds_agent_profile:kyc-investigation"],
  },
  {
    name: "rule7-chars-exceed",
    fixture: () => kycSkillFixture("chars-exceed", "", (p, w) => [replaceAll(p, INVESTIGATION_LIMITS, "    limits: {maxSteps: 8, maxObservationChars: 4000}\n"), w]),
    expected: ["workflow.loop_observation_chars_exceeds_agent_profile:kyc-investigation"],
  },
  {
    name: "rule7-limits-invalid",
    fixture: () => kycSkillFixture("limits-invalid", "", (p, w) => [replaceAll(p, INVESTIGATION_LIMITS, "    limits: {maxSteps: 21}\n"), w]),
    expected: ["package.agent_profile_limits_invalid:agent.kyc.investigation.v1"],
  },
];

/** Variants that must compile, each checked by the tests for what it pins. */
export const acceptedCases: { name: string; fixture: () => string }[] = [
  { name: "invoice", fixture: () => invoiceFixture("invoice") },
  { name: "invoice-group-subgraph", fixture: () => invoiceFixture("invoice-group-subgraph", INVOICE_PACKAGE, invoiceWorkflowWithGroupAndSubgraph()) },
  {
    name: "invoice-integrations",
    fixture: () => invoiceFixture("invoice-integrations", `${INVOICE_PACKAGE}\nintegrations:\n  triggers: []\n  humanActions: []\n  publications: []\n`, invoiceWorkflowWithGroupAndSubgraph()),
  },
  { name: "kyc-declared-skill", fixture: () => kycSkillFixture("unreferenced", SANCTIONS_SKILL) },
  { name: "kyc-explicit-skill", fixture: () => kycSkillFixture("explicit", SANCTIONS_SKILL, (p, w) => [p, bindSanctionsNode(w)]) },
  {
    name: "kyc-unbound-skill",
    fixture: () => kycSkillFixture("unbound", unboundSanctionsSkill(), (p, w) => [replaceAll(p, "  sanctions-screen: screening.sanctions.v1\n", ""), bindSanctionsNode(w)]),
  },
  { name: "skill-hosted", fixture: () => skillHostedFixture("pinned") },
  {
    name: "kyc-version-match",
    fixture: () => kycSkillFixture("version-match", "", (p, w) => [p, replaceAll(w, "        agentRef: agent.kyc.case-assessment.v2\n", "        agentRef: agent.kyc.case-assessment.v2\n        agentVersion: 1.0.0\n")]),
  },
  {
    name: "kyc-primary-only",
    fixture: () => kycSkillFixture("primary-only", "", (p, w) => [replaceAll(p, "        allowedCapabilityIds: [model.kyc.case_assessment.v2]\n", ""), w]),
  },
  {
    name: "kyc-skill-allowed",
    fixture: () => kycSkillFixture("skill-allowed", SANCTIONS_SKILL, (p, w) => [replaceFirst(p, INVESTIGATION_LIMITS, allowSkill("0.1.0", "screening.sanctions.execute")), investigationSkillNode(w)]),
  },
  {
    name: "kyc-inherit-limits",
    fixture: () => kycSkillFixture("inherit", "", (p, w) => [
      replaceAll(p, INVESTIGATION_LIMITS, "    limits: {maxSteps: 12, maxObservationChars: 9000}\n"),
      replaceAll(replaceAll(w, "          maxObservationChars: 12000\n", ""), "          maxSteps: 8\n", ""),
    ]),
  },
  {
    name: "kyc-narrow-limits",
    fixture: () => kycSkillFixture("narrow", "", (p, w) => [replaceAll(p, INVESTIGATION_LIMITS, "    limits: {maxSteps: 12, maxObservationChars: 20000}\n"), w]),
  },
];

// ---- Package, loop, gate/fanout, LGIR and YAML edge cases ---------------------------------------

const invoice = (name: string, edit: (pkg: string, workflow: string) => [string, string]) => () => {
  const [pkg, workflow] = edit(INVOICE_PACKAGE, INVOICE_WORKFLOW);
  return invoiceFixture(name, pkg, workflow);
};
const RECOMMENDATION_PROMPT = "      prompt: Recommend pay or manual_review from the verification evidence and explain any mismatch.\n";
const recommendationConfig = (config: string) => (workflow: string) => replaceFirst(workflow, RECOMMENDATION_PROMPT, `${RECOMMENDATION_PROMPT}      config:\n${config}`);
const NODE_LINES: Record<string, string> = {
  intake: "    - { id: intake, kind: input, name: Invoice intake }\n",
  "vendor-check": "    - { id: vendor-check, kind: tool, name: Vendor lookup }\n",
  "po-check": "    - { id: po-check, kind: tool, name: Purchase order lookup }\n",
  result: "    - { id: result, kind: output, name: Invoice disposition }\n",
};
const nodeLine = (id: string, replacement: string) => (workflow: string) => replaceFirst(workflow, NODE_LINES[id]!, replacement);
const loop = (body: string) => recommendationConfig(`        loop:\n${body}`);
const selectors = (purposeB = "INVOICE_REVIEW") => "contextSelectors:\n"
  + "  - {id: vendor, source: case, path: /vendor, purpose: INVOICE_REVIEW, classification: CONFIDENTIAL, required: true}\n"
  + `  - {id: amount, source: case, path: /amount, purpose: ${purposeB}, classification: CONFIDENTIAL, required: false}\n`
  + "contextClassificationPolicies:\n  - {classification: CONFIDENTIAL, action: allow}\n";
const withSelectors = (pkg: string, purposeB?: string) => replaceAll(pkg, "contextSelectors: []\n", selectors(purposeB));
const INVOICE_DIGEST = `sha256:${"a".repeat(64)}`;

export const extendedRefusalCases: RefusalCase[] = [
  { name: "owners-required", fixture: invoice("owners", (p, w) => [replaceAll(p, "  owners: [finance-platform]\n", ""), w]), expected: ["package.metadata.owners_required"] },
  { name: "owners-blank", fixture: invoice("owners-blank", (p, w) => [replaceAll(p, "owners: [finance-platform]", "owners: ['  ']"), w]), expected: ["package.metadata.owners_required"] },
  { name: "risk-class-required", fixture: invoice("risk", (p, w) => [replaceAll(p, "  riskClass: controlled\n", ""), w]), expected: ["package.metadata.risk_class_required"] },
  { name: "coordination-mode", fixture: invoice("coordination", (p, w) => [replaceAll(p, "coordinationMode: caseStore", "coordinationMode: parallel"), w]), expected: ["package.coordination_mode_invalid"] },
  { name: "regions-required", fixture: invoice("regions", (p, w) => [replaceAll(p, "allowedRegions: [US]", "allowedRegions: []"), w]), expected: ["package.allowed_regions_required"] },
  { name: "contract-unsupported", fixture: invoice("contract", (p, w) => [replaceAll(p, "kind: DomainPackage", "kind: Package"), w]), expected: ["package.contract_unsupported"] },
  {
    name: "policy-duplicate",
    fixture: invoice("policy-duplicate", (p, w) => [replaceAll(p, "contextSelectors: []\n", `  - {policyId: policy.invoice.test, policyVersion: 2.0.0, source: policy.yaml, digest: ${"c".repeat(64)}}\ncontextSelectors: []\n`), w]),
    expected: ["package.policy_duplicate:policy.invoice.test"],
  },
  { name: "policy-version", fixture: invoice("policy-version", (p, w) => [replaceAll(p, "policyVersion: 1.0.0", "policyVersion: ' '"), w]), expected: ["package.policy_version_required:policy.invoice.test"] },
  { name: "policy-digest", fixture: invoice("policy-digest", (p, w) => [replaceAll(p, INVOICE_DIGEST, "sha256:ABC"), w]), expected: ["package.policy_digest_invalid:policy.invoice.test"] },
  { name: "policy-source-unsafe", fixture: invoice("policy-unsafe", (p, w) => [replaceAll(p, "source: policy.yaml", "source: ../policy.yaml"), w]), expected: ["package.dependency_path_unsafe:../policy.yaml"] },
  { name: "policy-source-missing", fixture: invoice("policy-missing", (p, w) => [replaceAll(p, "source: policy.yaml", "source: missing.yaml"), w]), expected: ["package.dependency_missing:missing.yaml"] },
  {
    name: "classification-transform-required",
    fixture: invoice("classification", (p, w) => [`${p}contextClassificationPolicies:\n  - {classification: PII, action: mask}\n`, w]),
    expected: ["package.context_classification_policy_transform_required"],
  },
  {
    name: "classification-transform-invalid",
    fixture: invoice("classification-invalid", (p, w) => [`${p}contextClassificationPolicies:\n  - {classification: PII, action: mask, transform: {kind: partial, visiblePrefix: 2, replacement: '*'}}\n`, w]),
    expected: ["package.context_classification_policy_transform_invalid:PII"],
  },
  {
    name: "classification-duplicate",
    fixture: invoice("classification-duplicate", (p, w) => [`${p}contextClassificationPolicies:\n  - {classification: PII, action: allow}\n  - {classification: PII, action: deny}\n`, w]),
    expected: ["package.context_classification_policy_duplicate:PII"],
  },
  {
    name: "selector-classification-denied",
    fixture: invoice("selector-denied", (p, w) => [replaceAll(withSelectors(p), "action: allow", "action: deny"), w]),
    expected: ["package.context_selector_classification_denied:vendor:CONFIDENTIAL"],
  },
  {
    name: "selector-required-flag",
    fixture: invoice("selector-flag", (p, w) => [replaceAll(withSelectors(p), ", required: true}", "}"), w]),
    expected: ["package.context_selector_required_flag_missing:vendor"],
  },
  {
    name: "selector-unresolved",
    fixture: invoice("selector-unresolved", (p, w) => [withSelectors(p), recommendationConfig("        contextSelectorIds: [vendor, nope]\n")(w)]),
    expected: ["workflow.context_selector_unresolved:recommendation:nope"],
  },
  {
    name: "selector-purpose-ambiguous",
    fixture: invoice("selector-ambiguous", (p, w) => [withSelectors(p, "INVOICE_PAYMENT"), recommendationConfig("        contextSelectorIds: [vendor, amount]\n")(w)]),
    expected: ["workflow.context_selector_purpose_ambiguous:recommendation"],
  },
  { name: "node-kind-unsupported", fixture: invoice("kind", (p, w) => [p, nodeLine("po-check", "    - { id: po-check, kind: loop, name: Purchase order lookup }\n")(w)]), expected: ["workflow.node_kind_unsupported:po-check:loop"] },
  {
    name: "gate-policy-unresolved",
    fixture: invoice("gate", (p, w) => [p, nodeLine("po-check", "    - { id: po-check, kind: gate, name: Gate, config: { policyRef: policy.other, gateId: g1 } }\n")(w)]),
    expected: ["workflow.gate_policy_unresolved:po-check:policy.other"],
  },
  { name: "gate-id-required", fixture: invoice("gate-id", (p, w) => [p, nodeLine("po-check", "    - { id: po-check, kind: gate, name: Gate, config: { policyRef: policy.invoice.test } }\n")(w)]), expected: ["workflow.gate_id_required"] },
  {
    name: "fanout-join-mode",
    fixture: invoice("fanout", (p, w) => [p, nodeLine("po-check", "    - { id: po-check, kind: fanout, name: Fanout, config: { itemsPath: /items, bodyRef: vendor-check, maxItems: 5, maxConcurrency: 2, joinMode: any } }\n")(w)]),
    expected: ["workflow.fanout_join_mode_invalid"],
  },
  {
    name: "fanout-max-items",
    fixture: invoice("fanout-items", (p, w) => [p, nodeLine("po-check", "    - { id: po-check, kind: fanout, name: Fanout, config: { itemsPath: /items, bodyRef: vendor-check, maxItems: 0, maxConcurrency: 2, joinMode: all } }\n")(w)]),
    expected: ["workflow.fanout_maxItems_invalid"],
  },
  {
    name: "protected-write",
    fixture: invoice("protected", (p, w) => [p, recommendationConfig("        caseWrites: [{commandType: FinalizeDisposition}]\n")(w)]),
    expected: ["workflow.agent_protected_write:recommendation"],
  },
  // Loop rules.
  { name: "loop-max-steps", fixture: invoice("loop-steps", (p, w) => [p, loop("          maxSteps: 0\n          tools: [vendor.lookup]\n")(w)]), expected: ["workflow.loop_max_steps_invalid:recommendation"] },
  { name: "loop-observation-chars", fixture: invoice("loop-chars", (p, w) => [p, loop("          maxSteps: 3\n          maxObservationChars: 100\n          tools: [vendor.lookup]\n")(w)]), expected: ["workflow.loop_max_observation_chars_invalid:recommendation"] },
  { name: "loop-tools-required", fixture: invoice("loop-tools", (p, w) => [p, loop("          maxSteps: 3\n")(w)]), expected: ["workflow.loop_tools_required:recommendation"] },
  { name: "loop-tools-empty", fixture: invoice("loop-tools-empty", (p, w) => [p, loop("          maxSteps: 3\n          tools: []\n")(w)]), expected: ["workflow.loop_tools_invalid:recommendation"] },
  { name: "loop-tool-missing", fixture: invoice("loop-missing", (p, w) => [p, loop("          maxSteps: 3\n          tools: [vendor.unknown]\n")(w)]), expected: ["workflow.loop_tool_missing:recommendation:vendor.unknown"] },
  { name: "loop-tool-model", fixture: invoice("loop-model", (p, w) => [p, loop("          maxSteps: 3\n          tools: [model.invoice.recommend]\n")(w)]), expected: ["workflow.loop_tool_model_forbidden:recommendation:model.invoice.recommend"] },
  {
    name: "loop-requires-binding",
    fixture: invoice("loop-unbound", (p, w) => [replaceAll(p, "  recommendation: model.invoice.recommend\n", ""), loop("          maxSteps: 3\n          tools: [vendor.lookup]\n")(w)]),
    expected: ["workflow.loop_requires_bound_model:recommendation"],
  },
  {
    name: "loop-requires-model",
    fixture: invoice("loop-tool-bound", (p, w) => [replaceAll(p, "  recommendation: model.invoice.recommend\n", "  recommendation: vendor.lookup\n"), loop("          maxSteps: 3\n          tools: [purchase_order.lookup]\n")(w)]),
    expected: ["workflow.loop_requires_bound_model:recommendation"],
  },
  { name: "agent-version-without-ref", fixture: invoice("agent-version", (p, w) => [p, recommendationConfig("        agentVersion: 1.0.0\n")(w)]), expected: ["workflow.agent_version_without_agent_ref:recommendation"] },
  {
    name: "skill-node-kind",
    fixture: () => kycSkillFixture("skill-kind", SANCTIONS_SKILL, (p, w) => [p, replaceFirst(w, "      kind: input\n", "      kind: input\n      config: {skillId: screening.sanctions.execute}\n")]),
    expected: ["workflow.skill_node_kind_unsupported:"],
  },
  { name: "model-profile-missing", fixture: invoice("model-profile", (p, w) => [replaceAll(p, "modelProfiles: [model.fast.v1]", "modelProfiles: [model.fast.v1, model.unknown.v1]"), w]), expected: ["model profile missing: model.unknown.v1"] },
  { name: "binding-capability-missing", fixture: invoice("binding-missing", (p, w) => [replaceAll(p, "  po-check: purchase_order.lookup\n", "  po-check: purchase_order.unknown\n"), w]), expected: ["binding capability missing: purchase_order.unknown"] },
  // Hosted runtime rules.
  {
    name: "runtime-target-invalid",
    fixture: () => kycSkillFixture("runtime-invalid", "", (p, w) => [replaceFirst(p, "    runtimeTarget: hosted_http\n", "    runtimeTarget: Databricks\n"), w]),
    expected: ["package.agent_profile_runtime_target_invalid:agent.kyc.investigation.v1"],
  },
  {
    name: "runtime-target-local-binding",
    fixture: () => kycSkillFixture("runtime-local", "", (p, w) => [replaceFirst(p, "    runtimeTarget: hosted_http\n", "    runtimeTarget: local_http:investigator\n"), w]),
    expected: ["package.production_agent_profile_requires_hosted_runtime:agent.kyc.investigation.v1"],
  },
  // LGIR structural and textual refusals.
  { name: "lgir-cycle", fixture: invoice("cycle", (p, w) => [p, `${w}    - { id: e5, from: po-check, to: vendor-check, kind: data }\n`]), expected: ["LGIR validation failed:", "LG150"] },
  { name: "lgir-agent-prompt", fixture: invoice("prompt", (p, w) => [p, replaceAll(w, RECOMMENDATION_PROMPT, "")]), expected: ["LGIR validation failed:", "LG112"] },
  {
    name: "lgir-anchor-text",
    fixture: invoice("anchor-text", (p, w) => [p, replaceAll(w, RECOMMENDATION_PROMPT, "      prompt: 'Recommend pay or manual_review. Note: *always* cite evidence.'\n")]),
    expected: ["LGIR validation failed:", "LG004"],
  },
  {
    name: "lgir-anchor-literal",
    fixture: invoice("anchor-literal", (p, w) => [p, replaceAll(w, RECOMMENDATION_PROMPT, "      prompt: |\n        Recommend pay or manual_review.\n        *Always* cite the evidence.\n")]),
    expected: ["LGIR validation failed:", "LG004"],
  },
  { name: "lgir-external-ref", fixture: invoice("external-ref", (p, w) => [p, replaceAll(w, "  outputs: { type: object }\n", "  outputs: { $ref: 'https://example.com/schema.json' }\n")]), expected: ["LGIR validation failed:", "LG005"] },
  { name: "lgir-type-error", fixture: invoice("type-error", (p, w) => [p, replaceAll(w, "name: Invoice intake", "name: 42")]), expected: ["LGIR validation failed:", "LG003"] },
  { name: "lgir-duplicate-node", fixture: invoice("duplicate-node", (p, w) => [p, nodeLine("po-check", "    - { id: vendor-check, kind: tool, name: Again }\n")(w)]), expected: ["LGIR validation failed:", "LG110"] },
  { name: "package-yaml-invalid", fixture: invoice("yaml-invalid", (p, w) => [`${p}  - broken: [\n`, w]), expected: ["parse package.yaml"] },
  { name: "package-field-missing", fixture: invoice("field-missing", (p, w) => [replaceAll(p, "workflow: workflow.yaml\n", ""), w]), expected: ["parse package.yaml"] },
  { name: "workflow-yaml-invalid", fixture: invoice("workflow-invalid", (p, w) => [p, `${w}  extra: [\n`]), expected: ["parse workflow source"] },
];

export const extendedAcceptedCases: { name: string; fixture: () => string }[] = [
  { name: "loop-accepted", fixture: invoice("loop-ok", (p, w) => [p, loop("          maxSteps: 3\n          tools: [vendor.lookup, purchase_order.lookup, vendor.lookup]\n")(w)]) },
  { name: "selectors-accepted", fixture: invoice("selectors-ok", (p, w) => [withSelectors(p), recommendationConfig("        contextSelectorIds: [vendor, amount]\n        caseWrites: [{commandType: AddNote}]\n")(w)]) },
  { name: "selector-envelope-only", fixture: invoice("selector-envelope", (p, w) => [withSelectors(p), nodeLine("result", "    - { id: result, kind: output, name: Invoice disposition, contextSelectorIds: [vendor] }\n")(w)]) },
  {
    name: "gate-and-fanout",
    fixture: invoice("gate-fanout", (p, w) => [replaceAll(replaceAll(p, "  vendor-check: vendor.lookup\n", ""), "  po-check: purchase_order.lookup\n", ""), nodeLine("po-check", "    - { id: po-check, kind: gate, name: Gate, config: { policyRef: policy.invoice.test, gateId: g1, evidenceCapture: {mode: digest} } }\n")(
      nodeLine("vendor-check", "    - { id: vendor-check, kind: fanout, name: Fanout, config: { itemsPath: /items, bodyRef: po-check, maxItems: 5, maxConcurrency: 2, joinMode: allSettled } }\n")(w))]),
  },
  { name: "edge-outcome", fixture: invoice("edge-outcome", (p, w) => [p, replaceAll(w, "{ id: e3, from: po-check, to: recommendation, kind: data }", "{ id: e3, from: po-check, to: recommendation, kind: data, outcome: ALLOW }")]) },
  {
    name: "floats-and-integers",
    fixture: invoice("floats", (p, w) => [
      replaceAll(p, "  maxCostUsd: 0.25\n", "  maxCostUsd: 1.0\n  ratios: [0.1, 1e21, 1e-7, 1e15, 1e16, -0.0, 2.5e-5, 0x1F, 0o17, 0b101, 007, +7, 18446744073709551615, 9007199254740993, .inf, .nan, yes, 1_0, '1.0', ~]\n"),
      recommendationConfig("        threshold: 1\n        weights: {Zebra: 1, apple: 2.50, Apple: 3, a_b: 4, aB: 5}\n")(w),
    ]),
  },
  { name: "no-policies-block", fixture: invoice("no-policies", (p, w) => [p, replaceAll(w, "  policies: { maxConcurrency: 2, onFailure: stop, requireApprovalFor: [] }\n", "")]) },
  { name: "empty-policies-block", fixture: invoice("empty-policies", (p, w) => [p, replaceAll(w, "  policies: { maxConcurrency: 2, onFailure: stop, requireApprovalFor: [] }\n", "  policies: {}\n")]) },
  {
    name: "lenient-package-scalars",
    fixture: invoice("lenient", (p, w) => [replaceAll(replaceAll(p, "  version: 0.1.0\n", "  version: 1.0\n"), "dataClasses: [CONFIDENTIAL]", "dataClasses: [CONFIDENTIAL, 7, true]"), w]),
  },
  {
    name: "anchors-and-aliases",
    fixture: invoice("aliases", (p, w) => [replaceFirst(p, "    inputSchema: { type: object }\n    outputSchema: { type: object }\n", "    inputSchema: &object { type: object }\n    outputSchema: *object\n"), w]),
  },
  {
    name: "double-quoted-prompt-with-tab",
    fixture: invoice("prompt-tab", (p, w) => [p, replaceAll(w, RECOMMENDATION_PROMPT, "      prompt: \"Recommend pay.\\n*Always*\\tcite evidence.\"\n")]),
  },
  {
    name: "ref-in-sequence-item",
    fixture: invoice("ref-sequence", (p, w) => [p, replaceAll(w, "  outputs: { type: object }\n", "  outputs: { allOf: [ { $ref: 'https://example.com/schema.json' } ] }\n")]),
  },
  {
    name: "unicode-and-escapes",
    fixture: invoice("unicode", (p, w) => [
      replaceAll(p, "  objective: Verify a vendor and purchase order, then recommend invoice disposition.\n", "  objective: \"V\u00e9rifier \u2014 \u8acb\u6c42\u66f8 \u2713 \ud83e\uddfe \\u0007 tab\\there\"\n"),
      recommendationConfig("        \"\\U0001F600key\": 1\n        \"\\uE000key\": 2\n        zkey: 3\n")(w),
    ]),
  },
  {
    name: "hosted-runtime-binding",
    fixture: () => kycSkillFixture("runtime-binding", "", (p, w) => [replaceFirst(p, "    runtimeTarget: hosted_http\n", "    runtimeTarget: databricks:kyc-investigator\n"), w]),
  },
];
