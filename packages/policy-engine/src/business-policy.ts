import { validateInstallationContent } from "./installation-content.js";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { z } from "zod";
import {
  businessDecisionBasisSchema, businessDecisionResultSchema, businessDecisionSchema,
  effectivePolicySetSchema, policyBundleSchema, stableDigest,
  type BusinessDecision, type BusinessDecisionBasis,
  type EffectivePolicySet, type PolicyBundle,
} from "@ehf/contracts";
import { OpaServerPool, type OpaBundleEvaluator } from "./decision-table/opa-server.js";
import { verifyOpaVersion } from "./decision-table/compile.js";
import { productCovered } from "@ehf/contracts/products";
import { approvalGateOf, checkDiligenceCoverage, diligenceIndex, diligenceSourceSchema, requiresApprovals, type DiligenceSource } from "./diligence/schema.js";
import { APPROVAL_REGO } from "./diligence/approvals.js";
import { combineDiligenceContent, DERIVABLE_CONTENT_FIELDS, deriveDiligenceContent, type DerivableContentField } from "./diligence/derive.js";
import { INSTALLATION_CONTENT_SCHEMA_VERSION } from "./installation-content.js";
import { DILIGENCE_REGO } from "./diligence/rego.js";

const id = z.string().min(1).max(200);
/** Rules read the facts, configuration, observations, subjects and the verified scope (jurisdiction, institution, products, customer type, legal form). */
const pointer = z.string().regex(/^\/(?:facts|configuration|observations|subjectIds|scope)(?:\/(?:[^~]|~[01])*)?$/);
const rowPointer = z.string().regex(/^(?:\/(?:[^~]|~[01])*)?$/);
export type PolicyPredicate =
  | { path: string; op: "eq" | "ne" | "in" | "contains" | "gt" | "gte" | "lt" | "lte" | "count_gte" | "age_lte_seconds" | "after"; value: unknown }
  | { path: string; op: "eq" | "ne" | "in" | "contains" | "gt" | "gte" | "lt" | "lte" | "count_gte" | "age_lte_seconds" | "after"; valueFrom: string }
  | { path: string; op: "eq" | "ne" | "in" | "contains" | "gt" | "gte" | "lt" | "lte" | "count_gte" | "age_lte_seconds" | "after"; valueFromParent: {depth:number;path:string} }
  | { path: string; op: "present" | "missing" }
  | { all: PolicyPredicate[] } | { any: PolicyPredicate[] }
  | { every: { path: string; where: PolicyPredicate; allowEmpty: boolean; fromInput?:boolean } }
  | { some: { path: string; where: PolicyPredicate; fromInput?:boolean } };

const predicate: z.ZodType<PolicyPredicate> = z.lazy(() => z.union([
  z.object({ path: rowPointer, op: z.enum(["eq", "ne", "in", "contains", "gt", "gte", "lt", "lte", "count_gte", "age_lte_seconds", "after"]), value: z.json() }).strict(),
  z.object({ path: rowPointer, op: z.enum(["eq", "ne", "in", "contains", "gt", "gte", "lt", "lte", "count_gte", "age_lte_seconds", "after"]), valueFrom: pointer }).strict(),
  z.object({path:rowPointer,op:z.enum(["eq","ne","in","contains","gt","gte","lt","lte","count_gte","age_lte_seconds","after"]),valueFromParent:z.object({depth:z.number().int().min(1).max(8),path:rowPointer}).strict()}).strict(),
  z.object({ path: rowPointer, op: z.enum(["present", "missing"]) }).strict(),
  z.object({ all: z.array(predicate).min(1).max(100) }).strict(),
  z.object({ any: z.array(predicate).min(1).max(100) }).strict(),
  z.object({ every: z.object({ path: rowPointer, where: predicate, fromInput:z.boolean().optional(), allowEmpty: z.boolean().default(false) }).strict() }).strict(),
  z.object({ some: z.object({ path: rowPointer, where: predicate, fromInput:z.boolean().optional() }).strict() }).strict(),
]) as z.ZodType<PolicyPredicate>);

