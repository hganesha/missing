import { z } from "zod";

const reference = z.string().trim().min(1).max(400);
const probability = z.number().finite().min(0).max(1);
const coordinates = z.object({ top: probability, bottom: probability, left: probability, right: probability }).strict()
  .refine(box => box.top < box.bottom && box.left < box.right, "Box edges must define a nonempty region");

/** Canonical executor protocol. These schemas do not implement provider dispatch. */
export const intelligenceInvocationSchema = z.object({
  requestId: reference, bindingId: reference, bindingRevision: z.number().int().positive(),
  bindingDigest: z.string().regex(/^[a-f0-9]{64}$/), inputRef: reference,
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/), deadline: z.string().datetime(),
}).strict();
export const documentAnalysisRequestSchema = intelligenceInvocationSchema.extend({
  contract: z.literal("document.analysis.v1"),
  document: z.object({ artifactRef: reference, sha256: z.string().regex(/^[a-f0-9]{64}$/), mediaType: reference, byteLength: z.number().int().positive(), pages: z.array(z.number().int().positive()).min(1).max(10000) }).strict(),
}).strict();
export const documentAnalysisResultSchema = z.object({
  contract: z.literal("document.analysis.v1"), requestId: reference, providerJobId: reference.nullable(),
  status: z.enum(["queued", "running", "succeeded", "partial", "failed", "cancelled", "expired"]),
  sourceDigest: z.string().regex(/^[a-f0-9]{64}$/), modelVersion: reference,
  outputRef: reference.nullable(),
  pages: z.array(z.object({
    page: z.number().int().positive(),
    fields: z.array(z.object({ path: reference, valueRef: reference, confidence: probability.nullable(), box: coordinates.nullable(), sourceSpanRef: reference }).strict()),
  }).strict()),
  reviewRequired: z.boolean(), errorCode: reference.nullable(),
}).strict().superRefine((value, context) => {
  if (value.status === "succeeded" && (!value.outputRef || !value.pages.length)) context.addIssue({ code: "custom", message: "Successful analysis requires an output artifact and page provenance" });
  if ((value.status === "partial" || value.pages.some(page => page.fields.some(field => field.confidence === null))) && !value.reviewRequired) context.addIssue({ code: "custom", message: "Partial results and missing field confidence require review" });
});
export const system1RequestSchema = intelligenceInvocationSchema.extend({
  contract: z.literal("decision.system1.v1"), stateSchemaRef: reference, questionSetRef: reference,
}).strict();
/**
 * A choice answer may carry the provider's distribution over the question's declared options
 * (`probabilities`). It is reported, never synthesized: an adapter whose provider returns none sends
 * null, and the distribution is not calibrated confidence until the evaluation engine calibrates it.
 */
export const system1AnswerSchema = z.discriminatedUnion("primitive", [
  z.object({ primitive: z.literal("choice"), value: reference, confidence: probability.nullable(),
    probabilities: z.record(reference, probability).nullable().optional() }).strict(),
  z.object({ primitive: z.literal("score"), level: reference, confidence: probability.nullable() }).strict(),
  z.object({ primitive: z.literal("noul"), probability, confidence: z.null() }).strict(),
  z.object({ primitive: z.literal("box"), box: coordinates, confidence: probability.nullable() }).strict(),
]);
export type System1Answer = z.infer<typeof system1AnswerSchema>;

/** Whether a distribution covers exactly the options, sums to 1 (within 0.02) and favours the chosen option. */
export function system1DistributionValid(options: readonly string[], chosen: string, probabilities: Record<string, number>): boolean {
  const keys = Object.keys(probabilities);
  if (keys.length !== options.length || options.some(option => !Object.hasOwn(probabilities, option))) return false;
  const values = Object.values(probabilities);
  if (values.some(value => !Number.isFinite(value) || value < 0 || value > 1)) return false;
  return Math.abs(values.reduce((sum, value) => sum + value, 0) - 1) <= 0.02 && probabilities[chosen]! >= Math.max(...values);
}

/** Validates a canonical answer; acceptance is input to policy, never action authority. */
export function checkSystem1Answer(configuration: { primitive: System1Answer["primitive"]; options: readonly string[]; minConfidence: number }, raw: unknown):
  { status: "accepted"; answer: System1Answer } | { status: "abstain"; reason: "invalid_answer" | "unexpected_primitive" | "unknown_option" | "confidence_unavailable" | "low_confidence" } {
  const parsed = system1AnswerSchema.safeParse(raw);
  if (!parsed.success || !Number.isFinite(configuration.minConfidence) || configuration.minConfidence < 0 || configuration.minConfidence > 1) return { status: "abstain", reason: "invalid_answer" };
  const answer = parsed.data;
  if (answer.primitive !== configuration.primitive) return { status: "abstain", reason: "unexpected_primitive" };
  if (answer.primitive === "choice" && !configuration.options.includes(answer.value) || answer.primitive === "score" && !configuration.options.includes(answer.level)) return { status: "abstain", reason: "unknown_option" };
  if (answer.primitive === "choice" && answer.probabilities && !system1DistributionValid(configuration.options, answer.value, answer.probabilities)) return { status: "abstain", reason: "invalid_answer" };
  if (configuration.minConfidence > 0 && answer.confidence === null) return { status: "abstain", reason: "confidence_unavailable" };
  if (answer.confidence !== null && answer.confidence < configuration.minConfidence) return { status: "abstain", reason: "low_confidence" };
  return { status: "accepted", answer };
}

/**
 * Why a System 1 question or batch has no usable answer (factory plan §6.5 rule 2). Abstention is not an
 * answer: it is recorded with its reason and changes nothing. Provider refusals, content filters, rate limits
 * and outages are all `unavailable`, never a negative answer.
 */
