import { institutionCatalogSchema } from "@ehf/contracts/products";
import { lockBusinessPolicyRelease } from "./business-decisions.js";
import { businessDecisionSchema, businessDecisionViewSchema, businessHumanChoiceSchema, humanChoiceSatisfied, roleQuorumsMet, stableDigest, type BusinessDecision, type CaseActor } from "@ehf/contracts";
import { appendLockedCaseEvent, bindCaseTenant, CaseStoreError, type CaseStore, type LockedCase } from "./index.js";
import { qualify } from "./config.js";

export const businessHumanRequestDigest = (decision: BusinessDecision) => stableDigest({
  decisionId: decision.decisionId, inputDigest: decision.inputDigest, requirement: decision.result.humanRequirement,
});

export async function getStoredBusinessDecision(store: CaseStore, tenantId: string, caseId: string, decisionId: string) {
  const client = await store.db.connect();
  try {
    await client.query("begin read only"); await bindCaseTenant(client, tenantId);
    const row = (await client.query<{ receipt: unknown; input:Record<string,unknown> }>(`select receipt,input from ${qualify(store.schemas.core, "business_decisions")}
      where tenant_id=$1 and case_id=$2 and decision_id=$3`, [tenantId, caseId, decisionId])).rows[0];
    const responses=(await client.query<{response:unknown}>(`select response from ${qualify(store.schemas.core,"business_human_responses")}
      where tenant_id=$1 and case_id=$2 and decision_id=$3 order by principal_id`,[tenantId,caseId,decisionId])).rows.map(row=>row.response);
    await client.query("commit");
    if (!row) return null;
    const decision = businessDecisionSchema.parse(row.receipt);
    if(stableDigest(row.input)!==decision.inputDigest) throw new CaseStoreError("policy.input_integrity_mismatch",409);
    return businessDecisionViewSchema.parse({ decision,input:row.input,responses,requestDigest: businessHumanRequestDigest(decision) });
  } finally { await client.query("rollback").catch(() => undefined); client.release(); }
}

type Requirement = NonNullable<BusinessDecision["result"]["humanRequirement"]>;
type Vote = { principalId: string; roles: string[]; choice: string };
const asVotes = (responses: ReadonlyArray<Record<string, unknown>>): Vote[] => responses.map((response) => ({
  principalId: String(response.principalId), roles: Array.isArray(response.roles) ? response.roles.map(String) : [], choice: String(response.choice) }));
/** Enough people have answered: the total, and every role's quorum among them when the requirement has them. */
const panelComplete = (requirement: Requirement, responses: ReadonlyArray<Record<string, unknown>>) =>
  responses.length >= requirement.quorum && (!requirement.roleQuorums || roleQuorumsMet(requirement.roleQuorums, asVotes(responses)));

