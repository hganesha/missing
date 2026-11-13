/**
 * Agent profiles (v2 packages): one contract for an agent's identity, prompt, instructions,
 * allowed capabilities, allowed business skills, context purposes and loop limits.
 *
 * The compiler rules implemented here are numbered as in docs/implementation/agent-profiles.md.
 */
import { AGENT_LOOP_BOUNDS, AGENT_PROFILE_DEFAULT_LIMITS, runtimeTargetSchema } from "@ehf/contracts";
import { CompilerError, refuse } from "./errors.js";
import { asU64, compareKeys, get, has, isArray, isObject, sortedKeys, type Json, type JsonObject } from "./json.js";
import type { Capability, DomainPackage } from "./package.js";
import type { SkillBinding } from "./skill-bindings.js";

export const LOOP_MAX_STEPS_MIN = BigInt(AGENT_LOOP_BOUNDS.maxSteps.min);
export const LOOP_MAX_STEPS_MAX = BigInt(AGENT_LOOP_BOUNDS.maxSteps.max);
export const LOOP_OBSERVATION_CHARS_MIN = BigInt(AGENT_LOOP_BOUNDS.maxObservationChars.min);
export const LOOP_OBSERVATION_CHARS_MAX = BigInt(AGENT_LOOP_BOUNDS.maxObservationChars.max);

/** A validated agent profile: what the node checks read. */
export interface AgentProfile {
  version: string;
  allowedCapabilities: string[];
  allowedSkills: Map<string, string>;
  purposes: string[];
  maxSteps: bigint;
  maxObservationChars: bigint;
}

const PROFILE_KEYS = new Set([
  "id", "version", "name", "description", "role", "prompt", "instructions", "allowedSkills",
  "modelProfileId", "runtimeTarget", "caseWrites", "primaryCapabilityId", "inputSchema",
  "outputSchema", "purposes", "limits",
]);
const INSTRUCTION_KEYS = new Set(["id", "version", "name", "description", "text", "allowedCapabilityIds"]);

/** The id pattern of agent profiles and instructions: `^[a-z0-9][a-z0-9._-]*$`, at most 200 characters. */
function profileIdValid(id: string): boolean {
  return id.length >= 1 && id.length <= 200 && /^[a-z0-9][a-z0-9._-]*$/.test(id);
}

/** `<adapter>` or `<adapter>:<binding>`: `runtimeTargetSchema` in @ehf/contracts. */
export function runtimeTargetValid(target: string): boolean {
  return runtimeTargetSchema.safeParse(target).success;
}

function requiredText(value: JsonObject, key: string, code: string, owner: string): string {
  const text = get(value, key);
  if (typeof text !== "string" || text.trim() === "") refuse(`${code}:${owner}:${key}`);
  return text;
}

function stringList(value: Json | undefined, code: string): string[] {
  if (value === undefined) return [];
  if (!isArray(value)) refuse(code);
  return value.map((item) => {
    if (typeof item !== "string" || item.trim() === "") refuse(code);
    return item;
  });
}

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareKeys);
}

/**
 * The v2 package keys `agentProfiles` replaced. Present at all (even empty), they refuse
 * the package, so an old package cannot compile into a plan that silently drops them.
 */
export function refuseRetiredKeys(pkg: DomainPackage): void {
  if (pkg.skills !== undefined) {
    throw new CompilerError(
      "package.agent_profiles_required",
      "package.agent_profiles_required:skills (v2 packages declare agentProfiles; fold each skill into a profile's instructions)",
    );
  }
  if (pkg.agents !== undefined) {
    throw new CompilerError("package.agent_profiles_required", "package.agent_profiles_required:agents (v2 packages declare agentProfiles)");
  }
}

/**
 * Validate a v2 package's `agentProfiles` (rules 1, 2 and 5) and compute each profile's
 * `allowedCapabilities`. Returns the compiled plan entries in authored order and the
 * profiles keyed by id.
 */
