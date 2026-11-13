// The agentic KYC and KYB flows (agentic plan phase 4): the roster's agents, the per-case policy
// packs and released OPA decisions, composed into two domain packages.
//
//   node --import tsx scripts/sync-agentic-flows.ts [--check]
//
// Reads domains/agents/roster.json (scripts/sync-agent-roster.mjs) and artifacts/policy/packs
// (scripts/sync-policy-packs.mjs) and writes domains/{kyc,kyb}[-edd,-sdd]-agentic/{package,workflow,policy}.yaml
// and domains/securities-agentic (the synthetic securities firm),
// which `make compile` compiles to artifacts/<flow>.plan.json.
//
// Each flow runs, in roster order, the agents its customer type needs. An agent's required skills run
// as skill nodes with their parameters bound from earlier skills' payloads and from the case (nothing
// runs on a placeholder: an unresolved binding fails the node closed); then its bounded review loop runs
// over those results, its read-only loop skills and the records it reads, and the runtime judges its
// task from its own skills. Three OPA gates decide readiness and disposition under the released
// installation policy. Human work, when required by a gate, resumes that same gate for fresh
// evaluation. Hydration and agent outputs remain observations. Every policy-reading skill carries
// the selected installation projection, with unresolved content explicit.
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { readdirSync, readFileSync } from "node:fs";
import { createComposer, loadDiligenceInputs, resolveFlow, toYaml, type Agent, type Flow, type ProcessScope, type SyntheticContent } from "../packages/flow-composer/src/index.js";
import type { EffectivePolicyPack } from "../packages/policy-engine/src/index.js";
// @ts-expect-error -- plain ESM helpers shared by the package generators
import { assertRegistrySnapshot, createEmitter, readJson, registryEntries, repoRoot, vendoredSkills } from "./lib/library-package.mjs";

// The composition itself lives in @ehf/flow-composer (packages/flow-composer), shared with the
// authoring service; this script loads its inputs from the repository and writes the packages.
const check = process.argv.includes("--check");
const { emit, state } = createEmitter(check);
const libraryRoot = resolve(repoRoot, "apps/fincrime-host");
const roster = (readJson(resolve(repoRoot, "domains/agents/roster.json")) as { agents: Agent[] }).agents;
const packsDir = resolve(repoRoot, "artifacts/policy/packs");
const packs = new Map(readdirSync(packsDir).filter((file) => file.startsWith("policy.pack.") && file.endsWith(".json"))
  .map((file) => readJson(resolve(packsDir, file)) as EffectivePolicyPack).map((item) => [item.id, item] as const));
const composer = createComposer({
  roster,
  packs,
  catalogSkills: (readJson(resolve(repoRoot, "config/skill-library/catalog.json")) as { skills: Array<{ id: string; semver: string }> }).skills,
  registry: registryEntries(),
  vendor: (workflow, extraSkillIds) => {
    const library = vendoredSkills({ libraryRoot, workflow, files: ["catalog/catalog.json"], extraSkillIds });
    assertRegistrySnapshot(library);
    return library;
  },
  synthetic: parse(readFileSync(resolve(repoRoot, "domains/policy/synthetic-installation-content.yaml"), "utf8")) as SyntheticContent,
  // The institutions' diligence designs: each flow gets the diligence gate and derived requirements.
  diligence: loadDiligenceInputs(resolve(repoRoot, "domains")),
});

// The two released processes, by scope: everything else (agents, excluded skills, packs, acquisition
// connectors, document requirements) is derived by resolveFlow from the roster and the packs.
const SCOPES: ProcessScope[] = [
  { customerType: "individual", trigger: "onboarding", jurisdictions: ["US", "GB"], products: ["card", "deposit", "payments"] },
  { customerType: "corporate", trigger: "onboarding", jurisdictions: ["US", "GB"], products: ["deposit", "lending", "merchant_acquiring", "payments"] },
  // The escalation targets: enhanced due diligence for both customer types, and simplified due
  // diligence for an eligible legal entity, across the jurisdictions with pack layers.
  { customerType: "individual", trigger: "onboarding", dueDiligence: "enhanced", jurisdictions: ["US", "GB", "AU"], products: ["card", "deposit", "payments"] },
  { customerType: "corporate", trigger: "onboarding", dueDiligence: "enhanced", jurisdictions: ["US", "GB", "AU"], products: ["deposit", "lending", "merchant_acquiring", "payments"] },
  { customerType: "corporate", trigger: "onboarding", dueDiligence: "simplified", jurisdictions: ["US", "GB", "AU"], products: ["deposit", "lending", "merchant_acquiring", "payments"] },
  // The synthetic securities firm's institutional clients (Product Policy Studio phase G): its own
  // pack and diligence design, on taxonomy nodes. Securities products are policy-only until the skill
  // library's Product record carries them (docs/implementation/product-policy-library-change-request.md).
  { customerType: "corporate", trigger: "onboarding", jurisdictions: ["US"], products: ["BRK", "CUS", "WLT"], institution: "securities.synthetic" },
];
const FLOWS: Flow[] = SCOPES.map((scope) => resolveFlow(scope, { roster, packs }).flow);

for (const flow of FLOWS) {
  const { packageDocument, workflowDocument, businessPolicy } = composer.compose(flow);
  emit(resolve(repoRoot, `domains/${flow.id}/policy.yaml`), toYaml(businessPolicy.source));
  emit(resolve(repoRoot, `artifacts/policy/${flow.id}.business-v2.json`), JSON.stringify(businessPolicy.compiled, null, 2) + "\n");
  const header = (title: string) => `# GENERATED by scripts/sync-agentic-flows.ts from domains/agents and artifacts/policy/packs -- do not edit; regenerate.\n# ${title}\n`;
  const root = resolve(repoRoot, `domains/${flow.id}`);
  emit(join(root, "package.yaml"), header(`${flow.title}: package.`) + toYaml(packageDocument));
  emit(join(root, "workflow.yaml"), header(`${flow.title}: workflow.`) + toYaml(workflowDocument));
}
if (check && state.changed) process.exit(1);
process.stdout.write(check ? "agentic flows are up to date\n" : `agentic flows generated (${FLOWS.map((flow) => flow.id).join(", ")})\n`);
