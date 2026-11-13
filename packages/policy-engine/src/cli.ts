import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { compilePolicySource } from "./index.js";

const run = promisify(execFile);

const [sourceArgument, testsArgument, outputArgument, releaseArgument = "candidate"] = process.argv.slice(2);
if (!sourceArgument || !testsArgument || !outputArgument || !["candidate", "production"].includes(releaseArgument)) {
  throw new Error("usage: policyc <policy.yaml> <golden-tests.json> <output-directory> [candidate|production]");
}

const sourcePath = resolve(sourceArgument);
const testsPath = resolve(testsArgument);
const outputPath = resolve(outputArgument);
const source = await readFile(sourcePath, "utf8");
const testsSource = await readFile(testsPath, "utf8");
const compiled = compilePolicySource(source, {
  // This is the runtime compatibility target. Deployment must use exactly the same
  // pinned OPA minor and verify it before admitting the signed bundle.
  opaVersion: process.env.OPA_VERSION ?? "1.9.0",
  testsSource,
  release: releaseArgument as "candidate" | "production",
});
await mkdir(outputPath, { recursive: true });
await Promise.all([
  writeFile(join(outputPath, "policy.rego"), compiled.files["policy.rego"], "utf8"),
  writeFile(join(outputPath, "data.json"), `${compiled.files["data.json"]}\n`, "utf8"),
  writeFile(join(outputPath, "manifest.unsigned.json"), `${JSON.stringify({
    ...compiled.manifest,
    productionEligible: compiled.productionEligible,
    releaseBlockers: compiled.releaseBlockers,
    source: basename(sourcePath),
    tests: basename(testsPath),
  }, null, 2)}\n`, "utf8"),
]);
const opaPath = process.env.OPA_PATH ?? "opa";
try {
  const version = await run(opaPath, ["version"]);
  if (!version.stdout.includes(compiled.manifest.opaVersion)) {
    throw new Error(`policy.opa_version_mismatch:expected=${compiled.manifest.opaVersion}`);
  }
  await run(opaPath, ["check", "--v1-compatible", join(outputPath, "policy.rego")]);
} catch (error) {
  const missing = error && typeof error === "object" && "code" in error && error.code === "ENOENT";
  if (!missing || releaseArgument === "production") throw error;
  process.stderr.write(`warning: ${opaPath} is unavailable; candidate Rego syntax was not verified by OPA\n`);
}
process.stdout.write(`${compiled.manifest.bundleDigest}\n`);
