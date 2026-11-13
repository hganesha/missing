import { readFileSync } from "node:fs";
import { businessCommandTypeSchema, isSkillForbiddenCommand, SKILL_GRANT_KINDS, skillGrantsFor, planSourceAuthorizationSchema } from "@ehf/contracts";
import { checkNodeWithinProfile, LOOP_MAX_STEPS_MAX, LOOP_MAX_STEPS_MIN, LOOP_OBSERVATION_CHARS_MAX, LOOP_OBSERVATION_CHARS_MIN, parseAgentProfiles, refuseRetiredKeys, resolveNodeProfile, type AgentProfile } from "./agent-profiles.js";
import { CompilerError, refuse } from "./errors.js";
import { asU64, compareKeys, digest, F64, get, has, isArray, isObject, object, parseJson, sha256Hex, sortedKeys, stringifyPretty, u64Value, type Json, type JsonObject } from "./json.js";
import { analysisReport, analyze, configJson, diagnosticsJson, LGIR_CORE_REVISION, type AnalysisResult } from "./lgir.js";
import { loadPackage, type Capability, type DomainPackage } from "./package.js";
import { parseSkillBindings, skillBindingJson, type SkillBinding } from "./skill-bindings.js";
import { directorySource, memorySource, packageRelativeFile, readText, sortedFiles, type PackageSource } from "./source.js";
import { parseYaml, toJson } from "./yaml.js";

/** The command name and plan `compiler.name`. */
export const COMPILER_NAME = "harnessc";
/** The compiler release. Every plan digests it, so changing it changes every plan. */
export const COMPILER_VERSION = "1.0.0";
export { LGIR_CORE_REVISION };

export interface CompilerIdentity {
  name: string;
  version: string;
  lgirCoreRevision: string;
}

export const COMPILER_IDENTITY: CompilerIdentity = Object.freeze({
  name: COMPILER_NAME,
  version: COMPILER_VERSION,
  lgirCoreRevision: LGIR_CORE_REVISION,
});

/** A model profile registry document (`config/model-profiles.json`). */
export type ModelProfileRegistry = { profiles: unknown[] } & Record<string, unknown>;

export interface CompileOptions {
  /**
   * The model profile registry the plan's `modelProfiles` are digested from: a path to a
   * registry file, or the registry document itself. Defaults to `config/model-profiles.json`
   * relative to the working directory.
   */
  modelProfiles?: string | ModelProfileRegistry;
}

/** Where a package comes from: a directory, in-memory files, or a prepared source. */
export type PackageInput = string | Readonly<Record<string, string | Uint8Array>> | PackageSource;

export interface CompiledPlan {
  /** The plan document exactly as `compile` writes it (pretty JSON with a trailing newline). */
  document: string;
  /** The plan, parsed from `document`. */
  plan: Record<string, unknown>;
  planDigest: string;
  planId: string;
}

export interface ValidationResult {
  ok: boolean;
  /** LGIR diagnostics for the workflow. */
  analysis: AnalysisResult;
  /** The analysis report `validate` prints (pretty JSON). */
  report: string;
}

function toSource(input: PackageInput): PackageSource {
  if (typeof input === "string") return directorySource(input);
  if ("files" in input && input.files instanceof Map) return input as PackageSource;
  return memorySource(input as Readonly<Record<string, string | Uint8Array>>);
}

function requireNonEmptyStrings(values: string[], code: string): void {
  if (values.length === 0 || values.some((value) => value.trim() === "")) refuse(code);
}

const NODE_KINDS = new Set(["input", "output", "agent", "tool", "transform", "condition", "evaluate", "join", "aggregator", "approval", "group", "subgraph", "gate", "fanout"]);

export function nodeKindSupported(kind: string): boolean {
  return NODE_KINDS.has(kind);
}

function capabilityMap(pkg: DomainPackage): Map<string, Capability> {
  // Later declarations of an id replace earlier ones, as the original map did.
  return new Map(pkg.capabilities.map((capability) => [capability.id, capability]));
}

// ---- The workflow source ------------------------------------------------------------------

function lazy<T>(compute: () => T): () => T {
  let value: { result: T } | undefined;
  return () => (value ??= { result: compute() }).result;
}

function workflowDocument(source: string): Json {
  const document = parseYaml(source, "workflow source");
  return toJson(document, document.root);
}

/** Nodes of the authored workflow keyed by id (a later duplicate id wins). */
function sourceNodes(document: Json): Map<string, JsonObject> {
  const result = new Map<string, JsonObject>();
  const nodes = get(get(document, "spec"), "nodes");
  if (!isArray(nodes)) return result;
  for (const node of nodes) {
    const id = get(node, "id");
    if (typeof id === "string") result.set(id, node as JsonObject);
  }
  return result;
}

function sourceEdgeOutcomes(document: Json): Map<string, Json> {
  const result = new Map<string, Json>();
  const edges = get(get(document, "spec"), "edges");
  if (!isArray(edges)) return result;
  for (const edge of edges) {
    const id = get(edge, "id");
    const outcome = get(edge, "outcome");
    if (typeof id === "string" && outcome !== undefined) result.set(id, outcome);
  }
  return result;
}

function clone(value: Json): Json {
  if (Array.isArray(value)) return value.map(clone);
  if (isObject(value)) {
    const result = object();
    for (const key of Object.keys(value)) result[key] = clone(value[key]!);
    return result;
  }
  return value;
}

/**
 * Gate and fanout are governed Harness extensions to the pinned LGIR revision. For
 * structural graph analysis they behave as bounded transforms; their original kinds and
 * complete configs are restored into the emitted plan after LGIR validation.
 */
