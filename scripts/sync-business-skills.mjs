#!/usr/bin/env node
// Generates config/business-skills.json, the business-skill registry seed, from the vendored
// financial-crime skill library catalog (config/skill-library).
//
//   node scripts/sync-business-skills.mjs [--library <financial-crime skills checkout>] [--check]
//
// --library  the library to vendor from (default: apps/fincrime-host, the in-repository library).
//            catalog/catalog.json and catalog/release-lock.json are copied byte for byte into
//            config/skill-library/, with source.json naming the library (its repository path, or
//            the commit of an external checkout) and the files' sha256.
// --check    write nothing; exit 1 when the vendored snapshot, config/skill-library/source.json or
//            config/business-skills.json differs from what would be generated.
//
// Every catalog entry becomes one registry entry: the entry verbatim as `manifest` (validated
// with librarySkillManifestSchema, which refuses unknown fields), `manifestDigest` =
// businessSkillManifestDigest(entry) (the rule the KYB/KYC generators pin, and the library's own
// digest), `maturity` from the entry, `effects` per CR-5 (businessSkillEffects) and
// `dependencies` (businessSkillDependencies). The snapshot must be internally consistent or
// nothing is written: the release lock's catalog_hash, bundle_code_hash and skill_count must
// match the catalog, and every entry's bundle_code_hash must be the catalog's. Output is
// deterministic (sorted by skill ID then semver, canonical key order, two-space JSON).
// See docs/implementation/business-skills.md.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { writeFileAtomic } from './lib/write-atomic.mjs';
const {
  businessSkillCatalogSchema,
  businessSkillDependencies,
  businessSkillEffects,
  businessSkillManifestDigest,
  canonicalize,
  librarySkillManifestSchema,
} = await tsImport("../packages/contracts/src/index.ts", import.meta.url);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : undefined;
};
const check = args.includes("--check");
const libraryRoot = resolve(option("--library") ?? resolve(repoRoot, "apps/fincrime-host"));

const VENDOR = "config/skill-library";
const LIBRARY = "financial-crime-skills";
const FILES = ["catalog/catalog.json", "catalog/release-lock.json"];
const vendored = (file) => resolve(repoRoot, VENDOR, file.split("/").at(-1));
const out = resolve(repoRoot, "config/business-skills.json");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

let stale = false;
function emit(path, content) {
  const current = existsSync(path) ? readFileSync(path) : null;
  if (current && current.equals(Buffer.from(content))) return;
  stale = true;
  if (check) {
    process.stderr.write(`sync-business-skills: out of date: ${path.slice(repoRoot.length + 1)}\n`);
    return;
  }
  writeFileAtomic(path, content);
}

