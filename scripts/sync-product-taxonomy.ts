// Compile the canonical product taxonomy (domains/products) into artifacts/products/taxonomy.json.
//
//   node --import tsx scripts/sync-product-taxonomy.ts [--check]
//
// Every legacy case productType must map onto the taxonomy, and every cross-reference must resolve.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadInstitutionSeeds, loadProductTaxonomy } from "../packages/policy-engine/src/products.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "domains/products");
const taxonomy = loadProductTaxonomy(source);
// Institution catalog seeds: stamped with the taxonomy they were checked against, and refused if
// any problem would stop an approver.
const seeds = loadInstitutionSeeds(source, taxonomy);
const outputs = new Map<string, string>([
  [join(root, "artifacts/products/taxonomy.json"), `${JSON.stringify(taxonomy, null, 2)}\n`],
  [join(root, "artifacts/products/institutions.json"), `${JSON.stringify({ apiVersion: "harness.factory/institution-catalog-seeds-v1", taxonomyDigest: taxonomy.digest, catalogs: seeds }, null, 2)}\n`],
]);
if (process.argv.includes("--check")) {
  for (const [out, text] of outputs) {
    let current = "";
    try { current = readFileSync(out, "utf8"); } catch { /* missing counts as stale */ }
    if (current !== text) { console.error(`${out} is stale. Run node --import tsx scripts/sync-product-taxonomy.ts`); process.exit(1); }
  }
  console.log(`product taxonomy is up to date (${taxonomy.nodes.length} nodes, ${seeds.length} institution seeds, ${taxonomy.digest.slice(0, 12)})`);
} else {
  for (const [out, text] of outputs) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, text); }
  const count = (level: string) => taxonomy.nodes.filter((node) => node.level === level).length;
  console.log(`product taxonomy compiled: ${count("domain")} domains, ${count("class")} classes, ${count("type")} types, ${taxonomy.attributes.length} attributes, ${seeds.length} institution seeds (${taxonomy.digest.slice(0, 12)})`);
}
