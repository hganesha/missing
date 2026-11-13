import { clone, SCENARIO, SCENARIOS, type Rec, type ScenarioName } from "./fixtures.js";
import { advanceClock, loadScenario, type MockState } from "./state.js";

/**
 * Scenario engine (BUILD-SPEC v2 §6.2, §6.5). The EHF store is the source of truth for work
 * items, claims and decisions; FinCrime projections are recomputed from it for the current
 * caller after every mutation and persona switch, using the same rules as the BFF (§5.6).
 */
const PENDING = new Set(["HUMAN_REQUIRED", "WAITING_HUMAN"]);

const GROUP_LABELS: Record<string, string> = {
  needs_action: "Needs your decision",
  prepared_by_agents: "Prepared by agents",
  waiting_on_others: "Waiting on others",
  approaching_deadline: "Approaching deadline",
  escalated_or_blocked: "Escalated or blocked",
};
const GROUP_ORDER = Object.keys(GROUP_LABELS);

export function isPending(item: Rec): boolean {
  return PENDING.has(item.workItem.status);
}

export function queue(state: MockState): Rec[] {
  return state.store.humanQueue as Rec[];
}

export function queueItem(state: MockState, workItemId: string): Rec | undefined {
  return queue(state).find((item) => item.workItem.workItemId === workItemId);
}

export function caseSequence(state: MockState): number {
  return state.store.caseSummary.caseSequence;
}

/**
 * Claims and decisions on human work change the case room and decision desk without a case
 * event, so `"seq-<n>"` alone would answer 304 over them (GAP-074). The store carries a
 * human-work version that the case ETag includes once it moves; a scenario load resets it.
 */
export function touchHumanWork(state: MockState): void {
  state.store.humanWorkVersion = (Number(state.store.humanWorkVersion) || 0) + 1;
}

export function caseEtag(state: MockState, caller?: string): string {
  // Scenario states can share a sequence (S3 and S4 are both 31), so the state is part of it too.
  const version = Number(state.store.humanWorkVersion) || 0;
  const scenario = SCENARIOS.indexOf(state.scenario);
  return `"seq-${caseSequence(state)};s${scenario}${version ? `.${version}` : ""}${caller ? `;${caller}` : ""}"`;
}

export function hasConflict(item: Rec): boolean {
  return new Set((item.decisions as Rec[]).map((decision) => decision.decision)).size > 1;
}

type Caller = { subject: string; actions: string[] };

/** BIZ-01 attention queue for the caller: mine, claimable and group are per caller. */
export function attentionFor(state: MockState, caller: Caller): Rec {
  const base = state.fin.attention as Rec;
  const items: Rec[] = [];
  for (const group of base.groups as Rec[]) {
    for (const entry of group.items as Rec[]) {
      const item = clone(entry);
      const live = queueItem(state, item.workItemId);
      if (live) {
        const decided = (live.decisions as Rec[]).some((decision) => decision.principalId === caller.subject);
        item.workStatus = live.workItem.status;
        item.claim = {
          assignedTo: [...live.assignedTo],
          mine: live.assignedTo.includes(caller.subject),
          claimable: isPending(live) && caller.actions.includes("human_work.claim") && !live.assignedTo.includes(caller.subject),
        };
        item.decisionsSoFar = live.decisions.length;
        item.requiredApprovals = live.requiredApprovals;
        item.overdue = live.overdue;
        item.escalated = live.escalated;
        item.caseStatus = state.store.caseSummary.status;
        item.group = decided && live.decisions.length < live.requiredApprovals ? "waiting_on_others" : hasConflict(live) ? "escalated_or_blocked" : "needs_action";
      } else if (PENDING.has(item.workStatus)) {
        continue; // The human item completed since the fixture was captured.
      }
      items.push(item);
    }
  }
  const pending = queue(state).filter(isPending);
  return {
    generatedAt: state.clock,
    kpis: (base.kpis as Rec[]).map((kpi) => {
      const value = kpi.key === "open" ? pending.length
        : kpi.key === "overdue" ? pending.filter((item) => item.overdue).length
          : kpi.key === "dual" ? pending.filter((item) => item.requiredApprovals > 1 && item.decisions.length > 0).length
            : kpi.value;
      return { ...kpi, value, emphasis: value > 0 ? (kpi.key === "overdue" ? "blocking" : "attention") : "none" };
    }),
    groups: GROUP_ORDER
      .map((group) => ({ group, label: GROUP_LABELS[group]!, items: items.filter((item) => item.group === group) }))
      .filter((group) => group.items.length > 0),
  };
}