/** The checkout's commit, read from its .git files (no git command), or null. */
function libraryRevision(root) {
  try {
    const head = readFileSync(resolve(root, ".git/HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return /^[0-9a-f]{40}$/.test(head) ? head : null;
    const ref = head.slice(5);
    const loose = resolve(root, ".git", ref);
    if (existsSync(loose)) return readFileSync(loose, "utf8").trim();
    const packed = readFileSync(resolve(root, ".git/packed-refs"), "utf8").split("\n").find((line) => line.endsWith(` ${ref}`));
    return packed ? packed.split(" ")[0] : null;
  } catch {
    return null;
  }
}

function fail(problems) {
  process.stderr.write(`sync-business-skills: ${problems.length} problem(s) in ${VENDOR}\n${problems.map((line) => `  - ${line}`).join("\n")}\n`);
  process.exit(1);
}

// 1. The vendored snapshot (refreshed from a checkout with --library).
if (libraryRoot) {
  const inRepository = libraryRoot.startsWith(`${repoRoot}/`);
  const revision = inRepository ? null : libraryRevision(libraryRoot);
  if (!inRepository && !revision) fail([`${libraryRoot}: no git revision; an external snapshot must name the library commit it came from`]);
  const digests = {};
  for (const file of FILES) {
    const bytes = readFileSync(resolve(libraryRoot, file));
    emit(vendored(file), bytes);
    digests[file] = `sha256:${sha256(bytes)}`;
  }
  const origin = inRepository ? { path: relative(repoRoot, libraryRoot) } : { revision };
  emit(resolve(repoRoot, VENDOR, "source.json"), `${JSON.stringify({ library: LIBRARY, ...origin, files: digests }, null, 2)}\n`);
}

const source = JSON.parse(readFileSync(resolve(repoRoot, VENDOR, "source.json"), "utf8"));
const problems = [];
const bytes = Object.fromEntries(FILES.map((file) => [file, readFileSync(vendored(file))]));
for (const file of FILES) {
  if (source.files?.[file] !== `sha256:${sha256(bytes[file])}`) problems.push(`${file}: sha256 differs from source.json (refresh with --library)`);
}
if (source.library !== LIBRARY || !(/^[0-9a-f]{40}$/.test(source.revision ?? "") || (typeof source.path === "string" && !source.revision))) problems.push("source.json: library, path or revision invalid");
const catalog = JSON.parse(bytes["catalog/catalog.json"].toString("utf8"));
const lock = JSON.parse(bytes["catalog/release-lock.json"].toString("utf8"));
if (businessSkillManifestDigest(catalog) !== lock.catalog_hash) problems.push("release-lock.json: catalog_hash does not match the catalog");
if (lock.bundle_code_hash !== catalog.bundle_code_hash) problems.push("release-lock.json: bundle_code_hash does not match the catalog");
if (lock.skill_count !== catalog.skills?.length) problems.push("release-lock.json: skill_count does not match the catalog");

// 2. One registry entry per catalog entry.
const entries = [];
const seen = new Set();
for (const [index, skill] of (catalog.skills ?? []).entries()) {
  const where = `catalog.json skills[${index}]${typeof skill?.id === "string" ? ` (${skill.id})` : ""}`;
  const parsed = librarySkillManifestSchema.safeParse(skill);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) problems.push(`${where}: ${issue.path.length ? issue.path.join(".") : "<manifest>"}: ${issue.message}`);
    continue;
  }
  const manifest = parsed.data;
  const key = `${manifest.id}@${manifest.semver}`;
  if (seen.has(key)) problems.push(`${where}: duplicate ${key}`);
  seen.add(key);
  if (manifest.bundle_code_hash !== catalog.bundle_code_hash) problems.push(`${where}: bundle_code_hash differs from the catalog's`);
  entries.push({
    skillId: manifest.id,
    semver: manifest.semver,
    status: "draft",
    maturity: manifest.maturity,
    owner: manifest.owner,
    // The verbatim entry, not the parsed copy: the digest is over exactly what the catalog says.
    manifestDigest: businessSkillManifestDigest(skill),
    effects: businessSkillEffects(manifest),
    dependencies: businessSkillDependencies(manifest),
    source: { path: `${VENDOR}/catalog.json`, revision: source.revision ?? `in-repo:${source.path}` },
    manifest: skill,
  });
}
if (!entries.length) problems.push("catalog.json: no skills");
if (problems.length) fail(problems);

entries.sort((left, right) => (left.skillId < right.skillId ? -1 : left.skillId > right.skillId ? 1 : left.semver < right.semver ? -1 : 1));
const seed = businessSkillCatalogSchema.parse({
  apiVersion: "harness.factory/business-skill-catalog-v2",
  generatedFrom: {
    source: `${VENDOR}/catalog.json`,
    library: LIBRARY,
    version: catalog.version,
    sourceHash: catalog.source_hash,
    bundleDigest: `sha256:${catalog.bundle_code_hash}`,
    catalogHash: lock.catalog_hash,
    ...(source.revision ? { revision: source.revision } : { path: source.path }),
  },
  skills: entries,
});
// Serialize the unparsed entries: the schema checked them, and parsing must not reshape a manifest.
emit(out, `${JSON.stringify(canonicalize({ ...seed, skills: entries }), null, 2)}\n`);

const count = (key) => Object.entries(Object.groupBy(entries, (entry) => key(entry))).map(([name, items]) => `${items.length} ${name}`).sort().join(", ");
const summary = `${entries.length} skill version(s) from ${LIBRARY} ${catalog.version} @ ${source.revision?.slice(0, 7) ?? source.path} (${count((entry) => entry.maturity)}; effects ${count((entry) => `${entry.effects.mode}${entry.effects.approval === "required" ? "+approval" : ""}`)})`;
if (check && stale) {
  process.stderr.write("sync-business-skills: run node scripts/sync-business-skills.mjs\n");
  process.exit(1);
}
process.stdout.write(`sync-business-skills: ${check ? "current" : "wrote config/business-skills.json"}: ${summary}\n`);
