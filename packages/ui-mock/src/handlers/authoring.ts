import { clone, FINCRIME, type Rec } from "../fixtures.js";
import { type Ctx, fail, type Impl, notFound, ok, page, refusal as refuseWith } from "../http.js";
import { nextId } from "../state.js";
import { validatorFor } from "@ehf/ui-contracts/validate";
import { inferScope, isScope, previewScope, refuse, SCOPE_FILE, scopeOptions, type ProcessScope } from "../process-scope.js";

const DIGEST = (seed: string) => seed.repeat(64).slice(0, 64);
const NODE_ID = /^[a-z][a-z0-9-]*$/;

// ---- Source model -----------------------------------------------------------------------
// The mock keeps package.yaml and workflow.yaml as JSON documents (JSON is valid YAML), so
// edits round-trip without a YAML dependency. parsedPackage/parsedWorkflow are the parsed
// forms the UI reads (ui-specs §4.3.1, §7.3).

const slug = (id: string) => id.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "node";
const toSource = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Saved layout for seeded nodes: three per row, left to right, so the canvas reads near 1:1. */
function seedPosition(index: number): Rec {
  return { x: 48 + (index % 3) * 300, y: 60 + Math.floor(index / 3) * 170 };
}

function seedWorkflow(ctx: Ctx, name: string, blank: boolean): Rec {
  const plan = ctx.state.platform.plan as Rec;
  const planNodes = (blank ? (plan.nodes as Rec[]).filter((node) => node.primitive === "input" || node.primitive === "output") : plan.nodes) as Rec[];
  const nodes = planNodes.map((node, index) => ({
    id: slug(node.id),
    name: node.name,
    kind: node.primitive,
    ...(node.agentRef ? { agentRef: node.agentRef, modelTier: node.modelTier } : {}),
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    contextSelectorIds: [],
    config: { caseWrites: [], ui: { position: seedPosition(index) } },
  }));
  const edges = nodes.slice(1).map((node, index) => ({ id: `edge-${nodes[index]!.id}-${node.id}`, from: nodes[index]!.id, to: node.id, kind: "data" }));
  return { apiVersion: "ladder.workflow/v1", kind: "Workflow", metadata: { name }, spec: { nodes, edges } };
}

function seedPackage(draft: Rec): Rec {
  return {
    name: draft.parsedPackage?.name ?? "fincrime-kyb",
    domain: draft.domain ?? "fincrime",
    version: draft.version ?? "0.1.0",
    objective: "Decide KYB onboarding with two independent approvers",
    contextSelectors: [],
    contextClassificationPolicies: [],
    integrations: { triggers: [], humanActions: [], publications: [] },
  };
}

