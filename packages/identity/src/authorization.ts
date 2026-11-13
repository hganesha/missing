/**
 * Application roles and the actions they permit.
 *
 * Coarse gates at the edge (an ingress controller, an API gateway, a service mesh policy)
 * decide who may reach a service. They do not decide what a caller may do once it is
 * there, so every protected operation is authorized again here against the resolved
 * principal. The table below is the single place that mapping lives.
 */

export type PlatformAction =
  | "context.refresh"
  | "plan.read" | "plan.admit"
  | "run.read" | "run.start" | "run.cancel" | "run.retry"
  | "draft.read" | "draft.write" | "draft.compile" | "draft.evaluate" | "draft.approve" | "draft.publish"
  | "release.read" | "release.create" | "release.approve" | "release.activate" | "release.revoke"
  | "human_work.read" | "human_work.claim" | "human_work.decide" | "human_work.resolve"
  | "agent.register"
  | "capability.read" | "capability.register"
  | "case.read" | "case.write" | "case.review" | "case.replan" | "case.assign"
  | "discovery.read" | "discovery.request" | "discovery.launch"
  | "evidence.read" | "evidence.write"
  | "receipt.read" | "event.read" | "telemetry.read"
  | "admin.read" | "admin.write"
  | "integration.read" | "integration.connector.write" | "integration.bind" | "integration.test"
  | "integration.activate" | "integration.pause" | "integration.replay" | "integration.ingress" | "integration.dispatch"
  | "workbench.evaluate" | "runtime.admission.write" | "runtime.state.write" | "policy.authority.read" | "outbox.publish" | "envelope.mint" | "envelope.delegate"
  | "context.release"
  | "legal_hold.read" | "legal_hold.write"
  // Document Factory (document factory plan §7.4): training data and model releases.
  | "dataset.read" | "dataset.curate" | "dataset.authorize" | "factory.train" | "factory.work" | "deployment.verify";

export type HumanRole =
  | "Harness.Reader" | "Harness.Author" | "Harness.Approver" | "Harness.Operator"
  | "Case.Analyst" | "Case.Reviewer" | "Case.Manager" | "Platform.Auditor" | "Platform.Admin" | "Legal.HoldOfficer" | "Data.Owner";

/** Human roles available in the application directory. Workload roles are never assignable. */
export const HUMAN_ROLES = [
  { id: "Harness.Reader", name: "Process flow reader", description: "View process flows, runs, cases and releases." },
  { id: "Harness.Author", name: "Process flow author", description: "Create and test drafts, agents and release candidates." },
  { id: "Harness.Approver", name: "Process flow approver", description: "Review and approve process flows and releases." },
  { id: "Harness.Operator", name: "Process flow operator", description: "Operate runs, activate releases and manage integrations." },
  { id: "Case.Analyst", name: "Case analyst", description: "Work on cases and collect supporting evidence." },
  { id: "Case.Reviewer", name: "Case reviewer", description: "Review cases and make human work decisions." },
  { id: "Case.Manager", name: "Case manager", description: "Oversee case work and assign cases to teams and people." },
  { id: "Platform.Auditor", name: "Platform auditor", description: "Inspect activity, configuration and change history." },
  { id: "Platform.Admin", name: "Platform administrator", description: "Manage users, roles and platform configuration." },
  { id: "Legal.HoldOfficer", name: "Legal hold officer", description: "Place and release legal holds on case evidence." },
  { id: "Data.Owner", name: "Training data owner", description: "Authorize documents for model training and revoke that authorization." },
] as const satisfies readonly { id: HumanRole; name: string; description: string }[];

export type WorkloadRole =
  | "Control.Api.Access" | "Case.Api.Access" | "Capability.Invoke" | "Runtime.State.Write"
  | "Integration.Dispatch" | "Envelope.Delegate" | "Skill.Host" | "Case.Outbox.Publish" | "Policy.Authority.Read"
  | "Context.Release" | "Context.Refresh" | "Workbench.Evaluate" | "Case.Replan" | "Factory.Worker" | "Discovery.Launch";

const READ_ACTIONS: PlatformAction[] = [
  "plan.read", "run.read", "draft.read", "capability.read",
  "case.read", "evidence.read", "receipt.read", "event.read", "release.read", "human_work.read",
  "integration.read",
];

