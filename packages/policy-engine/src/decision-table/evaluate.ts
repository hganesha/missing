import { resolveOwnerInput, type PolicyCatalog } from "./catalog.js";
import type { Condition, DecisionRow, DecisionTable, Extractor, PolicyOutcome } from "./schema.js";
import type { AggregateProviderResult, CaseAggregate } from "./aggregate.js";

/**
 * The reference evaluator for the KYC decision tables.
 *
 * This is not the production policy engine. Production compiles the same tables to Rego and
 * runs them on a pinned OPA; what lives here is the readable statement of what those tables
 * mean, used to adjudicate the golden corpus and to hold the compiled bundle to account.
 * Two independent implementations agreeing on 300+ cases is the evidence that the
 * compilation preserved the policy.
 *
 * Three properties it maintains deliberately:
 *
 *  - Total. Every condition resolves to a token, including UNKNOWN. There is no path where
 *    a missing field throws and the caller has to decide what that meant.
 *  - Fail-closed. UNKNOWN never satisfies anything. The tables route it to a human, and the
 *    evaluator has no way to express "absent, so presumably fine".
 *  - Order-independent in its inputs, order-dependent in its rows. Reordering evidence or
 *    findings on a case cannot change the outcome; reordering table rows can, which is why
 *    the row order is authored and reviewed rather than derived.
 */

export const UNKNOWN_TOKEN = "UNKNOWN";

export interface GateEvaluation {
  gateId: string;
  tableId: string;
  policyId: string;
  policyVersion: string;
  policyBundleDigest: string;
  caseSequence: number;
  cohortId: string | null;
  outcome: PolicyOutcome;
  reasonCode: string;
  matchedRowId: string | null;
  /** Every rule the matched row discharges, recorded so the evaluation replays. */
  ruleIds: string[];
  transitionTo: string | null;
  disposition: "APPROVED" | null;
  escalation: { queue: string; dualControl: boolean } | null;
  routeTo: string | null;
  /** Every condition's resolved token, not only the ones the matched row looked at. */
  conditionValues: Record<string, string>;
  evaluatedAt: string;
}

export function evaluateGate(
  gateId: string,
  snapshot: CaseAggregate,
  catalog: PolicyCatalog,
): GateEvaluation {
  const tableId = catalog.gateTables.get(gateId);
  if (!tableId) throw new Error(`Unknown gate: ${gateId}`);
  const table = catalog.tables.get(tableId)!;
  return evaluateTable(table, snapshot, catalog);
}

export function evaluateTable(
  table: DecisionTable,
  snapshot: CaseAggregate,
  catalog: PolicyCatalog,
): GateEvaluation {
  const cohortId = assignRiskCohort(snapshot, catalog);
  const conditionValues: Record<string, string> = {};
  for (const condition of table.spec.conditions) {
    conditionValues[condition.id] = resolveCondition(condition, snapshot, catalog, cohortId);
  }

  const matched = table.spec.rows.find((row) => rowMatches(row, conditionValues));
  const decision = matched ?? table.spec.default;
  const reasonCode = catalog.reasonCodes.get(decision.reasonCode);

  return {
    gateId: table.metadata.gate,
    tableId: table.metadata.id,
    policyId: catalog.policy.metadata.id,
    policyVersion: catalog.policy.metadata.version,
    policyBundleDigest: catalog.bundleDigest,
    caseSequence: snapshot.caseSequence,
    cohortId,
    outcome: decision.outcome,
    reasonCode: decision.reasonCode,
    matchedRowId: matched?.id ?? null,
    ruleIds: decision.rules,
    transitionTo: matched?.transitionTo ?? null,
    disposition: matched?.disposition ?? null,
    escalation: matched?.escalation ?? null,
    routeTo: reasonCode?.routeTo ?? null,
    conditionValues,
    evaluatedAt: snapshot.evaluatedAt,
  };
}

function rowMatches(row: DecisionRow, values: Record<string, string>): boolean {
  return Object.entries(row.when).every(([conditionId, expected]) => {
    const actual = values[conditionId];
    if (actual === undefined) return false;
    return Array.isArray(expected) ? expected.includes(actual) : expected === actual;
  });
}

// ------------------------------------------------------------------ cohort assignment

/**
 * Recompute the cohort from case attributes rather than trusting a label written onto the
 * case. A cohort decides whether automatic approval is even in scope, so a cohort an agent
 * could set would be a cohort an agent could choose for itself.
 */
