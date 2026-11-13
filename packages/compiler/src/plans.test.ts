import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compilePackage } from "./compiler.js";
import { modelProfilesPath, repositoryRoot } from "./test-support.js";

/**
 * Every committed package and the plan committed for it (`make compile fixtures` writes them).
 *
 * Parity with the previous (Rust) implementation was proven before it was removed: at the
 * commit that introduced this package, every plan compiled here was byte-for-byte the Rust
 * compiler's once the compiler identity was substituted, digests included.
 */
const PACKAGES: [string, string][] = [
  ["domains/archive/kyc-v2-deterministic", "artifacts/archive/kyc-v2.plan.json"],
  ["domains/archive/kyb-deterministic", "artifacts/archive/kyb.plan.json"],
  ["packages/contracts/test-fixtures/agent-profiles", "packages/contracts/test-fixtures/agent-profiles.plan.json"],
  ["packages/contracts/test-fixtures/conformance", "packages/contracts/test-fixtures/conformance.plan.json"],
  ["packages/contracts/test-fixtures/skill-bound", "packages/contracts/test-fixtures/skill-bound.plan.json"],
  ["packages/contracts/test-fixtures/skill-hosted", "packages/contracts/test-fixtures/skill-hosted.plan.json"],
  ["packages/contracts/test-fixtures/skill-commit", "packages/contracts/test-fixtures/skill-commit.plan.json"],
];

describe("committed plans", () => {
  it.each(PACKAGES)("%s compiles to its committed plan, byte for byte", (packageDir, planPath) => {
    const compiled = compilePackage(join(repositoryRoot, packageDir), { modelProfiles: modelProfilesPath });
    expect(compiled.document).toBe(readFileSync(join(repositoryRoot, planPath), "utf8"));
  });
});
