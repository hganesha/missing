import { evaluateOpaModule, POLICY_OPA_VERSION } from "./opa-module.js";
import { createHash } from "node:crypto";
export * from "./source-policy.js";
export { compileDecisionTableSources } from "./decision-table/sources.js";
export { OpaServerPool, type OpaBundleEvaluator } from "./decision-table/opa-server.js";
import { parseDocument } from "yaml";
import { z } from "zod";
export * from "./business-policy.js";
export * from "./diligence/index.js";
export { DILIGENCE_REGO } from "./diligence/rego.js";
export { compileBankingRequirements, assessBankingRelationship, type BankingRequirement } from "./banking.js";
export * from "./policy-packs.js";
export * from "./effective-policy.js";
export * from "./products.js";
import {
  caseSnapshotSchema,
  policyBundleSchema,
  policyEvaluationSchema,
  stableDigest,
  type CaseSnapshot,
  type PolicyBundle,
  type PolicyEvaluation,
} from "@ehf/contracts";

const outcomeSchema = z.enum(["ALLOW", "BLOCK", "REVIEW", "UNKNOWN", "ERROR"]);
const operatorSchema = z.enum([
  "any",
  "contains",
  "digestMatch",
  "eq",
  "none",
  "notEmpty",
  "policyEvidenceSatisfied",
]);

const blockerSchema = z.object({
  id: z.string().min(1),
  path: z.string().startsWith("$."),
  status: z.literal("UNRESOLVED"),
  reasonCode: z.string().min(1),
}).strict();

export const policySourceSchema = z.object({
  apiVersion: z.literal("harness.factory/policy-v1"),
  kind: z.literal("Policy"),
  metadata: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    version: z.string().min(1),
    domain: z.string().min(1),
    jurisdiction: z.string().min(1),
    status: z.enum(["DRAFT", "CANDIDATE", "APPROVED", "RETIRED"]),
  }).strict(),
  spec: z.object({
    compilation: z.object({
      target: z.literal("opa"),
      regoVersion: z.literal("v1"),
      entrypoint: z.string().regex(/^data\.[a-z0-9_.]+$/),
      deterministic: z.literal(true),
      networkAccess: z.literal("denied"),
    }).strict(),
    outcomes: z.array(outcomeSchema).min(1),
    defaultOutcome: outcomeSchema,
    unknownHandling: outcomeSchema,
    deploymentReadiness: z.object({
      productionEligible: z.boolean(),
      blockers: z.array(blockerSchema),
    }).strict(),
    institutionSettings: z.record(z.string(), z.unknown()),
    gates: z.record(z.string(), z.unknown()),
  }).passthrough(),
}).strict();

export type PolicySource = z.infer<typeof policySourceSchema>;
export type PolicyOutcome = z.infer<typeof outcomeSchema>;
export type PolicyDecision = {
  outcome: PolicyOutcome;
  reasonCode: string | null;
  ruleId?: string;
  commandType?: string;
  decision?: string;
};

export type CompiledPolicyBundle = {
  manifest: PolicyBundle;
  productionEligible: boolean;
  releaseBlockers: Array<z.infer<typeof blockerSchema>>;
  files: {
    "policy.rego": string;
    "data.json": string;
  };
};

type JsonObject = Record<string, unknown>;

export function parsePolicySource(source: string): PolicySource {
  const document = parseDocument(source, { strict: true, uniqueKeys: true });
  if (document.errors.length) {
    throw new Error(`policy.yaml_invalid:${document.errors.map((error) => error.message).join("; ")}`);
  }
  const policy = policySourceSchema.parse(document.toJS({ maxAliasCount: 0 }));
  validatePolicy(policy);
  return policy;
}

