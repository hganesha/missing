// Refresh the portable article from repository contracts; never contact a live service.
// --ref <git-ref> pins all embedded sources, useful when documenting main from an older branch.
// Without --ref, current agentic checkouts use working-tree files; older checkouts use the saved pin.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const path = resolve(root, "docs/visual-story.html");
const source = readFileSync(path, "utf8");
const pattern = /(<script[^>]*id="domain-data"[^>]*>)([\s\S]*?)(<\/script>)/;
const match = source.match(pattern);
if (!match) throw new Error("Visual story domain-data is missing");
const data = JSON.parse(match[2]);
const refIndex = process.argv.indexOf("--ref");
if (refIndex >= 0 && (!process.argv[refIndex + 1] || process.argv[refIndex + 1].startsWith("--"))) throw new Error("--ref requires a Git ref");
const requestedRef = refIndex >= 0 ? process.argv[refIndex + 1] : undefined;
const sourceRef = requestedRef ?? (existsSync(resolve(root, "domains/kyc-agentic/package.yaml")) ? null : data.sourceRevision);
if (!sourceRef && !existsSync(resolve(root, "domains/kyc-agentic/package.yaml"))) throw new Error("Agentic sources are missing. Use --ref <current-main-commit>");
// Source archives intentionally omit .git. They can publish the already generated,
// pinned article without attempting to regenerate its historical source snapshot.
// Explicit --ref requests and ordinary checkout checks remain strict.
if (sourceRef && !requestedRef && process.argv.includes("--if-available") && !existsSync(resolve(root, ".git"))) {
  if (!/^[a-f0-9]{40}$/.test(sourceRef) || !Array.isArray(data.sourceFiles) || !data.sourceFiles.length || data.sourceFiles.some(file => typeof file.path !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256))) throw new Error("Portable visual story requires a pinned snapshot with source digests");
  console.log(`visual-story: using supplied snapshot ${sourceRef} (Git history is outside the build context)`);
  process.exit(0);
}
data.sourceRevision = sourceRef ? execFileSync("git", ["rev-parse", "--verify", `${sourceRef}^{commit}`], { cwd: root, encoding: "utf8" }).trim() : null;
const sourceFiles = [];
const digest = value => createHash("sha256").update(value).digest("hex");
function read(relative) {
  const content = data.sourceRevision ? execFileSync("git", ["show", `${data.sourceRevision}:${relative}`], { cwd: root, encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }) : readFileSync(resolve(root, relative), "utf8");
  sourceFiles.push({ path: relative, sha256: digest(content) });
  return content;
}
const catalogPath = "apps/fincrime-host/docs/ui/contracts/fixtures/catalogs.json";
const catalog = JSON.parse(read(catalogPath));
// Omit full schema/source payloads from the embedded catalog summaries.
const entries = catalog.entries.map(({ kind, id, title, description, group, status, statusLabel, version, entryType, source, digest, facts, relationships, notice }) =>
  ({ kind, id, title, description, group, status, statusLabel, version, entryType, source, digest, facts, relationships, notice }));
for (const kind of ["agents", "skills", "context", "policies", "documents"]) {
  data.catalogEntries[kind] = entries.filter(entry => entry.kind === kind);
}
data.catalogEntries.capabilities = entries.filter(entry => entry.kind === "external-capabilities" && entry.entryType !== "binding");
data.catalogEntries.connectors = entries.filter(entry => entry.kind === "external-capabilities" && entry.entryType === "binding");
data.catalogSource = { release: catalog.sourceRelease, digest: catalog.digest, path: catalogPath };

