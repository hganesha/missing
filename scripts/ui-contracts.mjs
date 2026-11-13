#!/usr/bin/env node
// CI gate for the UI contract pack (BUILD-SPEC v2 §11.2, ALIGNMENT §8).
//
// 1. check_sources.py against this repo: fails on drift that is not acknowledged in
//    packages/ui-contracts/drift-acknowledged.json.
// 2. validate_contracts.py against the EHF code the pack was generated from: the pinned
//    ehfconcept commit, checked out into a temporary worktree (UI_CONTRACTS_EHF_ROOT overrides).
//    Current route modules supplement that pin for newly implemented endpoints.
// 3. redocly lint of the OpenAPI document.
// 4. ui:sync --check: vendor/ and generated/ are current.

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkSources } from "./lib/ui-drift.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsUi = resolve(repo, process.env.KYC_DOCS_UI ?? "apps/fincrime-host/docs/ui");
const kycRoot = resolve(repo, process.env.KYC_ROOT ?? "apps/fincrime-host");
const git = (...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
let failed = false;

// 1. Drift
const drift = checkSources({ docsUi, kycRoot, ehfRoot: repo, acknowledgedPath: join(repo, "packages/ui-contracts/drift-acknowledged.json") });
if (drift.unacknowledged.length) {
  console.error(drift.text());
  console.error(`ui:contracts: unacknowledged drift in ${drift.unacknowledged.join(", ")}`);
  failed = true;
} else {
  for (const entry of drift.acknowledged) console.log(`drift acknowledged · ${entry.group} · ${entry.gap}`);
  console.log("ui:contracts: no unacknowledged drift");
}

// 2. Contract validation against the pinned EHF commit
const lock = JSON.parse(readFileSync(join(docsUi, "contracts/SOURCES.lock.json"), "utf8"));
const pinned = lock.repos?.ehfconcept?.commit;
let ehfRoot = process.env.UI_CONTRACTS_EHF_ROOT ? resolve(process.env.UI_CONTRACTS_EHF_ROOT) : null;
let worktree = null;
if (!ehfRoot) {
  if (git("cat-file", "-e", `${pinned}^{commit}`).status !== 0) git("fetch", "--quiet", "--depth=1", "origin", pinned);
  worktree = mkdtempSync(join(tmpdir(), "ehf-pinned-"));
  const added = git("worktree", "add", "--detach", "--quiet", worktree, pinned);
  if (added.status !== 0) {
    console.error(`ui:contracts: cannot check out pinned ehfconcept ${pinned}\n${added.stderr}`);
    process.exit(1);
  }
  ehfRoot = worktree;
}
console.log(`ui:contracts: validating against ehfconcept ${worktree ? pinned.slice(0, 7) : ehfRoot}`);
const validation = spawnSync("python3", [join(docsUi, "contracts/tools/validate_contracts.py"), "--ehf-root", ehfRoot, "--current-ehf-root", repo], { encoding: "utf8", stdio: "inherit" });
if (validation.status !== 0) failed = true;
if (worktree) {
  git("worktree", "remove", "--force", worktree);
  if (existsSync(worktree)) rmSync(worktree, { recursive: true, force: true });
}

// 3. OpenAPI structure (validate_contracts.py relies on redocly lint for this)
const lint = spawnSync(join(repo, "packages/ui-contracts/node_modules/.bin/redocly"), [
  "lint", join(docsUi, "contracts/experience-api.openapi.yaml"), "--config", join(docsUi, "contracts/redocly.yaml"), "--format", "summary",
], { encoding: "utf8", env: { ...process.env, REDOCLY_TELEMETRY: "off", REDOCLY_SUPPRESS_UPDATE_NOTICE: "true" } });
if (lint.status !== 0) {
  console.error(lint.stdout, lint.stderr);
  failed = true;
} else console.log("ui:contracts: redocly lint clean");

// 4. Generated files current
const check = spawnSync(process.execPath, [join(repo, "scripts/ui-sync.mjs"), "--check"], { encoding: "utf8", stdio: "inherit" });
if (check.status !== 0) failed = true;

process.exit(failed ? 1 : 0);
