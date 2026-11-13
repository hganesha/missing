import { readPolicySource } from "./source-file.js";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
  policyBundleSchema,
  policyEvaluationSchema,
  stableDigest,
  type CaseSnapshot,
  type PolicyBundle,
  type PolicyEvaluation,
} from "@ehf/contracts";

import { policyCatalog, type PolicyCatalog } from "./catalog.js";
import { caseAggregateSchema, type CaseAggregate } from "./aggregate.js";
import { evaluateGate, type GateEvaluation } from "./evaluate.js";

/**
 * Compiles an authored decision-table catalog into an OPA/Rego v1 bundle.
 *
 * The emitted Rego is a pinned interpreter, and the policy itself is emitted as data. The
 * alternative — generating one Rego rule per authored row — reads better in isolation but
 * makes every policy change a diff of generated code. This way the interpreter is a fixed,
 * auditable artifact that changes rarely and is checked by OPA on every build, and a policy
 * change is a diff of rows that a policy owner can actually review. Both halves are pinned
 * by digest in the manifest, so neither can move without the bundle digest moving.
 */

const REGO_SOURCE_ROOT = process.env.POLICY_REGO_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../rego");

/** The interpreter modules, in the order their digests are recorded. */
export const REGO_MODULES = [
  "harness/decision_table/conditions.rego",
  "harness/decision_table/gate.rego",
] as const;

export const DECISION_TABLE_ENTRYPOINT = "data.harness.decision_table.gate.result";

export interface DeclaredBlocker {
  id: string;
  status: "UNRESOLVED" | "PROPOSED" | "RESOLVED";
  reasonCode: string;
  title: string;
  owner: string;
}

export interface CompiledDecisionTableBundle {
  manifest: PolicyBundle;
  productionEligible: boolean;
  releaseBlockers: DeclaredBlocker[];
  files: Record<string, string>;
  catalog: PolicyCatalog;
}

const run = promisify(execFile);
const verifiedOpaVersions = new Map<string, Promise<void>>();

const opaDecisionSchema = z.object({
  gateId: z.string().min(1),
  tableId: z.string().min(1),
  policyId: z.string().min(1),
  policyVersion: z.string().min(1),
  policyBundleDigest: z.string().min(1),
  cohortId: z.string().nullable(),
  outcome: z.enum(["ALLOW", "BLOCK", "REVIEW", "UNKNOWN", "ERROR"]),
  reasonCode: z.string().min(1),
  matchedRowId: z.string().nullable(),
  ruleIds: z.array(z.string()),
  transitionTo: z.string().nullable(),
  disposition: z.literal("APPROVED").nullable(),
  escalation: z.object({ queue: z.string(), dualControl: z.boolean() }).nullable(),
  routeTo: z.string().nullable(),
  conditionValues: z.record(z.string(), z.string()),
}).strict();

import type { OpaBundleEvaluator } from "./opa-server.js";
export type OpaCommand = (binary: string, args: string[]) => Promise<{ stdout: string }>;

async function defaultOpaCommand(binary: string, args: string[]): Promise<{ stdout: string }> {
  return run(binary, args, { maxBuffer: 10 * 1024 * 1024 });
}

export async function verifyOpaVersion(binary: string, expected: string, command: OpaCommand = defaultOpaCommand): Promise<void> {
  // Custom command implementations are test seams and must not share the process cache.
  const key = command === defaultOpaCommand ? `${binary}\0${expected}` : null;
  const verify = async () => {
    let stdout: string;
    try {
      ({ stdout } = await command(binary, ["version"]));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        throw new Error("policy.opa_binary_missing");
      }
      throw error;
    }
    const version = stdout.match(/Version:\s*v?([^\s]+)/i)?.[1];
    if (version !== expected) throw new Error(`policy.opa_version_mismatch:expected=${expected}:actual=${version ?? "unknown"}`);
  };
  if (!key) return verify();
  let pending = verifiedOpaVersions.get(key);
  if (!pending) {
    pending = verify();
    verifiedOpaVersions.set(key, pending);
    pending.catch(() => verifiedOpaVersions.delete(key));
  }
  return pending;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}

/**
 * The data half of the bundle: the parsed catalog, not the raw YAML, so the Rego never has
 * to guess what an omitted schema default meant.
 */
