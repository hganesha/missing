#!/usr/bin/env node
// Compiles the policy packs (domains/policy) into effective packs (artifacts/policy/packs). Product
// layers compose down the product taxonomy (artifacts/products, scripts/sync-product-taxonomy.ts).
//
//   node scripts/sync-policy-packs.mjs [--check]
//
// Reads every layer under domains/policy/packs and the selection matrix domains/policy/selection.yaml,
// composes one effective pack per selection entry with the tighten-only rules of
// packages/policy-engine/src/policy-packs.ts, checks that every OPA bundle a layer references is the
// compiled bundle in artifacts/policy, and writes <id>.json plus index.json. --check writes nothing
// and exits 1 when a committed file differs. Composition grants nothing: a pack is CANDIDATE until
// every layer is approved, and approval is the policy owner's.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { tsImport } from "tsx/esm/api";
import { createEmitter, json, repoRoot } from "./lib/library-package.mjs";

const { composeEffectivePack, policyPackLayerSchema, policyPackSelectionSchema, productLineageOf } = await tsImport("../packages/policy-engine/src/policy-packs.ts", import.meta.url);
const check = process.argv.includes("--check");
const { emit, state } = createEmitter(check);
const policyRoot = resolve(repoRoot, "domains/policy");
const outRoot = resolve(repoRoot, "artifacts/policy/packs");

const files = (dir) => readdirSync(dir).sort().flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : name.endsWith(".yaml") ? [path] : [];
});
const layers = files(join(policyRoot, "packs")).map((path) => {
  const parsed = policyPackLayerSchema.safeParse(parse(readFileSync(path, "utf8")));
  if (!parsed.success) throw new Error(`policy_pack.layer_invalid:${relative(repoRoot, path)}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
  return parsed.data;
});
const ids = layers.map((layer) => layer.metadata.id);
if (new Set(ids).size !== ids.length) throw new Error("policy_pack.layer_id_duplicate");
const selection = policyPackSelectionSchema.parse(parse(readFileSync(join(policyRoot, "selection.yaml"), "utf8")));

// Every referenced OPA bundle must be the one compiled in artifacts/policy.
const compiledBundles = new Map();
for (const dir of readdirSync(resolve(repoRoot, "artifacts/policy")).sort()) {
  try {
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, "artifacts/policy", dir, "manifest.unsigned.json"), "utf8"));
    compiledBundles.set(manifest.policyId, manifest.bundleDigest);
  } catch { /* not a compiled bundle directory */ }
}
for (const layer of layers) {
  for (const [gate, bundle] of Object.entries(layer.gateBundles)) {
    if (compiledBundles.get(bundle.policyId) !== bundle.bundleDigest) {
      throw new Error(`policy_pack.gate_bundle_not_compiled:${layer.metadata.id}:${gate}:${bundle.policyId}`);
    }
  }
}

// Product layers may target taxonomy nodes: a legacy product id inherits from the node the
// taxonomy maps it to and that node's ancestors (artifacts/products/taxonomy.json).
const legacy = JSON.parse(readFileSync(resolve(repoRoot, "artifacts/products/taxonomy.json"), "utf8")).legacy;
const lineage = (product) => productLineageOf(product, legacy);
const packs = selection.packs.map((entry) => composeEffectivePack(layers, entry, { lineage }));
const packIds = packs.map((pack) => pack.id);
if (new Set(packIds).size !== packIds.length) throw new Error("policy_pack.effective_id_duplicate");
for (const pack of packs) emit(join(outRoot, `${pack.id}.json`), json(pack));
emit(join(outRoot, "index.json"), json({
  apiVersion: "harness.factory/policy-pack-index-v1",
  packs: packs.map((pack) => ({ id: pack.id, digest: pack.digest, status: pack.status, scope: pack.scope })),
}));
if (check && state.changed) process.exit(1);
process.stdout.write(check ? "policy packs are up to date\n" : `policy packs compiled (${layers.length} layers, ${packs.length} effective packs)\n`);
