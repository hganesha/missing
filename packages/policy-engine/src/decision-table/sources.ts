import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compileDecisionTablePolicy } from "./compile.js";

/** Compile immutable registry source bytes; no caller-controlled paths escape the workspace. */
export function compileDecisionTableSources(files: Record<string, string>, opaVersion: string) {
  const root = mkdtempSync(join(tmpdir(), "ehf-policy-"));
  try {
    const entries = Object.entries(files);
    if (!entries.length || entries.length > 64) throw new Error("policy.files_count_invalid");
    let total = 0;
    for (const [path, source] of entries) {
      if (!/^(?:policy\.yaml|catalog\/[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*\.yaml|fixtures\/corpus\/[a-z0-9][a-z0-9.-]*\.jsonl)$/i.test(path)
        || typeof source !== "string") throw new Error("policy.file_invalid");
      total += Buffer.byteLength(source);
      if (total > 10_485_760) throw new Error("policy.files_too_large");
      const target = join(root, path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    return compileDecisionTablePolicy({ root, opaVersion, release: "candidate" });
  } finally { rmSync(root, { recursive: true, force: true }); }
}
