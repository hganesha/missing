import type { PoolClient } from "pg";
import {
  canonicalMappingSchema,
  contextCaseBindingSchema,
  BANK_CONTEXT_RECORD_TYPES,
} from "@ehf/contracts/context-setup";
import {
  stableDigest,
  type BusinessCommand,
  type CaseSnapshot,
} from "@ehf/contracts";
import {
  CaseStoreError,
  type CaseExecutionAuthority,
  type CaseStore,
} from "./index.js";
export type ContextPullScope = {
  planDigest: string;
  nodeId: string;
  subjects: string[];
  objectTypes: string[];
  connectorId: string;
};
const denied = (): never => {
  throw new CaseStoreError("context.pull_execution_not_authorized", 403);
};
/** The execution principal can ask this narrow function; it cannot read the control tables. */
export async function contextPullRunScope(
  store: CaseStore,
  authority: CaseExecutionAuthority,
  executionReader: Pick<PoolClient, "query"> = store.executionDb ?? store.db,
): Promise<ContextPullScope | null> {
  if (!authority.case_id) return null;
  const result = await executionReader.query(
    "select * from harness_runtime.context_pull_run($1,$2,$3,$4)",
    [
      authority.tenant_id,
      authority.case_id,
      authority.run_id,
      authority.plan_digest,
    ],
  );
  const row = result.rows[0];
  if (!row) return null;
  const b = contextCaseBindingSchema.parse(row.binding),
    m = canonicalMappingSchema.parse(row.mapping);
  const input = row.input as {
    canonicalSubjects?: unknown;
    subjects?: unknown;
    contextPullNodeId?: unknown;
  };
  if (
    !Array.isArray(input.canonicalSubjects) ||
    !input.canonicalSubjects.length ||
    !Array.isArray(input.subjects) ||
    new Set(input.canonicalSubjects).size !== input.canonicalSubjects.length ||
    input.canonicalSubjects.some(
      (id: unknown) =>
        typeof id !== "string" || !b.subjects.some((s) => s.subjectId === id),
    ) ||
    stableDigest(
      b.subjects
        .filter((s) =>
          (input.canonicalSubjects as unknown[]).includes(s.subjectId),
        )
        .map((s) => s.sourceKey),
    ) !== stableDigest(input.subjects) ||
    input.contextPullNodeId !== authority.node_id ||
    b.nodeId !== authority.node_id ||
    !row.connector_id?.startsWith("context-") ||
    m.outputs.some((o) => !BANK_CONTEXT_RECORD_TYPES.has(o.objectType))
  )
    return denied();
  return {
    planDigest: authority.plan_digest,
    nodeId: b.nodeId,
    subjects: input.canonicalSubjects as string[],
    objectTypes: m.outputs.map((o) => o.objectType),
    connectorId: row.connector_id,
  };
}
export function assertContextPullCommands(
  scope: ContextPullScope,
  commands: BusinessCommand[],
) {
  for (const command of commands) {
    if (
      command.commandType !== "RecordCanonicalRecords" ||
      !Array.isArray(command.payload.records) ||
      !command.payload.records.length
    )
      return denied();
    for (const raw of command.payload.records) {
      const r = raw as {
        object_type?: unknown;
        tenant_id?: unknown;
        case_id?: unknown;
        subject_ids?: unknown;
        provenance?: { method?: unknown; connector_id?: unknown };
      };
      if (
        typeof r.object_type !== "string" ||
        !scope.objectTypes.includes(r.object_type) ||
        !BANK_CONTEXT_RECORD_TYPES.has(r.object_type) ||
        !Array.isArray(r.subject_ids) ||
        !r.subject_ids.length ||
        r.subject_ids.some((id) => !scope.subjects.includes(id)) ||
        r.provenance?.method !== "connector_normalizer" ||
        r.provenance.connector_id !== scope.connectorId ||
        r.tenant_id !== command.tenantId ||
        r.case_id !== command.caseId
      )
        return denied();
    }
  }
}
/** Pulls read only case metadata needed for command authority; never the case's business record corpus. */
export function scopeContextPullSnapshot(
  snapshot: CaseSnapshot,
  scope: ContextPullScope,
): CaseSnapshot {
  const {
    snapshotId: _id,
    snapshotDigest: _digest,
    capturedAt,
    ...basis
  } = snapshot;
  const scoped = {
    ...basis,
    planDigest: scope.planDigest,
    data: { case: snapshot.data.case },
  };
  const digest = stableDigest(scoped);
  return {
    ...scoped,
    capturedAt,
    snapshotId: `snapshot_${digest}`,
    snapshotDigest: digest,
  };
}