const policySetSourceSchema = effectivePolicySetSchema.omit({ apiVersion: true, gateBindings: true, setDigest: true }).extend({
  status: z.enum(["CANDIDATE", "APPROVED"]),
}).strict();
const ruleSchema = z.object({ id, when: predicate, result: businessDecisionResultSchema }).strict();
export const businessPolicySourceSchema = z.object({
  apiVersion: z.literal("harness.factory/business-policy-v2"), kind: z.literal("BusinessPolicy"),
  metadata: z.object({ id, version: id, owner: id }).strict(),
  policySets: z.array(policySetSourceSchema).min(1).max(100),
  gates: z.record(id, z.object({ inputProfile: id, rules: z.array(ruleSchema).min(1).max(200),
    otherwise: businessDecisionResultSchema }).strict()),
  decisionTtlSeconds: z.number().int().min(1).max(86400),
  /** Customer due-diligence levels by party type and product, with escalating risk overlays. */
  diligence: diligenceSourceSchema.optional(),
}).strict().superRefine((v, ctx) => {
  if (v.diligence && Object.hasOwn(v.gates, v.diligence.gateId)) ctx.addIssue({ code: "custom", message: "policy.diligence_gate_collision" });
  if (v.diligence && requiresApprovals(v.diligence)) {
    const gate = approvalGateOf(v.diligence);
    if (!Object.hasOwn(v.gates, gate)) ctx.addIssue({ code: "custom", message: `policy.diligence_approval_gate_missing:${gate}` });
  }
  if (v.diligence) {
    const authoredRuleIds = new Set(Object.values(v.gates).flatMap(g => g.rules.map(r => r.id)));
    for (const overlay of v.diligence.overlays) if (authoredRuleIds.has(overlay.id)) ctx.addIssue({ code: "custom", message: `policy.diligence_rule_id_collision:${overlay.id}` });
  }
  for (const gate of Object.values(v.gates)) for (const result of [gate.otherwise, ...gate.rules.map(rule => rule.result)])
    if (result.outputs) ctx.addIssue({ code: "custom", message: "policy.authored_outputs_forbidden" });
  if (!Object.keys(v.gates).length || Object.keys(v.gates).length > 100)
    ctx.addIssue({ code: "custom", message: "policy.gate_count_invalid" });
  if (new Set(v.policySets.map(s => s.id)).size !== v.policySets.length)
    ctx.addIssue({ code: "custom", message: "policy.policy_set_duplicate" });
  const ruleIds = Object.values(v.gates).flatMap(g => g.rules.map(r => r.id));
  if (new Set(ruleIds).size !== ruleIds.length) ctx.addIssue({ code: "custom", message: "policy.rule_duplicate" });
  for (const gate of Object.values(v.gates)) {
    if (gate.otherwise.actions.length || gate.otherwise.state === "DECIDED")
      ctx.addIssue({ code: "custom", message: "policy.default_business_action_forbidden" });
  }
});
export type BusinessPolicySource = z.infer<typeof businessPolicySourceSchema>;
export type CompiledBusinessPolicy = {
  manifest: PolicyBundle; files: Record<string, string>; policySets: EffectivePolicySet[];
  source: BusinessPolicySource; productionEligible: boolean;
  releaseBlockers: Array<{ id: string; status: "UNRESOLVED"; reasonCode: string; title: string; owner: string }>;
};
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const ENTRYPOINT = "data.harness.business.result";
const REGOPATH = "harness/business/policy.rego";
export const isBusinessPolicyFiles = (files: Record<string, string>) => {
  try { return (parse(files["policy.yaml"] ?? "") as { kind?: string })?.kind === "BusinessPolicy"; } catch { return false; }
};

