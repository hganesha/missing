import type { HarnessPlanV2 } from "./index.js";
export const DOCUMENT_EXTRACTION_REVIEW = "DOCUMENT_EXTRACTION_AUTHORIZATION";
export const DOCUMENT_CASE_WRITES: ReadonlySet<string> = new Set(["LinkEvidence", "RecordCanonicalRecords", "ProposeWorkItem"]);
/** The connector that reads the run's own original with the document model of the release in effect (Route A). */
export const DOCUMENT_MODEL_CONNECTOR = "document-model:azure_document_intelligence";
/** Work types a document run may raise: the three of the contract plan, plus route conflicts (factory plan Phase 4). */
export const DOCUMENT_WORK_TYPES: ReadonlySet<string> = new Set(["DOCUMENT_CLASSIFICATION", "DOCUMENT_EVIDENCE_GAP", "DOCUMENT_FIELD_REVIEW", "DOCUMENT_FIELD_CONFLICT"]);
/**
 * The two admitted shapes of the document pipeline. `contract` is the LLM extraction alone (the plan before Phase 4,
 * kept selectable for rollback); `adjudicated` adds the provider-model route under the route policy.
 */
const VARIANTS = {
  contract: { extractor: "document.fields.contract_extract", modelRoute: false },
  adjudicated: { extractor: "document.fields.adjudicated_extract", modelRoute: true },
} as const;
export type DocumentExtractionVariant = keyof typeof VARIANTS;
const host = (skillId: string) => `skill.${skillId}.v0`;

/** Which admitted document pipeline a plan is, or null when it is not one. */
export function documentExtractionVariant(plan: HarnessPlanV2): DocumentExtractionVariant | null {
  if (plan.metadata.name !== "document-reextraction" || plan.execution.coordinationMode !== "caseStore") return null;
  const skills = new Set(plan.graph.nodes.map(node => node.config.skillId).filter(Boolean).map(String));
  const variant = (Object.keys(VARIANTS) as DocumentExtractionVariant[]).find(key => skills.has(VARIANTS[key].extractor));
  if (!variant) return null;
  const { extractor, modelRoute } = VARIANTS[variant];
  const hosts: Record<string, string> = { "document.classify.catalog": host("document.classify.catalog"), [extractor]: host(extractor) };
  const tools = new Map<string, string>([["document.evidence.prepare.v1", "evidence:prepare"],
    ...Object.entries(hosts).map(([skillId, capabilityId]) => [capabilityId, `skills:${skillId}`] as [string, string]),
    ...(modelRoute ? [["document.model.extract.v1", DOCUMENT_MODEL_CONNECTOR] as [string, string]] : [])]);
  const selectors = ["case.caseId", "subjects", "subjects.0.subject_id", "records.DocumentPage", ...(modelRoute ? ["records.DocumentVersion"] : [])];
  if (!["tenantId", "caseId", "documentId", "documentVersion", "evidenceId", "filename", "contentBase64"].every(key => Array.isArray(plan.schemas.input.required) && plan.schemas.input.required.includes(key))) return null;
  if (plan.capabilities.some(cap => cap.kind === "model" ? cap.id !== "document.fields.extract.v1" || cap.adapterBindingId !== "openrouter:document_fields.model.document.v1" || !["none", "read"].includes(cap.effect) : tools.get(cap.id) !== cap.adapterBindingId || (cap.id === hosts[extractor] ? !["read", "reversible"].includes(cap.effect) : !["none", "read"].includes(cap.effect)))) return null;
  if (plan.budgets.maxModelCalls > 1 || plan.budgets.maxCapabilityCalls > (modelRoute ? 10 : 8) || plan.budgets.maxCostUsd > 1 || plan.budgets.maxDurationMs > (modelRoute ? 420000 : 300000)) return null;
  if (plan.contextSelectors.some(selector => !selectors.includes(selector.path))) return null;
  if (plan.graph.nodes.some(node => {
    if (!["input", "output", "tool"].includes(node.kind)) return true;
    if (Array.isArray(node.config.caseWritesHeld) && node.config.caseWritesHeld.length) return true;
    const skill = node.config.skillId;
    if (node.kind === "tool" && (skill ? hosts[String(skill)] !== node.config.capabilityId : node.config.capabilityId !== "document.evidence.prepare.v1")) return true;
    return Array.isArray(node.config.caseWrites) && node.config.caseWrites.some(write => !DOCUMENT_CASE_WRITES.has(String((write as Record<string, unknown>).commandType)));
  })) return null;
  const complete = Object.keys(hosts).every(skillId => plan.graph.nodes.some(node => node.config.skillId === skillId)) && plan.graph.nodes.some(node => node.config.capabilityId === "document.evidence.prepare.v1");
  return complete ? variant : null;
}
/** Only the admitted, bounded document pipeline can receive a secondary case grant. */
export function isDocumentExtractionPlan(plan: HarnessPlanV2): boolean {
  return documentExtractionVariant(plan) !== null;
}
