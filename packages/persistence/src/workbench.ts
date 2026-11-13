import { randomUUID } from "node:crypto";
import {
  stableDigest,
  workspaceConfig,
  workspaceFilesSchema,
  type WorkbenchEvaluation,
  type WorkspaceRevision,
  type WorkspaceSummary,
} from "@ehf/contracts";
import type { Database } from "./index.js";

export class WorkbenchError extends Error {
  constructor(
    code: string,
    readonly status = 409,
  ) {
    super(code);
  }
}
type Row = Record<string, any>;
const summary = (row: Row): WorkspaceSummary => ({
  workspaceId: row.workspace_id,
  kind: row.kind,
  name: row.name,
  revision: row.revision,
  publishedRevision: row.published_revision,
  createdBy: row.created_by,
  updatedAt: row.updated_at.toISOString(),
});
const revision = (row: Row): WorkspaceRevision => ({
  workspaceId: row.workspace_id,
  revision: row.revision,
  digest: row.digest,
  files: row.files,
  config: row.config,
  message: row.message,
  actor: row.actor,
  createdAt: row.created_at.toISOString(),
});
const evaluation = (row: Row): WorkbenchEvaluation => ({
  evaluationId: row.evaluation_id,
  workspaceId: row.workspace_id,
  revision: row.revision,
  sourceDigest: row.source_digest,
  datasetDigest: row.dataset_digest,
  dataset: row.dataset,
  modelProfileId: row.model_profile_id,
  modelProfileDigest: row.model_profile_digest,
  modelProfileRevision: row.model_profile_revision,
  status: row.status,
  cases: row.cases,
  error: row.error,
  actor: row.actor,
  createdAt: row.created_at.toISOString(),
  completedAt: row.completed_at?.toISOString() ?? null,
  maxCostUsd: Number(row.max_cost_usd),
});

