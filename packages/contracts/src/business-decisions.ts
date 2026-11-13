import { z } from "zod";

const id = z.string().min(1).max(200);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const instant = z.iso.datetime();
const ids = z.array(id).max(200).refine(v => new Set(v).size === v.length, "decision.duplicate_reference");

/** Registry of consequential sinks. Proposal/observation names do not confer authority. */
export const PROTECTED_BUSINESS_COMMANDS = [
  "AcceptClaimAsFact", "ResolveContradiction", "ProposeWorkItem", "CompleteWorkItem",
  "RecordGateResult", "RecordQAResult", "RecordReview", "RequestHumanReview",
  "TransitionCaseStatus", "FinalizeDisposition",
] as const;
/**
 * Commands only the control plane issues, under its own authority rather than a policy grant: moving
 * a case onto the process its policy escalated it to (case.replan, with the escalation's work item
 * open). Neither a business action a policy may authorize nor an observation.
 */
export const CONTROL_PLANE_COMMANDS = ["ReplanCase"] as const;
/**
 * Commands a person issues under a supervisory role's own authority (case.assign): who works a case.
 * No policy may authorize one and no agent or skill may issue one; the case API requires a human.
 */
export const SUPERVISORY_COMMANDS = ["AssignCase"] as const;
export const protectedBusinessCommandSchema = z.enum(PROTECTED_BUSINESS_COMMANDS);
export function isProtectedBusinessCommand(command: string): boolean {
  return (PROTECTED_BUSINESS_COMMANDS as readonly string[]).includes(command);
}

export const decisionStateSchema = z.enum(["DECIDED", "NEEDS_EVIDENCE", "NEEDS_HUMAN", "NOT_APPLICABLE", "UNRESOLVED"]);
/** Exact command payloads are fingerprinted after server-side template resolution. */
export const businessActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("case_command"), commandType: protectedBusinessCommandSchema,
    payload: z.record(z.string(), z.json()) }).strict(),
  z.object({ kind: z.literal("external_action"), action: z.enum(["regulatory.filing.submit", "evidence.retention.delete"]),
    payload: z.record(z.string(), z.json()) }).strict(),
  z.object({ kind: z.literal("adopt_assessment"), objectType: id, objectId: id, versionId: id,
    interpretation: id, value: z.json() }).strict(),
]);
export type BusinessAction = z.infer<typeof businessActionSchema>;

export const humanRequirementSchema = z.object({
  roles: ids.refine(v => v.length > 0), quorum: z.number().int().min(1).max(10),
  /**
   * Per-role quorums (approvals by several roles): each listed role needs that many distinct people
   * holding it, and one person fills one role's slot. `quorum` is the total and is at least their sum.
   */
  roleQuorums: z.record(id, z.number().int().min(1).max(10)).optional(),
  independentOfProposer: z.boolean(), allowedChoices: z.array(z.enum(["APPROVE", "REJECT", "RETURN"])).min(1),
  actionIntents: z.partialRecord(z.enum(["APPROVE","REJECT","RETURN"]),z.array(businessActionSchema).max(200)),
  ttlSeconds: z.number().int().min(1).max(30 * 86400),
}).strict().superRefine((requirement,ctx)=>{
  if(new Set(requirement.allowedChoices).size!==requirement.allowedChoices.length || requirement.allowedChoices.some(choice=>!Object.hasOwn(requirement.actionIntents,choice))
    || Object.keys(requirement.actionIntents).some(choice=>!requirement.allowedChoices.includes(choice as "APPROVE"|"REJECT"|"RETURN")))
    ctx.addIssue({code:"custom",message:"decision.human_intent_choices_mismatch"});
  if(requirement.roleQuorums){
    const entries=Object.entries(requirement.roleQuorums);
    if(!entries.length || entries.some(([role])=>!requirement.roles.includes(role))
      || entries.reduce((total,[,quorum])=>total+quorum,0)>requirement.quorum)
      ctx.addIssue({code:"custom",message:"decision.human_role_quorums_invalid"});
  }
});

type Voter = { principalId: string; roles: readonly string[] };
/**
 * Whether distinct people can fill every role's slots: `roleQuorums[role]` people holding the role,
 * one person in one slot (bipartite matching). A reviewer with two roles counts once.
 */
