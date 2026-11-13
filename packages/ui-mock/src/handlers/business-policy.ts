import { applyApprovalGuard, approvalGateOf, checkDiligenceCoverage, diligenceSourceSchema, evaluateDiligence, requiresApprovals, summarizeDiligenceDecisions, type DiligenceSource } from "@ehf/policy-engine/diligence";
import { parse } from "yaml";
import kycAgenticPolicy from "../../../../domains/kyc-agentic/policy.yaml?raw";
import kybAgenticPolicy from "../../../../domains/kyb-agentic/policy.yaml?raw";
import securitiesAgenticPolicy from "../../../../domains/securities-agentic/policy.yaml?raw";
import type { Rec } from "../fixtures.js";

/**
 * The installation policies the control API serves for the agentic templates, and a contract
 * mock of their business-v2 compilation and evaluation. The mock reads the same source files;
 * its evaluation is a small stand-in for OPA (http mode evaluates with the real engine). The
 * diligence gate uses the engine's own reference evaluation, which tests hold equal to OPA's.
 */
export const BUSINESS_TEMPLATES: Record<string, Record<string, string>> = {
  "kyc-agentic": { "policy.yaml": kycAgenticPolicy },
  "kyb-agentic": { "policy.yaml": kybAgenticPolicy },
  "securities-agentic": { "policy.yaml": securitiesAgenticPolicy },
};

const DIGEST = (seed: string) => seed.repeat(64).slice(0, 64);
const STATES = ["DECIDED", "NEEDS_EVIDENCE", "NEEDS_HUMAN", "NOT_APPLICABLE", "UNRESOLVED"];

export function businessSource(files: Rec | undefined): Rec | null {
  try {
    const raw = parse(String(files?.["policy.yaml"] ?? "")) as Rec | null;
    return raw?.kind === "BusinessPolicy" ? raw : null;
  } catch {
    return null;
  }
}

export function businessCompilation(source: Rec): Rec {
  const metadata = source.metadata as Rec;
  const diligence = source.diligence as Rec | undefined;
  const gates = Object.entries({ ...(source.gates as Rec), ...(diligence ? { [String(diligence.gateId ?? "diligence-level")]: { inputProfile: diligence.inputProfile, rules: [], otherwise: null, diligence: true } } : {}) })
    .sort(([a], [b]) => a.localeCompare(b));
  const bundleDigest = DIGEST("7");
  const sets = (source.policySets as Rec[]).map((set, index) => {
    const { status: _status, ...rest } = set;
    return {
      apiVersion: "harness.factory/effective-policy-set-v2", ...rest,
      gateBindings: Object.fromEntries(gates.map(([gateId, gate]) => [gateId, { inputProfile: (gate as Rec).inputProfile, policyId: metadata.id, bundleDigest }])),
      setDigest: DIGEST(String.fromCharCode(97 + (index % 6))),
    };
  });
  const blockers: Rec[] = (source.policySets as Rec[]).filter((set) => set.status !== "APPROVED").map((set) => ({
    id: set.id, status: "UNRESOLVED", reasonCode: "POLICY_SET_NOT_APPROVED", title: `Approve installation policy set ${String(set.id)}`, owner: metadata.owner,
  }));
  for (const set of source.policySets as Rec[]) {
    const content = (set.configuration as Rec).content as Rec | undefined;
    if (!content) continue;
    const fields = content.fields as Rec;
    for (const field of content.requiredFields as string[]) if ((fields[field] as Rec | undefined)?.status !== "RESOLVED") {
      blockers.push({ id: `${String(set.id)}:${field}`, status: "UNRESOLVED", reasonCode: "INSTALLATION_CONTENT_UNRESOLVED", title: `Resolve installation policy field ${field}`, owner: metadata.owner });
    }
  }
  for (const [gateId, gate] of gates) {
    if ((gate as Rec).diligence) continue;
    const results = [(gate as Rec).otherwise as Rec, ...((gate as Rec).rules as Rec[]).map((rule) => rule.result as Rec)];
    if (results.some((result) => (result.reasonCodes as string[]).includes("INSTALLATION_POLICY_RULES_REQUIRED"))) {
      blockers.push({ id: `gate:${gateId}`, status: "UNRESOLVED", reasonCode: "INSTALLATION_POLICY_RULES_REQUIRED", title: `Author and validate installation gate ${gateId}`, owner: metadata.owner });
    }
  }
  return {
    files: { "harness/business/policy.rego": "package harness.business\n", "data.json": "{}" },
    manifest: {
      apiVersion: "harness.factory/policy-bundle-v1", kind: "PolicyBundle",
      bundleId: `${String(metadata.id)}@${String(metadata.version)}:${bundleDigest.slice(0, 12)}`,
      policyId: metadata.id, policyVersion: metadata.version, sourceDigest: DIGEST("8"), bundleDigest,
      opaVersion: "1.9.0", decisionContract: "business-v2", regoModules: [{ path: "harness/business/policy.rego", digest: DIGEST("9") }], dataDigest: DIGEST("5"),
      gates: gates.map(([gateId, gate]) => ({ gateId, entrypoint: "data.harness.business.result", inputProfile: (gate as Rec).inputProfile, allowedOutcomes: (gate as Rec).diligence ? ["DECIDED", "UNRESOLVED"] : STATES })),
      ruleIds: gates.flatMap(([, gate]) => ((gate as Rec).rules as Rec[]).map((rule) => rule.id)), testsDigest: DIGEST("3"),
      authority: { source: "POLICY_DB", casePath: "$.policyAuthority", requireSnapshotDigest: true },
    },
    policySets: sets,
    productionEligible: blockers.length === 0,
    releaseBlockers: blockers,
  };
}

