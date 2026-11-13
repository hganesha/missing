// Shared generator for v2 domain packages that run a financial-crime skill library workflow.
//
// Input: (a) a library-format workflow (`steps[]` with skill_id, parameters, bindings,
// dependencies, success_condition), (b) the vendored library manifests of the skills it uses
// (`skills.json`, a slice of the library's catalog/catalog.json with its source hashes), and
// (c) a small platform overlay: connector acquisition stages, OPA gate nodes, approval
// settings, agent profiles, context selectors and per-skill node additions.
// Output: package.yaml + workflow.yaml (harness.factory/domain-package-v2, ladder workflow).
//
// Two-stage pattern (docs/implementation/canonical-records.md): connector nodes ACQUIRE data and
// write canonical records (RecordCanonicalRecords from the adapter output's `records`); library
// skill nodes REASON over the records the context plane selects for their declared
// requirements. Each skill node binds capability `skill.<skill_id>.v<major>` (connector
// `skills:<skill_id>`); manifestDigest is businessSkillManifestDigest of the library manifest (the
// rule the business-skill registry pins, scripts/sync-business-skills.mjs) and bundleDigest the
// catalog's bundle_code_hash.
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tsImport } from "tsx/esm/api";
import { writeFileAtomic } from './write-atomic.mjs';
const { businessSkillManifestDigest } = await tsImport("../../packages/contracts/src/index.ts", import.meta.url);

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
export const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
export const nodeId = (stepId) => stepId.replaceAll("_", "-");
const majorOf = (semver) => semver.split(".")[0];
export const capabilityFor = (skillId, semver) => `skill.${skillId}.v${majorOf(semver)}`;
export function parseArgs(argv) {
  const option = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : undefined;
  };
  return { check: argv.includes("--check"), libraryRoot: resolve(option("--library") ?? resolve(repoRoot, "apps/fincrime-host")) };
}

/** Writes a file only when its content changes; in check mode reports instead of writing. */
export function createEmitter(check) {
  const state = { changed: false };
  const emit = (path, content) => {
    const current = existsSync(path) ? readFileSync(path, "utf8") : null;
    if (current === content) return;
    state.changed = true;
    if (check) {
      process.stderr.write(`out of date: ${path.slice(repoRoot.length + 1)}\n`);
      return;
    }
    writeFileAtomic(path, content);
  };
  return { emit, state };
}

/** The checkout's commit, read from its .git files (no git command), or null. */
function libraryRevision(libraryRoot) {
  try {
    const head = readFileSync(resolve(libraryRoot, ".git/HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) return /^[0-9a-f]{40}$/.test(head) ? head : null;
    const ref = head.slice(5);
    const loose = resolve(libraryRoot, ".git", ref);
    if (existsSync(loose)) return readFileSync(loose, "utf8").trim();
    const packed = readFileSync(resolve(libraryRoot, ".git/packed-refs"), "utf8").split("\n").find((line) => line.endsWith(` ${ref}`));
    return packed ? packed.split(" ")[0] : null;
  } catch {
    return null;
  }
}

/**
 * The vendored manifests (`skills.json`) for every skill the workflow uses, from the library's
 * catalog, with the catalog's source hashes. Refuses a workflow step whose skill the catalog
 * does not have.
 */
export function vendoredSkills({ libraryRoot, workflow, files, extraSkillIds = [] }) {
  const catalog = readJson(resolve(libraryRoot, "catalog/catalog.json"));
  const ids = new Set([...workflow.steps.map((step) => step.skill_id), ...extraSkillIds]);
  const skills = catalog.skills.filter((skill) => ids.has(skill.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
  const missing = [...ids].filter((id) => !skills.some((skill) => skill.id === id));
  if (missing.length) throw new Error(`library.skill_missing:${missing.sort().join(",")}`);
  const inRepository = libraryRoot.startsWith(`${repoRoot}/`);
  const revision = inRepository ? null : libraryRevision(libraryRoot);
  return {
    source: {
      library: "financial-crime-skills",
      catalogVersion: catalog.version,
      catalogSourceHash: catalog.source_hash,
      bundleCodeHash: catalog.bundle_code_hash,
      contextSchemaVersion: catalog.context_schema_version ?? null,
      ...(revision ? { revision } : {}),
      ...(inRepository ? { path: relative(repoRoot, libraryRoot) } : {}),
      synthetic: catalog.synthetic,
      files,
    },
    skills,
  };
}

/**
 * The package's vendored manifests must be the business-skill registry's: the same catalog
 * release (version, source and bundle hashes, revision) as config/skill-library, and each
 * manifest identical to its catalog entry, so every pinned manifestDigest names a registry
 * entry (config/business-skills.json). Throws otherwise; refresh both from the same checkout.
 */
export function assertRegistrySnapshot(library) {
  const catalog = readJson(resolve(repoRoot, "config/skill-library/catalog.json"));
  const { revision, path } = readJson(resolve(repoRoot, "config/skill-library/source.json"));
  const source = library.source;
  if (source.catalogVersion !== catalog.version || source.catalogSourceHash !== catalog.source_hash
    || source.bundleCodeHash !== catalog.bundle_code_hash || (source.revision && source.revision !== revision)
    || (source.path && source.path !== path)) {
    throw new Error("library.registry_snapshot_mismatch: the package and config/skill-library come from different catalog releases");
  }
  const entries = new Map(catalog.skills.map((skill) => [`${skill.id}@${skill.semver}`, skill]));
  for (const skill of library.skills) {
    const entry = entries.get(`${skill.id}@${skill.semver}`);
    if (!entry || businessSkillManifestDigest(entry) !== businessSkillManifestDigest(skill)) {
      throw new Error(`library.registry_manifest_mismatch:${skill.id}@${skill.semver}`);
    }
  }
}

/**
 * The business-skill registry entries (config/business-skills.json), keyed `skill_id@semver`.
 * The registry entry, not the vendored manifest, is the authority for a skill's effect mode and
 * approval (CR-5); assertRegistrySnapshot has already checked the manifests are identical.
 */
export function registryEntries() {
  const registry = readJson(resolve(repoRoot, "config/business-skills.json"));
  return new Map(registry.skills.map((entry) => [`${entry.skillId}@${entry.semver}`, entry]));
}

// The pure builder lives in @ehf/flow-composer (packages/flow-composer/src/library-package.ts), shared
// with run-time flow composition; these re-exports keep the generators' imports unchanged.
const pure = await tsImport("../../packages/flow-composer/src/library-package.ts", import.meta.url);
export const { bindingEffects, skillGrantEntries, recordSelectorsFor, yamlOptions, toYaml } = pure;

/** Build the package and workflow documents; the registry defaults to config/business-skills.json. */
export function buildLibraryPackage({ registry = registryEntries(), ...args }) {
  return pure.buildLibraryPackage({ ...args, registry });
}
