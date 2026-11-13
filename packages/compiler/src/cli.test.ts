import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { compilePackage, COMPILER_VERSION } from "./compiler.js";
import { invoiceFixture, KYC_FIXTURE, modelProfilesPath, repositoryRoot } from "./test-support.js";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const harnessc = (...args: string[]) => run(process.execPath, ["--import", "tsx", cli, ...args], { cwd: repositoryRoot });

describe("harnessc command line", () => {
  it("compiles a package to a file and prints its digest", async () => {
    const out = join(mkdtempSync(join(tmpdir(), "harnessc-cli-")), "nested", "plan.json");
    try {
      const { stdout } = await harnessc("compile", KYC_FIXTURE, "--out", out);
      const expected = compilePackage(KYC_FIXTURE, { modelProfiles: modelProfilesPath });
      expect(stdout).toBe(`${expected.planDigest}\n`);
      expect(readFileSync(out, "utf8")).toBe(expected.document);
    } finally {
      rmSync(join(out, "..", ".."), { recursive: true, force: true });
    }
  });

  it("prints the LGIR analysis on validate", async () => {
    const { stdout } = await harnessc("validate", KYC_FIXTURE);
    expect(JSON.parse(stdout)).toMatchObject({ ok: true });
  });

  it("exits non-zero with the compiler diagnostic", async () => {
    const directory = invoiceFixture("cli-refused", readFileSync(join(KYC_FIXTURE, "package.yaml"), "utf8").replace("agentProfiles:\n", "skills: []\nagentProfiles:\n"));
    try {
      await expect(harnessc("compile", directory, "--out", join(directory, "..", "plan.json"))).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("Error: package.agent_profiles_required:skills"),
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("reports its version and refuses unknown arguments", async () => {
    expect((await harnessc("--version")).stdout).toBe(`harnessc ${COMPILER_VERSION}\n`);
    await expect(harnessc("compile", KYC_FIXTURE)).rejects.toMatchObject({ code: 2 });
    await expect(harnessc("explode")).rejects.toMatchObject({ code: 2 });
  });
});
