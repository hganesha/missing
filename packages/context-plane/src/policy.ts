import { stableDigest } from "@ehf/contracts";
import { assignRiskCohort, type CaseAggregate, type PolicyCatalog } from "@ehf/policy-engine";
import { z } from "zod";
import type { ContextSection } from "./index.js";

/**
 * The `policy` context section of a library skill (skill.execution.v1 §4 `sections[]` kind
 * `policy`; change request CR-4).
 *
 * A skill node that declares `config.skillPolicy` receives the case's pinned policy projected to
 * its manifest's `policy_context_fields`. The projection is compiled into the plan from the
 * policy bundle the plan binds (scripts/sync-kyc-package.mjs): `values` are copied or derived
 * from the bundle; `computed` fields depend on the case and are computed here with the policy
 * engine (today: a per-risk-cohort table, the cohort assigned by
 * `@ehf/policy-engine#assignRiskCohort`, the assignment the OPA gates use).
 *
 * Fail closed. The section is sent only when the case is pinned to exactly the plan's policy
 * bundle and every field the skill declares resolves; otherwise the skill is not called and the
 * node answers NEEDS_EVIDENCE with POLICY_UNRESOLVED (see skill-input.ts). A field the bundle
 * does not define is never defaulted.
 */

const sha256 = z.string().regex(/^(sha256:)?[a-f0-9]{64}$/);

export const skillPolicyConfigSchema = z.object({
  policyRef: z.string().min(1),
  policyVersion: z.string().min(1).optional(),
  bundleDigest: sha256,
  effectivePolicySetDigest: sha256.optional(),
  /** The manifest's policy_context_fields: every one is required. */
  fields: z.array(z.string().min(1)).max(256),
  values: z.record(z.string(), z.unknown()),
  computed: z.record(z.string(), z.object({
    kind: z.literal("cohortTable"),
    table: z.record(z.string(), z.unknown()),
  }).strict()).optional(),
  cohorts: z.object({
    precedence: z.array(z.string().min(1)),
    requiredAttributes: z.array(z.string().min(1)),
    attributePaths: z.record(z.string(), z.string().min(1)),
    selectors: z.record(z.string(), z.record(z.string(), z.unknown())),
  }).strict().optional(),
  /** Where each top-level cohort aggregate key comes from in the node's selection. */
  cohortInputs: z.record(z.string(), z.object({
    selector: z.string().min(1),
    path: z.string().min(1).optional(),
    /** Read the value of the single active fact with this predicate from a facts selection. */
    fact: z.string().min(1).optional(),
  }).strict()).optional(),
  sources: z.record(z.string(), z.string()).optional(),
  unresolved: z.array(z.string()).optional(),
}).strict();

export type SkillPolicyConfig = z.infer<typeof skillPolicyConfigSchema>;

/** The case's policy binding, as the case snapshot carries it. */
export type CasePolicyAuthority = {
  policyId: string;
  policyVersion?: string;
  policyBundleDigest: string;
  policySnapshotDigest: string;
};

export type SkillPolicyResolution =
  | { status: "ready"; section: ContextSection; cohortId: string | null }
  | { status: "unresolved"; missing: string[]; explanation: string };

const bare = (digest: string) => digest.replace(/^sha256:/, "");

function pathValue(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let current = value;
  for (const part of path.split(".").filter(Boolean)) {
    if (current === null || current === undefined) return undefined;
    current = Array.isArray(current) && /^\d+$/.test(part) ? current[Number(part)] : (current as Record<string, unknown>)[part];
  }
  return current;
}

const camel = (key: string) => key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** The value of the one active, current fact with `predicate`; ambiguity or absence is unknown. */
function activeFact(rows: unknown, predicate: string, asOf: number): unknown {
  if (!Array.isArray(rows)) return undefined;
  const active = rows
    .map((row) => Object.fromEntries(Object.entries((row ?? {}) as Record<string, unknown>).map(([key, value]) => [camel(key), value])))
    .filter((row) => row.predicate === predicate && row.status === "ACTIVE" && !row.supersededAt
      && (!row.validFrom || Date.parse(String(row.validFrom)) <= asOf)
      && (!row.validTo || Date.parse(String(row.validTo)) > asOf));
  return active.length === 1 ? active[0]!.value : undefined;
}