const ROLE_ACTIONS: Record<string, PlatformAction[]> = {
  "Harness.Reader": READ_ACTIONS,
  "Harness.Author": [...READ_ACTIONS, "draft.write", "draft.compile", "draft.evaluate", "agent.register", "capability.register", "release.create", "dataset.read", "dataset.curate"],
  // Approval is deliberately not a superset of authoring: the separation-of-duties check
  // that rejects self-approval only means anything if the two are distinct grants.
  "Harness.Approver": [...READ_ACTIONS, "draft.approve", "draft.publish", "release.approve", "dataset.read"],
  "Harness.Operator": [...READ_ACTIONS, "telemetry.read", "runtime.admission.write", "plan.admit", "run.start", "run.cancel", "run.retry", "release.activate", "release.revoke", "human_work.resolve", "integration.bind", "integration.test", "integration.activate", "integration.pause", "integration.replay", "dataset.read", "factory.train"],
  // People who work a case read its event log and see what it is waiting on. Both are reads:
  // an analyst can see a human step and why they cannot decide it, but claiming and deciding
  // stay with the reviewer.
  "Case.Analyst": ["case.read", "discovery.read", "discovery.request", "case.write", "evidence.read", "evidence.write", "run.read", "event.read", "human_work.read"],
  "Case.Reviewer": ["case.read", "discovery.read", "case.review", "evidence.read", "run.read", "event.read", "human_work.read", "human_work.claim", "human_work.decide"],
  // An auditor may read the administered configuration and its change log, because
  // "what was this run actually configured to do" is unanswerable without it. Only the
  // administrator may change it, and administration is not a superset of authoring,
  // approval, release or case work: repointing a provider is a different authority from
  // publishing a plan or activating a release.
  "Platform.Auditor": [...READ_ACTIONS, "admin.read", "telemetry.read", "dataset.read"],
  "Platform.Admin": [...READ_ACTIONS, "admin.read", "admin.write", "capability.register", "integration.connector.write"],
  // Oversight of case work (docs/implementation/case-access-model.md): reads everything about a
  // case and its queue, and assigns cases. Deliberately no write, review, claim or decide: the
  // person who distributes the work is not, by this role, the one who approves it.
  "Case.Manager": ["case.read", "discovery.read", "event.read", "evidence.read", "run.read", "human_work.read", "case.assign"],
  // Legal holds over cases' evidence (data-stores-plan.md §3.6). Not case work and not
  // administration: placing a hold freezes evidence deletion, and the store requires the
  // release to come from a different officer than the one who placed it.
  "Legal.HoldOfficer": ["case.read", "legal_hold.read", "legal_hold.write"],
  // Training data (document factory plan §7.4): authorizing a document for training is the data owner's decision,
  // never the curator's; the Factory refuses the same person doing both for one sample.
  "Data.Owner": ["dataset.read", "dataset.authorize"],

  // Workload roles. A workload never inherits a human role and vice versa.
  "Control.Api.Access": ["plan.read", "run.read", "run.start", "event.read", "receipt.read"],
  "Case.Api.Access": ["case.read", "case.write", "evidence.read", "evidence.write"],
  "Capability.Invoke": ["capability.read"],
  "Deployment.Verify": ["deployment.verify"],
  "Runtime.State.Write": ["runtime.state.write", "envelope.mint", "plan.read", "run.read"],
  // The case service publishing committed case events to the integration control plane.
  "Case.Outbox.Publish": ["outbox.publish"],
  // The case service asking the control plane which policy authority a node's grant carries
  // before it evaluates a gate on that node's behalf.
  "Policy.Authority.Read": ["policy.authority.read"],
  // The capability gateway's skills adapter: exchange a node envelope it verified for a
  // delegated envelope narrowed to a skill's declared dependencies (skill.execution.v1 §6.1).
  "Envelope.Delegate": ["envelope.delegate"],
  // A skill host calling the gateway for its dependencies; the gateway accepts only a
  // delegated envelope from it (skill.execution.v1 §9 outbound identity).
  "Skill.Host": ["capability.read"],
  "Integration.Dispatch": ["integration.dispatch", "integration.ingress", "integration.read", "case.read", "case.write", "run.start"],
  // The context release job (data-stores-plan.md §3.3): reads a closed case's release
  // eligibility and records the release in its ledger. It cannot write any other case data.
  "Workbench.Evaluate": ["workbench.evaluate"],
  "Context.Refresh": ["context.refresh"],
  // The control plane moving a case onto the process its policy escalated it to (EDD escalation):
  // the only authority that can change a case's plan and policy pin. No person or agent holds it.
  "Case.Replan": ["case.replan"],
  "Discovery.Launch": ["discovery.launch"],
  "Context.Release": ["case.read", "context.release"],
  // The Document Factory worker: claims approved release jobs and reports their progress and results.
  "Factory.Worker": ["factory.work"],
};