/** No v1 semantics are widened. v2 rules explicitly authorize their exact business actions. */
export function compileBusinessPolicy(source: string | unknown, options: { opaVersion: string; release?: "candidate" | "production" }): CompiledBusinessPolicy {
  const raw = typeof source === "string" ? parse(source) : source;
  // Bound nesting before recursive schema parsing (also protects the YAML/JSON authoring API).
  let nodes = 0;
  const bound = (v: unknown, depth: number) => {
    if (++nodes > 100000 || depth > 40) throw new Error("policy.source_budget_exceeded");
    if (v && typeof v === "object") for (const child of Object.values(v)) bound(child, depth + 1);
  };
  bound(raw, 0);
  const policy = businessPolicySourceSchema.parse(raw);
  if (!/^\d+\.\d+\.\d+$/.test(options.opaVersion)) throw new Error("policy.opa_version_invalid");
  const modules: string[] = ["package harness.business", "import rego.v1"];
  let sequence = 0;
  const pathParts = (p: string) => p === "" ? [] : p.slice(1).split("/").map(v => v.replaceAll("~1", "/").replaceAll("~0", "~"));
  const emit = (expr: PolicyPredicate, row = false): string => {
    const name = `condition_${sequence++}`;
    if ("all" in expr) {
      const children = expr.all.map(p => emit(p, row));
      modules.push(`${name}(root, parents) if { ${children.map(c => `${c}(root, parents)`).join("; ")} }`);
    } else if ("any" in expr) {
      for (const child of expr.any) modules.push(`${name}(root, parents) if { ${emit(child, row)}(root, parents) }`);
    } else if ("every" in expr || "some" in expr) {
      const quantifier = "every" in expr ? expr.every : expr.some;
      if ((!row || quantifier.fromInput) && !pointer.safeParse(quantifier.path).success) throw new Error("policy.predicate_path_invalid");
      const child = emit(quantifier.where, true);
      const lookup = `values := object.get(${quantifier.fromInput ? "input" : "root"}, ${JSON.stringify(pathParts(quantifier.path))}, null); is_array(values)`;
      modules.push("every" in expr
        ? `${name}(root, parents) if { ${lookup}; ${expr.every.allowEmpty ? "true" : "count(values) > 0"}; every item in values { ${child}(item, array.concat([root],parents)) } }`
        : `${name}(root, parents) if { ${lookup}; some item in values; ${child}(item, array.concat([root],parents)) }`);
    } else {
      if (!row && !pointer.safeParse(expr.path).success) throw new Error("policy.predicate_path_invalid");
      const v = expr.path==="" ? "value := root" : `value := object.get(root, ${JSON.stringify(pathParts(expr.path))}, null)`;
      const expected = "valueFromParent" in expr ? "expected" : "valueFrom" in expr ? "expected" : "value" in expr ? JSON.stringify(expr.value) : "null";
      const expectedBinding = "valueFromParent" in expr
        ? `; count(parents)>=${expr.valueFromParent.depth}; expected := ${expr.valueFromParent.path === "" ? `parents[${expr.valueFromParent.depth-1}]` : `object.get(parents[${expr.valueFromParent.depth-1}],${JSON.stringify(pathParts(expr.valueFromParent.path))},null)`}; expected != null`
        : "valueFrom" in expr
        ? `; expected := object.get(input, ${JSON.stringify(pathParts(expr.valueFrom))}, null); expected != null` : "";
      const guard = `${v}; value != null${expectedBinding}`;
      const operations: Record<string, string> = {
        present: guard, missing: `${v}; value == null`, eq: `${guard}; value == ${expected}`,
        ne: `${guard}; value != ${expected}`, in: `${guard}; value in ${expected}`,
        gt: `${guard}; to_number(value) > to_number(${expected})`,
        gte: `${guard}; to_number(value) >= to_number(${expected})`,
        lt: `${guard}; to_number(value) < to_number(${expected})`,
        lte: `${guard}; to_number(value) <= to_number(${expected})`,
        count_gte: `${guard}; is_array(value); count(value) >= ${expected}`,
        age_lte_seconds: `${guard}; observed := time.parse_rfc3339_ns(value); cutoff := time.parse_rfc3339_ns(input.facts.asOf); observed <= cutoff; cutoff-observed <= to_number(${expected})*1000000000`,
        // Strictly later instant (RFC 3339 on both sides): "superseded by a later" comparisons.
        after: `${guard}; is_string(value); is_string(${expected}); time.parse_rfc3339_ns(value) > time.parse_rfc3339_ns(${expected})`,
      };
      if (expr.op === "contains") {
        modules.push(`${name}(root, ${"valueFromParent" in expr ? "parents" : "_"}) if { ${guard}; is_array(value); ${expected} in value }`);
        modules.push(`${name}(root, ${"valueFromParent" in expr ? "parents" : "_"}) if { ${guard}; is_string(value); contains(value, ${expected}) }`);
      } else modules.push(`${name}(root, ${"valueFromParent" in expr ? "parents" : "_"}) if { ${operations[expr.op]} }`);
    }
    return name;
  };
  const gates = Object.entries(policy.gates).sort(([a], [b]) => a.localeCompare(b));
  for (const [gateId, gate] of gates) {
    gate.rules.forEach((rule, index) => modules.push(`matches contains ${index} if { input.gateId == ${JSON.stringify(gateId)}; ${emit(rule.when)}(input, []) }`));
  }
  const diligence = policy.diligence;
  if (diligence) {
    const problems = checkDiligenceCoverage(diligence, policy.policySets);
    if (problems.length) throw new Error(`policy.diligence_coverage_invalid:${problems.join(",")}`);
    for (const overlay of diligence.overlays) {
      const when = predicate.safeParse(overlay.when);
      if (!when.success) throw new Error(`policy.diligence_overlay_condition_invalid:${overlay.id}`);
      modules.push(`diligence_fired contains ${JSON.stringify(overlay.id)} if { input.gateId == ${JSON.stringify(diligence.gateId)}; ${emit(when.data)}(input, []) }`);
    }
    modules.push(DILIGENCE_REGO.trim());
  }
  const gateEntries = [...gates.map(([gateId, gate]) => ({ gateId, inputProfile: gate.inputProfile })),
    ...(diligence ? [{ gateId: diligence.gateId, inputProfile: diligence.inputProfile }] : [])].sort((a, b) => a.gateId.localeCompare(b.gateId));
  // With approvals to enforce, the authored result is named and the approval gate's passes the guard.
  const guarded = Boolean(diligence && requiresApprovals(diligence));
  const authored = guarded ? "authored_result" : "result";
  modules.push("selected := min(matches) if { count(matches) > 0 }");
  modules.push(`${authored} := object.union(data.business.gates[input.gateId].rules[selected].result, {"ruleIds": [data.business.gates[input.gateId].rules[selected].id]}) if { count(matches) > 0 }`);
  modules.push(`${authored} := data.business.gates[input.gateId].otherwise if { count(matches) == 0 }`);
  if (guarded) modules.push(APPROVAL_REGO.trim());
  const rego = modules.join("\n\n") + "\n";
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, value]) => [k, canonical(value)])) : v;
  const data = JSON.stringify(canonical({ business: diligence ? { ...policy, diligenceIndex: diligenceIndex(diligence) } : policy }));
  const files = { [REGOPATH]: rego, "data.json": data };
  const sourceDigest = stableDigest(policy);
  const bundleDigest = stableDigest({ sourceDigest, opaVersion: options.opaVersion, files });
  const manifest = policyBundleSchema.parse({
    apiVersion: "harness.factory/policy-bundle-v1", kind: "PolicyBundle",
    bundleId: `${policy.metadata.id}@${policy.metadata.version}:${bundleDigest.slice(0, 12)}`,
    policyId: policy.metadata.id, policyVersion: policy.metadata.version, sourceDigest, bundleDigest,
    opaVersion: options.opaVersion, decisionContract: "business-v2", regoModules: [{ path: REGOPATH, digest: hash(rego) }], dataDigest: hash(data),
    gates: gateEntries.map(({ gateId, inputProfile }) => ({ gateId, entrypoint: ENTRYPOINT, inputProfile,
      allowedOutcomes: diligence && gateId === diligence.gateId ? ["DECIDED", "UNRESOLVED"] : ["DECIDED", "NEEDS_EVIDENCE", "NEEDS_HUMAN", "NOT_APPLICABLE", "UNRESOLVED"] })),
    ruleIds: [...gates.flatMap(([, g]) => g.rules.map(r => r.id)), ...(diligence?.overlays.map(overlay => overlay.id) ?? [])], testsDigest: stableDigest(policy.gates),
    authority: { source: "POLICY_DB", casePath: "$.policyAuthority", requireSnapshotDigest: true },
  });
  const policySets = policy.policySets.map(raw => materializeDerivedContent(raw, policy.diligence)).map(set => {
    const { status: _status, ...content } = set;
    const body = { apiVersion: "harness.factory/effective-policy-set-v2" as const, ...content,
      gateBindings: Object.fromEntries(gateEntries.map(({ gateId, inputProfile }) => [gateId, { inputProfile, policyId: manifest.policyId, bundleDigest }])) };
    return effectivePolicySetSchema.parse({ ...body, setDigest: stableDigest(body) });
  });
  const releaseBlockers = policy.policySets.filter(s => s.status !== "APPROVED").map(s => ({
    id: s.id, status: "UNRESOLVED" as const, reasonCode: "POLICY_SET_NOT_APPROVED", title: `Approve installation policy set ${s.id}`, owner: policy.metadata.owner,
  }));
  for (const set of policy.policySets.map(raw => materializeDerivedContent(raw, policy.diligence))) if (set.configuration.content !== undefined) {
    const { unresolved } = validateInstallationContent(set.configuration.content, set.scope.jurisdiction);
    releaseBlockers.push(...unresolved.map(field => ({ id: `${set.id}:${field}`, status: "UNRESOLVED" as const,
      reasonCode: "INSTALLATION_CONTENT_UNRESOLVED", title: `Resolve installation policy field ${field}`, owner: policy.metadata.owner })));
  }
  for (const [gateId, gate] of gates) if ([gate.otherwise, ...gate.rules.map(rule=>rule.result)]
    .some(result=>result.reasonCodes.includes("INSTALLATION_POLICY_RULES_REQUIRED"))) {
    releaseBlockers.push({id:`gate:${gateId}`,status:"UNRESOLVED",reasonCode:"INSTALLATION_POLICY_RULES_REQUIRED",
      title:`Author and validate installation gate ${gateId}`,owner:policy.metadata.owner});
  }
  if (options.release === "production" && releaseBlockers.length) throw new Error(`policy.production_blocked:${releaseBlockers.map(b => b.id).join(",")}`);
  return { manifest, files, policySets, source: policy, productionEligible: releaseBlockers.length === 0, releaseBlockers };
}

