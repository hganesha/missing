export type { components, operations, paths } from "./generated/api.js";
export type { OperationMeta } from "./operation-meta.js";
export { OPERATIONS, type OperationId } from "./generated/operations.js";
export { CATALOG_ACCESS, CATALOG_KINDS, canReadCatalog, type CatalogKind } from './catalog-access.js';
// Validators live at "@ehf/ui-contracts/validate" so the app bundle never includes the
// bundled contract or Ajv; only the mock, the BFF and tests import them.

import type { components } from "./generated/api.js";

/** Component schemas by name, e.g. `Schemas["Session"]`, `Schemas["HumanQueueItem"]`. */
export type Schemas = components["schemas"];
