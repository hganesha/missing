import { clone, CONTEXT_MATRIX, FINCRIME, SKILL_MANIFESTS, type Rec } from "../fixtures.js";
import { type Ctx, fail, type Impl, notFound, ok, page } from "../http.js";
import { validatorFor } from "@ehf/ui-contracts/validate";
import { attentionFor, caseEtag, caseRoom, caseSequence, decisionDesk, queueItem } from "../scenario.js";
import { hex64 } from "./cases.js";
import { contextOntologyView, type OntologyMetadata, type RelationshipCatalog, type ContextCatalogSource } from "@ehf/fincrime-views";
import ontology from '../../../library-contracts/src/vendor/ontology.schema.json' with { type: 'json' };
import contextLock from '../../../library-contracts/src/vendor/lock.json' with { type: 'json' };
import relationships from '../../../library-contracts/src/vendor/context-relationships.json' with { type: 'json' };
import catalogArtifact from '../../../ui-contracts/vendor/catalog/ehf-catalog.json' with { type: 'json' };

const ontologyView = () => contextOntologyView(
  { ...JSON.parse(catalogArtifact.content), catalogDigest: catalogArtifact.sha256 } as ContextCatalogSource,
  { schemaVersion: contextLock.context_schema_version, objectTypes: ontology['x-context-types'], definitions: ontology.$defs, lock: contextLock } as unknown as OntologyMetadata,
  relationships as RelationshipCatalog,
);

const catalog = () => FINCRIME.catalog as Rec;

/** The mock tenant's case teams. Members are persona subject ids. */
const TEAMS: ReadonlyArray<{ teamId: string; name: string; members: string[] }> = [
  { teamId: "kyb-onboarding", name: "KYB onboarding", members: ["r.okafor", "l.nakamura", "d.patel", "s.varga", "h.adeyemi", "t.brandt"] },
  { teamId: "compliance-review", name: "Compliance review", members: ["s.varga", "h.adeyemi"] },
];

/** The mock case's current assignment; it starts with the onboarding team and one named analyst. */
function assignmentFor(ctx: Ctx): Rec {
  const fin = ctx.state.fin as Rec;
  fin.assignment ??= {
    team: { teamId: "kyb-onboarding", name: "KYB onboarding" }, assignees: ["r.okafor"], reason: "Onboarding intake",
    assignedBy: { principalId: "m.castillo", type: "HUMAN", roles: [] }, assignedAt: "2026-11-08T03:01:00Z",
  };
  return clone(fin.assignment as Rec);
}

function reconPreview(ctx: Ctx, request: boolean) {
  const room = caseRoom(ctx.state);
  if (ctx.params.caseId !== room.caseId) return notFound(ctx, "Case");
  const assignment = assignmentFor(ctx);
  if (!(assignment.assignees as string[]).includes(ctx.subject)
    && !TEAMS.find(team => team.teamId === assignment.team.teamId)?.members.includes(ctx.subject)) {
    return fail(ctx, 403, "authorization.discovery_standing_missing", "Only assigned case staff can read this brief.");
  }
  if (!["KYB", "kyb_onboarding"].includes(room.caseType)) return ok(ctx, { status: "unavailable", canRequest: false, brief: null });
  const fin = ctx.state.fin as Rec;
  const canRequest = ctx.session.actions.includes("discovery.request") && !["APPROVED", "DECLINED", "CLOSED"].includes(room.status);
  if (request && !canRequest) return fail(ctx, 409, "discovery.case_not_eligible", "This case cannot request a Recon brief.");
  if (request && !fin.reconRequested) {
    fin.reconRequested = true;
    return ok(ctx, { status: "queued", canRequest: false, brief: null });
  }
  if (!fin.reconRequested) return ok(ctx, { status: "idle", canRequest, brief: null });
  return ok(ctx, { status: "complete", canRequest: false, brief: {
    schemaVersion: "discovery.brief.v1", briefId: "mock-recon-brief", caseId: room.caseId, subjectId: room.subject.subjectId,
    parentPlanDigest: room.planDigest, intakeDecisionId: "mock-intake", recordedAt: ctx.state.clock, origin: "synthetic_fixture",
    status: "complete", summary: "A fictional rating notice may relate to a similarly named issuer.",
    signals: [{ signalId: "lead-1", category: "credit_rating", headline: "Possible issuer credit rating downgrade", reportedStage: "Downgrade reported",
      eventOn: "2025-05-05", sourceIds: ["rating"], match: "uncertain", matchBasis: "The report uses a similar company name.",
      verificationStatus: "UNVERIFIED", priority: "medium", verificationQuestion: "Which issuer and rating did the agency change?" }],
    sources: [{ sourceId: "rating", title: "Fictional rating agency notice", kind: "rating_agency", url: "https://ratings.example/rating-action",
      publishedOn: "2025-05-05", observedAt: ctx.state.clock }],
    limitations: ["Synthetic fixture. No external searches were performed."],
  } });
}

