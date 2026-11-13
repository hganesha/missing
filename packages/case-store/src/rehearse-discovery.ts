import { createCaseStore } from "./index.js";
import { createDiscoveryDatabase, recordSyntheticDiscovery, syntheticDiscoveryEnabled } from "./discovery.js";

const [tenantId, caseId, intakeDecisionId, ...extra] = process.argv.slice(2);
if (!tenantId || !caseId || !intakeDecisionId || extra.length) {
  throw new Error("Usage: pnpm --filter @ehf/case-store discovery:rehearse <tenantId> <caseId> <intakeDecisionId>");
}
if (!syntheticDiscoveryEnabled(process.env)) throw new Error("discovery.synthetic_disabled");

const store = createCaseStore();
const discovery = createDiscoveryDatabase();
try {
  const { brief, replayed } = await recordSyntheticDiscovery(store, discovery, { tenantId, caseId, intakeDecisionId });
  process.stdout.write(JSON.stringify({ briefId: brief.briefId, status: brief.status, leadCount: brief.signals.length, replayed }) + "\n");
} finally {
  await Promise.all([discovery.end(), store.db.end(), store.executionDb?.end()]);
}