/** The case's risk cohort, assigned by the policy engine from the node's selection; null when undetermined. */
function cohortFor(config: SkillPolicyConfig, selection: Readonly<Record<string, unknown>>, asOf: number): string | null {
  if (!config.cohorts || !config.cohortInputs) return null;
  const aggregate: Record<string, unknown> = {};
  for (const [key, input] of Object.entries(config.cohortInputs)) {
    const selected = selection[input.selector];
    const value = input.fact ? activeFact(selected, input.fact, asOf) : pathValue(selected, input.path);
    if (value !== undefined) aggregate[key] = value;
  }
  const catalog = {
    cohortAttributePaths: config.cohorts.attributePaths,
    cohortRequiredAttributes: config.cohorts.requiredAttributes,
    cohortPrecedence: config.cohorts.precedence,
    riskCohorts: new Map(Object.entries(config.cohorts.selectors).map(([id, selector]) => [id, { id, selector }])),
  } as unknown as PolicyCatalog;
  return assignRiskCohort(aggregate as unknown as CaseAggregate, catalog);
}

export function resolveSkillPolicySection(input: {
  config: unknown;
  authority: CasePolicyAuthority | null | undefined;
  selection?: Readonly<Record<string, unknown>>;
  purpose: string;
  asOfTime?: string;
}): SkillPolicyResolution {
  const parsed = skillPolicyConfigSchema.safeParse(input.config);
  if (!parsed.success) return { status: "unresolved", missing: ["policy"], explanation: "The node's policy projection is not a valid skillPolicy configuration." };
  const config = parsed.data;
  const authority = input.authority;
  if (!authority?.policyId || !authority.policyBundleDigest || !authority.policySnapshotDigest) {
    return { status: "unresolved", missing: config.fields, explanation: "The case carries no pinned policy authority, so no policy context can be sent." };
  }
  if (authority.policyId !== config.policyRef || bare(authority.policyBundleDigest) !== bare(config.bundleDigest)) {
    return {
      status: "unresolved", missing: config.fields,
      explanation: `The case is pinned to ${authority.policyId} (bundle ${bare(authority.policyBundleDigest).slice(0, 12)}), not to the plan's ${config.policyRef} (bundle ${bare(config.bundleDigest).slice(0, 12)}).`,
    };
  }
  const asOf = Date.parse(input.asOfTime ?? "") || Date.now();
  let cohort: string | null | undefined;
  const value: Record<string, unknown> = {};
  const missing: string[] = [];
  for (const field of config.fields) {
    if (Object.hasOwn(config.values, field) && config.values[field] !== undefined && config.values[field] !== null) {
      value[field] = structuredClone(config.values[field]);
      continue;
    }
    const rule = config.computed?.[field];
    if (rule?.kind === "cohortTable") {
      if (cohort === undefined) cohort = cohortFor(config, input.selection ?? {}, asOf);
      const entry = cohort === null ? undefined : rule.table[cohort];
      if (entry !== undefined && entry !== null) {
        value[field] = structuredClone(entry);
        continue;
      }
    }
    missing.push(field);
  }
  if (missing.length) {
    const cohortNote = config.computed && missing.some((field) => config.computed?.[field])
      ? cohort === null ? " The case's risk cohort could not be determined from its attributes." : ` The bundle defines no value for cohort ${cohort}.`
      : "";
    return {
      status: "unresolved", missing,
      explanation: `Pinned policy ${config.policyRef} does not resolve ${missing.join(", ")} for this skill.${cohortNote}`,
    };
  }
  return {
    status: "ready",
    cohortId: cohort ?? null,
    section: {
      id: "policy",
      kind: "policy",
      purpose: input.purpose,
      classification: "CONFIDENTIAL",
      trust: "TRUSTED_DATA",
      provenanceRef: `policy-snapshot:${bare(authority.policySnapshotDigest)}`,
      contentDigest: stableDigest(value),
      required: true,
      quarantined: false,
      value,
    },
  };
}