export function buildBundleData(catalog: PolicyCatalog): Record<string, unknown> {
  const record = <T>(entries: Iterable<[string, T]>): Record<string, T> =>
    Object.fromEntries([...entries].sort(([a], [b]) => a.localeCompare(b)));

  return {
    harness: {
      decision_table: {
        catalog: {
          policy_id: catalog.policy.metadata.id,
          policy_version: catalog.policy.metadata.version,
          bundle_digest: catalog.bundleDigest,
          gate_tables: record(catalog.gateTables),
          tables: record(
            [...catalog.tables].map(([id, table]) => [id, {
              id,
              gate: table.metadata.gate,
              conditions: table.spec.conditions,
              rows: table.spec.rows,
              default: table.spec.default,
              transition: table.spec.transition,
            }]),
          ),
          obligations: record(catalog.obligations),
          risk_cohorts: record(catalog.riskCohorts),
          cohort_precedence: catalog.cohortPrecedence,
          cohort_required_attributes: catalog.cohortRequiredAttributes,
          cohort_attribute_paths: catalog.cohortAttributePaths,
          reason_codes: record(catalog.reasonCodes),
          owner_inputs: record([...catalog.ownerInputs].map(([id, input]) => [id, input.placeholder])),
        },
      },
    },
  };
}