export function roleQuorumsMet(roleQuorums: Readonly<Record<string, number>>, voters: readonly Voter[]): boolean {
  const slots = Object.entries(roleQuorums).sort(([a], [b]) => a.localeCompare(b)).flatMap(([role, quorum]) => Array.from({ length: quorum }, () => role));
  const people = [...new Map(voters.map((voter) => [voter.principalId, voter])).values()];
  if (people.length < slots.length) return false;
  const holder: Array<number | null> = slots.map(() => null);
  const assign = (person: number, seen: Set<number>): boolean => {
    for (let slot = 0; slot < slots.length; slot++) {
      if (seen.has(slot) || !people[person]!.roles.includes(slots[slot]!)) continue;
      seen.add(slot);
      if (holder[slot] === null || assign(holder[slot]!, seen)) { holder[slot] = person; return true; }
    }
    return false;
  };
  for (let person = 0; person < people.length; person++) assign(person, new Set());
  return holder.every((entry) => entry !== null);
}

/** Whether the votes for one choice meet the requirement: its total, and each role's quorum when it has them. */
export function humanChoiceSatisfied(requirement: Pick<z.infer<typeof humanRequirementSchema>, "quorum" | "roleQuorums">,
  votes: ReadonlyArray<Voter & { choice: string }>, choice: string): boolean {
  const voters = votes.filter((vote) => vote.choice === choice);
  if (new Set(voters.map((vote) => vote.principalId)).size < requirement.quorum) return false;
  return !requirement.roleQuorums || roleQuorumsMet(requirement.roleQuorums, voters);
}


/**
 * The customer due-diligence level a diligence gate derived, and what contributed to it: the
 * matrix cell for each product, any jurisdiction floor, every overlay that fired and the
 * simplified-due-diligence permission. Contributors only ever raise the level.
 */
export const diligenceOutcomeSchema = z.object({
  level: id, baseLevel: id, partyType: id, products: ids.refine(v => v.length > 0), requirements: ids,
  contributors: z.array(z.object({ kind: z.enum(["cell", "floor", "overlay", "permission"]), id, level: id }).strict()).min(1).max(200),
  /** Each requirement with its sources: the level (`diligence.level.<LEVEL>`) and the rules that added it. Absent on receipts from before rule effects. */
  requirementSources: z.array(z.object({ requirement: id, from: ids.refine(v => v.length > 0) }).strict()).max(500).optional(),
  /** Approvals the fired rules require. Enforced at the policy's approval gate as a human requirement; they grant nothing. */
  approvals: z.array(z.object({ ruleId: id, role: id, quorum: z.number().int().min(1).max(5), reason: z.string().min(1).max(500) }).strict()).max(50).optional(),
  /** The screening types the resolved requirements imply; later gates and checkpoints require them. */
  screeningTypes: ids.optional(),
}).strict();
export type DiligenceOutcome = z.infer<typeof diligenceOutcomeSchema>;

export const businessDecisionResultSchema = z.object({
  state: decisionStateSchema, reasonCodes: ids.refine(v => v.length > 0), ruleIds: ids,
  actions: z.array(businessActionSchema).max(200), humanRequirement: humanRequirementSchema.nullable(),
  humanIntent:z.object({decisionId:id,choice:z.enum(["APPROVE","REJECT","RETURN"])}).strict().optional(),
  gaps: z.array(z.object({ code: id, path: id, subjectId: id.nullable() }).strict()).max(500),
  /** Typed values a gate derives; only a decided result carries them. */
  outputs: z.object({ diligence: diligenceOutcomeSchema }).strict().optional(),
}).strict().superRefine((v, ctx) => {
  if (v.outputs && v.state !== "DECIDED") ctx.addIssue({ code: "custom", message: "decision.outputs_state_mismatch" });
  if ((v.state === "NEEDS_HUMAN") !== (v.humanRequirement !== null))
    ctx.addIssue({ code: "custom", message: "decision.human_requirement_state_mismatch" });
  if(v.humanIntent && v.state!=="DECIDED") ctx.addIssue({code:"custom",message:"decision.human_intent_state_mismatch"});
  if (v.state !== "DECIDED" && v.actions.some(a => !(v.state === "NEEDS_EVIDENCE" && a.kind === "case_command" && a.commandType === "ProposeWorkItem")))
    ctx.addIssue({ code: "custom", message: "decision.non_decision_action_forbidden" });
});
export type BusinessDecisionResult = z.infer<typeof businessDecisionResultSchema>;