/** BIZ-02 case room with live status, sequence, work item states and human work. */
export function caseRoom(state: MockState): Rec {
  const room = clone(state.fin.caseRoom as Rec);
  room.status = state.store.caseSummary.status;
  room.caseSequence = caseSequence(state);
  room.snapshotDigest = state.store.snapshot.snapshotDigest;
  room.humanWork = clone(queue(state));
  room.recentEvents = clone((state.store.caseEvents as Rec[]).slice(-6).reverse());
  const byId = new Map((state.store.workItems as Rec[]).map((item) => [item.workItemId, item]));
  room.workItems = (room.workItems as Rec[]).map((row) => {
    const live = byId.get(row.workItemId);
    return live ? { ...row, status: live.status, updatedAt: live.updatedAt } : row;
  });
  for (const live of state.store.workItems as Rec[]) {
    if ((room.workItems as Rec[]).some((row) => row.workItemId === live.workItemId)) continue;
    room.workItems.push({
      workItemId: live.workItemId,
      objective: live.objective,
      status: live.status,
      agentId: live.constraints?.agentProfile ?? null,
      taskId: live.constraints?.taskId ?? null,
      stepId: live.constraints?.stepId ?? null,
      skillStatus: null,
      updatedAt: live.updatedAt,
    });
  }
  return room;
}

/** BIZ-07 decision desk; `youMay` is computed for the caller. */
export function decisionDesk(state: MockState, caller: Caller): Rec | null {
  const desk = state.fin.decision as Rec | null;
  if (!desk) return null;
  const view = clone(desk);
  const workItemId: string | undefined = desk.humanWork?.workItem?.workItemId
    ?? (state.store.workItems as Rec[]).find((item) => item.workType === "human_review" && item.workItemId === "wi_decision")?.workItemId;
  const live = workItemId ? queueItem(state, workItemId) : undefined;
  view.status = state.store.caseSummary.status;
  view.basis = { caseSequence: caseSequence(state), snapshotDigest: state.store.snapshot.snapshotDigest };
  view.humanWork = live ? clone(live) : null;
  const decided: Rec[] = live ? clone(live.decisions) : (state.store.decisions as Rec[]).filter((decision) => decision.workItemId === workItemId);
  const pending = live ? isPending(live) : false;
  const mine = live ? live.assignedTo.includes(caller.subject) : false;
  const decidedByMe = decided.some((decision) => decision.principalId === caller.subject);
  const conflict = live ? hasConflict(live) : false;
  const youMay = {
    claim: pending && caller.actions.includes("human_work.claim") && !mine,
    decide: pending && !conflict && caller.actions.includes("human_work.decide") && !decidedByMe && (mine || (live?.assignedTo.length ?? 0) === 0),
    resolve: conflict && caller.actions.includes("human_work.resolve") && !decidedByMe,
  };
  const reasonIfNot = !live ? "No decision is waiting on this case."
    : decidedByMe ? "You already decided. A second, different approver is required."
      : conflict && !youMay.resolve ? "Reviewers disagree. An operator who did not decide must resolve it."
        : !caller.actions.includes("human_work.decide") ? "Your role does not permit deciding this item."
          : null;
  view.requirements = { ...view.requirements, requiredApprovals: live?.requiredApprovals ?? view.requirements.requiredApprovals, decided, youMay, reasonIfNot };
  return view;
}

