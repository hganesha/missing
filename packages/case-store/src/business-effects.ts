import { lockBusinessPolicyRelease } from "./business-decisions.js";
import { businessActionSchema, businessDecisionSchema, stableDigest, type BusinessAction } from "@ehf/contracts";
import { z } from "zod";
import { appendLockedCaseEvent, bindCaseTenant, normalizeDigest, CaseStoreError, type CaseStore, type LockedCase } from "./index.js";
import { qualify } from "./config.js";

const deliverySchema=z.discriminatedUnion("status",[
  z.object({status:z.literal("DELIVERED"),providerReceipt:z.record(z.string(),z.json())}).strict(),
  z.object({status:z.literal("NOT_SENT"),reason:z.string().min(1).max(200)}).strict(),
  z.object({status:z.literal("UNKNOWN"),reason:z.string().min(1).max(200)}).strict(),
]);
export type BusinessEffectDelivery=z.infer<typeof deliverySchema>;
export type BusinessEffectAdapter=(request:{
  tenantId:string;caseId:string;purpose:string;action:Extract<BusinessAction,{kind:"external_action"}>;idempotencyKey:string;
})=>Promise<BusinessEffectDelivery>;

/**
 * A trusted delivery service supplies a qualified adapter for the named action. The adapter
 * MUST honor the stable idempotency key, including after a network/commit ambiguity.
 * No arbitrary URL, capability or provider can be selected by an agent or HTTP payload.
 */
export async function dispatchBusinessEffect(store:CaseStore, input:{
  tenantId:string;caseId:string;decisionId:string;actionIndex:number;
  adapters:Partial<Record<"regulatory.filing.submit"|"evidence.retention.delete",BusinessEffectAdapter>>;
}) {
  if(!store.executionDb) throw new CaseStoreError("policy.control_connection_required",503);
  const control=await store.executionDb.connect(),client=await store.db.connect();
  try {
    // Always acquire control authority before a case lock. Other decision writers use
    // this same order; reversing it can deadlock across the two database connections
    // when a release revocation is queued between shared-lock requests.
    await client.query("begin read only");await bindCaseTenant(client,input.tenantId);
    const stored=(await client.query<{receipt:unknown}>(`select receipt from ${qualify(store.schemas.core,"business_decisions")}
      where tenant_id=$1 and case_id=$2 and decision_id=$3`,[input.tenantId,input.caseId,input.decisionId])).rows[0];
    if(!stored)throw new CaseStoreError("policy.external_effect_not_found",404);
    const authorityDecision=businessDecisionSchema.parse(stored.receipt);
    const {receiptDigest:authorityDigest,...authorityBody}=authorityDecision;
    if(stableDigest(authorityBody)!==authorityDigest)throw new CaseStoreError("policy.external_effect_integrity_mismatch",403);
    await client.query("commit");
    await control.query("begin");
    const authorized=await lockBusinessPolicyRelease(control,authorityDecision);
    await client.query("begin");await bindCaseTenant(client,input.tenantId);
    const current=(await client.query<LockedCase>(`select * from ${qualify(store.schemas.core,"cases")} where tenant_id=$1 and case_id=$2 for update`,
      [input.tenantId,input.caseId])).rows[0];
    if(!current) throw new CaseStoreError("case.not_found",404);
    const queued=(await client.query<{status:string;action:unknown;action_digest:string;provider_receipt:unknown;receipt:unknown}>(
      `select o.*,d.receipt from ${qualify(store.schemas.core,"business_effect_outbox")} o
       join ${qualify(store.schemas.core,"business_decisions")} d using(tenant_id,case_id,decision_id)
       where o.tenant_id=$1 and o.case_id=$2 and o.decision_id=$3 and o.action_index=$4 for update of o`,
    [input.tenantId,input.caseId,input.decisionId,input.actionIndex])).rows[0];
    if(!queued) throw new CaseStoreError("policy.external_effect_not_found",404);
    if(queued.status!=="PENDING") {await client.query("commit");return {status:queued.status,providerReceipt:queued.provider_receipt,replayed:true};}
    const decision=businessDecisionSchema.parse(queued.receipt),action=businessActionSchema.parse(queued.action);
    const {receiptDigest,...unsigned}=decision;
    if(receiptDigest!==authorityDigest || stableDigest(unsigned)!==receiptDigest || action.kind!=="external_action" || stableDigest(action)!==queued.action_digest
      || stableDigest(decision.result.actions[input.actionIndex])!==queued.action_digest)
      throw new CaseStoreError("policy.external_effect_integrity_mismatch",403);
    const completed=(await client.query<{n:number}>(`select count(*)::int n from ${qualify(store.schemas.core,"business_effect_outbox")}
      where tenant_id=$1 and case_id=$2 and decision_id=$3 and status<>'PENDING'`,[input.tenantId,input.caseId,input.decisionId])).rows[0]!.n;
    let result:BusinessEffectDelivery|{status:"CANCELLED";reason:string};
    if(!authorized || Date.now()>=Date.parse(decision.expiresAt) || current.harness_plan_digest!==decision.planDigest
      || decision.dependencyDigest!==normalizeDigest(current.dependency_digest??current.policy_snapshot_digest)
      || Number(current.case_sequence)!==decision.caseSequence+1+decision.result.actions.length+completed)
      result={status:"CANCELLED",reason:"policy.external_effect_authority_stale"};
    else {
      const adapter=input.adapters[action.action];
      if(!adapter) throw new CaseStoreError("policy.external_adapter_unavailable",503);
      try {
        result=deliverySchema.parse(await adapter({tenantId:input.tenantId,caseId:input.caseId,purpose:decision.purpose,action,
          idempotencyKey:"effect_"+stableDigest([input.tenantId,input.caseId,input.decisionId,input.actionIndex,queued.action_digest])}));
      } catch {result={status:"UNKNOWN",reason:"policy.external_delivery_ambiguous"};}
    }
    const status=result.status==="UNKNOWN"?"RECONCILIATION":result.status==="NOT_SENT"?"PENDING":result.status;
    await client.query(`update ${qualify(store.schemas.core,"business_effect_outbox")} set status=$5,provider_receipt=$6::jsonb
      where tenant_id=$1 and case_id=$2 and decision_id=$3 and action_index=$4`,
    [input.tenantId,input.caseId,input.decisionId,input.actionIndex,status,JSON.stringify(result)]);
    if(status!=="PENDING")await appendLockedCaseEvent(client,store,current,{
      eventType:"policy.external_effect_delivery",eventSchema:"harness.policy.external_effect_delivery.v2",
      commandId:input.decisionId+":delivery:"+input.actionIndex,actor:{type:"SYSTEM",principalId:"policy-effect-delivery",roles:[]},
      authority:{planDigest:decision.planDigest,decisionDigest:decision.receiptDigest,releaseDigest:decision.releaseDigest},
      payload:{decisionId:input.decisionId,actionIndex:input.actionIndex,actionDigest:queued.action_digest,status,delivery:result},evidenceRefs:[],
    });
    await client.query("commit");return {status,providerReceipt:result,replayed:false};
  } catch(error){await client.query("rollback").catch(()=>undefined);throw error;}
  finally{client.release();await control.query("rollback").catch(()=>undefined);control.release();}
}