/** Owner inputs that are declared release blockers and are not yet resolved. */
export function releaseBlockers(catalog: PolicyCatalog): DeclaredBlocker[] {
  return [...catalog.ownerInputs.values()]
    .filter((input) => input.blocksRelease && input.status !== "RESOLVED")
    .map((input) => ({
      id: input.id,
      status: input.status,
      reasonCode: input.reasonCode,
      title: input.title,
      owner: input.owner,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function compileDecisionTablePolicy(options: {
  root: string;
  opaVersion: string;
  release?: "candidate" | "production";
}): CompiledDecisionTableBundle {
  if (!options.opaVersion.trim()) throw new Error("policy.opa_version_required");
  const catalog = policyCatalog(options.root);

  const blockers = releaseBlockers(catalog);
  const productionEligible = blockers.length === 0;
  if (options.release === "production" && !productionEligible) {
    // A candidate bundle may be compiled while the institution has not decided; promoting
    // one to production silently is the failure this check exists to prevent.
    throw new Error(`policy.production_blocked:${blockers.map((item) => item.id).join(",")}`);
  }

  const files: Record<string, string> = {};
  const regoModules = REGO_MODULES.map((path) => {
    const contents = readFileSync(resolve(REGO_SOURCE_ROOT, path), "utf8");
    files[path] = contents;
    return { path, digest: digest(contents) };
  });

  const data = `${JSON.stringify(buildBundleData(catalog), null, 2)}\n`;
  files["data.json"] = data;

  const sourceDigest = catalog.bundleDigest;
  const dataDigest = digest(data);
  const bundleDigest = digest(stableJson({ sourceDigest, regoModules, dataDigest }));

  const manifest = {
    apiVersion: "harness.factory/policy-bundle-v1" as const,
    kind: "PolicyBundle" as const,
    bundleId: `${catalog.policy.metadata.id}@${catalog.policy.metadata.version}:${bundleDigest.slice(0, 12)}`,
    policyId: catalog.policy.metadata.id,
    policyVersion: catalog.policy.metadata.version,
    sourceDigest,
    bundleDigest,
    opaVersion: options.opaVersion,
    regoModules,
    dataDigest,
    gates: [...catalog.gateTables.keys()].sort().map((gateId) => ({
      gateId,
      entrypoint: DECISION_TABLE_ENTRYPOINT,
      allowedOutcomes: catalog.policy.spec.outcomes,
    })),
    ruleIds: [...catalog.rules.keys()].sort(),
    // Pinned so a bundle cannot be promoted against a corpus other than the one it passed.
    testsDigest: digest(readPolicySource(catalog.root, catalog.policy.spec.evaluation.corpus)),
    authority: {
      source: String(catalog.policy.spec.authority.source),
      casePath: String(catalog.policy.spec.authority.casePath),
      requireSnapshotDigest: Boolean(catalog.policy.spec.authority.requireSnapshotDigest),
    },
  };

  return { manifest, productionEligible, releaseBlockers: blockers, files, catalog };
}

/**
 * Evaluate a gate against an immutable CaseSnapshot and issue a reproducible receipt.
 *
 * The caller supplies the clock value, so a replay months later produces the same receipt
 * byte for byte. Every condition value the gate resolved is carried in the obligations, not
 * only the ones the matched row looked at: that is what lets an evaluation be reconstructed
 * from the receipt alone, without the original case.
 */
export function evaluateDecisionTablePolicy(input: {
  compiled: CompiledDecisionTableBundle;
  snapshot: CaseSnapshot;
  gateId: string;
  evaluatedAt: string;
}): PolicyEvaluation {
  const { compiled, snapshot } = input;
  if (snapshot.policyAuthority.policyId !== compiled.manifest.policyId
    || snapshot.policyAuthority.policyVersion !== compiled.manifest.policyVersion
    || snapshot.policyAuthority.policyBundleDigest !== compiled.manifest.bundleDigest) {
    throw new Error("policy.snapshot_authority_mismatch");
  }

  const aggregate = caseAggregateSchema.parse(snapshot.data) as CaseAggregate;
  const evaluation = evaluateGate(input.gateId, aggregate, compiled.catalog);
  return createDecisionTablePolicyEvaluation({ ...input, evaluation });
}

function createDecisionTablePolicyEvaluation(input: {
  compiled: CompiledDecisionTableBundle;
  snapshot: CaseSnapshot;
  gateId: string;
  evaluatedAt: string;
  evaluation: GateEvaluation;
}): PolicyEvaluation {
  const { compiled, snapshot, evaluation } = input;
  if (evaluation.gateId !== input.gateId
    || evaluation.policyId !== compiled.manifest.policyId
    || evaluation.policyVersion !== compiled.manifest.policyVersion
    // The decision-table catalog digest is the source half of the bundle. The final
    // bundle digest also covers this emitted data, so embedding it here would be a
    // circular hash. The receipt below binds the verified final manifest digest.
    || evaluation.policyBundleDigest !== compiled.manifest.sourceDigest) {
    throw new Error("policy.opa_authority_mismatch");
  }
  const aggregate = caseAggregateSchema.parse(snapshot.data) as CaseAggregate;
  const evidenceRefs = aggregate.evidence.map((item) => item.evidenceId);

  const unsigned = {
    apiVersion: "harness.factory/policy-evaluation-v1" as const,
    kind: "PolicyEvaluation" as const,
    evaluationId: "pending",
    tenantId: snapshot.tenantId,
    caseId: snapshot.caseId,
    caseSequence: snapshot.caseSequence,
    caseSnapshotDigest: snapshot.snapshotDigest,
    dependencyDigest: snapshot.dependencyDigest,
    policyBundleDigest: compiled.manifest.bundleDigest,
    gateId: input.gateId,
    inputDigest: stableDigest(snapshot.data),
    outcome: evaluation.outcome,
    ruleResults: evaluation.ruleIds.map((ruleId) => ({
      ruleId,
      outcome: evaluation.outcome,
      reasonCode: evaluation.reasonCode,
      evidenceRefs,
    })),
    reasonCodes: [evaluation.reasonCode],
    obligations: obligationsFor(evaluation, compiled.catalog),
    evidenceRefs,
    evaluatedAt: input.evaluatedAt,
  };
  const identityDigest = stableDigest(unsigned);
  const withId = { ...unsigned, evaluationId: `evaluation_${identityDigest.slice(0, 24)}` };
  return policyEvaluationSchema.parse({ ...withId, receiptDigest: stableDigest(withId) });
}

/**
 * Execute the emitted, digest-bound bundle with the exact OPA version named by its
 * manifest. This is the production decision path; the TypeScript implementation above is
 * deliberately retained only as an independently testable reference evaluator.
 */
export async function evaluateDecisionTablePolicyWithOpa(input: {
  compiled: CompiledDecisionTableBundle;
  snapshot: CaseSnapshot;
  gateId: string;
  evaluatedAt: string;
  opaPath?: string;
  command?: OpaCommand;
  /** A long-running evaluator (OpaServerPool). Without one, each call runs `opa eval`. */
  evaluator?: OpaBundleEvaluator;
}): Promise<PolicyEvaluation> {
  const { compiled } = input;
  if (input.snapshot.policyAuthority.policyId !== compiled.manifest.policyId
    || input.snapshot.policyAuthority.policyVersion !== compiled.manifest.policyVersion
    || input.snapshot.policyAuthority.policyBundleDigest !== compiled.manifest.bundleDigest) {
    throw new Error("policy.snapshot_authority_mismatch");
  }
  const gate = compiled.manifest.gates.find((candidate) => candidate.gateId === input.gateId);
  if (!gate) throw new Error("policy.gate_not_found");
  const command = input.command ?? defaultOpaCommand;
  const binary = input.opaPath ?? process.env.OPA_PATH ?? process.env.OPA_BIN ?? "opa";
  await verifyOpaVersion(binary, compiled.manifest.opaVersion, command);

  const aggregate = caseAggregateSchema.parse(input.snapshot.data);
  const opaInput = { gate: input.gateId, snapshot: aggregate };
  const raw = input.evaluator
    ? await input.evaluator.evaluate({ bundleDigest: compiled.manifest.bundleDigest, files: compiled.files }, gate.entrypoint, opaInput)
    : await evaluateOnce(compiled, gate.entrypoint, opaInput, binary, command);
  const decision = opaDecisionSchema.parse(raw);
  return createDecisionTablePolicyEvaluation({
    compiled,
    snapshot: input.snapshot,
    gateId: input.gateId,
    evaluatedAt: input.evaluatedAt,
    evaluation: {
      ...decision,
      caseSequence: input.snapshot.caseSequence,
      evaluatedAt: input.evaluatedAt,
    },
  });
}

/** One `opa eval` process over a temporary copy of the bundle. */
async function evaluateOnce(compiled: CompiledDecisionTableBundle, entrypoint: string, opaInput: unknown, binary: string, command: OpaCommand): Promise<unknown> {
  const root = await mkdtemp(resolve(tmpdir(), "ehf-opa-evaluation-"));
  try {
    const bundleRoot = resolve(root, "bundle");
    await Promise.all(Object.entries(compiled.files).map(async ([path, source]) => {
      const target = resolve(bundleRoot, path);
      if (!target.startsWith(`${bundleRoot}/`)) throw new Error("policy.bundle_path_invalid");
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, source, "utf8");
    }));
    const inputPath = resolve(root, "input.json");
    await writeFile(inputPath, JSON.stringify(opaInput), "utf8");
    let stdout: string;
    try {
      ({ stdout } = await command(binary, [
        "eval", "--fail", "--format=json", "--data", bundleRoot, "--input", inputPath,
        entrypoint,
      ]));
    } catch (error) {
      throw new Error(`policy.opa_evaluation_failed:${error instanceof Error ? error.message : "unknown"}`);
    }
    try {
      const document = JSON.parse(stdout) as { result?: Array<{ expressions?: Array<{ value?: unknown }> }> };
      return document.result?.[0]?.expressions?.[0]?.value;
    } catch {
      throw new Error("policy.opa_response_invalid");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * What the control plane must do about this outcome, and what the gate saw when it decided.
 *
 * The command mapping comes from the policy rather than being inferred here, so the set of
 * case commands a gate can ask for stays something a reviewer reads in the YAML.
 */
function obligationsFor(
  evaluation: GateEvaluation,
  catalog: PolicyCatalog,
): { code: string; parameters: Record<string, unknown> }[] {
  const mappings = catalog.policy.spec.commandMappings;
  const obligations: { code: string; parameters: Record<string, unknown> }[] = [];

  if (evaluation.outcome === "ALLOW") {
    obligations.push({
      code: mappings.recordEvaluation.commandType,
      parameters: {
        decision: "AUTHORIZED",
        ...(evaluation.transitionTo ? { transitionTo: evaluation.transitionTo } : {}),
        ...(evaluation.disposition ? { disposition: evaluation.disposition } : {}),
      },
    });
  } else {
    obligations.push({
      code: mappings.routeHumanReview.commandType,
      parameters: {
        reasonCode: evaluation.reasonCode,
        ...(evaluation.routeTo ? { queue: evaluation.routeTo } : {}),
        ...(evaluation.escalation ? { dualControl: evaluation.escalation.dualControl } : {}),
      },
    });
  }

  obligations.push({
    code: "RecordConditionValues",
    parameters: {
      tableId: evaluation.tableId,
      matchedRowId: evaluation.matchedRowId,
      cohortId: evaluation.cohortId,
      conditionValues: evaluation.conditionValues,
    },
  });
  return obligations;
}
