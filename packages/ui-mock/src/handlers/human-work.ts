import { clone, type Rec } from "../fixtures.js";
import { type Ctx, fail, type Impl, notFound, ok, stableJson } from "../http.js";
import { caseSequence, hasConflict, isPending, queue, queueItem, recordDecision, resolveConflict, touchHumanWork } from "../scenario.js";
import { notify } from "../state.js";

const DECISIONS = new Set(["APPROVE", "REJECT", "RETURN"]);

function item(ctx: Ctx): Rec | undefined {
  return queueItem(ctx.state, ctx.params.workItemId!);
}

/** A completed item is no longer in the queue; find its work item for not-pending errors. */
function anyWorkItem(ctx: Ctx): Rec | undefined {
  return (ctx.state.store.workItems as Rec[]).find((workItem) => workItem.workItemId === ctx.params.workItemId);
}

function validBody(ctx: Ctx, idKey: "decisionId" | "resolutionId"): Response | null {
  const body = ctx.body ?? {};
  const issues: Rec[] = [];
  for (const field of ["caseId", idKey, "reasonCode", "rationale"]) {
    if (typeof body[field] !== "string" || !body[field]) issues.push({ path: field, message: "required" });
  }
  if (!DECISIONS.has(String(body.decision))) issues.push({ path: "decision", message: "must be APPROVE, REJECT or RETURN" });
  if (!Array.isArray(body.evidenceRefs)) issues.push({ path: "evidenceRefs", message: "must be an array" });
  return issues.length ? fail(ctx, 400, "request.invalid", "The decision is incomplete.", { issues }) : null;
}

export const humanWork: Record<string, Impl> = {
  getOperationsHumanWork: (ctx) => {
    const caseId = ctx.url.searchParams.get("caseId");
    const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? 100) || 100, 500);
    const items = queue(ctx.state).filter((entry) => !caseId || entry.workItem.caseId === caseId).slice(0, limit);
    return ok(ctx, { items: clone(items), generatedAt: ctx.state.clock });
  },

  postOperationsHumanWorkWorkItemIdClaim: (ctx) => {
    const target = item(ctx);
    if (!target && !anyWorkItem(ctx)) return notFound(ctx, "Work item");
    if (!target || !isPending(target)) return fail(ctx, 409, "workflow.human_assignment_not_pending", "This item is no longer waiting for a decision.");
    const replayed = target.assignedTo.includes(ctx.subject);
    if (!replayed) {
      target.assignedTo.push(ctx.subject);
      touchHumanWork(ctx.state);
    }
    notify(ctx.state, "store");
    return ok(ctx, { workItem: clone(target.workItem), assignedTo: [...target.assignedTo], replayed });
  },

  /**
   * §6.4 order, with one deliberate exception: an idempotent replay is recognised before the
   * claim/pending checks, so retrying a committed decision recovers its receipt even after
   * the item completed (EHF 17: replay does not need the consumed claim).
   */
  postOperationsHumanWorkWorkItemIdDecisions: (ctx) => {
    const invalid = validBody(ctx, "decisionId");
    if (invalid) return invalid;
    const body = ctx.body as Rec;
    const { basis: _basis, claimVersion: _claimVersion, ...content } = body;
    const prior = ctx.state.decisionLog.get(String(body.decisionId));
    if (prior) {
      if (prior.body === stableJson({ ...content, workItemId: ctx.params.workItemId, principalId: ctx.subject })) return ok(ctx, prior.decision, 201);
      return fail(ctx, 409, "workflow.human_decision_idempotency_conflict", "This decision was already recorded with different content.", { report: prior.decision });
    }
    const target = item(ctx);
    if (!target && !anyWorkItem(ctx)) return notFound(ctx, "Work item");
    if (target && target.assignedTo.length > 0 && !target.assignedTo.includes(ctx.subject)) {
      return fail(ctx, 409, "workflow.human_decision_not_assigned", `Claimed by ${target.assignedTo.join(", ")}. Claim it too, or ask them.`, { actor: ctx.subject });
    }
    if (!target || !isPending(target)) return fail(ctx, 409, "workflow.human_decision_not_pending", "This item is no longer waiting for a decision.");
    const current = caseSequence(ctx.state);
    if (ctx.state.faults.staleBasisNext || body.basis?.caseSequence !== current) {
      if (!ctx.state.faults.sticky.includes("staleBasisNext")) ctx.state.faults.staleBasisNext = false;
      return fail(ctx, 409, "human.basis_stale", `The case changed while you were reviewing (sequence ${String(body.basis?.caseSequence)} → ${current}).`, {
        report: { expected: body.basis?.caseSequence ?? null, current },
      });
    }
    if ((target.decisions as Rec[]).some((decision) => decision.principalId === ctx.subject)) {
      return fail(ctx, 409, "workflow.human_decision_conflict", "You already decided this item. A second, different approver is required.", { actor: ctx.subject });
    }
    const decision = {
      caseId: String(body.caseId),
      decidedAt: ctx.state.clock,
      decision: String(body.decision),
      decisionId: String(body.decisionId),
      evidenceRefs: [...(body.evidenceRefs as string[])],
      principalId: ctx.subject,
      rationale: String(body.rationale),
      reasonCode: String(body.reasonCode),
      tenantId: target.workItem.tenantId,
      workItemId: ctx.params.workItemId!,
    };
    recordDecision(ctx.state, target, decision);
    ctx.state.decisionLog.set(decision.decisionId, { body: stableJson({ ...content, workItemId: ctx.params.workItemId, principalId: ctx.subject }), decision });
    notify(ctx.state, "store");
    return ok(ctx, decision, 201);
  },

  postOperationsHumanWorkWorkItemIdResolve: (ctx) => {
    const invalid = validBody(ctx, "resolutionId");
    if (invalid) return invalid;
    const target = item(ctx);
    if (!target && !anyWorkItem(ctx)) return notFound(ctx, "Work item");
    if (!target || !isPending(target) || !hasConflict(target)) {
      return fail(ctx, 409, "workflow.human_resolution_not_required", "This item has no conflicting decisions to resolve.");
    }
    if ((target.decisions as Rec[]).some((decision) => decision.principalId === ctx.subject)) {
      return fail(ctx, 409, "workflow.human_resolution_separation_required", "You decided this item, so someone else must resolve the conflict.", { actor: ctx.subject });
    }
    const body = ctx.body as Rec;
    const resolution = {
      caseId: String(body.caseId),
      decidedAt: ctx.state.clock,
      decision: String(body.decision),
      decisionId: String(body.resolutionId),
      evidenceRefs: [...(body.evidenceRefs as string[])],
      principalId: ctx.subject,
      rationale: String(body.rationale),
      reasonCode: String(body.reasonCode),
      tenantId: target.workItem.tenantId,
      workItemId: ctx.params.workItemId!,
    };
    const transitioned = resolveConflict(ctx.state, target, resolution);
    notify(ctx.state, "store");
    return ok(ctx, { resolution, workItemId: resolution.workItemId, scenario: transitioned ?? ctx.state.scenario });
  },
};
