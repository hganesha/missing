import { clone, type Rec } from "../fixtures.js";
import { type Ctx, fail, type Impl, notFound, ok } from "../http.js";
import { BUSINESS_TEMPLATES, businessCompilation, businessDecision, businessSource, diligenceMonitoring, diligenceRefusal } from "./business-policy.js";

const DIGEST = (seed: string) => seed.repeat(64).slice(0, 64);

function revisions(ctx: Ctx): Rec[] {
  const id = ctx.params.workspaceId!;
  if (!ctx.state.policyWorkspaces.has(id)) ctx.state.policyWorkspaces.set(id, []);
  return ctx.state.policyWorkspaces.get(id)!;
}

function activations(ctx: Ctx): Rec[] {
  const id = ctx.params.workspaceId!;
  if (!ctx.state.policyActivations.has(id)) ctx.state.policyActivations.set(id, []);
  return ctx.state.policyActivations.get(id)!;
}

/** As the control API reports it: the history newest first, the revision in effect now and those scheduled. */
function activationView(ctx: Ctx): Rec {
  const published = new Set(revisions(ctx).filter((entry) => entry.status === "published").map((entry) => entry.revision));
  const now = new Date().toISOString();
  const history = [...activations(ctx)].sort((a, b) => String(b.effectiveFrom).localeCompare(String(a.effectiveFrom)) || String(b.createdAt).localeCompare(String(a.createdAt)));
  const live = history.filter((entry) => published.has(entry.revision));
  return { activations: clone(history), active: clone(live.find((entry) => String(entry.effectiveFrom) <= now) ?? null), scheduled: clone(live.filter((entry) => String(entry.effectiveFrom) > now).reverse()) };
}

function revisionOf(ctx: Ctx): Rec | undefined {
  return revisions(ctx).find((revision) => revision.revision === Number(ctx.params.revision));
}

function compilation(files: Rec): Rec {
  return {
    files: clone(files),
    manifest: {
      apiVersion: "harness.factory/policy-bundle-v1", kind: "PolicyBundle",
      regoModules: [{path:"policy.rego",digest:DIGEST("2")}],
      authority: {source:"POLICY_DB",casePath:"$.policyAuthority",requireSnapshotDigest:true},
      bundleDigest: DIGEST("4"), bundleId: "kyc-candidate", dataDigest: DIGEST("5"), gates: [
        { gateId: "edd.required", entrypoint: "data.kyc.edd.required", allowedOutcomes: ["ALLOW", "REVIEW", "BLOCK"] },
        { gateId: "decision.consequential", entrypoint: "data.kyc.decision.consequential", allowedOutcomes: ["ALLOW", "REVIEW", "BLOCK", "ERROR"] },
      ], opaVersion: "1.9.0",
      policyId: "kyc", policyVersion: "2026.11", ruleIds: ["req-legal-existence", "req-ubo-identified"], sourceDigest: DIGEST("6"), testsDigest: DIGEST("3"),
    },
    productionEligible: false,
    releaseBlockers: [{ id: "blk-1", owner: "compliance", path: "policy.yaml", reasonCode: "policy.institution_approval_pending", status: "open", title: "Institution-approved rules pending" }],
  };
}

