/**
 * Answer keys for the agentic flows' agents (delivery plan wave 5), derived only from a corpus hero's
 * scenario facts: its `expectations.yaml` (screening hits, beneficial owners, the expected workflow
 * outcome, hard negatives) and `documents.expected.yaml` (planted document defects and missing
 * documents). Nothing here reads what the system under test produced to decide what is right.
 *
 * Each check names the agent it scores. A check is only written where the facts settle it; what needs
 * a policy the corpus does not state (a risk tier, a per-party document requirement) is left unscored.
 */

/** The hero facts the keys read (fixtures/context-corpus/parties/<hero>/expectations.yaml). */
export type HeroExpectations = {
  party_id: string;
  hard_negative?: boolean | null;
  beneficial_owners?: string[] | null;
  screening_result?: { hits?: Array<{ entry: string; record: string; subject: string; list_type: string; verified_match: boolean; identifier_conflict: boolean }> } | null;
  workflow?: Record<string, string> | null;
};
/** The planted document defects (documents.expected.yaml). */
export type DocumentExpectations = {
  documents: Array<{ document_id: string; document_version: string; document_type: string; subject: string; defects: Array<{ finding: string; field: string; stated: string; record: string }> }>;
  missing?: Array<{ type: string; subject: string }>;
};
export type AgentAnswer = { agent: string; output?: Record<string, any> | undefined; error?: string | undefined };
export type AnswerKeyCheck = { agent: string; check: string; passed: boolean; detail: string };
export type AnswerKeyResult = { passed: number; total: number; checks: AnswerKeyCheck[]; unscored: Array<{ agent: string; check: string; observed: unknown }> };

const text = (value: unknown) => JSON.stringify(value ?? "").toLowerCase();
/** An agent reference names a corpus object by its id's last segment (`h04.entity.gareth` → gareth). */
const names = (ref: unknown, key: string) => typeof ref === "string" && (ref === key || ref.toLowerCase().endsWith(`.${key.toLowerCase()}`));

/** The onboarding outcome the hero's facts expect: `kyc_v2` for an individual, `kyb` for a business. */
function expectedOutcome(facts: HeroExpectations): string | null {
  return facts.workflow?.kyb ?? facts.workflow?.kyc_v2 ?? null;
}