type MockFinding = Rec & { findingId: string; disposition: { allowed: boolean; reason: string | null } };

/**
 * The mock's findings registry: the scenario's contradictions and screening candidates, plus one
 * recorded finding that belongs to neither, so the reviewer's disposition can be exercised.
 */
function findingsFor(ctx: Ctx): MockFinding[] {
  const fin = ctx.state.fin as Rec;
  const canReview = (ctx.session.actions as string[]).includes("case.review");
  const actor = (principalId: string) => ({ principalId, type: "AGENT", roles: [] });
  const no = (reason: string) => ({ allowed: false, reason });
  const contradictions = Object.values((fin.contradictions ?? {}) as Record<string, Rec>).map((entry) => {
    const open = entry.status === "OPEN";
    return {
      findingId: entry.contradictionId as string, kind: "contradiction", findingType: null, title: `Sources disagree: ${String(entry.subjectLabel)}`, subjectRefs: [],
      severity: "material", state: open ? "open" : "resolved", recordedStatus: entry.status,
      evidenceIds: [...new Set((entry.assertions as Rec[]).map((assertion) => assertion.evidenceId).filter(Boolean))], raisedBy: actor("agent.identity_ownership"), raisedAt: "2026-11-08T03:12:26Z",
      dispositions: open ? [] : [{ id: `${String(entry.contradictionId)}:resolution`, source: "resolution", outcome: "RESOLVED", rationale: null, by: null, at: "2026-11-08T03:20:00Z" }],
      disposition: no("A contradiction is closed by resolving it where its sources are compared."),
    };
  });
  const screening = (((fin.screening as Rec | undefined)?.findings ?? []) as Rec[]).filter((entry) => entry.entryName && entry.entryName !== "—").map((entry) => {
    const open = entry.status === "open";
    return {
      findingId: entry.findingId as string, kind: "finding", findingType: "SCREENING", title: `Possible ${String(entry.listType).replace(/_/g, " ")} match: ${String(entry.entryName)}`, subjectRefs: [],
      severity: null, state: open ? "open" : "dispositioned", recordedStatus: "ACTIVE", evidenceIds: [], raisedBy: actor("agent.screening"), raisedAt: "2026-11-08T03:20:30Z",
      dispositions: open ? [] : [{ id: `${String(entry.findingId)}:review`, source: "review", outcome: String(entry.disposition ?? "DISPOSITIONED"), rationale: null, by: null, at: "2026-11-08T03:40:00Z" }],
      disposition: no(open ? "A screening finding is dispositioned in the screening workspace, through its human step." : "This finding already has a disposition recorded."),
    };
  });
  const recorded = ((fin.findingDispositions ?? {}) as Record<string, Rec[]>)["fd-21"] ?? [];
  const validity = {
    findingId: "fd-21", kind: "finding", findingType: "DOCUMENT_VALIDITY", title: "Operating account statement is dated more than 90 days before onboarding", subjectRefs: ["acme"],
    severity: "review", state: recorded.length ? "dispositioned" : "open", recordedStatus: "ACTIVE", evidenceIds: ["ev-account-statement"], raisedBy: actor("agent.document_intelligence"), raisedAt: "2026-11-08T03:11:40Z",
    dispositions: clone(recorded),
    disposition: recorded.length ? no("This finding already has a disposition recorded.") : canReview ? { allowed: true, reason: null } : no("Recording a disposition needs the reviewer role (case.review)."),
  };
  return [...contradictions, ...screening, validity];
}