export async function listWorkspaces(
  db: Database,
  tenantId: string,
): Promise<WorkspaceSummary[]> {
  return (
    await db.query(
      "select * from harness_control.workspaces where tenant_id=$1 order by updated_at desc limit 200",
      [tenantId],
    )
  ).rows.map(summary);
}
export async function getWorkspace(
  db: Database,
  tenantId: string,
  id: string,
  requestedRevision?: number,
) {
  const head = (
    await db.query(
      "select * from harness_control.workspaces where tenant_id=$1 and workspace_id=$2",
      [tenantId, id],
    )
  ).rows[0];
  if (!head) throw new WorkbenchError("workbench.not_found", 404);
  const rows = await db.query(
    "select revision,digest,message,actor,created_at from harness_control.workspace_revisions where tenant_id=$1 and workspace_id=$2 order by revision desc",
    [tenantId, id],
  );
  const selected = (
    await db.query(
      "select * from harness_control.workspace_revisions where tenant_id=$1 and workspace_id=$2 and revision=$3",
      [tenantId, id, requestedRevision ?? head.revision],
    )
  ).rows[0];
  if (!selected) throw new WorkbenchError("workbench.revision_not_found", 404);
  const [reports, promotions] = await Promise.all([
    db.query(
      `select * from harness_control.workspace_evaluations where tenant_id=$1 and workspace_id=$2 and
       (evaluation_id in (select evaluation_id from harness_control.workspace_evaluations where tenant_id=$1 and workspace_id=$2 order by created_at desc limit 10)
        or evaluation_id in (select evaluation_id from harness_control.workspace_promotions where tenant_id=$1 and workspace_id=$2 and revision=$3)) order by created_at desc`,
      [tenantId, id, selected.revision],
    ),
    db.query(
      "select revision,operation,evaluation_id,actor,reason,occurred_at from harness_control.workspace_promotions where tenant_id=$1 and workspace_id=$2 order by occurred_at desc",
      [tenantId, id],
    ),
  ]);
  return {
    workspace: summary(head),
    source: revision(selected),
    history: rows.rows.map((row) => ({
      revision: row.revision,
      digest: row.digest,
      message: row.message,
      actor: row.actor,
      createdAt: row.created_at.toISOString(),
    })),
    evaluations: reports.rows.map(evaluation),
    promotions: promotions.rows.map((row) => ({
      revision: row.revision,
      operation: row.operation,
      evaluationId: row.evaluation_id,
      actor: row.actor,
      reason: row.reason,
      occurredAt: row.occurred_at.toISOString(),
    })),
  };
}
export async function saveWorkspace(
  db: Database,
  input: {
    tenantId: string;
    actor: string;
    id?: string;
    expectedRevision?: number;
    files: Record<string, string>;
    message: string;
  },
) {
  const files = workspaceFilesSchema.parse(input.files);
  const config = workspaceConfig(files);
  const digest = stableDigest(files);
  const id = input.id ?? `WS-${randomUUID()}`;
  const client = await db.connect();
  try {
    await client.query("begin");
    if (input.id) {
      const head = (
        await client.query(
          "select kind,revision from harness_control.workspaces where tenant_id=$1 and workspace_id=$2 for update",
          [input.tenantId, id],
        )
      ).rows[0];
      if (!head) throw new WorkbenchError("workbench.not_found", 404);
      if (head.revision !== input.expectedRevision)
        throw new WorkbenchError("workbench.revision_conflict");
      if (head.kind !== config.kind)
        throw new WorkbenchError("workbench.kind_immutable", 400);
      await client.query(
        "update harness_control.workspaces set name=$3,revision=revision+1,updated_at=now() where tenant_id=$1 and workspace_id=$2",
        [input.tenantId, id, config.name],
      );
    } else
      await client.query(
        "insert into harness_control.workspaces(tenant_id,workspace_id,kind,name,revision,created_by) values($1,$2,$3,$4,1,$5)",
        [input.tenantId, id, config.kind, config.name, input.actor],
      );
    const rev = (input.expectedRevision ?? 0) + 1;
    await client.query(
      `insert into harness_control.workspace_revisions(tenant_id,workspace_id,revision,digest,files,config,message,actor)
      values($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8)`,
      [
        input.tenantId,
        id,
        rev,
        digest,
        JSON.stringify(files),
        JSON.stringify(config),
        input.message,
        input.actor,
      ],
    );
    await client.query("commit");
    return await getWorkspace(
      client as unknown as Database,
      input.tenantId,
      id,
    );
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
export async function queueWorkspaceEvaluation(
  db: Database,
  input: {
    tenantId: string;
    actor: string;
    workspaceId: string;
    revision: number;
    dataset: WorkbenchEvaluation["dataset"];
    maxCostUsd: number;
    monthlyLimitUsd: number | null;
    modelProfileId: string | null;
    modelProfileDigest: string | null;
    modelProfileRevision: number | null;
  },
) {
  const view = await getWorkspace(
    db,
    input.tenantId,
    input.workspaceId,
    input.revision,
  );
  const id = `EVAL-${randomUUID()}`;
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [
      input.tenantId,
    ]);
    const pending = await client.query(
      "select count(*)::integer as count from harness_control.workspace_evaluations where tenant_id=$1 and status in ('queued','running')",
      [input.tenantId],
    );
    if (pending.rows[0].count >= 10)
      throw new WorkbenchError("workbench.queue_full", 429);
    if (input.modelProfileId && input.monthlyLimitUsd !== null) {
      if (!Number.isFinite(input.monthlyLimitUsd) || input.monthlyLimitUsd < 0)
        throw new WorkbenchError("workbench.monthly_budget_invalid", 503);
      if (input.maxCostUsd <= 0)
        throw new WorkbenchError("workbench.model_budget_required", 400);
      const period = new Date().toISOString().slice(0, 7) + "-01";
      await client.query(
        `insert into harness_control.monthly_metered_budgets(tenant_id,period_start,limit_usd) values($1,$2,$3)
        on conflict(tenant_id,period_start) do update set limit_usd=least(harness_control.monthly_metered_budgets.limit_usd,excluded.limit_usd),updated_at=now()`,
        [input.tenantId, period, input.monthlyLimitUsd],
      );
      const reservation = await client.query(
        "update harness_control.monthly_metered_budgets set reserved_usd=reserved_usd+$3,updated_at=now() where tenant_id=$1 and period_start=$2 and reserved_usd+$3<=limit_usd",
        [input.tenantId, period, input.maxCostUsd],
      );
      if (!reservation.rowCount)
        throw new WorkbenchError("workbench.monthly_budget_exhausted", 409);
    }
    const result = await client.query(
      `insert into harness_control.workspace_evaluations(tenant_id,evaluation_id,workspace_id,revision,source_digest,dataset_digest,dataset,
    model_profile_id,model_profile_digest,model_profile_revision,status,actor,max_cost_usd)
    values($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,'queued',$11,$12) returning *`,
      [
        input.tenantId,
        id,
        input.workspaceId,
        input.revision,
        view.source.digest,
        stableDigest(input.dataset),
        JSON.stringify(input.dataset),
        input.modelProfileId,
        input.modelProfileDigest,
        input.modelProfileRevision,
        input.actor,
        input.maxCostUsd,
      ],
    );
    await client.query("commit");
    return evaluation(result.rows[0]!);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
export async function claimWorkspaceEvaluation(
  db: Database,
  owner: string,
  tenantId: string,
) {
  // A worker lost during execution is failed explicitly. Never silently replay paid/model calls.
  await db.query(
    "update harness_control.workspace_evaluations set status='error',error='workbench.worker_lease_expired',completed_at=now() where tenant_id=$1 and status='running' and lease_until<now()",
    [tenantId],
  );
  const result = await db.query(
    `update harness_control.workspace_evaluations set status='running',owner=$1,lease_until=now()+interval '10 minutes'
    where (tenant_id,evaluation_id)=(select tenant_id,evaluation_id from harness_control.workspace_evaluations where tenant_id=$2 and status='queued' order by created_at for update skip locked limit 1) returning *`,
    [owner, tenantId],
  );
  const row = result.rows[0];
  return row
    ? { tenantId: row.tenant_id as string, report: evaluation(row) }
    : null;
}
export async function finishWorkspaceEvaluation(
  db: Database,
  input: {
    tenantId: string;
    id: string;
    owner: string;
    status: WorkbenchEvaluation["status"];
    cases: WorkbenchEvaluation["cases"];
    error: string | null;
  },
) {
  await db.query(
    `update harness_control.workspace_evaluations set status=case when cancellation_requested then 'cancelled' else $4 end,cases=$5::jsonb,error=$6,completed_at=now(),lease_until=null
    where tenant_id=$1 and evaluation_id=$2 and owner=$3 and status='running' and lease_until>now()`,
    [
      input.tenantId,
      input.id,
      input.owner,
      input.status,
      JSON.stringify(input.cases),
      input.error,
    ],
  );
}
export async function cancelWorkspaceEvaluation(
  db: Database,
  tenantId: string,
  id: string,
) {
  const result = await db.query(
    "update harness_control.workspace_evaluations set cancellation_requested=true,status=case when status='queued' then 'cancelled' else status end,completed_at=case when status='queued' then now() else completed_at end where tenant_id=$1 and evaluation_id=$2 and status in ('queued','running') returning evaluation_id",
    [tenantId, id],
  );
  if (!result.rowCount)
    throw new WorkbenchError("workbench.cancel_requires_active");
}
export async function promoteWorkspace(
  db: Database,
  input: {
    tenantId: string;
    id: string;
    revision: number;
    operation: "approve" | "publish";
    evaluationId: string;
    actor: string;
    reason: string;
  },
) {
  const client = await db.connect();
  try {
    await client.query("begin");
    const head = (
      await client.query(
        "select * from harness_control.workspaces where tenant_id=$1 and workspace_id=$2 for update",
        [input.tenantId, input.id],
      )
    ).rows[0];
    if (!head || head.revision !== input.revision)
      throw new WorkbenchError("workbench.revision_conflict");
    const evidence = (
      await client.query(
        `select e.source_digest from harness_control.workspace_evaluations e join harness_control.workspace_revisions r
      on r.tenant_id=e.tenant_id and r.workspace_id=e.workspace_id and r.revision=e.revision
      where e.tenant_id=$1 and e.workspace_id=$2 and e.revision=$3 and e.evaluation_id=$4 and e.status='passed' and e.source_digest=r.digest`,
        [input.tenantId, input.id, input.revision, input.evaluationId],
      )
    ).rows[0];
    if (!evidence)
      throw new WorkbenchError("workbench.passing_evaluation_required");
    const authors = await client.query(
      "select 1 from harness_control.workspace_revisions where tenant_id=$1 and workspace_id=$2 and actor=$3 limit 1",
      [input.tenantId, input.id, input.actor],
    );
    if (authors.rowCount)
      throw new WorkbenchError("workbench.separation_of_duties", 403);
    const source = (
      await client.query(
        "select config from harness_control.workspace_revisions where tenant_id=$1 and workspace_id=$2 and revision=$3",
        [input.tenantId, input.id, input.revision],
      )
    ).rows[0];
    for (const pin of source.config.skillRefs ?? []) {
      const published = await client.query(
        `select 1 from harness_control.workspace_revisions r join harness_control.workspace_promotions p
        on p.tenant_id=r.tenant_id and p.workspace_id=r.workspace_id and p.revision=r.revision
        where r.tenant_id=$1 and r.workspace_id=$2 and r.digest=$3 and p.operation='publish'`,
        [input.tenantId, pin.id, pin.digest],
      );
      if (!published.rowCount)
        throw new WorkbenchError("workbench.published_skill_required");
    }
    if (input.operation === "publish") {
      const approved = await client.query(
        "select 1 from harness_control.workspace_promotions where tenant_id=$1 and workspace_id=$2 and revision=$3 and operation='approve' and evaluation_id=$4",
        [input.tenantId, input.id, input.revision, input.evaluationId],
      );
      if (!approved.rowCount)
        throw new WorkbenchError("workbench.approval_required");
      await client.query(
        "update harness_control.workspaces set published_revision=$3,updated_at=now() where tenant_id=$1 and workspace_id=$2",
        [input.tenantId, input.id, input.revision],
      );
    }
    await client.query(
      "insert into harness_control.workspace_promotions(tenant_id,workspace_id,revision,operation,evaluation_id,actor,reason) values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing",
      [
        input.tenantId,
        input.id,
        input.revision,
        input.operation,
        input.evaluationId,
        input.actor,
        input.reason,
      ],
    );
    await client.query("commit");
    return getWorkspace(db, input.tenantId, input.id);
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