export function scoreAgentAnswers(input: {
  customerType: "individual" | "corporate";
  facts: HeroExpectations;
  documents?: DocumentExpectations | null;
  answers: AgentAnswer[];
}): AnswerKeyResult {
  const checks: AnswerKeyCheck[] = [];
  const unscored: AnswerKeyResult["unscored"] = [];
  const answer = (agent: string) => input.answers.find((item) => item.agent === agent);
  const add = (agent: string, check: string, passed: boolean, detail: string) => checks.push({ agent, check, passed, detail });

  // Every agent that ran answered within its schema (the loop validates; an error is a failed run).
  for (const item of input.answers) add(item.agent, "answered within its output schema", Boolean(item.output) && !item.error, item.error ?? "answered");

  const intake = answer("agent.intake_profile");
  if (intake?.output) add(intake.agent, `customer type ${input.customerType}`, intake.output.profile?.customerType === input.customerType, `agent: ${intake.output.profile?.customerType}`);

  // Documents: the planted defects (the document and identity agents, as in the first live runs).
  const document = answer("agent.document_intelligence");
  const identity = answer("agent.identity_verification");
  for (const doc of input.documents?.documents ?? []) {
    if (!document) break;
    const stated = (document.output?.documents ?? []).find((item: any) => text(item.documentRef).includes(doc.document_id.toLowerCase()) || text(item.documentRef).includes(doc.document_version.slice(0, 12)));
    add(document.agent, `document ${doc.document_id} typed ${doc.document_type}`, stated?.documentType === doc.document_type, stated ? `agent: ${stated.documentType}, ${stated.validity}` : "not in the agent's documents");
    // No check here establishes authenticity: a document is never reported authentic (wave 4).
    if (stated?.authenticity !== undefined) add(document.agent, `${doc.document_id} authenticity not asserted`, ["NOT_CHECKED", "INCONCLUSIVE", "SIGNAL"].includes(stated.authenticity), `agent: ${stated.authenticity}`);
    for (const defect of doc.defects) {
      if (defect.finding === "DOCUMENT_EXPIRED") {
        add(document.agent, `${doc.document_id} expired (${defect.stated})`, stated?.validity === "EXPIRED", stated ? `agent validity ${stated.validity}` : "not reported");
        continue;
      }
      // A conflict between a document and a record is the identity agent's; the document agent may report it too.
      const found = [identity, document].some((entry) => {
        const conflicts = (entry?.output?.documentChecks ?? []).filter((item: any) => item.outcome === "CONFLICT" && text(item.field).includes(defect.field.split("_")[0]!));
        return conflicts.length > 0 || text(entry?.output?.findings).includes(defect.stated.toLowerCase());
      });
      add(identity?.agent ?? document.agent, `${defect.finding} on ${defect.field} (${defect.stated} vs ${defect.record})`, found, found ? "reported" : "not reported");
    }
  }
  for (const missing of input.documents?.missing ?? []) {
    // Per-party document requirements are not expressible in document.requirements.resolve's policy yet.
    unscored.push({ agent: "agent.document_intelligence", check: `request for missing ${missing.type} (${missing.subject})`, observed: (document?.output?.requests ?? []).some((item: any) => item.documentType === missing.type) });
  }

  // Ownership: every beneficial owner the facts name is reported (a business only).
  const ownership = answer("agent.identity_ownership");
  if (ownership?.output && input.customerType === "corporate") {
    for (const owner of input.facts.beneficial_owners ?? []) {
      const reported = (ownership.output.beneficialOwners ?? []).some((item: any) => names(item.entityRef, owner));
      add(ownership.agent, `beneficial owner ${owner} reported`, reported, reported ? "reported" : `agent: ${(ownership.output.beneficialOwners ?? []).map((item: any) => item.entityRef).join(", ") || "none"}`);
    }
  }

  // Screening: each list hit is proposed for review, never cleared or confirmed against the facts.
  const screening = answer("agent.screening");
  const hits = input.facts.screening_result?.hits ?? [];
  if (screening?.output) {
    for (const hit of hits) {
      const proposal = (screening.output.proposals ?? []).find((item: any) => text(item.hitRef).includes(hit.record.toLowerCase()) || text(item.hitRef).includes(hit.entry.toLowerCase()) || text(item.sourceRefs).includes(hit.record.toLowerCase()));
      add(screening.agent, `hit ${hit.entry} on ${hit.subject} proposed`, Boolean(proposal), proposal ? `agent: ${proposal.proposal}` : "no proposal for the hit");
      if (!proposal) continue;
      if (hit.identifier_conflict) add(screening.agent, `hit ${hit.entry}: identifiers conflict, not proposed as a true match`, proposal.proposal !== "LIKELY_TRUE_MATCH", `agent: ${proposal.proposal}`);
      if (hit.verified_match) add(screening.agent, `hit ${hit.entry}: a verified match, not proposed as a false match`, proposal.proposal !== "FALSE_MATCH_CANDIDATE", `agent: ${proposal.proposal}`);
    }
    if (hits.length) add(screening.agent, "a hit is left to a person", screening.output.requiresHumanReview === true, `requiresHumanReview ${screening.output.requiresHumanReview}`);
    if (input.facts.hard_negative && !hits.length) {
      const blocking = (screening.output.findings ?? []).filter((item: any) => item.severity === "BLOCKING");
      add(screening.agent, "a clean hero raises no blocking screening finding", blocking.length === 0, blocking.map((item: any) => item.type).join(", ") || "none");
    }
  }

  // Risk: EDD where the facts require it; a clean hero is not proposed high risk.
  const outcome = expectedOutcome(input.facts);
  const risk = answer("agent.risk_edd");
  if (risk?.output) {
    if (outcome === "EDD_REQUIRED") add(risk.agent, "EDD recommended", risk.output.eddRecommended === true, `agent: eddRecommended ${risk.output.eddRecommended}`);
    if (input.facts.hard_negative) add(risk.agent, "a clean hero is not proposed HIGH", risk.output.proposedTier !== "HIGH", `agent: ${risk.output.proposedTier}`);
    unscored.push({ agent: risk.agent, check: "proposed tier (needs the pinned policy's tiering)", observed: risk.output.proposedTier });
  }

  // Investigation: a clean hero carries no relevant allegation.
  const investigation = answer("agent.investigation");
  if (investigation?.output && input.facts.hard_negative) {
    const relevant = (investigation.output.allegations ?? []).filter((item: any) => item.relevance === "RELEVANT" && item.status === "ALLEGATION");
    add(investigation.agent, "a clean hero carries no relevant allegation", relevant.length === 0, relevant.map((item: any) => item.category).join(", ") || "none");
  }

  // Decision support: never decides, and its recommendation agrees with the facts' direction.
  const decision = answer("agent.decision_support");
  if (decision?.output) {
    const recommendation = decision.output.recommendation as string;
    add(decision.agent, "proposes, never decides", decision.output.final === false && decision.output.requiresHumanReview === true, `final ${decision.output.final}, requiresHumanReview ${decision.output.requiresHumanReview}`);
    if (outcome && /^APPROVE|^REVIEW_THEN_CLEAR$/.test(outcome)) add(decision.agent, `${outcome}: not a decline`, recommendation !== "RECOMMEND_DECLINE", `agent: ${recommendation}`);
    if (outcome === "EDD_REQUIRED") add(decision.agent, `${outcome}: not proposed for acceptance as is`, recommendation !== "REVIEW_FOR_ACCEPTANCE", `agent: ${recommendation}`);
    if (outcome?.startsWith("BLOCK")) add(decision.agent, `${outcome}: declined or escalated`, recommendation === "RECOMMEND_DECLINE" || recommendation === "ESCALATE", `agent: ${recommendation}`);
  }

  for (const agent of ["agent.relationship_product", "agent.qa_assurance"]) {
    const item = answer(agent);
    if (item?.output) unscored.push({ agent, check: "no scenario fact settles this agent's answer", observed: agent === "agent.qa_assurance" ? { passed: item.output.passed, challenges: (item.output.challenges ?? []).length } : { products: item.output.products } });
  }
  return { passed: checks.filter((item) => item.passed).length, total: checks.length, checks, unscored };
}
