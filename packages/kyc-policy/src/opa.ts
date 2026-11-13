import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REGO_MODULES } from "@ehf/policy-engine";

/**
 * Runs the compiled Rego bundle so it can be held to the same corpus as the reference
 * evaluator.
 *
 * The bundle is the thing that will actually decide cases in production, so "the tables say
 * X" is not evidence until OPA, given the same snapshot, also says X. This module exists to
 * make that comparison cheap enough to run on every change: one server, one HTTP call per
 * evaluation, rather than several hundred process starts.
 */

/** The compiled bundle the conformance run evaluates: emitted Rego plus emitted data. */
export const COMPILED_BUNDLE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../artifacts/policy/kyc",
);

/** Sanity check that the compiler actually wrote what the conformance run expects. */
export const EXPECTED_MODULES = REGO_MODULES;

/** Where to find an `opa` binary, or null when this machine has none. */
export function findOpaBinary(): string | null {
  const candidates: string[] = [];
  if (process.env.OPA_BIN) candidates.push(process.env.OPA_BIN);
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir) candidates.push(join(dir, "opa"));
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export interface OpaDecision {
  outcome: string;
  reasonCode: string;
  matchedRowId: string | null;
  ruleIds: string[];
  cohortId: string | null;
  transitionTo: string | null;
  disposition: string | null;
  routeTo: string | null;
  conditionValues: Record<string, string>;
}

export class OpaServer {
  private process: ChildProcess | undefined;
  private baseUrl = "";

  constructor(private readonly binary: string) {}

  async start(): Promise<void> {
    // Port 0 would be ideal but OPA does not report the bound port, so take a high port and
    // let a collision surface as a start failure rather than silently querying someone else.
    const port = 18181 + (process.pid % 900);
    this.baseUrl = `http://127.0.0.1:${port}`;
    this.process = spawn(
      this.binary,
      ["run", "--server", "--addr", `127.0.0.1:${port}`, "--log-level", "error", COMPILED_BUNDLE_ROOT],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    this.process.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (this.process.exitCode !== null) {
        throw new Error(`opa exited before becoming ready: ${stderr.trim() || `code ${this.process.exitCode}`}`);
      }
      try {
        const response = await fetch(`${this.baseUrl}/health`);
        if (response.ok) return;
      } catch {
        // not listening yet
      }
      await new Promise((done) => setTimeout(done, 100));
    }
    this.stop();
    throw new Error(`opa did not become ready within 20s: ${stderr.trim()}`);
  }

  async evaluate(gate: string, snapshot: unknown): Promise<OpaDecision> {
    const response = await fetch(`${this.baseUrl}/v1/data/harness/decision_table/gate/result`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: { gate, snapshot } }),
    });
    if (!response.ok) throw new Error(`opa responded ${response.status}: ${await response.text()}`);
    const body = await response.json() as { result?: OpaDecision };
    if (!body.result) {
      // An undefined result means no rule produced a decision, which would be a hole in the
      // bundle rather than a policy outcome. Never let it read as a benign answer.
      throw new Error(`opa returned no decision for gate ${gate}`);
    }
    return body.result;
  }

  stop(): void {
    this.process?.kill("SIGTERM");
    this.process = undefined;
  }
}