function lookup(root: unknown, path: string): unknown {
  if (path === "") return root;
  let current = root;
  for (const part of path.slice(1).split("/").map((value) => value.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, part)) return null;
    current = (current as Rec)[part];
  }
  return current ?? null;
}

/** Equality, membership and presence only; anything else does not match in the mock. */
function matches(predicate: Rec, input: Rec): boolean {
  if (Array.isArray(predicate.all)) return predicate.all.every((child) => matches(child as Rec, input));
  if (Array.isArray(predicate.any)) return predicate.any.some((child) => matches(child as Rec, input));
  const value = lookup(input, String(predicate.path ?? ""));
  const expected = predicate.valueFrom !== undefined ? lookup(input, String(predicate.valueFrom)) : predicate.value;
  switch (predicate.op) {
    case "present": return value !== null;
    case "missing": return value === null;
    case "eq": return value !== null && JSON.stringify(value) === JSON.stringify(expected);
    case "ne": return value !== null && JSON.stringify(value) !== JSON.stringify(expected);
    case "in": return value !== null && Array.isArray(expected) && expected.some((item) => JSON.stringify(item) === JSON.stringify(value));
    case "contains": return Array.isArray(value) && value.some((item) => JSON.stringify(item) === JSON.stringify(expected));
    default: return false;
  }
}

export function businessDecision(source: Rec, body: Rec, counter: number): Rec | null {
  const basis = body.basis as Rec | undefined;
  const diligence = source.diligence as Rec | undefined;
  const isDiligence = Boolean(diligence) && basis?.gateId === (diligence?.gateId ?? "diligence-level");
  const gate = (source.gates as Rec)[String(basis?.gateId ?? "")] as Rec | undefined;
  const compiled = businessCompilation(source);
  const set = (compiled.policySets as Rec[]).find((entry) => entry.setDigest === basis?.effectivePolicySetDigest);
  if (!basis || (!gate && !isDiligence) || !set) return null;
  const input = { gateId: basis.gateId, inputProfile: basis.inputProfile, facts: body.facts ?? {}, observations: body.observations ?? {}, subjectIds: basis.subjectIds ?? [],
    configuration: set.configuration, scope: basis.scope };
  let result: Rec;
  if (isDiligence) result = evaluateDiligence({ gateId: "diligence-level", ...diligence } as DiligenceSource, input as Rec);
  else {
    const index = (gate!.rules as Rec[]).findIndex((rule) => matches(rule.when as Rec, input));
    const rule = index >= 0 ? (gate!.rules as Rec[])[index]! : null;
    result = rule ? { ...(rule.result as Rec), ruleIds: [rule.id] } : gate!.otherwise as Rec;
    // Like the compiled bundle: approvals rules require hold the approval gate for people.
    const block = diligence as unknown as DiligenceSource | undefined;
    if (block && requiresApprovals(block) && basis.gateId === approvalGateOf(block)) result = applyApprovalGuard(result, input as Rec) as Rec;
  }
  const expires = new Date(Date.parse(String(basis.evaluatedAt)) + Number(source.decisionTtlSeconds ?? 60) * 1000).toISOString();
  return {
    apiVersion: "harness.factory/business-decision-v2", ...basis,
    inputDigest: DIGEST("2"), evaluator: { kind: "OPA", version: "1.9.0" }, result, expiresAt: expires,
    decisionId: `decision_mock_${counter}`, receiptDigest: DIGEST("1"),
  };
}