const WORKLOAD_ROLES = new Set<string>(["Control.Api.Access", "Case.Api.Access", "Capability.Invoke", "Runtime.State.Write", "Integration.Dispatch", "Envelope.Delegate", "Skill.Host", "Case.Outbox.Publish", "Policy.Authority.Read", "Edge.Delegate", "Context.Release", "Context.Refresh", "Workbench.Evaluate", "Case.Replan", "Factory.Worker", "Discovery.Launch"]);

export type ResourceRef = {
  kind: string;
  id?: string;
  tenantId?: string;
};

export type AuthorizationDecision = {
  outcome: "allowed" | "denied";
  reasonCode: string;
  action: PlatformAction;
  subjectId: string;
  actorType: string;
  tenantId: string;
  resourceKind: string;
  resourceId: string | null;
};

export class AuthorizationError extends Error {
  readonly httpStatus: number;
  constructor(readonly decision: AuthorizationDecision) {
    super(decision.reasonCode);
    this.httpStatus = decision.reasonCode === "authorization.principal_unauthenticated" ? 401 : 403;
  }
}

export type Principal = {
  subjectId: string;
  tenantId: string;
  actorType: "human" | "workload";
  roles: string[];
  source: "local" | "oidc" | "workload_identity";
  displayName?: string;
  email?: string;
  /** Stable provider object identity, obtained only from verified token claims. */
  directorySubjectId?: string;
};

export function actionsForRoles(roles: readonly string[]): Set<PlatformAction> {
  const allowed = new Set<PlatformAction>();
  for (const role of roles) {
    for (const action of ROLE_ACTIONS[role] ?? []) allowed.add(action);
  }
  return allowed;
}

/**
 * Authorize an action and return the bounded decision record.
 *
 * The decision carries identifiers and a stable reason code and nothing else: no tokens,
 * no claim payloads, no case content. It is safe to log and safe to attach to a span.
 */
export function evaluate(
  principal: Principal | null,
  action: PlatformAction,
  resource: ResourceRef,
): AuthorizationDecision {
  const base = {
    action,
    subjectId: principal?.subjectId ?? "anonymous",
    actorType: principal?.actorType ?? "unknown",
    tenantId: principal?.tenantId ?? "unknown",
    resourceKind: resource.kind,
    resourceId: resource.id ?? null,
  };
  if (!principal) return { ...base, outcome: "denied", reasonCode: "authorization.principal_unauthenticated" };
  if (!actionsForRoles(principal.roles.filter((role) => WORKLOAD_ROLES.has(role) === (principal.actorType === "workload"))).has(action)) {
    return { ...base, outcome: "denied", reasonCode: "authorization.role_missing" };
  }
  // A caller may only ever act inside the tenant its identity was assigned. A requested
  // tenant is a scope, never an authority.
  if (resource.tenantId && resource.tenantId !== principal.tenantId) {
    return { ...base, outcome: "denied", reasonCode: "authorization.tenant_mismatch" };
  }
  return { ...base, outcome: "allowed", reasonCode: "authorization.role_granted" };
}

export interface Authorizer {
  require(principal: Principal | null, action: PlatformAction, resource: ResourceRef): AuthorizationDecision;
}

export function createAuthorizer(
  onDecision?: (decision: AuthorizationDecision) => void,
): Authorizer {
  return {
    require(principal, action, resource) {
      const decision = evaluate(principal, action, resource);
      onDecision?.(decision);
      if (decision.outcome === "denied") throw new AuthorizationError(decision);
      return decision;
    },
  };
}
