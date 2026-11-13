import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { contextEnvelopeV1Schema, harnessPlanV2Schema } from "@ehf/contracts";
import { assembleContextPack, permittedProviders, renderContextPrompt, withObservations } from "./index.js";

const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../contracts/test-fixtures/skill-bound.plan.json", import.meta.url), "utf8")));
const kycPlan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../contracts/test-fixtures/agent-profiles.plan.json", import.meta.url), "utf8")));
const snapshot = { snapshotId: `snapshot_${"b".repeat(64)}`, snapshotDigest: "b".repeat(64), tenantId: "tenant_demo", caseId: "CASE-9", caseSequence: 3 };
const envelope = {
  subjectRefs: ["party:P-1"], jurisdiction: "US", actor: "runtime:worker-1", policySnapshotRef: "policy:policy.kyc.customer-acceptance.v1@1.0.0",
  asOfTime: "2026-11-07T12:00:00Z", freshnessRequirements: { WatchlistEntry: "P1D" },
};
const base = { plan, nodeId: "sanctions-screen", runId: "RUN-1", selection: { name: "Acme Holdings" }, snapshot, now: new Date("2026-11-07T12:00:00Z") };

describe("ContextEnvelope.v1", () => {
  it("emits a complete envelope whose context_hash is the pack digest", () => {
    const pack = assembleContextPack({ ...base, envelope });
    expect(pack.contextGaps).toEqual([]);
    const parsed = contextEnvelopeV1Schema.parse(pack.contextEnvelope);
    expect(parsed).toMatchObject({
      tenant_id: "tenant_demo", case_id: "CASE-9", subject_refs: ["party:P-1"], jurisdiction: "US", purpose: "KYC_SCREENING",
      actor: "runtime:worker-1", object_refs: ["case:CASE-9@3/case:subjects.0.display_name"], evidence_refs: [], graph_scope: null,
      freshness_requirements: { WatchlistEntry: "P1D" }, correlation_id: "RUN-1:sanctions-screen",
    });
    expect(parsed.context_hash).toBe(pack.packDigest);
    expect(pack.contextHash).toBe(pack.packDigest);
  });

  it("limits permitted providers to the node's pinned skill candidates", () => {
    expect(permittedProviders(plan, "sanctions-screen")).toEqual([
      "opensanctions:sanctions", "wiring:dow-jones-risk-compliance:screening.sanctions", "wiring:opensanctions:screening.sanctions",
    ]);
    expect(permittedProviders(plan, "pep-screen")).toEqual(["opensanctions:pep", "wiring:opensanctions:screening.pep"]);
    expect(permittedProviders(kycPlan, "sanctions-screen")).toEqual(["opensanctions:sanctions"]);
  });

  it("reports missing required context instead of emitting empty values", () => {
    const pack = assembleContextPack({ ...base, envelope: { ...envelope, subjectRefs: [], jurisdiction: "  " } });
    expect(pack.contextEnvelope).toBeNull();
    expect(pack.contextGaps.map((gap) => gap.field)).toEqual(["subject_refs", "jurisdiction"]);
    expect(pack.contextGaps.every((gap) => gap.code === "CONTEXT_MISSING")).toBe(true);
    expect(pack.envelopeFields).not.toHaveProperty("subject_refs");
    expect(pack.envelopeFields).not.toHaveProperty("jurisdiction");
    expect(renderContextPrompt(pack)).toContain("Context the platform could not establish: subject_refs, jurisdiction.");

    const bare = assembleContextPack({ ...base, snapshot: null });
    expect(bare.contextGaps.map((gap) => gap.field)).toEqual(expect.arrayContaining(["tenant_id", "case_id", "actor", "policy_snapshot_ref", "as_of_time"]));
  });

  it("covers the envelope in the pack digest and re-seals it after observations", () => {
    const first = assembleContextPack({ ...base, envelope });
    const other = assembleContextPack({ ...base, envelope: { ...envelope, jurisdiction: "GB" } });
    expect(other.packDigest).not.toBe(first.packDigest);
    const observed = withObservations(first, [{ step: 1, tool: "screening.sanctions.v1", status: "succeeded", value: { alerts: [] } }]);
    expect(observed.contextHash).toBe(observed.packDigest);
    expect(observed.contextEnvelope?.context_hash).toBe(observed.packDigest);
    expect(observed.packDigest).not.toBe(first.packDigest);
  });
});
