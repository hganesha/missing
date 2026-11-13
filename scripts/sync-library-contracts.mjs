#!/usr/bin/env node
// Vendors the financial-crime skill library's executable contracts into
// packages/library-contracts/src/vendor/ (see docs/implementation/library-contracts.md).
//
//   node scripts/sync-library-contracts.mjs            # refresh from apps/fincrime-host (or --library <dir>)
//   node scripts/sync-library-contracts.mjs --check    # CI: fail when the vendored files do not match
//                                                      # their lock or the library's current files
//
// Vendored, byte for byte:
//   schemas/context/ontology.schema.json   → ontology.schema.json   (87 closed context types)
//   schemas/runtime/EffectCommand.schema.json → effect-command.schema.json
//   schemas/providers/*.schema.json        → providers/              (9 capabilities, request + response)
// plus lock.json: library version, context schema version, catalog source/bundle hashes and the
// sha256 of every vendored file. Nothing is rewritten: a file that differs from its lock fails --check.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vendorRoot = resolve(repoRoot, "packages/library-contracts/src/vendor");
const args = process.argv.slice(2);
const libraryIndex = args.indexOf("--library");
const check = args.includes("--check");
const library = resolve(libraryIndex >= 0 ? args[libraryIndex + 1] ?? "" : join(repoRoot, "apps/fincrime-host"));

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function vendoredFiles() {
  const files = ["ontology.schema.json", "effect-command.schema.json", "context-relationships.json"];
  const providers = join(vendorRoot, "providers");
  if (existsSync(providers)) files.push(...readdirSync(providers).filter((name) => name.endsWith(".schema.json")).sort().map((name) => `providers/${name}`));
  return files;
}

if (!check) {
  const catalog = JSON.parse(readFileSync(join(library, "catalog/catalog.json"), "utf8"));
  const sources = {
    "ontology.schema.json": "schemas/context/ontology.schema.json",
    "context-relationships.json": "catalog/context-relationships.json",
    "effect-command.schema.json": "schemas/runtime/EffectCommand.schema.json",
  };
  for (const name of readdirSync(join(library, "schemas/providers")).filter((item) => item.endsWith(".schema.json")).sort()) {
    sources[`providers/${name}`] = `schemas/providers/${name}`;
  }
  rmSync(vendorRoot, { recursive: true, force: true });
  mkdirSync(join(vendorRoot, "providers"), { recursive: true });
  const files = {};
  for (const [target, source] of Object.entries(sources)) {
    const bytes = readFileSync(join(library, source));
    writeFileSync(join(vendorRoot, target), bytes);
    files[target] = { source, sha256: sha256(bytes) };
  }
  const lock = {
    library: "financial-crime-skills",
    version: catalog.version,
    context_schema_version: catalog.context_schema_version,
    catalog_source_hash: catalog.source_hash,
    bundle_code_hash: catalog.bundle_code_hash,
    synthetic: catalog.synthetic === true,
    files,
  };
  writeFileSync(join(vendorRoot, "lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`library-contracts: vendored ${Object.keys(files).length} files from financial-crime-skills ${catalog.version} (context ${catalog.context_schema_version})`);
}

{
  const lock = JSON.parse(readFileSync(join(vendorRoot, "lock.json"), "utf8"));
  const problems = [];
  const present = new Set(vendoredFiles());
  for (const [target, entry] of Object.entries(lock.files)) {
    if (!present.delete(target)) { problems.push(`${target}: missing`); continue; }
    if (sha256(readFileSync(join(vendorRoot, target))) !== entry.sha256) problems.push(`${target}: differs from lock`);
  }
  for (const extra of present) problems.push(`${extra}: not in lock`);
  for (const [target, entry] of Object.entries(lock.files)) {
    const source = join(library, entry.source);
    if (!existsSync(source)) problems.push(`${target}: library source ${entry.source} missing`);
    else if (sha256(readFileSync(source)) !== entry.sha256) problems.push(`${target}: library source ${entry.source} changed (re-run without --check)`);
  }
  if (problems.length) {
    console.error(`library-contracts: vendored files do not match lock.json\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`library-contracts: ${Object.keys(lock.files).length} vendored files match financial-crime-skills ${lock.version}`);
}
