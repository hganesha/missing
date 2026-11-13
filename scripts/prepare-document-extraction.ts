/**
 * Local admission and review preparation. Deliberately never approves its own artifacts.
 * `--variant adjudicated` (default) or `--variant contract` (the LLM-only plan, kept for rollback); each variant has
 * its own plan, validation report and release candidate, and BFF_DOCUMENT_PLAN_DIGEST selects the one that runs.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { computeReleaseManifestDigest, stableDigest, type ReleaseManifest } from "../packages/contracts/src/index.js";
import { admitPlan, createDatabase } from "../packages/persistence/src/index.js";
import { registerReleaseManifest } from "../packages/persistence/src/governance.js";
import { registerSkillBundle } from "../packages/persistence/src/skill-bundles.js";
import { directorySource } from "../packages/compiler/src/index.js";
import { buildDocumentExtractionPlan, DOCUMENT_PLAN_PATHS } from "./document-extraction-plan.js";
import { writeFileAtomic } from './lib/write-atomic.mjs';
const root = fileURLToPath(new URL("../", import.meta.url));
const path = (name: string) => resolve(root, name);
const hashFile = (name: string) => createHash("sha256").update(readFileSync(path(name))).digest("hex");
const url = process.env.DATABASE_URL;
if (!url || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname) || process.env.SECURITY_PROFILE === "production") throw new Error("document.local_database_required");
const tenantId = process.env.LOCAL_DEFAULT_TENANT_ID ?? "tenant_demo";
const actor = "codex:document-integration";
const flag = process.argv.indexOf("--variant");
const variant = flag > 0 ? process.argv[flag + 1] : "adjudicated";
if (variant !== "adjudicated" && variant !== "contract") throw new Error("document.variant_unknown");
const artifact = (kind: "plan" | "validation" | "release") => DOCUMENT_PLAN_PATHS[variant].replace(".plan.json", `.${kind}.json`);
const { plan, document } = buildDocumentExtractionPlan(variant);
writeFileSync(path(artifact("plan")), document);
const report = JSON.parse(readFileSync(path(artifact("validation")), "utf8"));
if (report.status !== "passed" || report.productionQualified !== false || report.planDigest !== plan.planDigest) throw new Error("document.validation_report_required");
if (Object.entries(report.sourceDigests ?? {}).some(([name, expected]) => hashFile(name) !== expected)) throw new Error("document.validation_sources_changed");
const runtimeSources = Object.fromEntries([...directorySource(path("packages/runtime-core/src")).files].map(([name, data]) => [name, Buffer.from(data).toString("utf8")]));
const candidate: ReleaseManifest = {
  apiVersion: "harness.factory/release-manifest-v1", kind: "ReleaseManifest", releaseId: `document-extraction-${plan.planDigest.slice(0,12)}-${hashFile(artifact("validation")).slice(0,8)}`,
  manifestDigest: "0".repeat(64), planDigest: plan.planDigest, packageDigest: plan.packageDigest, policyBundleDigests: plan.policyBundles.map(bundle => bundle.bundleDigest),
  schemaSetDigest: plan.schemas.schemaSetDigest, agentDigests: [], skillDigests: (plan.skillBindings ?? []).map(binding => binding.manifestDigest),
  capabilityDigests: plan.capabilities.map(capability => stableDigest(capability)), modelProfileDigests: plan.modelProfiles.map(profile => profile.digest),
  executionProfileDigest: stableDigest(plan.execution), compilerDigest: plan.compiler.digest, runtimeDigest: stableDigest({ runtimeSources, integrationSources: report.sourceDigests ?? {} }),
  dependencyManifestDigest: plan.dependencyManifestDigest, evaluationAttestationDigest: hashFile(artifact("validation")), provenanceDigest: plan.buildProvenanceDigest,
  scope: { environment: "development", tenants: [tenantId], regions: ["US"], cohort: "document-extraction-local" }, createdAt: report.verifiedAt,
};
candidate.manifestDigest = computeReleaseManifestDigest(candidate);
writeFileSync(path(artifact("release")), JSON.stringify(candidate, null, 2) + "\n");
const db = createDatabase(url);
try {
  const admitted = await admitPlan(db, plan, tenantId);
  const release = await registerReleaseManifest(db, { tenantId, actor, manifest: candidate });
  const lock = JSON.parse(readFileSync(path("apps/fincrime-host/src/financial_crime/resources/bundle.lock.json"), "utf8"));
  const bundle = await registerSkillBundle(db, { tenantId, actor, lock });
  const envPath = path(".env.local");
  let local = existsSync(envPath) ? readFileSync(envPath, "utf8") : "# Local EHF document integration. Keep credentials in this ignored file.\n";
  const settings: Record<string,string> = { BFF_DOCUMENT_PLAN_DIGEST: plan.planDigest };
  if (!/^DATABASE_URL=/m.test(local)) settings.DATABASE_URL = url;
  if (!/^CASE_DATABASE_URL=/m.test(local)) settings.CASE_DATABASE_URL = process.env.CASE_DATABASE_URL ?? url;
  for (const [key, value] of Object.entries(settings)) {
    const entry = `${key}=${value}`;
    local = new RegExp(`^${key}=.*$`, "m").test(local) ? local.replace(new RegExp(`^${key}=.*$`, "m"), entry) : local.trimEnd() + "\n" + entry + "\n";
  }
  writeFileAtomic(envPath, local, { mode: 0o600 });
  console.log(JSON.stringify({ tenantId, variant, planDigest: plan.planDigest, admitted: admitted.created, releaseId: candidate.releaseId, releaseStatus: release.record.status, bundleStatus: bundle.entry.status, bindingFile: ".env.local" }, null, 2));
} finally { await db.end(); }
