import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { prepareHostedDiscovery, publishHostedDiscovery, recordSyntheticDiscovery, syntheticDiscoveryEnabled, type DiscoveryIntakeScope } from "./discovery.js";
import type { DiscoveryCaseReader } from "./discovery.js";
import { CaseStoreError, type CaseStoreDatabase } from "./index.js";

const id = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const readySchema = z.object({
  state: z.literal("ready"), work_item_id: id, decision_id: id, receipt_digest: digest, plan_digest: digest,
}).strict();

type ObserverScope = { tenantId: string; caseId: string; runId: string };
type Observation =
  | { state: "pending" }
  | { state: "ineligible"; reason: string }
  | { state: "published"; briefId: string; replayed: boolean };

export async function readDiscoveryIntake(
  control: Pick<CaseStoreDatabase, "query">, scope: ObserverScope,
): Promise<{ state: "pending" | "ineligible" } | { state: "ready"; intake: DiscoveryIntakeScope }> {
  const { tenantId, caseId, runId } = scope;
  const { rows } = await control.query<{ state: string }>(
    "select * from harness_runtime.discovery_intake_settlement($1,$2,$3)", [tenantId, caseId, runId],
  );
  if (!rows.length) return { state: "pending" };
  if (rows[0]?.state === "ineligible") return { state: "ineligible" };
  const ready = readySchema.parse(rows[0]);
  return { state: "ready", intake: {
    tenantId, caseId, intakeDecisionId: ready.decision_id,
    settlement: { runId, workItemId: ready.work_item_id, planDigest: ready.plan_digest, receiptDigest: ready.receipt_digest },
  } };
}

export async function observeSyntheticIntake(
  store: DiscoveryCaseReader, discovery: CaseStoreDatabase, control: Pick<CaseStoreDatabase, "query">, scope: ObserverScope, env: NodeJS.ProcessEnv = process.env,
): Promise<Observation> {
  if (!syntheticDiscoveryEnabled(env)) throw new CaseStoreError("discovery.synthetic_disabled", 403);
  const found = await readDiscoveryIntake(control, scope);
  if (found.state === "pending") return { state: "pending" };
  if (found.state !== "ready") return { state: "ineligible", reason: "discovery.intake_settlement_ineligible" };
  try {
    const { brief, replayed } = await recordSyntheticDiscovery(store, discovery, found.intake, env);
    return { state: "published", briefId: brief.briefId, replayed };
  } catch (error) {
    if (error instanceof CaseStoreError && (error.httpStatus === 404 || error.httpStatus === 409)) {
      return { state: "ineligible", reason: error.code };
    }
    throw error;
  }
}

export async function watchSyntheticIntake(
  store: DiscoveryCaseReader, discovery: CaseStoreDatabase, control: Pick<CaseStoreDatabase, "query">, scope: ObserverScope,
  options: { signal: AbortSignal; pollMs: number; env?: NodeJS.ProcessEnv },
): Promise<Exclude<Observation, { state: "pending" }>> {
  for (;;) {
    options.signal.throwIfAborted();
    const result = await observeSyntheticIntake(store, discovery, control, scope, options.env);
    if (result.state !== "pending") return result;
    await delay(options.pollMs, undefined, { signal: options.signal });
  }
}


async function hostedRequest(
  store: DiscoveryCaseReader, control: Pick<CaseStoreDatabase, "query">, scope: ObserverScope, planDigest: string, env: NodeJS.ProcessEnv,
) {
  if (!syntheticDiscoveryEnabled(env)) throw new CaseStoreError("discovery.synthetic_disabled", 403);
  const pinned = digest.parse(planDigest);
  const found = await readDiscoveryIntake(control, scope);
  if (found.state !== "ready") throw new CaseStoreError(`discovery.intake_settlement_${found.state}`, 409);
  const input = await prepareHostedDiscovery(store, found.intake, env);
  return { request: { planDigest: pinned, input }, intake: found.intake };
}

export async function prepareHostedDiscoveryRun(
  store: DiscoveryCaseReader, control: Pick<CaseStoreDatabase, "query">, scope: ObserverScope, planDigest: string, env: NodeJS.ProcessEnv = process.env,
) {
  const { request } = await hostedRequest(store, control, scope, planDigest, env);
  return request;
}

export async function collectHostedDiscoveryRun(
  store: DiscoveryCaseReader, discovery: CaseStoreDatabase, control: Pick<CaseStoreDatabase, "query">, scope: ObserverScope,
  planDigest: string, advisoryRunId: string, env: NodeJS.ProcessEnv = process.env,
) {
  const { request, intake } = await hostedRequest(store, control, scope, planDigest, env);
  const { rows } = await control.query<{ output: unknown }>(
    "select harness_runtime.discovery_advisory_result($1,$2,$3,$4::jsonb) as output",
    [scope.tenantId, id.parse(advisoryRunId), request.planDigest, JSON.stringify(request.input)],
  );
  const output = rows[0]?.output;
  if (!output) throw new CaseStoreError("discovery.advisory_result_unavailable", 409);
  return publishHostedDiscovery(store, discovery, intake, { runId: advisoryRunId, planDigest: request.planDigest, output }, env);
}