/**
 * Replace each `DERIVED` installation content field with its value from the diligence block, so the
 * compiled policy set (and every skill projection of it) carries what the block implies.
 */
function materializeDerivedContent<T extends { configuration: Record<string, unknown> }>(set: T, diligence: DiligenceSource | undefined): T {
  const content = set.configuration.content as { fields?: Record<string, { status?: string; owner?: string }> } | undefined;
  const fields = content?.fields;
  if (!fields || !Object.values(fields).some(entry => entry?.status === "DERIVED")) return set;
  const next = structuredClone(set);
  const nextFields = (next.configuration.content as { fields: Record<string, unknown> }).fields;
  for (const [field, entry] of Object.entries(fields)) {
    if (entry?.status !== "DERIVED") continue;
    if (!(DERIVABLE_CONTENT_FIELDS as readonly string[]).includes(field)) throw new Error(`policy.derived_content_unsupported:${field}`);
    if (!diligence) throw new Error(`policy.derived_content_requires_diligence:${field}`);
    const derived = deriveDiligenceContent(diligence, field as DerivableContentField);
    const base = (entry as { base?: { owner: string; basis: string; value: unknown } }).base;
    nextFields[field] = base
      ? { status: "RESOLVED", owner: base.owner, schemaVersion: INSTALLATION_CONTENT_SCHEMA_VERSION,
        basis: `${base.basis} Combined, when it compiled, with what this policy's diligence design derives.`,
        value: combineDiligenceContent(field as DerivableContentField, base.value, derived) }
      : { status: "RESOLVED", owner: entry.owner, schemaVersion: INSTALLATION_CONTENT_SCHEMA_VERSION,
        basis: `Derived from this policy's diligence design when it compiled; it changes with the design.`, value: derived };
  }
  return next;
}