export const SYSTEM1_ABSTENTION_REASONS = [
  "timeout", "unavailable", "invalid_response", "model_substitution", "missing_or_unknown_questions", "invalid_distribution",
  "response_limit", "cannot_tell", "budget_exhausted", "missing_context", "not_configured",
] as const;
export type System1AbstentionReason = typeof SYSTEM1_ABSTENTION_REASONS[number];
const abstentionReason = z.enum(SYSTEM1_ABSTENTION_REASONS);
const questionId = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const optionLabel = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

/** One bounded multiple-choice question: instructions and a description per option. */
export const system1QuestionSchema = z.object({
  type: z.literal("choice"),
  instructions: z.string().trim().min(1).max(4000),
  criteria: z.record(optionLabel, z.string().trim().min(1).max(1000)).refine(value => Object.keys(value).length >= 2 && Object.keys(value).length <= 20, "A question needs 2 to 20 options"),
}).strict();
export type System1Question = z.infer<typeof system1QuestionSchema>;

/** A batch of questions over one state, for one pinned model. `returnedModel` pins a dated revision the provider reports. */
export const system1DecisionRequestSchema = z.object({
  state: z.record(z.string(), z.unknown()),
  questions: z.record(questionId, system1QuestionSchema).refine(value => Object.keys(value).length >= 1 && Object.keys(value).length <= 100, "1 to 100 questions"),
}).strict();
export type System1DecisionRequest = z.infer<typeof system1DecisionRequestSchema>;

const choiceAnswer = system1AnswerSchema.options[0];
export const system1QuestionResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("answered"), answer: choiceAnswer }).strict(),
  z.object({ status: z.literal("abstained"), reason: abstentionReason }).strict(),
]);
/** The canonical result of a batch, whichever adapter produced it. */
export const system1DecisionResultSchema = z.object({
  contract: z.literal("decision.system1.v1"),
  adapter: reference, model: reference, actualModel: reference.nullable(),
  status: z.enum(["answered", "abstained"]),
  abstention: z.object({ reason: abstentionReason, detail: z.string().max(200).nullable() }).strict().nullable(),
  answers: z.record(questionId, system1QuestionResultSchema),
  telemetry: z.object({
    requestId: reference.nullable(), upstreamProvider: reference.nullable(), inputTokens: z.number().nonnegative().nullable(),
    outputTokens: z.number().nonnegative().nullable(), costUsd: z.number().nonnegative().nullable(), durationMs: z.number().nonnegative(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if ((value.status === "abstained") !== (value.abstention !== null)) context.addIssue({ code: "custom", message: "A batch abstains with a reason, and only then" });
  if (value.status === "abstained" && Object.values(value.answers).some(answer => answer.status === "answered")) context.addIssue({ code: "custom", message: "An abstained batch carries no answers" });
});
export type System1DecisionResult = z.infer<typeof system1DecisionResultSchema>;

export class System1Error extends Error {
  constructor(readonly reason: System1AbstentionReason, readonly detail: string | null = null) { super(`decision.${reason}`); }
}

/** A provider answer after its adapter normalized it, before validation. */
export type System1RawAnswers = { model: string | null; answers: Record<string, { choice: string; probabilities: Record<string, number> | null; confidence?: number | null }> };

/**
 * The one validator every adapter's answer passes (ported and generalized from pipeline-builder's
 * validateDecisionResponse). It refuses model substitution, a missing or unknown question, an option the
 * question does not declare, and a distribution that does not cover the options, sum to 1 or favour the
 * chosen option. A batch with any such fault is unusable as a whole: no convenient defaults, no retrying
 * until the model agrees. A missing distribution is allowed and stays null.
 */
export function validateSystem1Answers(raw: System1RawAnswers, questions: Record<string, System1Question>, pin: { model: string; returnedModel?: string | null }):
  Record<string, z.infer<typeof choiceAnswer>> {
  if (raw.model === null || raw.model !== (pin.returnedModel ?? pin.model)) throw new System1Error("model_substitution", raw.model ? raw.model.slice(0, 200) : null);
  const ids = Object.keys(questions);
  if (Object.keys(raw.answers).length !== ids.length || Object.keys(raw.answers).some(id => !Object.hasOwn(questions, id))) throw new System1Error("missing_or_unknown_questions");
  const out: Record<string, z.infer<typeof choiceAnswer>> = {};
  for (const id of ids) {
    const answer = raw.answers[id]!, options = Object.keys(questions[id]!.criteria);
    if (typeof answer?.choice !== "string" || !options.includes(answer.choice)) throw new System1Error("invalid_distribution", `${id}: option`);
    if (answer.probabilities !== null && !system1DistributionValid(options, answer.choice, answer.probabilities)) throw new System1Error("invalid_distribution", id);
    const confidence = typeof answer.confidence === "number" && answer.confidence >= 0 && answer.confidence <= 1 ? answer.confidence : null;
    out[id] = { primitive: "choice", value: answer.choice, confidence, probabilities: answer.probabilities };
  }
  return out;
}

/** An MCP registration and pinned tool contract accompany every future gateway call. */
export const mcpToolCallRequestSchema = intelligenceInvocationSchema.extend({
  contract: z.literal("mcp.tools.v1"),
  catalogDigest: z.string().regex(/^[a-f0-9]{64}$/),
  toolName: z.string().trim().min(1).max(128).regex(/^[^\s*]+$/),
  capabilityId: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+\.v[0-9]+$/),
  inputSchemaRef: reference, outputSchemaRef: reference,
}).strict();
