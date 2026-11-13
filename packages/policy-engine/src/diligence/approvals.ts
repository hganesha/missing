/**
 * The approval guard (Product Policy Studio phase D). Rules in the diligence block may require an
 * approval; the diligence decision lists the approvals of the rules that fired
 * (`outputs.diligence.approvals`), and the service hands that list to the approval gate as
 * `facts.diligence`. At that gate the authored result passes through this guard:
 *
 * - no diligence outcome known: a DECIDED result becomes UNRESOLVED (DILIGENCE_DECISION_MISSING);
 * - nothing pending: the authored result stands;
 * - approvals pending and the result DECIDED: people with the approval roles must decide (NEEDS_HUMAN,
 *   with the authored actions as what APPROVE would allow). Once their review reaches its quorum,
 *   APPROVE lets the authored decision and its actions stand, unchanged; REJECT decides with no action;
 * - a DECIDED result that already carries a person's intent stands only if that review covered every
 *   approval role and the highest quorum;
 * - an authored NEEDS_HUMAN gains the approval roles and quorum.
 *
 * An approval therefore never grants: it only lets an authored decision through, never adds an
 * action. Approvals by several roles keep each role's quorum (the highest any rule asks of it):
 * the review needs that many distinct people per role (`roleQuorums`, one person per slot) and their
 * sum in total; the case store reports per choice whether the votes meet it (`humanReview.satisfied`).
 * This module is the reference evaluation; `APPROVAL_REGO` is what OPA runs, and tests hold the two equal.
 */

