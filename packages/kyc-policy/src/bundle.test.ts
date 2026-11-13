import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  DECISION_TABLE_ENTRYPOINT,
  REGO_MODULES,
  compileDecisionTablePolicy,
  evaluateDecisionTablePolicy,
  evaluateDecisionTablePolicyWithOpa,
  evaluateGate,
  OpaServerPool,
} from "@ehf/policy-engine";
import { policyBundleSchema } from "@ehf/contracts";

import { KYC_POLICY_ROOT, kycPolicyCatalog } from "./catalog.js";
import { loadCorpus } from "./corpus.js";
import { COMPILED_BUNDLE_ROOT, findOpaBinary, OpaServer } from "./opa.js";

const catalog = kycPolicyCatalog();
const compiled = compileDecisionTablePolicy({ root: KYC_POLICY_ROOT, opaVersion: "1.9.0" });

describe("compiled KYC policy bundle", () => {
  it("produces a manifest the PolicyBundle contract accepts as-is", () => {
    const signed = policyBundleSchema.parse(compiled.manifest);
    expect(signed.policyId).toBe(catalog.policy.metadata.id);
    expect(signed.gates.map((gate) => gate.gateId).sort()).toEqual([
      "decision-ready",
      "disposition",
      "screening-ready",
    ]);
    for (const gate of signed.gates) expect(gate.entrypoint).toBe(DECISION_TABLE_ENTRYPOINT);
    expect(signed.gates[0]!.entrypoint).toBe(catalog.policy.spec.compilation.entrypoint);
  });

  it("pins every emitted file by digest", () => {
    expect(compiled.manifest.regoModules.map((module) => module.path)).toEqual([...REGO_MODULES]);
    for (const module of compiled.manifest.regoModules) {
      expect(module.digest).toMatch(/^[a-f0-9]{64}$/);
    }
    expect(compiled.manifest.dataDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(compiled.manifest.sourceDigest).toBe(catalog.bundleDigest);
    expect(compiled.manifest.ruleIds).toContain("KYC-DEC-003");
  });

  it("is deterministic", () => {
    const again = compileDecisionTablePolicy({ root: KYC_POLICY_ROOT, opaVersion: "1.9.0" });
    expect(again.manifest.bundleDigest).toBe(compiled.manifest.bundleDigest);
    expect(again.files).toEqual(compiled.files);
  });

  it("matches the bundle checked in under artifacts", () => {
    for (const [path, contents] of Object.entries(compiled.files)) {
      const onDisk = readFileSync(resolve(COMPILED_BUNDLE_ROOT, path), "utf8");
      expect(onDisk, `${path} is stale; re-run \`pnpm --filter @ehf/policy-engine compile:kyc\``)
        .toBe(contents);
    }
  });

  it("refuses to compile for production while owner inputs are unresolved", () => {
    expect(compiled.productionEligible).toBe(false);
    expect(compiled.releaseBlockers.length).toBeGreaterThan(0);
    expect(() => compileDecisionTablePolicy({
      root: KYC_POLICY_ROOT,
      opaVersion: "1.9.0",
      release: "production",
    })).toThrow(/policy\.production_blocked/);
  });

  it("names the owner and reason code of every release blocker", () => {
    for (const blocker of compiled.releaseBlockers) {
      expect(blocker.owner.length, blocker.id).toBeGreaterThan(0);
      expect(blocker.reasonCode).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

describe("policy evaluation receipts", () => {
  const corpusCase = loadCorpus().find((item) => item.tags.includes("clean"))!;

  const snapshot = {
    apiVersion: "harness.factory/case-snapshot-v1" as const,
    kind: "CaseSnapshot" as const,
    snapshotId: "snap_test",
    snapshotDigest: "a".repeat(64),
    tenantId: corpusCase.snapshot.tenantId,
    caseId: corpusCase.snapshot.caseId,
    caseSequence: corpusCase.snapshot.caseSequence,
    dependencyDigest: "b".repeat(64),
    planDigest: "c".repeat(64),
    policyAuthority: {
      policyId: catalog.policy.metadata.id,
      policyVersion: catalog.policy.metadata.version,
      policySnapshotDigest: "d".repeat(64),
      policyBundleDigest: compiled.manifest.bundleDigest,
    },
    consistency: "strong" as const,
    classification: "CONFIDENTIAL",
    data: corpusCase.snapshot as unknown as Record<string, unknown>,
    capturedAt: "2026-03-02T12:00:00.000Z",
  };

  it("issues a PolicyEvaluation the contract accepts", () => {
    const receipt = evaluateDecisionTablePolicy({
      compiled,
      snapshot,
      gateId: "screening-ready",
      evaluatedAt: "2026-03-02T12:00:00.000Z",
    });
    const reference = evaluateGate("screening-ready", corpusCase.snapshot, catalog);
    expect(receipt.outcome).toBe(reference.outcome);
    expect(receipt.reasonCodes).toEqual([reference.reasonCode]);
    expect(receipt.policyBundleDigest).toBe(compiled.manifest.bundleDigest);
    expect(receipt.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("replays byte for byte from the same snapshot and clock", () => {
    const options = { compiled, snapshot, gateId: "disposition", evaluatedAt: "2026-03-02T12:00:00.000Z" };
    expect(evaluateDecisionTablePolicy(options)).toEqual(evaluateDecisionTablePolicy(options));
  });

  it("uses the pinned OPA result to issue the production receipt", async () => {
    const reference = evaluateGate("screening-ready", corpusCase.snapshot, catalog);
    const { caseSequence: _caseSequence, evaluatedAt: _evaluatedAt, ...opaDecision } = reference;
    const calls: string[][] = [];
    const receipt = await evaluateDecisionTablePolicyWithOpa({
      compiled,
      snapshot,
      gateId: "screening-ready",
      evaluatedAt: "2026-03-02T12:00:00.000Z",
      opaPath: "/test/opa",
      command: async (_binary, args) => {
        calls.push(args);
        if (args[0] === "version") return { stdout: "Version: 1.9.0\n" };
        return { stdout: JSON.stringify({ result: [{ expressions: [{ value: opaDecision }] }] }) };
      },
    });
    expect(calls[0]).toEqual(["version"]);
    expect(calls[1]).toContain(DECISION_TABLE_ENTRYPOINT);
    expect(receipt.outcome).toBe(reference.outcome);
    expect(receipt.reasonCodes).toEqual([reference.reasonCode]);
  });

  it("fails closed when the installed OPA version is not the bundle version", async () => {
    await expect(evaluateDecisionTablePolicyWithOpa({
      compiled,
      snapshot,
      gateId: "screening-ready",
      evaluatedAt: "2026-03-02T12:00:00.000Z",
      command: async () => ({ stdout: "Version: 1.10.0\n" }),
    })).rejects.toThrow("policy.opa_version_mismatch");
  });

  it("carries every condition value, so the decision reconstructs from the receipt alone", () => {
    const receipt = evaluateDecisionTablePolicy({
      compiled,
      snapshot,
      gateId: "disposition",
      evaluatedAt: "2026-03-02T12:00:00.000Z",
    });
    const recorded = receipt.obligations.find((item) => item.code === "RecordConditionValues");
    expect(recorded).toBeDefined();
    const table = catalog.tables.get("table.kyc.disposition.v1")!;
    expect(Object.keys(recorded!.parameters.conditionValues as Record<string, string>).sort())
      .toEqual(table.spec.conditions.map((condition) => condition.id).sort());
  });

  it("asks only for case commands the policy maps", () => {
    const mapped = new Set([
      catalog.policy.spec.commandMappings.recordEvaluation.commandType,
      catalog.policy.spec.commandMappings.routeHumanReview.commandType,
      "RecordConditionValues",
    ]);
    for (const gateId of ["screening-ready", "decision-ready", "disposition"]) {
      const receipt = evaluateDecisionTablePolicy({ compiled, snapshot, gateId, evaluatedAt: "2026-03-02T12:00:00.000Z" });
      for (const obligation of receipt.obligations) {
        expect(mapped.has(obligation.code), `${gateId} asked for ${obligation.code}`).toBe(true);
      }
      // Finalising a disposition is human-only, so no gate receipt may ever ask for it.
      expect(receipt.obligations.some((item) => item.code === "FinalizeDisposition")).toBe(false);
    }
  });

  it("refuses a snapshot pinned to a different bundle", () => {
    expect(() => evaluateDecisionTablePolicy({
      compiled,
      snapshot: { ...snapshot, policyAuthority: { ...snapshot.policyAuthority, policyBundleDigest: "e".repeat(64) } },
      gateId: "disposition",
      evaluatedAt: "2026-03-02T12:00:00.000Z",
    })).toThrow(/policy\.snapshot_authority_mismatch/);
  });
});

/**
 * The bundle is what decides cases in production, so the tables agreeing with the reference
 * evaluator is only a claim until OPA agrees too. This runs where an `opa` binary is
 * available (CI installs one; set OPA_BIN locally) and is skipped, loudly, where it is not:
 * a skipped conformance run is a gap in the evidence, not a pass.
 */
const opaBinary = findOpaBinary();

describe.skipIf(opaBinary === null)("OPA conformance", () => {
  const cases = loadCorpus();

  it("reproduces every corpus verdict, condition by condition", async () => {
    const server = new OpaServer(opaBinary!);
    const mismatches: string[] = [];
    await server.start();
    try {
      for (const corpusCase of cases) {
        for (const expectation of corpusCase.expectations) {
          const reference = evaluateGate(expectation.gate, corpusCase.snapshot, catalog);
          const decision = await server.evaluate(expectation.gate, corpusCase.snapshot);
          const where = `${corpusCase.caseId} ${expectation.gate}`;

          if (decision.outcome !== expectation.outcome || decision.reasonCode !== expectation.reasonCode) {
            mismatches.push(
              `${where}: rego ${decision.outcome}/${decision.reasonCode} vs adjudicated ` +
              `${expectation.outcome}/${expectation.reasonCode}`,
            );
          }
          if (decision.matchedRowId !== reference.matchedRowId) {
            mismatches.push(`${where}: row rego ${decision.matchedRowId} vs reference ${reference.matchedRowId}`);
          }
          if (decision.cohortId !== reference.cohortId) {
            mismatches.push(`${where}: cohort rego ${decision.cohortId} vs reference ${reference.cohortId}`);
          }
          for (const [conditionId, value] of Object.entries(reference.conditionValues)) {
            if (decision.conditionValues[conditionId] !== value) {
              mismatches.push(
                `${where}: condition ${conditionId} rego ` +
                `${decision.conditionValues[conditionId] ?? "<absent>"} vs reference ${value}`,
              );
            }
          }
        }
      }
    } finally {
      server.stop();
    }
    expect(mismatches.slice(0, 20).join("\n")).toBe("");
  }, 300_000);
});

describe.skipIf(opaBinary === null)("OPA server pool (production path)", () => {
  const cases = loadCorpus();
  const snapshotFor = (corpusCase: (typeof cases)[number]) => ({
    apiVersion: "harness.factory/case-snapshot-v1" as const, kind: "CaseSnapshot" as const,
    snapshotId: "snap_pool", snapshotDigest: "a".repeat(64), tenantId: corpusCase.snapshot.tenantId,
    caseId: corpusCase.snapshot.caseId, caseSequence: corpusCase.snapshot.caseSequence,
    dependencyDigest: "b".repeat(64), planDigest: "c".repeat(64),
    policyAuthority: { policyId: catalog.policy.metadata.id, policyVersion: catalog.policy.metadata.version, policySnapshotDigest: "d".repeat(64), policyBundleDigest: compiled.manifest.bundleDigest },
    consistency: "strong" as const, classification: "CONFIDENTIAL",
    data: corpusCase.snapshot as unknown as Record<string, unknown>, capturedAt: "2026-03-02T12:00:00.000Z",
  });

  it("issues the same receipts as one opa eval process per gate", async () => {
    const pool = new OpaServerPool({ binary: opaBinary! });
    try {
      for (const corpusCase of cases.slice(0, 12)) {
        for (const expectation of corpusCase.expectations) {
          const options = { compiled, snapshot: snapshotFor(corpusCase), gateId: expectation.gate, evaluatedAt: "2026-03-02T12:00:00.000Z", opaPath: opaBinary! };
          const [viaProcess, viaServer] = await Promise.all([
            evaluateDecisionTablePolicyWithOpa(options),
            evaluateDecisionTablePolicyWithOpa({ ...options, evaluator: pool }),
          ]);
          expect(viaServer).toEqual(viaProcess);
        }
      }
    } finally { await pool.close(); }
  }, 120_000);

  it("restarts a server that died and evicts the least recently used bundle", async () => {
    const pool = new OpaServerPool({ binary: opaBinary!, maxServers: 1 });
    const corpusCase = cases[0]!;
    const options = { compiled, snapshot: snapshotFor(corpusCase), gateId: corpusCase.expectations[0]!.gate, evaluatedAt: "2026-03-02T12:00:00.000Z", opaPath: opaBinary!, evaluator: pool };
    try {
      const first = await evaluateDecisionTablePolicyWithOpa(options);
      // Reach the running server and stop it; the next evaluation must start a new one.
      const servers = (pool as unknown as { servers: Map<string, Promise<{ child: { kill(signal: string): void } }>> }).servers;
      (await [...servers.values()][0]!).child.kill("SIGKILL");
      expect(await evaluateDecisionTablePolicyWithOpa(options)).toEqual(first);
      const other = { bundleDigest: "f".repeat(64), files: compiled.files };
      await pool.evaluate(other, compiled.manifest.gates[0]!.entrypoint, { gate: corpusCase.expectations[0]!.gate, snapshot: corpusCase.snapshot });
      expect([...servers.keys()]).toEqual(["f".repeat(64)]);
      await expect(pool.evaluate(other, "data.harness.no_such_rule", {})).rejects.toThrow("policy.opa_response_invalid");
    } finally { await pool.close(); }
  }, 60_000);
});
