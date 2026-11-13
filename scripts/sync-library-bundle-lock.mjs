#!/usr/bin/env node
// Generates the skill library host's bundle lock (skill.execution.v1 §8, CR-7) from the in-repository
// library catalog with the platform's own rule (`librarySkillBundleLock`, @ehf/contracts):
//
//   node scripts/sync-library-bundle-lock.mjs [--check]
//
// Output: apps/fincrime-host/src/financial_crime/resources/bundle.lock.json, served by the library's
// host (`python -m financial_crime.runtimes.skill_host`) at GET /v1/bundle. The host refuses to start
// when the lock does not match its installed catalog and code. Image and SBOM digests are stand-ins
// derived from the bundle digest: a published image's real digests belong in the artifact registry
// entry the operator approves, not in this file.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { writeFileAtomic } from './lib/write-atomic.mjs';
const { librarySkillBundleLock } = await tsImport("../packages/contracts/src/index.ts", import.meta.url);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const catalogPath = resolve(repoRoot, "apps/fincrime-host/catalog/catalog.json");
const out = resolve(repoRoot, "apps/fincrime-host/src/financial_crime/resources/bundle.lock.json");

const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const standIn = (kind) => `sha256:${createHash("sha256").update(`financial-crime-skills:${kind}:${catalog.bundle_code_hash}`).digest("hex")}`;
const lock = librarySkillBundleLock(catalog, { imageDigest: standIn("image"), sbomDigest: standIn("sbom") });
const content = `${JSON.stringify({ ...lock, python: "3.13" }, null, 2)}\n`;

const current = existsSync(out) ? readFileSync(out, "utf8") : null;
if (current === content) {
  process.stdout.write(`library bundle lock is current (${lock.skills.length} skills, ${lock.bundle_digest})\n`);
} else if (check) {
  process.stderr.write("library bundle lock is stale; run node scripts/sync-library-bundle-lock.mjs\n");
  process.exit(1);
} else {
  writeFileAtomic(out, content);
  process.stdout.write(`wrote ${out.slice(repoRoot.length + 1)}: ${lock.skills.length} skills, ${lock.bundle_digest}\n`);
}