/** Synthetic evidence for the mock case, in the order the stages register it: [id, type, source type, dataset, added by, minute]. */
const EVIDENCE: ReadonlyArray<readonly [string, string, string, string | null, string, string]> = [
  ["ev-intake-form", "CUSTOMER_FORM", "UPLOAD", null, "d.patel", "02"],
  ["ev-register-acme", "REGISTRY_EXTRACT", "TOOL", "companies-registry", "agent.identity_ownership", "08"],
  ["ev-decl-acme", "CUSTOMER_DECLARATION", "UPLOAD", null, "d.patel", "09"],
  ["ev-register-northwind", "REGISTRY_EXTRACT", "TOOL", "companies-registry", "agent.identity_ownership", "10"],
  ["ev-register-meridian", "SHAREHOLDER_REGISTER", "UPLOAD", null, "d.patel", "10"],
  ["ev-passport-alice", "IDENTITY_DOCUMENT", "UPLOAD", null, "d.patel", "11"],
  ["ev-passport-bram", "IDENTITY_DOCUMENT", "UPLOAD", null, "d.patel", "11"],
  ["ev-account-statement", "DOCUMENT", "UPLOAD", null, "d.patel", "11"],
  ["ev-structure-summary", "OWNERSHIP_SUMMARY", "DERIVED", null, "agent.identity_ownership", "12"],
  ["ev-sanctions-run", "SCREENING_RESULT", "TOOL", "sanctions-lists", "agent.screening", "20"],
  ["ev-pep-run", "SCREENING_RESULT", "TOOL", "pep-lists", "agent.screening", "21"],
  ["ev-adverse-media-run", "SCREENING_RESULT", "TOOL", "adverse-media", "agent.screening", "22"],
  ["ev-risk-assessment", "RISK_ASSESSMENT", "DERIVED", null, "agent.risk_edd", "30"],
];
const caller = (ctx: Ctx) => ({ subject: ctx.subject, actions: ctx.session.actions as string[] });
const FIELD_REQUIREMENT_KEYS = ["object_type", "field", "required", "min_count", "on_missing", "freshness_policy", "temporal", "skill_id"] as const;

function fieldRequirements(skillId: string): Rec[] {
  return CONTEXT_MATRIX.filter((row) => row.skill_id === skillId)
    .map((row) => Object.fromEntries(FIELD_REQUIREMENT_KEYS.map((key) => [key, row[key] ?? null])));
}

/** FinCrime case reads are for the scenario case; ETag is the case sequence (§5.4). */
function caseRead(ctx: Ctx, build: () => Rec | null | undefined, what: string, perCaller = false): Response {
  if (ctx.params.caseId !== ctx.state.store.caseSummary.caseId) return notFound(ctx, "Case");
  const body = build();
  if (!body) return fail(ctx, 404, "fincrime.not_available", `${what} is not available for this case yet.`);
  return ok(ctx, body, 200, { etag: caseEtag(ctx.state, perCaller ? ctx.subject : undefined) });
}