export function assignRiskCohort(snapshot: CaseAggregate, catalog: PolicyCatalog): string | null {
  const attributes: Record<string, unknown> = {};
  for (const [attribute, path] of Object.entries(catalog.cohortAttributePaths)) {
    attributes[attribute] = readPath(snapshot as unknown as Record<string, unknown>, path) ?? null;
  }
  for (const attribute of catalog.cohortRequiredAttributes) {
    if (attributes[attribute] === null || attributes[attribute] === undefined) return null;
  }

  for (const cohortId of catalog.cohortPrecedence) {
    const cohort = catalog.riskCohorts.get(cohortId);
    if (!cohort) continue;
    const matches = Object.entries(cohort.selector).every(([key, expected]) => {
      const actual = attributes[key];
      if (Array.isArray(expected)) return typeof actual === "string" && expected.includes(actual);
      return actual === expected;
    });
    if (matches) return cohortId;
  }
  return null;
}

// ------------------------------------------------------------------ condition extraction

function resolveCondition(
  condition: Condition,
  snapshot: CaseAggregate,
  catalog: PolicyCatalog,
  cohortId: string | null,
): string {
  const token = extract(condition.extractor, snapshot, catalog, cohortId);
  // A token an extractor produced but the condition never declared would silently match no
  // row and land on the default. Treat it as undetermined, which at least routes to a human.
  return condition.tokens.includes(token) ? token : UNKNOWN_TOKEN;
}