export function compilePolicySource(source: string, options: {
  opaVersion: string;
  testsSource: string;
  release?: "candidate" | "production";
}): CompiledPolicyBundle {
  if (!options.opaVersion.trim()) throw new Error("policy.opa_version_required");
  const policy = parsePolicySource(source);
  validatePolicyTests(policy, options.testsSource);
  const blockers = policy.spec.deploymentReadiness.blockers;
  if (options.release === "production" && (!policy.spec.deploymentReadiness.productionEligible || blockers.length)) {
    throw new Error(`policy.production_blocked:${blockers.map((item) => item.id).join(",") || "not_eligible"}`);
  }
  const sourceDigest = digest(source);
  const data = stableJson({ policy });
  const rego = emitRego(policy);
  const bundleDigest = digest(stableJson({ sourceDigest, rego, data }));
  const ruleIds = collectIds(policy.spec.gates);
  const manifest = {
    apiVersion: "harness.factory/policy-bundle-v1" as const,
    kind: "PolicyBundle" as const,
    bundleId: `${policy.metadata.id}@${policy.metadata.version}:${bundleDigest.slice(0, 12)}`,
    policyId: policy.metadata.id,
    policyVersion: policy.metadata.version,
    sourceDigest,
    bundleDigest,
    opaVersion: options.opaVersion,
    regoModules: [{ path: "policy.rego", digest: digest(rego) }],
    dataDigest: digest(data),
    gates: Object.keys(policy.spec.gates).sort().map((gateId) => ({
      gateId,
      entrypoint: policy.spec.compilation.entrypoint,
      allowedOutcomes: policy.spec.outcomes,
    })),
    ruleIds,
    testsDigest: digest(options.testsSource),
    authority: {
      source: String((policy.spec.authority as JsonObject | undefined)?.source ?? "POLICY_DB"),
      casePath: String((policy.spec.authority as JsonObject | undefined)?.casePath ?? "$.policyAuthority"),
      requireSnapshotDigest: Boolean((policy.spec.authority as JsonObject | undefined)?.requireSnapshotDigest),
    },
  };
  return {
    manifest,
    productionEligible: policy.spec.deploymentReadiness.productionEligible && blockers.length === 0,
    releaseBlockers: blockers,
    files: { "policy.rego": rego, "data.json": data },
  };
}

function validatePolicyTests(policy: PolicySource, source: string): void {
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch {
    throw new Error("policy.tests_json_invalid");
  }
  if (!isObject(document) || document.policyId !== policy.metadata.id || !Array.isArray(document.cases) || document.cases.length === 0) {
    throw new Error("policy.tests_contract_invalid");
  }
  const fixtureIds = new Set<string>();
  for (const fixture of document.cases) {
    if (!isObject(fixture) || typeof fixture.id !== "string" || typeof fixture.gate !== "string"
      || !isObject(fixture.input) || !isObject(fixture.expected) || fixtureIds.has(fixture.id)) {
      throw new Error("policy.tests_contract_invalid");
    }
    fixtureIds.add(fixture.id);
    const actual = evaluatePolicy(policy, fixture.gate, fixture.input);
    if (stableJson(actual) !== stableJson(fixture.expected)) {
      throw new Error(`policy.golden_decision_mismatch:${fixture.id}`);
    }
  }
}

/**
 * Evaluate a gate against an immutable CaseSnapshot and issue a reproducible receipt.
 * The caller supplies the clock value so replay produces the same receipt byte-for-byte.
 */
export function evaluateCompiledPolicy(input: {
  source: string;
  compiled: CompiledPolicyBundle;
  snapshot: CaseSnapshot;
  gateId: string;
  evaluatedAt: string;
}): PolicyEvaluation {
  const snapshot = caseSnapshotSchema.parse(input.snapshot);
  const policy = parsePolicySource(input.source);
  if (digest(input.source) !== input.compiled.manifest.sourceDigest) throw new Error("policy.source_digest_mismatch");
  if (snapshot.policyAuthority.policyId !== input.compiled.manifest.policyId
    || snapshot.policyAuthority.policyVersion !== input.compiled.manifest.policyVersion
    || snapshot.policyAuthority.policyBundleDigest !== input.compiled.manifest.bundleDigest) {
    throw new Error("policy.snapshot_authority_mismatch");
  }
  const decision = evaluatePolicy(policy, input.gateId, snapshot.data);
  return compiledPolicyReceipt(input,snapshot,decision);
}

