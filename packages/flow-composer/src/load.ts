import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  composeEffectivePack, diligenceDesignSchema, loadProductTaxonomy, policyPackLayerSchema, policyPackSelectionSchema, productLineageOf, withLayerRevisions,
  type DiligenceDesign, type EffectivePolicyPack, type PolicyPackLayer, type PolicyPackSelection,
} from "@ehf/policy-engine";
import type { DiligenceInputs, SyntheticContent } from "./business-policy.js";
import type { Agent, ComposerInputs } from "./compose.js";

/** Everything composition reads, from a repository checkout or a platform image (domains/ and config/). */
export type ComposerRepository = ComposerInputs & { layers: PolicyPackLayer[]; selection?: PolicyPackSelection };

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const yamlFiles = (dir: string): string[] => readdirSync(dir).sort().flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? yamlFiles(path) : name.endsWith(".yaml") ? [path] : [];
});

/**
 * Load the composer's inputs: the agent roster (domains/agents/roster.json), the policy pack layers
 * and the released selection composed into effective packs (domains/policy), the skill catalog and
 * business-skill registry (config/skill-library, config/business-skills.json) and the SYNTHETIC
 * placeholder content (domains/policy/synthetic-installation-content.yaml). Effective packs are
 * composed from the layers exactly as scripts/sync-policy-packs.mjs does, so a service needs no
 * generated artifacts.
 */
/**
 * The institutions' diligence designs (domains/policy/diligence, by institution) and the product
 * taxonomy's legacy mapping (domains/products), which lets designs and pack layers name taxonomy nodes.
 */
export function loadDiligenceInputs(domains: string): DiligenceInputs {
  const legacy = loadProductTaxonomy(join(domains, "products")).legacy;
  const designs = new Map<string, DiligenceDesign>(yamlFiles(join(domains, "policy/diligence"))
    .map((path) => diligenceDesignSchema.parse(parse(readFileSync(path, "utf8")))).map((design) => [design.metadata.institution, design] as const));
  return { designs, legacy };
}

export function loadComposerRepository(paths: { domains: string; config: string }): ComposerRepository {
  const roster = (readJson(join(paths.domains, "agents/roster.json")) as { agents: Agent[] }).agents;
  const diligence = loadDiligenceInputs(paths.domains);
  const lineage = (product: string) => productLineageOf(product, diligence.legacy);
  const layers = yamlFiles(join(paths.domains, "policy/packs")).map((path) => policyPackLayerSchema.parse(parse(readFileSync(path, "utf8"))));
  const selection = policyPackSelectionSchema.parse(parse(readFileSync(join(paths.domains, "policy/selection.yaml"), "utf8")));
  const packs = new Map<string, EffectivePolicyPack>(selection.packs.map((entry) => {
    const pack = composeEffectivePack(layers, entry, { lineage });
    return [pack.id, pack] as const;
  }));
  const catalog = readJson(join(paths.config, "skill-library/catalog.json")) as {
    version: string; source_hash: string; bundle_code_hash: string; context_schema_version?: string; synthetic: boolean;
    skills: Array<{ id: string; semver: string }>;
  };
  const registry = new Map<string, any>((readJson(join(paths.config, "business-skills.json")) as { skills: Array<{ skillId: string; semver: string }> }).skills
    .map((entry) => [`${entry.skillId}@${entry.semver}`, entry]));
  const synthetic = parse(readFileSync(join(paths.domains, "policy/synthetic-installation-content.yaml"), "utf8")) as SyntheticContent;
  return {
    roster, layers, selection, packs, registry, synthetic, diligence, catalogSkills: catalog.skills,
    // The registry's own catalog: every vendored manifest is the registry's entry by construction.
    vendor: (workflow, extraSkillIds) => {
      const ids = new Set([...workflow.steps.map((step) => step.skill_id), ...extraSkillIds]);
      const skills = catalog.skills.filter((skill) => ids.has(skill.id)).sort((a, b) => (a.id < b.id ? -1 : 1));
      const missing = [...ids].filter((id) => !skills.some((skill) => skill.id === id));
      if (missing.length) throw new Error(`library.skill_missing:${missing.sort().join(",")}`);
      return {
        source: {
          library: "financial-crime-skills", catalogVersion: catalog.version, catalogSourceHash: catalog.source_hash,
          bundleCodeHash: catalog.bundle_code_hash, contextSchemaVersion: catalog.context_schema_version ?? null,
          synthetic: catalog.synthetic, files: ["catalog/catalog.json"],
        },
        skills,
      };
    },
  };
}

/**
 * The repository with a tenant's published pack layer revisions in place of the repository's layers
 * (phase H): its packs are composed again from them, so a process composed for the tenant pins the
 * packs its policy owners published. Without revisions it is the repository itself.
 */
export function withPublishedLayers(repository: ComposerRepository, revisions: readonly PolicyPackLayer[]): ComposerRepository {
  if (!revisions.length || !repository.selection) return repository;
  const layers = withLayerRevisions(repository.layers, revisions);
  const legacy = repository.diligence?.legacy ?? {};
  const packs = new Map<string, EffectivePolicyPack>(repository.selection.packs.map((entry) => {
    const pack = composeEffectivePack(layers, entry, { lineage: (product: string) => productLineageOf(product, legacy) });
    return [pack.id, pack] as const;
  }));
  return { ...repository, layers, packs };
}
