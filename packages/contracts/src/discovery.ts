import { z } from "zod";

const id = z.string().min(1).max(200);
const text = z.string().min(1).max(1_000);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const uniqueIds = (ids: string[]) => new Set(ids).size === ids.length;

export const discoverySourceLeadSchema = z.object({
  sourceId: id,
  title: text,
  kind: z.enum(["registry", "court", "regulator", "issuer", "rating_agency", "news"]),
  url: z.url({ protocol: /^https$/ }).max(1_000),
  publishedOn: z.iso.date().nullable(),
  observedAt: z.iso.datetime(),
}).strict();

export const discoverySignalSchema = z.object({
  signalId: id,
  category: z.enum([
    "identity", "ownership", "legal", "regulatory", "financial_crime",
    "bankruptcy", "financial_losses", "credit_rating", "operational", "reputation", "geography",
  ]),
  headline: text,
  reportedStage: text,
  eventOn: z.iso.date().nullable(),
  sourceIds: z.array(id).min(1).max(5).refine(uniqueIds),
  match: z.enum(["uncertain", "possible", "likely", "likely_different"]),
  matchBasis: text,
  verificationStatus: z.literal("UNVERIFIED"),
  priority: z.enum(["low", "medium", "high"]),
  verificationQuestion: text,
}).strict();

export const discoveryBriefSchema = z.object({
  schemaVersion: z.literal("discovery.brief.v1"),
  briefId: id,
  caseId: id,
  subjectId: id,
  parentPlanDigest: digest,
  intakeDecisionId: id,
  intakeSettlement: z.object({ runId: id, workItemId: id }).strict().optional(),
  origin: z.enum(["synthetic_fixture", "hosted_synthetic", "openrouter_web", "azure_foundry_web"]),
  advisoryExecution: z.object({ runId: id, planDigest: digest }).strict().optional(),
  recordedAt: z.iso.datetime(),
  status: z.enum(["complete", "no_leads"]),
  summary: text,
  signals: z.array(discoverySignalSchema).max(12),
  sources: z.array(discoverySourceLeadSchema).max(24),
  limitations: z.array(text).min(1).max(8),
}).strict().superRefine((brief, ctx) => {
  if ((brief.origin === "hosted_synthetic") !== Boolean(brief.advisoryExecution)) {
    ctx.addIssue({ code: "custom", path: ["advisoryExecution"], message: "discovery.execution_origin_mismatch" });
  }
  const sourceIds = brief.sources.map((source) => source.sourceId);
  if (!uniqueIds(sourceIds) || !uniqueIds(brief.signals.map((signal) => signal.signalId))) {
    ctx.addIssue({ code: "custom", message: "discovery.duplicate_id" });
  }
  if (brief.signals.some((signal) => signal.sourceIds.some((id) => !sourceIds.includes(id)))) {
    ctx.addIssue({ code: "custom", path: ["signals"], message: "discovery.source_reference_missing" });
  }
  if ((brief.status === "no_leads") !== (brief.signals.length === 0)) {
    ctx.addIssue({ code: "custom", path: ["status"], message: "discovery.status_inconsistent" });
  }
});

export type DiscoveryBrief = z.infer<typeof discoveryBriefSchema>;

export const discoverySearchCapabilityId = "discovery.public.search.v1";
export const discoveryModelCapabilityId = "model.discovery.brief.v1";
export const discoveryFixtureCompany = "Asterion Advanced Materials Ltd.";

export const discoverySearchSeedSchema = z.object({
  companyName: z.literal(discoveryFixtureCompany),
  country: z.string().regex(/^[A-Z]{2}$/),
}).strict();

export const discoveryRunInputSchema = z.object({
  tenantId: id,
  caseId: z.string().regex(/^recon_[a-f0-9]{64}$/),
  seed: discoverySearchSeedSchema,
}).strict();

export const discoverySearchResultSchema = z.object({
  schemaVersion: z.literal("discovery.search.v1"),
  origin: z.literal("synthetic_fixture"),
  queries: z.array(z.string().min(1).max(1_000)).length(4),
  results: z.array(discoverySourceLeadSchema.extend({ snippet: text })).max(12)
    .refine(rows => uniqueIds(rows.map(row => row.sourceId))),
  limitations: z.array(text).min(1).max(8),
}).strict();

export const discoveryAgentDraftSchema = z.object({
  summary: text,
  signals: z.array(discoverySignalSchema.omit({ signalId: true, verificationStatus: true })).max(12),
  limitations: z.array(text).min(1).max(7),
}).strict();

export const discoveryAdvisoryOutputSchema = z.object({
  search: discoverySearchResultSchema,
  draft: discoveryAgentDraftSchema,
}).strict();

export function validateDiscoveryAdvisoryOutput(value: unknown) {
  const output = discoveryAdvisoryOutputSchema.parse(value);
  const ids = new Set(output.search.results.map(result => result.sourceId));
  if (output.draft.signals.some(signal => signal.sourceIds.some(sourceId => !ids.has(sourceId)))) {
    throw new Error("discovery.source_reference_missing");
  }
  return output;
}

export const reconJobStatusSchema = z.enum(["queued", "running", "complete", "failed"]);
export const reconModeSchema = z.enum(["synthetic", "live"]);
/** Why a request failed, from a closed vocabulary. Never provider text. */
export const reconFailureReasonSchema = z.enum(["timeout", "provider_rejected", "output_unusable", "not_eligible", "expired", "interrupted", "error"]);
export type ReconFailureReason = z.infer<typeof reconFailureReasonSchema>;
export type ReconMode = z.infer<typeof reconModeSchema>;
export const caseReconStateSchema = z.object({
  status: z.enum(["unavailable", "idle", ...reconJobStatusSchema.options]),
  canRequest: z.boolean(),
  brief: discoveryBriefSchema.nullable(),
  /** Present only while the status is `failed`. */
  failureReason: reconFailureReasonSchema.optional(),
}).strict();
export type CaseReconState = z.infer<typeof caseReconStateSchema>;
export const caseReconSchema = caseReconStateSchema.extend({ live: caseReconStateSchema.optional() });
export type ReconJobStatus = z.infer<typeof reconJobStatusSchema>;
export type CaseRecon = z.infer<typeof caseReconSchema>;