// ---- mutations --------------------------------------------------------------------------

function completeItem(state: MockState, item: Rec, reasonCode: string): void {
  const stamp = state.clock;
  const update = (workItem: Rec) => Object.assign(workItem, { status: "COMPLETED", reasonCode, terminalAt: stamp, updatedAt: stamp, transitionSequence: workItem.transitionSequence + 1 });
  update(item.workItem);
  const stored = (state.store.workItems as Rec[]).find((workItem) => workItem.workItemId === item.workItem.workItemId);
  if (stored) update(stored);
  state.store.humanQueue = queue(state).filter((entry) => entry !== item);
}

/**
 * Record a decision that passed every check, then settle the item: quorum completes it and
 * fires the scenario transition or rule; differing decisions leave it WAITING_HUMAN in
 * conflict (§6.4).
 */
export function recordDecision(state: MockState, item: Rec, decision: Rec): { effective: boolean; conflict: boolean; transitioned: ScenarioName | null } {
  touchHumanWork(state);
  item.decisions.push(decision);
  state.store.decisions.push(decision);
  if (!item.assignedTo.includes(decision.principalId)) item.assignedTo.push(decision.principalId);
  if (hasConflict(item)) {
    item.workItem.reasonCode = "workflow.human_decision_conflict";
    const stored = (state.store.workItems as Rec[]).find((workItem) => workItem.workItemId === item.workItem.workItemId);
    if (stored) stored.reasonCode = "workflow.human_decision_conflict";
    return { effective: false, conflict: true, transitioned: null };
  }
  const priorPrincipals = (item.decisions as Rec[]).slice(0, -1).map((entry) => entry.principalId);
  const transition = findTransition(state, item.workItem.workItemId, decision.decision, decision.principalId, priorPrincipals);
  if (transition) {
    goTo(state, transition, [decision]);
    return { effective: queueItem(state, item.workItem.workItemId) === undefined, conflict: false, transitioned: transition };
  }
  const quorum = (item.decisions as Rec[]).filter((entry) => entry.decision === decision.decision).length >= item.requiredApprovals;
  if (!quorum) return { effective: false, conflict: false, transitioned: null };
  completeItem(state, item, decision.reasonCode);
  applyRules(state, item, decision.decision);
  return { effective: true, conflict: false, transitioned: null };
}

/** An independent operator settles a conflict; the outcome then behaves like a decision. */
export function resolveConflict(state: MockState, item: Rec, resolution: Rec): ScenarioName | null {
  touchHumanWork(state);
  state.store.decisions.push(resolution);
  const transition = findTransition(state, item.workItem.workItemId, resolution.decision, resolution.principalId, []);
  if (transition) {
    goTo(state, transition, [resolution]);
    return transition;
  }
  completeItem(state, item, resolution.reasonCode);
  applyRules(state, item, resolution.decision);
  return null;
}

function findTransition(state: MockState, workItemId: string, decision: string, principalId: string, prior: string[]): ScenarioName | null {
  const match = (SCENARIO.transitions as Rec[]).find((transition) =>
    transition.from === state.scenario
    && transition.on.workItemId === workItemId
    && transition.on.decision === decision
    && (!transition.on.distinctFromPrior || !prior.includes(principalId)));
  return match ? match.to : null;
}

/**
 * Move to the next scenario state. The fixture for that state already contains decisions
 * by its scripted principals; the decisions actually recorded here replace the scripted
 * ones for the same work item and outcome, so "who decided" stays truthful.
 */