/** The engine's own diligence checks, so the mock refuses what the server would. */
export function diligenceRefusal(source: Rec): string | null {
  if (source.diligence === undefined) return null;
  const parsed = diligenceSourceSchema.safeParse(source.diligence);
  if (!parsed.success) return parsed.error.issues.map((issue) => issue.message).join("; ");
  const problems = checkDiligenceCoverage(parsed.data, source.policySets as Parameters<typeof checkDiligenceCoverage>[1]);
  return problems.length ? `policy.diligence_coverage_invalid:${problems.join(",")}` : null;
}

/**
 * Synthetic monitoring: a fixed set of cases evaluated against both agentic policies' diligence
 * designs with the engine's reference evaluation, then summarised as case-api would. Never real data.
 */
export function diligenceMonitoring(query: URLSearchParams): Rec {
  const gateId = query.get("gateId") ?? "diligence-level";
  const levels = (query.get("levels") ?? "SDD,CDD,EDD").split(",").filter(Boolean);
  const receipts: Rec[] = [];
  const records = (list: string, data: Rec[]) => ({ [list]: data.map((entry, index) => ({ object_id: `${list}-${index}`, data: entry })) });
  const scenarios: Array<{ legalForm: string; products: string[]; jurisdiction: string; selected: Rec }> = [];
  const base = { policyRecordPEPRelationship: [], policyCaseFindings: [], policyRecordGeographyExposure: [], packOwnership: [], policyRecordAdverseMediaEvent: [], policyRecordRiskFactor: [] };
  const people = ["individual", "individual", "individual", "individual", "individual", "individual"];
  people.forEach((legalForm, index) => scenarios.push({ legalForm, jurisdiction: index % 3 ? "US" : "GB", products: index % 2 ? ["deposit"] : ["card", "payments"],
    selected: { ...base, ...(index === 4 ? records("policyRecordPEPRelationship", [{ verified: true }]) : {}), ...(index === 5 ? records("policyRecordGeographyExposure", [{ country: "IR" }]) : {}) } }));
  [["corporation", ["deposit"]], ["corporation", ["deposit", "payments"]], ["llc", ["lending"]], ["ordinary_trust", ["payments"]], ["charity", ["payments"]],
    ["general_partnership", ["merchant_acquiring"]], ["corporation", ["deposit"]], ["unknown", ["deposit"]]].forEach(([legalForm, products], index) => scenarios.push({
    legalForm: legalForm as string, products: products as string[], jurisdiction: index % 2 ? "GB" : "US",
    selected: { ...base, ...(index === 1 ? records("policyRecordPEPRelationship", [{ verified: true }]) : {}), ...(index === 6 ? { packOwnership: [{}, {}, {}] } : {}) } }));
  const customerTypes = (query.get("customerTypes") ?? "individual,corporate").split(",");
  scenarios.forEach((scenario, index) => {
    const corporate = scenario.legalForm !== "individual";
    if (!customerTypes.includes(corporate ? "corporate" : "individual")) return;
    const source = businessSource(BUSINESS_TEMPLATES[corporate ? "kyb-agentic" : "kyc-agentic"])!;
    const set = (source.policySets as Rec[]).find((entry) => (entry.scope as Rec).jurisdiction === scenario.jurisdiction)!;
    const evaluatedAt = new Date(Date.UTC(2026, 10, 1 + index)).toISOString();
    const scope = { jurisdiction: scenario.jurisdiction, institution: "bank.synthetic", products: scenario.products, customerType: corporate ? "corporate" : "individual", legalForm: scenario.legalForm };
    const result = evaluateDiligence({ gateId, ...(source.diligence as Rec) } as DiligenceSource,
      { gateId, facts: { asOf: evaluatedAt, selected: scenario.selected }, observations: {}, subjectIds: [], configuration: set.configuration as Rec, scope });
    receipts.push({ gateId, evaluatedAt, scope, result });
  });
  return { gateId, generatedAt: "2026-11-15T00:00:00.000Z", limited: false, levels, summary: summarizeDiligenceDecisions(receipts, levels) };
}
