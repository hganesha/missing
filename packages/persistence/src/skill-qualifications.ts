import {
  skillQualificationSchema, stableDigest, type SkillQualification,
} from "@ehf/contracts";
import type { Database } from "./index.js";
import { approveArtifact, registerArtifact, requireApprovedArtifact, type RegistryClient } from "./artifact-registry.js";

async function scoped<T>(db: Database, tenantId: string, action: (client: RegistryClient) => Promise<T>): Promise<T> {
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
  } finally { client.release(); }
}

export async function registerSkillQualification(db: Database, input: { tenantId: string; actor: string; qualification: unknown }) {
  const qualification = skillQualificationSchema.parse(input.qualification);
  if (qualification.independentReviewer === input.actor) throw new Error("artifact.separation_of_duties");
  const digest = stableDigest(qualification);
  return scoped(db, input.tenantId, async (client) => {
    const entry = await registerArtifact(client, {
      tenantId: input.tenantId, kind: "skill-qualification", digest,
      reference: `skill-qualification:${digest}`, actor: input.actor,
    });
    await client.query(`insert into harness_control.skill_qualifications(tenant_id, digest, qualification)
      values ($1,$2,$3::jsonb) on conflict (tenant_id,digest) do nothing`,
    [input.tenantId, digest, JSON.stringify(qualification)]);
    return { digest, qualification, entry };
  });
}

export async function listSkillQualifications(db: Database, tenantId: string): Promise<Array<{ digest: string; qualification: SkillQualification; status: string }>> {
  return scoped(db, tenantId, async (client) => {
    const result = await client.query<{ digest: string; qualification: unknown; status: string }>(`
      select q.digest, q.qualification, a.status from harness_control.skill_qualifications q
      join harness_control.artifact_registry a on a.tenant_id=q.tenant_id and a.digest=q.digest and a.artifact_kind='skill-qualification'
      where q.tenant_id=$1 order by q.created_at desc, q.digest limit 200`, [tenantId]);
    return result.rows.map((row) => ({ digest: row.digest, qualification: skillQualificationSchema.parse(row.qualification), status: row.status }));
  });
}

export async function approveSkillQualification(db: Database, input: { tenantId: string; actor: string; digest: string; now?: number }) {
  if (!/^[a-f0-9]{64}$/.test(input.digest)) throw new Error("artifact.digest_invalid");
  return scoped(db, input.tenantId, async (client) => {
    const result = await client.query<{ qualification: unknown }>(
      "select qualification from harness_control.skill_qualifications where tenant_id=$1 and digest=$2", [input.tenantId, input.digest]);
    if (!result.rows[0]) throw new Error("artifact.not_registered");
    const q = skillQualificationSchema.parse(result.rows[0].qualification);
    if (stableDigest(q) !== input.digest) throw new Error("skill_qualification.integrity_failure");
    if (q.independentReviewer !== input.actor) throw new Error("skill_qualification.reviewer_mismatch");
    if (Date.parse(q.expiresAt) <= (input.now ?? Date.now())) throw new Error("skill_qualification.expired");
    return approveArtifact(client, { ...input, kind: "skill-qualification" });
  });
}

export type SkillQualificationScope = Pick<SkillQualification,
  "skillId" | "skillVersion" | "manifestDigest" | "bundleDigest" | "bundleLockDigest" | "planDigest" | "policySnapshotRef" | "policyContextDigest" | "purpose"> & { jurisdiction: string };

export function qualificationCovers(q: SkillQualification, scope: SkillQualificationScope, now: number): boolean {
  return q.skillId === scope.skillId && q.skillVersion === scope.skillVersion && q.manifestDigest === scope.manifestDigest
    && q.bundleDigest === scope.bundleDigest && q.bundleLockDigest === scope.bundleLockDigest && q.planDigest === scope.planDigest
    && q.policySnapshotRef === scope.policySnapshotRef && q.policyContextDigest === scope.policyContextDigest
    && q.purpose === scope.purpose && q.jurisdictions.includes(scope.jurisdiction)
    && Date.parse(q.validFrom) <= now && now < Date.parse(q.expiresAt);
}

/** Fresh tenant-scoped read at every invocation: exact artifacts, workflow, policy and scope.
 * The approved plan/policy defines supported products/roles; free-form scope text grants no authority.
 */
export async function requireSkillQualification(db: Database, tenantId: string, scope: SkillQualificationScope, now: number): Promise<string> {
  return scoped(db, tenantId, async (client) => {
    const result = await client.query<{ digest: string; qualification: unknown }>(`
      select q.digest, q.qualification from harness_control.skill_qualifications q
      join harness_control.artifact_registry a on a.tenant_id=q.tenant_id and a.digest=q.digest and a.artifact_kind='skill-qualification'
      where q.tenant_id=$1 and q.qualification->>'skillId'=$2 and q.qualification->>'skillVersion'=$3
        and q.qualification->>'planDigest'=$4 and q.qualification->>'manifestDigest'=$5
        and q.qualification->>'bundleDigest'=$6 and q.qualification->>'bundleLockDigest'=$7
        and q.qualification->>'policySnapshotRef'=$8 and q.qualification->>'purpose'=$9
        and q.qualification->>'policyContextDigest'=$12
        and q.qualification->'jurisdictions' ? $10
        and (q.qualification->>'validFrom')::timestamptz <= $11::timestamptz
        and (q.qualification->>'expiresAt')::timestamptz > $11::timestamptz
        and a.status='approved' order by q.digest limit 32`,
    [tenantId, scope.skillId, scope.skillVersion, scope.planDigest, scope.manifestDigest, scope.bundleDigest,
      scope.bundleLockDigest, scope.policySnapshotRef, scope.purpose, scope.jurisdiction, new Date(now).toISOString(), scope.policyContextDigest]);
    for (const row of result.rows) {
      const q = skillQualificationSchema.parse(row.qualification);
      if (stableDigest(q) !== row.digest) throw new Error("skill_qualification.integrity_failure");
      if (!qualificationCovers(q, scope, now)) continue;
      const artifact = await requireApprovedArtifact(client, tenantId, "skill-qualification", row.digest);
      if (artifact.approvedBy !== q.independentReviewer) throw new Error("skill_qualification.reviewer_mismatch");
      return row.digest;
    }
    throw new Error("skill_qualification.required");
  });
}
