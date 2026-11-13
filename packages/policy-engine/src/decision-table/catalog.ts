import { createHash } from "node:crypto";
import { readPolicySource } from "./source-file.js";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

import {
  cohortCatalogSchema,
  decisionTableSchema,
  evidenceObligationCatalogSchema,
  ownerInputRegisterSchema,
  policySchema,
  reasonCodeRegistrySchema,
  ruleCatalogSchema,
  type DecisionTable,
  type EvidenceObligation,
  type FailureCohort,
  type OwnerInput,
  type Policy,
  type ReasonCode,
  type RiskCohort,
  type Rule,
} from "./schema.js";

export interface PolicyCatalog {
  policy: Policy;
  rules: Map<string, Rule>;
  reasonCodes: Map<string, ReasonCode>;
  queues: Set<string>;
  obligations: Map<string, EvidenceObligation>;
  riskCohorts: Map<string, RiskCohort>;
  failureCohorts: Map<string, FailureCohort>;
  cohortPrecedence: string[];
  cohortRequiredAttributes: string[];
  cohortAttributePaths: Record<string, string>;
  minimumTotalCorpusCases: number;
  ownerInputs: Map<string, OwnerInput>;
  tables: Map<string, DecisionTable>;
  /** gate id -> table id */
  gateTables: Map<string, string>;
  /**
   * Digest over every authored source file, in a fixed order. This is what pins a case to
   * the exact catalog that judged it: change any rule, reason code or row and the digest
   * moves, which is the whole point of pinning one.
   */
  bundleDigest: string;
  sourceDigests: Record<string, string>;
  /** Absolute directory the artifacts were read from. */
  root: string;
}