function workflowForLgir(document: Json): Json {
  const copy = clone(document);
  const nodes = get(get(copy, "spec"), "nodes");
  if (!isArray(nodes)) throw new CompilerError("workflow.spec.nodes missing");
  for (const node of nodes) {
    const kind = get(node, "kind");
    if (kind !== "gate" && kind !== "fanout") continue;
    if (!isObject(node)) throw new CompilerError("workflow node must be an object");
    node.kind = "transform";
    if (!has(node, "config")) node.config = object();
    const config = node.config;
    if (!isObject(config)) throw new CompilerError("workflow node config must be an object");
    config.operation = "select";
  }
  return copy;
}

/**
 * Node configuration carried by the authoring source but not modelled by LGIR.
 *
 * LGIR's node config is a closed set of keys, but the harness layers authority-bearing
 * declarations on top of the same `config` block -- `caseWrites` (which canonical
 * BusinessCommands a node may submit), `agentRef`, `agentVersion`, `skillId`, `runtimeTarget`.
 * They are merged back after normalization; a key LGIR models keeps its normalized value.
 */
export function mergeExtensionConfig(normalized: JsonObject, source: Json | undefined): void {
  if (!isObject(source)) return;
  for (const key of Object.keys(source)) {
    if (has(normalized, key)) continue;
    normalized[key] = clone(source[key]!);
  }
}

// ---- Package validation -----------------------------------------------------------------

const DIGEST_HEX = /^[a-f0-9]{64}$/;

