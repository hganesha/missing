import type { DiligenceSource } from "./schema.js";

/**
 * Installation content the library skills read, derived from the diligence block so that the
 * level a case receives and the work it triggers cannot drift apart. Browser-safe.
 *
 * - `edd_triggers`: one trigger per level above the standard level (CDD when SDD exists, else the
 *   lowest). Its predicate is the case's `diligence_level`; its tasks are what that level requires
 *   beyond the standard level. `edd.trigger.evaluate` reads `facts.diligence_level`.
 * - `requirements`: every obligation of the highest level, applicable at exactly the levels that
 *   require it. `decision.requirements.compile` reads `facts.diligence_level`; an unknown level
 *   leaves every requirement UNKNOWN, never not applicable.
 */
export const DERIVABLE_CONTENT_FIELDS = ["edd_triggers", "requirements"] as const;
export type DerivableContentField = (typeof DERIVABLE_CONTENT_FIELDS)[number];
export const DILIGENCE_LEVEL_FACT = "diligence_level";
/** The gate's resolved requirements (`outputs.diligence.requirements`): the level's and those its rules added. */
export const DILIGENCE_REQUIREMENTS_FACT = "diligence_requirements";

export function standardLevel(source: Pick<DiligenceSource, "levels" | "simplifiedLevel">): string {
  return source.simplifiedLevel !== undefined ? source.levels[1] ?? source.levels[0]! : source.levels[0]!;
}

/**
 * Requirement-driven planning (Product Policy Studio phase G): the skills plan work from what the
 * diligence decision resolved, not from the level alone.
 * - `requirements`: every obligation any level or rule can bring, applicable exactly when the
 *   decision lists it (`diligence_requirements` contains it). Without the decision every
 *   requirement is UNKNOWN, never not applicable. Obligations a party role brings are included.
 * - `edd_triggers`: one per level above the standard level, and one per rule that adds obligations
 *   beyond the standard level, firing when the decision lists any of them.
 */