function goTo(state: MockState, to: ScenarioName, recorded: Rec[]): void {
  const carried = [...(state.store.decisions as Rec[])];
  const clock = state.clock;
  loadScenario(state, to);
  if (Date.parse(clock) > Date.parse(state.clock)) state.clock = clock;
  for (const decision of [...carried, ...recorded]) {
    const decisions = state.store.decisions as Rec[];
    if (decisions.some((entry) => entry.decisionId === decision.decisionId)) continue;
    const scripted = decisions.findIndex((entry) => entry.workItemId === decision.workItemId && entry.decision === decision.decision
      && !carried.some((kept) => kept.decisionId === entry.decisionId));
    if (scripted >= 0) {
      const replaced = decisions[scripted]!;
      decisions[scripted] = decision;
      for (const item of queue(state)) {
        item.decisions = (item.decisions as Rec[]).map((entry) => (entry.decisionId === replaced.decisionId ? decision : entry));
        item.assignedTo = (item.assignedTo as string[]).map((principal) => (principal === replaced.principalId ? decision.principalId : principal));
      }
    }
  }
}

/** §6.5 "other effects" that are not state transitions. */
function applyRules(state: MockState, item: Rec, decision: string): void {
  const workItemId = item.workItem.workItemId;
  if (workItemId === "wi_own_review" && decision === "RETURN") {
    const rework = clone(item.workItem);
    Object.assign(rework, {
      workItemId: "wi_own_rework",
      workType: "fincrime.skill_step",
      assuranceClass: "standard",
      objective: "Rework ownership findings with the evidence the reviewer requested",
      status: "READY",
      reasonCode: "workflow.rework_requested",
      readyAt: state.clock,
      terminalAt: null,
      createdAt: state.clock,
      updatedAt: state.clock,
      transitionSequence: 1,
      dispatch: { ...rework.dispatch, queue: "fincrime", publishedAt: state.clock },
      constraints: { ...rework.constraints, agentProfile: "agent.identity_ownership", gate: null },
    });
    state.store.workItems.push(rework);
    moveAttention(state, workItemId, (entry) => Object.assign(entry, {
      workItemId: "wi_own_rework",
      objective: rework.objective,
      workStatus: "READY",
      gate: null,
      group: "prepared_by_agents",
      claim: { assignedTo: [], mine: false, claimable: false },
      decisionsSoFar: 0,
    }));
  }
  if (workItemId === "wi_scr_review" && decision === "REJECT") {
    setCaseStatus(state, "INVESTIGATING");
    moveAttention(state, workItemId, (entry) => Object.assign(entry, {
      objective: "EDD required: the screening reviewer rejected the false-match proposal",
      workStatus: "COMPLETED",
      gate: "edd.required",
      group: "escalated_or_blocked",
      caseStatus: "INVESTIGATING",
      claim: { assignedTo: [], mine: false, claimable: false },
      route: `/work/cases/${item.workItem.caseId}/lens/edd`,
    }));
  }
}

function moveAttention(state: MockState, workItemId: string, update: (entry: Rec) => void): void {
  for (const group of state.fin.attention.groups as Rec[]) {
    for (const entry of group.items as Rec[]) {
      if (entry.workItemId === workItemId) update(entry);
    }
  }
}

export function setCaseStatus(state: MockState, status: string): void {
  state.store.caseStatus = status;
  state.store.caseSummary.status = status;
  state.store.snapshot.data.status = status;
  state.fin.caseRoom.status = status;
}

