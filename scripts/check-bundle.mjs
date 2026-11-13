#!/usr/bin/env node
// Fail an http build that ships mock code (BUILD-SPEC v2 §4.4, §0.4).
// Usage: node scripts/check-bundle.mjs <dist-dir>
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const dist = resolve(process.argv[2] ?? "apps/web/dist");
const FORBIDDEN = [
  { name: "MSW", pattern: /\bmsw\b|mockServiceWorker|setupWorker\(/ },
  { name: "@ehf/ui-mock", pattern: /ui-mock|startMockWorker|mock\.not_implemented/ },
  { name: "fixtures", pattern: /contracts\/fixtures|personas\.json|scenario\.kyb-1042|ehf\.kyb-1042/ },
];

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

let files;
try {
  files = walk(dist).filter((path) => !path.endsWith(".map"));
} catch {
  console.error(`check-bundle: ${dist} does not exist; build first.`);
  process.exit(1);
}
const problems = [];
for (const file of files) {
  if (/mockServiceWorker\.js$/.test(file)) problems.push(`${relative(dist, file)}: MSW service worker file`);
  if (!/\.(js|mjs|css|html|json)$/.test(file)) continue;
  const text = readFileSync(file, "utf8");
  // The portable article cites the repository catalog as provenance metadata. A source
  // path is not an imported fixture module. Exempt only this exact metadata reference
  // in the article; fixture imports/data and all mock-runtime markers remain forbidden.
  const fixtureText = relative(dist, file) === "visual-story.html"
    ? text.replace(/"path"\s*:\s*"apps\/fincrime-host\/docs\/ui\/contracts\/fixtures\/catalogs\.json"/g, '"path":"repository-catalog-source"')
    : text;
  for (const { name, pattern } of FORBIDDEN) if (pattern.test(name === "fixtures" ? fixtureText : text)) problems.push(`${relative(dist, file)}: contains ${name}`);
}
if (problems.length) {
  console.error(`check-bundle: the http build contains mock code:\n  ${problems.join("\n  ")}`);
  process.exit(1);
}
console.log(`check-bundle: ${files.length} files, no mock code.`);
