import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { harnessPlanV2Schema, PLAN_V1_REMOVED, stableDigest, type HarnessPlanV2 } from "@ehf/contracts";
import { admitPlan, type Database } from "./index.js";

function fixturePlan(): HarnessPlanV2 {
  return harnessPlanV2Schema.parse(JSON.parse(readFileSync(
    new URL("../../contracts/test-fixtures/conformance.plan.json", import.meta.url),
    "utf8",
  )));
}

function recordingDatabase(): { db: Database; queries: unknown[] } {
  const queries: unknown[] = [];
  const db = {
    query: async (text: unknown) => {
      queries.push(text);
      return { rowCount: 1, rows: [] };
    },
  } as unknown as Database;
  return { db, queries };
}

describe("plan admission", () => {
  it("admits a plan whose content matches its digest", async () => {
    const { db, queries } = recordingDatabase();
    const result = await admitPlan(db, fixturePlan(), "tenant_demo");
    expect(result.created).toBe(true);
    expect(queries).toHaveLength(1);
  });

  it("rejects a tampered plan before touching the database", async () => {
    const { db, queries } = recordingDatabase();
    const tampered = { ...fixturePlan(), budgets: { ...fixturePlan().budgets, maxCostUsd: 999 } };
    await expect(admitPlan(db, tampered, "tenant_demo")).rejects.toThrow("plan.digest_invalid");
    // The regression this guards: admission used to insert first and validate after,
    // which left an unverifiable plan admitted and executable behind a 400 response.
    expect(queries).toHaveLength(0);
  });

  it("admits a digest-valid v2 plan through the same immutable boundary", async () => {
    const digest = "a".repeat(64);
    const content = {
      apiVersion: "harness.factory/plan-v2" as const,
      kind: "HarnessPlan" as const,
      packageDigest: digest,
      compiler: {
        name: "harnessc" as const, version: "2.0.0", digest,
        compatibilityVersion: "4", lgirCoreRevision: "abcdef0",
      },
      metadata: { name: "v2", version: "2.0.0", domain: "test", objective: "Exercise v2 admission" },
      execution: {
        engine: { kind: "harness-runtime" as const, adapterVersion: "harness-runtime-v2", profile: "test" },
        coordinationMode: "caseStore" as const, maxTransitions: 100, maxConcurrency: 4,
        durability: "durable" as const,
      },
      budgets: { maxDurationMs: 60_000, maxCostUsd: 1, maxModelCalls: 2, maxCapabilityCalls: 4 },
      schemas: { input: { type: "object" }, output: { type: "object" }, schemaSetDigest: digest },
      modelProfiles: [], agentProfiles: [], capabilities: [], permissionEnvelopes: [],
      policyBundles: [{ policyId: "policy.test", bundleDigest: digest }],
      contextSelectors: [],
      contextClassificationPolicies: [],
      graph: {
        apiVersion: "ladder.dev/v1alpha1" as const, name: "v2", nodeOrder: ["input"],
        nodes: [{ id: "input", kind: "input" as const, name: "Input", contextSelectorIds: [], config: {} }],
        edges: [],
      },
      releaseConstraints: { regions: ["US"], dataClasses: ["CONFIDENTIAL"], evaluationRequirementIds: ["contract"] },
      dependencyManifest: [{ kind: "policy", id: "policy.test", digest }],
      dependencyManifestDigest: digest,
      createdAt: "2026-09-19T12:00:00.000Z",
      buildProvenanceDigest: digest,
    };
    const plan = harnessPlanV2Schema.parse({ ...content, planId: "plan-v2", planDigest: stableDigest(content) });
    const { db, queries } = recordingDatabase();
    const admitted = await admitPlan(db, plan, "tenant_demo");
    expect(admitted.plan.apiVersion).toBe("harness.factory/plan-v2");
    expect(admitted.created).toBe(true);
    expect(queries).toHaveLength(1);
  });

  it("refuses a removed v1 plan before touching the database", async () => {
    const { db, queries } = recordingDatabase();
    const v1 = { ...fixturePlan(), apiVersion: "harness.factory/plan-v1" };
    await expect(admitPlan(db, v1, "tenant_demo")).rejects.toThrow(PLAN_V1_REMOVED);
    expect(queries).toHaveLength(0);
  });

  it("refuses a v2 plan compiled before agent profiles, telling the operator to recompile", async () => {
    const { agentProfiles: _profiles, ...current } = JSON.parse(readFileSync(
      new URL("../../../artifacts/archive/kyc-v2.plan.json", import.meta.url), "utf8")) as Record<string, unknown>;
    const legacy = { ...current, skills: [], agents: [] };
    const { db, queries } = recordingDatabase();
    await expect(admitPlan(db, legacy, "tenant_demo")).rejects.toThrow("plan.v2_agent_profiles_required");
    expect(queries).toHaveLength(0);
  });
});