export function parseAgentProfiles(
  pkg: DomainPackage,
  capabilityById: Map<string, Capability>,
  skillBindings: Map<string, SkillBinding>,
): { compiled: JsonObject[]; profiles: Map<string, AgentProfile> } {
  const compiled: JsonObject[] = [];
  const profiles = new Map<string, AgentProfile>();
  for (const raw of pkg.agentProfiles ?? []) {
    if (!isObject(raw)) refuse("package.agent_profile_invalid");
    const id = get(raw, "id");
    if (typeof id !== "string") refuse("package.agent_profile_id_required");
    if (!profileIdValid(id)) refuse(`package.agent_profile_id_invalid:${id}`);
    if (has(raw, "allowedCapabilities")) {
      // Computed from the instructions and the primary capability; authoring it would
      // let a profile claim authority that no instruction declares.
      refuse(`package.agent_profile_allowed_capabilities_computed:${id}`);
    }
    for (const key of sortedKeys(raw)) {
      if (!PROFILE_KEYS.has(key)) refuse(`package.agent_profile_field_unknown:${id}:${key}`);
    }
    const code = "package.agent_profile_field_required";
    const version = requiredText(raw, "version", code, id);
    for (const key of ["name", "description", "role", "prompt", "modelProfileId"]) requiredText(raw, key, code, id);
    const modelProfileId = raw.modelProfileId as string;
    if (!pkg.modelProfiles.includes(modelProfileId)) refuse(`package.agent_profile_model_profile_undeclared:${id}:${modelProfileId}`);
    // Production agents run on a hosted runtime (the hosted HTTP runtime, Databricks, or any
    // registered hosted adapter), addressed as `<adapter>` or `<adapter>:<binding>`.
    // Only the platform's own local host is excluded; which adapters exist is the
    // dispatcher's registry's concern, not the compiler's.
    const targetValue = get(raw, "runtimeTarget");
    const target = typeof targetValue === "string" ? targetValue : "";
    if (!runtimeTargetValid(target)) refuse(`package.agent_profile_runtime_target_invalid:${id}`);
    if (target.split(":")[0] === "local_http") refuse(`package.production_agent_profile_requires_hosted_runtime:${id}`);
    for (const key of ["inputSchema", "outputSchema"]) {
      if (!isObject(get(raw, key))) refuse(`${code}:${id}:${key}`);
    }
    const caseWrites = has(raw, "caseWrites") ? raw.caseWrites! : [];
    if (!isArray(caseWrites)) refuse(`package.agent_profile_case_writes_invalid:${id}`);

    // Instructions: the former playbooks, folded in and kept in authored order.
    let rawInstructions: Json[] = [];
    if (has(raw, "instructions")) {
      const value = raw.instructions!;
      if (!isArray(value)) refuse(`package.agent_profile_instructions_invalid:${id}`);
      rawInstructions = value;
    }
    const instructions: JsonObject[] = [];
    const instructionIds = new Set<string>();
    const allowed = new Set<string>();
    for (const rawInstruction of rawInstructions) {
      if (!isObject(rawInstruction)) refuse(`package.agent_profile_instructions_invalid:${id}`);
      const instructionId = get(rawInstruction, "id");
      if (typeof instructionId !== "string") refuse(`package.agent_profile_instruction_id_required:${id}`);
      if (!profileIdValid(instructionId)) refuse(`package.agent_profile_instruction_id_invalid:${id}:${instructionId}`);
      if (instructionIds.has(instructionId)) refuse(`package.agent_profile_instruction_duplicate:${id}:${instructionId}`);
      instructionIds.add(instructionId);
      for (const key of sortedKeys(rawInstruction)) {
        if (!INSTRUCTION_KEYS.has(key)) refuse(`package.agent_profile_instruction_field_unknown:${id}:${instructionId}:${key}`);
      }
      const owner = `${id}:${instructionId}`;
      for (const key of ["version", "name", "description", "text"]) {
        requiredText(rawInstruction, key, "package.agent_profile_instruction_field_required", owner);
      }
      const capabilityIds = stringList(get(rawInstruction, "allowedCapabilityIds"), `package.agent_profile_instruction_capabilities_invalid:${owner}`);
      for (const capabilityId of capabilityIds) {
        if (!capabilityById.has(capabilityId)) refuse(`package.agent_profile_capability_undeclared:${id}:${capabilityId}`);
        allowed.add(capabilityId);
      }
      instructions.push({
        id: instructionId,
        version: rawInstruction.version!,
        name: rawInstruction.name!,
        description: rawInstruction.description!,
        text: rawInstruction.text!,
        allowedCapabilityIds: capabilityIds,
      });
    }
    let primary: string | undefined;
    if (has(raw, "primaryCapabilityId")) {
      const value = raw.primaryCapabilityId!;
      if (typeof value !== "string" || value === "") refuse(`package.agent_profile_primary_capability_invalid:${id}`);
      primary = value;
    }
    if (primary !== undefined) {
      if (!capabilityById.has(primary)) refuse(`package.agent_profile_capability_undeclared:${id}:${primary}`);
      allowed.add(primary);
    }

    // Business skills the profile may run, each pinned to the package binding's semver.
    const allowedSkills = new Map<string, string>();
    if (has(raw, "allowedSkills")) {
      const invalid = `package.agent_profile_allowed_skills_invalid:${id}`;
      const value = raw.allowedSkills!;
      if (!isArray(value)) refuse(invalid);
      for (const item of value) {
        if (!isObject(item)) refuse(invalid);
        if (Object.keys(item).some((key) => key !== "skillId" && key !== "semver")) refuse(invalid);
        const skillId = get(item, "skillId");
        const semver = get(item, "semver");
        if (typeof skillId !== "string" || typeof semver !== "string") refuse(invalid);
        const binding = skillBindings.get(skillId);
        if (!binding) refuse(`package.agent_profile_skill_unbound:${id}:${skillId}`);
        if (binding.semver !== semver) refuse(`package.agent_profile_skill_semver_mismatch:${id}:${skillId}`);
        if (allowedSkills.has(skillId)) refuse(`package.agent_profile_skill_duplicate:${id}:${skillId}`);
        allowedSkills.set(skillId, semver);
      }
    }

    const purposes = sortedUnique(stringList(get(raw, "purposes"), `package.agent_profile_purposes_invalid:${id}`).map((purpose) => purpose.trim()));

    const limits = get(raw, "limits");
    if (limits !== undefined) {
      const valid = isObject(limits) && Object.keys(limits).every((key) => key === "maxSteps" || key === "maxObservationChars");
      if (!valid) refuse(`package.agent_profile_limits_invalid:${id}`);
    }
    const limit = (key: string, fallback: bigint, min: bigint, max: bigint): bigint => {
      const value = get(limits, key);
      if (value === undefined) return fallback;
      const number = asU64(value);
      if (number === undefined || number < min || number > max) refuse(`package.agent_profile_limits_invalid:${id}`);
      return number;
    };
    const maxSteps = limit("maxSteps", BigInt(AGENT_PROFILE_DEFAULT_LIMITS.maxSteps), LOOP_MAX_STEPS_MIN, LOOP_MAX_STEPS_MAX);
    const maxObservationChars = limit(
      "maxObservationChars",
      BigInt(AGENT_PROFILE_DEFAULT_LIMITS.maxObservationChars),
      LOOP_OBSERVATION_CHARS_MIN,
      LOOP_OBSERVATION_CHARS_MAX,
    );

    const allowedCapabilities = sortedUnique(allowed);
    const entry: JsonObject = {
      id,
      version,
      name: raw.name!,
      description: raw.description!,
      role: raw.role!,
      prompt: raw.prompt!,
      instructions,
      allowedCapabilities,
      allowedSkills: [...allowedSkills.keys()].sort(compareKeys).map((skillId) => ({ skillId, semver: allowedSkills.get(skillId)! })),
      modelProfileId,
      runtimeTarget: target,
      caseWrites,
      inputSchema: raw.inputSchema!,
      outputSchema: raw.outputSchema!,
      purposes,
      limits: { maxSteps: Number(maxSteps), maxObservationChars: Number(maxObservationChars) },
    };
    if (primary !== undefined) entry.primaryCapabilityId = primary;
    compiled.push(entry);
    if (profiles.has(id)) refuse(`package.agent_profile_duplicate:${id}`);
    profiles.set(id, { version, allowedCapabilities, allowedSkills, purposes, maxSteps, maxObservationChars });
  }
  return { compiled, profiles };
}

