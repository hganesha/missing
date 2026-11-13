import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { compileDecisionTablePolicy } from "./decision-table/compile.js";

const run = promisify(execFile);

const [rootArgument, outputArgument, releaseArgument = "candidate"] = process.argv.slice(2);
if (!rootArgument || !outputArgument || !["candidate", "production"].includes(releaseArgument)) {
  throw new Error("usage: policyc-table <policy-root> <output-directory> [candidate|production]");
}

const compiled = compileDecisionTablePolicy({
  root: resolve(rootArgument),
  // The runtime compatibility target. Deployment must use exactly this pinned OPA minor and
  // verify it before admitting the signed bundle.
  opaVersion: process.env.OPA_VERSION ?? "1.9.0",
  release: releaseArgument as "candidate" | "production",
});

const outputPath = resolve(outputArgument);
await mkdir(outputPath, { recursive: true });
await Promise.all(Object.entries(compiled.files).map(async ([path, contents]) => {
  const target = join(outputPath, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
}));
await writeFile(
  join(outputPath, "manifest.unsigned.json"),
  `${JSON.stringify({
    ...compiled.manifest,
    productionEligible: compiled.productionEligible,
    releaseBlockers: compiled.releaseBlockers,
    source: relative(process.cwd(), resolve(rootArgument)),
  }, null, 2)}\n`,
  "utf8",
);

const opaPath = process.env.OPA_PATH ?? process.env.OPA_BIN ?? "opa";
try {
  const version = await run(opaPath, ["version"]);
  if (!version.stdout.includes(compiled.manifest.opaVersion)) {
    throw new Error(`policy.opa_version_mismatch:expected=${compiled.manifest.opaVersion}`);
  }
  await run(opaPath, ["check", "--v1-compatible", join(outputPath, "harness")]);
} catch (error) {
  // A candidate build may be produced on a machine without OPA; a production build may not,
  // because an unverified bundle is not evidence of anything.
  const missing = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
  if (!missing || releaseArgument === "production") throw error;
  process.stderr.write(`warning: ${opaPath} is unavailable; candidate Rego syntax was not verified by OPA\n`);
}

if (compiled.releaseBlockers.length > 0) {
  process.stderr.write(
    `candidate bundle: ${compiled.releaseBlockers.length} unresolved release blockers ` +
    `(${compiled.releaseBlockers.map((item) => item.id).join(", ")})\n`,
  );
}
process.stdout.write(`${compiled.manifest.bundleDigest}\n`);