function readArtifact(root: string, relativePath: string): { raw: string; parsed: unknown } {
  const raw = readPolicySource(root, relativePath);
  const document = parseDocument(raw, { strict: true, uniqueKeys: true });
  if (document.errors.length > 0) {
    throw new Error(
      "policy.yaml_invalid",
    );
  }
  return { raw, parsed: document.toJS({ maxAliasCount: 0 }) };
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export class CatalogIntegrityError extends Error {
  constructor(public readonly problems: string[]) {
    super(`KYC policy catalog failed integrity checks:\n  - ${problems.join("\n  - ")}`);
    this.name = "CatalogIntegrityError";
  }
}

/**
 * Parse and cross-check every authored artifact.
 *
 * Schema validation alone would still let the catalog rot: a rule can cite a reason code
 * that was renamed, a table row can name a rule that no longer exists, a cohort can
 * require evidence nobody defined. Those are the mistakes that turn into a gate quietly
 * enforcing nothing, so they are errors here rather than warnings.
 */
export function loadPolicyCatalog(root: string): PolicyCatalog {
  const problems: string[] = [];
  const sourceDigests: Record<string, string> = {};

  const policyArtifact = readArtifact(root, "policy.yaml");
  sourceDigests["policy.yaml"] = sha256(policyArtifact.raw);
  const policy = policySchema.parse(policyArtifact.parsed);

  const load = <T>(relativePath: string, schema: { parse: (value: unknown) => T }): T => {
    const artifact = readArtifact(root, relativePath);
    sourceDigests[relativePath] = sha256(artifact.raw);
    return schema.parse(artifact.parsed);
  };

  const ruleCatalog = load(policy.spec.catalog.rules, ruleCatalogSchema);
  const reasonRegistry = load(policy.spec.catalog.reasonCodes, reasonCodeRegistrySchema);
  const obligationCatalog = load(policy.spec.catalog.evidenceObligations, evidenceObligationCatalogSchema);
  const cohortCatalog = load(policy.spec.catalog.cohorts, cohortCatalogSchema);
  const ownerRegister = load(policy.spec.catalog.ownerInputs, ownerInputRegisterSchema);

  const rules = new Map<string, Rule>();
  for (const rule of ruleCatalog.spec.rules) {
    if (rules.has(rule.id)) problems.push(`duplicate rule id ${rule.id}`);
    rules.set(rule.id, rule);
  }

  const reasonCodes = new Map<string, ReasonCode>();
  for (const code of reasonRegistry.spec.codes) {
    if (reasonCodes.has(code.code)) problems.push(`duplicate reason code ${code.code}`);
    reasonCodes.set(code.code, code);
  }

  const queues = new Set(reasonRegistry.spec.queues.map((queue) => queue.id));
  for (const code of reasonCodes.values()) {
    if (code.routeTo !== null && !queues.has(code.routeTo)) {
      problems.push(`reason code ${code.code} routes to unknown queue ${code.routeTo}`);
    }
    if (code.outcome === "ALLOW" && code.routeTo !== null) {
      problems.push(`reason code ${code.code} is an ALLOW code but names a queue`);
    }
  }

  const obligations = new Map<string, EvidenceObligation>();
  for (const obligation of obligationCatalog.spec.obligations) {
    if (obligations.has(obligation.id)) problems.push(`duplicate obligation id ${obligation.id}`);
    obligations.set(obligation.id, obligation);
  }

  const riskCohorts = new Map<string, RiskCohort>();
  for (const cohort of cohortCatalog.spec.riskCohorts) {
    if (riskCohorts.has(cohort.id)) problems.push(`duplicate risk cohort ${cohort.id}`);
    riskCohorts.set(cohort.id, cohort);
  }

  const failureCohorts = new Map<string, FailureCohort>();
  for (const cohort of cohortCatalog.spec.failureCohorts) {
    if (failureCohorts.has(cohort.id)) problems.push(`duplicate failure cohort ${cohort.id}`);
    failureCohorts.set(cohort.id, cohort);
  }

  const ownerInputs = new Map<string, OwnerInput>();
  for (const input of ownerRegister.spec.inputs) {
    if (ownerInputs.has(input.id)) problems.push(`duplicate owner input ${input.id}`);
    ownerInputs.set(input.id, input);
  }

  const tables = new Map<string, DecisionTable>();
  const gateTables = new Map<string, string>();
  for (const [gateId, gate] of Object.entries(policy.spec.gates)) {
    const table = load(gate.table, decisionTableSchema);
    if (table.metadata.gate !== gateId) {
      problems.push(`gate ${gateId} binds table ${table.metadata.id} declaring gate ${table.metadata.gate}`);
    }
    if (tables.has(table.metadata.id)) problems.push(`duplicate decision table ${table.metadata.id}`);
    tables.set(table.metadata.id, table);
    gateTables.set(gateId, table.metadata.id);

    if (!gate.mayFinalizeDisposition) {
      for (const row of table.spec.rows) {
        if (row.disposition !== undefined) {
          problems.push(`gate ${gateId} may not finalize a disposition but row ${row.id} sets ${row.disposition}`);
        }
      }
    }
  }

  // ---- cross-references
  const everyCohortId = new Set([...riskCohorts.keys()]);

  for (const rule of rules.values()) {
    if (!reasonCodes.has(rule.reasonCode)) {
      problems.push(`rule ${rule.id} cites unknown reason code ${rule.reasonCode}`);
    }
    for (const obligationId of rule.evidenceObligations) {
      if (!obligations.has(obligationId)) {
        problems.push(`rule ${rule.id} cites unknown evidence obligation ${obligationId}`);
      }
    }
    for (const cohortId of rule.appliesTo) {
      if (cohortId !== "*" && !everyCohortId.has(cohortId)) {
        problems.push(`rule ${rule.id} applies to unknown cohort ${cohortId}`);
      }
    }
    for (const tableId of rule.enforcedBy) {
      if (!tables.has(tableId)) problems.push(`rule ${rule.id} claims enforcement by unknown table ${tableId}`);
    }
    for (const inputId of rule.ownerInputRefs) {
      if (!ownerInputs.has(inputId)) problems.push(`rule ${rule.id} cites unknown owner input ${inputId}`);
    }
  }

  for (const obligation of obligations.values()) {
    for (const cohortId of obligation.requiredFor) {
      if (cohortId !== "*" && !everyCohortId.has(cohortId)) {
        problems.push(`obligation ${obligation.id} is required for unknown cohort ${cohortId}`);
      }
    }
    for (const ruleId of obligation.satisfiedBy) {
      if (!rules.has(ruleId)) problems.push(`obligation ${obligation.id} cites unknown rule ${ruleId}`);
    }
  }

  for (const cohortId of cohortCatalog.spec.assignmentPrecedence) {
    if (!riskCohorts.has(cohortId)) problems.push(`assignment precedence names unknown cohort ${cohortId}`);
  }
  for (const cohortId of riskCohorts.keys()) {
    if (!cohortCatalog.spec.assignmentPrecedence.includes(cohortId)) {
      problems.push(`risk cohort ${cohortId} is missing from the assignment precedence`);
    }
  }
  for (const cohort of failureCohorts.values()) {
    if (!reasonCodes.has(cohort.requiredReasonCode)) {
      problems.push(`failure cohort ${cohort.id} requires unknown reason code ${cohort.requiredReasonCode}`);
    }
    const code = reasonCodes.get(cohort.requiredReasonCode);
    if (code && code.outcome !== cohort.requiredOutcome) {
      problems.push(
        `failure cohort ${cohort.id} expects ${cohort.requiredOutcome} but reason code ` +
        `${cohort.requiredReasonCode} is registered as ${code.outcome}`,
      );
    }
  }

  for (const table of tables.values()) {
    const conditionIds = new Set(table.spec.conditions.map((condition) => condition.id));
    const tokensByCondition = new Map(
      table.spec.conditions.map((condition) => [condition.id, new Set(condition.tokens)]),
    );
    const seenRowIds = new Set<string>();

    for (const row of table.spec.rows) {
      if (seenRowIds.has(row.id)) problems.push(`table ${table.metadata.id} has duplicate row ${row.id}`);
      seenRowIds.add(row.id);

      for (const ruleId of row.rules) {
        if (!rules.has(ruleId)) problems.push(`table ${table.metadata.id} row ${row.id} cites unknown rule ${ruleId}`);
      }
      if (!reasonCodes.has(row.reasonCode)) {
        problems.push(`table ${table.metadata.id} row ${row.id} cites unknown reason code ${row.reasonCode}`);
      }
      const code = reasonCodes.get(row.reasonCode);
      if (code && code.outcome !== row.outcome) {
        problems.push(
          `table ${table.metadata.id} row ${row.id} emits ${row.outcome} with reason code ` +
          `${row.reasonCode}, registered as ${code.outcome}`,
        );
      }
      for (const [conditionId, expected] of Object.entries(row.when)) {
        if (!conditionIds.has(conditionId)) {
          problems.push(`table ${table.metadata.id} row ${row.id} matches unknown condition ${conditionId}`);
          continue;
        }
        const tokens = tokensByCondition.get(conditionId)!;
        for (const value of Array.isArray(expected) ? expected : [expected]) {
          if (!tokens.has(value)) {
            problems.push(
              `table ${table.metadata.id} row ${row.id} expects ${conditionId}=${value}, ` +
              `which is not a token of that condition`,
            );
          }
        }
      }
      if (row.escalation && !queues.has(row.escalation.queue)) {
        problems.push(`table ${table.metadata.id} row ${row.id} escalates to unknown queue ${row.escalation.queue}`);
      }
    }

    for (const ruleId of table.spec.default.rules) {
      if (!rules.has(ruleId)) problems.push(`table ${table.metadata.id} default cites unknown rule ${ruleId}`);
    }
    if (table.spec.default.outcome === "ALLOW") {
      problems.push(`table ${table.metadata.id} defaults to ALLOW; nothing may fall through to approval`);
    }

    // Every extractor that names a catalog entry must name one that exists.
    for (const condition of table.spec.conditions) {
      const extractor = condition.extractor;
      if (extractor.kind === "obligationFreshness" && !obligations.has(extractor.obligation)) {
        problems.push(`table ${table.metadata.id} condition ${condition.id} names unknown obligation ${extractor.obligation}`);
      }
      if (extractor.kind === "obligationsSatisfied") {
        for (const obligationId of [...(extractor.obligations ?? []), ...extractor.exclude]) {
          if (!obligations.has(obligationId)) {
            problems.push(`table ${table.metadata.id} condition ${condition.id} names unknown obligation ${obligationId}`);
          }
        }
        if (extractor.obligations === undefined && extractor.scope === undefined) {
          problems.push(`table ${table.metadata.id} condition ${condition.id} names neither obligations nor a scope`);
        }
      }
      for (const ref of ownerInputRefsOf(extractor)) {
        const [inputId, field] = ref.split(".");
        const input = inputId ? ownerInputs.get(inputId) : undefined;
        if (!input) {
          problems.push(`table ${table.metadata.id} condition ${condition.id} names unknown owner input ${ref}`);
        } else if (field && !(field in input.placeholder)) {
          problems.push(`owner input ${inputId} has no placeholder field ${field} required by condition ${condition.id}`);
        }
      }
    }
  }

  if (problems.length > 0) throw new CatalogIntegrityError(problems);

  const bundleDigest = sha256(
    Object.keys(sourceDigests).sort().map((key) => `${key}:${sourceDigests[key]}`).join("\n"),
  );

  return {
    root,
    policy,
    rules,
    reasonCodes,
    queues,
    obligations,
    riskCohorts,
    failureCohorts,
    cohortPrecedence: cohortCatalog.spec.assignmentPrecedence,
    cohortRequiredAttributes: cohortCatalog.spec.requiredAttributes,
    cohortAttributePaths: cohortCatalog.spec.attributePaths,
    minimumTotalCorpusCases: cohortCatalog.spec.minimumTotalCases,
    ownerInputs,
    tables,
    gateTables,
    bundleDigest,
    sourceDigests,
  };
}

function ownerInputRefsOf(extractor: { kind: string } & Record<string, unknown>): string[] {
  const refs: string[] = [];
  if (typeof extractor.maxAgeDaysOwnerInput === "string") refs.push(extractor.maxAgeDaysOwnerInput);
  if (typeof extractor.minimumOwnerInput === "string") refs.push(extractor.minimumOwnerInput);
  return refs;
}

/** Resolve an owner-input reference such as `D07.minimumConfidence` to its placeholder value. */
export function resolveOwnerInput(catalog: PolicyCatalog, reference: string): unknown {
  const [inputId, field] = reference.split(".");
  if (!inputId || !field) return undefined;
  return catalog.ownerInputs.get(inputId)?.placeholder[field];
}

const cache = new Map<string, PolicyCatalog>();

/** Load each policy root once per process; a catalog is immutable for the life of a bundle. */
export function policyCatalog(root: string): PolicyCatalog {
  const key = resolve(root);
  let catalog = cache.get(key);
  if (!catalog) {
    catalog = loadPolicyCatalog(key);
    cache.set(key, catalog);
  }
  return catalog;
}