export async function evaluateCompiledPolicyWithOpa(input: Parameters<typeof evaluateCompiledPolicy>[0]): Promise<PolicyEvaluation> {
  const snapshot=caseSnapshotSchema.parse(input.snapshot),policy=parsePolicySource(input.source);
  if (digest(input.source)!==input.compiled.manifest.sourceDigest || input.compiled.files["policy.rego"]!==emitRego(policy)
    || input.compiled.files["data.json"]!==stableJson({policy})
    || digest(stableJson({sourceDigest:digest(input.source),rego:input.compiled.files["policy.rego"],data:input.compiled.files["data.json"]}))!==input.compiled.manifest.bundleDigest)
    throw new Error("policy.compilation_integrity_mismatch");
  if(input.compiled.manifest.opaVersion!==POLICY_OPA_VERSION) throw new Error("policy.opa_version_mismatch");
  if(snapshot.policyAuthority.policyId!==input.compiled.manifest.policyId || snapshot.policyAuthority.policyVersion!==input.compiled.manifest.policyVersion
    || snapshot.policyAuthority.policyBundleDigest!==input.compiled.manifest.bundleDigest) throw new Error("policy.snapshot_authority_mismatch");
  const decision=z.object({outcome:outcomeSchema,reasonCode:z.string().nullable(),ruleId:z.string().optional(),commandType:z.string().optional(),decision:z.string().optional()}).strict()
    .parse(await evaluateOpaModule({bundleDigest:input.compiled.manifest.bundleDigest,files:input.compiled.files},policy.spec.compilation.entrypoint,{case:snapshot.data,gateId:input.gateId}));
  return compiledPolicyReceipt(input,snapshot,{outcome:decision.outcome,reasonCode:decision.reasonCode,
    ...(decision.ruleId?{ruleId:decision.ruleId}:{}),...(decision.commandType?{commandType:decision.commandType}:{}),...(decision.decision?{decision:decision.decision}:{})});
}
function compiledPolicyReceipt(input: Parameters<typeof evaluateCompiledPolicy>[0],snapshot:CaseSnapshot,decision:PolicyDecision):PolicyEvaluation {
  const reasonCode = decision.reasonCode ?? "POLICY_GATE_PASSED";
  const evidenceRefs = Array.isArray(snapshot.data.evidence)
    ? snapshot.data.evidence.filter(isObject).flatMap((item) => typeof item.evidenceId === "string" ? [item.evidenceId] : [])
    : [];
  const unsigned = {
    apiVersion: "harness.factory/policy-evaluation-v1" as const,
    kind: "PolicyEvaluation" as const,
    evaluationId: "pending",
    tenantId: snapshot.tenantId,
    caseId: snapshot.caseId,
    caseSequence: snapshot.caseSequence,
    caseSnapshotDigest: snapshot.snapshotDigest,
    dependencyDigest: snapshot.dependencyDigest,
    policyBundleDigest: input.compiled.manifest.bundleDigest,
    gateId: input.gateId,
    inputDigest: stableDigest(snapshot.data),
    outcome: decision.outcome,
    ruleResults: decision.ruleId ? [{
      ruleId: decision.ruleId,
      outcome: decision.outcome,
      reasonCode,
      evidenceRefs,
    }] : [],
    reasonCodes: [reasonCode],
    obligations: decision.commandType ? [{
      code: decision.commandType,
      parameters: decision.decision ? { decision: decision.decision } : {},
    }] : [],
    evidenceRefs,
    evaluatedAt: input.evaluatedAt,
  };
  const identityDigest = stableDigest(unsigned);
  const withId = { ...unsigned, evaluationId: `evaluation_${identityDigest.slice(0, 24)}` };
  return policyEvaluationSchema.parse({ ...withId, receiptDigest: stableDigest(withId) });
}

export function evaluatePolicy(policy: PolicySource, gateId: string, input: JsonObject): PolicyDecision {
  const gates = policy.spec.gates as Record<string, JsonObject>;
  const gate = gates[gateId];
  if (!gate) return { outcome: "ERROR", reasonCode: "POLICY_GATE_NOT_FOUND" };
  const requirements = (gate.preconditions ?? gate.requirements ?? []) as JsonObject[];
  for (const requirement of requirements) {
    if (!evaluateAssertion(requirement.assert as JsonObject, input)) {
      const failure = requirement.onFailure as JsonObject;
      return {
        outcome: outcomeSchema.parse(failure.outcome),
        reasonCode: String(failure.reasonCode),
        ruleId: String(requirement.id),
      };
    }
  }
  const rules = gate.rules as JsonObject[] | undefined;
  if (rules) {
    for (const rule of [...rules].sort((a, b) => Number(a.priority) - Number(b.priority))) {
      if (!evaluateAssertion(rule.when as JsonObject, input)) continue;
      if (rule.require && !evaluateAssertion(rule.require as JsonObject, input)) {
        return normalizeOutcome(rule.onRequirementFailure as JsonObject, String(rule.id));
      }
      return normalizeOutcome(rule.outcome as JsonObject, String(rule.id));
    }
    return normalizeOutcome(gate.otherwise as JsonObject);
  }
  const onPass = gate.onPass as JsonObject;
  const command = onPass.command as JsonObject;
  return {
    outcome: outcomeSchema.parse(onPass.outcome),
    reasonCode: null,
    commandType: String(command.commandType),
    ...(command.decision ? { decision: String(command.decision) } : {}),
  };
}

