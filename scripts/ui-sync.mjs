#!/usr/bin/env node
// Sync the UI contract pack into @ehf/ui-contracts and generate types (BUILD-SPEC v2 §4.1).
//
//   node scripts/ui-sync.mjs            sync, then generate
//   node scripts/ui-sync.mjs --check    exit 1 when vendor/ or generated/ is stale (CI)
//   node scripts/ui-sync.mjs --if-stale sync only when the sources changed (used by dev)
//
// Sources: the pack lives in apps/fincrime-host/docs/ui (KYC_DOCS_UI overrides it) and the kyc files it
// $refs (schemas, catalog, tasks, profiles) live in apps/fincrime-host (KYC_ROOT overrides it).
// Drift reported by check_sources.py aborts the sync, unless every drifting group is
// acknowledged in packages/ui-contracts/drift-acknowledged.json with a CONTRACT-GAPS id.

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkSources } from "./lib/ui-drift.mjs";
import { writeFileAtomic } from './lib/write-atomic.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsUi = resolve(repo, process.env.KYC_DOCS_UI ?? "apps/fincrime-host/docs/ui");
const kycRoot = resolve(repo, process.env.KYC_ROOT ?? "apps/fincrime-host");
const pkg = join(repo, "packages/ui-contracts");
const vendor = join(pkg, "vendor");
const generated = join(pkg, "src/generated");
const tokensPkg = join(repo, "packages/ui-tokens");
const bin = (name) => join(pkg, "node_modules/.bin", name);
const args = new Set(process.argv.slice(2));

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8", env: { ...process.env, REDOCLY_TELEMETRY: "off", REDOCLY_SUPPRESS_UPDATE_NOTICE: "true" }, ...options });
  if (result.error) throw result.error;
  return result;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

/** Digest of every input the sync reads, so dev can skip it when nothing changed. */
function sourceDigest() {
  const hash = createHash("sha256");
  const inputs = [
    ...walk(docsUi).filter((path) => !path.includes(`${join("docs", "ui", "mockups")}`)),
    ...["schemas", "catalog", "tasks", "profiles"].flatMap((dir) => (existsSync(join(kycRoot, dir)) ? walk(join(kycRoot, dir)) : [])),
    join(pkg, "drift-acknowledged.json"),
    join(repo, "config/provider-priorities.json"),
    join(repo, "config/capability-collections.json"),
    join(repo, "scripts/lib/capability-discovery.mjs"),
    join(repo, "scripts/catalog-snapshot.mjs"),
    fileURLToPath(import.meta.url),
  ].filter(existsSync).toSorted();
  for (const path of inputs) hash.update(relative(repo, path)).update(sha256(path));
  return hash.digest("hex");
}

// Context source request schemas are generated from the platform's typed contracts.
const contextExport = run(process.execPath, ["--import", "tsx", join(docsUi, "contracts/tools/export_context_contracts.mts"), ...(args.has("--check") ? ["--check"] : [])]);
if (contextExport.status !== 0) throw new Error(contextExport.stderr || "Context source contract export failed");

const workbenchExport=run(process.execPath,["--import","tsx",join(docsUi,"contracts/tools/export_workbench_contracts.mts"),...(args.has("--check")?["--check"]:[])]);
if(workbenchExport.status!==0)throw new Error(workbenchExport.stderr||"Workbench schema export failed");

// ---- 1. drift gate --------------------------------------------------------------------
function driftGate() {
  const result = checkSources({ docsUi, kycRoot, ehfRoot: repo, acknowledgedPath: join(pkg, "drift-acknowledged.json") });
  if (result.unacknowledged.length) {
    console.error(result.text());
    throw new Error(`Contract drift in ${result.unacknowledged.join(", ")}. Re-pin the pack (ALIGNMENT §8) or acknowledge the group in packages/ui-contracts/drift-acknowledged.json with a CONTRACT-GAPS id.`);
  }
  for (const entry of result.acknowledged) console.warn(`ui:sync: drift in ${entry.group} acknowledged (${entry.gap}: ${entry.reason})`);
  return { drifting: result.drifting, acknowledged: result.acknowledged };
}

// ---- 2. vendor ------------------------------------------------------------------------
function vendorCopy() {
  rmSync(vendor, { recursive: true, force: true });
  // Keep kyc-relative layout so the pack's ../../../schemas $refs resolve.
  cpSync(join(docsUi, "contracts"), join(vendor, "docs/ui/contracts"), { recursive: true });
  cpSync(join(kycRoot, "schemas"), join(vendor, "schemas"), { recursive: true });
  for (const file of ["ehf-catalog.json", "context-matrix.json", "context-products.json", "release-lock.json"]) {
    cpSync(join(kycRoot, "catalog", file), join(vendor, "catalog", file));
  }
  for (const dir of ["tasks", "profiles"]) {
    for (const name of readdirSync(join(kycRoot, dir)).filter((file) => file.endsWith(".json") && (dir !== "profiles" || file.startsWith("agent.")))) {
      cpSync(join(kycRoot, dir, name), join(vendor, dir, name));
    }
  }
}

