import { randomUUID } from "node:crypto";
import {
  sourceArtifactSchema, sourceArtifactKindSchema, sourcePolicyDecisionSchema, sourceEvidenceObservationSchema, connectorRegistrationSchema, stableDigest,
  type SourceArtifact, type SourceArtifactKind, type SourcePolicyDecision, type SourceEvidenceObservation,
  type SourceContext, type HarnessPlanV2, type SourceBinding, type SourceAccess, type JurisdictionSourcePolicy,
} from "@ehf/contracts";
import { approveArtifact, registerArtifact, requireApprovedArtifact, type RegistryClient } from "./artifact-registry.js";
import type { Database } from "./index.js";

async function scoped<T>(db: Database, tenantId: string, action: (client: RegistryClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id',$1,true)", [tenantId]);
    const result = await action(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function read(client: RegistryClient, tenantId: string, kind: SourceArtifactKind, digest: string, approved = true): Promise<SourceArtifact> {
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("source_policy.digest_invalid");
  if (approved) await requireApprovedArtifact(client, tenantId, kind, digest);
  const result = await client.query<{ artifact: unknown }>(`select artifact from harness_control.source_artifacts
    where tenant_id=$1 and artifact_kind=$2 and digest=$3`, [tenantId, kind, digest]);
  if (!result.rows[0]) throw new Error("source_policy.artifact_missing");
  const artifact = sourceArtifactSchema.parse(result.rows[0].artifact);
  if (artifact.kind !== kind || stableDigest(artifact) !== digest) throw new Error("source_policy.integrity_denied");
  return artifact;
}

export async function registerSourceArtifact(db: Database, input: { tenantId: string; actor: string; artifact: unknown; expectedDigest: string }) {
  const artifact = sourceArtifactSchema.parse(input.artifact);
  const digest = stableDigest(artifact);
  if (digest !== input.expectedDigest) throw new Error("source_policy.digest_mismatch");
  if (artifact.kind === "source-context" && artifact.tenantId !== input.tenantId) throw new Error("source_policy.tenant_denied");
  return scoped(db, input.tenantId, async (client) => {
    const entry = await registerArtifact(client, { tenantId: input.tenantId, actor: input.actor, kind: artifact.kind, digest, reference: `${artifact.kind}:${digest}` });
    await client.query(`insert into harness_control.source_artifacts(tenant_id, artifact_kind, digest, artifact)
      values($1,$2,$3,$4::jsonb) on conflict do nothing`, [input.tenantId, artifact.kind, digest, JSON.stringify(artifact)]);
    return { artifact, digest, entry };
  });
}

export async function approveSourceArtifact(db: Database, input: { tenantId: string; actor: string; kind: SourceArtifactKind; digest: string; now?: number }) {
  return scoped(db, input.tenantId, async (client) => {
    const artifact = await read(client, input.tenantId, input.kind, input.digest, false);
    const now = input.now ?? Date.now();
    if (Date.parse(artifact.expiresAt) <= now) throw new Error("source_policy.artifact_expired");
    if (artifact.kind === "source-binding" && (artifact.quarantined || artifact.readiness !== "integration_verified" || artifact.jurisdiction === "unresolved")) throw new Error("source_policy.source_not_qualified");
    if (artifact.kind === "source-access") await read(client, input.tenantId, "source-binding", artifact.bindingDigest);
    return approveArtifact(client, { ...input, kind: input.kind });
  });
}

export async function getSourceArtifact(db: Database, tenantId: string, kind: SourceArtifactKind, digest: string, approved = true) {
  return scoped(db, tenantId, (client) => read(client, tenantId, sourceArtifactKindSchema.parse(kind), digest, approved));
}

export async function listSourceArtifacts(db: Database, tenantId: string, kind?: SourceArtifactKind) {
  return scoped(db, tenantId, async (client) => {
    const result = await client.query<{ artifact: unknown; digest: string; status: string; registered_by: string; approved_by: string | null }>(`
      select s.artifact,s.digest,a.status,a.registered_by,a.approved_by from harness_control.source_artifacts s
      join harness_control.artifact_registry a using(tenant_id,artifact_kind,digest)
      where s.tenant_id=$1 and ($2::text is null or s.artifact_kind=$2)
      order by s.created_at desc,s.digest limit 500`, [tenantId, kind ? sourceArtifactKindSchema.parse(kind) : null]);
    return result.rows.map((row) => ({ artifact: sourceArtifactSchema.parse(row.artifact), digest: row.digest,
      status: row.status, registeredBy: row.registered_by, approvedBy: row.approved_by }));
  });
}

export async function requireSourceContext(db: Database, input: { tenantId: string; caseId: string; planDigest: string; digest: string; now?: number }): Promise<SourceContext> {
  const artifact = await getSourceArtifact(db, input.tenantId, "source-context", input.digest);
  const now = input.now ?? Date.now();
  if (artifact.kind !== "source-context" || artifact.tenantId !== input.tenantId || artifact.caseId !== input.caseId || artifact.planDigest !== input.planDigest
    || Date.parse(artifact.validFrom) > now || Date.parse(artifact.expiresAt) <= now) throw new Error("source_policy.context_scope_denied");
  return artifact;
}

/** Fresh authority reads on every invocation and every outbound transport dispatch. */
export async function loadSourceAuthority(db: Database, input: {
  tenantId: string; caseId: string; plan: HarnessPlanV2; contextDigest: string;
  capabilityId: string; connectorId: string;
}) {
  const pin = input.plan.sourceAuthorization?.bindings.find((binding) => binding.capabilityId === input.capabilityId && binding.connectorId === input.connectorId);
  if (!pin || !input.plan.sourceAuthorization) throw new Error("source_policy.binding_unpinned_denied");
  return scoped(db, input.tenantId, async (client) => {
    const context = await read(client, input.tenantId, "source-context", input.contextDigest) as SourceContext;
    if (context.tenantId !== input.tenantId || context.caseId !== input.caseId || context.planDigest !== input.plan.planDigest) throw new Error("source_policy.context_scope_denied");
    const policies: JurisdictionSourcePolicy[] = [];
    for (const digest of input.plan.sourceAuthorization!.policyDigests) policies.push(await read(client, input.tenantId, "source-policy", digest) as JurisdictionSourcePolicy);
    const binding = await read(client, input.tenantId, "source-binding", pin.bindingDigest) as SourceBinding;
    const access = await read(client, input.tenantId, "source-access", pin.accessDigest) as SourceAccess;
    const connector = await client.query<{ definition: Record<string, unknown>; definition_digest: string; status: string }>(`
      select definition,definition_digest,status from harness_gateway.connector_registry where connector_id=$1`, [input.connectorId]);
    const row = connector.rows[0];
    if (!row || row.status !== "live_ready" || stableDigest(row.definition) !== row.definition_digest) throw new Error("source_policy.connector_not_ready_denied");
    const definition = connectorRegistrationSchema.parse({ ...row.definition, status: row.status });
    const modelBinding = input.plan.capabilities.find((capability) => capability.id === input.capabilityId)?.kind === "model" && definition.capabilityId === "model.general.inference.v1";
    if (definition.connectorId !== input.connectorId || definition.capabilityId !== input.capabilityId && !modelBinding) throw new Error("source_policy.connector_semantics_denied");
    const canonical = definition.canonical;
    if (canonical && canonical.runtimeDisposition !== "alias_pending_approval") throw new Error("source_policy.connector_semantics_denied");
    return { context, policies, binding, access, connectorDigest: stableDigest(definition) };
  });
}

export async function recordSourceDecision(db: Database, input: {
  tenantId: string; runId: string; invocationId: string; capabilityId: string; connectorId: string;
  stage: "acquire" | "use" | "transport"; decision: SourcePolicyDecision; observation?: SourceEvidenceObservation;
}) {
  const decision = sourcePolicyDecisionSchema.parse(input.decision);
  const observation = input.observation ? sourceEvidenceObservationSchema.parse(input.observation) : null;
  const decisionId = `SD-${randomUUID()}`;
  await scoped(db, input.tenantId, async (client) => {
    const inserted = await client.query(`insert into harness_gateway.source_decisions
      (decision_id,tenant_id,run_id,invocation_id,capability_id,connector_id,stage,decision_digest,decision,observation)
      select $1,$2,r.run_id,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb from harness_runtime.runs r
      where r.run_id=$3 and r.tenant_id=$2`, [decisionId, input.tenantId, input.runId, input.invocationId, input.capabilityId,
      input.connectorId, input.stage, stableDigest(decision), JSON.stringify(decision), observation ? JSON.stringify(observation) : null]);
    if (inserted.rowCount !== 1) throw new Error("source_policy.run_scope_denied");
  });
  return decisionId;
}

export async function listSourceDecisions(db: Database, tenantId: string, runId: string) {
  return scoped(db, tenantId, async (client) => {
    const result = await client.query<{ decision_id: string; capability_id: string; connector_id: string; stage: string; decision: unknown; observation: unknown; decision_digest: string }>(`
      select decision_id,capability_id,connector_id,stage,decision,observation,decision_digest from harness_gateway.source_decisions
      where tenant_id=$1 and run_id=$2 order by created_at desc,decision_id limit 500`, [tenantId, runId]);
    return result.rows.map((row) => {
      const decision = sourcePolicyDecisionSchema.parse(row.decision);
      if (stableDigest(decision) !== row.decision_digest) throw new Error("source_policy.integrity_denied");
      return { decisionId: row.decision_id, capabilityId: row.capability_id, connectorId: row.connector_id, stage: row.stage, decision,
        observation: row.observation ? sourceEvidenceObservationSchema.parse(row.observation) : null };
    });
  });
}

export async function getSourceDecision(db: Database, tenantId: string, decisionId: string) {
  return scoped(db, tenantId, async (client) => {
    const result = await client.query<{ decision: unknown; observation: unknown; decision_digest: string; run_id: string; stage: string; capability_id: string; connector_id: string }>(`
      select decision,observation,decision_digest,run_id,stage,capability_id,connector_id from harness_gateway.source_decisions
      where tenant_id=$1 and decision_id=$2`, [tenantId, decisionId]);
    const row = result.rows[0];
    if (!row) throw new Error("source_policy.evidence_decision_missing");
    const decision = sourcePolicyDecisionSchema.parse(row.decision);
    if (stableDigest(decision) !== row.decision_digest) throw new Error("source_policy.integrity_denied");
    return { decision, observation: row.observation ? sourceEvidenceObservationSchema.parse(row.observation) : null,
      runId: row.run_id, stage: row.stage, capabilityId: row.capability_id, connectorId: row.connector_id };
  });
}

async function planArtifacts(client: RegistryClient, tenantId: string, plan: HarnessPlanV2) {
  if (!plan.sourceAuthorization) return;
    const current = (artifact: SourceArtifact) => {
      if (Date.parse(artifact.validFrom) > Date.now() || Date.parse(artifact.expiresAt) <= Date.now()) throw new Error("source_policy.artifact_not_current");
    };
    for (const digest of plan.sourceAuthorization!.policyDigests) current(await read(client, tenantId, "source-policy", digest));
    for (const pin of plan.sourceAuthorization!.bindings) {
      const binding = await read(client, tenantId, "source-binding", pin.bindingDigest) as SourceBinding;
      const access = await read(client, tenantId, "source-access", pin.accessDigest) as SourceAccess;
      current(binding); current(access);
      if (binding.capabilityId !== pin.capabilityId || binding.connectorId !== pin.connectorId || access.bindingDigest !== pin.bindingDigest
        || binding.quarantined || binding.jurisdiction === "unresolved" || binding.readiness !== "integration_verified") throw new Error("source_policy.plan_scope_denied");
    }
}

export async function requirePlanSourceArtifacts(db: Database, tenantId: string, plan: HarnessPlanV2) {
  if (!plan.sourceAuthorization) return;
  return scoped(db, tenantId, (client) => planArtifacts(client, tenantId, plan));
}

export async function requireRunSourceAuthority(client: RegistryClient, input: { tenantId: string; planDigest: string; runInput: unknown; sourceContextDigest?: string }) {
  const result = await client.query<{ plan: HarnessPlanV2 }>("select plan from harness_control.plans where tenant_id=$1 and plan_digest=$2", [input.tenantId, input.planDigest]);
  const plan = result.rows[0]?.plan;
  if (!plan?.sourceAuthorization && !input.sourceContextDigest) return;
  if (!input.sourceContextDigest) throw new Error("source_policy.context_required");
  const context = await read(client, input.tenantId, "source-context", input.sourceContextDigest) as SourceContext;
  const identity = input.runInput as { tenantId?: unknown; caseId?: unknown } | null;
  if (!identity || identity.tenantId !== input.tenantId || identity.caseId !== context.caseId || context.tenantId !== input.tenantId || context.planDigest !== input.planDigest
    || Date.parse(context.validFrom) > Date.now() || Date.parse(context.expiresAt) <= Date.now()) throw new Error("source_policy.context_scope_denied");
  if (!plan) throw new Error("source_policy.plan_missing");
  await planArtifacts(client, input.tenantId, plan);
}
