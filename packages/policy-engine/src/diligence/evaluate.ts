import { diligenceColumn, diligenceLineage, pointerParts, type DiligenceOverlay, type DiligenceSource } from "./schema.js";

/**
 * The reference evaluation of a diligence block: an independent oracle for the compiled OPA
 * interpreter (tests compare the two on a corpus) and the Policy Studio mock's evaluator. The
 * server never applies this result; OPA's is the authority.
 */

type Json = unknown;
type Obj = Record<string, Json>;

export type DiligenceResult = {
  state: "DECIDED" | "UNRESOLVED";
  reasonCodes: string[];
  ruleIds: string[];
  actions: [];
  humanRequirement: null;
  gaps: Array<{ code: string; path: string; subjectId: null }>;
  outputs?: { diligence: {
    level: string; baseLevel: string; partyType: string; products: string[]; requirements: string[];
    contributors: Array<{ kind: "cell" | "floor" | "overlay" | "permission"; id: string; level: string }>;
    /** Each requirement with where it came from: the level (`diligence.level.<LEVEL>`) and the rules that added it. */
    requirementSources: Array<{ requirement: string; from: string[] }>;
    /** Approvals the rules that fired require, by rule id. Enforced at the approval gate; they grant nothing. */
    approvals: Array<{ ruleId: string; role: string; quorum: number; reason: string }>;
    /** The screening types the resolved requirements imply (the block's `screening` map), sorted. */
    screeningTypes: string[];
  } };
};

const isObject = (value: Json): value is Obj => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function get(root: Json, parts: string[]): Json {
  let current = root;
  for (const part of parts) {
    if (Array.isArray(current) && /^(0|[1-9]\d*)$/.test(part)) current = current[Number(part)];
    else if (isObject(current) && Object.hasOwn(current, part)) current = current[part];
    else return null;
    if (current === undefined) return null;
  }
  return current ?? null;
}

/** OPA's equality over JSON values (numbers compare by value, objects by keys). */
function same(a: Json, b: Json): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((item, index) => same(item, b[index]));
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
  }
  return a === b;
}