// ---- 3–5. bundle, types, operations ---------------------------------------------------
function generate() {
  const bundle = run(bin("redocly"), ["bundle", join(vendor, "docs/ui/contracts/experience-api.openapi.yaml"), "-o", join(vendor, "bundle.json"), "--ext", "json"]);
  if (bundle.status !== 0) throw new Error(`redocly bundle failed\n${bundle.stdout}\n${bundle.stderr}`);
  mkdirSync(generated, { recursive: true });
  const types = run(bin("openapi-typescript"), [join(vendor, "bundle.json"), "-o", join(generated, "api.d.ts")]);
  if (types.status !== 0) throw new Error(`openapi-typescript failed\n${types.stdout}\n${types.stderr}`);

  const spec = JSON.parse(readFileSync(join(vendor, "bundle.json"), "utf8"));
  const operations = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of ["get", "put", "post", "patch", "delete"]) {
      const op = item[method];
      if (!op) continue;
      const security = op.security ?? spec.security ?? [];
      operations.push({
        operationId: op.operationId,
        method: method.toUpperCase(),
        path,
        tag: op.tags?.[0] ?? null,
        xScreens: op["x-screens"] ?? [],
        xUpstream: op["x-upstream"] ?? null,
        xAction: op["x-action"] ?? null,
        xPoll: op["x-poll"] ?? null,
        xOwner: op["x-owner"] ?? null,
        xStatus: op["x-status"] ?? null,
        mockOnly: op["x-mock-only"] === true,
        csrf: security.some((requirement) => "csrf" in requirement),
        public: security.length === 0 || security.some((requirement) => Object.keys(requirement).length === 0),
      });
    }
  }
  operations.sort((a, b) => a.operationId.localeCompare(b.operationId));
  writeFileSync(join(generated, "operations.ts"), [
    "// Generated by scripts/ui-sync.mjs from experience-api.openapi.yaml. Do not edit.",
    'import type { OperationMeta } from "../operation-meta.js";',
    "",
    `export const OPERATIONS = ${JSON.stringify(operations, null, 2)} as const satisfies readonly OperationMeta[];`,
    "",
    "export type OperationId = (typeof OPERATIONS)[number][\"operationId\"];",
    "",
  ].join("\n"));
  return operations.length;
}

// ---- 6. tokens and fonts --------------------------------------------------------------
function tokens() {
  const target = join(tokensPkg, "vendor");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(join(docsUi, "tokens.json"), join(target, "tokens.json"));
  cpSync(join(docsUi, "assets/fonts"), join(target, "fonts"), { recursive: true });
  cpSync(join(docsUi, "assets/tokens.css"), join(target, "reference-tokens.css"));
  cpSync(join(docsUi, "assets/shell.js"), join(target, "reference-shell.js"));
}

// ---- main -----------------------------------------------------------------------------
const syncFile = join(vendor, "SYNC.json");
for (const [command, commandArgs] of [
  [process.execPath, [join(repo, 'scripts/catalog-snapshot.mjs'), ...(args.has('--check') ? ['--check'] : [])]],
  ['python3', [join(repo, 'scripts/ui-catalog-fixtures.py'), ...(args.has('--check') ? ['--check'] : [])]],
  [process.execPath, [join(repo, 'scripts/generate-ui-presentation.mjs'), ...(args.has('--check') ? ['--check'] : [])]],
  [process.execPath, [join(repo, 'scripts/sync-visual-story.mjs'), ...(args.has('--check') ? ['--check'] : [])]],
]) {
  const result = run(command, commandArgs);
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}
const digest = sourceDigest();
const previous = existsSync(syncFile) ? JSON.parse(readFileSync(syncFile, "utf8")) : null;
const fresh = previous?.sourceDigest === digest && existsSync(join(generated, "api.d.ts")) && existsSync(join(generated, "operations.ts"));

if (args.has("--check")) {
  if (!fresh) {
    console.error("ui:sync --check: vendor/ or generated/ is stale. Run `pnpm ui:sync`.");
    process.exit(1);
  }
  console.log("ui:sync --check: up to date.");
  process.exit(0);
}
if (args.has("--if-stale") && fresh) process.exit(0);

try {
  const drift = driftGate();
  vendorCopy();
  const count = generate();
  tokens();
  writeFileAtomic(syncFile, `${JSON.stringify({
    sourceDigest: digest,
    lockDigest: sha256(join(docsUi, "contracts/SOURCES.lock.json")),
    bundleDigest: sha256(join(vendor, "bundle.json")),
    typesDigest: sha256(join(generated, "api.d.ts")),
    operations: count,
    acknowledgedDrift: drift.acknowledged,
  }, null, 2)}\n`);
  console.log(`ui:sync: ${count} operations; types and operation table generated.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
