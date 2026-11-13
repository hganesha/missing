import {
  businessSkillDependencies,
  platformCapabilityId,
  delegatedEnvelopeRequestSchema,
  delegatedSkillAudience,
  skillBindingForNode,
  SKILL_ADAPTER_PREFIX,
  type EffectClass,
  type ExecutionEnvelopeClaims,
  type HarnessPlanV2,
} from "@ehf/contracts";
import { isDelegatedEnvelope, mintDelegatedEnvelope, verifyExecutionEnvelope, type JwtSigner } from "./index.js";

/** An authority refusal: a stable reason code and the HTTP status a server maps it to. */
export class EnvelopeAuthorityError extends Error {
  constructor(readonly code: string, readonly httpStatus = 403) {
    super(code);
  }
}

/** Minimal durable-state shapes the delegation decision reads. */
type RunState = { runId: string; attempt: number; status: string; planDigest: string };
type WorkState = {
  status: string;
  lease: { fencingEpoch: number; leaseUntil: string } | null;
  constraints: { nodeId?: string | null; runId?: string | null };
};
type SkillState = { manifest: Parameters<typeof businessSkillDependencies>[0]; manifestDigest: string };

/**
 * Durable-state reads the decision needs, injected so the same rules run wherever the
 * delegated envelope is issued (the capability gateway) without this package depending
 * on a database client.
 */
export type DelegationReads<Db> = {
  getRun(db: Db, runId: string): Promise<RunState | null>;
  currentFencingEpoch(db: Db, runId: string): Promise<number | null>;
  getPlan(db: Db, planDigest: string): Promise<HarnessPlanV2 | null>;
  requireExecutableRelease(db: Db, tenantId: string, planDigest: string, environment: string): Promise<unknown>;
  getExecutionWorkItem(db: Db, tenantId: string, workItemId: string): Promise<WorkState | null>;
  getBusinessSkill(db: Db, skillId: string, semver: string): Promise<SkillState | null>;
};

export type DelegationDependencies<Db> = {
  db: Db;
  reads: DelegationReads<Db>;
  envelopeSecret?: string;
  envelopeSigner?: JwtSigner;
  /** Verifies parent node envelopes: the HMAC secret locally, the control plane's public key in production. */
  envelopeVerifier: string;
  environment?: string;
};

/**
 * Exchange a node envelope for a delegated envelope (skill.execution.v1 §6.1).
 *
 * Run in-process by the capability gateway's `skills` adapter, the only component that ever
 * presents or accepts a delegated envelope, so issuing it needs no call to another service.
 * The parent is verified again here and everything is re-derived from durable state, exactly
 * as the control plane does when it exchanges a runtime grant for a node envelope: the run must be
 * running at the parent's attempt and fence, a v2 plan's release must still be executable and
 * the node's work item must still be leased under the parent's work fence. The narrowed
 * capability set must lie inside the parent, the node's permission envelope and the skill's
 * declared dependencies, and may not include another skill (no recursion through the
 * gateway; sub-skills run in-process). A delegated envelope is never delegated again.
 */
