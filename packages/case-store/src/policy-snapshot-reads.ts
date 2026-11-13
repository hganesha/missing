import { randomUUID } from "node:crypto";
import type { CaseSnapshot } from "@ehf/contracts";
import { bindCaseTenant, CaseStoreError, type CaseStore } from "./index.js";
import { qualify } from "./config.js";

/** Called by the trusted read service after applying its signed selector envelope. */
export async function recordPolicySnapshotRead(store:CaseStore,snapshot:CaseSnapshot,nodeId:string,purpose:string):Promise<CaseSnapshot> {
  const client=await store.db.connect();
  try {
    await client.query("begin");await bindCaseTenant(client,snapshot.tenantId);
    const current=(await client.query<{decision_contract_version:number;case_sequence:string}>(`select decision_contract_version,case_sequence
      from ${qualify(store.schemas.core,"cases")} where tenant_id=$1 and case_id=$2 for share`,[snapshot.tenantId,snapshot.caseId])).rows[0];
    if(!current)throw new CaseStoreError("case.not_found",404);
    if(current.decision_contract_version!==2){await client.query("commit");return snapshot;}
    if(Number(current.case_sequence)!==snapshot.caseSequence)throw new CaseStoreError("policy.snapshot_stale",409);
    await client.query(`select ${qualify(store.schemas.core,"purge_expired_policy_reads")}()`);
    const readReceiptId="read_"+randomUUID();
    await client.query(`insert into ${qualify(store.schemas.core,"policy_snapshot_reads")}
      (tenant_id,case_id,read_receipt_id,plan_digest,node_id,purpose,case_sequence,snapshot_digest,captured_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [snapshot.tenantId,snapshot.caseId,readReceiptId,snapshot.planDigest,nodeId,purpose,snapshot.caseSequence,snapshot.snapshotDigest,snapshot.capturedAt]);
    await client.query("commit");return {...snapshot,readReceiptId};
  } catch(error){await client.query("rollback").catch(()=>undefined);throw error;}finally{client.release();}
}

export async function verifyPolicySnapshotRead(store:CaseStore,snapshot:Pick<CaseSnapshot,"readReceiptId"|"tenantId"|"caseId"|"planDigest"|"caseSequence"|"snapshotDigest"|"capturedAt">,nodeId:string,purpose:string) {
  if(!snapshot.readReceiptId)throw new CaseStoreError("policy.snapshot_read_proof_required",403);
  const client=await store.db.connect();
  try {
    await client.query("begin read only");await bindCaseTenant(client,snapshot.tenantId);
    const row=await client.query(`select 1 from ${qualify(store.schemas.core,"policy_snapshot_reads")} where tenant_id=$1 and case_id=$2
      and read_receipt_id=$3 and plan_digest=$4 and node_id=$5 and purpose=$6 and case_sequence=$7 and snapshot_digest=$8 and captured_at=$9
      and created_at>clock_timestamp()-interval '60 seconds'`,
    [snapshot.tenantId,snapshot.caseId,snapshot.readReceiptId,snapshot.planDigest,nodeId,purpose,snapshot.caseSequence,snapshot.snapshotDigest,snapshot.capturedAt]);
    if(!row.rowCount)throw new CaseStoreError("policy.snapshot_read_proof_invalid",403);
    await client.query("commit");
  }finally{await client.query("rollback").catch(()=>undefined);client.release();}
}