const pools = new Map<string, OpaServerPool>();
/** Low-level engine. Services must establish release authority before retaining/applying a receipt. */
export async function evaluateBusinessPolicy(input: {
  compiled: CompiledBusinessPolicy; basis: BusinessDecisionBasis;
  facts: Record<string, unknown>; observations?: Record<string, unknown>;
  evaluator?: OpaBundleEvaluator; opaPath?: string;
}): Promise<BusinessDecision> {
  const { compiled } = input;
  const basis = businessDecisionBasisSchema.parse(input.basis);
  // Recompute from source: callers cannot swap code/data/sets beneath an approved manifest.
  const verified = compileBusinessPolicy(compiled.source, { opaVersion: compiled.manifest.opaVersion });
  if (stableDigest(verified) !== stableDigest(compiled)) throw new Error("policy.compilation_integrity_mismatch");
  const set = compiled.policySets.find(s => s.setDigest === basis.effectivePolicySetDigest);
  const gate = set?.gateBindings[basis.gateId];
  if (!set || !gate || gate.inputProfile !== basis.inputProfile || gate.bundleDigest !== basis.policyBundleDigest || !set.scope.purposes.includes(basis.purpose)
    || set.scope.jurisdiction !== basis.scope.jurisdiction || set.scope.institution !== basis.scope.institution
    || !set.scope.customerTypes.includes(basis.scope.customerType) || basis.scope.products.some(p => !productCovered(p, set.scope.products, compiled.source.diligence?.productAliases ?? {})))
    throw new Error("policy.decision_authority_mismatch");
  const opaPath = input.opaPath ?? process.env.OPA_PATH ?? process.env.OPA_BIN ?? "opa";
  await verifyOpaVersion(opaPath, compiled.manifest.opaVersion);
  let evaluator = input.evaluator;
  if (!evaluator) {
    let pool = pools.get(opaPath);
    if (!pool) { pool = new OpaServerPool({ binary: opaPath, maxServers: 4 }); pools.set(opaPath, pool); }
    evaluator = pool;
  }
  const opaInput = businessPolicyInput({ basis, configuration: set.configuration,
    facts: z.record(z.string(),z.json()).parse(input.facts), observations: z.record(z.string(),z.json()).parse(input.observations ?? {}) });
  const raw = await evaluator.evaluate({ bundleDigest: compiled.manifest.bundleDigest, files: compiled.files }, ENTRYPOINT, opaInput);
  const result = businessDecisionResultSchema.parse(resolveActionTemplates(raw, opaInput));
  const body = { apiVersion: "harness.factory/business-decision-v2" as const, ...basis,
    inputDigest: stableDigest(opaInput), evaluator: { kind: "OPA" as const, version: compiled.manifest.opaVersion }, result,
    expiresAt: new Date(Date.parse(basis.evaluatedAt) + compiled.source.decisionTtlSeconds * 1000).toISOString() };
  const decisionId = `decision_${stableDigest(body).slice(0, 32)}`;
  return businessDecisionSchema.parse({ ...body, decisionId, receiptDigest: stableDigest({ ...body, decisionId }) });
}

