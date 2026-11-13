import { stableDigest } from '@ehf/contracts';
import type { Database } from './index.js';

/** Immutable observation, separate from the later human decision and canonical case mutation. */
export async function retainExecutionOutcome(db:Database,input:{tenantId:string;workItemId:string;executionId:string;fencingEpoch:number;outcome:unknown}) {
  const c=await db.connect();
  try {
    await c.query('begin'); await c.query("select set_config('app.tenant_id',$1,true)",[input.tenantId]);
    const row=(await c.query(`select 1 from workflow.work_items where tenant_id=$1 and work_item_id=$2
      and execution_id=$3 and fencing_epoch=$4 and status='RUNNING' and lease_until>clock_timestamp()
      and cancellation_requested_at is null for update`,[input.tenantId,input.workItemId,input.executionId,input.fencingEpoch])).rows[0];
    if(!row) throw new Error('workflow.stale_outcome');
    const digest=stableDigest(input.outcome);
    await c.query(`insert into workflow.execution_outcomes(tenant_id,work_item_id,execution_id,fencing_epoch,outcome,outcome_digest)
      values($1,$2,$3,$4,$5::jsonb,$6) on conflict do nothing`,[input.tenantId,input.workItemId,input.executionId,input.fencingEpoch,JSON.stringify(input.outcome),digest]);
    const stored=(await c.query('select outcome_digest from workflow.execution_outcomes where tenant_id=$1 and work_item_id=$2 and execution_id=$3',[input.tenantId,input.workItemId,input.executionId])).rows[0];
    if(stored?.outcome_digest!==digest) throw new Error('workflow.outcome_conflict');
    await c.query('commit');
  } catch(e) {await c.query('rollback');throw e;} finally {c.release();}
}
export async function latestExecutionOutcome(db:Database,tenantId:string,workItemId:string):Promise<unknown|null> {
  const c=await db.connect();
  try {
    await c.query('begin read only'); await c.query("select set_config('app.tenant_id',$1,true)",[tenantId]);
    const row=(await c.query('select outcome,outcome_digest from workflow.execution_outcomes where tenant_id=$1 and work_item_id=$2 order by recorded_at desc limit 1',[tenantId,workItemId])).rows[0];
    if(row && stableDigest(row.outcome)!==row.outcome_digest) throw new Error('workflow.outcome_corrupt');
    await c.query('commit'); return row?.outcome??null;
  } catch(e) {await c.query('rollback');throw e;} finally {c.release();}
}
