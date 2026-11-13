import pg from "pg";
import { createCaseStore } from "./index.js";
import { createDiscoveryDatabase, syntheticDiscoveryEnabled } from "./discovery.js";
import { watchSyntheticIntake } from "./discovery-observer.js";

const [tenantId, caseId, runId, ...extra] = process.argv.slice(2);
if (!tenantId || !caseId || !runId || extra.length) {
  throw new Error("Usage: pnpm --filter @ehf/case-store discovery:watch <tenantId> <caseId> <runId>");
}
if (!syntheticDiscoveryEnabled(process.env)) throw new Error("discovery.synthetic_disabled");
const connectionString = process.env.DISCOVERY_CONTROL_DATABASE_URL;
if (!connectionString) throw new Error("discovery.control_database_url_missing");
const timeoutMs = Number(process.env.DISCOVERY_WATCH_TIMEOUT_MS ?? 600_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
  throw new Error("discovery.watch_timeout_invalid");
}

const store = createCaseStore();
const discovery = createDiscoveryDatabase();
const control = new pg.Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
const timeout = AbortSignal.timeout(timeoutMs);
try {
  const result = await watchSyntheticIntake(store, discovery, control, { tenantId, caseId, runId }, {
    signal: AbortSignal.any([controller.signal, timeout]), pollMs: 1_000,
  });
  process.stdout.write(JSON.stringify(result) + "\n");
} catch (error) {
  if (!controller.signal.aborted && !timeout.aborted) throw error;
  process.stdout.write(JSON.stringify({ state: timeout.aborted ? "timed_out" : "stopped" }) + "\n");
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await Promise.all([control.end(), discovery.end(), store.db.end(), store.executionDb?.end()]);
}