export const fincrime: Record<string, Impl> = {
  postFincrimeCasesCaseIdContextTraverse: ctx => fail(ctx, 503, "context.traversal_service_required", "Case traversal requires HTTP mode with the case and control services."),
  getFincrimeContextOntology: async ctx => ok(ctx, await ontologyView()),
  getFincrimeCatalog: (ctx) => ok(ctx, clone(catalog())),
  getFincrimeAgents: (ctx) => ok(ctx, clone(ctx.state.fin.agents)),
  getFincrimeAgentsAgentId: (ctx) => {
    const card = (ctx.state.fin.agents.agents as Rec[]).find((entry) => entry.agent.id === ctx.params.agentId);
    if (!card) return notFound(ctx, "Agent");
    const agent = card.agent as Rec;
    return ok(ctx, {
      card: clone(card),
      tasks: clone((catalog().tasks as Rec[]).filter((task) => (agent.task_ids as string[]).includes(task.id))),
      contextProducts: clone((catalog().contextProducts as Rec[]).filter((product) => (agent.context_products as string[]).includes(product.id))),
      skills: clone((FINCRIME.skills as Rec[]).filter((skill) => (skill.agent_ids as string[]).includes(agent.id))),
      ceilings: { context_fields: clone(agent.execution?.context_fields ?? {}), policy_fields: clone(agent.execution?.policy_fields ?? []) },
    });
  },
  getFincrimeTasksTaskId: (ctx) => {
    const task = (FINCRIME.tasks as Rec)[ctx.params.taskId!];
    return task ? ok(ctx, clone(task)) : notFound(ctx, "Task");
  },
  getFincrimeSkills: (ctx) => {
    const query = ctx.url.searchParams.get("q")?.toLowerCase();
    const domain = ctx.url.searchParams.get("domain");
    const items = (FINCRIME.skills as Rec[]).filter((skill) => (!domain || skill.domain === domain)
      && (!query || `${skill.skill_id} ${skill.business_outcome}`.toLowerCase().includes(query)));
    return ok(ctx, page(ctx, clone(items)));
  },
  getFincrimeSkillsSkillId: (ctx) => {
    const summary = (FINCRIME.skills as Rec[]).find((skill) => skill.skill_id === ctx.params.skillId);
    const manifest = SKILL_MANIFESTS.get(ctx.params.skillId!);
    if (!summary || !manifest) return notFound(ctx, "Skill");
    return ok(ctx, { manifest: clone(manifest), summary: clone(summary), fieldRequirements: fieldRequirements(summary.skill_id) });
  },
  getFincrimeContextProducts: (ctx) => ok(ctx, clone(catalog().contextProducts)),
  getFincrimeContextProductsProductId: (ctx) => {
    const view = (FINCRIME.contextProducts as Rec)[ctx.params.productId!];
    return view ? ok(ctx, clone(view)) : notFound(ctx, "Context product");
  },
  getFincrimeContextReadiness: (ctx) => {
    const agentId = ctx.url.searchParams.get("agentId");
    const readiness = clone(FINCRIME.readiness as Rec);
    if (agentId) {
      readiness.agents = (readiness.agents as string[]).filter((id) => id === agentId);
      readiness.cells = (readiness.cells as Rec[]).filter((cell) => cell.agentId === agentId);
    }
    return ok(ctx, readiness);
  },
  // x-status needs-upstream (GAP-004, G4): no non-dispatching ContextPacket preview exists yet,
  // so the BFF answers 503 with the blocker until the Bridge preview hook lands (CXT-04 AC1).
  postFincrimeContextPacketsPreview: (ctx) => fail(ctx, 503, "bff.upstream_unavailable", "Recorded mode does not assemble runtime context packets. Use an HTTP environment and choose an explicit case, plan and node.", { blockers: ["mock.preview_unavailable"] }),

  getFincrimeWork: (ctx) => {
    // Scoped by standing, as the BFF does: named on the case, in its team, or overseeing all case work.
    const queue = attentionFor(ctx.state, caller(ctx));
    const assignment = assignmentFor(ctx);
    const oversees = (ctx.session.actions as string[]).includes("case.assign");
    const standing = oversees ? "oversight"
      : (assignment.assignees as string[]).includes(ctx.subject) ? "assigned"
      : TEAMS.find((team) => team.teamId === assignment.team.teamId)?.members.includes(ctx.subject) ? "team" : null;
    for (const group of queue.groups as Rec[]) {
      group.items = standing ? (group.items as Rec[]).map((item) => ({ ...item, assignment, standing })) : [];
    }
    if (!standing) for (const kpi of queue.kpis as Rec[]) kpi.value = 0;
    queue.scope = oversees ? "all" : "standing";
    return ok(ctx, queue);
  },
  getFincrimeTeams: (ctx) => ok(ctx, { teams: clone(TEAMS) }),
  postFincrimeCasesCaseIdAssignment: (ctx) => {
    if (ctx.params.caseId !== ctx.state.store.caseSummary.caseId) return notFound(ctx, "Case");
    if (!validatorFor("CaseAssignmentRequest")(ctx.body)) return fail(ctx, 400, "assignment.request_invalid", "Choose a team and give a reason.");
    const body = ctx.body as Rec;
    const fin = ctx.state.fin as Rec;
    fin.assignmentReceipts ??= {};
    const held = fin.assignmentReceipts[body.idempotencyKey as string] as { body: Rec; receipt: Rec } | undefined;
    if (held) return JSON.stringify(held.body) === JSON.stringify(body) ? ok(ctx, held.receipt) : fail(ctx, 409, "command.idempotency_conflict", "This key was used for a different assignment.");
    if (body.expectedCaseSequence !== caseSequence(ctx.state)) return fail(ctx, 409, "case.sequence_conflict", "The case changed while you were assigning it. Refresh and try again.");
    const team = TEAMS.find((entry) => entry.teamId === body.teamId);
    if (!team) return fail(ctx, 409, "assignment.team_not_found", "That team does not exist.");
    const assignees = [...new Set(body.assignees as string[])].sort();
    if (assignees.some((subject) => !team.members.includes(subject))) return fail(ctx, 409, "assignment.assignee_not_in_team", "Everyone named must be a member of the team.");
    fin.assignment = {
      team: { teamId: team.teamId, name: team.name }, assignees, reason: body.reason,
      assignedBy: { principalId: ctx.subject, type: "HUMAN", roles: [] }, assignedAt: new Date(Date.parse(ctx.state.clock)).toISOString(),
    };
    ctx.state.store.caseSummary.caseSequence += 1;
    if (fin.claims) fin.claims.caseSequence = ctx.state.store.caseSummary.caseSequence;
    fin.caseRoom.caseSequence = ctx.state.store.caseSummary.caseSequence;
    const receipt = { outcome: "ACCEPTED", commandId: `assign_${crypto.randomUUID()}`, caseSequence: caseSequence(ctx.state), eventIds: [], reasonCode: null };
    fin.assignmentReceipts[body.idempotencyKey as string] = { body: clone(body), receipt };
    return ok(ctx, receipt);
  },
  getFincrimeCasesCaseIdRecon: (ctx) => reconPreview(ctx, false),
  postFincrimeCasesCaseIdRecon: (ctx) => reconPreview(ctx, true),
  getFincrimeCasesCaseIdRoom: (ctx) => caseRead(ctx, () => ({ ...caseRoom(ctx.state), assignment: assignmentFor(ctx) }), "The case room"),
  getFincrimeCasesCaseIdClaims: (ctx) => caseRead(ctx, () => {
    const kind = ctx.url.searchParams.get("kind");
    const claims = clone(ctx.state.fin.claims as Rec);
    claims.caseSequence = caseSequence(ctx.state);
    if (kind) claims.items = (claims.items as Rec[]).filter((item) => item.kind === kind);
    return claims;
  }, "Claims"),
  getFincrimeCasesCaseIdEvidence: (ctx) => caseRead(ctx, () => {
    // As many items as the case room counts, so the list and the count never disagree.
    const count = Number((ctx.state.fin.caseRoom as Rec).counts?.evidence ?? 0);
    const statements = ((ctx.state.fin.claims as Rec | undefined)?.items ?? []) as Rec[];
    return {
      caseSequence: caseSequence(ctx.state),
      items: EVIDENCE.slice(0, count).map(([evidenceId, evidenceType, type, dataset, agent, minute]) => ({
        evidenceId, evidenceType,
        source: { type, dataset, datasetVersion: dataset ? "2026-11" : null, capability: null, retrievedAt: `2026-11-08T03:${minute}:00Z`, sourceEffectiveAt: null },
        subjectRefs: ["acme"], addedBy: { principalId: agent, type: agent.startsWith("agent.") ? "AGENT" : "HUMAN", roles: [] }, addedAt: `2026-11-08T03:${minute}:05Z`,
        integrity: "DIGEST_VERIFIED", scanStatus: "POC_NOT_SCANNED", classification: "CONFIDENTIAL", documentId: null,
        citedBy: statements.filter((item) => (item.evidenceIds as string[]).includes(evidenceId)).map((item) => item.id as string),
      })),
    };
  }, "The case evidence"),
  getFincrimeCasesCaseIdFindings: (ctx) => caseRead(ctx, () => ({ caseSequence: caseSequence(ctx.state), items: findingsFor(ctx) }), "The case findings", true),
  postFincrimeCasesCaseIdFindingsFindingIdDispositions: (ctx) => {
    if (ctx.params.caseId !== ctx.state.store.caseSummary.caseId) return notFound(ctx, "Case");
    if (!validatorFor("FindingDispositionRequest")(ctx.body)) return fail(ctx, 400, "finding.disposition_invalid", "Choose an outcome and give a rationale.");
    const body = ctx.body as Rec;
    const fin = ctx.state.fin as Rec;
    fin.findingDispositionReceipts ??= {};
    const key = `${ctx.params.findingId}:${String(body.idempotencyKey)}`;
    const held = fin.findingDispositionReceipts[key] as { body: Rec; receipt: Rec } | undefined;
    if (held) return JSON.stringify(held.body) === JSON.stringify(body) ? ok(ctx, held.receipt) : fail(ctx, 409, "command.idempotency_conflict", "This key was used for a different disposition.");
    const finding = findingsFor(ctx).find((item) => item.findingId === ctx.params.findingId);
    if (!finding) return notFound(ctx, "Finding");
    if (!finding.disposition.allowed) return fail(ctx, 409, "finding.disposition_not_allowed", finding.disposition.reason ?? "This finding cannot be dispositioned here.");
    if (body.expectedCaseSequence !== caseSequence(ctx.state)) return fail(ctx, 409, "case.sequence_conflict", "The case changed while you were reviewing. Refresh before recording a disposition.");
    const onFile = new Set(EVIDENCE.map(([id]) => id));
    if ((body.viewedEvidenceIds as string[]).some((id) => !onFile.has(id))) return fail(ctx, 409, "finding.evidence_not_on_case", "Evidence you cited is not on this case.");
    fin.findingDispositions ??= {};
    (fin.findingDispositions[ctx.params.findingId!] ??= []).push({
      id: `rev_${crypto.randomUUID()}`, source: "review", outcome: body.outcome, rationale: body.rationale,
      by: { principalId: ctx.subject, type: "HUMAN", roles: [] }, at: new Date(Date.parse(ctx.state.clock)).toISOString(),
    });
    ctx.state.store.caseSummary.caseSequence += 1;
    if (fin.claims) fin.claims.caseSequence = ctx.state.store.caseSummary.caseSequence;
    fin.caseRoom.caseSequence = ctx.state.store.caseSummary.caseSequence;
    const receipt = { outcome: "ACCEPTED", commandId: `review_${crypto.randomUUID()}`, caseSequence: caseSequence(ctx.state), eventIds: [], reasonCode: null };
    fin.findingDispositionReceipts[key] = { body: clone(body), receipt };
    return ok(ctx, receipt);
  },
  getFincrimeCasesCaseIdContradictionsContradictionId: (ctx) => caseRead(ctx, () => clone(ctx.state.fin.contradictions?.[ctx.params.contradictionId!]), "This contradiction"),
  getFincrimeCasesCaseIdOwnership: (ctx) => caseRead(ctx, () => clone(ctx.state.fin.ownership), "The ownership view"),
  getFincrimeCasesCaseIdScreening: (ctx) => caseRead(ctx, () => clone(ctx.state.fin.screening), "The screening view"),
  getFincrimeCasesCaseIdScreeningFindingId: (ctx) => caseRead(ctx, () => {
    const comparison = clone(ctx.state.fin.screeningComparisons?.[ctx.params.findingId!]) as Rec | undefined;
    if (!comparison) return null;
    const workItemId = comparison.humanWork?.workItem?.workItemId;
    if (workItemId) comparison.humanWork = clone(queueItem(ctx.state, workItemId) ?? null);
    return comparison;
  }, "This screening finding"),
  // youMay is computed for the caller, so the validator is per caller.
  getFincrimeCasesCaseIdDecision: (ctx) => caseRead(ctx, () => decisionDesk(ctx.state, caller(ctx)), "The decision desk", true),
  postFincrimeCasesCaseIdCommandsPreview: (ctx) => {
    if (ctx.params.caseId !== ctx.state.store.caseSummary.caseId) return notFound(ctx, "Case");
    const body = (ctx.body ?? {}) as Rec;
    const current = caseSequence(ctx.state);
    if (body.preconditions?.caseSequence !== current) {
      return fail(ctx, 409, "case.sequence_conflict", `The case changed while you were preparing this (sequence ${String(body.preconditions?.caseSequence)} → ${current}).`);
    }
    const snapshot = ctx.state.store.snapshot as Rec;
    const command = {
      actor: { type: "HUMAN", principalId: ctx.subject, roles: [...ctx.session.roles] },
      // GAP-006: authority for human commands is filled from the case snapshot.
      authority: { permissionEnvelopeDigest: snapshot.dependencyDigest, planDigest: snapshot.planDigest, policySnapshotDigest: snapshot.policyAuthority.policySnapshotDigest },
      caseId: snapshot.caseId,
      commandId: `cmd_preview_${hex64(JSON.stringify(body)).slice(0, 12)}`,
      commandType: body.commandType,
      commandVersion: body.commandVersion,
      idempotencyKey: body.idempotencyKey,
      payload: clone(body.payload ?? {}),
      preconditions: { caseSequence: current },
      tenantId: snapshot.tenantId,
    };
    const diff = body.commandType === "ResolveContradiction"
      ? [
        { path: `contradictions.${String(body.payload?.contradictionId)}.status`, before: "OPEN", after: "RESOLVED" },
        { path: "caseSequence", before: String(current), after: String(current + 1) },
      ]
      : Object.entries((body.payload ?? {}) as Rec).map(([key, value]) => ({ path: `payload.${key}`, before: null, after: typeof value === "string" ? value : JSON.stringify(value) }));
    return ok(ctx, {
      command,
      diff,
      effects: [
        { kind: "case_state", description: `${String(body.commandType)} is recorded against case ${snapshot.caseId}.` },
        { kind: "audit", description: "A case event is appended to the hash-chained ledger." },
      ],
      warnings: [],
      basis: { caseSequence: current, snapshotDigest: snapshot.snapshotDigest },
    });
  },
  getFincrimeCasesCaseIdRecorder: (ctx) => caseRead(ctx, () => clone(ctx.state.fin.recorder), "The flight recorder"),
  getFincrimeCasesCaseIdRecorderEntriesEntryRef: (ctx) => caseRead(ctx, () => {
    const entry = (ctx.state.fin.recorder?.entries as Rec[] | undefined)?.find((item) => item.ref === ctx.params.entryRef);
    if (!entry) return null;
    const last = (ctx.state.store.caseEvents as Rec[]).at(-1);
    return {
      entry: clone(entry),
      raw: clone((ctx.state.store.caseEvents as Rec[]).find((event) => entry.source === "case_event" && event.sequence === entry.sequence) ?? entry),
      ledger: { verified: true, headDigest: last ? hex64(`event:${ctx.state.store.caseSummary.caseId}:${last.sequence}`) : null, checkedEvents: (ctx.state.store.caseEvents as Rec[]).length },
    };
  }, "This recorder entry"),
  getFincrimeCasesCaseIdRecorderCausality: (ctx) => caseRead(ctx, () => clone(ctx.state.fin.causality), "The causal graph"),
  getFincrimeCasesCaseIdLineage: (ctx) => caseRead(ctx, () => clone(ctx.state.fin.lineage), "Decision lineage"),
  getFincrimeAssuranceMissionControl: (ctx) => ok(ctx, clone(ctx.state.fin.missionControl)),

};