export async function issueDelegatedEnvelope<Db>(
  dependencies: DelegationDependencies<Db>,
  callerTenantId: string,
  parentToken: string,
  body: unknown,
): Promise<{ envelope: string; jti: string; expiresAt: string; capabilities: string[]; effects: EffectClass[] }> {
  const request = delegatedEnvelopeRequestSchema.parse(body);
  let parent: ExecutionEnvelopeClaims;
  try {
    parent = await verifyExecutionEnvelope(parentToken, dependencies.envelopeVerifier);
  } catch {
    throw new EnvelopeAuthorityError("broker.parent_envelope_invalid", 401);
  }
  if (isDelegatedEnvelope(parent)) throw new EnvelopeAuthorityError("broker.delegation_chain_refused");
  if (parent.tenant_id !== callerTenantId) throw new EnvelopeAuthorityError("broker.tenant_mismatch");
  const reads = dependencies.reads;

  const run = await reads.getRun(dependencies.db, parent.run_id);
  if (!run) throw new EnvelopeAuthorityError("broker.run_not_found", 404);
  if (run.attempt !== parent.attempt) throw new EnvelopeAuthorityError("broker.attempt_mismatch");
  if (run.status !== "running") throw new EnvelopeAuthorityError("broker.run_not_running");
  if (run.planDigest !== parent.plan_digest) throw new EnvelopeAuthorityError("broker.plan_mismatch");
  const epoch = await reads.currentFencingEpoch(dependencies.db, parent.run_id);
  if (epoch === null || epoch !== parent.fencing_epoch) throw new EnvelopeAuthorityError("broker.stale_fence");
  const plan = await reads.getPlan(dependencies.db, run.planDigest);
  if (!plan) throw new EnvelopeAuthorityError("broker.plan_not_admitted", 404);
  try {
    await reads.requireExecutableRelease(dependencies.db, parent.tenant_id, plan.planDigest, dependencies.environment ?? "development");
  } catch {
    // A revoked or deactivated release withdraws delegated authority at once.
    throw new EnvelopeAuthorityError("broker.release_not_executable");
  }
  if (!parent.work_item_id) throw new EnvelopeAuthorityError("broker.node_grant_required");
  const work = await reads.getExecutionWorkItem(dependencies.db, parent.tenant_id, parent.work_item_id);
  if (work?.status !== "RUNNING" || !work.lease || work.lease.fencingEpoch !== parent.work_fencing_epoch
    || Date.parse(work.lease.leaseUntil) <= Date.now()
    || work.constraints.nodeId !== parent.node_id || work.constraints.runId !== run.runId) {
    throw new EnvelopeAuthorityError("broker.work_authority_expired");
  }
  const permission = plan.permissionEnvelopes.find((item) => item.nodeId === parent.node_id);
  if (!permission || permission.digest !== parent.permission_digest) throw new EnvelopeAuthorityError("broker.permission_mismatch");

  let binding;
  try {
    binding = skillBindingForNode(plan, parent.node_id, request.skillId);
  } catch {
    binding = null;
  }
  if (!binding || binding.skillId !== request.skillId || binding.semver !== request.skillVersion) {
    throw new EnvelopeAuthorityError("broker.delegation_skill_mismatch");
  }
  const skill = await reads.getBusinessSkill(dependencies.db, binding.skillId, binding.semver);
  if (!skill || skill.manifestDigest !== binding.manifestDigest) throw new EnvelopeAuthorityError("broker.delegation_skill_unregistered", 409);
  // Library manifests declare provider capabilities by library name (CR-8): compare platform ids.
  const declared = new Set(businessSkillDependencies(skill.manifest).capabilities.map(platformCapabilityId));
  const capabilities = new Map(plan.capabilities.map((capability) => [capability.id, capability]));
  const requested = [...new Set(request.capabilities)];
  for (const capabilityId of requested) {
    const capability = capabilities.get(capabilityId);
    if (!capability || !declared.has(capabilityId) || !parent.capabilities.includes(capabilityId)
      || !permission.capabilities.includes(capabilityId) || capability.adapterBindingId.startsWith(SKILL_ADAPTER_PREFIX)) {
      throw new EnvelopeAuthorityError("broker.delegation_capability_denied");
    }
  }
  const effects = [...new Set(requested.map((capabilityId) => capabilities.get(capabilityId)!.effect))]
    .filter((effect) => parent.effects.includes(effect) && permission.effects.includes(effect));
  try {
    const minted = await mintDelegatedEnvelope({
      ...(dependencies.envelopeSigner ? { signer: dependencies.envelopeSigner } : { secret: dependencies.envelopeSecret! }),
      parent,
      delegatedTo: delegatedSkillAudience(binding.skillId, binding.semver),
      capabilities: requested,
      effects,
      deadlineAt: Math.floor(Date.parse(request.deadlineAt) / 1000),
    });
    return { envelope: minted.envelope, jti: minted.jti, expiresAt: new Date(minted.expiresAt * 1000).toISOString(), capabilities: requested, effects };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "execution_auth.delegation_expired") throw new EnvelopeAuthorityError("broker.delegation_expired");
    throw error;
  }
}
