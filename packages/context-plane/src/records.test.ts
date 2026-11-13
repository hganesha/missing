import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { harnessPlanV2Schema, type ContextSelector, type HarnessPlanV2 } from "@ehf/contracts";
import { assembleContextPack, buildSkillCapabilityInput, selectRecordSection } from "./index.js";

const registrySelector: ContextSelector = {
  id: "registryRecords", source: "case", path: "records.RegistryRecord", purpose: "KYC_SCREENING", classification: "PII", required: true,
  record: { objectType: "RegistryRecord", fields: ["registration_id", "status", "coverage"], minCount: 1, maxAgeSeconds: 86_400 },
};
const asOf = "2026-11-07T12:00:00.000Z";

function registry(objectId: string, data: Record<string, unknown>, observedAt = "2026-11-07T08:00:00.000Z") {
  return { object_type: "RegistryRecord", object_id: objectId, version_id: "v1", data, observed_at: observedAt, synthetic: true, source_refs: [], record_digest: "f".repeat(64) };
}

const complete = registry("registry:gb:1", { registration_id: "1", status: "ACTIVE", coverage: { complete: true } });

describe("record requirement selection", () => {
  it("admit records that carry every required field and are fresh enough", () => {
    expect(selectRecordSection(registrySelector, [complete], asOf)).toEqual({ records: [complete], gaps: [] });
  });

  it("report a record lacking a field as CONTEXT_MISSING and an empty selection as under the minimum", () => {
    const partial = registry("registry:gb:2", { registration_id: "2", status: null, coverage: {} });
    const result = selectRecordSection(registrySelector, [partial], asOf);
    expect(result.records).toEqual([]);
    expect(result.gaps).toEqual([
      expect.objectContaining({ code: "CONTEXT_MISSING", objectId: "registry:gb:2", fields: ["status"], required: true }),
      expect.objectContaining({ code: "CONTEXT_MISSING", found: 0, minCount: 1 }),
    ]);
    expect(selectRecordSection(registrySelector, [], asOf).gaps).toEqual([expect.objectContaining({ code: "CONTEXT_MISSING", found: 0 })]);
    expect(selectRecordSection(registrySelector, undefined, asOf).gaps).toHaveLength(1);
  });

  it("report a record older than max age (or observed after as-of) as CONTEXT_STALE", () => {
    const old = registry("registry:gb:3", complete.data, "2026-11-01T00:00:00.000Z");
    const future = registry("registry:gb:4", complete.data, "2026-11-08T00:00:00.000Z");
    const result = selectRecordSection(registrySelector, [old, future, complete], asOf);
    expect(result.records).toEqual([complete]);
    expect(result.gaps.map((gap) => [gap.code, gap.objectId])).toEqual([["CONTEXT_STALE", "registry:gb:3"], ["CONTEXT_STALE", "registry:gb:4"]]);
  });

  it("honour an optional requirement with no minimum", () => {
    const optional = { ...registrySelector, required: false, record: { ...registrySelector.record!, minCount: 0 } };
    expect(selectRecordSection(optional, [], asOf)).toEqual({ records: [], gaps: [] });
  });
});

describe("record sections in a context pack", () => {
  const base = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../contracts/test-fixtures/skill-hosted.plan.json", import.meta.url), "utf8")));
  const plan: HarnessPlanV2 = {
    ...base,
    contextSelectors: [...base.contextSelectors, { ...registrySelector, purpose: "KYC_ONBOARDING" }],
    graph: { ...base.graph, nodes: base.graph.nodes.map((node) => node.id === "registry-verify" ? { ...node, contextSelectorIds: ["subject", "registryRecords"] } : node) },
  };
  const snapshot = { snapshotId: `snapshot_${"b".repeat(64)}`, snapshotDigest: "b".repeat(64), tenantId: "tenant-1", caseId: "case-1", caseSequence: 5 };
  const envelope = { tenantId: "tenant-1", caseId: "case-1", subjectRefs: ["subject:S-1"], jurisdiction: "GB", actor: "workload:runtime/w", policySnapshotRef: "policy-snapshot:x", asOfTime: asOf };
  const invocation = { executionId: "3f1c2d4e-5a6b-8c7d-9e0f-112233445566", parameters: {}, purpose: "onboarding" as const, idempotencyKey: "RUN-1:registry-verify:1", traceId: "RUN-1" };

  it("carry admitted records as an untrusted section and build the skill input from them", () => {
    const pack = assembleContextPack({ plan, nodeId: "registry-verify", runId: "RUN-1", snapshot, envelope,
      selection: { subject: "Meridian Trade Holdings Ltd", registryRecords: [complete] } });
    expect(pack.recordGaps).toEqual([]);
    const section = pack.sections.find((item) => item.id === "registryRecords")!;
    expect(section).toMatchObject({ trust: "UNTRUSTED_EXTERNAL", provenanceRef: "case:case-1@5/case:records.RegistryRecord", value: [complete] });
    const built = buildSkillCapabilityInput(pack, invocation);
    expect(built.status).toBe("ready");
    if (built.status !== "ready") return;
    expect(built.input.context.sections.find((item) => item.id === "registryRecords")).toMatchObject({ value: [complete], content_digest: `sha256:${section.contentDigest}` });
    expect(built.input.input).toMatchObject({ tenant_id: "tenant-1", case_id: "case-1", subject_refs: ["subject:S-1"], purpose: "onboarding" });
    expect(built.input.context.missing).toEqual([]);
  });

  it("block the skill on a required record gap instead of building an input", () => {
    const pack = assembleContextPack({ plan, nodeId: "registry-verify", runId: "RUN-1", snapshot, envelope, selection: { subject: "Meridian", registryRecords: [] } });
    expect(pack.recordGaps).toEqual([expect.objectContaining({ selector: "registryRecords", code: "CONTEXT_MISSING" })]);
    expect(buildSkillCapabilityInput(pack, invocation)).toMatchObject({ status: "blocked", code: "CONTEXT_MISSING" });
    const stale = assembleContextPack({ plan, nodeId: "registry-verify", runId: "RUN-1", snapshot, envelope,
      selection: { subject: "Meridian", registryRecords: [registry("registry:gb:9", complete.data, "2026-10-01T00:00:00.000Z")] } });
    expect(buildSkillCapabilityInput(stale, invocation)).toMatchObject({ status: "blocked", code: "CONTEXT_STALE", recordGaps: [expect.objectContaining({ code: "CONTEXT_STALE" }), expect.anything()] });
  });

  it("leave packs of nodes without record selectors unchanged", () => {
    const pack = assembleContextPack({ plan: base, nodeId: "registry-verify", runId: "RUN-1", snapshot, envelope, selection: { subject: "Meridian" } });
    expect(pack).not.toHaveProperty("recordGaps");
  });
});

it("does not let one subject's records satisfy another subject's declared minimum", () => {
  const record = { ...complete, subject_ids: ["subject-a"] };
  const result = selectRecordSection(registrySelector, [record], asOf, ["subject-a", "subject-b"]);
  expect(result.gaps).toEqual([expect.objectContaining({ subjectId: "subject-b", found: 0, minCount: 1, code: "CONTEXT_MISSING" })]);
});
