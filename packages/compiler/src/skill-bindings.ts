import {
  businessCommandTypeSchema,
  businessSkillIdSchema,
  connectorIdSchema,
  coverageGroupSchema,
  isSkillForbiddenCommand,
  semverSchema,
  sha256DigestSchema,
  skillResolutionPolicySchema,
  type PlanSkillEffects,
} from "@ehf/contracts";
import { refuse } from "./errors.js";
import { get, has, isArray, isObject, sortedKeys, type Json, type JsonObject } from "./json.js";
import type { Capability, DomainPackage } from "./package.js";

/** One pinned implementation candidate of a business skill. */
export interface SkillCandidate {
  capabilityId: string;
  connectorId: string;
  equivalentCoverageGroup: string | undefined;
}

/**
 * A business skill binding: manifest digest, ordered candidates and resolution policy.
 * Pin at compile, select at run: the runtime picks one candidate per invocation.
 */
export interface SkillBinding {
  skillId: string;
  semver: string;
  manifestDigest: string;
  candidates: SkillCandidate[];
  policy: JsonObject;
  /** For a skill served by a skill host (`skills:<skill_id>` candidates): the bundle lock's digest. */
  bundleDigest: string | undefined;
  /** The skill's declared dependency capabilities; they join the node's permission envelope. */
  dependencyCapabilities: string[];
  /**
   * The skill's write authority pinned from its registry entry (effect mode, approval, manifest
   * case commands). Node skill grants may not exceed it; absent means read-only.
   */
  effects: PlanSkillEffects | undefined;
}

const BINDING_KEYS = new Set(["skillId", "semver", "manifestDigest", "candidates", "policy", "bundleDigest", "dependencyCapabilities", "effects"]);
const EFFECT_KEYS = new Set(["mode", "approval", "caseCommands"]);
const EFFECT_MODES = new Set(["read_only", "proposal", "internal_write", "external_write"]);

/** A binding's pinned `effects`, validated: known keys and values, no forbidden or duplicate command. */
function parseSkillEffects(skillId: string, raw: Json): PlanSkillEffects {
  if (!isObject(raw)) refuse(`package.skill_binding_effects_invalid:${skillId}`);
  for (const key of sortedKeys(raw)) {
    if (!EFFECT_KEYS.has(key)) refuse(`package.skill_binding_effects_field_unknown:${skillId}:${key}`);
  }
  const mode = get(raw, "mode");
  if (typeof mode !== "string" || !EFFECT_MODES.has(mode)) refuse(`package.skill_binding_effects_mode_invalid:${skillId}`);
  const approval = get(raw, "approval");
  if (approval !== "required" && approval !== "none") refuse(`package.skill_binding_effects_approval_invalid:${skillId}`);
  const rawCommands = get(raw, "caseCommands");
  if (!isArray(rawCommands) || rawCommands.length > 32) refuse(`package.skill_binding_effects_commands_invalid:${skillId}`);
  const caseCommands: PlanSkillEffects["caseCommands"] = [];
  for (const item of rawCommands) {
    const parsed = businessCommandTypeSchema.safeParse(item);
    if (!parsed.success) refuse(`package.skill_binding_effects_commands_invalid:${skillId}`);
    // A skill never records a decision, disposition, review or approval (skill.execution.v1 §6.2).
    if (isSkillForbiddenCommand(parsed.data)) refuse(`package.skill_binding_effects_command_forbidden:${skillId}:${parsed.data}`);
    if (caseCommands.includes(parsed.data)) refuse(`package.skill_binding_effects_command_duplicate:${skillId}:${parsed.data}`);
    caseCommands.push(parsed.data);
  }
  // Case commands are effects, which only the write modes may request (§6.3).
  if (caseCommands.length && mode !== "internal_write" && mode !== "external_write") {
    refuse(`package.skill_binding_effects_commands_require_write_mode:${skillId}`);
  }
  return { mode: mode as PlanSkillEffects["mode"], approval, caseCommands };
}
const CANDIDATE_KEYS = new Set(["capabilityId", "connectorId", "equivalentCoverageGroup"]);
const BUNDLE_DIGEST = /^sha256:[a-f0-9]{64}$/;