export function deriveDiligenceContent(source: DiligenceSource, field: DerivableContentField): unknown {
  const standard = standardLevel(source);
  const base = source.requirements[standard] ?? [];
  const rules = source.overlays.filter((overlay) => overlay.effect.addRequirements?.length);
  if (field === "edd_triggers") {
    const levels = source.levels.slice(source.levels.indexOf(standard) + 1).map((level) => ({
      id: `diligence-level-${level.toLowerCase()}`,
      predicate: { field: DILIGENCE_LEVEL_FACT, op: "eq", value: level },
      tasks: (source.requirements[level] ?? []).filter((obligation) => !base.includes(obligation)),
    }));
    const added = rules.flatMap((overlay) => {
      const tasks = overlay.effect.addRequirements!.filter((obligation) => !base.includes(obligation));
      return tasks.length ? [{
        id: `diligence-rule-${overlay.id.replace(/^overlay\./, "").replace(/[^a-z0-9-]+/g, "-")}`,
        predicate: tasks.length === 1 ? { field: DILIGENCE_REQUIREMENTS_FACT, op: "contains", value: tasks[0] }
          : { any: tasks.map((obligation) => ({ field: DILIGENCE_REQUIREMENTS_FACT, op: "contains", value: obligation })) },
        tasks,
      }] : [];
    });
    return [...levels, ...added];
  }
  const top = source.requirements[source.levels.at(-1)!] ?? [];
  const roles = Object.entries(source.roleRequirements ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const obligations = [...top, ...rules.flatMap((overlay) => overlay.effect.addRequirements!), ...roles.flatMap(([, list]) => list ?? [])]
    .filter((obligation, index, all) => all.indexOf(obligation) === index);
  return obligations.map((obligation) => {
    const levels = source.levels.filter((level) => (source.requirements[level] ?? []).includes(obligation));
    const by = rules.filter((overlay) => overlay.effect.addRequirements!.includes(obligation)).map((overlay) => overlay.label);
    const as = roles.filter(([, list]) => (list ?? []).includes(obligation)).map(([role]) => role.toLowerCase().replaceAll("_", " "));
    const why = [levels.length ? `at ${levels.join(", ")} due diligence` : null, by.length ? `when ${by.join(" or ")} adds it` : null,
      as.length ? `when the customer holds a product as ${as.join(" or ")}` : null].filter(Boolean).join(", and ");
    return { id: obligation, description: `Required ${why}.`, when: { field: DILIGENCE_REQUIREMENTS_FACT, op: "contains", value: obligation } };
  });
}

type Entry = { id: string; when?: unknown; [key: string]: unknown };
/**
 * Derived content combined with base content (e.g. SYNTHETIC placeholders): every base entry stays.
 * - `edd_triggers`: the base triggers, then the derived ones whose ids the base lacks.
 * - `requirements`: a requirement both name keeps the base entry (its control) and applies when the
 *   base says so or the decision lists it; a base entry with no `when` always applies. Requirements
 *   only the derivation names follow it.
 */
export function combineDiligenceContent(field: DerivableContentField, base: unknown, derived: unknown): unknown {
  const baseEntries = (Array.isArray(base) ? base : []) as Entry[];
  const derivedEntries = (Array.isArray(derived) ? derived : []) as Entry[];
  const ids = new Set(baseEntries.map((entry) => entry.id));
  if (field === "edd_triggers") return [...baseEntries, ...derivedEntries.filter((entry) => !ids.has(entry.id))];
  const byId = new Map(derivedEntries.map((entry) => [entry.id, entry]));
  return [
    ...baseEntries.map((entry) => {
      const derivedEntry = byId.get(entry.id);
      if (!derivedEntry || entry.when === undefined) return entry;
      return { ...entry, when: { any: [entry.when, derivedEntry.when] } };
    }),
    ...derivedEntries.filter((entry) => !ids.has(entry.id)),
  ];
}

// ---- monitoring ---------------------------------------------------------------------------

type Receipt = {
  gateId?: unknown; evaluatedAt?: unknown; effectivePolicySetDigest?: unknown; policyBundleDigest?: unknown;
  scope?: { jurisdiction?: unknown; customerType?: unknown };
  result?: { state?: unknown; reasonCodes?: unknown; outputs?: { diligence?: {
    level?: unknown; baseLevel?: unknown; partyType?: unknown; products?: unknown;
    contributors?: Array<{ kind?: unknown; id?: unknown; level?: unknown }>;
  } } };
};

export type DiligenceMonitoring = {
  total: number;
  decided: number;
  unresolved: number;
  byLevel: Record<string, number>;
  /** Decisions per party type and product, with the level each ended at. */
  cells: Array<{ partyType: string; product: string; total: number; byLevel: Record<string, number> }>;
  /** How often each overlay fired, and how often it changed the outcome. */
  overlays: Array<{ id: string; fired: number; decisive: number }>;
  escalated: number;
  floorRaised: number;
  permissionRaised: number;
  unresolvedReasons: Record<string, number>;
  byJurisdiction: Record<string, number>;
  first: string | null;
  last: string | null;
};

const text = (value: unknown) => typeof value === "string" ? value : null;
const bump = (map: Record<string, number>, key: string) => { map[key] = (map[key] ?? 0) + 1; };

/** Aggregate stored diligence decisions; every count comes from a receipt. */
export function summarizeDiligenceDecisions(receipts: unknown[], levels: string[] = []): DiligenceMonitoring {
  const summary: DiligenceMonitoring = { total: 0, decided: 0, unresolved: 0, byLevel: {}, cells: [], overlays: [], escalated: 0, floorRaised: 0,
    permissionRaised: 0, unresolvedReasons: {}, byJurisdiction: {}, first: null, last: null };
  const cells = new Map<string, DiligenceMonitoring["cells"][number]>();
  const overlays = new Map<string, { id: string; fired: number; decisive: number }>();
  const rank = (level: string | null) => level === null ? -1 : levels.indexOf(level);
  for (const raw of receipts) {
    const receipt = (raw ?? {}) as Receipt;
    summary.total++;
    const at = text(receipt.evaluatedAt);
    if (at && (!summary.first || at < summary.first)) summary.first = at;
    if (at && (!summary.last || at > summary.last)) summary.last = at;
    bump(summary.byJurisdiction, text(receipt.scope?.jurisdiction) ?? "unknown");
    const outcome = receipt.result?.outputs?.diligence;
    if (receipt.result?.state !== "DECIDED" || !outcome) {
      summary.unresolved++;
      for (const code of Array.isArray(receipt.result?.reasonCodes) ? receipt.result.reasonCodes : ["UNKNOWN"]) bump(summary.unresolvedReasons, String(code));
      continue;
    }
    summary.decided++;
    const level = text(outcome.level) ?? "unknown", base = text(outcome.baseLevel);
    bump(summary.byLevel, level);
    if (base && level !== base) summary.escalated++;
    const contributors = Array.isArray(outcome.contributors) ? outcome.contributors : [];
    if (contributors.some((entry) => entry.kind === "floor")) summary.floorRaised++;
    if (contributors.some((entry) => entry.kind === "permission")) summary.permissionRaised++;
    const before = Math.max(-1, ...contributors.filter((entry) => entry.kind === "cell" || entry.kind === "floor").map((entry) => rank(text(entry.level))));
    for (const entry of contributors) if (entry.kind === "overlay" && typeof entry.id === "string") {
      const row = overlays.get(entry.id) ?? { id: entry.id, fired: 0, decisive: 0 };
      row.fired++;
      if (levels.length && rank(text(entry.level)) > before && text(entry.level) === level) row.decisive++;
      overlays.set(entry.id, row);
    }
    const party = text(outcome.partyType) ?? "unknown";
    for (const product of Array.isArray(outcome.products) ? outcome.products.filter((item): item is string => typeof item === "string") : []) {
      const key = `${party}|${product}`;
      const row = cells.get(key) ?? { partyType: party, product, total: 0, byLevel: {} };
      row.total++;
      bump(row.byLevel, level);
      cells.set(key, row);
    }
  }
  summary.cells = [...cells.values()].sort((a, b) => a.partyType.localeCompare(b.partyType) || a.product.localeCompare(b.product));
  summary.overlays = [...overlays.values()].sort((a, b) => b.fired - a.fired || a.id.localeCompare(b.id));
  return summary;
}
