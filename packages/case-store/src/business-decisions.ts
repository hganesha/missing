import { businessDecisionSchema, releaseManifestSchema, verifyReleaseManifestDigest, stableDigest, type BusinessCommand, type BusinessDecision } from "@ehf/contracts";
import type { PoolClient } from "pg";
import { applyLockedCommand, appendLockedCaseEvent, assertActiveCaseExecution, bindCaseTenant,
  CaseStoreError, normalizeDigest, type CaseExecutionAuthority, type CaseStore, type LockedCase } from "./index.js";
import { qualify } from "./config.js";

// An HTTP body or a skill payload cannot mint this process-local capability. It is set
// only after a service evaluation has acquired the released authority and case locks.
const authorizedCommands = new WeakSet<BusinessCommand>();
export const isPolicyAuthorizedCommand = (command: BusinessCommand) => authorizedCommands.has(command);

export async function resolveCasePolicyContract(store: CaseStore, tenantId: string, planDigest: string): Promise<1 | 2> {
  // A case-only development store supports historical fixtures without a control DB.
  // Production creation requires the execution connection in createCaseStore.
  if (!store.executionDb) return 1;
  const result = await store.executionDb.query<{ version: number }>(
    "select harness_runtime.case_policy_contract($1,$2) as version", [tenantId, normalizeDigest(planDigest)]);
  if (result.rows[0]?.version !== 1 && result.rows[0]?.version !== 2) throw new CaseStoreError("policy.admitted_plan_required", 403);
  return result.rows[0].version;
}

/** Acquire fresh registry/release locks and verify the returned manifest's exact content. */
export async function lockBusinessPolicyRelease(control:PoolClient,decision:BusinessDecision):Promise<boolean> {
  const raw=(await control.query<{manifest:unknown}>("select harness_runtime.lock_business_policy_authority($1,$2,$3,$4,$5,$6) as manifest",
    [decision.tenantId,decision.planDigest,decision.releaseDigest,decision.policyBundleDigest,decision.gateId,process.env.RELEASE_ENVIRONMENT??"development"])).rows[0]?.manifest;
  const parsed=releaseManifestSchema.safeParse(raw);
  return parsed.success && parsed.data.manifestDigest.replace(/^sha256:/,"")===decision.releaseDigest && verifyReleaseManifestDigest(parsed.data)
    && parsed.data.planDigest.replace(/^sha256:/,"")===decision.planDigest && parsed.data.scope.tenants.includes(decision.tenantId)
    && parsed.data.policyBundleDigests.some(digest=>digest.replace(/^sha256:/,"")===decision.policyBundleDigest);
}