function validatePolicy(policy: PolicySource): void {
  const ids = new Set<string>();
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const item = value as JsonObject;
    if (typeof item.id === "string") {
      if (ids.has(item.id)) throw new Error(`policy.duplicate_id:${item.id}`);
      ids.add(item.id);
    }
    if (typeof item.operator === "string") operatorSchema.parse(item.operator);
    for (const child of Array.isArray(value) ? value : Object.values(item)) visit(child);
  };
  visit(policy.spec.gates);
  for (const blocker of policy.spec.deploymentReadiness.blockers) {
    if (readPath(policy, blocker.path) !== null) throw new Error(`policy.blocker_path_must_be_null:${blocker.path}`);
  }
}

function normalizeOutcome(value: JsonObject, ruleId?: string): PolicyDecision {
  return {
    outcome: outcomeSchema.parse(value.result),
    reasonCode: String(value.reasonCode),
    ...(ruleId ? { ruleId } : {}),
    ...(value.commandType ? { commandType: String(value.commandType) } : {}),
    ...(value.decision ? { decision: String(value.decision) } : {}),
  };
}

function evaluateAssertion(assertion: JsonObject, input: JsonObject): boolean {
  if (Array.isArray(assertion.all)) return assertion.all.every((item) => evaluateAssertion(item as JsonObject, input));
  if (Array.isArray(assertion.any) && !assertion.operator) return assertion.any.some((item) => evaluateAssertion(item as JsonObject, input));
  const operator = operatorSchema.parse(assertion.operator);
  if (operator === "digestMatch") {
    const left = assertion.left as JsonObject;
    const right = assertion.right as JsonObject;
    const values = readPath(input, String(left.path));
    const selected = Array.isArray(values) ? values.find((item) => matches(item, left.select as JsonObject)) : undefined;
    return readPath(selected, String(left.valuePath)) === readPath(input, String(right.path));
  }
  if (operator === "policyEvidenceSatisfied") {
    const claims = input.claims;
    const claim = Array.isArray(claims)
      ? claims.find((item) => isObject(item) && item.predicate === assertion.policyClaimPredicate) as JsonObject | undefined
      : undefined;
    if (!claim) return false;
    const evidence = readPath(input, String(assertion.evidencePath));
    const present = new Set(Array.isArray(evidence)
      ? evidence.filter(isObject).map((item) => item.purpose)
      : []);
    const claimValue = isObject(claim.value) ? claim.value : {};
    const required = Array.isArray(claimValue.requiredEvidencePurposes) ? claimValue.requiredEvidencePurposes : [];
    return required.every((purpose) => present.has(purpose));
  }
  const actual = readPath(input, String(assertion.path));
  if (operator === "eq") return actual === assertion.value;
  if (operator === "notEmpty") return Array.isArray(actual) ? actual.length > 0 : actual !== null && actual !== undefined && actual !== "";
  if (operator === "contains" || operator === "any") return Array.isArray(actual) && actual.some((item) => matches(item, assertion.where as JsonObject));
  if (operator === "none") return Array.isArray(actual) && !actual.some((item) => matches(item, assertion.where as JsonObject));
  return false;
}

function matches(value: unknown, expected: JsonObject): boolean {
  if (!isObject(value)) return false;
  return Object.entries(expected ?? {}).every(([key, condition]) => {
    if (isObject(condition) && Array.isArray(condition.in)) return condition.in.includes(value[key]);
    return value[key] === condition;
  });
}

