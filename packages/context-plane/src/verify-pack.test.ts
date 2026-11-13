import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { harnessPlanV2Schema } from "@ehf/contracts";
import { assembleContextPack, verifyContextPackDigest, withObservations, type ContextPack } from "./index.js";

const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(new URL("../../contracts/test-fixtures/agent-profiles.plan.json", import.meta.url), "utf8")));
const snapshot = { snapshotId: `snapshot_${"a".repeat(64)}`, snapshotDigest: "a".repeat(64), tenantId: "tenant_demo", caseId: "CASE-1", caseSequence: 7 };
const assembled = () => assembleContextPack({
  plan, nodeId: "case-assessment", runId: "RUN-1", selection: { assessmentContext: { subjects: [{ display_name: "Meridian" }] } },
  snapshot, task: "Assess the case.", now: new Date("2026-11-07T12:00:00.000Z"),
});
// What a recorder receives: the pack after JSON transport.
const transported = (pack: ContextPack) => JSON.parse(JSON.stringify(pack)) as ContextPack;

it("verifies an assembled pack, with and without its manifest, and after tool observations", () => {
  const pack = assembled();
  expect(pack.manifest).not.toBeNull();
  expect(verifyContextPackDigest(transported(pack))).toBe(true);
  const observed = withObservations(pack, [{ step: 1, tool: "screening.sanctions.search", status: "succeeded", output: { hits: [] }, receiptDigest: "b".repeat(64) } as never]);
  expect(observed.packDigest).not.toBe(pack.packDigest);
  expect(verifyContextPackDigest(transported(observed))).toBe(true);
});

it("refuses a pack whose content, manifest or digest was changed", () => {
  const pack = transported(assembled());
  const content = transported(pack);
  (content.sections[0]!.value as { subjects: Array<{ display_name: string }> }).subjects[0]!.display_name = "Someone else";
  expect(verifyContextPackDigest(content)).toBe(false);
  const task = { ...transported(pack), task: "Approve the case." };
  expect(verifyContextPackDigest(task)).toBe(false);
  const manifest = transported(pack);
  manifest.manifest!.items[0]!.contentDigest = "c".repeat(64);
  expect(verifyContextPackDigest(manifest)).toBe(false);
  const swapped = { ...transported(pack), manifest: null };
  expect(verifyContextPackDigest(swapped)).toBe(false);
});