function validatePackageRules(pkg: DomainPackage, workflow: () => Json, source: PackageSource): void {
  requireNonEmptyStrings(pkg.metadata.owners, "package.metadata.owners_required");
  if ((pkg.metadata.riskClass ?? "").trim() === "") refuse("package.metadata.risk_class_required");
  if (pkg.coordinationMode !== "caseStore" && pkg.coordinationMode !== "dataFlow") refuse("package.coordination_mode_invalid");
  requireNonEmptyStrings(pkg.allowedRegions, "package.allowed_regions_required");
  refuseRetiredKeys(pkg);
  const capabilityById = capabilityMap(pkg);
  const skillBindings = parseSkillBindings(pkg, capabilityById);
  if (pkg.sourceAuthorization !== undefined) {
    const parsed = planSourceAuthorizationSchema.safeParse(pkg.sourceAuthorization);
    if (!parsed.success) refuse("package.source_authorization_invalid");
    for (const pin of parsed.data.bindings) {
      if (!capabilityById.has(pin.capabilityId)) refuse(`package.source_capability_unknown:${pin.capabilityId}`);
      const connectors = [capabilityById.get(pin.capabilityId)!.adapterBindingId,
        ...[...skillBindings.values()].flatMap((binding) => binding.candidates.filter((candidate) => candidate.capabilityId === pin.capabilityId).map((candidate) => candidate.connectorId))];
      if (!connectors.includes(pin.connectorId)) refuse(`package.source_connector_unbound:${pin.connectorId}`);
    }
    for (const capability of pkg.capabilities) {
      if (!parsed.data.internalCapabilityIds?.includes(capability.id) && !parsed.data.bindings.some((pin) => pin.capabilityId === capability.id && pin.connectorId === capability.adapterBindingId)) refuse(`package.source_binding_missing:${capability.id}`);
    }
    for (const binding of skillBindings.values()) for (const candidate of binding.candidates) {
      if (!parsed.data.internalCapabilityIds?.includes(candidate.capabilityId) && !parsed.data.bindings.some((pin) => pin.capabilityId === candidate.capabilityId && pin.connectorId === candidate.connectorId)) refuse(`package.source_binding_missing:${candidate.connectorId}`);
    }
  }
  parseAgentProfiles(pkg, capabilityById, skillBindings);

  const policyIds = new Set<string>();
  for (const policy of pkg.policies) {
    if (policyIds.has(policy.policyId)) refuse(`package.policy_duplicate:${policy.policyId}`);
    policyIds.add(policy.policyId);
    if (policy.policyVersion.trim() === "") refuse(`package.policy_version_required:${policy.policyId}`);
    if (!DIGEST_HEX.test(policy.digest.replace(/^sha256:/, ""))) refuse(`package.policy_digest_invalid:${policy.policyId}`);
    // The binding source is an authoring dependency and must resolve within the
    // package even when `digest` names the separately compiled policy bundle.
    packageRelativeFile(source, policy.source);
  }

  const classificationPolicies = new Map<string, string>();
  for (const policy of pkg.contextClassificationPolicies) {
    const classification = get(policy, "classification");
    if (typeof classification !== "string" || classification.trim() === "") {
      throw new CompilerError("package.context_classification_policy_classification_required");
    }
    const action = get(policy, "action");
    if (typeof action !== "string") throw new CompilerError("package.context_classification_policy_action_required");
    if (classificationPolicies.has(classification)) refuse(`package.context_classification_policy_duplicate:${classification}`);
    classificationPolicies.set(classification, action);
    const transform = get(policy, "transform");
    if (action === "allow" || action === "deny") {
      if (transform !== undefined) refuse(`package.context_classification_policy_transform_forbidden:${classification}`);
    } else if (action === "mask") {
      if (!isObject(transform)) throw new CompilerError("package.context_classification_policy_transform_required");
      const kind = get(transform, "kind");
      const replacement = get(transform, "replacement");
      const nonEmptyReplacement = typeof replacement === "string" && replacement !== "";
      const valid = (kind === "replace" && nonEmptyReplacement)
        || (kind === "partial" && asU64(get(transform, "visiblePrefix")) !== undefined
          && asU64(get(transform, "visibleSuffix")) !== undefined && nonEmptyReplacement)
        || (kind === "hash" && typeof get(transform, "prefix") === "string");
      if (!valid) refuse(`package.context_classification_policy_transform_invalid:${classification}`);
    } else {
      refuse(`package.context_classification_policy_action_invalid:${classification}`);
    }
  }

  const selectorIds = new Set<string>();
  const selectorPurposes = new Map<string, string>();
  for (const selector of pkg.contextSelectors) {
    const id = get(selector, "id");
    if (typeof id !== "string") throw new CompilerError("package.context_selector_id_required");
    if (selectorIds.has(id)) refuse(`package.context_selector_duplicate:${id}`);
    selectorIds.add(id);
    for (const field of ["source", "path", "purpose", "classification"]) {
      const value = get(selector, field);
      if (typeof value !== "string" || value.trim() === "") refuse(`package.context_selector_field_required:${id}:${field}`);
    }
    if (typeof get(selector, "required") !== "boolean") refuse(`package.context_selector_required_flag_missing:${id}`);
    const classification = (get(selector, "classification") as string).trim();
    const action = classificationPolicies.get(classification);
    if (action === undefined) refuse(`package.context_selector_classification_policy_missing:${id}:${classification}`);
    if (action === "deny") refuse(`package.context_selector_classification_denied:${id}:${classification}`);
    selectorPurposes.set(id, (get(selector, "purpose") as string).trim());
  }

  // The workflow is parsed only once the package rules hold, so a package refusal wins.
  const nodes = sourceNodes(workflow());
  for (const id of [...nodes.keys()].sort(compareKeys)) {
    const node = nodes.get(id)!;
    const kind = get(node, "kind");
    if (typeof kind !== "string") throw new CompilerError("workflow.node_kind_required");
    if (!nodeKindSupported(kind)) refuse(`workflow.node_kind_unsupported:${id}:${kind}`);
    const config = isObject(get(node, "config")) ? (get(node, "config") as JsonObject) : undefined;
    const selectorsValue = has(node, "contextSelectorIds") ? node.contextSelectorIds : get(get(node, "config"), "contextSelectorIds");
    const referenced = isArray(selectorsValue) ? selectorsValue : [];
    const nodePurposes = new Set<string>();
    for (const selector of referenced) {
      if (typeof selector !== "string") throw new CompilerError("workflow.context_selector_invalid");
      if (!selectorIds.has(selector)) refuse(`workflow.context_selector_unresolved:${id}:${selector}`);
      const purpose = selectorPurposes.get(selector);
      if (purpose !== undefined) nodePurposes.add(purpose);
    }
    if (nodePurposes.size > 1) refuse(`workflow.context_selector_purpose_ambiguous:${id}`);
    if (kind === "gate") {
      if (!config) throw new CompilerError("workflow.gate_config_required");
      const policyRef = get(config, "policyRef");
      if (typeof policyRef !== "string" || policyRef === "") throw new CompilerError("workflow.gate_policy_ref_required");
      if (!policyIds.has(policyRef)) refuse(`workflow.gate_policy_unresolved:${id}:${policyRef}`);
      const gateId = get(config, "gateId");
      if (typeof gateId !== "string" || gateId === "") throw new CompilerError("workflow.gate_id_required");
    }
    if (kind === "fanout") {
      if (!config) throw new CompilerError("workflow.fanout_config_required");
      for (const field of ["itemsPath", "bodyRef"]) {
        const value = get(config, field);
        if (typeof value !== "string" || value === "") throw new CompilerError(`workflow.fanout_${field}_required`);
      }
      for (const field of ["maxItems", "maxConcurrency"]) {
        const bound = asU64(get(config, field)) ?? 0n;
        if (bound === 0n) throw new CompilerError(`workflow.fanout_${field}_invalid`);
      }
      const joinMode = get(config, "joinMode");
      if (joinMode !== "all" && joinMode !== "allSettled" && joinMode !== "first") throw new CompilerError("workflow.fanout_join_mode_invalid");
    }
    if (kind === "agent" || kind === "evaluate") {
      const writes = get(config, "caseWrites");
      for (const write of isArray(writes) ? writes : []) {
        if (isObject(write) && has(write, "skillGrant")) continue;
        const commandType = get(write, "commandType");
        if (commandType === "TransitionCaseStatus" || commandType === "RecordGateResult" || commandType === "FinalizeDisposition") {
          refuse(`workflow.agent_protected_write:${id}`);
        }
      }
    }
  }
  checkSkillGrants(nodes, skillBindings);
  const sourceEdges = get(get(workflow(), "spec"), "edges");
  const parents = new Map<string, string[]>();
  for (const edge of isArray(sourceEdges) ? sourceEdges : []) {
    const from = get(edge, "from");
    const to = get(edge, "to");
    if (typeof from === "string" && typeof to === "string") parents.set(to, [...(parents.get(to) ?? []), from]);
  }
  checkTaskCompletion(nodes, (id) => {
    const seen = new Set<string>();
    const stack = [...(parents.get(id) ?? [])];
    while (stack.length) {
      const next = stack.pop()!;
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(parents.get(next) ?? []));
    }
    return seen;
  });
}

