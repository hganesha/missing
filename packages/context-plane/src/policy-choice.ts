import type { CasePolicyAuthority } from "./policy.js";

/**
 * Per-case policy packs (agentic plan phase 2, docs/implementation/policy-packs.md): a node may
 * carry one skill policy projection per effective pack its plan pinned (`config.skillPolicies`),
 * instead of a single `config.skillPolicy`. The projection used is the one whose policy id and
 * bundle digest are exactly the case's pin, so a case can only ever be governed by a pack the plan
 * pinned. With no match the single projection, or the first, is returned unchanged: the policy
 * resolver then answers POLICY_UNRESOLVED with its usual explanation of the mismatch.
 */
export function chooseSkillPolicy(
  single: unknown,
  alternatives: unknown,
  authority: CasePolicyAuthority | null | undefined,
): unknown {
  if (!Array.isArray(alternatives) || alternatives.length === 0) return single;
  const bare = (digest: unknown) => (typeof digest === "string" ? digest.replace(/^sha256:/, "") : "");
  const match = alternatives.find((candidate) => {
    const config = candidate as { policyRef?: unknown; bundleDigest?: unknown } | null;
    return Boolean(authority) && config?.policyRef === authority!.policyId && bare(config?.bundleDigest) === bare(authority!.policyBundleDigest);
  });
  return match ?? single ?? alternatives[0];
}
