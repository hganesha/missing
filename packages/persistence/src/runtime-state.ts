import type {
  CheckpointMark,
  FencedRun,
  NodeFinished,
  NodeStarted,
  RuntimeStateEvent,
  RuntimeStateStore,
} from "@ehf/runtime-state";
import { appendEvent, updateRunNode, type Database } from "./index.js";

/**
 * Journal a run directly into PostgreSQL.
 *
 * Used by the control plane on behalf of a runtime, and by contract tests that exercise
 * the same behaviour without an HTTP hop. `updateRunNode` enforces the fence, so a write
 * from a superseded worker fails rather than overwriting the current one's progress.
 */
export function createPostgresRuntimeStateStore(db: Database): RuntimeStateStore {
  const append = async (run: FencedRun, input: RuntimeStateEvent): Promise<void> => {
    await appendEvent(db, {
      runId: run.runId,
      eventKey: input.eventKey,
      code: input.code,
      nodeId: input.nodeId,
      status: input.status,
      values: {
        ...input.values,
        correlation: { attempt: run.attempt, fencingEpoch: run.fencingEpoch },
      },
    });
  };
  return {
    async nodeStarted(run: FencedRun, input: NodeStarted): Promise<void> {
      await updateRunNode(db, {
        runId: run.runId, workerId: run.workerId, fencingEpoch: run.fencingEpoch, nodeId: input.nodeId,
      });
      await db.query(`
        insert into harness_runtime.node_attempts(
          run_id, node_id, attempt, fencing_epoch, status, input_digest, trace_id, span_id
        ) values ($1, $2, $3, $4, 'running', $5, $6, $7)
        on conflict (run_id, node_id, attempt) do nothing
      `, [run.runId, input.nodeId, run.attempt, run.fencingEpoch, input.inputDigest, input.traceId ?? null, input.spanId ?? null]);
      if (input.event) await append(run, input.event);
    },

    async nodeFinished(run: FencedRun, input: NodeFinished): Promise<void> {
      await db.query(`
        update harness_runtime.node_attempts
        set status = $4, output_digest = $5, error_code = $6, completed_at = now()
        where run_id = $1 and node_id = $2 and attempt = $3
      `, [run.runId, input.nodeId, run.attempt, input.status, input.outputDigest ?? null, input.errorCode ?? null]);
      if (input.event) await append(run, input.event);
    },

    appendEvent: append,

    async markCheckpoint(run: FencedRun, input: CheckpointMark): Promise<void> {
      await updateRunNode(db, {
        runId: run.runId,
        workerId: run.workerId,
        fencingEpoch: run.fencingEpoch,
        nodeId: input.nodeId,
        checkpointId: input.checkpointId,
      });
    },
  };
}