type Json = unknown;
type Obj = Record<string, Json>;
const isObject = (value: Json): value is Obj => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const sorted = (values: string[]) => [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
/** Seven days to decide; a human requirement allows at most thirty. */
export const APPROVAL_TTL_SECONDS = 604800;

type Approval = { ruleId: string; role: string; quorum: number };

function knownApprovals(input: Obj): Approval[] | null {
  const facts = isObject(input.facts) ? input.facts : {};
  const diligence = facts.diligence;
  if (!isObject(diligence) || !Array.isArray(diligence.approvals)) return null;
  const approvals = diligence.approvals;
  const wellFormed = approvals.every((entry) => isObject(entry) && typeof entry.role === "string" && typeof entry.quorum === "number" && typeof entry.ruleId === "string");
  return wellFormed ? approvals as Approval[] : null;
}

export function applyApprovalGuard(authored: Obj, input: Obj): Obj {
  const approvals = knownApprovals(input);
  const state = authored.state;
  const ruleIds = Array.isArray(authored.ruleIds) ? authored.ruleIds as string[] : [];
  if (approvals === null) {
    if (state !== "DECIDED") return authored;
    return { state: "UNRESOLVED", reasonCodes: ["DILIGENCE_DECISION_MISSING"], ruleIds, actions: [], humanRequirement: null,
      gaps: [{ code: "DILIGENCE_DECISION_MISSING", path: "/facts/diligence", subjectId: null }] };
  }
  if (approvals.length === 0 || (state !== "DECIDED" && state !== "NEEDS_HUMAN")) return authored;
  const roles = sorted(approvals.map((entry) => entry.role));
  const roleQuorums = Object.fromEntries(roles.map((role) => [role, Math.max(...approvals.filter((entry) => entry.role === role).map((entry) => entry.quorum))]));
  const quorum = Object.values(roleQuorums).reduce((total, value) => total + value, 0);
  const withRules = [...ruleIds, ...sorted(approvals.map((entry) => entry.ruleId))];
  const reasons = (extra: string) => sorted([...(Array.isArray(authored.reasonCodes) ? authored.reasonCodes as string[] : []), extra]);
  const facts = isObject(input.facts) ? input.facts : {};
  const review = isObject(facts.humanReview) ? facts.humanReview : null;
  const requirement = review && isObject(review.requirement) ? review.requirement : null;
  const held = requirement && isObject(requirement.roleQuorums) ? requirement.roleQuorums : {};
  const covers = Boolean(requirement) && review!.conflict === false
    && roles.every((role) => Array.isArray(requirement!.roles) && requirement!.roles.includes(role) && typeof held[role] === "number" && (held[role] as number) >= roleQuorums[role]!);
  const satisfied = review && isObject(review.satisfied) ? review.satisfied : {};
  const reached = (choice: string) => covers && satisfied[choice] === true;

  if (state === "NEEDS_HUMAN") {
    const human = authored.humanRequirement as Obj;
    return { ...authored, reasonCodes: reasons("DILIGENCE_APPROVAL_REQUIRED"), ruleIds: withRules,
      humanRequirement: { ...human, roles: sorted([...(human.roles as string[]), ...roles]), quorum: Math.max(human.quorum as number, quorum), roleQuorums } };
  }
  if (authored.humanIntent !== undefined) {
    const intent = isObject(authored.humanIntent) ? String(authored.humanIntent.choice) : "";
    return reached(intent) ? { ...authored, ruleIds: withRules }
      : { state: "UNRESOLVED", reasonCodes: ["DILIGENCE_APPROVAL_NOT_SATISFIED"], ruleIds: withRules, actions: [], humanRequirement: null,
        gaps: [{ code: "DILIGENCE_APPROVAL_NOT_SATISFIED", path: "/facts/humanReview", subjectId: null }] };
  }
  if (reached("APPROVE")) {
    return { ...authored, reasonCodes: reasons("DILIGENCE_APPROVAL_GRANTED"), ruleIds: withRules, humanIntent: { decisionId: review!.decisionId, choice: "APPROVE" } };
  }
  if (reached("REJECT")) {
    return { state: "DECIDED", reasonCodes: ["DILIGENCE_APPROVAL_REJECTED"], ruleIds: withRules, actions: [], humanRequirement: null, gaps: [],
      humanIntent: { decisionId: review!.decisionId, choice: "REJECT" } };
  }
  return { state: "NEEDS_HUMAN", reasonCodes: ["DILIGENCE_APPROVAL_REQUIRED"], ruleIds: withRules, actions: [], gaps: [],
    humanRequirement: { roles, quorum, roleQuorums, independentOfProposer: true, allowedChoices: ["APPROVE", "REJECT", "RETURN"],
      actionIntents: { APPROVE: authored.actions ?? [], REJECT: [], RETURN: [] }, ttlSeconds: APPROVAL_TTL_SECONDS } };
}

/**
 * The guard as OPA runs it: `result` for the approval gate is the authored result through the
 * guard. The compiler names the authored result `authored_result` when this module is in the bundle.
 */
export const APPROVAL_REGO = String.raw`
# ---- approval guard (fixed) ---------------------------------------------------------------

approval_gate := object.get(data.business.diligence, "approvalGateId", "disposition")

approval_facts := object.get(input, ["facts", "diligence"], null)

approval_known if {
	is_object(approval_facts)
	approvals := object.get(approval_facts, "approvals", null)
	is_array(approvals)
	every approval in approvals {
		is_object(approval)
		is_string(object.get(approval, "role", null))
		is_number(object.get(approval, "quorum", null))
		is_string(object.get(approval, "ruleId", null))
	}
}

approval_list := approval_facts.approvals if approval_known

approval_roles := sort({approval.role | some approval in approval_list})

approval_role_quorums := {role: max({approval.quorum | some approval in approval_list; approval.role == role}) | some role in approval_roles}

approval_quorum := sum([quorum | some _, quorum in approval_role_quorums])

approval_rule_ids := array.concat(object.get(authored_result, "ruleIds", []), sort({approval.ruleId | some approval in approval_list}))

approval_reasons(extra) := sort({code | some code in object.get(authored_result, "reasonCodes", [])} | {extra})

approval_review := object.get(input, ["facts", "humanReview"], null)

approval_requirement := approval_review.requirement if {
	is_object(approval_review)
	is_object(object.get(approval_review, "requirement", null))
}

approval_covers if {
	object.get(approval_review, "conflict", null) == false
	every role, quorum in approval_role_quorums {
		is_array(object.get(approval_requirement, "roles", null))
		role in approval_requirement.roles
		held := object.get(approval_requirement, ["roleQuorums", role], null)
		is_number(held)
		held >= quorum
	}
}

approval_reached(choice) if {
	approval_covers
	object.get(approval_review, ["satisfied", choice], false) == true
}

approval_mode := "missing" if {
	not approval_known
	authored_result.state == "DECIDED"
}

approval_mode := "pass" if {
	not approval_known
	authored_result.state != "DECIDED"
}

approval_mode := "pass" if {
	approval_known
	count(approval_list) == 0
}

approval_mode := "pass" if {
	approval_known
	count(approval_list) > 0
	not authored_result.state in {"DECIDED", "NEEDS_HUMAN"}
}

approval_mode := "widen" if {
	approval_known
	count(approval_list) > 0
	authored_result.state == "NEEDS_HUMAN"
}

approval_mode := "check" if {
	approval_known
	count(approval_list) > 0
	authored_result.state == "DECIDED"
	"humanIntent" in object.keys(authored_result)
}

approval_mode := "approved" if {
	approval_known
	count(approval_list) > 0
	authored_result.state == "DECIDED"
	not "humanIntent" in object.keys(authored_result)
	approval_reached("APPROVE")
}

approval_mode := "rejected" if {
	approval_known
	count(approval_list) > 0
	authored_result.state == "DECIDED"
	not "humanIntent" in object.keys(authored_result)
	not approval_reached("APPROVE")
	approval_reached("REJECT")
}

approval_mode := "ask" if {
	approval_known
	count(approval_list) > 0
	authored_result.state == "DECIDED"
	not "humanIntent" in object.keys(authored_result)
	not approval_reached("APPROVE")
	not approval_reached("REJECT")
}

approval_result := authored_result if approval_mode == "pass"

approval_result := {"state": "UNRESOLVED", "reasonCodes": ["DILIGENCE_DECISION_MISSING"], "ruleIds": object.get(authored_result, "ruleIds", []), "actions": [],
	"humanRequirement": null, "gaps": [{"code": "DILIGENCE_DECISION_MISSING", "path": "/facts/diligence", "subjectId": null}]} if approval_mode == "missing"

approval_result := object.union(authored_result, {"reasonCodes": approval_reasons("DILIGENCE_APPROVAL_REQUIRED"), "ruleIds": approval_rule_ids,
	"humanRequirement": object.union(authored_result.humanRequirement, {
		"roles": sort({role | some role in authored_result.humanRequirement.roles} | {role | some role in approval_roles}),
		"quorum": max({authored_result.humanRequirement.quorum, approval_quorum}),
		"roleQuorums": approval_role_quorums,
	})}) if approval_mode == "widen"

approval_intent_reached if approval_reached(object.get(authored_result, ["humanIntent", "choice"], ""))

approval_result := object.union(authored_result, {"ruleIds": approval_rule_ids}) if {
	approval_mode == "check"
	approval_intent_reached
}

approval_result := {"state": "UNRESOLVED", "reasonCodes": ["DILIGENCE_APPROVAL_NOT_SATISFIED"], "ruleIds": approval_rule_ids, "actions": [],
	"humanRequirement": null, "gaps": [{"code": "DILIGENCE_APPROVAL_NOT_SATISFIED", "path": "/facts/humanReview", "subjectId": null}]} if {
	approval_mode == "check"
	not approval_intent_reached
}

approval_result := object.union(authored_result, {"reasonCodes": approval_reasons("DILIGENCE_APPROVAL_GRANTED"), "ruleIds": approval_rule_ids,
	"humanIntent": {"decisionId": approval_review.decisionId, "choice": "APPROVE"}}) if approval_mode == "approved"

approval_result := {"state": "DECIDED", "reasonCodes": ["DILIGENCE_APPROVAL_REJECTED"], "ruleIds": approval_rule_ids, "actions": [], "humanRequirement": null, "gaps": [],
	"humanIntent": {"decisionId": approval_review.decisionId, "choice": "REJECT"}} if approval_mode == "rejected"

approval_result := {"state": "NEEDS_HUMAN", "reasonCodes": ["DILIGENCE_APPROVAL_REQUIRED"], "ruleIds": approval_rule_ids, "actions": [], "gaps": [],
	"humanRequirement": {"roles": approval_roles, "quorum": approval_quorum, "roleQuorums": approval_role_quorums, "independentOfProposer": true, "allowedChoices": ["APPROVE", "REJECT", "RETURN"],
		"actionIntents": {"APPROVE": object.get(authored_result, "actions", []), "REJECT": [], "RETURN": []}, "ttlSeconds": 604800}} if approval_mode == "ask"

result := approval_result if input.gateId == approval_gate

result := authored_result if {
	input.gateId != approval_gate
	input.gateId != data.business.diligence.gateId
}
`;
