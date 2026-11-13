import { parse } from "yaml";
import { createComposer } from "./compose.js";
import { toYaml } from "./library-package.js";
import type { ComposerRepository } from "./load.js";
import { resolveFlow, type CompositionDecision, type ProcessScope } from "./scope.js";

/** The scope source file a draft keeps beside its package and workflow. */
export const SCOPE_FILE = "scope.yaml";

type Node = { id: string; kind: string; name?: string; config?: Record<string, unknown> };
type Workflow = { spec?: { nodes?: Node[] } };

/** What a process runs: its agents, skills, acquisition connectors and pinned packs. */
export type ProcessShape = { agents: string[]; skills: string[]; connectors: string[]; packs: string[]; nodes: Array<{ id: string; kind: string; name: string }> };
const setDiff = (before: string[], after: string[]) => ({ added: after.filter((x) => !before.includes(x)), removed: before.filter((x) => !after.includes(x)) });

/** The shape of a workflow document (a draft's, or a composed one). */
export function processShape(workflow: unknown): ProcessShape {
  const nodes = ((workflow as Workflow)?.spec?.nodes ?? []).filter((node) => node && typeof node.id === "string");
  const gate = nodes.find((node) => node.kind === "gate" && Array.isArray(node.config?.policyPacks));
  return {
    agents: [...new Set(nodes.filter((node) => node.kind === "agent" && typeof node.config?.agentRef === "string").map((node) => String(node.config!.agentRef)))],
    skills: [...new Set(nodes.filter((node) => typeof node.config?.skillId === "string").map((node) => String(node.config!.skillId)))].sort(),
    connectors: nodes.filter((node) => node.id.startsWith("acquire-")).map((node) => node.id),
    packs: ((gate?.config?.policyPacks as Array<{ id: string }> | undefined) ?? []).map((pack) => pack.id),
    nodes: nodes.map((node) => ({ id: node.id, kind: node.kind, name: node.name ?? node.id })),
  };
}

/** A draft's scope: its scope file, else what its pinned packs say (customer type, jurisdictions, products). */
export function inferScope(workflow: unknown, sourceFiles: Record<string, string> = {}): ProcessScope | null {
  if (sourceFiles[SCOPE_FILE]) return parse(sourceFiles[SCOPE_FILE]) as ProcessScope;
  const gate = ((workflow as Workflow)?.spec?.nodes ?? []).find((node) => node.kind === "gate" && Array.isArray(node.config?.policyPacks));
  const packs = (gate?.config?.policyPacks as Array<{ scope: { jurisdiction: string; institution: string; products: string[]; customerTypes: string[] } }> | undefined) ?? [];
  if (!packs.length) return null;
  const customerTypes = [...new Set(packs.flatMap((pack) => pack.scope.customerTypes))];
  if (customerTypes.length !== 1) return null;
  return {
    customerType: customerTypes[0] as ProcessScope["customerType"], trigger: "onboarding",
    jurisdictions: packs.map((pack) => pack.scope.jurisdiction), products: [...packs[0]!.scope.products], institution: packs[0]!.scope.institution,
  };
}

/** Compose the process for a scope: its sources (package, workflow, business policy, scope file) and decisions. */
export function composeForScope(scope: ProcessScope, repository: ComposerRepository) {
  const resolved = resolveFlow(scope, { roster: repository.roster, packs: repository.packs, layers: repository.layers,
    ...(repository.diligence ? { legacy: repository.diligence.legacy } : {}) });
  const packs = new Map(repository.packs);
  for (const pack of resolved.packs) packs.set(pack.id, pack);
  const composed = createComposer({ ...repository, packs }).compose(resolved.flow);
  const header = (what: string) => `# Composed by @ehf/flow-composer for scope ${scope.customerType}/${scope.trigger}/${scope.jurisdictions.join("+")}/${[...scope.products].sort().join("+")}: ${what}.\n`;
  return {
    flow: resolved.flow, packs: resolved.packs, decisions: resolved.decisions,
    packageDocument: composed.packageDocument, workflowDocument: composed.workflowDocument,
    sources: {
      packageSource: header(`${resolved.flow.title} package`) + toYaml(composed.packageDocument),
      workflowSource: header(`${resolved.flow.title} workflow`) + toYaml(composed.workflowDocument),
      sourceFiles: { "policy.yaml": toYaml(composed.businessPolicy.source), [SCOPE_FILE]: toYaml(scope) },
    },
  };
}

export type ScopePreview = {
  scope: ProcessScope;
  previous: ProcessScope | null;
  decisions: CompositionDecision[];
  changes: {
    agents: { added: string[]; removed: string[] };
    skills: { added: string[]; removed: string[] };
    connectors: { added: string[]; removed: string[] };
    packs: { added: string[]; removed: string[] };
    nodes: { added: ProcessShape["nodes"]; removed: ProcessShape["nodes"] };
  };
  /** True when nothing would change. */
  unchanged: boolean;
};

/** What changing a process to `scope` would add and remove, and why, without changing anything. */
export function previewScopeChange(input: { workflow: unknown; sourceFiles?: Record<string, string>; scope: ProcessScope; repository: ComposerRepository }) {
  const composed = composeForScope(input.scope, input.repository);
  const before = processShape(input.workflow);
  const after = processShape(composed.workflowDocument);
  const ids = (nodes: ProcessShape["nodes"]) => nodes.map((node) => node.id);
  const changes: ScopePreview["changes"] = {
    agents: setDiff(before.agents, after.agents),
    skills: setDiff(before.skills, after.skills),
    connectors: setDiff(before.connectors, after.connectors),
    packs: setDiff(before.packs, after.packs),
    nodes: {
      added: after.nodes.filter((node) => !ids(before.nodes).includes(node.id)),
      removed: before.nodes.filter((node) => !ids(after.nodes).includes(node.id)),
    },
  };
  const unchanged = Object.values(changes).every((change) => !change.added.length && !change.removed.length);
  const preview: ScopePreview = { scope: input.scope, previous: inferScope(input.workflow, input.sourceFiles), decisions: composed.decisions, changes, unchanged };
  return { preview, composed };
}
