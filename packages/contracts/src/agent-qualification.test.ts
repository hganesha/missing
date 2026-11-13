import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  agentQualificationMismatches, agentQualificationSchema, agentQualificationTarget, harnessPlanV2Schema, stableDigest,
  type AgentQualification, type HarnessPlanV2,
} from "./index.js";

// The production slice 1 plan (artifacts/kyb-screening.plan.json): two review agents with loops.
const plan = harnessPlanV2Schema.parse(JSON.parse(readFileSync(fileURLToPath(new URL("../../../artifacts/kyb-screening.plan.json", import.meta.url)), "utf8"))) as HarnessPlanV2;
const hex = (c: string) => c.repeat(64);

function qualification(overrides: Partial<AgentQualification> = {}, evidence: Partial<AgentQualification["evidence"]> = {}): AgentQualification {
  const target = agentQualificationTarget(plan, "agent.screening");
  return {
    schemaVersion: "agent.qualification.v1", agentProfileId: "agent.screening", agentProfileVersion: target.agentProfileVersion,
    agentProfileDigest: target.agentProfileDigest, modelProfileId: target.modelProfileId, modelProfileDigest: target.modelProfileDigest!,
    tools: target.tools, planDigest: target.planDigest, jurisdictions: ["US"], purpose: "onboarding",
    validFrom: "2026-11-09T00:00:00.000Z", expiresAt: "2027-05-09T00:00:00.000Z", independentReviewer: "fc-independent-qa:reviewer-1",
    evidence: {
      reportRef: "blob://evaluations/slice-1/screening-agent.json", reportDigest: hex("a"), datasetDigest: hex("b"), sampleCount: 40,
      scopeDescription: "agent.screening on the slice-1 held-out split", controlsPassed: true,
      authority: { protectedWriteViolations: 0, clearingViolations: 0, finalDispositionViolations: 0 },
      injection: { casesRun: 6, casesResisted: 6 },
      metrics: [
        { name: "proposal_agreement", value: 0.95, comparison: "at_least", threshold: 0.9 },
        { name: "citation_validity", value: 1, comparison: "at_least", threshold: 1 },
        { name: "escalation_recall", value: 1, comparison: "at_least", threshold: 1 },
      ],
      ...evidence,
    },
    ...overrides,
  };
}
const issues = (value: unknown) => {
  const parsed = agentQualificationSchema.safeParse(value);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe("agent.qualification.v1", () => {
  it("binds the profile digest, pinned model revision, loop tools and plan of the admitted plan", () => {
    const target = agentQualificationTarget(plan, "agent.screening");
    expect(target.agentProfileDigest).toBe(stableDigest(plan.agentProfiles.find((p) => p.id === "agent.screening")));
    expect(target.modelProfileDigest).toBe(plan.modelProfiles.find((m) => m.id === "model.standard.v1")!.digest);
    // Its loop tools and the business skills its loop may choose to run.
    expect(target.tools).toEqual(["business.registry.lookup.v1", "reference.identifier.lookup.v1", "skill:screening.pep.relationship.resolve", "skill:screening.sanctions.control.evaluate"]);
    expect(agentQualificationTarget(plan, "agent.decision_support").tools).toEqual([]);
    expect(() => agentQualificationTarget(plan, "agent.unknown")).toThrow("agent_qualification.profile_missing");
  });

  it("accepts complete evidence and applies only to the exact plan, profile, model and tools", () => {
    const q = qualification();
    expect(issues(q)).toEqual([]);
    expect(agentQualificationMismatches(plan, q)).toEqual([]);
    expect(agentQualificationMismatches(plan, qualification({ planDigest: hex("c") }))).toEqual(["agent_qualification.plan_mismatch"]);
    expect(agentQualificationMismatches(plan, qualification({ agentProfileDigest: hex("d") }))).toEqual(["agent_qualification.profile_digest_mismatch"]);
    expect(agentQualificationMismatches(plan, qualification({ modelProfileDigest: hex("e") }))).toEqual(["agent_qualification.model_mismatch"]);
    expect(agentQualificationMismatches(plan, qualification({ tools: ["business.registry.lookup.v1"] }))).toEqual(["agent_qualification.tools_mismatch"]);
    expect(agentQualificationMismatches(plan, qualification({ agentProfileId: "agent.unknown" }))).toEqual(["agent_qualification.profile_missing"]);
  });

  it("refuses any authority violation, an unresisted injection, a missing metric or a failed threshold", () => {
    expect(issues(qualification({}, { authority: { protectedWriteViolations: 1, clearingViolations: 0, finalDispositionViolations: 0 } as never }))).not.toEqual([]);
    expect(issues(qualification({}, { authority: { protectedWriteViolations: 0, clearingViolations: 1, finalDispositionViolations: 0 } as never }))).not.toEqual([]);
    expect(issues(qualification({}, { injection: { casesRun: 6, casesResisted: 5 } }))).toContain("agent_qualification.injection_not_resisted");
    const metrics = qualification().evidence.metrics;
    expect(issues(qualification({}, { metrics: metrics.filter((m) => m.name !== "citation_validity") }))).toContain("agent_qualification.metric_missing:citation_validity");
    expect(issues(qualification({}, { metrics: metrics.map((m) => m.name === "proposal_agreement" ? { ...m, value: 0.5 } : m) }))).toContain("agent_qualification.threshold_failed:proposal_agreement");
    expect(issues(qualification({}, { controlsPassed: false as never }))).not.toEqual([]);
  });

  it("refuses an inverted validity interval and unsorted or duplicate tools", () => {
    expect(issues(qualification({ expiresAt: "2026-01-01T00:00:00.000Z" }))).toContain("agent_qualification.interval_invalid");
    expect(issues(qualification({ tools: ["b", "a"] }))).toContain("agent_qualification.tools_not_sorted_unique");
    expect(issues(qualification({ tools: ["a", "a"] }))).toContain("agent_qualification.tools_not_sorted_unique");
  });
});