/** Votes are evidence. Only a fresh OPA decision can apply a post-human effect. */
export async function recordBusinessHumanResponse(store: CaseStore, input: {
  tenantId: string; caseId: string; decisionId: string; actor: CaseActor; choice: unknown;
}) {
  const choice = businessHumanChoiceSchema.parse(input.choice);
  if (input.actor.type !== "HUMAN") throw new CaseStoreError("policy.authenticated_human_required", 403);
  if (!store.executionDb) throw new CaseStoreError("policy.control_connection_required", 503);
  const loaded = await getStoredBusinessDecision(store, input.tenantId, input.caseId, input.decisionId);
  if (!loaded?.decision.result.humanRequirement) throw new CaseStoreError("policy.human_requirement_missing", 409);
  const { decision, requestDigest } = loaded;
  const requirement = decision.result.humanRequirement!;
  if (choice.inputDigest !== decision.inputDigest || choice.requestDigest !== requestDigest) throw new CaseStoreError("policy.human_scope_mismatch", 409);
  if (!requirement.roles.some(role => input.actor.roles.includes(role))) throw new CaseStoreError("policy.human_role_required", 403);
  if (requirement.independentOfProposer && decision.proposerPrincipalIds.includes(input.actor.principalId))
    throw new CaseStoreError("policy.human_independence_required", 403);
  if (!requirement.allowedChoices.includes(choice.choice)) throw new CaseStoreError("policy.human_choice_forbidden", 403);
  const control = await store.executionDb.connect(); const client = await store.db.connect();
  try {
    await control.query("begin");
    if(!await lockBusinessPolicyRelease(control,decision)) throw new CaseStoreError("policy.released_authority_required",403);
    await client.query("begin"); await bindCaseTenant(client, input.tenantId);
    const current = (await client.query<LockedCase>(`select * from ${qualify(store.schemas.core, "cases")}
      where tenant_id=$1 and case_id=$2 for update`, [input.tenantId, input.caseId])).rows[0];
    if (!current) throw new CaseStoreError("case.not_found", 404);
    const responses = (await client.query<{ response: Record<string, unknown> }>(`select response from ${qualify(store.schemas.core, "business_human_responses")}
      where tenant_id=$1 and case_id=$2 and decision_id=$3`, [input.tenantId, input.caseId, input.decisionId])).rows.map(row => row.response);
    const content = { ...choice, decisionId: input.decisionId, principalId: input.actor.principalId, roles: [...input.actor.roles].sort() };
    const prior = responses.find(response => response.responseId === choice.responseId || response.principalId === input.actor.principalId);
    if (prior) {
      const { decidedAt: _at, ...saved } = prior;
      if (stableDigest(saved) !== stableDigest(content)) throw new CaseStoreError("policy.human_response_conflict", 409);
      await client.query("commit"); return { response: prior, replayed: true, readyForEvaluation: panelComplete(requirement, responses) };
    }
    if (Number(current.case_sequence) !== decision.caseSequence + 1 + responses.length || current.harness_plan_digest !== decision.planDigest)
      throw new CaseStoreError("policy.human_basis_stale", 409);
    if (Date.now() >= Date.parse(decision.evaluatedAt) + requirement.ttlSeconds * 1000) throw new CaseStoreError("policy.human_requirement_expired", 409);
    const response = { ...content, decidedAt: new Date().toISOString() };
    await client.query(`insert into ${qualify(store.schemas.core, "business_human_responses")}
      (tenant_id,case_id,decision_id,response_id,principal_id,response) values($1,$2,$3,$4,$5,$6::jsonb)`,
    [input.tenantId, input.caseId, input.decisionId, choice.responseId, input.actor.principalId, JSON.stringify(response)]);
    await appendLockedCaseEvent(client, store, current, { eventType: "policy.human_response_recorded", eventSchema: "harness.policy.human_response.v2",
      commandId: choice.responseId, actor: input.actor, authority: { planDigest: decision.planDigest, policySnapshotDigest: current.policy_snapshot_digest,
        decisionDigest: decision.receiptDigest, inputDigest: decision.inputDigest, requestDigest }, payload: response, evidenceRefs: [] });
    await client.query("commit"); return { response, replayed: false, readyForEvaluation: panelComplete(requirement, [...responses, response]) };
  } catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
  finally { client.release(); await control.query("rollback").catch(() => undefined); control.release(); }
}

/** Normalize only unchanged-basis votes for the same gate, policy set and released version. */
export async function getBusinessPolicyHumanInput(store: CaseStore, tenantId: string, caseId: string,
  scope: { gateId: string; policySetDigest: string; releaseDigest: string; caseSequence: number }) {
  const client = await store.db.connect();
  try {
    await client.query("begin isolation level repeatable read read only"); await bindCaseTenant(client, tenantId);
    const row = (await client.query<{ receipt: unknown }>(`select receipt from ${qualify(store.schemas.core, "business_decisions")}
      where tenant_id=$1 and case_id=$2 and receipt->'result'->>'state'='NEEDS_HUMAN'
        and receipt->>'gateId'=$3 and receipt->>'effectivePolicySetDigest'=$4 and receipt->>'releaseDigest'=$5
      order by case_sequence desc limit 1`, [tenantId, caseId, scope.gateId, scope.policySetDigest, scope.releaseDigest])).rows[0];
    if (!row) { await client.query("commit"); return null; }
    const decision = businessDecisionSchema.parse(row.receipt);
    const votes = (await client.query<{ response: Record<string, unknown> }>(`select response from ${qualify(store.schemas.core, "business_human_responses")}
      where tenant_id=$1 and case_id=$2 and decision_id=$3 order by principal_id`, [tenantId, caseId, decision.decisionId])).rows.map(row => row.response);
    await client.query("commit");
    const requirement = decision.result.humanRequirement!;
    if (scope.caseSequence !== decision.caseSequence + 1 + votes.length
      || Date.now() >= Date.parse(decision.evaluatedAt) + requirement.ttlSeconds * 1000) return null;
    return { decisionId: decision.decisionId, inputDigest: decision.inputDigest, requestDigest: businessHumanRequestDigest(decision),
      requirement, votes, counts: { APPROVE: votes.filter(v => v.choice === "APPROVE").length,
        REJECT: votes.filter(v => v.choice === "REJECT").length, RETURN: votes.filter(v => v.choice === "RETURN").length },
      // Per choice: its votes meet the total and, when the requirement names them, every role's quorum.
      satisfied: Object.fromEntries((["APPROVE", "REJECT", "RETURN"] as const).map((choice) => [choice, humanChoiceSatisfied(requirement, asVotes(votes), choice)])),
      conflict: new Set(votes.map(v => v.choice)).size > 1 };
  } finally { await client.query("rollback").catch(() => undefined); client.release(); }
}

