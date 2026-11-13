import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { agenticBusinessPolicy as compose, type SyntheticContent } from "../../packages/flow-composer/src/business-policy.js";
import { loadDiligenceInputs } from "../../packages/flow-composer/src/load.js";
import type { EffectivePolicyPack } from "../../packages/policy-engine/src/index.js";

// The builder lives in @ehf/flow-composer (packages/flow-composer/src/business-policy.ts); this wrapper
// supplies the repository's SYNTHETIC placeholder content.
const SYNTHETIC = parse(readFileSync(new URL("../../domains/policy/synthetic-installation-content.yaml", import.meta.url), "utf8")) as SyntheticContent;
// And the institutions' diligence designs, as the generated flows carry them.
const DILIGENCE = loadDiligenceInputs(new URL("../../domains", import.meta.url).pathname);

export function agenticBusinessPolicy(id: string, packs: EffectivePolicyPack[], fields: string[], options: { dueDiligence?: "simplified" | "standard" | "enhanced"; ownershipAgent?: string | null } = {}) {
  return compose(id, packs, fields, SYNTHETIC, { diligence: DILIGENCE, ...options });
}
