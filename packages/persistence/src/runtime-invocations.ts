import { stableDigest, type RuntimeInvocationAnyVersion, type RuntimeInvocationResult } from "@ehf/contracts";
import { invocationRequestDigest, type InvocationRecord, type InvocationStore } from "@ehf/runtime-state";
import type { Database } from "./index.js";
import type { PoolClient } from "pg";

function map(row: Record<string, any>): InvocationRecord {
  if (row.result && stableDigest(row.result) !== row.result_digest) throw new Error("runtime_invocations.result_corrupt");
  return { invocationId: row.invocation_id, runId: row.run_id, requestDigest: row.request_digest,
    executionProfileDigest: row.execution_profile_digest, state: row.state,
    cancellationRequested: row.cancellation_requested, result: row.result };
}
export function postgresInvocationStore(db: Database, tenantId: string): InvocationStore {
  async function tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await db.connect();
    try { await c.query("begin"); await c.query("select set_config('app.tenant_id',$1,true)",[tenantId]);
      const value = await fn(c); await c.query("commit"); return value;
    } catch(e) { await c.query("rollback"); throw e; } finally { c.release(); }
  }
  return {
    claim: request => tx(async c => {
      const digest = invocationRequestDigest(request);
      const inserted = await c.query(`insert into harness_runtime.runtime_invocations
        (tenant_id,invocation_id,run_id,request_digest,execution_profile_digest,state)
        values ($1,$2,$3,$4,$5,'running') on conflict do nothing returning *`,
      [tenantId,request.invocationId,request.runId,digest,request.executionProfileDigest.replace(/^sha256:/,"")]);
      const selected = inserted.rows[0] ?? (await c.query("select * from harness_runtime.runtime_invocations where tenant_id=$1 and invocation_id=$2 for update",[tenantId,request.invocationId])).rows[0];
      if (!selected || selected.request_digest !== digest || selected.run_id !== request.runId) throw new Error("runtime_invocations.idempotency_conflict");
      return { created: inserted.rows.length === 1, record: map(selected) };
    }),
    read: id => tx(async c => {
      const row=(await c.query("select * from harness_runtime.runtime_invocations where tenant_id=$1 and invocation_id=$2",[tenantId,id])).rows[0];
      return row ? map(row) : null;
    }),
    cancel: id => tx(async c => {
      const r=await c.query("update harness_runtime.runtime_invocations set cancellation_requested=true where tenant_id=$1 and invocation_id=$2 and state='running' returning invocation_id",[tenantId,id]);
      return r.rows.length === 1;
    }),
    complete: (request,result) => tx(async c => {
      if (result.invocationId!==request.invocationId || result.runId!==request.runId) throw new Error("runtime_invocations.result_binding_invalid");
      const row=(await c.query("select * from harness_runtime.runtime_invocations where tenant_id=$1 and invocation_id=$2 for update",[tenantId,request.invocationId])).rows[0];
      if (!row || row.request_digest!==invocationRequestDigest(request)) throw new Error("runtime_invocations.idempotency_conflict");
      const digest=stableDigest(result);
      if (row.result_digest) { if(row.result_digest!==digest) throw new Error("runtime_invocations.terminal_conflict"); return; }
      // A cancellation request is not proof an effect stopped; completed results remain completed.
      const state=result.status==='completed'?'completed':result.errorCode==='runtime.cancelled'?'cancelled':'failed';
      await c.query("update harness_runtime.runtime_invocations set state=$3,result=$4::jsonb,result_digest=$5,completed_at=clock_timestamp() where tenant_id=$1 and invocation_id=$2",
        [tenantId,request.invocationId,state,JSON.stringify(result),digest]);
    }),
  };
}
