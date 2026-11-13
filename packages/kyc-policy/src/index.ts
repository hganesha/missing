/**
 * Lane B: the authored US KYC policy and the evidence that it is encoded correctly.
 *
 * The decision-table machinery — schemas, loader, reference evaluator, Rego emitter — lives
 * in `@ehf/policy-engine` and is domain-neutral. This package is the KYC content: the
 * catalog under `domains/kyc/policy`, the KYC projection of the case aggregate, the golden
 * corpus, and the suite that holds all three to each other.
 */
export { KYC_POLICY_ROOT, kycPolicyCatalog, type PolicyCatalog } from "./catalog.js";

export {
  CASE_SNAPSHOT_SCHEMA_VERSION,
  kycCaseAggregateSchema,
  type KycCaseAggregate,
  type KycEvidence,
  type KycFinding,
  type KycProviderResult,
  type KycRecommendation,
} from "./snapshot.js";

export {
  GATE_ORDER,
  corpusPath,
  loadCorpus,
  loadCorpusManifest,
  type CorpusCase,
  type CorpusExpectation,
} from "./corpus.js";

// Re-exported so a consumer of the KYC policy does not have to reach past it into the
// engine for the everyday calls.
export {
  UNKNOWN_TOKEN,
  assignRiskCohort,
  compileDecisionTablePolicy,
  evaluateDecisionTablePolicy,
  evaluateGate,
  releaseBlockers,
  type CompiledDecisionTableBundle,
  type GateEvaluation,
} from "@ehf/policy-engine";
