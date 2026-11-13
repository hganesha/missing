import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { stableDigest, type CaseSnapshot } from "@ehf/contracts";
import { compilePolicySource, evaluateCompiledPolicy, evaluatePolicy, parsePolicySource } from "./index.js";

// A compiler test that reads whatever a domain's policy currently says breaks whenever a
// policy owner edits a rule, and stops telling you anything about the compiler. These
// fixtures exist only to exercise compiler behaviour.
const policyPath = resolve(import.meta.dirname, "__fixtures__/example-policy.yaml");
const corpusPath = resolve(import.meta.dirname, "__fixtures__/example-golden.json");

describe("policy compiler", () => {
  it("compiles deterministically and runs its golden corpus", async () => {
    const source = await readFile(policyPath, "utf8");
    const policy = parsePolicySource(source);
    const corpus = JSON.parse(await readFile(corpusPath, "utf8")) as {
      cases: Array<{ gate: string; input: Record<string, unknown>; expected: unknown }>;
    };
    const testsSource = await readFile(corpusPath, "utf8");
    const options = { opaVersion: "1.9.0", testsSource };
    const first = compilePolicySource(source, options);
    const second = compilePolicySource(source, options);
    expect(second).toEqual(first);
    expect(first.manifest.gates[0]?.entrypoint).toBe("data.harness.example.acceptance.evaluate");
    expect(first.releaseBlockers).toHaveLength(1);
    expect(first.manifest.ruleIds).toHaveLength(4);
    expect(first.files["policy.rego"]).toContain('item["findingType"] in ["POSSIBLE_SANCTIONS_MATCH","IDENTITY_CONFLICT"]');
    for (const fixture of corpus.cases) {
      expect(evaluatePolicy(policy, fixture.gate, fixture.input)).toEqual(fixture.expected);
    }
  });

  it("refuses to promote unresolved policy to production", async () => {
    const source = await readFile(policyPath, "utf8");
    const testsSource = await readFile(corpusPath, "utf8");
    expect(() => compilePolicySource(source, { opaVersion: "1.9.0", testsSource, release: "production" }))
      .toThrow(/policy\.production_blocked:EXAMPLE-CONFIG-001/);
  });

  it("rejects a golden corpus that does not reproduce the authored decision", async () => {
    const source = await readFile(policyPath, "utf8");
    const corpus = JSON.parse(await readFile(corpusPath, "utf8"));
    corpus.cases[0].expected.outcome = "ERROR";
    expect(() => compilePolicySource(source, { opaVersion: "1.9.0", testsSource: JSON.stringify(corpus) }))
      .toThrow(/policy\.golden_decision_mismatch:/);
  });

  it("binds an evaluation receipt to the authoritative case snapshot", async () => {
    const source = await readFile(policyPath, "utf8");
    const testsSource = await readFile(corpusPath, "utf8");
    const compiled = compilePolicySource(source, { opaVersion: "1.9.0", testsSource });
    const snapshot = {
      apiVersion: "harness.factory/case-snapshot-v1",
      kind: "CaseSnapshot",
      snapshotId: "snapshot_1",
      snapshotDigest: "a".repeat(64),
      tenantId: "tenant_1",
      caseId: "case_1",
      caseSequence: 4,
      dependencyDigest: "b".repeat(64),
      planDigest: "c".repeat(64),
      policyAuthority: {
        policyId: compiled.manifest.policyId,
        policyVersion: compiled.manifest.policyVersion,
        policySnapshotDigest: compiled.manifest.sourceDigest,
        policyBundleDigest: compiled.manifest.bundleDigest,
      },
      consistency: "strong",
      classification: "CONFIDENTIAL",
      data: {
        evidence: [{ evidenceId: "evidence_1", purpose: "EXAMPLE_AUTHORITY" }],
        policyAuthority: { policySnapshotDigest: "source_1" },
      },
      capturedAt: "2026-09-19T12:00:00.000Z",
    } satisfies CaseSnapshot;
    const receipt = evaluateCompiledPolicy({
      source,
      compiled,
      snapshot,
      gateId: "readiness",
      evaluatedAt: "2026-09-19T12:01:00.000Z",
    });
    expect(receipt.outcome).toBe("ALLOW");
    const { receiptDigest, ...unsigned } = receipt;
    expect(receiptDigest).toBe(stableDigest(unsigned));
  });

  it("rejects duplicate YAML keys", () => {
    expect(() => parsePolicySource("apiVersion: one\napiVersion: two\n"))
      .toThrow(/policy\.yaml_invalid/);
  });
});