/**
 * Resolve a v2 node's agent profile (`config.agentRef`, rule 3) and apply the profile's
 * loop limits to `config.loop` (rule 7): a node may narrow them, never exceed them, and
 * inherits the profile's value for a limit it omits. `config.skillRefs` is retired.
 */
export function resolveNodeProfile(nodeId: string, config: JsonObject, profiles: Map<string, AgentProfile>): AgentProfile | undefined {
  if (has(config, "skillRefs")) {
    // Playbooks are folded into the agent profile's instructions.
    throw new CompilerError("workflow.skill_refs_retired", `workflow.skill_refs_retired:${nodeId} (instructions come from the node's agent profile)`);
  }
  if (!has(config, "agentRef")) {
    if (has(config, "agentVersion")) refuse(`workflow.agent_version_without_agent_ref:${nodeId}`);
    return undefined;
  }
  const agentRef = config.agentRef;
  if (typeof agentRef !== "string") refuse(`workflow.agent_ref_invalid:${nodeId}`);
  const profile = profiles.get(agentRef);
  if (!profile) refuse(`workflow.agent_profile_missing:${nodeId}:${agentRef}`);
  if (has(config, "agentVersion") && config.agentVersion !== profile.version) {
    refuse(`workflow.agent_profile_version_mismatch:${nodeId}:${agentRef}`);
  }
  const agentLoop = config.loop;
  if (isObject(agentLoop)) {
    const limits: [string, bigint, string][] = [
      ["maxSteps", profile.maxSteps, "workflow.loop_max_steps_exceeds_agent_profile"],
      ["maxObservationChars", profile.maxObservationChars, "workflow.loop_observation_chars_exceeds_agent_profile"],
    ];
    for (const [key, limit, code] of limits) {
      if (!has(agentLoop, key)) {
        agentLoop[key] = Number(limit);
        continue;
      }
      const number = asU64(agentLoop[key]);
      if (number !== undefined && number > limit) refuse(`${code}:${nodeId}`);
    }
  }
  return profile;
}

/**
 * Rules 4-6: the node's bound capability and loop tools, its business skill and the
 * purposes of the context it reads must all be within its agent profile.
 */
export function checkNodeWithinProfile(
  nodeId: string,
  profile: AgentProfile,
  bound: string | undefined,
  tools: string[],
  skill: SkillBinding | undefined,
  purposes: string[],
): void {
  if (bound !== undefined && !profile.allowedCapabilities.includes(bound)) {
    refuse(`workflow.capability_not_allowed_by_agent_profile:${nodeId}:${bound}`);
  }
  for (const tool of tools) {
    if (!profile.allowedCapabilities.includes(tool)) refuse(`workflow.loop_tool_not_allowed_by_agent_profile:${nodeId}:${tool}`);
  }
  if (skill && profile.allowedSkills.get(skill.skillId) !== skill.semver) {
    refuse(`workflow.skill_not_allowed_by_agent_profile:${nodeId}:${skill.skillId}`);
  }
  for (const purpose of purposes) {
    if (!profile.purposes.includes(purpose)) refuse(`workflow.context_purpose_not_allowed_by_agent_profile:${nodeId}:${purpose}`);
  }
}