/**
 * Skill grants (`config.caseWrites` entries with `skillGrant`) authorize committing a hosted
 * skill's output (skill.execution.v1 §6.2–6.3). A node's grants may not exceed what its skill
 * binding's pinned `effects` (from the registry manifest) allow:
 *
 * - `proposal`: one of the §6.2 record commands, for a skill above read-only;
 * - `effect`: one of the manifest's case commands, for a write-mode skill without approval;
 * - `held`: one of the manifest's case commands, for a skill whose effects need approval;
 * - `release`: on the node named by `config.skillEffectRelease` (after the approval), one of
 *   the released skill's held commands.
 *
 * Decision, disposition, review and approval commands are refused everywhere on a skill node,
 * as grants and as declarative writes, and a held command may not also be directly writable on
 * the same node (the case API classifies held effects by the envelope's claims alone).
 */
function checkSkillGrants(nodes: Map<string, JsonObject>, skills: Map<string, SkillBinding>): void {
  const bindingOf = (node: JsonObject | undefined): SkillBinding | undefined => {
    const skillId = get(get(node, "config"), "skillId");
    return typeof skillId === "string" ? skills.get(skillId) : undefined;
  };
  for (const id of [...nodes.keys()].sort(compareKeys)) {
    const node = nodes.get(id)!;
    const config = get(node, "config");
    const writes = isArray(get(config, "caseWrites")) ? (get(config, "caseWrites") as Json[]) : [];
    const binding = bindingOf(node);
    const releaseValue = get(config, "skillEffectRelease");
    let released: SkillBinding | undefined;
    if (releaseValue !== undefined) {
      if (get(node, "kind") !== "transform") refuse(`workflow.skill_release_node_kind_invalid:${id}`);
      const skillNodeId = get(releaseValue, "skillNodeId");
      const approvalNodeId = get(releaseValue, "approvalNodeId");
      if (typeof skillNodeId !== "string" || typeof approvalNodeId !== "string") refuse(`workflow.skill_release_invalid:${id}`);
      released = bindingOf(nodes.get(skillNodeId));
      if (!released) refuse(`workflow.skill_release_skill_node_invalid:${id}:${skillNodeId}`);
      if (get(nodes.get(approvalNodeId), "kind") !== "approval") refuse(`workflow.skill_release_approval_node_invalid:${id}:${approvalNodeId}`);
      // Only an approval-required skill has effects to release; anything else is a misconfiguration.
      if (released.effects?.approval !== "required") refuse(`workflow.skill_release_without_approval:${id}`);
    }
    const allowed = skillGrantsFor(binding?.effects);
    const releasable = skillGrantsFor(released?.effects).held;
    const direct = new Set<string>();
    const held = new Set<string>();
    for (const write of writes) {
      const commandType = get(write, "commandType");
      if (!isObject(write) || !has(write, "skillGrant")) {
        if (binding && typeof commandType === "string" && isSkillForbiddenCommand(commandType)) refuse(`workflow.skill_node_protected_write:${id}:${commandType}`);
        if (typeof commandType === "string") direct.add(commandType);
        continue;
      }
      const grant = get(write, "skillGrant");
      if (typeof grant !== "string" || !(SKILL_GRANT_KINDS as readonly string[]).includes(grant)) refuse(`workflow.skill_grant_invalid:${id}`);
      if (typeof commandType !== "string" || !businessCommandTypeSchema.safeParse(commandType).success) refuse(`workflow.skill_grant_invalid:${id}`);
      if (isSkillForbiddenCommand(commandType)) refuse(`workflow.skill_grant_forbidden:${id}:${commandType}`);
      if (grant === "release") {
        if (!released) refuse(`workflow.skill_grant_requires_release_node:${id}`);
        if (!releasable.includes(commandType as never)) refuse(`workflow.skill_grant_exceeds_manifest:${id}:${commandType}`);
        held.add(commandType);
        continue;
      }
      if (!binding) refuse(`workflow.skill_grant_requires_skill:${id}`);
      const permitted = grant === "proposal" ? allowed.proposal : grant === "effect" ? allowed.effect : allowed.held;
      if (!permitted.includes(commandType as never)) refuse(`workflow.skill_grant_exceeds_manifest:${id}:${commandType}`);
      (grant === "held" ? held : direct).add(commandType);
    }
    for (const commandType of held) {
      if (direct.has(commandType)) refuse(`workflow.skill_grant_held_overlap:${id}:${commandType}`);
    }
    // A proposal-mode skill whose node grants no proposal command can only fail at commit time
    // (`records_not_granted`): refuse it here instead (delivery plan W11).
    if (binding?.effects?.mode === "proposal" && allowed.proposal.length > 0
      && !writes.some((write) => isObject(write) && get(write, "skillGrant") === "proposal")) {
      refuse(`workflow.skill_proposal_grants_missing:${id}`);
    }
  }
}

// ---- Node compilation --------------------------------------------------------------------

/**
 * Tool capabilities an agent node may call from its bounded loop (`config.loop.tools`).
 *
 * They join the node's bound capability in its permission envelope, so the gateway can
 * authorize each step against the admitted plan. A tool must be a declared, non-model
 * capability. The node's agent profile bounds the tools, so the loop cannot widen what the
 * agent is allowed.
 */