/** OPA `to_number`: numbers, numeric strings, booleans and null; anything else is undefined. */
function toNumber(value: Json): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null) return 0;
  if (typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return Number(value);
  return undefined;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const instant = (value: Json) => typeof value === "string" && RFC3339.test(value) ? Date.parse(value) : undefined;

/** A business-policy predicate, with the same semantics as the compiled Rego. */
export function predicateMatches(raw: Json, root: Json, parents: Json[], input: Obj): boolean {
  const predicate = isObject(raw) ? raw : {};
  if (Array.isArray(predicate.all)) return predicate.all.every((child) => predicateMatches(child, root, parents, input));
  if (Array.isArray(predicate.any)) return predicate.any.some((child) => predicateMatches(child, root, parents, input));
  for (const quantifier of ["every", "some"] as const) if (isObject(predicate[quantifier])) {
    const body = predicate[quantifier] as Obj;
    const values = get(body.fromInput ? input : root, pointerParts(String(body.path ?? "")));
    if (!Array.isArray(values)) return false;
    const nested = [root, ...parents];
    if (quantifier === "every") return (body.allowEmpty === true || values.length > 0) && values.every((item) => predicateMatches(body.where, item, nested, input));
    return values.some((item) => predicateMatches(body.where, item, nested, input));
  }
  const value = get(root, pointerParts(String(predicate.path ?? "")));
  const op = String(predicate.op ?? "");
  if (op === "missing") return value === null;
  if (value === null) return false;
  if (op === "present") return true;
  let expected: Json;
  if (isObject(predicate.valueFromParent)) {
    const depth = Number(predicate.valueFromParent.depth);
    if (parents.length < depth) return false;
    expected = get(parents[depth - 1], pointerParts(String(predicate.valueFromParent.path ?? "")));
    if (expected === null) return false;
  } else if (typeof predicate.valueFrom === "string") {
    expected = get(input, pointerParts(predicate.valueFrom));
    if (expected === null) return false;
  } else expected = predicate.value ?? null;
  const numbers = () => { const a = toNumber(value), b = toNumber(expected); return a === undefined || b === undefined ? undefined : [a, b] as const; };
  switch (op) {
    case "eq": return same(value, expected);
    case "ne": return !same(value, expected);
    case "in": return Array.isArray(expected) ? expected.some((item) => same(item, value)) : isObject(expected) ? Object.values(expected).some((item) => same(item, value)) : false;
    case "contains": return Array.isArray(value) ? value.some((item) => same(item, expected)) : typeof value === "string" && typeof expected === "string" && value.includes(expected);
    case "gt": { const pair = numbers(); return Boolean(pair && pair[0] > pair[1]); }
    case "gte": { const pair = numbers(); return Boolean(pair && pair[0] >= pair[1]); }
    case "lt": { const pair = numbers(); return Boolean(pair && pair[0] < pair[1]); }
    case "lte": { const pair = numbers(); return Boolean(pair && pair[0] <= pair[1]); }
    case "count_gte": return Array.isArray(value) && typeof expected === "number" && value.length >= expected;
    case "age_lte_seconds": {
      const observed = instant(value), cutoff = instant(get(input, ["facts", "asOf"])), limit = toNumber(expected);
      return observed !== undefined && cutoff !== undefined && limit !== undefined && observed <= cutoff && cutoff - observed <= limit * 1000;
    }
    default: return false;
  }
}

/**
 * Whether an overlay applies to the case: some case product within its products, the case's party
 * type among its party types (an unresolved party type does not narrow it), and the case's
 * jurisdiction among its jurisdictions. Each part it does not name holds.
 */
export function overlayInScope(source: Pick<DiligenceSource, "productAliases">, overlay: Pick<DiligenceOverlay, "appliesTo">,
  scope: { products: string[]; partyType: string | null; jurisdiction: Json }): boolean {
  const to = overlay.appliesTo;
  if (!to) return true;
  if (to.products && !scope.products.some((product) => diligenceLineage(source, product).some((node) => to.products!.includes(node)))) return false;
  if (to.partyTypes && scope.partyType !== null && !to.partyTypes.includes(scope.partyType)) return false;
  if (to.jurisdictions && !to.jurisdictions.some((code) => same(code, scope.jurisdiction))) return false;
  return true;
}

const byId = <T extends { id: string }>(items: T[]) => [...new Map(items.map((item) => [item.id, item])).values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** The level a case's party type, products and risk overlays give, under one policy set's configuration. */
export function evaluateDiligence(source: DiligenceSource, input: Obj): DiligenceResult {
  const configuration = isObject(input.configuration) ? input.configuration : {};
  const scope = isObject(input.scope) ? input.scope : {};
  const legalForm = get(input, pointerParts(source.inputs.legalForm));
  const products = Array.isArray(scope.products) ? scope.products.filter((item): item is string => typeof item === "string") : [];
  const customerType = scope.customerType ?? null;
  const parties = source.partyTypes.filter((party) => party.legalForms.some((form) => same(form, legalForm)));
  const party = parties.length === 1 ? parties[0]! : undefined;
  const mandatory = Array.isArray(configuration.mandatory_overlays) ? configuration.mandatory_overlays : [];
  const enabled = source.overlays.filter((overlay) => (overlay.enabled === true || mandatory.some((entry) => same(entry, overlay.id)))
    && overlayInScope(source, overlay, { products, partyType: party?.id ?? null, jurisdiction: scope.jurisdiction ?? null }));

  const gaps: DiligenceResult["gaps"] = [];
  const gap = (code: string, path: string) => { if (!gaps.some((entry) => entry.code === code && entry.path === path)) gaps.push({ code, path, subjectId: null }); };
  if (legalForm === null) gap("DILIGENCE_INPUT_MISSING", source.inputs.legalForm);
  else if (!party) gap("DILIGENCE_PARTY_TYPE_UNKNOWN", source.inputs.legalForm);
  if (party && party.customerType !== customerType) gap("DILIGENCE_PARTY_TYPE_SCOPE_MISMATCH", "/scope/customerType");
  if (!products.length) gap("DILIGENCE_PRODUCTS_MISSING", "/scope/products");
  for (const product of products) if (diligenceColumn(source, product) === undefined) gap("DILIGENCE_PRODUCT_NOT_IN_MATRIX", `/scope/products/${product}`);
  for (const overlay of enabled) for (const pointer of overlay.requires) if (get(input, pointerParts(pointer)) === null) gap("DILIGENCE_INPUT_MISSING", pointer);
  // Products the customer holds in another role bring that role's requirements; an unlisted role is a gap.
  const related = (Array.isArray(scope.relatedProducts) ? scope.relatedProducts : []).filter((entry): entry is { product: string; role: string } =>
    isObject(entry) && typeof entry.product === "string" && typeof entry.role === "string");
  const roleRequirements = (source.roleRequirements ?? {}) as Record<string, string[] | undefined>;
  for (const entry of related) if (!Array.isArray(roleRequirements[entry.role])) gap("DILIGENCE_ROLE_REQUIREMENTS_MISSING", `/scope/relatedProducts/${entry.product}`);
  if (gaps.length || !party) {
    const sorted = [...gaps].sort((a, b) => { const x = `${a.code}|${a.path}`, y = `${b.code}|${b.path}`; return x < y ? -1 : x > y ? 1 : 0; });
    return { state: "UNRESOLVED", reasonCodes: [...new Set(sorted.map((entry) => entry.code))].sort(), ruleIds: [], actions: [], humanRequirement: null, gaps: sorted };
  }

  const rank = (level: string) => source.levels.indexOf(level);
  const top = source.levels.length - 1;
  const cells = byId(products.map((product) => diligenceColumn(source, product)!).map((column) => ({ id: `diligence.cell.${party.id}.${column}`, rank: rank(source.matrix[party.id]![column]!) })));
  const base = Math.max(...cells.map((cell) => cell.rank));
  const floorValues = isObject(configuration.diligence_floors) ? configuration.diligence_floors : {};
  const floorHits = byId(products.flatMap((product) => [...diligenceLineage(source, product), "*"].flatMap((node) => [`${String(customerType)}:${node}`, `*:${node}`])
    .filter((key) => typeof floorValues[key] === "string" && rank(floorValues[key] as string) >= 0)
    .map((key) => ({ id: `diligence.floor.${key}`, rank: rank(floorValues[key] as string) }))));
  const floored = Math.max(base, ...floorHits.map((hit) => hit.rank));
  const firedRules = byId(enabled.filter((overlay) => predicateMatches(overlay.when, input, [], input)));
  // A rule that does not escalate leaves the level where the floors put it.
  const fired = firedRules.map((overlay) => ({
    id: overlay.id, rank: overlay.effect.escalateTo !== undefined ? rank(overlay.effect.escalateTo)
      : overlay.effect.escalateBy !== undefined ? Math.min(floored + overlay.effect.escalateBy, top) : floored,
  }));
  const before = Math.max(floored, ...fired.map((overlay) => overlay.rank));
  const blocked = source.simplifiedLevel !== undefined && source.levels[before] === source.simplifiedLevel && configuration.simplified_due_diligence_permitted !== true;
  const final = blocked ? before + 1 : before;
  const level = source.levels[final]!;
  const contributors: NonNullable<DiligenceResult["outputs"]>["diligence"]["contributors"] = [
    ...cells.map((cell) => ({ kind: "cell" as const, id: cell.id, level: source.levels[cell.rank]! })),
    ...floorHits.filter((hit) => hit.rank > base).map((hit) => ({ kind: "floor" as const, id: hit.id, level: source.levels[hit.rank]! })),
    ...fired.map((overlay) => ({ kind: "overlay" as const, id: overlay.id, level: source.levels[overlay.rank]! })),
    ...(blocked ? [{ kind: "permission" as const, id: "diligence.permission.sdd", level }] : []),
  ];
  // The level's requirements, then those rules added (rules by id, each in authored order), once each.
  const levelRequirements = source.requirements[level] ?? [];
  // Then the rules' (by id), then the related roles' (sorted): each obligation once.
  const roles = [...new Set(related.map((entry) => entry.role))].sort();
  const added = [...firedRules.flatMap((overlay) => overlay.effect.addRequirements ?? []), ...roles.flatMap((role) => roleRequirements[role] ?? [])];
  const requirements = [...levelRequirements, ...added.filter((requirement, index) => !levelRequirements.includes(requirement) && added.indexOf(requirement) === index)];
  const requirementSources = requirements.map((requirement) => ({ requirement, from: [
    ...(levelRequirements.includes(requirement) ? [`diligence.level.${level}`] : []),
    ...firedRules.filter((overlay) => (overlay.effect.addRequirements ?? []).includes(requirement)).map((overlay) => overlay.id),
    ...roles.filter((role) => (roleRequirements[role] ?? []).includes(requirement)).map((role) => `diligence.role.${role}`),
  ] }));
  const screeningTypes = Object.entries(source.screening ?? {}).filter(([, obligation]) => requirements.includes(obligation!)).map(([type]) => type).sort();
  const approvals = firedRules.flatMap((overlay) => overlay.effect.requireApproval
    ? [{ ruleId: overlay.id, role: overlay.effect.requireApproval.role, quorum: overlay.effect.requireApproval.quorum, reason: overlay.effect.requireApproval.reason }] : []);
  return {
    state: "DECIDED", reasonCodes: [`DILIGENCE_LEVEL_${level}`], ruleIds: contributors.map((entry) => entry.id), actions: [], humanRequirement: null, gaps: [],
    outputs: { diligence: { level, baseLevel: source.levels[base]!, partyType: party.id, products: [...products].sort(), requirements, contributors, requirementSources, approvals, screeningTypes } },
  };
}
