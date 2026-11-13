import {
  lockDigestFromRegistryReference,
  skillBundleLockDigest,
  skillBundleLockSchema,
  skillBundleRegistryReference,
  type ArtifactRegistryEntry,
  type SkillBundleLock,
} from "@ehf/contracts";
import { approveArtifact, registerApprovedArtifact, registerArtifact, requireApprovedArtifact, type RegistryClient } from "./artifact-registry.js";
import type { Database } from "./index.js";

/**
 * Skill-host bundles in the artifact registry (skill.execution.v1 §8).
 *
 * The registry key is the lock's `bundle_digest`; the reference also names the digest of the
 * exact lock content, so the gateway can check that what a host serves at `GET /v1/bundle` is
 * the lock that was approved, not merely a lock that quotes an approved digest. Registration
 * and approval are separate actors (the registry's separation-of-duties rule).
 */

async function tenantScoped<T>(db: Database, tenantId: string, action: (client: RegistryClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await action(client as unknown as RegistryClient);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function registerSkillBundle(db: Database, input: { tenantId: string; lock: unknown; actor: string }): Promise<{
  entry: ArtifactRegistryEntry; lock: SkillBundleLock; lockDigest: string;
}> {
  const lock = skillBundleLockSchema.parse(input.lock);
  const entry = await tenantScoped(db, input.tenantId, (client) => registerArtifact(client, {
    tenantId: input.tenantId, kind: "skill-bundle", digest: lock.bundle_digest,
    reference: skillBundleRegistryReference(lock), actor: input.actor,
  }));
  return { entry, lock, lockDigest: skillBundleLockDigest(lock) };
}

export async function approveSkillBundle(db: Database, input: { tenantId: string; bundleDigest: string; actor: string }): Promise<ArtifactRegistryEntry> {
  return tenantScoped(db, input.tenantId, (client) => approveArtifact(client, {
    tenantId: input.tenantId, kind: "skill-bundle", digest: input.bundleDigest, actor: input.actor,
  }));
}

/**
 * Development only: register and approve a lock in one step, recorded under two system actors
 * named for what happened (`DEV_AUTO_APPROVAL_ACTOR` approves), so the registry history shows
 * the approval was automatic rather than a person's review. Callers gate it on an explicit
 * development choice; it is never reached from an HTTP route.
 */
export const DEV_AUTO_APPROVAL_ACTOR = "system:dev-auto-approval";
export async function autoApproveSkillBundle(db: Database, input: { tenantId: string; lock: unknown; registeredBy: string }): Promise<{
  entry: ArtifactRegistryEntry; lock: SkillBundleLock; lockDigest: string;
}> {
  const lock = skillBundleLockSchema.parse(input.lock);
  if (input.registeredBy === DEV_AUTO_APPROVAL_ACTOR) throw new Error("artifact.separation_of_duties");
  const entry = await tenantScoped(db, input.tenantId, (client) => registerApprovedArtifact(client, {
    tenantId: input.tenantId, kind: "skill-bundle", digest: lock.bundle_digest, reference: skillBundleRegistryReference(lock),
    registeredBy: input.registeredBy, approvedBy: DEV_AUTO_APPROVAL_ACTOR,
  }));
  return { entry, lock, lockDigest: skillBundleLockDigest(lock) };
}

/**
 * The served lock is executable: its `bundle_digest` has an approved, unrevoked
 * `skill-bundle` entry for the tenant and the entry names exactly this lock's content.
 * A fresh registry read every time; never cached.
 */
export async function requireApprovedSkillBundle(db: Database, tenantId: string, lock: SkillBundleLock): Promise<ArtifactRegistryEntry> {
  const entry = await tenantScoped(db, tenantId, (client) => requireApprovedArtifact(client, tenantId, "skill-bundle", lock.bundle_digest));
  if (lockDigestFromRegistryReference(entry.reference) !== skillBundleLockDigest(lock)) throw new Error("artifact.skill_bundle_lock_mismatch");
  return entry;
}

/**
 * Receipt digests of the delegated dependency calls of one skill execution: gateway receipts
 * of the run whose invocation id is `<executionId>:<key>`. Used to check that a proposed
 * record's `receipt_digest` evidence came from this execution.
 */
export async function delegatedReceiptDigests(db: Database, runId: string, executionId: string): Promise<string[]> {
  const prefix = `${executionId}:`;
  const result = await db.query<{ receipt_digest: string | null }>(`
    select receipt_digest from harness_gateway.receipts
    where run_id = $1 and left(invocation_id, length($2)) = $2 and receipt_digest is not null
    order by created_at
  `, [runId, prefix]);
  return result.rows.map((row) => row.receipt_digest).filter((digest): digest is string => typeof digest === "string");
}