/** Internal service operation, never a caller-supplied business command or public receipt-import API. */
export async function applyEvaluatedBusinessDecision(store: CaseStore, raw: BusinessDecision, execution: CaseExecutionAuthority, opaInput: Record<string,unknown>) {
  const decision = businessDecisionSchema.parse(raw);
  const { receiptDigest, ...unsigned } = decision;
  if (stableDigest(opaInput) !== decision.inputDigest) throw new CaseStoreError("policy.input_integrity_mismatch",403);
  if (stableDigest(unsigned) !== receiptDigest) throw new CaseStoreError("policy.receipt_integrity_mismatch", 403);
  if (!store.executionDb) throw new CaseStoreError("policy.control_connection_required", 503);
  if (decision.tenantId !== execution.tenant_id || decision.caseId !== execution.case_id || decision.planDigest !== normalizeDigest(execution.plan_digest))
    throw new CaseStoreError("policy.execution_scope_mismatch", 403);
  const control = await store.executionDb.connect();
  const client = await store.db.connect();
  try {
    await control.query("begin");
    await assertActiveCaseExecution(control, execution, decision.tenantId, decision.caseId);
    if (!await lockBusinessPolicyRelease(control,decision)) throw new CaseStoreError("policy.released_authority_required", 403);
    await client.query("begin");
    await bindCaseTenant(client, decision.tenantId);
    const current = (await client.query<LockedCase>(`select * from ${qualify(store.schemas.core, "cases")}
      where tenant_id=$1 and case_id=$2 for update`, [decision.tenantId, decision.caseId])).rows[0];
    if (!current) throw new CaseStoreError("case.not_found", 404);
    const prior = (await client.query<{ receipt_digest: string }>(`select receipt_digest from ${qualify(store.schemas.core, "business_decisions")}
      where tenant_id=$1 and case_id=$2 and decision_id=$3`, [decision.tenantId, decision.caseId, decision.decisionId])).rows[0];
    if (prior) {
      if (prior.receipt_digest !== decision.receiptDigest) throw new CaseStoreError("policy.decision_conflict", 409);
      await client.query("commit");
      return { decision, replayed: true };
    }
    if (decision.caseSequence !== Number(current.case_sequence) || decision.planDigest !== normalizeDigest(current.harness_plan_digest)
      || decision.dependencyDigest !== normalizeDigest(current.dependency_digest ?? current.policy_snapshot_digest))
      throw new CaseStoreError("policy.snapshot_stale", 409);
    if (Date.parse(decision.expiresAt) <= Date.now() || Date.parse(decision.evaluatedAt) > Date.now() + 1000)
      throw new CaseStoreError("policy.decision_expired", 409);
    await client.query(`update ${qualify(store.schemas.core, "cases")} set decision_contract_version=2 where tenant_id=$1 and case_id=$2`, [decision.tenantId, decision.caseId]);
    current.decision_contract_version = 2;
    await client.query(`insert into ${qualify(store.schemas.core, "business_decisions")}
      (tenant_id,case_id,decision_id,receipt_digest,case_sequence,receipt,input) values ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
    [decision.tenantId, decision.caseId, decision.decisionId, decision.receiptDigest, decision.caseSequence, JSON.stringify(decision), JSON.stringify(opaInput)]);
    const actor = { type: "SYSTEM" as const, principalId: "policy-engine", roles: [] };
    const authority = { planDigest: decision.planDigest, policySnapshotDigest: current.policy_snapshot_digest,
      permissionEnvelopeDigest: stableDigest({ decision: decision.receiptDigest, execution }) };
    await appendLockedCaseEvent(client, store, current, { eventType: "policy.business_decision_recorded",
      eventSchema: "harness.policy.business_decision.v2", commandId: decision.decisionId, actor, authority,
      payload: { decisionId: decision.decisionId, receiptDigest, state: decision.result.state, ruleIds: decision.result.ruleIds }, evidenceRefs: [] });
    for (const [actionIndex, action] of decision.result.actions.entries()) {
      const actionDigest = stableDigest(action);
      let result: Record<string, unknown>;
      if (action.kind === "case_command") {
        const command: BusinessCommand = { commandId: `${decision.decisionId}:${actionIndex}`, commandType: action.commandType,
          commandVersion: "harness.policy-action.v2", tenantId: decision.tenantId, caseId: decision.caseId,
          actor, authority: {...authority,businessActionGrant:{apiVersion:"harness.factory/business-action-grant-v2",
            decisionId:decision.decisionId,decisionDigest:decision.receiptDigest,actionIndex,actionDigest}}, payload: action.payload, preconditions: { caseSequence: Number(current.case_sequence) },
          idempotencyKey: `${decision.decisionId}:${actionIndex}` };
        authorizedCommands.add(command);
        try { result = (await applyLockedCommand(client, store, command, current, stableDigest(command))).response; }
        finally { authorizedCommands.delete(command); }
      } else {
        if (action.kind === "adopt_assessment") {
          const version = await client.query(`select 1 from ${qualify(store.schemas.core, "canonical_records")}
            where tenant_id=$1 and case_id=$2 and object_type=$3 and object_id=$4 and version_id=$5`,
          [decision.tenantId, decision.caseId, action.objectType, action.objectId, action.versionId]);
          if (!version.rowCount) throw new CaseStoreError("policy.assessment_version_missing", 409);
          await client.query(`insert into ${qualify(store.schemas.core, "adopted_assessments")}
            (tenant_id,case_id,decision_id,action_index,object_type,object_id,version_id,interpretation,value) values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
          [decision.tenantId, decision.caseId, decision.decisionId, actionIndex, action.objectType, action.objectId, action.versionId, action.interpretation, JSON.stringify(action.value)]);
        } else {
          await client.query(`insert into ${qualify(store.schemas.core, "business_effect_outbox")}
            (tenant_id,case_id,decision_id,action_index,action_digest,action) values ($1,$2,$3,$4,$5,$6::jsonb)`,
          [decision.tenantId, decision.caseId, decision.decisionId, actionIndex, actionDigest, JSON.stringify(action)]);
        }
        result = await appendLockedCaseEvent(client, store, current, { eventType: `policy.${action.kind}`,
          eventSchema: "harness.policy.action.v2", commandId: `${decision.decisionId}:${actionIndex}`, actor, authority,
          payload: { decisionId: decision.decisionId, actionIndex, actionDigest, action }, evidenceRefs: [] });
      }
      await client.query(`insert into ${qualify(store.schemas.core, "business_action_consumptions")}
        (tenant_id,case_id,decision_id,action_index,action_digest,result) values ($1,$2,$3,$4,$5,$6::jsonb)`,
      [decision.tenantId, decision.caseId, decision.decisionId, actionIndex, actionDigest, JSON.stringify(result)]);
    }
    await client.query("commit");
    return { decision, replayed: false };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await control.query("rollback").catch(() => undefined);
    control.release();
  }
}