function parse(source: string): Rec | null {
  try {
    const value = JSON.parse(source);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

const nodesOf = (draft: Rec): Rec[] => (draft.parsedWorkflow?.spec?.nodes ?? []) as Rec[];
const edgesOf = (draft: Rec): Rec[] => (draft.parsedWorkflow?.spec?.edges ?? []) as Rec[];

/** Parse diagnostics for the stored sources (codes from ui-specs §7.7). */
function diagnose(draft: Rec): Rec[] {
  const diagnostics: Rec[] = [];
  if (!parse(draft.packageSource)) diagnostics.push({ code: "author.source_unparsable", severity: "error", path: "package", message: "package.yaml could not be parsed." });
  if (!parse(draft.workflowSource)) {
    diagnostics.push({ code: "author.source_unparsable", severity: "error", path: "workflow", message: "workflow.yaml could not be parsed." });
    return diagnostics;
  }
  const ids = new Set<string>();
  nodesOf(draft).forEach((node, index) => {
    const id = String(node.id ?? "");
    if (!NODE_ID.test(id)) diagnostics.push({ code: "authoring.node_id_invalid", severity: "error", path: `workflow.spec.nodes.${index}.id`, message: `Node id "${id}" must match ^[a-z][a-z0-9-]*$.` });
    if (ids.has(id)) diagnostics.push({ code: "authoring.node_duplicate", severity: "error", path: `workflow.spec.nodes.${index}.id`, message: `Node id "${id}" is used more than once.` });
    ids.add(id);
  });
  edgesOf(draft).forEach((edge, index) => {
    for (const end of ["from", "to"] as const) {
      if (!ids.has(String(edge[end]))) diagnostics.push({ code: "authoring.edge_reference_missing", severity: "error", path: `workflow.spec.edges.${index}.${end}`, message: `Edge ${String(edge.id ?? index)} points at unknown node "${String(edge[end])}".` });
    }
  });
  return diagnostics;
}

/** Re-serialise the parsed documents into the stored sources. */
function syncSources(draft: Rec): void {
  draft.packageSource = toSource(draft.parsedPackage);
  draft.workflowSource = toSource(draft.parsedWorkflow);
  draft.diagnostics = diagnose(draft);
}

/** Fixture drafts carry placeholder sources; give them an editable workflow once. */
function hydrate(ctx: Ctx, draft: Rec): Rec {
  if (draft.parsedWorkflow?.spec) return draft;
  const pkg = parse(draft.packageSource) ?? seedPackage(draft);
  const workflow = parse(draft.workflowSource);
  draft.parsedPackage = { ...seedPackage(draft), ...pkg };
  draft.parsedWorkflow = workflow?.spec ? workflow : seedWorkflow(ctx, String(draft.parsedPackage.name), draft.workflowSource === "{}\n");
  syncSources(draft);
  return draft;
}

function draftOf(ctx: Ctx): Rec | undefined {
  const draft = (ctx.state.platform.drafts as Rec[]).find((entry) => entry.draftId === ctx.params.draftId);
  return draft ? hydrate(ctx, draft) : undefined;
}

function event(ctx: Ctx, draft: Rec, eventType: string, details: Rec = {}): void {
  draft.events ??= [];
  draft.events.unshift({ eventId: `${draft.draftId}-e${draft.events.length + 1}`, eventType, actor: ctx.subject, revision: draft.revision, details, occurredAt: ctx.state.clock });
}

function author(ctx: Ctx, draft: Rec): void {
  const actors = ctx.state.draftActors.get(draft.draftId) ?? new Set<string>();
  actors.add(ctx.subject);
  ctx.state.draftActors.set(draft.draftId, actors);
}

/**
 * A source mutation: stale `expectedRevision` or a PUBLISHED draft → 409; success bumps the
 * revision, resets status to DRAFT and clears compile/evaluate/approve/publish (§6.4). `apply`
 * may return a Response to reject the change (the draft is then left untouched).
 */
function mutate(ctx: Ctx, apply: (draft: Rec) => Response | void): Rec | Response {
  const draft = draftOf(ctx);
  if (!draft) return notFound(ctx, "Draft");
  if (draft.status === "PUBLISHED" || ctx.body?.expectedRevision !== draft.revision) {
    return fail(ctx, 409, "authoring.revision_conflict_or_published", draft.status === "PUBLISHED"
      ? "This draft is published and can no longer change."
      : `Changed since you opened it (rev ${String(ctx.body?.expectedRevision)} → ${draft.revision}).`, { actor: ctx.subject });
  }
  const before = { name:draft.name, parsedPackage: clone(draft.parsedPackage), parsedWorkflow: clone(draft.parsedWorkflow), packageSource: draft.packageSource, workflowSource: draft.workflowSource, sourceFiles: clone(draft.sourceFiles), diagnostics: clone(draft.diagnostics) };
  const rejected = apply(draft);
  if (rejected instanceof Response) {
    Object.assign(draft, before);
    return rejected;
  }
  Object.assign(draft, { revision: draft.revision + 1, status: "DRAFT", compiledPlan: null, evaluationReport: null, approvedBy: null, publishedPlanDigest: null, updatedAt: ctx.state.clock });
  author(ctx, draft);
  event(ctx, draft, "draft.updated");
  return draft;
}

function lifecycle(ctx: Ctx, required: string[], apply: (draft: Rec) => Response | void, separation: boolean): Response {
  const draft = draftOf(ctx);
  if (!draft) return notFound(ctx, "Draft");
  if (separation && ctx.state.draftActors.get(draft.draftId)?.has(ctx.subject)) {
    return fail(ctx, 403, "authorization.separation_of_duties", "You authored or compiled this, so someone else must approve it.", { actor: ctx.subject });
  }
  if (!required.includes(draft.status)) {
    return fail(ctx, 409, "authoring.action_failed", `The draft is ${draft.status}; this step needs ${required.join(" or ")}.`);
  }
  const rejected = apply(draft);
  if (rejected instanceof Response) return rejected;
  draft.updatedAt = ctx.state.clock;
  return ok(ctx, draft);
}

function newDraft(ctx: Ctx): Rec {
  const id = `draft_${crypto.randomUUID()}`;
  const fromTemplate = typeof ctx.body?.packageSource === "string" || typeof ctx.body?.workflowSource === "string";
  return hydrate(ctx, {
    approvedBy: null, compiledPlan: null, createdAt: ctx.state.clock, diagnostics: [], domain: "fincrime", draftId: id, evaluationReport: null,
    name: fromTemplate ? "FinCrime KYB draft" : "New process", packageSource: String(ctx.body?.packageSource ?? "{}\n"), parsedPackage: {}, parsedWorkflow: {},
    publishedPlanDigest: null, revision: 1, status: "DRAFT", updatedAt: ctx.state.clock, version: "0.1.0",
    // A template seeds the full FinCrime workflow; a blank draft seeds input → output only (§7.4).
    workflowSource: fromTemplate ? String(ctx.body?.workflowSource) : "{}\n", events: [],
    ...(ctx.body?.sourceFiles ? { sourceFiles: ctx.body.sourceFiles } : {}),
  });
}

// ---- Graph mutations (ui-specs §7.5, plus the batched `layout` move, GAP-040) --------------

const DEFAULT_CONFIG: Record<string, Rec> = {
  transform: { operation: "select" },
  condition: { expression: "true" },
  fanout: { itemsPath: "/items", bodyRef: "capability:replace-me", maxItems: 100, maxConcurrency: 5, joinMode: "all" },
};

function configureAgentReads(ctx: Ctx, draft: Rec, node: Rec, agent: Rec): Response | void {
  if (agent.caseReads === undefined) return;
  const reads = agent.caseReads as Rec[];
  if (new Set(reads.map(read => read.id)).size !== reads.length || new Set(reads.map(read => read.purpose)).size > 1) return fail(ctx, 400, "authoring.agent_case_reads_invalid", "Choose unique case reads with one purpose.");
  const selectors = draft.parsedPackage.contextSelectors ?? [];
  const canonical = (value: unknown) => JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
  for (const read of reads) {
    const existing = selectors.find((selector: Rec) => selector.id === read.id);
    if (existing && canonical(existing) !== canonical(read)) return fail(ctx, 400, `authoring.agent_case_read_conflict:${read.id}`, "The process has a different definition for this case read.");
    if (!existing) selectors.push(clone(read));
  }
  draft.parsedPackage.contextSelectors = selectors;
  node.contextSelectorIds = reads.map(read => read.id);
}

function configureAgent(ctx:Ctx,draft:Rec,node:Rec,agentId:string):Response|void {
  const agent=(ctx.state.platform.agentRegistry as Rec[]).find(item=>item.agent?.id===agentId)?.agent as Rec|undefined;
  if(!agent||agent.status!=="active")return fail(ctx,400,"authoring.agent_not_found","Choose an active registered agent.");
  const rejected = configureAgentReads(ctx, draft, node, agent);
  if (rejected) return rejected;
  Object.assign(node,{kind:"evaluate",prompt:agent.prompt,role:agent.role,inputSchema:clone(agent.inputSchema),outputSchema:clone(agent.outputSchema),config:{caseWrites:clone(agent.caseWrites??[]),...(node.config??{}),agentRef:agent.id,agentVersion:agent.version,modelProfileId:agent.modelProfileId,runtimeTarget:agent.runtimeTarget}});
  const profile={...clone(agent),instructions:(agent.skillIds??[]).map((id:string)=>{
    const instruction=(ctx.state.platform.skillRegistry as Rec[]).find(item=>item.skill?.id===id)?.skill;
    return {...clone(instruction??{}),text:instruction?.instructions??""};
  })};
  draft.parsedPackage.agentProfiles=[...(draft.parsedPackage.agentProfiles??[]).filter((item:Rec)=>item.id!==agentId),profile];
  draft.parsedPackage.modelProfiles=[...new Set([...(draft.parsedPackage.modelProfiles??[]),agent.modelProfileId])];
  if(agent.primaryCapabilityId)draft.parsedPackage.bindings={...(draft.parsedPackage.bindings??{}),[node.id]:agent.primaryCapabilityId};
}

function validGate(draft:Rec,gate:Rec):boolean {
  return Boolean(gate.policyRef&&gate.gateId&&Array.isArray(draft.parsedPackage.policies)&&draft.parsedPackage.policies.some((policy:Rec)=>policy.policyId===gate.policyRef));
}

function setPosition(node: Rec, position: Rec): void {
  node.config ??= {};
  node.config.ui = { ...(node.config.ui ?? {}), position: { x: Number(position.x), y: Number(position.y) } };
}

function applyGraph(ctx: Ctx, draft: Rec, mutation: Rec): Response | void {
  const nodes = nodesOf(draft);
  const edges = edgesOf(draft);
  const find = (id: unknown) => nodes.find((node) => node.id === id);
  const bad = (error: string, message: string) => fail(ctx, 400, error, message);
  if (!validatorFor("AuthoringGraphMutation")(mutation)) return bad("authoring.graph_mutation_invalid", "Choose a valid graph operation and its required fields.");
  switch (mutation.type) {
    case "rename-process": {
      if(!String(mutation.name).trim())return bad("authoring.graph_mutation_invalid","Give the process a name.");
      draft.parsedWorkflow.metadata={...(draft.parsedWorkflow.metadata??{}),title:String(mutation.name).trim()};
      draft.name=String(mutation.name).trim();
      break;
    }
    case "move": {
      const node = find(mutation.nodeId);
      if (!node) return bad("authoring.node_not_found", `No node ${String(mutation.nodeId)}.`);
      setPosition(node, mutation.position ?? {});
      break;
    }
    case "layout": {
      const positions = (mutation.positions ?? []) as Rec[];
      if (!positions.length) return bad("authoring.graph_mutation_invalid", "A layout needs at least one position.");
      for (const entry of positions) {
        const node = find(entry.nodeId);
        if (!node) return bad("authoring.node_not_found", `No node ${String(entry.nodeId)}.`);
        setPosition(node, entry.position ?? {});
      }
      break;
    }
    case "connect": {
      if (mutation.from === mutation.to || !find(mutation.from) || !find(mutation.to)) return bad("authoring.edge_endpoint_invalid", "Connect two different existing nodes.");
      if (!edges.some((edge) => edge.from === mutation.from && edge.to === mutation.to)) edges.push({ id: `edge-${mutation.from}-${mutation.to}`, from: mutation.from, to: mutation.to, kind: "data" });
      break;
    }
    case "delete": {
      const nodeIds = new Set((mutation.nodeIds ?? []) as string[]);
      const edgeIds = new Set((mutation.edgeIds ?? []) as string[]);
      if (nodes.some((node) => nodeIds.has(node.id) && (node.kind === "input" || node.kind === "output"))) return bad("authoring.delete_boundary_node_forbidden", "Input and output nodes cannot be deleted.");
      draft.parsedWorkflow.spec.nodes = nodes.filter((node) => !nodeIds.has(node.id));
      draft.parsedWorkflow.spec.edges = edges.filter((edge) => !edgeIds.has(edge.id) && !nodeIds.has(edge.from) && !nodeIds.has(edge.to));
      break;
    }
    case "update-node": {
      const node = find(mutation.nodeId);
      if (!node) return bad("authoring.node_not_found", `No node ${String(mutation.nodeId)}.`);
      if (!String(mutation.name).trim()) return bad("authoring.node_name_required", "A node needs a display name.");
      if(mutation.agentId){
        if(!(node.kind==="agent"||node.config?.agentRef))return bad("authoring.agent_node_required","Select an agent step.");
        const rejected=configureAgent(ctx,draft,node,String(mutation.agentId));if(rejected)return rejected;
      }
      if(mutation.gate){
        if(node.kind!=="gate")return bad("authoring.gate_node_required","Select a policy gate.");
        if(!validGate(draft,mutation.gate as Rec))return bad("authoring.gate_policy_unresolved","Bind the policy before using its gate.");
        node.config={...(node.config??{}),...(mutation.gate as Rec)};
      }
      node.name = String(mutation.name).trim();
      node.config ??= {};
      node.config.ui = { ...(node.config.ui ?? {}), description: String(mutation.description).trim() };
      break;
    }
    case "insert-on-edge":
    case "add": {
      const spec = (mutation.node ?? {}) as Rec;
      const id = String(spec.id ?? "");
      if (!NODE_ID.test(id)) return bad("authoring.node_id_invalid", `Node id "${id}" must match ^[a-z][a-z0-9-]*$.`);
      if (find(id)) return bad("authoring.node_duplicate", `Node ${id} already exists.`);
      if (!String(spec.name ?? "").trim()) return bad("authoring.node_name_required", "A node needs a display name.");
      const kind = String(spec.kind ?? "transform");
      if(kind==="agent"&&!spec.agentId||kind!=="agent"&&spec.agentId||kind==="gate"&&!spec.gate||kind!=="gate"&&spec.gate)return bad("authoring.graph_mutation_invalid","Complete the step settings.");
      if(kind==="gate"&&!validGate(draft,spec.gate as Rec))return bad("authoring.gate_policy_unresolved","Bind the policy before using its gate.");
      const ui = { ...(spec.position ? { position: clone(spec.position) } : {}), ...(spec.description !== undefined ? { description: String(spec.description).trim() } : {}) };
      const node={ id, name: String(spec.name).trim(), kind, inputSchema: { type: "object" }, outputSchema: { type: "object" }, contextSelectorIds: [], config: { ...clone(DEFAULT_CONFIG[kind] ?? {}), ...(spec.gate as Rec ?? {}), ...(kind!=="agent"?{caseWrites:[]}:{}), ...(Object.keys(ui).length ? { ui } : {}) } };
      nodes.push(node);
      if(kind==="agent"){const rejected=configureAgent(ctx,draft,node,String(spec.agentId));if(rejected)return rejected;}
      const uniqueEdgeId = (base: string) => {
        let candidate = base;
        let suffix = 2;
        while (edges.some(edge => edge.id === candidate)) candidate = `${base}-${suffix++}`;
        return candidate;
      };
      if (mutation.type === "insert-on-edge") {
        const edge = edges.find(edge => edge.id === mutation.edgeId);
        if (!edge) return bad("authoring.edge_not_found", "That connection no longer exists in the draft.");
        if (!find(edge.from) || !find(edge.to)) return bad("authoring.edge_endpoint_invalid", "The connection must join existing nodes.");
        const target = edge.to;
        edge.to = id;
        edges.push({ id: uniqueEdgeId(`edge-${id}-${target}`), from: id, to: target, kind: edge.kind ?? "data" });
      } else if (mutation.insertAfter) {
        if (!find(mutation.insertAfter)) return bad("authoring.insert_after_invalid", "Choose an existing node.");
        for (const edge of edges) if (edge.from === mutation.insertAfter) edge.from = id;
        edges.push({ id: uniqueEdgeId(`edge-${mutation.insertAfter}-${id}`), from: mutation.insertAfter, to: id, kind: "data" });
      }
      break;
    }
    case "update-contract": {
      const node = find(mutation.nodeId);
      if (!node) return bad("authoring.node_not_found", `No node ${String(mutation.nodeId)}.`);
      if (mutation.inputSchema) node.inputSchema = mutation.inputSchema;
      if (mutation.outputSchema) node.outputSchema = mutation.outputSchema;
      if (mutation.contextSelectorIds) node.contextSelectorIds = [...new Set(mutation.contextSelectorIds as string[])];
      if (mutation.caseWrites) {
        node.config ??= {};
        node.config.caseWrites = mutation.caseWrites;
      }
      break;
    }
    default:
      return bad("authoring.graph_mutation_invalid", `Unknown graph mutation ${String(mutation.type)}.`);
  }
  syncSources(draft);
}

function applySources(draft: Rec, body: Rec): void {
  draft.packageSource = String(body.packageSource ?? draft.packageSource);
  draft.workflowSource = String(body.workflowSource ?? draft.workflowSource);
  if (body.sourceFiles) draft.sourceFiles = body.sourceFiles;
  const pkg = parse(draft.packageSource);
  const workflow = parse(draft.workflowSource);
  if (pkg) {
    draft.parsedPackage = pkg;
    for (const key of ["domain", "version"]) if (typeof pkg[key] === "string") draft[key] = pkg[key];
  }
  if (workflow) {draft.parsedWorkflow = workflow;if(typeof workflow.metadata?.title==="string"&&workflow.metadata.title.trim())draft.name=workflow.metadata.title.trim();}
  draft.diagnostics = diagnose(draft);
}

const registered = (ctx: Ctx, key: string, value: Rec): Rec => ({ [key]: value, createdAt: ctx.state.clock, digest: DIGEST("a"), updatedAt: ctx.state.clock });
const reply = (ctx: Ctx, result: Rec | Response, body: (draft: Rec) => unknown = (draft) => draft, status = 200) => (result instanceof Response ? result : ok(ctx, body(result), status));

/** Scope reads and previews need a composed KYC/KYB draft and a supported scope (control-api authoring-scope.ts). */
function scopeRequest(ctx: Ctx): { draft: Rec; scope: ProcessScope } | Response {
  const draft = draftOf(ctx);
  if (!draft) return notFound(ctx, "Draft");
  if (!inferScope(draft.parsedWorkflow, draft.sourceFiles)) return fail(ctx, 422, "authoring.scope_unsupported_draft", "This draft is not a composed KYC/KYB process.");
  const scope = ctx.body?.scope;
  if (!isScope(scope)) return fail(ctx, 400, "authoring.scope_invalid", "Choose a customer type, trigger, at least one jurisdiction and at least one product.");
  const refusal = refuse(scope);
  if (refusal) return refuseWith(ctx, refusal.status, refusal.error, refusal.message, refusal.remedy);
  return { draft, scope };
}

const sandboxRunNotFound: Impl = ctx => fail(ctx, 404, "sandbox.run_not_found", "No sandbox runs have executed in mock mode.");

export const authoring: Record<string, Impl> = {
  getAuthoringScopeOptions: (ctx) => ok(ctx, scopeOptions()),
  getAuthoringDraftsDraftIdScope: (ctx) => {
    const draft = draftOf(ctx);
    if (!draft) return notFound(ctx, "Draft");
    const scope = inferScope(draft.parsedWorkflow, draft.sourceFiles);
    return scope ? ok(ctx, { scope }) : fail(ctx, 422, "authoring.scope_unsupported_draft", "This draft is not a composed KYC/KYB process.");
  },
  postAuthoringDraftsDraftIdScopePreview: (ctx) => {
    const request = scopeRequest(ctx);
    if (request instanceof Response) return request;
    return ok(ctx, { preview: previewScope(request.draft.parsedWorkflow, request.draft.sourceFiles, request.scope).preview });
  },
  postAuthoringDraftsDraftIdScopeApply: (ctx) => {
    const request = scopeRequest(ctx);
    if (request instanceof Response) return request;
    const { preview, composed } = previewScope(request.draft.parsedWorkflow, request.draft.sourceFiles, request.scope);
    // One revision recomposes the workflow and keeps the scope with the draft.
    return reply(ctx, mutate(ctx, (draft) => {
      draft.parsedWorkflow = composed;
      draft.parsedPackage = { ...draft.parsedPackage, name: composed.metadata.name };
      draft.sourceFiles = { ...(draft.sourceFiles ?? {}), [SCOPE_FILE]: toSource(request.scope) };
      draft.name = composed.metadata.title;
      syncSources(draft);
    }), (draft) => ({ draft, preview }));
  },
  getAuthoringDraftsDraftIdTestSamples: ctx => {
    const draft = draftOf(ctx);
    return draft ? ok(ctx, { revision: draft.revision, items: [{ id: "schema-template", name: "Sample input template", description: "Open HTTP mode to run the actual workflow engine with sample data.", input: {}, context: {}, capabilityOutputs: {} }] }) : notFound(ctx,"Draft");
  },
  getAuthoringDraftsDraftIdSandbox: ctx => {
    const draft = draftOf(ctx);
    return draft ? ok(ctx, { available: false, reason: "Open HTTP mode with the live services to run a draft in the sandbox. Mock mode does not execute flows.", revision: draft.revision, parties: [] }) : fail(ctx, 404, "authoring.draft_not_found", "Draft not found.");
  },
  getAuthoringSandboxRuns: ctx => ok(ctx, { items: [] }),
  getAuthoringSandboxRunsRunIdContextResults: sandboxRunNotFound,
  getAuthoringSandboxRunsRunIdObservations: sandboxRunNotFound,
  getAuthoringSandboxRunsRunIdPolicy: sandboxRunNotFound,
  getAuthoringSandboxRunsRunId: sandboxRunNotFound,
  postAuthoringDraftsDraftIdTestRunsTestRunIdControl: ctx => fail(ctx,503,"draft_test.http_services_required","Fixture execution controls require the live control API."),
  postAuthoringDraftsDraftIdTestRunsTestRunIdFork: ctx => fail(ctx,503,"draft_test.http_services_required","Fixture forks require the live control API."),
  postAuthoringDraftsDraftIdSandboxRuns: ctx => fail(ctx,503,"sandbox.live_backend_required","Sandbox runs require the live control API."),
  getAuthoringDraftsDraftIdTestRuns: ctx => ok(ctx, { items: [] }),
  getAuthoringDraftsDraftIdTestRunsTestRunId: ctx => fail(ctx,404,"draft_test.not_found","No workflow tests have executed in mock mode."),
  postAuthoringDraftsDraftIdTestRuns: ctx => fail(ctx,503,"draft_test.live_backend_required","Open HTTP mode with the control API to execute a draft test. Mock mode does not execute agents."),
  postAuthoringDraftsDraftIdTestRunsTestRunIdCancel: ctx => fail(ctx,503,"draft_test.live_backend_required","Draft execution requires the live control API."),
  getAuthoringDrafts: (ctx) => ok(ctx, page(ctx, (ctx.state.platform.drafts as Rec[]).map((draft) => hydrate(ctx, draft)))),
  postAuthoringDrafts: (ctx) => {
    const draft = newDraft(ctx);
    ctx.state.platform.drafts.unshift(draft);
    author(ctx, draft);
    event(ctx, draft, "draft.created");
    return ok(ctx, draft, 201);
  },
  getAuthoringDraftsDraftId: (ctx) => {
    const draft = draftOf(ctx);
    return draft ? ok(ctx, draft) : notFound(ctx, "Draft");
  },
  putAuthoringDraftsDraftId: (ctx) => reply(ctx, mutate(ctx, (draft) => applySources(draft, (ctx.body ?? {}) as Rec))),
  postAuthoringDraftsDraftIdValidate: (ctx) => {
    const draft = draftOf(ctx);
    if (!draft) return notFound(ctx, "Draft");
    const diagnostics = diagnose(draft);
    return ok(ctx, { valid: !diagnostics.some((entry) => entry.severity === "error"), diagnostics });
  },
  postAuthoringDraftsDraftIdCompile: (ctx) => lifecycle(ctx, ["DRAFT", "COMPILED", "EVALUATED"], (draft) => {
    const diagnostics = diagnose(draft);
    draft.diagnostics = diagnostics;
    if (diagnostics.some((entry) => entry.severity === "error")) {
      return fail(ctx, 422, "authoring.compile_failed", `Compilation failed with ${diagnostics.length} diagnostic${diagnostics.length === 1 ? "" : "s"}.`, { diagnostics });
    }
    Object.assign(draft, { status: "COMPILED", compiledPlan: clone(ctx.state.platform.plan), evaluationReport: null, diagnostics: [] });
    author(ctx, draft);
    event(ctx, draft, "draft.compiled", { from: "DRAFT", to: "COMPILED" });
  }, false),
  postAuthoringDraftsDraftIdEvaluate: (ctx) => lifecycle(ctx, ["COMPILED"], (draft) => {
    draft.status = "EVALUATED";
    draft.evaluationReport = {
      passed: true,
      evaluatedAt: ctx.state.clock,
      planDigest: draft.compiledPlan?.planDigest ?? ctx.state.platform.plan.planDigest,
      checks: [
        { id: "graph.connected", label: "Executable topology", passed: true, detail: "All nodes reachable from input" },
        { id: "case-writes.authority", label: "Case-write authority", passed: true, detail: "No agent writes FinalizeDisposition" },
      ],
    };
    event(ctx, draft, "draft.evaluated", { from: "COMPILED", to: "EVALUATED" });
  }, false),
  postAuthoringDraftsDraftIdApprove: (ctx) => lifecycle(ctx, ["EVALUATED"], (draft) => {
    Object.assign(draft, { status: "APPROVED", approvedBy: ctx.subject });
    event(ctx, draft, "draft.approved", { from: "EVALUATED", to: "APPROVED" });
  }, true),
  postAuthoringDraftsDraftIdPublish: (ctx) => lifecycle(ctx, ["APPROVED"], (draft) => {
    Object.assign(draft, { status: "PUBLISHED", publishedPlanDigest: draft.compiledPlan?.planDigest ?? ctx.state.platform.plan.planDigest });
    event(ctx, draft, "draft.published", { from: "APPROVED", to: "PUBLISHED", planDigest: draft.publishedPlanDigest });
  }, true),
  postAuthoringDraftsDraftIdGraph: (ctx) => {
    const mutation = (ctx.body?.mutation ?? {}) as Rec;
    const result = mutate(ctx, (draft) => applyGraph(ctx, draft, mutation));
    return reply(ctx, result, (draft) => ({ draft, nodeId: (mutation.node as Rec | undefined)?.id ?? mutation.nodeId ?? null }));
  },
  postAuthoringDraftsDraftIdOrchestrationNodes: (ctx) => {
    const node = (ctx.body?.node ?? {}) as Rec;
    const nodeId = String(node.id ?? nextId(ctx.state, "node"));
    const result = mutate(ctx, (draft) => {
      if (!NODE_ID.test(nodeId)) {
        return fail(ctx, 422, "authoring.orchestration_node_invalid", "The orchestration node is invalid.", {
          diagnostics: [{ code: "authoring.node_id_invalid", severity: "error", path: "workflow.spec.nodes.id", message: `Node id "${nodeId}" must match ^[a-z][a-z0-9-]*$.` }],
        });
      }
      if (nodesOf(draft).some((entry) => entry.id === nodeId)) return fail(ctx, 400, "authoring.node_duplicate", `Node ${nodeId} already exists.`);
      const kind = node.kind === "subgraph" ? "subgraph" : "group";
      const { kind: _kind, id: _id, name, ...config } = node;
      nodesOf(draft).push({ id: nodeId, name: name ?? nodeId, kind, inputSchema: { type: "object" }, outputSchema: { type: "object" }, contextSelectorIds: [], config: { ...config, members: node.memberIds ?? [], caseWrites: [] } });
      if (kind === "subgraph" && node.insertAfter) {
        for (const edge of edgesOf(draft)) if (edge.from === node.insertAfter) edge.from = nodeId;
        edgesOf(draft).push({ id: `edge-${node.insertAfter}-${nodeId}`, from: node.insertAfter, to: nodeId, kind: "data" });
      }
      syncSources(draft);
    });
    return reply(ctx, result, (draft) => ({ draft, nodeId }), 201);
  },
  putAuthoringDraftsDraftIdNodesNodeIdCaseWrites: (ctx) => reply(ctx, mutate(ctx, (draft) => {
    const node = nodesOf(draft).find((entry) => entry.id === ctx.params.nodeId);
    if (!node) return notFound(ctx, "Node");
    node.config ??= {};
    node.config.caseWrites = clone(ctx.body?.caseWrites ?? []);
    syncSources(draft);
  })),
  postAuthoringDraftsDraftIdAgentsAgentIdAttach: (ctx) => {
    const agent = (ctx.state.platform.agentRegistry as Rec[]).find((entry) => entry.agent?.id === ctx.params.agentId)?.agent as Rec | undefined;
    if (!agent) return fail(ctx, 404, "authoring.agent_not_found", `No registered agent ${ctx.params.agentId}.`);
    const target = String(ctx.body?.nodeId ?? "");
    const attachedNodeId = String(ctx.body?.newNodeId || (ctx.body?.mode === "replace" ? target : `${target}-agent`));
    const result = mutate(ctx, (draft) => {
      const nodes = nodesOf(draft);
      const node = nodes.find((entry) => entry.id === target);
      if (!node) return fail(ctx, 400, "authoring.node_not_found", `No node ${target}.`);
      const fields = { kind: "agent", agentRef: agent.id, modelTier: agent.modelProfileId, inputSchema: agent.inputSchema ?? { type: "object" }, outputSchema: agent.outputSchema ?? { type: "object" } };
      if (ctx.body?.mode === "replace") {
        Object.assign(node, fields, { id: attachedNodeId, name: agent.name ?? node.name });
        for (const edge of edgesOf(draft)) {
          if (edge.from === target) edge.from = attachedNodeId;
          if (edge.to === target) edge.to = attachedNodeId;
        }
      } else {
        if (nodes.some((entry) => entry.id === attachedNodeId)) return fail(ctx, 400, "authoring.node_duplicate", `Node ${attachedNodeId} already exists.`);
        nodes.push({ id: attachedNodeId, name: agent.name ?? attachedNodeId, ...fields, contextSelectorIds: [], config: { caseWrites: clone(agent.caseWrites ?? []) } });
        for (const edge of edgesOf(draft)) if (edge.from === target) edge.from = attachedNodeId;
        edgesOf(draft).push({ id: `edge-${target}-${attachedNodeId}`, from: target, to: attachedNodeId, kind: "data" });
      }
      const rejected = configureAgentReads(ctx, draft, nodes.find(entry => entry.id === attachedNodeId)!, agent);
      if (rejected) return rejected;
      syncSources(draft);
    });
    return reply(ctx, result, (draft) => ({ draft, attachedNodeId }));
  },
  putAuthoringDraftsDraftIdContextSelectors: (ctx) => reply(ctx, mutate(ctx, (draft) => {
    draft.parsedPackage.contextSelectors = clone(ctx.body?.contextSelectors ?? []);
    syncSources(draft);
  })),
  putAuthoringDraftsDraftIdContextClassificationPolicies: (ctx) => reply(ctx, mutate(ctx, (draft) => {
    draft.parsedPackage.contextClassificationPolicies = clone(ctx.body?.contextClassificationPolicies ?? []);
    syncSources(draft);
  })),

  // ---- Registries ----
  getAuthoringTemplates: (ctx) => ok(ctx, page(ctx, ctx.state.platform.templates as Rec[])),
  getAuthoringAgents: (ctx) => ok(ctx, page(ctx, ctx.state.platform.agentRegistry as Rec[])),
  postAuthoringAgents: (ctx) => {
    const { canonicalProfile: _canonical, ...agent } = (ctx.body ?? {}) as Rec;
    const item = registered(ctx, "agent", { source: { type: "manual" }, status: "draft", version: "0.1.0", ...agent });
    ctx.state.platform.agentRegistry.unshift(item);
    return ok(ctx, item, 201);
  },
  getAuthoringSkills: (ctx) => ok(ctx, page(ctx, ctx.state.platform.skillRegistry as Rec[])),
  postAuthoringSkills: (ctx) => {
    const item = registered(ctx, "skill", { source: { type: "manual" }, status: "draft", version: "0.1.0", ...(ctx.body ?? {}) });
    ctx.state.platform.skillRegistry.unshift(item);
    return ok(ctx, item, 201);
  },
  postAuthoringImportGithub: (ctx) => {
    const agent = clone((ctx.state.platform.agentRegistry as Rec[])[0]!);
    agent.agent.source = { type: "github", url: String(ctx.body?.url ?? "https://github.com/example/agent") };
    return ok(ctx, { agent, skills: clone(ctx.state.platform.skillRegistry) }, 201);
  },
  postAuthoringImportFincrime: (ctx) => ok(ctx, {
    digest: (FINCRIME.catalog as Rec).catalogDigest,
    created: false,
    sourceRelease: (FINCRIME.catalog as Rec).sourceRelease,
  }, 201),
  getAuthoringCatalogsFincrimeDigest: (ctx) => {
    const catalog = FINCRIME.catalog as Rec;
    return ctx.params.digest.replace(/^sha256:/, "") === catalog.catalogDigest ? ok(ctx, clone(catalog)) : notFound(ctx, "Catalog");
  },
};