/** ResolveContradiction on an open contradiction: bump the sequence and mark it RESOLVED. */
export function resolveContradiction(state: MockState, contradictionId: string, command: Rec): Rec | null {
  const contradiction = state.fin.contradictions?.[contradictionId] as Rec | undefined;
  if (!contradiction || contradiction.status !== "OPEN") return null;
  advanceClock(state, 60);
  const sequence = caseSequence(state) + 1;
  contradiction.status = "RESOLVED";
  contradiction.commands = (contradiction.commands as Rec[]).map((affordance) => ({ ...affordance, enabled: false, disabledReason: "Resolved" }));
  state.store.caseSummary.caseSequence = sequence;
  state.store.caseSummary.updatedAt = state.clock;
  state.store.snapshot.caseSequence = sequence;
  state.store.snapshot.snapshotId = `snap_${state.store.snapshot.caseId}_${sequence}`;
  state.store.snapshot.capturedAt = state.clock;
  state.store.caseEvents.push({
    sequence,
    commandType: "ResolveContradiction",
    summary: `Contradiction ${contradictionId} resolved: ${command.payload?.resolution ?? "resolved"}`,
    actor: command.actor,
    occurredAt: state.clock,
  });
  if (state.fin.claims) state.fin.claims.caseSequence = sequence;
  state.fin.caseRoom.caseSequence = sequence;
  if (state.fin.caseRoom.counts) state.fin.caseRoom.counts.openContradictions = Math.max(0, state.fin.caseRoom.counts.openContradictions - 1);
  settleProjections(state, contradiction, command, sequence);
  return { sequence };
}

/** "12%" → "0.12": exact decimal strings, never floats in the payload (contract pattern). */
function percentToDecimal(value: string): string | null {
  const match = /^(\d+)(?:\.(\d+))?%$/.exec(value.trim());
  if (!match) return null;
  const digits = `${match[1]}${match[2] ?? ""}`.padStart(3 + (match[2]?.length ?? 0), "0");
  const scale = 2 + (match[2]?.length ?? 0);
  const whole = digits.slice(0, digits.length - scale).replace(/^0+(?=\d)/, "") || "0";
  const fraction = digits.slice(digits.length - scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

/**
 * The FinCrime projections that read the contradiction (ownership edge, the claim, the lens
 * badge) follow the case event, as the BFF's pure projection over the snapshot would (§5.6).
 */
function settleProjections(state: MockState, contradiction: Rec, command: Rec, sequence: number): void {
  const accepted = (contradiction.assertions as Rec[] | undefined)?.find((assertion) => assertion.assertionId === command.payload?.assertionId);
  const decimal = typeof accepted?.value === "string" ? percentToDecimal(accepted.value) : null;
  const ownership = state.fin.ownership as Rec | undefined;
  const subjects = new Set<string>();
  for (const edge of (ownership?.edges as Rec[] | undefined) ?? []) {
    if (edge.contradictionId !== contradiction.contradictionId) continue;
    subjects.add(edge.source);
    if (!accepted) continue;
    Object.assign(edge, { status: "verified", interest: decimal ?? edge.interest, interestAlternative: null, label: accepted.value, evidenceIds: [...new Set([...(edge.evidenceIds as string[]), accepted.evidenceId].filter(Boolean))] });
    const node = (ownership!.nodes as Rec[]).find((entry) => entry.id === edge.source);
    if (node) Object.assign(node, { sublabel: `${String(accepted.value)} direct`, effectiveInterest: decimal ?? node.effectiveInterest });
  }
  for (const claim of (state.fin.claims?.items as Rec[] | undefined) ?? []) {
    if (claim.kind !== "contradiction" || claim.status !== "open" || !subjects.has(claim.subjectRef)) continue;
    Object.assign(claim, {
      status: "resolved",
      epistemic: accepted ? "fact" : claim.epistemic,
      value: accepted ? `${String(accepted.value)} (${String(accepted.source?.kind ?? "accepted")})` : claim.value,
      evidenceIds: accepted?.evidenceId ? [...new Set([...(claim.evidenceIds as string[]), accepted.evidenceId])] : claim.evidenceIds,
      acceptedBy: command.actor ?? null,
      caseSequence: sequence,
    });
  }
  const open = Object.values((state.fin.contradictions ?? {}) as Record<string, Rec>).filter((entry) => entry.status === "OPEN").length;
  for (const lens of (state.fin.caseRoom.lenses as Rec[] | undefined) ?? []) {
    if (lens.lens === "ownership") lens.badge = open ? `${open} open` : null;
  }
}
