// The acquisition connectors (KYB registry, LEI, officers, ownership, documents; sanctions, PEP and
// adverse-media screening) live in @ehf/flow-composer (packages/flow-composer/src/connectors.ts),
// shared with run-time flow composition. Re-exported for the package generators.
import { tsImport } from "tsx/esm/api";
const module = await tsImport("../../packages/flow-composer/src/connectors.ts", import.meta.url);
export const { wiringOutput, subjectInput, subjectSelectors, connectors, connectorNode } = module;
