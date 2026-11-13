/**
 * Local preparation for the agentic KYC and KYB flows (delivery plan wave 1): admit both compiled
 * plans and register the skill library's bundle lock in the artifact registry, so the library skill
 * host (compose profile `skills`) can serve their skills once the lock is approved.
 *
 *   DATABASE_URL=postgresql://...@localhost:5432/ehf_control pnpm agentic:prepare
 *
 * Local development approves the bundle automatically, under the `system:dev-auto-approval` actor
 * so the registry history shows it was not a person's review. Pass --no-approve to leave it
 * registered for another identity to approve (`POST /v1/registry/skill-bundles/{digest}/approve`,
 * `release.approve`), as a shared environment requires. Release candidates for the flows need
 * evaluation evidence (delivery plan wave 5), so none is registered here.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { harnessPlanV2Schema, type HarnessPlanV2 } from "../packages/contracts/src/index.js";
import { admitPlan, createDatabase } from "../packages/persistence/src/index.js";
import { autoApproveSkillBundle, registerSkillBundle } from "../packages/persistence/src/skill-bundles.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const url = process.env.DATABASE_URL;
if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname) || process.env.SECURITY_PROFILE === "production") {
  throw new Error("agentic.local_database_required");
}
const tenantId = process.env.LOCAL_DEFAULT_TENANT_ID ?? "tenant_demo";
const actor = "claude:agentic-flows";
const plans = ["kyc-agentic", "kyb-agentic", "kyc-edd-agentic", "kyb-edd-agentic", "kyb-sdd-agentic"].map((name) =>
  harnessPlanV2Schema.parse(JSON.parse(readFileSync(resolve(root, `artifacts/${name}.plan.json`), "utf8"))) as HarnessPlanV2);
const lock = JSON.parse(readFileSync(resolve(root, "apps/fincrime-host/src/financial_crime/resources/bundle.lock.json"), "utf8"));
// Every library binding of both plans must pin the lock being registered.
for (const plan of plans) {
  for (const binding of plan.skillBindings ?? []) {
    if (binding.bundleDigest && binding.bundleDigest !== lock.bundle_digest) throw new Error(`agentic.bundle_mismatch:${plan.metadata.name}:${binding.skillId}`);
  }
}
const db = createDatabase(url);
try {
  const admitted = [];
  for (const plan of plans) admitted.push({ plan: plan.metadata.name, planDigest: plan.planDigest, created: (await admitPlan(db, plan, tenantId)).created });
  const approve = !process.argv.includes("--no-approve");
  const bundle = approve ? await autoApproveSkillBundle(db, { tenantId, registeredBy: actor, lock }) : await registerSkillBundle(db, { tenantId, actor, lock });
  console.log(JSON.stringify({ tenantId, admitted, bundleDigest: lock.bundle_digest, bundleStatus: bundle.entry.status, bundleApprovedBy: bundle.entry.approvedBy ?? null,
    next: approve ? "run with GATEWAY_ADAPTERS=default,skills and the skills compose profile"
      : "approve the bundle as another identity, then run with GATEWAY_ADAPTERS=default,skills and the skills compose profile" }, null, 2));
} finally {
  await db.end();
}