function loopTools(nodeId: string, config: JsonObject, capabilityById: Map<string, Capability>): string[] {
  if (!has(config, "loop")) return [];
  const agentLoop = config.loop!;
  const maxSteps = asU64(get(agentLoop, "maxSteps")) ?? 0n;
  if (maxSteps < LOOP_MAX_STEPS_MIN || maxSteps > LOOP_MAX_STEPS_MAX) refuse(`workflow.loop_max_steps_invalid:${nodeId}`);
  const charsValue = get(agentLoop, "maxObservationChars");
  if (charsValue !== undefined) {
    const chars = asU64(charsValue) ?? 0n;
    if (chars < LOOP_OBSERVATION_CHARS_MIN || chars > LOOP_OBSERVATION_CHARS_MAX) refuse(`workflow.loop_max_observation_chars_invalid:${nodeId}`);
  }
  // A loop calls connectors (`tools`), business skills (`skills`), or both; it must call something.
  const toolsValue = get(agentLoop, "tools");
  const skillsValue = get(agentLoop, "skills");
  const tools = toolsValue === undefined && isArray(skillsValue) && skillsValue.length > 0 ? [] : toolsValue;
  if (!isArray(tools)) refuse(`workflow.loop_tools_required:${nodeId}`);
  if (tools.length > 32 || (tools.length === 0 && !(isArray(skillsValue) && skillsValue.length > 0))) refuse(`workflow.loop_tools_invalid:${nodeId}`);
  const ids: string[] = [];
  for (const tool of tools) {
    if (typeof tool !== "string") refuse(`workflow.loop_tool_invalid:${nodeId}`);
    const capability = capabilityById.get(tool);
    if (!capability) refuse(`workflow.loop_tool_missing:${nodeId}:${tool}`);
    if (capability.kind === "model") refuse(`workflow.loop_tool_model_forbidden:${nodeId}:${tool}`);
    if (!ids.includes(tool)) ids.push(tool);
  }
  return ids;
}

/**
 * Business skills an agent loop may choose to run (`config.loop.skills`). Each must be bound in
 * the package, read-only (a loop's skill result is an observation; it commits nothing), read only
 * selectors the node itself reads, and, on a node with an agent profile, be one of the profile's
 * allowed skills at the bound version (checked in checkNodeWithinProfile). The skill's candidates
 * join the node's permission envelope, so the gateway can check each call against this node's
 * pinned binding for that skill.
 */
function loopSkills(nodeId: string, config: JsonObject, skills: Map<string, SkillBinding>, nodeSelectors: Json): SkillBinding[] {
  const agentLoop = get(config, "loop");
  if (agentLoop === undefined) return [];
  const value = get(agentLoop, "skills");
  if (value === undefined) return [];
  if (!isArray(value) || value.length > 16) refuse(`workflow.loop_skills_invalid:${nodeId}`);
  const selectors = new Set(isArray(nodeSelectors) ? nodeSelectors.filter((id): id is string => typeof id === "string") : []);
  const out: SkillBinding[] = [];
  for (const entry of value) {
    const skillId = get(entry, "skillId");
    if (!isObject(entry) || typeof skillId !== "string") refuse(`workflow.loop_skills_invalid:${nodeId}`);
    for (const key of sortedKeys(entry)) {
      if (!["skillId", "contextSelectorIds", "parameters", "skillPolicy", "skillPolicies", "purpose"].includes(key)) refuse(`workflow.loop_skill_field_unknown:${nodeId}:${skillId}:${key}`);
    }
    const binding = skills.get(skillId);
    if (!binding) refuse(`workflow.loop_skill_undeclared:${nodeId}:${skillId}`);
    if (out.some((item) => item.skillId === skillId)) refuse(`workflow.loop_skill_duplicate:${nodeId}:${skillId}`);
    if ((binding.effects?.mode ?? "read_only") !== "read_only") refuse(`workflow.loop_skill_not_read_only:${nodeId}:${skillId}`);
    const own = get(entry, "contextSelectorIds");
    for (const id of isArray(own) ? own : []) {
      if (typeof id !== "string" || !selectors.has(id)) refuse(`workflow.loop_skill_selector_not_on_node:${nodeId}:${skillId}`);
    }
    out.push(binding);
  }
  return out;
}

/**
 * Task completion on an agent node (`config.completion`): every criterion names a predecessor
 * skill node that runs as the same agent profile, so a task can only be judged complete over its
 * own agent's work. The runtime evaluates it; the model never can.
 */
function checkTaskCompletion(nodes: Map<string, JsonObject>, ancestors: (id: string) => Set<string>): void {
  for (const id of [...nodes.keys()].sort(compareKeys)) {
    const node = nodes.get(id)!;
    const completion = get(get(node, "config"), "completion");
    if (completion === undefined) continue;
    if (get(node, "kind") !== "agent") refuse(`workflow.completion_node_kind_invalid:${id}`);
    if (get(get(node, "config"), "loop") === undefined) refuse(`workflow.completion_requires_loop:${id}`);
    const agentRef = get(get(node, "config"), "agentRef");
    if (typeof agentRef !== "string") refuse(`workflow.completion_requires_agent_ref:${id}`);
    const criteria = get(completion, "criteria");
    if (!isArray(criteria) || criteria.length === 0) refuse(`workflow.completion_invalid:${id}`);
    const upstream = ancestors(id);
    for (const criterion of criteria) {
      const target = get(criterion, "nodeId");
      if (typeof target !== "string") refuse(`workflow.completion_invalid:${id}`);
      const skillNode = nodes.get(target);
      if (!skillNode || typeof get(get(skillNode, "config"), "skillId") !== "string") refuse(`workflow.completion_target_not_skill_node:${id}:${target}`);
      if (get(get(skillNode, "config"), "agentRef") !== agentRef) refuse(`workflow.completion_target_other_agent:${id}:${target}`);
      if (!upstream.has(target)) refuse(`workflow.completion_target_not_upstream:${id}:${target}`);
    }
  }
}

/**
 * The business skill a node is bound to (`config.skillId`), validated against the package.
 *
 * A skill-bound node must be a `tool`, `agent` or `evaluate` node. An explicit package
 * binding must be one of the skill's candidates, or the node's planning model (whose loop
 * may then call the candidates); a node without one is bound to the first candidate.
 */
