import type { BusinessPolicySource, PolicyPredicate } from "./business-policy.js";
import { applyApprovalGuard } from "./diligence/approvals.js";
import { evaluateDiligence } from "./diligence/evaluate.js";
import { approvalGateOf, requiresApprovals, type DiligenceSource } from "./diligence/schema.js";

/**
 * A browser-safe reference evaluation of a business-policy-v2 gate: the semantics business-policy.ts
 * emits as Rego. Authored gates are first-match over their rules; the diligence gate is the
 * diligence reference evaluation; the approval gate passes its authored result through the approval
 * guard, as the compiled bundle does. Tests hold OPA to it; the studio mock and the impact runner's
 * reference side use it. It decides nothing about a real case.
 */

type Json = unknown;
const parts = (path: string) => path === "" ? [] : path.slice(1).split("/").map((p) => p.replaceAll("~1", "/").replaceAll("~0", "~"));
const get = (value: Json, path: string): Json => parts(path).reduce<Json>((at, key) =>
  at !== null && typeof at === "object" && !Array.isArray(at) && Object.hasOwn(at as object, key) ? (at as Record<string, Json>)[key] : null, value) ?? null;
const same = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);
const num = (v: Json) => typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)) ? Number(v) : null;

/** Whether a predicate holds for `item` (with enclosing `parents`) under the whole `input`. */
export function holds(expr: PolicyPredicate, item: Json, parents: Json[], input: Json): boolean {
  if ("all" in expr) return expr.all.every((child) => holds(child, item, parents, input));
  if ("any" in expr) return expr.any.some((child) => holds(child, item, parents, input));
  if ("every" in expr || "some" in expr) {
    const q = "every" in expr ? expr.every : expr.some;
    const values = get(q.fromInput ? input : item, q.path);
    if (!Array.isArray(values)) return false;
    const scope = [item, ...parents];
    if ("every" in expr) return (expr.every.allowEmpty || values.length > 0) && values.every((v) => holds(q.where, v, scope, input));
    return values.some((v) => holds(q.where, v, scope, input));
  }
  const value = get(item, expr.path);
  if (expr.op === "missing") return value === null;
  if (value === null) return false;
  if (expr.op === "present") return true;
  const leaf = expr as { value?: Json; valueFrom?: string; valueFromParent?: { depth: number; path: string } };
  const parent = leaf.valueFromParent;
  const expected = "value" in leaf ? leaf.value : leaf.valueFrom !== undefined ? get(input, leaf.valueFrom)
    : parent && parents.length >= parent.depth ? get(parents[parent.depth - 1], parent.path) : null;
  if (expected === null) return false;
  switch (expr.op) {
    case "eq": return same(value, expected);
    case "ne": return !same(value, expected);
    case "in": return Array.isArray(expected) && expected.some((e) => same(e, value));
    case "contains": return Array.isArray(value) ? value.some((v) => same(v, expected)) : typeof value === "string" && value.includes(String(expected));
    case "count_gte": return Array.isArray(value) && value.length >= Number(expected);
    case "age_lte_seconds": {
      const observed = Date.parse(String(value)); const cutoff = Date.parse(String(get(input, "/facts/asOf")));
      return observed <= cutoff && cutoff - observed <= Number(expected) * 1000;
    }
    case "after": {
      if (typeof value !== "string" || typeof expected !== "string") return false;
      const a = Date.parse(value), b = Date.parse(expected);
      return !Number.isNaN(a) && !Number.isNaN(b) && a > b;
    }
    default: {
      const a = num(value), b = num(expected);
      if (a === null || b === null) return false;
      return expr.op === "gt" ? a > b : expr.op === "gte" ? a >= b : expr.op === "lt" ? a < b : a <= b;
    }
  }
}

/** An authored gate's result: the first rule whose condition holds (with its id), else the gate's default. */
export function interpretGate(source: Pick<BusinessPolicySource, "gates">, gateId: string, input: Json) {
  const gate = source.gates[gateId];
  if (!gate) throw new Error(`policy.gate_unknown:${gateId}`);
  const index = gate.rules.findIndex((rule) => holds(rule.when, input, [], input));
  return index < 0 ? gate.otherwise : { ...gate.rules[index]!.result, ruleIds: [gate.rules[index]!.id] };
}

/** Any gate of the policy, as the compiled bundle decides it: authored rules, the diligence gate, the approval guard. */
export function referenceGateResult(source: Pick<BusinessPolicySource, "gates" | "diligence">, gateId: string, input: Record<string, unknown>): Record<string, unknown> {
  const diligence = source.diligence as DiligenceSource | undefined;
  if (diligence && gateId === diligence.gateId) return evaluateDiligence(diligence, input) as unknown as Record<string, unknown>;
  const authored = interpretGate(source, gateId, input) as unknown as Record<string, unknown>;
  return diligence && requiresApprovals(diligence) && gateId === approvalGateOf(diligence) ? applyApprovalGuard(authored, input) : authored;
}
