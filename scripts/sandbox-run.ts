/**
 * Local sandbox run of an agentic flow on a synthetic test party, from the command line: the same
 * path as the draft editor's "Run in sandbox" (apps/control-api/src/sandbox-run.ts), for the
 * flow's compiled plan in artifacts/ rather than a saved draft.
 *
 *   DATABASE_URL=postgresql://...@localhost:5432/ehf_control \
 *   SANDBOX_EDGE_TOKEN=<the stack's EDGE_SERVICE_TOKEN> \
 *     node --import tsx scripts/sandbox-run.ts --flow kyc-agentic --party H01 [--case-api http://127.0.0.1:4102]
 *
 * It admits the plan, puts it and its compiled policy in effect as a sandbox release approved by
 * `system:sandbox-auto-approval` (never a person's review), loads the party as a new case pinned to
 * that plan and its policy pack, and starts a run on it. A sandbox release is not a governed
 * release: it carries no evaluation attestation, it may decide under a policy that still has
 * release blockers, and it is refused under the production profile.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessPlanV2Schema, type HarnessPlanV2 } from "../packages/contracts/src/index.js";
import { createDatabase } from "../packages/persistence/src/index.js";
import { seedParty } from "../packages/context-corpus/src/seed.js";
import { sandboxDocumentLoader, startSandboxRun } from "../apps/control-api/src/sandbox-run.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : fallback; };
const flow = arg("flow", "kyc-agentic")!;
const party = arg("party", "H01")!;
const caseApi = arg("case-api", process.env.CASE_API_URL ?? "http://127.0.0.1:4102")!;
const url = process.env.DATABASE_URL;
if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname) || process.env.SECURITY_PROFILE === "production") {
  throw new Error("sandbox.local_database_required");
}
const token = process.env.SANDBOX_EDGE_TOKEN;
if (!token) throw new Error("sandbox.edge_token_required");
const tenantId = process.env.LOCAL_DEFAULT_TENANT_ID ?? "tenant_demo";

const loadDocument = sandboxDocumentLoader(process.env);
const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(resolve(root, `artifacts/${flow}.plan.json`), "utf8"))) as HarnessPlanV2;
const db = createDatabase(url);
try {
  const result = await startSandboxRun({
    db, env: process.env, tenantId, actor: "sandbox:local-runner", plan, party,
    policyFiles: { "policy.yaml": readFileSync(resolve(root, `domains/${flow}/policy.yaml`), "utf8") },
    corpusRoot: resolve(root, "fixtures/context-corpus"), opaVersion: process.env.OPA_VERSION ?? "1.9.0",
    seed: (dossier, pins) => seedParty(dossier, { ...pins, baseUrl: caseApi, token }),
    // The party's source documents go to the evidence pipeline when it is reachable from here
    // (EVIDENCE_PIPELINE_URL and EVIDENCE_PIPELINE_TOKEN); compose does not publish its port.
    ...(loadDocument ? { loadDocument } : {}),
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await db.end();
}