export const policies: Record<string, Impl> = {
  getAuthoringPoliciesMonitoringDiligence: (ctx) => ok(ctx, diligenceMonitoring(ctx.url.searchParams)),
  getAuthoringPolicies: (ctx) => {
    // Like the control API: the agentic installation policies by default, the archived catalog on request.
    const template = ctx.url.searchParams.get("template") ?? "kyc-agentic";
    const business = BUSINESS_TEMPLATES[template];
    return ok(ctx, business ? { id: template, files: clone(business) } : clone(ctx.state.platform.policyTemplate));
  },
  postAuthoringPoliciesCompile: (ctx) => {
    const files = (ctx.body?.files as Rec | undefined) ?? ctx.state.platform.policyTemplate.files;
    const source = businessSource(files);
    const refused = source ? diligenceRefusal(source) : null;
    if (refused) return fail(ctx, 400, "policy.compile_failed", refused);
    const result = source ? businessCompilation(source) : compilation(files);
    const open = (result.releaseBlockers as Rec[]).filter((blocker) => blocker.status === "open" || blocker.status === "UNRESOLVED");
    // A production compile with open blockers is refused with the blockers forwarded (ui-specs §10.2).
    if (ctx.body?.release === "production" && open.length) {
      return fail(ctx, 422, "policy.production_blocked", `${open.length} release blocker${open.length === 1 ? "" : "s"} must be closed before production.`, {
        blockers: open.map((blocker) => `${String(blocker.title ?? blocker.id)} (${String(blocker.reasonCode)})`),
      });
    }
    return ok(ctx, result);
  },
  postAuthoringPoliciesEvaluate: (ctx) => {
    const source = businessSource(ctx.body?.files as Rec | undefined);
    if (source) {
      const decision = businessDecision(source, ctx.body ?? {}, ctx.state.counter + 1);
      return decision ? ok(ctx, decision) : fail(ctx, 400, "policy.decision_authority_mismatch", "The sample does not match a compiled policy set and gate.");
    }
    const store = ctx.state.store;
    return ok(ctx, {
      apiVersion: "harness.factory/policy-evaluation-v1",
      kind: "PolicyEvaluation",
      caseId: store.caseSummary.caseId,
      caseSequence: store.caseSummary.caseSequence,
      caseSnapshotDigest: store.snapshot.snapshotDigest,
      dependencyDigest: store.snapshot.dependencyDigest,
      evaluatedAt: String(ctx.body?.evaluatedAt ?? ctx.state.clock),
      evaluationId: `peval_${ctx.state.counter + 1}`,
      evidenceRefs: [],
      gateId: String(ctx.body?.gateId ?? "decision.consequential"),
      inputDigest: DIGEST("2"),
      obligations: [],
      outcome: "REVIEW",
      policyBundleDigest: store.snapshot.policyAuthority.policyBundleDigest,
      reasonCodes: ["policy.review_required"],
      receiptDigest: DIGEST("1"),
      ruleResults: [{ evidenceRefs: [], outcome: "UNKNOWN", reasonCode: "policy.coverage_incomplete", ruleId: "req-watchlist-coverage" }],
      tenantId: store.caseSummary.tenantId,
    });
  },
  getAuthoringPoliciesWorkspacesWorkspaceIdRevisions: (ctx) => ok(ctx, { workspaceId: ctx.params.workspaceId, revisions: clone(revisions(ctx)), ...activationView(ctx) }),
  postAuthoringPoliciesWorkspacesWorkspaceIdRevisions: (ctx) => {
    const list = revisions(ctx);
    const current = list.length ? list[list.length - 1]!.revision : 0;
    if (ctx.body?.expectedRevision != null && ctx.body.expectedRevision !== current) {
      return fail(ctx, 409, "policy.revision_conflict", `Workspace changed (rev ${String(ctx.body.expectedRevision)} → ${current}).`);
    }
    const revision = { revision: current + 1, author: ctx.subject, status: "draft", files: clone(ctx.body?.files ?? {}), createdAt: ctx.state.clock, approvedBy: null };
    list.push(revision);
    return ok(ctx, revision, 201);
  },
  postAuthoringPoliciesWorkspacesWorkspaceIdRevisionsRevisionCompile: (ctx) => {
    const revision = revisionOf(ctx);
    if (!revision) return notFound(ctx, "Policy revision");
    if (revision.author !== ctx.subject) return fail(ctx, 409, "policy.revision_author_mismatch", "Only the author of this revision can compile it.");
    revision.status = "compiled";
    const source = businessSource(revision.files);
    revision.compilation = source ? businessCompilation(source) : compilation(revision.files);
    return ok(ctx, revision);
  },
  postAuthoringPoliciesWorkspacesWorkspaceIdRevisionsRevisionApprove: (ctx) => {
    const revision = revisionOf(ctx);
    if (!revision) return notFound(ctx, "Policy revision");
    if (revision.author === ctx.subject || revision.status !== "compiled") {
      return fail(ctx, 409, "policy.separation_or_lifecycle_conflict", revision.author === ctx.subject ? "You authored this revision, so someone else must approve it." : `The revision is ${revision.status}; compile it first.`);
    }
    Object.assign(revision, { status: "approved", approvedBy: ctx.subject });
    return ok(ctx, revision);
  },
  postAuthoringPoliciesWorkspacesWorkspaceIdRevisionsRevisionPublish: (ctx) => {
    const revision = revisionOf(ctx);
    if (!revision) return notFound(ctx, "Policy revision");
    if (revision.status !== "approved") return fail(ctx, 409, "policy.separation_or_lifecycle_conflict", "Only an approved revision can be published.");
    const now = Date.now();
    const requested = typeof ctx.body?.effectiveFrom === "string" ? Date.parse(ctx.body.effectiveFrom) : null;
    if (requested !== null && !Number.isFinite(requested)) return fail(ctx, 400, "policy.effective_from_invalid", "The effective date is not a date.");
    if (requested !== null && requested < now - 60_000) return fail(ctx, 400, "policy.effective_from_past", "A revision cannot take effect in the past.");
    const effectiveFrom = new Date(requested !== null && requested > now ? requested : now).toISOString();
    revision.status = "published";
    activations(ctx).push({ activationId: `pact_mock_${activations(ctx).length + 1}`, revision: revision.revision, kind: requested !== null && requested > now ? "SCHEDULE" : "PUBLISH",
      effectiveFrom, actor: ctx.subject, reason: String(ctx.body?.reason ?? ""), createdAt: new Date(now).toISOString() });
    return ok(ctx, revision);
  },
  postAuthoringPoliciesWorkspacesWorkspaceIdRevisionsRevisionRollback: (ctx) => {
    const revision = revisionOf(ctx);
    if (!revision) return notFound(ctx, "Policy revision");
    const reason = String(ctx.body?.reason ?? "").trim();
    if (reason.length < 3) return fail(ctx, 400, "policy.rollback_reason_required", "Say why you are rolling back.");
    if (revision.status !== "published") return fail(ctx, 409, "policy.rollback_target_not_published", "Only a published revision can be put back in effect.");
    const later = revisions(ctx).filter((entry) => entry.revision > revision.revision && entry.status === "published");
    if (!later.length) return fail(ctx, 409, "policy.rollback_nothing_to_undo", "No later revision is published.");
    for (const entry of later) entry.status = "superseded";
    const now = new Date().toISOString();
    activations(ctx).push({ activationId: `pact_mock_${activations(ctx).length + 1}`, revision: revision.revision, kind: "ROLLBACK", effectiveFrom: now, actor: ctx.subject, reason, createdAt: now });
    return ok(ctx, revision);
  },
};
