import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { policyCatalog as loadCatalog, type PolicyCatalog } from "@ehf/policy-engine";

/**
 * The authored US KYC policy: rules, reason codes, evidence obligations, cohorts, owner
 * inputs and the three gate decision tables.
 *
 * The machinery that reads and evaluates all of this lives in `@ehf/policy-engine`, which
 * knows nothing about KYC. What lives here is the content and the tests that hold it to
 * account. That split is deliberate: the compiler is Lane A's and serves every domain, and
 * the policy is Lane B's and serves one.
 */
export const KYC_POLICY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../domains/kyc/policy",
);

export function kycPolicyCatalog(): PolicyCatalog {
  return loadCatalog(KYC_POLICY_ROOT);
}

export type { PolicyCatalog };