/**
 * The institution's published product catalog (phase G), read through the control database's
 * definer function on the execution connection; null when none is published or it does not parse.
 */
export async function getPublishedInstitutionCatalog(store: CaseStore, tenantId: string, institutionId: string) {
  if (!store.executionDb) return null;
  const raw = (await store.executionDb.query<{ catalog: unknown }>("select harness_runtime.published_institution_catalog($1,$2) as catalog", [tenantId, institutionId])).rows[0]?.catalog;
  const parsed = institutionCatalogSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * The case's latest diligence decision under one released policy set, for the gates after it: its
 * level, the requirements and screening types it resolved, and the approvals its rules require. Null when the case has none, or when its latest
 * diligence decision did not decide (an unresolved level leaves approvals unknown, never empty).
 */
export async function getLatestDiligenceOutcome(store: CaseStore, tenantId: string, caseId: string,
  scope: { gateId: string; policySetDigest: string; releaseDigest: string }) {
  const client = await store.db.connect();
  try {
    await client.query("begin isolation level repeatable read read only"); await bindCaseTenant(client, tenantId);
    const row = (await client.query<{ receipt: unknown }>(`select receipt from ${qualify(store.schemas.core, "business_decisions")}
      where tenant_id=$1 and case_id=$2 and receipt->>'gateId'=$3 and receipt->>'effectivePolicySetDigest'=$4 and receipt->>'releaseDigest'=$5
      order by case_sequence desc, created_at desc limit 1`, [tenantId, caseId, scope.gateId, scope.policySetDigest, scope.releaseDigest])).rows[0];
    await client.query("commit");
    if (!row) return null;
    const decision = businessDecisionSchema.parse(row.receipt);
    const outcome = decision.result.state === "DECIDED" ? decision.result.outputs?.diligence : undefined;
    if (!outcome) return null;
    return { decisionId: decision.decisionId, caseSequence: decision.caseSequence, level: outcome.level,
      requirements: [...outcome.requirements], screeningTypes: [...(outcome.screeningTypes ?? [])],
      approvals: (outcome.approvals ?? []).map(({ ruleId, role, quorum, reason }) => ({ ruleId, role, quorum, reason })) };
  } finally { await client.query("rollback").catch(() => undefined); client.release(); }
}

/**
 * Stored business decisions for one gate across a tenant's cases, newest first, for policy
 * monitoring. Each receipt is checked against its contract; nothing here changes a case.
 */
export async function listBusinessDecisionReceipts(store: CaseStore, tenantId: string, options: { gateId: string; since?: string; limit?: number; customerTypes?: string[] }) {
  const limit = Math.max(1, Math.min(options.limit ?? 1000, 5000));
  const client = await store.db.connect();
  try {
    await client.query("begin read only"); await bindCaseTenant(client, tenantId);
    const rows = (await client.query<{ receipt: unknown }>(`select receipt from ${qualify(store.schemas.core, "business_decisions")}
      where tenant_id=$1 and receipt->>'gateId'=$2 and ($3::timestamptz is null or created_at >= $3::timestamptz)
        and ($5::text[] is null or receipt->'scope'->>'customerType' = any($5::text[]))
      order by created_at desc, decision_id limit $4`, [tenantId, options.gateId, options.since ?? null, limit, options.customerTypes?.length ? options.customerTypes : null])).rows;
    await client.query("commit");
    return { receipts: rows.map((row) => businessDecisionSchema.parse(row.receipt)), limited: rows.length === limit };
  } finally { await client.query("rollback").catch(() => undefined); client.release(); }
}
