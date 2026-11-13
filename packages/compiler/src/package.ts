import { CompilerError, refuse } from "./errors.js";
import { type Json } from "./json.js";
import { parseYaml, TypedReader, type Node } from "./yaml.js";

/** The removed v1 package contract. Refused with its own code so an author knows to migrate. */
export const RETIRED_PACKAGE_API_VERSION = "harness.factory/domain-package-v1";
export const PACKAGE_API_VERSION = "harness.factory/domain-package-v2";

export interface Capability {
  id: string;
  kind: string;
  effect: string;
  adapterBindingId: string;
  inputSchema: Json;
  outputSchema: Json;
  timeoutMs: bigint;
  maxAttempts: bigint;
  idempotent: boolean;
}

export interface PolicyBinding {
  policyId: string;
  policyVersion: string;
  source: string;
  digest: string;
}

export interface DomainPackage {
  apiVersion: string;
  kind: string;
  metadata: { name: string; version: string; domain: string; objective: string; owners: string[]; riskClass: string | undefined };
  workflow: string;
  budgets: Json;
  modelProfiles: string[];
  /** Retired agent playbooks: read only so a package that still carries the key is refused. */
  skills: Json[] | undefined;
  /** Retired agent registrations: read only to refuse them. */
  agents: Json[] | undefined;
  agentProfiles: Json[] | undefined;
  capabilities: Capability[];
  bindings: Map<string, string>;
  coordinationMode: string | undefined;
  policies: PolicyBinding[];
  contextSelectors: Json[];
  contextClassificationPolicies: Json[];
  allowedRegions: string[];
  dataClasses: string[];
  evaluationRequirements: string[];
  integrations: Json | undefined;
  /** Business skills pinned for skill-bound nodes; distinct from the retired `skills`. */
  skillBindings: Json[];
  sourceAuthorization?: Json;
}

const U32_MAX = 0xffff_ffffn;

/**
 * Read `package.yaml` into the package model. Field typing follows the original reader:
 * string fields take any scalar by its text, unknown keys are ignored, and a missing
 * required field or a wrongly shaped one is a `parse package.yaml` refusal.
 */
export function parsePackage(text: string): DomainPackage {
  const document = parseYaml(text, "package.yaml");
  const read = new TypedReader(document);
  const root = read.struct(document.root, "package");
  const field = (key: string): Node | undefined => (root.has(key) ? root.get(key) : undefined);
  const strings = (key: string): string[] => {
    const node = field(key);
    return node === undefined ? [] : read.sequence(node, key).map((item, index) => read.string(item, `${key}[${index}]`));
  };
  const values = (key: string): Json[] => {
    const node = field(key);
    return node === undefined ? [] : read.sequence(node, key).map((item) => read.json(item));
  };
  const optionalValues = (key: string): Json[] | undefined => {
    const node = field(key);
    if (node === undefined) return undefined;
    return read.optionalSequence(node, key)?.map((item) => read.json(item));
  };

  const metadataFields = read.struct(read.required(root, "metadata", "package"), "metadata");
  const metadataString = (key: string) => read.string(read.required(metadataFields, key, "metadata"), `metadata.${key}`);
  const metadata = {
    name: metadataString("name"),
    version: metadataString("version"),
    domain: metadataString("domain"),
    objective: metadataString("objective"),
    owners: metadataFields.has("owners")
      ? read.sequence(metadataFields.get("owners"), "metadata.owners").map((item, index) => read.string(item, `metadata.owners[${index}]`))
      : [],
    riskClass: metadataFields.has("riskClass") ? read.optionalString(metadataFields.get("riskClass"), "metadata.riskClass") : undefined,
  };

  const capabilities = read.sequence(read.required(root, "capabilities", "package"), "capabilities").map((item, index): Capability => {
    const path = `capabilities[${index}]`;
    const capability = read.struct(item, path);
    const text = (key: string) => read.string(read.required(capability, key, path), `${path}.${key}`);
    const maxAttempts = capability.has("maxAttempts") ? read.u64(capability.get("maxAttempts"), `${path}.maxAttempts`) : 1n;
    if (maxAttempts > U32_MAX) document.fail(`invalid value at ${path}.maxAttempts: expected u32`);
    return {
      id: text("id"),
      kind: text("kind"),
      effect: text("effect"),
      adapterBindingId: text("adapterBindingId"),
      inputSchema: capability.has("inputSchema") ? read.json(capability.get("inputSchema")) : {},
      outputSchema: capability.has("outputSchema") ? read.json(capability.get("outputSchema")) : {},
      timeoutMs: read.u64(read.required(capability, "timeoutMs", path), `${path}.timeoutMs`),
      maxAttempts,
      idempotent: capability.has("idempotent") ? read.bool(capability.get("idempotent"), `${path}.idempotent`) : false,
    };
  });

  const policies = field("policies") === undefined ? [] : read.sequence(field("policies"), "policies").map((item, index): PolicyBinding => {
    const path = `policies[${index}]`;
    const policy = read.struct(item, path);
    const text = (key: string) => read.string(read.required(policy, key, path), `${path}.${key}`);
    return { policyId: text("policyId"), policyVersion: text("policyVersion"), source: text("source"), digest: text("digest") };
  });

  const integrationsNode = field("integrations");
  return {
    apiVersion: read.string(read.required(root, "apiVersion", "package"), "apiVersion"),
    kind: read.string(read.required(root, "kind", "package"), "kind"),
    metadata,
    workflow: read.string(read.required(root, "workflow", "package"), "workflow"),
    budgets: read.json(read.required(root, "budgets", "package")),
    modelProfiles: strings("modelProfiles"),
    skills: optionalValues("skills"),
    agents: optionalValues("agents"),
    agentProfiles: optionalValues("agentProfiles"),
    capabilities,
    bindings: field("bindings") === undefined ? new Map() : read.stringMap(field("bindings"), "bindings"),
    coordinationMode: field("coordinationMode") === undefined ? undefined : read.optionalString(field("coordinationMode"), "coordinationMode"),
    policies,
    contextSelectors: values("contextSelectors"),
    contextClassificationPolicies: values("contextClassificationPolicies"),
    allowedRegions: strings("allowedRegions"),
    dataClasses: strings("dataClasses"),
    evaluationRequirements: strings("evaluationRequirements"),
    integrations: integrationsNode === undefined ? undefined : read.optionalJson(integrationsNode),
    skillBindings: values("skillBindings"),
    ...(field("sourceAuthorization") === undefined ? {} : { sourceAuthorization: read.json(field("sourceAuthorization")) }),
  };
}

/** Parse, then refuse the retired v1 contract and anything that is not a v2 domain package. */
export function loadPackage(text: string): DomainPackage {
  const pkg = parsePackage(text);
  if (pkg.apiVersion === RETIRED_PACKAGE_API_VERSION) {
    throw new CompilerError(
      "package.v1_removed",
      `package.v1_removed: ${RETIRED_PACKAGE_API_VERSION} packages (and v1 plans) are no longer supported; migrate the package to ${PACKAGE_API_VERSION} (owners, riskClass, coordinationMode, allowedRegions, agentProfiles)`,
    );
  }
  if (pkg.apiVersion !== PACKAGE_API_VERSION || pkg.kind !== "DomainPackage") refuse("package.contract_unsupported");
  return pkg;
}