const packages = {};
for (const [key, path] of [["kyc", "domains/kyc-agentic"], ["kyb", "domains/kyb-agentic"]]) {
  const pkg = YAML.parse(read(`${path}/package.yaml`));
  const workflow = YAML.parse(read(`${path}/workflow.yaml`));
  const { nodes, edges } = workflow.spec;
  if (!Array.isArray(nodes) || !Array.isArray(edges)) throw new Error(`Missing workflow graph: ${path}`);
  packages[key] = pkg;
  data[key] = { path, nodes, edges, budgets: pkg.budgets, agentProfiles: pkg.agentProfiles, policies: pkg.policies };
}
data.catalogEntries.workflows = ["kyb", "kyc"].map(key => {
  const pkg = packages[key], graph = data[key];
  const skills = [...new Set(graph.nodes.flatMap(node => node.config?.skillId ? [node.config.skillId] : []))];
  return {
    id: graph.path, title: pkg.metadata.name, description: pkg.metadata.objective,
    version: pkg.metadata.version, status: "candidate", statusLabel: "Agentic template · candidate policy",
    entryType: "authored-workflow", group: "Agentic onboarding", source: `${graph.path}/package.yaml`,
    facts: [
      { label: "Nodes", value: String(graph.nodes.length) },
      { label: "Agent reviews", value: String(graph.nodes.filter(node => node.config?.loop).length) },
      { label: "Skill steps", value: String(graph.nodes.filter(node => node.config?.skillId).length) },
      { label: "Model calls allowed", value: String(pkg.budgets.maxModelCalls) },
    ],
    relationships: skills.map(id => ({ kind: "skills", id, label: id, entryType: "definition" })),
  };
});
// Keep the transition slice and frozen parity baselines discoverable without mixing
// them into the two active-flow diagrams.
for (const [key, path, status, group] of [
  ["slice1", "domains/kyb-screening", "Transition assessment", "Transition workflows"],
  ["kycArchive", "domains/archive/kyc-v2-deterministic", "Archived", "Archived workflows"],
  ["kybArchive", "domains/archive/kyb-deterministic", "Archived", "Archived workflows"],
]) {
  const pkg = YAML.parse(read(`${path}/package.yaml`));
  const workflow = YAML.parse(read(`${path}/workflow.yaml`));
  const nodes = workflow.spec.nodes.map(node => ({
    id: node.id, kind: node.kind, name: node.name, summary: node.summary,
    contextSelectorIds: node.contextSelectorIds,
    config: Object.fromEntries(Object.entries(node.config ?? {}).filter(([key]) =>
      ["agentRef", "skillId", "gateId", "businessDecision", "policyRef", "inputProfile", "completion"].includes(key))),
  }));
  data[key] = { path, nodes, edges: workflow.spec.edges, budgets: pkg.budgets };
  data.catalogEntries.workflows.push({
    id: path, title: pkg.metadata.name, description: pkg.metadata.objective,
    version: pkg.metadata.version, status, statusLabel: status,
    entryType: status === "Archived" ? "archived-workflow" : "transition-workflow",
    group, source: `${path}/workflow.yaml`, relationships: [],
    facts: [
      { label: "Graph nodes", value: String(nodes.length) },
      { label: "Agent profiles", value: String(pkg.agentProfiles.length) },
      { label: "Model-call ceiling", value: String(pkg.budgets.maxModelCalls) },
    ],
  });
}
for (const [key, domain, nodeId] of [
  ["identity", "kyc", "entity-identity-verify"],
  ["sanctions", "kyc", "screening-sanctions-execute"],
  ["ownership", "kyb", "ownership-ubo-resolve"],
]) {
  const node = data[domain].nodes.find(node => node.id === nodeId);
  if (!node?.config?.skillId) throw new Error(`Missing context example: ${nodeId}`);
  data.contextExamples[key] = {
    domain, nodeId, skillId: node.config.skillId,
    selectors: node.contextSelectorIds.map(id => {
      const selector = packages[domain].contextSelectors.find(selector => selector.id === id);
      if (!selector) throw new Error(`Missing selector: ${id}`);
      return selector;
    }),
  };
}
data.libraryAgentCount = data.catalogEntries.agents.length;
const roster = JSON.parse(read("domains/agents/roster.json"));
data.roster = roster.agents;
data.catalogEntries.agents = roster.agents.map(agent => ({
  kind: "agents", id: agent.id, title: agent.name, description: agent.description,
  group: `${agent.modelTier} reasoning`, status: "roster", statusLabel: "Flow roster · qualification pending",
  version: agent.version, entryType: "roster", source: "domains/agents/roster.json", digest: digest(JSON.stringify(agent)),
  facts: [
    { label: "Model profile", value: agent.modelProfileId },
    { label: "Customers", value: agent.customerTypes.join(", ") },
    { label: "Required skills", value: String(agent.skills.required.length) },
    { label: "Loop skills", value: String(agent.skills.optional.length) },
    { label: "Tools", value: agent.tools.join(", ") || "None" },
  ],
  relationships: agent.allowedSkills.map(skill => ({ kind: "skills", id: skill.skillId, label: skill.skillId, entryType: "definition" })),
}));
for (const key of ["kyc", "kyb"]) {
  const path = `${data[key].path}/policy.yaml`;
  const policy = YAML.parse(read(path));
  data.catalogEntries.policies.unshift({
    kind: "policies", id: policy.metadata.id, title: `${key.toUpperCase()} installation business policy v2`,
    description: "Candidate installation template for actual OPA onboarding gates. Owner content, rules, independent approval and release remain required.",
    entryType: "installation-policy", group: "Current installation policies", status: "CANDIDATE", statusLabel: "Candidate · owner rules required",
    version: policy.metadata.version, source: path, digest: digest(JSON.stringify(policy)),
    facts: [{ label: "Effective sets", value: String(policy.policySets.length) }, { label: "Gates", value: Object.keys(policy.gates).join(", ") }, { label: "Jurisdictions", value: policy.policySets.map(set => set.scope.jurisdiction).join(", ") }],
    relationships: [{ kind: "workflows", id: data[key].path, label: `${key.toUpperCase()} agentic template`, entryType: "authored-workflow" }],
  });
}
const packIndexPath = "artifacts/policy/packs/index.json";
for (const pack of JSON.parse(read(packIndexPath)).packs) {
  data.catalogEntries.policies.push({
    kind: "policies", id: pack.id, title: `${pack.scope.jurisdiction} ${pack.scope.productSet} effective pack`,
    source: packIndexPath, description: "Baseline, jurisdiction, institution and product layers composed into an exact candidate pack. A pack definition does not supply released business decision rules.",
    status: pack.status, statusLabel: pack.status, digest: pack.digest,
    entryType: "effective-policy-pack", group: "Effective policy packs", relationships: [],
    facts: [
      { label: "Jurisdiction", value: pack.scope.jurisdiction },
      { label: "Institution", value: pack.scope.institution },
      { label: "Products", value: pack.scope.products.join(", ") },
    ],
  });
}
const relationships = JSON.parse(read("apps/fincrime-host/catalog/context-relationships.json"));
data.inventory = {
  documentTypes: entries.filter(entry => entry.kind === "documents" && entry.entryType === "definition").length,
  documentFields: entries.filter(entry => entry.kind === "documents" && entry.entryType === "field").length,
  documentFamilies: new Set(entries.filter(entry => entry.kind === "documents" && entry.entryType === "definition").map(entry => entry.group)).size,
  capabilityDomains: new Set(data.catalogEntries.capabilities.map(entry => entry.group)).size,
  semanticRelationships: relationships.relationships.length,
};
data.sourceFiles = sourceFiles;
// This fingerprints the working-tree sources, including changes not committed to Git.
data.snapshot = digest(JSON.stringify(sourceFiles)).slice(0, 12);
const updated = source.replace(pattern, (_match, start, _data, end) => start + JSON.stringify(data).replaceAll("<", "\\u003c") + end);
if (process.argv.includes("--check")) {
  if (updated !== source) throw new Error("Visual story snapshots are stale. Run node scripts/sync-visual-story.mjs");
} else writeFileSync(path, updated);
console.log(`visual-story: catalogs, domain graphs, context examples and source fingerprints match (${data.snapshot}).`);