function extract(
  extractor: Extractor,
  snapshot: CaseAggregate,
  catalog: PolicyCatalog,
  cohortId: string | null,
): string {
  switch (extractor.kind) {
    case "evaluationStatus":
      return snapshot.evaluationError === null ? "OK" : "ERROR";

    case "snapshotFreshness": {
      if (snapshot.currentSequence === null) return UNKNOWN_TOKEN;
      return snapshot.currentSequence > snapshot.caseSequence ? "STALE" : "CURRENT";
    }

    case "riskCohort":
      return cohortId === null ? UNKNOWN_TOKEN : "RESOLVED";

    case "cohortEligibility": {
      if (cohortId === null) return UNKNOWN_TOKEN;
      const cohort = catalog.riskCohorts.get(cohortId);
      if (!cohort) return UNKNOWN_TOKEN;
      return cohort.automaticApprovalEligible ? "ELIGIBLE" : "NOT_ELIGIBLE";
    }

    case "attestationStatus": {
      if (cohortId === null) return UNKNOWN_TOKEN;
      const cohort = catalog.riskCohorts.get(cohortId);
      if (!cohort) return UNKNOWN_TOKEN;
      // A cohort that needs no attestation cannot be approved automatically anyway; saying
      // VALID here keeps the attestation row from masking the eligibility row's reason.
      if (!cohort.requiresAttestation) return "VALID";
      const attestation = snapshot.attestation;
      if (attestation === null) return "MISSING";
      if (attestation.cohortId !== cohortId) return "MISSING";
      if (attestation.status === "EXPIRED") return "EXPIRED";
      if (attestation.status === "REVOKED") return "MISSING";
      if (attestation.expiresAt !== null && isBefore(attestation.expiresAt, snapshot.evaluatedAt)) return "EXPIRED";
      return "VALID";
    }

    case "recommendationCitations": {
      const recommendation = snapshot.recommendation;
      if (recommendation === null) return UNKNOWN_TOKEN;
      const hasPolicy = recommendation.policyRuleRefs.length > 0;
      const hasEvidence = recommendation.evidenceRefs.length > 0;
      // A decline must additionally say which finding it rests on; an approval need not,
      // because there may be nothing adverse to cite.
      const hasFinding = recommendation.outcome !== "DECLINE" || recommendation.findingRefs.length > 0;
      return hasPolicy && hasEvidence && hasFinding ? "COMPLETE" : "INCOMPLETE";
    }

    case "presence": {
      const items = collectionOf(snapshot, extractor.collection);
      const present = items.some((item) => matchesWhere(item, extractor.where));
      return present ? extractor.presentToken : extractor.absentToken;
    }

    case "itemStatus": {
      const items = collectionOf(snapshot, extractor.collection).filter((item) =>
        matchesWhere(item, extractor.where),
      );
      if (items.length === 0) return extractor.absent;
      const statuses = items.map((item) => String(readPath(item, extractor.statusPath) ?? ""));
      // Any item still satisfying the mapped status is enough; a second, cancelled attempt
      // at the same work does not undo a completed one.
      for (const status of statuses) {
        const mapped = extractor.map[status];
        if (mapped !== undefined) return mapped;
      }
      return extractor.otherwise;
    }

    case "strongestFinding": {
      const findings = snapshot.findings.filter((finding) => !extractor.openOnly || finding.status === "OPEN");
      for (const rank of extractor.ranking) {
        if (findings.some((finding) => finding.findingType === rank.findingType)) return rank.token;
      }
      return extractor.absentToken;
    }

    case "digestMatch": {
      const claim = snapshot.claims.find((item) => matchesWhere(item, extractor.left.where));
      if (!claim) return UNKNOWN_TOKEN;
      const left = readPath(claim as unknown as Record<string, unknown>, extractor.left.valuePath);
      const right = readPath(snapshot as unknown as Record<string, unknown>, extractor.right.path);
      if (typeof left !== "string" || typeof right !== "string" || left === "" || right === "") return UNKNOWN_TOKEN;
      return normalizeDigest(left) === normalizeDigest(right) ? "MATCH" : "MISMATCH";
    }

    case "attributesComplete": {
      const container = readPath(snapshot as unknown as Record<string, unknown>, extractor.path);
      if (container === null || container === undefined || typeof container !== "object") return UNKNOWN_TOKEN;
      const record = container as Record<string, unknown>;
      const complete = extractor.required.every((field) => {
        const value = record[field];
        return value !== null && value !== undefined && value !== "";
      });
      return complete ? "COMPLETE" : "INCOMPLETE";
    }

    case "obligationFreshness": {
      const obligation = catalog.obligations.get(extractor.obligation);
      if (!obligation) return UNKNOWN_TOKEN;
      const matching = snapshot.evidence.filter((item) => item.purpose === obligation.purpose);
      if (matching.length === 0) return UNKNOWN_TOKEN;
      if (obligation.freshnessDays === null) return "FRESH";
      const fresh = matching.some((item) => withinDays(item.recordedAt, snapshot.evaluatedAt, obligation.freshnessDays!));
      return fresh ? "FRESH" : "STALE";
    }

    case "obligationsSatisfied": {
      if (cohortId === null) return UNKNOWN_TOKEN;
      const excluded = new Set(extractor.exclude);
      const required = (extractor.obligations
        ? extractor.obligations.map((obligationId) => catalog.obligations.get(obligationId))
        : [...catalog.obligations.values()]
      )
        .filter((obligation): obligation is NonNullable<typeof obligation> => obligation !== undefined)
        .filter((obligation) => !excluded.has(obligation.id))
        .filter((obligation) => obligation.requiredFor.includes("*") || obligation.requiredFor.includes(cohortId));

      if (required.length === 0) return "NOT_APPLICABLE";
      // A wholly absent obligation is a worse problem than one whose evidence has aged out,
      // and it needs a different action, so absence outranks expiry when both are present.
      let anyExpired = false;
      for (const obligation of required) {
        if (obligationSatisfied(obligation, snapshot)) continue;
        if (obligationExpired(obligation, snapshot)) {
          anyExpired = true;
          continue;
        }
        return "UNSATISFIED";
      }
      return anyExpired ? "EXPIRED" : "SATISFIED";
    }

    case "providerHealth": {
      const screening = readPath(snapshot as unknown as Record<string, unknown>, extractor.basePath);
      if (screening === null || screening === undefined || typeof screening !== "object") return UNKNOWN_TOKEN;
      const byProvider = screening as Record<string, unknown>;
      const results = extractor.providers.map((provider) => byProvider[provider]);
      if (results.some((result) => result === null || result === undefined)) return UNKNOWN_TOKEN;
      const present = results as AggregateProviderResult[];
      if (present.some((result) => result.status === "UNAVAILABLE")) return "UNAVAILABLE";
      if (present.some((result) => result.status === "DEGRADED")) return "DEGRADED";
      return "COMPLETE";
    }

    case "listFreshness": {
      const result = readPath(
        snapshot as unknown as Record<string, unknown>,
        `${extractor.basePath}.${extractor.provider}`,
      ) as AggregateProviderResult | null | undefined;
      if (!result || result.listPublishedAt === null || result.listPublishedAt === undefined) return UNKNOWN_TOKEN;
      const maxAgeDays = resolveOwnerInput(catalog, extractor.maxAgeDaysOwnerInput);
      if (typeof maxAgeDays !== "number") return UNKNOWN_TOKEN;
      return withinDays(result.listPublishedAt, snapshot.evaluatedAt, maxAgeDays) ? "FRESH" : "STALE";
    }

    case "value": {
      const value = readPath(snapshot as unknown as Record<string, unknown>, extractor.path);
      if (value === null || value === undefined) return extractor.absentToken;
      const asString = String(value);
      return extractor.domain.includes(asString) ? asString : UNKNOWN_TOKEN;
    }

    case "booleanValue": {
      const value = readPath(snapshot as unknown as Record<string, unknown>, extractor.path);
      if (value === true) return "TRUE";
      if (value === false) return "FALSE";
      return UNKNOWN_TOKEN;
    }

    case "numericThreshold": {
      const value = readPath(snapshot as unknown as Record<string, unknown>, extractor.path);
      const minimum = resolveOwnerInput(catalog, extractor.minimumOwnerInput);
      if (typeof value !== "number" || Number.isNaN(value)) return UNKNOWN_TOKEN;
      if (typeof minimum !== "number") return UNKNOWN_TOKEN;
      return value >= minimum ? "AT_OR_ABOVE" : "BELOW";
    }

    default: {
      const exhaustive: never = extractor;
      throw new Error(`Unhandled extractor: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Evidence satisfies an obligation only if it was linked for that purpose, came from an
 * acceptable source, was produced under the policy snapshot the case pins, and is inside
 * its freshness window. Anything less would let a stale or cross-snapshot artifact close
 * out an obligation it was never gathered for.
 */
export function obligationSatisfied(
  obligation: { purpose: string; acceptableSourceTypes: string[]; freshnessDays: number | null },
  snapshot: CaseAggregate,
): boolean {
  const pinned = snapshot.policyAuthority?.policySnapshotDigest ?? null;
  return snapshot.evidence.some((item) => {
    if (item.purpose !== obligation.purpose) return false;
    if (!obligation.acceptableSourceTypes.includes(item.sourceType)) return false;
    if (pinned !== null && item.policySnapshotDigest !== null) {
      if (normalizeDigest(item.policySnapshotDigest) !== normalizeDigest(pinned)) return false;
    }
    if (obligation.freshnessDays !== null) {
      if (!withinDays(item.recordedAt, snapshot.evaluatedAt, obligation.freshnessDays)) return false;
    }
    return true;
  });
}

/**
 * True when evidence of the right purpose and source is present for this obligation but has
 * aged past its freshness window. Distinguishing this from absence is what lets the analyst
 * be told to refresh something rather than to go and find it.
 */
export function obligationExpired(
  obligation: { purpose: string; acceptableSourceTypes: string[]; freshnessDays: number | null },
  snapshot: CaseAggregate,
): boolean {
  if (obligation.freshnessDays === null) return false;
  const pinned = snapshot.policyAuthority?.policySnapshotDigest ?? null;
  return snapshot.evidence.some((item) => {
    if (item.purpose !== obligation.purpose) return false;
    if (!obligation.acceptableSourceTypes.includes(item.sourceType)) return false;
    if (pinned !== null && item.policySnapshotDigest !== null) {
      if (normalizeDigest(item.policySnapshotDigest) !== normalizeDigest(pinned)) return false;
    }
    return !withinDays(item.recordedAt, snapshot.evaluatedAt, obligation.freshnessDays!);
  });
}

// ------------------------------------------------------------------ helpers

function collectionOf(snapshot: CaseAggregate, name: string): Record<string, unknown>[] {
  switch (name) {
    case "evidence": return snapshot.evidence as unknown as Record<string, unknown>[];
    case "claims": return snapshot.claims as unknown as Record<string, unknown>[];
    case "findings": return snapshot.findings as unknown as Record<string, unknown>[];
    case "contradictions": return snapshot.contradictions as unknown as Record<string, unknown>[];
    case "workItems": return snapshot.workItems as unknown as Record<string, unknown>[];
    default: return [];
  }
}

function matchesWhere(item: Record<string, unknown>, where: Record<string, string | boolean>): boolean {
  return Object.entries(where).every(([key, expected]) => item[key] === expected);
}

function readPath(source: Record<string, unknown>, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function normalizeDigest(value: string): string {
  return value.startsWith("sha256:") ? value.slice("sha256:".length).toLowerCase() : value.toLowerCase();
}

const MILLIS_PER_DAY = 86_400_000;

function withinDays(fromIso: string, toIso: string, days: number): boolean {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (Number.isNaN(from) || Number.isNaN(to)) return false;
  const ageDays = (to - from) / MILLIS_PER_DAY;
  // Evidence dated in the future is not fresh, it is wrong; treat it as outside the window.
  return ageDays >= 0 && ageDays <= days;
}

function isBefore(iso: string, referenceIso: string): boolean {
  const value = Date.parse(iso);
  const reference = Date.parse(referenceIso);
  if (Number.isNaN(value) || Number.isNaN(reference)) return false;
  return value < reference;
}
