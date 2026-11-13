import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { chooseSkillPolicy, resolveSkillPolicySection } from "@ehf/context-plane";
import { projectPackForSkill, type EffectivePolicyPack } from "@ehf/policy-engine";
import { evaluatePackCheckpoint } from "./index.js";

// Per-case policy packs at run time (agentic plan phase 2): a node pins one projection per pack and
// the case's pin chooses; a pack checkpoint evaluates the pinned pack over canonical records.
const load = (id: string) => JSON.parse(readFileSync(new URL(`../../../artifacts/policy/packs/${id}.json`, import.meta.url), "utf8")) as EffectivePolicyPack;
const US = load("policy.pack.us.bank-synthetic.business-banking");
const GB = load("policy.pack.gb.bank-synthetic.business-banking");
const pin = (pack: EffectivePolicyPack) => ({ policyId: pack.id, policyVersion: pack.version, policyBundleDigest: pack.digest, policySnapshotDigest: "d".repeat(64) });

const records: Record<string, unknown[]> = {};
for (const line of readFileSync(new URL("../../../fixtures/context-corpus/parties/H04/records.jsonl", import.meta.url), "utf8").split("\n").filter(Boolean)) {
  const record = JSON.parse(line) as { object_type: string };
  (records[record.object_type] ??= []).push(record);
}
const selection = { rel: records.BankingRelationship, exec: records.ScreeningExecution, own: records.OwnershipInterest, bo: records.BeneficialOwner, ver: records.VerificationRecord };
const recordSelectors = { BankingRelationship: "rel", ScreeningExecution: "exec", OwnershipInterest: "own", BeneficialOwner: "bo", VerificationRecord: "ver" };
const snapshot = (pack: EffectivePolicyPack | null) => ({ capturedAt: "2026-09-30T00:00:00Z", policyAuthority: pack ? pin(pack) : null });

describe("per-case skill policy", () => {
  const fields = ["ownership_threshold", "control_bases", "jurisdiction", "version"];
  const alternatives = [US, GB].map((pack) => projectPackForSkill(pack, fields));

  it("uses the projection of the pack the case is pinned to", () => {
    for (const pack of [US, GB]) {
      const chosen = chooseSkillPolicy(undefined, alternatives, pin(pack));
      const resolved = resolveSkillPolicySection({ config: chosen, authority: pin(pack), purpose: "KYB_ONBOARDING" });
      expect(resolved.status).toBe("ready");
      expect(JSON.stringify(resolved)).toContain(pack.values.jurisdiction as string);
    }
  });

  it("never lets a case run under a pack its plan did not pin", () => {
    const other = { ...pin(US), policyBundleDigest: "e".repeat(64) };
    const chosen = chooseSkillPolicy(undefined, alternatives, other);
    expect(resolveSkillPolicySection({ config: chosen, authority: other, purpose: "KYB_ONBOARDING" }).status).toBe("unresolved");
    // A node with a single projection behaves exactly as before.
    expect(chooseSkillPolicy(alternatives[0], undefined, pin(GB))).toBe(alternatives[0]);
  });
});

describe("pack checkpoint", () => {
  const config = (gateId: "intake-ready" | "decision-ready" | "disposition") => ({ gateId, packs: [US, GB], recordSelectors });

  it("evaluates the pack the case is pinned to, in either jurisdiction", () => {
    expect(evaluatePackCheckpoint(config("intake-ready"), selection, snapshot(US))).toMatchObject({ outcome: "ALLOW", packId: US.id });
    expect(evaluatePackCheckpoint(config("intake-ready"), selection, snapshot(GB))).toMatchObject({ outcome: "ALLOW", packId: GB.id });
    // H04 is clean: every subject is searched for each type its products require, so it is decision-ready.
    expect(evaluatePackCheckpoint(config("decision-ready"), selection, snapshot(US))).toMatchObject({ outcome: "ALLOW", reasonCodes: [] });
    // Its acquiring product requires an adverse-media search: without one it is not.
    const withoutMedia = { ...selection, exec: (selection.exec ?? []).filter((record) => (record as { data: { screening_type: string } }).data.screening_type !== "adverse_media") };
    expect(evaluatePackCheckpoint(config("decision-ready"), withoutMedia, snapshot(US))).toMatchObject({ outcome: "REVIEW", reasonCodes: ["SCREENING_INCOMPLETE"] });
    expect(evaluatePackCheckpoint(config("disposition"), selection, snapshot(US))).toMatchObject({ outcome: "REVIEW", details: { dualControlRequired: true } });
  });

  it("is UNKNOWN without a pin or with a pin to an unpinned pack, and refuses a tampered pack", () => {
    expect(evaluatePackCheckpoint(config("intake-ready"), selection, snapshot(null))).toMatchObject({ outcome: "UNKNOWN", reasonCodes: ["POLICY_PACK_NOT_PINNED"] });
    expect(evaluatePackCheckpoint({ ...config("intake-ready"), packs: [US] }, selection, snapshot(GB)).outcome).toBe("UNKNOWN");
    const tampered = { ...US, values: { ...US.values, screening_threshold: 0.99 } };
    expect(() => evaluatePackCheckpoint({ ...config("intake-ready"), packs: [tampered] }, selection, snapshot(US))).toThrow("runtime.policy_pack_digest_mismatch");
  });

  it("is UNKNOWN when the relationship that names the customer type is missing", () => {
    expect(evaluatePackCheckpoint(config("intake-ready"), { ...selection, rel: [] }, snapshot(US))).toMatchObject({ outcome: "UNKNOWN", reasonCodes: ["CUSTOMER_TYPE_OUT_OF_SCOPE"] });
  });
});
