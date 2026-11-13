import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPolicySource } from "./source-file.js";

describe("policy source containment", () => {
  it("rejects traversal, absolute paths, symlinks, missing files and oversized files", () => {
    const parent = mkdtempSync(join(tmpdir(), "policy-test-"));
    const root = join(parent, "workspace");
    mkdirSync(join(root, "catalog", "nested"), { recursive: true });
    writeFileSync(join(parent, "sentinel.yaml"), "sentinel: [OUTSIDE_SECRET");
    writeFileSync(join(root, "catalog", "nested", "valid.yaml"), "valid: true");
    symlinkSync(join(parent, "sentinel.yaml"), join(root, "link.yaml"));
    symlinkSync(parent, join(root, "outside"));
    writeFileSync(join(root, "large.yaml"), Buffer.alloc(10_485_761));
    try {
      expect(readPolicySource(root, "catalog/nested/valid.yaml")).toBe("valid: true");
      for (const reference of [join(parent, "sentinel.yaml"), "../sentinel.yaml", "catalog/../../sentinel.yaml", "link.yaml", "outside/sentinel.yaml", "missing.yaml", "large.yaml"]) {
        expect(() => readPolicySource(root, reference)).toThrow(/^policy\.(reference_invalid|source_unavailable|source_size_invalid)$/);
      }
    } finally { rmSync(parent, { recursive: true, force: true }); }
  });
});