export const businessSkillIdValid = (id: string) => businessSkillIdSchema.safeParse(id).success;
export const semverValid = (version: string) => semverSchema.safeParse(version).success;
export const connectorIdValid = (id: string) => connectorIdSchema.safeParse(id).success;
export const coverageGroupValid = (group: string) => coverageGroupSchema.safeParse(group).success;

function optionalString(value: JsonObject, key: string, code: string): string | undefined {
  if (!has(value, key)) return undefined;
  const text = value[key];
  if (typeof text !== "string") refuse(code);
  return text;
}

/** Validate the package's `skillBindings` against its declared capabilities. */
export function parseSkillBindings(pkg: DomainPackage, capabilityById: Map<string, Capability>): Map<string, SkillBinding> {
  const bindings = new Map<string, SkillBinding>();
  for (const raw of pkg.skillBindings) {
    if (!isObject(raw)) refuse("package.skill_binding_invalid");
    for (const key of sortedKeys(raw)) {
      if (!BINDING_KEYS.has(key)) refuse(`package.skill_binding_field_unknown:${key}`);
    }
    const skillId = get(raw, "skillId");
    if (typeof skillId !== "string") refuse("package.skill_binding_skill_id_required");
    if (!businessSkillIdValid(skillId)) refuse(`package.skill_binding_skill_id_invalid:${skillId}`);
    const semverValue = get(raw, "semver");
    const semver = typeof semverValue === "string" ? semverValue : "";
    if (!semverValid(semver)) refuse(`package.skill_binding_semver_invalid:${skillId}`);
    const digestValue = get(raw, "manifestDigest");
    const digestText = typeof digestValue === "string" ? digestValue : "";
    if (!sha256DigestSchema.safeParse(digestText).success) refuse(`package.skill_binding_manifest_digest_invalid:${skillId}`);
    const manifestDigest = digestText.replace(/^sha256:/, "");
    const rawCandidates = get(raw, "candidates");
    if (!isArray(rawCandidates)) refuse(`package.skill_binding_candidates_required:${skillId}`);
    if (rawCandidates.length === 0 || rawCandidates.length > 16) refuse(`package.skill_binding_candidates_invalid:${skillId}`);
    const candidates: SkillCandidate[] = [];
    for (const rawCandidate of rawCandidates) {
      let capabilityId: string;
      let connectorId: string | undefined;
      let group: string | undefined;
      if (typeof rawCandidate === "string") {
        capabilityId = rawCandidate;
      } else if (isObject(rawCandidate)) {
        for (const key of sortedKeys(rawCandidate)) {
          if (!CANDIDATE_KEYS.has(key)) refuse(`package.skill_binding_candidate_field_unknown:${skillId}:${key}`);
        }
        const id = get(rawCandidate, "capabilityId");
        if (typeof id !== "string") refuse(`package.skill_binding_candidate_invalid:${skillId}`);
        capabilityId = id;
        connectorId = optionalString(rawCandidate, "connectorId", `package.skill_binding_connector_invalid:${skillId}`);
        group = optionalString(rawCandidate, "equivalentCoverageGroup", `package.skill_binding_coverage_group_invalid:${skillId}`);
      } else {
        refuse(`package.skill_binding_candidate_invalid:${skillId}`);
      }
      const capability = capabilityById.get(capabilityId);
      if (!capability) refuse(`package.skill_binding_capability_missing:${skillId}:${capabilityId}`);
      // Pin the connector: an omitted one is the package capability's own binding.
      const connector = connectorId ?? capability.adapterBindingId;
      if (!connectorIdValid(connector)) refuse(`package.skill_binding_connector_invalid:${skillId}:${connector}`);
      if (group !== undefined && !coverageGroupValid(group)) refuse(`package.skill_binding_coverage_group_invalid:${skillId}:${group}`);
      if (candidates.some((existing) => existing.capabilityId === capabilityId && existing.connectorId === connector)) {
        refuse(`package.skill_binding_candidate_duplicate:${skillId}:${capabilityId}`);
      }
      candidates.push({ capabilityId, connectorId: connector, equivalentCoverageGroup: group });
    }
    // Equivalent coverage means interchangeable: the same kind of call with the same effect.
    candidates.forEach((candidate, index) => {
      const group = candidate.equivalentCoverageGroup;
      if (group === undefined) return;
      const capability = capabilityById.get(candidate.capabilityId)!;
      for (const other of candidates.slice(index + 1)) {
        if (other.equivalentCoverageGroup !== group) continue;
        const peer = capabilityById.get(other.capabilityId)!;
        if (peer.kind !== capability.kind || peer.effect !== capability.effect) {
          refuse(`package.skill_binding_coverage_group_incompatible:${skillId}:${group}`);
        }
      }
    });
    const policy = get(raw, "policy");
    if (!isObject(policy)) refuse(`package.skill_binding_policy_required:${skillId}`);
    if (!skillResolutionPolicySchema.safeParse(plainBooleans(policy)).success) refuse(`package.skill_binding_policy_invalid:${skillId}`);
    // A skill served by a skill host is pinned to one approved bundle; nothing else has one.
    const hosted = candidates.some((candidate) => candidate.connectorId.startsWith("skills:"));
    const bundleDigest = optionalString(raw, "bundleDigest", `package.skill_binding_bundle_digest_invalid:${skillId}`);
    if (bundleDigest !== undefined) {
      if (!BUNDLE_DIGEST.test(bundleDigest)) refuse(`package.skill_binding_bundle_digest_invalid:${skillId}`);
      if (!hosted) refuse(`package.skill_binding_bundle_digest_requires_skill_host:${skillId}`);
    } else if (hosted) {
      refuse(`package.skill_binding_bundle_digest_required:${skillId}`);
    }
    const dependencyCapabilities: string[] = [];
    if (has(raw, "dependencyCapabilities")) {
      const items = raw.dependencyCapabilities!;
      if (!isArray(items) || items.length > 64) refuse(`package.skill_binding_dependencies_invalid:${skillId}`);
      for (const item of items) {
        if (typeof item !== "string") refuse(`package.skill_binding_dependencies_invalid:${skillId}`);
        const dependency = capabilityById.get(item);
        if (!dependency) refuse(`package.skill_binding_dependency_missing:${skillId}:${item}`);
        // Sub-skills run in-process in the host; a skill never calls another skill through the gateway.
        if (dependency.adapterBindingId.startsWith("skills:")) refuse(`package.skill_binding_dependency_skill_forbidden:${skillId}:${item}`);
        if (dependencyCapabilities.includes(item)) refuse(`package.skill_binding_dependency_duplicate:${skillId}:${item}`);
        dependencyCapabilities.push(item);
      }
    }
    if (bindings.has(skillId)) refuse(`package.skill_binding_duplicate:${skillId}`);
    const effects = has(raw, "effects") ? parseSkillEffects(skillId, raw.effects!) : undefined;
    bindings.set(skillId, { skillId, semver, manifestDigest, candidates, policy, bundleDigest, dependencyCapabilities, effects });
  }
  return bindings;
}

/** A policy object for schema validation (the compiler's objects have no prototype). */
function plainBooleans(policy: JsonObject): Record<string, Json> {
  return Object.fromEntries(Object.entries(policy));
}

export function skillBindingJson(binding: SkillBinding): JsonObject {
  const value: JsonObject = {
    skillId: binding.skillId,
    semver: binding.semver,
    manifestDigest: binding.manifestDigest,
    candidates: binding.candidates.map((candidate) => ({
      capabilityId: candidate.capabilityId,
      connectorId: candidate.connectorId,
      equivalentCoverageGroup: candidate.equivalentCoverageGroup ?? null,
    })),
    policy: binding.policy,
  };
  // Emitted only when present, so bindings without a skill host keep their bytes and digest.
  if (binding.bundleDigest !== undefined) value.bundleDigest = binding.bundleDigest;
  if (binding.dependencyCapabilities.length > 0) value.dependencyCapabilities = [...binding.dependencyCapabilities];
  if (binding.effects !== undefined) {
    value.effects = { mode: binding.effects.mode, approval: binding.effects.approval, caseCommands: [...binding.effects.caseCommands] };
  }
  return value;
}
