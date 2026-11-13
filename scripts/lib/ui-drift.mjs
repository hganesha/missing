// Shared drift gate for ui:sync and ui:contracts (ALIGNMENT §8).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

export function checkSources({ docsUi, kycRoot, ehfRoot, acknowledgedPath }) {
  const tool = join(docsUi, "contracts/tools/check_sources.py");
  const json = spawnSync("python3", [tool, "--kyc-root", kycRoot, "--ehf-root", ehfRoot, "--json"], { encoding: "utf8" });
  if (json.status === 2) throw new Error(`check_sources: a root is missing\n${json.stderr}`);
  const report = JSON.parse(json.stdout);
  const drifting = Object.entries(report.groups ?? {}).filter(([, group]) => group.status === "drift").map(([id]) => id);
  const acknowledged = JSON.parse(readFileSync(acknowledgedPath, "utf8")).groups ?? {};
  const unacknowledged = drifting.filter((id) => !acknowledged[id]);
  const text = () => spawnSync("python3", [tool, "--kyc-root", kycRoot, "--ehf-root", ehfRoot], { encoding: "utf8" }).stdout;
  return { report, drifting, unacknowledged, acknowledged: drifting.map((id) => ({ group: id, ...acknowledged[id] })), text };
}