export const effectivePolicySetSchema = z.object({
  apiVersion: z.literal("harness.factory/effective-policy-set-v2"), id, version: id,
  packPin: z.object({ id, digest }).strict(),
  scope: z.object({ jurisdiction: id, institution: id, products: ids.refine(v => v.length > 0),
    customerTypes: z.array(z.enum(["individual", "corporate"])).min(1), purposes: ids.refine(v => v.length > 0) }).strict(),
  modules: z.array(z.object({ id, version: id, digest }).strict()).min(1).max(100),
  configuration: z.record(z.string(), z.json()),
  gateBindings: z.record(id, z.object({ inputProfile: id, policyId: id, bundleDigest: digest }).strict()),
  setDigest: digest,
}).strict();
export type EffectivePolicySet = z.infer<typeof effectivePolicySetSchema>;

/** Data from trusted services; a request body's actor/role claims are never used as facts. */
export const businessDecisionBasisSchema = z.object({
  tenantId: id, caseId: id, planDigest: digest, releaseDigest: digest,
  caseSequence: z.number().int().nonnegative(), snapshotDigest: digest, dependencyDigest: digest, selectedInputDigest: digest,
  effectivePolicySetDigest: digest, policyBundleDigest: digest, inputProfile: id, gateId: id,
  purpose: id, subjectIds: ids, evaluatedAt: instant, knowledgeCutoff: instant,
  proposerPrincipalIds: ids,
  scope: z.object({ jurisdiction: id, institution: id, products: ids.refine(v => v.length > 0),
    customerType: z.enum(["individual", "corporate"]),
    /** The customer's canonical legal form, from the same relationship that gave the customer type. */
    legalForm: id.optional(),
    /** Products the customer holds in another role (underlying investor, counterparty, ...), resolved; they bring that role's requirements. */
    relatedProducts: z.array(z.object({ product: id, role: id }).strict()).max(100).optional() }).strict(),
}).strict();
export type BusinessDecisionBasis = z.infer<typeof businessDecisionBasisSchema>;

export const businessDecisionSchema = businessDecisionBasisSchema.extend({
  apiVersion: z.literal("harness.factory/business-decision-v2"), decisionId: id,
  inputDigest: digest, evaluator: z.object({ kind: z.literal("OPA"), version: id }).strict(),
  result: businessDecisionResultSchema, expiresAt: instant, receiptDigest: digest,
}).strict().refine(v => Date.parse(v.expiresAt) > Date.parse(v.evaluatedAt), "decision.invalid_validity");
export type BusinessDecision = z.infer<typeof businessDecisionSchema>;

export const businessDecisionGrantSchema = z.object({
  apiVersion: z.literal("harness.factory/business-action-grant-v2"), decisionId: id,
  decisionDigest: digest, actionIndex: z.number().int().nonnegative().max(199), actionDigest: digest,
}).strict();
export type BusinessDecisionGrant = z.infer<typeof businessDecisionGrantSchema>;

/** Human responses are populated from authenticated, durable work records by the service. */
export const policyHumanResponseSchema = z.object({
  decisionId: id, inputDigest: digest, actionDigest: digest,
  choices: z.array(z.object({ principalId: id, roles: ids, choice: z.enum(["APPROVE", "REJECT", "RETURN"]),
    decidedAt: instant, responseId: id }).strict()).max(100),
}).strict();
export type PolicyHumanResponse = z.infer<typeof policyHumanResponseSchema>;

export const businessHumanChoiceSchema = z.object({
  responseId: id, inputDigest: digest, requestDigest: digest,
  choice: z.enum(["APPROVE", "REJECT", "RETURN"]), rationale: z.string().min(1).max(10000),
}).strict();

export const businessHumanRecordedResponseSchema=businessHumanChoiceSchema.extend({decisionId:id,principalId:id,roles:ids,decidedAt:instant}).strict();
export const businessDecisionViewSchema=z.object({decision:businessDecisionSchema,requestDigest:digest,input:z.record(z.string(),z.json()),
  responses:z.array(businessHumanRecordedResponseSchema)}).strict();
