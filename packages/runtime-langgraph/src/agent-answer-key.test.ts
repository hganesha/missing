import { describe, expect, it } from "vitest";
import { scoreAgentAnswers, type HeroExpectations } from "./agent-answer-key.js";

// The answer keys (delivery plan wave 5) are derived from a hero's scenario facts alone.
const verdicts = (result: ReturnType<typeof scoreAgentAnswers>) => Object.fromEntries(result.checks.map((check) => [`${check.agent}: ${check.check}`, check.passed]));

describe("agent answer keys", () => {
  const pep: HeroExpectations = {
    party_id: "H03", workflow: { kyc_v2: "EDD_REQUIRED" },
    screening_result: { hits: [{ entry: "synthetic-peps:SYN-P-0001", record: "h03.screeninghit.chidi-synthetic-peps-syn-p-0001", subject: "chidi", list_type: "pep", verified_match: true, identifier_conflict: false }] },
  };

  it("scores a verified PEP hit, EDD and decision support from the facts", () => {
    const answers = [
      { agent: "agent.screening", output: { requiresHumanReview: true, findings: [], proposals: [{ hitRef: "h03.screeninghit.chidi-synthetic-peps-syn-p-0001", proposal: "FALSE_MATCH_CANDIDATE" }] } },
      { agent: "agent.risk_edd", output: { eddRecommended: true, proposedTier: "HIGH" } },
      { agent: "agent.decision_support", output: { recommendation: "REVIEW_FOR_ACCEPTANCE", final: false, requiresHumanReview: true } },
    ];
    const result = verdicts(scoreAgentAnswers({ customerType: "individual", facts: pep, answers }));
    expect(result["agent.screening: hit synthetic-peps:SYN-P-0001 on chidi proposed"]).toBe(true);
    // A verified match proposed as a false match fails, whatever the agent's reasons.
    expect(result["agent.screening: hit synthetic-peps:SYN-P-0001: a verified match, not proposed as a false match"]).toBe(false);
    expect(result["agent.risk_edd: EDD recommended"]).toBe(true);
    expect(result["agent.decision_support: EDD_REQUIRED: not proposed for acceptance as is"]).toBe(false);
  });

  it("keeps a clean hero clean and leaves what needs policy unscored", () => {
    const clean: HeroExpectations = { party_id: "H04", hard_negative: true, workflow: { kyb: "APPROVE" }, beneficial_owners: ["gareth", "priya"], screening_result: { hits: [] } };
    const answers = [
      { agent: "agent.identity_ownership", output: { beneficialOwners: [{ entityRef: "h04.entity.gareth" }, { entityRef: "h04.beneficialowner.priya" }] } },
      { agent: "agent.screening", output: { findings: [{ type: "X", severity: "BLOCKING" }], proposals: [] } },
      { agent: "agent.risk_edd", output: { eddRecommended: false, proposedTier: "MEDIUM" } },
      { agent: "agent.decision_support", output: { recommendation: "RECOMMEND_DECLINE", final: false, requiresHumanReview: true } },
      { agent: "agent.relationship_product", error: "replay.model_call_not_recorded" },
    ];
    const scored = scoreAgentAnswers({ customerType: "corporate", facts: clean, answers });
    const result = verdicts(scored);
    expect(result["agent.identity_ownership: beneficial owner gareth reported"]).toBe(true);
    expect(result["agent.identity_ownership: beneficial owner priya reported"]).toBe(true);
    expect(result["agent.screening: a clean hero raises no blocking screening finding"]).toBe(false);
    expect(result["agent.risk_edd: a clean hero is not proposed HIGH"]).toBe(true);
    expect(result["agent.decision_support: APPROVE: not a decline"]).toBe(false);
    expect(result["agent.relationship_product: answered within its output schema"]).toBe(false);
    expect(scored.unscored.map((item) => item.check)).toContain("proposed tier (needs the pinned policy's tiering)");
  });

  it("matches a beneficial owner by its id's last segment, never by a substring", () => {
    const facts: HeroExpectations = { party_id: "H06", workflow: { kyb: "BLOCK_SANCTIONS_OWNERSHIP" }, beneficial_owners: ["c"] };
    const scored = verdicts(scoreAgentAnswers({ customerType: "corporate", facts, answers: [{ agent: "agent.identity_ownership", output: { beneficialOwners: [{ entityRef: "h06.entity.seabright-c" }] } }] }));
    expect(scored["agent.identity_ownership: beneficial owner c reported"]).toBe(false);
  });
});
