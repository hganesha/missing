import pg from "pg";
import { stableDigest } from "@ehf/contracts";
import { createCaseStore } from "./index.js";
import { createDiscoveryDatabase, syntheticDiscoveryEnabled } from "./discovery.js";
import { collectHostedDiscoveryRun, prepareHostedDiscoveryRun } from "./discovery-observer.js";

const [command, tenantId, caseId, runId, advisoryRunId, ...extra] = process.argv.slice(2);
if (!tenantId || !caseId || !runId || extra.length
  || !((command === "prepare" && !advisoryRunId) || (command === "collect" && advisoryRunId))) {
  throw new Error("Usage: pnpm --filter @ehf/case-store discovery:hosted prepare|collect <tenantId> <caseId> <parentRunId> [advisoryRunId]");
}
if (!syntheticDiscoveryEnabled(process.env)) throw new Error("discovery.synthetic_disabled");
const connectionString = process.env.DISCOVERY_CONTROL_DATABASE_URL;
const planDigest = process.env.DISCOVERY_HOSTED_PLAN_DIGEST;
if (!connectionString || !planDigest) throw new Error("discovery.hosted_configuration_missing");

const discovery = advisoryRunId ? createDiscoveryDatabase() : undefined;
const store = createCaseStore();
const control = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
const scope = { tenantId, caseId, runId };
try {
  if (advisoryRunId && discovery) {
    const { brief, replayed } = await collectHostedDiscoveryRun(store, discovery, control, scope, planDigest, advisoryRunId);
    process.stdout.write(JSON.stringify({ briefId: brief.briefId, status: brief.status, leadCount: brief.signals.length, replayed }) + "\n");
  } else {
    const body = await prepareHostedDiscoveryRun(store, control, scope, planDigest);
    process.stdout.write(JSON.stringify({ idempotencyKey: `recon-${stableDigest(body)}`, body }) + "\n");
  }
} finally {
  await Promise.all([control.end(), discovery?.end(), store.db.end(), store.executionDb?.end()]);
}