function nodeSkill(
  nodeId: string,
  kind: string,
  config: JsonObject,
  explicit: string | undefined,
  skills: Map<string, SkillBinding>,
  capabilityById: Map<string, Capability>,
): SkillBinding | undefined {
  if (!has(config, "skillId")) return undefined;
  const skillId = config.skillId;
  if (typeof skillId !== "string") refuse(`workflow.skill_id_invalid:${nodeId}`);
  const binding = skills.get(skillId);
  if (!binding) refuse(`workflow.skill_undeclared:${nodeId}:${skillId}`);
  if (kind !== "tool" && kind !== "agent" && kind !== "evaluate") refuse(`workflow.skill_node_kind_unsupported:${nodeId}:${kind}`);
  if (explicit !== undefined) {
    const isCandidate = binding.candidates.some((candidate) => candidate.capabilityId === explicit);
    const isModel = capabilityById.get(explicit)?.kind === "model";
    if (!isCandidate && !isModel) refuse(`workflow.skill_binding_conflict:${nodeId}:${explicit}`);
  }
  return binding;
}

function capabilityJson(capability: Capability): JsonObject {
  return {
    id: capability.id,
    kind: capability.kind,
    effect: capability.effect,
    adapterBindingId: capability.adapterBindingId,
    inputSchema: capability.inputSchema,
    outputSchema: capability.outputSchema,
    timeoutMs: u64Value(capability.timeoutMs),
    maxAttempts: u64Value(capability.maxAttempts),
    idempotent: capability.idempotent,
  };
}

function registryJson(registry: string | ModelProfileRegistry | undefined): Json {
  if (registry === undefined || typeof registry === "string") {
    const path = registry ?? "config/model-profiles.json";
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      throw new CompilerError("read model profiles", `read model profiles: ${(error as Error).message}`);
    }
    try {
      return parseJson(text);
    } catch (error) {
      throw new CompilerError("model profiles invalid", `model profiles invalid: ${(error as Error).message}`);
    }
  }
  return fromPlain(registry);
}

/** A plain JavaScript value as a compiler value (a non-integral number is a float). */
function fromPlain(value: unknown): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    return Number.isSafeInteger(value) ? value : Number.isInteger(value) ? BigInt(value) : new F64(value);
  }
  if (typeof value === "bigint") return value;
  if (Array.isArray(value)) return value.map(fromPlain);
  if (typeof value === "object") {
    const result = object();
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (nested !== undefined) result[key] = fromPlain(nested);
    }
    return result;
  }
  throw new CompilerError("model profiles invalid");
}

/** The package's own files as the dependency manifest: every file, by path and SHA-256. */
function dependencyManifest(source: PackageSource): JsonObject[] {
  return sortedFiles(source).map(([path, bytes]) => ({ kind: "source", id: path, digest: sha256Hex(bytes) }));
}

interface LoadedPackage {
  pkg: DomainPackage;
  workflowSource: string;
  source: PackageSource;
}

function load(input: PackageInput): LoadedPackage {
  const source = toSource(input);
  const pkg = loadPackage(readText(source, "package.yaml", "read package.yaml"));
  // The workflow is a package dependency: digested by the manifest, so it must be inside the package.
  const workflowPath = packageRelativeFileOr(source, pkg.workflow);
  const workflowSource = readText(source, workflowPath, "read workflow");
  return { pkg, workflowSource, source };
}

function packageRelativeFileOr(source: PackageSource, path: string): string {
  try {
    return packageRelativeFile(source, path);
  } catch (error) {
    if (error instanceof CompilerError && error.code === "package.dependency_missing") {
      throw new CompilerError("read workflow", `read workflow: ${path} not found in the package`);
    }
    throw error;
  }
}

function lgirFailure(analysis: AnalysisResult): never {
  throw new CompilerError("LGIR validation failed", `LGIR validation failed:\n${stringifyPretty(diagnosticsJson(analysis.diagnostics), false)}`);
}

/**
 * Compile with an explicit compiler identity. Only the determinism proof uses another
 * identity (to show the bytes match the previous implementation's); every plan the platform
 * admits is compiled by `compilePackage` with `COMPILER_IDENTITY`.
 */