function readPath(value: unknown, path: string): unknown {
  if (!path.startsWith("$.")) return undefined;
  return path.slice(2).split(".").reduce<unknown>((current, segment) => isObject(current) ? current[segment] : undefined, value);
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function emitRego(policy: PolicySource): string {
  const entrypoint = policy.spec.compilation.entrypoint.replace(/^data\./, "").split(".");
  const rule = entrypoint.pop()!;
  const packageName = entrypoint.join(".");
  const gates = policy.spec.gates as Record<string, JsonObject>;
  const helpers: string[] = [];
  let assertionIndex = 0;
  const assertionRule = (assertion: JsonObject): string => {
    const name = `assertion_${assertionIndex++}`;
    if (Array.isArray(assertion.all)) {
      const children = assertion.all.map((item) => assertionRule(item as JsonObject));
      helpers.push(`${name} if {\n${children.map((child) => `  ${child}`).join("\n")}\n}`);
      return name;
    }
    if (Array.isArray(assertion.any) && !assertion.operator) {
      for (const item of assertion.any) {
        const child = assertionRule(item as JsonObject);
        helpers.push(`${name} if { ${child} }`);
      }
      return name;
    }
    const operator = operatorSchema.parse(assertion.operator);
    const path = (value: unknown): string => `input.case${String(value).slice(1)}`;
    if (operator === "eq") helpers.push(`${name} if { ${path(assertion.path)} == ${JSON.stringify(assertion.value)} }`);
    else if (operator === "notEmpty") helpers.push(`${name} if { count(${path(assertion.path)}) > 0 }`);
    else if (operator === "contains" || operator === "any") {
      helpers.push(`${name} if { some item in ${path(assertion.path)}; ${regoMatch("item", assertion.where as JsonObject)} }`);
    } else if (operator === "none") {
      const present = `${name}_present`;
      helpers.push(`${present} if { some item in ${path(assertion.path)}; ${regoMatch("item", assertion.where as JsonObject)} }`);
      helpers.push(`${name} if { not ${present} }`);
    } else if (operator === "digestMatch") {
      const left = assertion.left as JsonObject;
      const right = assertion.right as JsonObject;
      helpers.push(`${name} if {\n  some item in ${path(left.path)}\n  ${regoMatch("item", left.select as JsonObject)}\n  item${String(left.valuePath).slice(1)} == ${path(right.path)}\n}`);
    } else {
      const evidencePath = path(assertion.evidencePath);
      helpers.push(`${name} if {\n  some claim in input.case.claims\n  claim.predicate == ${JSON.stringify(assertion.policyClaimPredicate)}\n  required := object.get(object.get(claim, "value", {}), "requiredEvidencePurposes", [])\n  present := {purpose | some evidence in ${evidencePath}; purpose := evidence.purpose}\n  every purpose in required { purpose in present }\n}`);
    }
    return name;
  };
  const blocks: string[] = [];
  for (const [gateId, gate] of Object.entries(gates)) {
    const gateRule = `evaluate_${gateId.replace(/[^A-Za-z0-9_]/g, "_")}`;
    blocks.push(`${rule} := output if { input.gateId == ${JSON.stringify(gateId)}; output := ${gateRule} }`);
    const previousPasses: string[] = [];
    const requirements = (gate.preconditions ?? gate.requirements ?? []) as JsonObject[];
    for (const requirement of requirements) {
      const assertion = assertionRule(requirement.assert as JsonObject);
      const failure = requirement.onFailure as JsonObject;
      const output = {
        outcome: failure.outcome,
        reasonCode: failure.reasonCode,
        ruleId: requirement.id,
      };
      blocks.push(`${gateRule} := ${JSON.stringify(output)} if { ${[...previousPasses, `not ${assertion}`].join("; ")} }`);
      previousPasses.push(assertion);
    }
    const rules = gate.rules as JsonObject[] | undefined;
    if (!rules) {
      const onPass = gate.onPass as JsonObject;
      const command = onPass.command as JsonObject;
      const output = {
        outcome: onPass.outcome,
        reasonCode: null,
        commandType: command.commandType,
        ...(command.decision ? { decision: command.decision } : {}),
      };
      blocks.push(`${gateRule} := ${JSON.stringify(output)} if { ${previousPasses.join("; ") || "true"} }`);
      continue;
    }
    const previousRules: string[] = [];
    for (const policyRule of [...rules].sort((a, b) => Number(a.priority) - Number(b.priority))) {
      const when = assertionRule(policyRule.when as JsonObject);
      const base = [...previousPasses, ...previousRules.map((item) => `not ${item}`), when];
      if (policyRule.require) {
        const require = assertionRule(policyRule.require as JsonObject);
        const failed = policyRule.onRequirementFailure as JsonObject;
        blocks.push(`${gateRule} := ${JSON.stringify(regoOutcome(failed, String(policyRule.id)))} if { ${[...base, `not ${require}`].join("; ")} }`);
        blocks.push(`${gateRule} := ${JSON.stringify(regoOutcome(policyRule.outcome as JsonObject, String(policyRule.id)))} if { ${[...base, require].join("; ")} }`);
      } else {
        blocks.push(`${gateRule} := ${JSON.stringify(regoOutcome(policyRule.outcome as JsonObject, String(policyRule.id)))} if { ${base.join("; ")} }`);
      }
      previousRules.push(when);
    }
    blocks.push(`${gateRule} := ${JSON.stringify(regoOutcome(gate.otherwise as JsonObject))} if { ${[...previousPasses, ...previousRules.map((item) => `not ${item}`)].join("; ")} }`);
  }
  return `# Generated by @ehf/policy-engine. Do not edit.\npackage ${packageName}\n\nimport rego.v1\n\ndefault ${rule} := {"outcome": "ERROR", "reasonCode": "POLICY_GATE_NOT_FOUND"}\n\n${blocks.join("\n\n")}\n\n${helpers.join("\n\n")}\n`;
}

function regoOutcome(value: JsonObject, ruleId?: string): JsonObject {
  return {
    outcome: value.result,
    reasonCode: value.reasonCode,
    ...(ruleId ? { ruleId } : {}),
    ...(value.commandType ? { commandType: value.commandType } : {}),
    ...(value.decision ? { decision: value.decision } : {}),
  };
}

function regoMatch(variable: string, expected: JsonObject | undefined): string {
  const expressions = Object.entries(expected ?? {}).map(([key, condition]) => {
    const access = `${variable}[${JSON.stringify(key)}]`;
    if (isObject(condition) && Array.isArray(condition.in)) {
      return `${access} in ${JSON.stringify(condition.in)}`;
    }
    return `${access} == ${JSON.stringify(condition)}`;
  });
  return expressions.join("; ") || "true";
}

function collectIds(value: unknown): string[] {
  const ids = new Set<string>();
  const visit = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    if (!Array.isArray(item) && typeof (item as JsonObject).id === "string") ids.add(String((item as JsonObject).id));
    for (const child of Array.isArray(item) ? item : Object.values(item as JsonObject)) visit(child);
  };
  visit(value);
  return [...ids].sort();
}

function stableJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (isObject(item)) return Object.fromEntries(Object.keys(item).sort().map((key) => [key, normalize(item[key])]));
    return item;
  };
  return JSON.stringify(normalize(value));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// ---------------------------------------------------------------- decision tables
//
// The second authoring form this engine compiles. Where the operator-tree form above suits
// a policy written as nested assertions, a decision table suits one a policy owner reviews
// as rows: conditions that each resolve to one token from a closed set, matched in an
// authored order. Both compile to the same PolicyBundle contract.
export {
  caseAggregateSchema,
  type AggregateEvidence,
  type AggregateProviderResult,
  type CaseAggregate,
} from "./decision-table/aggregate.js";

export {
  CatalogIntegrityError,
  loadPolicyCatalog,
  policyCatalog,
  resolveOwnerInput,
  type PolicyCatalog,
} from "./decision-table/catalog.js";

export {
  UNKNOWN_TOKEN,
  assignRiskCohort,
  evaluateGate,
  evaluateTable,
  normalizeDigest,
  obligationExpired,
  obligationSatisfied,
  type GateEvaluation,
} from "./decision-table/evaluate.js";

export {
  DECISION_TABLE_ENTRYPOINT,
  REGO_MODULES,
  buildBundleData,
  compileDecisionTablePolicy,
  evaluateDecisionTablePolicy,
  evaluateDecisionTablePolicyWithOpa,
  releaseBlockers,
  type CompiledDecisionTableBundle,
  type DeclaredBlocker,
} from "./decision-table/compile.js";

export {
  cohortCatalogSchema,
  decisionTableSchema,
  evidenceObligationCatalogSchema,
  ownerInputRegisterSchema,
  policyOutcomeSchema as decisionTableOutcomeSchema,
  policySchema as decisionTablePolicySchema,
  reasonCodeRegistrySchema,
  ruleCatalogSchema,
  type Condition,
  type DecisionRow,
  type DecisionTable,
  type EvidenceObligation,
  type Extractor,
  type FailureCohort,
  type OwnerInput,
  type ReasonCode,
  type RiskCohort,
  type Rule,
} from "./decision-table/schema.js";

export * from "./installation-content.js";

export * from "./source-policy-opa.js";
export { closeOpaModules } from "./opa-module.js";

export * from "./banking-opa.js";
export * from "./impact.js";