const ZERO = "0".repeat(64);
/**
 * The basis of a simulated decision (what-if, impact runs): no tenant, case, plan or release, so the
 * receipt can never be applied to a case; only the policy set and bundle are real.
 */
export function simulationBasis(compiled: CompiledBusinessPolicy, set: EffectivePolicySet, gateId: string, caseId: string, at: string,
  scope: BusinessDecisionBasis["scope"]): BusinessDecisionBasis {
  const gate = compiled.manifest.gates.find((entry) => entry.gateId === gateId);
  if (!gate?.inputProfile) throw new Error(`policy.simulation_gate_unknown:${gateId}`);
  return { tenantId: "simulation", caseId, planDigest: ZERO, releaseDigest: ZERO, caseSequence: 0, snapshotDigest: ZERO, dependencyDigest: ZERO,
    selectedInputDigest: ZERO, effectivePolicySetDigest: set.setDigest, policyBundleDigest: compiled.manifest.bundleDigest, inputProfile: gate.inputProfile,
    gateId, purpose: set.scope.purposes[0]!, subjectIds: [], proposerPrincipalIds: [], evaluatedAt: at, knowledgeCutoff: at, scope };
}

/**
 * The exact OPA input for a decision. Callers that retain a decision rebuild it with this
 * function, because the case store checks its digest against the receipt.
 */
export function businessPolicyInput(input: { basis: BusinessDecisionBasis; facts: Record<string, unknown>; observations?: Record<string, unknown>; configuration: Record<string, unknown> }) {
  const { basis } = input;
  return { gateId: basis.gateId, inputProfile: basis.inputProfile, facts: input.facts, observations: input.observations ?? {}, subjectIds: basis.subjectIds,
    configuration: input.configuration, scope: basis.scope };
}

/** One pass over the authored template; referenced source values are never interpreted as templates. */
function resolveActionTemplates(value: unknown, input: unknown): unknown {
  if (typeof value === "string" && value.startsWith("$input/")) {
    const parts = value.slice(7).split("/").map(p => p.replaceAll("~1", "/").replaceAll("~0", "~"));
    let current: unknown = input;
    for (const part of parts) {
      if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) throw new Error("policy.action_input_missing");
      current = (current as Record<string, unknown>)[part];
    }
    return structuredClone(current);
  }
  if (Array.isArray(value)) return value.map(v => resolveActionTemplates(v, input));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveActionTemplates(v, input)]));
  return value;
}

export async function closeBusinessPolicyEvaluators(): Promise<void> {
  await Promise.all([...pools.values()].map(p => p.close())); pools.clear();
}