export function compileWithIdentity(input: PackageInput, options: CompileOptions, identity: CompilerIdentity): CompiledPlan {
  const { pkg, workflowSource, source } = load(input);
  const sourceDocument = lazy(() => workflowDocument(workflowSource));
  validatePackageRules(pkg, sourceDocument, source);
  const capabilityById = capabilityMap(pkg);
  const skillBindings = parseSkillBindings(pkg, capabilityById);
  const referencedSkills = new Set<string>();
  const analysis = analyze(workflowForLgir(sourceDocument()));
  if (!analysis.ok) lgirFailure(analysis);
  const workflow = analysis.normalized!;
  const nodesById = sourceNodes(sourceDocument());
  const { compiled: agentProfiles, profiles } = parseAgentProfiles(pkg, capabilityById, skillBindings);
  const selectorPurposes = new Map<string, string>();
  for (const selector of pkg.contextSelectors) {
    const id = get(selector, "id");
    const purpose = get(selector, "purpose");
    if (typeof id === "string" && typeof purpose === "string") selectorPurposes.set(id, purpose.trim());
  }
  const envelopes: JsonObject[] = [];
  const toolCapabilityIds = new Set<string>();
  const nodes = workflow.spec.nodes.map((node) => {
    const binding = pkg.bindings.get(node.id);
    const sourceNode = nodesById.get(node.id);
    const sourceConfig = get(sourceNode, "config");
    const sourceKindValue = get(sourceNode, "kind");
    const sourceKind = typeof sourceKindValue === "string" ? sourceKindValue : node.kind;
    const contextSelectorIds = clone(sourceNode && has(sourceNode, "contextSelectorIds")
      ? sourceNode.contextSelectorIds!
      : get(sourceConfig, "contextSelectorIds") ?? []);
    const hasContextSelectors = isArray(contextSelectorIds) && contextSelectorIds.length > 0;
    const config = configJson(node.config);
    mergeExtensionConfig(config, sourceConfig);
    const profile: AgentProfile | undefined = resolveNodeProfile(node.id, config, profiles);
    const tools = loopTools(node.id, config, capabilityById);
    const loopSkillBindings = loopSkills(node.id, config, skillBindings, contextSelectorIds);
    if ((tools.length > 0 || loopSkillBindings.length > 0) && binding === undefined) refuse(`workflow.loop_requires_bound_model:${node.id}`);
    const skill = nodeSkill(node.id, sourceKind, config, binding, skillBindings, capabilityById);
    // A skill-bound node without an explicit binding is bound to its first pinned
    // candidate; every candidate joins its permission envelope so the runtime can
    // select (and, where the policy allows, fall back) without a new plan.
    const bound = binding ?? skill?.candidates[0]!.capabilityId;
    const reachable = [...tools];
    if (skill) {
      referencedSkills.add(skill.skillId);
      for (const candidate of skill.candidates) if (!reachable.includes(candidate.capabilityId)) reachable.push(candidate.capabilityId);
      // The skill's declared dependencies: the gateway narrows a delegated envelope to these.
      for (const dependency of skill.dependencyCapabilities) if (!reachable.includes(dependency)) reachable.push(dependency);
    }
    for (const loopSkill of loopSkillBindings) {
      referencedSkills.add(loopSkill.skillId);
      for (const candidate of loopSkill.candidates) if (!reachable.includes(candidate.capabilityId)) reachable.push(candidate.capabilityId);
      for (const dependency of loopSkill.dependencyCapabilities) if (!reachable.includes(dependency)) reachable.push(dependency);
    }
    if (bound !== undefined) {
      config.capabilityId = bound;
      const capability = capabilityById.get(bound);
      if (!capability) throw new CompilerError("binding capability missing", `binding capability missing: ${bound}`);
      if ((tools.length > 0 || loopSkillBindings.length > 0) && capability.kind !== "model") refuse(`workflow.loop_requires_bound_model:${node.id}`);
      const capabilities = [capability.id];
      const effects = [capability.effect];
      for (const tool of reachable) {
        if (!capabilities.includes(tool)) capabilities.push(tool);
        const effect = capabilityById.get(tool)!.effect;
        if (!effects.includes(effect)) effects.push(effect);
        toolCapabilityIds.add(tool);
      }
      envelopes.push({ nodeId: node.id, capabilities, effects, digest: digest({ nodeId: node.id, capabilities, effects }) });
    } else if (hasContextSelectors
      || (isArray(get(config, "caseWrites")) && (config.caseWrites as Json[]).length > 0)
      || has(config, "skillEffectRelease")
      || has(config, "evidenceCapture")) {
      // A pure policy/read node still needs a signed envelope. The empty
      // capability/effect set makes it spendable only for the case-read grants
      // derived from its context selectors.
      envelopes.push({ nodeId: node.id, capabilities: [], effects: [], digest: digest({ nodeId: node.id, capabilities: [], effects: [] }) });
    }
    if (profile) {
      const capabilityIdValue = get(config, "capabilityId");
      const capabilityId = typeof capabilityIdValue === "string" ? capabilityIdValue : undefined;
      const purposes = new Set<string>();
      for (const id of isArray(contextSelectorIds) ? contextSelectorIds : []) {
        const purpose = typeof id === "string" ? selectorPurposes.get(id) : undefined;
        if (purpose !== undefined) purposes.add(purpose);
      }
      checkNodeWithinProfile(node.id, profile, capabilityId, tools, skill, [...purposes].sort(compareKeys));
      for (const loopSkill of loopSkillBindings) {
        if (profile.allowedSkills.get(loopSkill.skillId) !== loopSkill.semver) refuse(`workflow.loop_skill_not_allowed_by_agent_profile:${node.id}:${loopSkill.skillId}`);
        for (const candidate of loopSkill.candidates) {
          if (!profile.allowedCapabilities.includes(candidate.capabilityId)) refuse(`workflow.loop_skill_capability_not_allowed_by_agent_profile:${node.id}:${candidate.capabilityId}`);
        }
      }
    } else if (loopSkillBindings.length > 0) {
      refuse(`workflow.loop_skills_require_agent_profile:${node.id}`);
    }
    const compiled: JsonObject = {
      id: node.id,
      kind: sourceKind,
      name: node.name === "" ? node.id : node.name,
      summary: node.summary,
      prompt: node.prompt,
      inputSchema: node.inputSchema,
      outputSchema: node.outputSchema,
      config,
      contextSelectorIds,
    };
    return compiled;
  });
  const sourceOutcomes = sourceEdgeOutcomes(sourceDocument());
  const edges = workflow.spec.edges.map((edge) => {
    const compiled: JsonObject = {
      id: edge.id, from: edge.from, to: edge.to, kind: edge.kind,
      condition: edge.condition, sourcePath: edge.sourcePath, targetPath: edge.targetPath,
    };
    if (sourceOutcomes.has(edge.id)) compiled.outcome = clone(sourceOutcomes.get(edge.id)!);
    return compiled;
  });
  const registry = registryJson(options.modelProfiles);
  const profileList = get(registry, "profiles");
  if (!isArray(profileList)) throw new CompilerError("model profiles invalid");
  const modelProfiles = pkg.modelProfiles.map((id) => {
    const profile = profileList.find((item) => get(item, "id") === id);
    if (profile === undefined) throw new CompilerError("model profile missing", `model profile missing: ${id}`);
    return { id, digest: digest(profile) };
  });
  // A plan carries only the capabilities a node can actually reach. Everything else the
  // package declares stays out of the executable artifact: the permission envelopes are
  // the authority, and an unreachable definition in the plan is only blast radius.
  const boundCapabilityIds = new Set(pkg.bindings.values());
  const capabilities = pkg.capabilities
    .filter((capability) => boundCapabilityIds.has(capability.id) || toolCapabilityIds.has(capability.id))
    .map(capabilityJson);
  const dependencies = dependencyManifest(source);
  const packageDigest = digest(dependencies);
  // "2"/"3" were plans with `skills` and `agents` (without/with integrations); "4"/"5"
  // carry `agentProfiles` instead. Admission refuses the earlier shape.
  const compatibilityVersion = pkg.integrations !== undefined ? "5" : "4";
  const compilerDigest = digest({
    name: identity.name,
    version: identity.version,
    lgirCoreRevision: identity.lgirCoreRevision,
    compatibilityVersion,
  });
  const inputs = object();
  for (const [key, value] of workflow.spec.inputs) inputs[key] = value;
  const outputs = object();
  for (const [key, value] of workflow.spec.outputs) outputs[key] = value;
  const schemaSetDigest = digest({ input: inputs, output: outputs });
  const dependencyManifestDigest = digest(dependencies);
  const buildProvenanceDigest = digest({ compilerDigest, packageDigest, dependencyManifestDigest });
  const content: JsonObject = {
    apiVersion: "harness.factory/plan-v2",
    kind: "HarnessPlan",
    packageDigest,
    compiler: {
      name: identity.name,
      version: identity.version,
      digest: compilerDigest,
      compatibilityVersion,
      lgirCoreRevision: identity.lgirCoreRevision,
    },
    metadata: {
      name: pkg.metadata.name,
      version: pkg.metadata.version,
      domain: pkg.metadata.domain,
      objective: pkg.metadata.objective,
    },
    execution: {
      engine: { kind: "harness-runtime", adapterVersion: "harness-runtime-v2", profile: "production-v2" },
      coordinationMode: pkg.coordinationMode ?? null,
      maxTransitions: 10_000,
      maxConcurrency: workflow.spec.policies.maxConcurrency,
      durability: "durable",
    },
    budgets: pkg.budgets,
    schemas: { input: inputs, output: outputs, schemaSetDigest },
    modelProfiles,
    agentProfiles,
    capabilities,
    permissionEnvelopes: envelopes,
    policyBundles: pkg.policies.map((policy) => ({ policyId: policy.policyId, bundleDigest: policy.digest.replace(/^sha256:/, "") })),
    contextSelectors: pkg.contextSelectors,
    contextClassificationPolicies: pkg.contextClassificationPolicies,
    graph: {
      apiVersion: "ladder.dev/v1alpha1",
      name: workflow.metadata.name,
      nodes,
      edges,
      nodeOrder: [...analysis.nodeOrder],
    },
    releaseConstraints: {
      regions: [...pkg.allowedRegions],
      dataClasses: [...pkg.dataClasses],
      evaluationRequirementIds: [...pkg.evaluationRequirements],
    },
    dependencyManifest: dependencies,
    dependencyManifestDigest,
    // Canonical plan bytes cannot contain wall-clock time. This sentinel means
    // "not applicable to deterministic content"; release records carry real time.
    createdAt: "1970-01-01T00:00:00Z",
    buildProvenanceDigest,
  };
  if (pkg.integrations !== undefined) content.integrations = pkg.integrations;
  if (pkg.sourceAuthorization !== undefined) content.sourceAuthorization = pkg.sourceAuthorization;
  // Absent rather than empty: plans without skill-bound nodes keep their exact bytes.
  if (referencedSkills.size > 0) {
    content.skillBindings = [...referencedSkills].sort(compareKeys).map((skillId) => skillBindingJson(skillBindings.get(skillId)!));
  }
  const planDigest = digest(content);
  const planId = `${pkg.metadata.name}@${pkg.metadata.version}:${planDigest.slice(0, 12)}`;
  const plan: JsonObject = { ...content, planId, planDigest };
  const document = `${stringifyPretty(plan)}\n`;
  return { document, plan: JSON.parse(document) as Record<string, unknown>, planDigest, planId };
}

/**
 * Compile a domain package into an executable, content-addressed plan.
 *
 * `input` is a package directory, an in-memory map of package-relative paths to contents,
 * or a prepared `PackageSource`. Every refusal is a `CompilerError` whose message is the
 * compiler diagnostic (`package.policy_duplicate:policy.kyc`).
 */
export function compilePackage(input: PackageInput, options: CompileOptions = {}): CompiledPlan {
  return compileWithIdentity(input, options, COMPILER_IDENTITY);
}

/**
 * Validate a package without emitting a plan: the package rules and the LGIR analysis of
 * its workflow. Package refusals throw; LGIR findings are returned (`ok` is false on an error).
 */
export function validatePackage(input: PackageInput): ValidationResult {
  const { pkg, workflowSource, source } = load(input);
  const sourceDocument = lazy(() => workflowDocument(workflowSource));
  validatePackageRules(pkg, sourceDocument, source);
  const analysis = analyze(workflowForLgir(sourceDocument()));
  return { ok: analysis.ok, analysis, report: analysisReport(analysis) };
}

