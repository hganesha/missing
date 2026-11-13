/**
 * Compile the bounded document rerun from the pinned library contracts used by KYC, in its two admitted variants
 * (packages/contracts document-extraction.ts): `adjudicated` (the LLM route plus the provider-model route under the
 * route policy, document factory plan Phase 4) and `contract` (the LLM route alone, kept selectable for rollback).
 * The BFF runs whichever plan digest BFF_DOCUMENT_PLAN_DIGEST names.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { compilePackage, directorySource } from "../packages/compiler/src/index.js";
import { businessSkillManifestDigest, DOCUMENT_MODEL_CONNECTOR, documentExtractionVariant, parseHarnessPlan, verifyHarnessPlanDigest, type DocumentExtractionVariant } from "../packages/contracts/src/index.js";
import { admitHarnessPlanV2 } from "../packages/runtime-core/src/index.js";
import { PROVIDER_SCHEMAS } from "../packages/library-contracts/src/providers.js";
const root = fileURLToPath(new URL("../", import.meta.url));
const EXTRACTOR = { contract: "document.fields.contract_extract", adjudicated: "document.fields.adjudicated_extract" } as const;
export const DOCUMENT_PLAN_PATHS: Record<DocumentExtractionVariant, string> = {
  adjudicated: "artifacts/document-extraction.plan.json",
  contract: "artifacts/document-extraction-contract.plan.json",
};
const readJson = (path: string) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
export function buildDocumentExtractionPlan(variant: DocumentExtractionVariant = "adjudicated") {
  const source = directorySource(resolve(root, "domains/archive/kyc-v2-deterministic"));
  const files = new Map(source.files);
  const pkg = parse(Buffer.from(files.get("package.yaml")!).toString());
  const workflow = parse(Buffer.from(files.get(pkg.workflow)!).toString());
  const archived = ["document.classify.catalog", "document.fields.contract_extract"];
  const skillIds = ["document.classify.catalog", EXTRACTOR[variant]];
  const nodes = workflow.spec.nodes.filter((node: any) => archived.includes(node.config?.skillId));
  // The archived KYC package predates the adjudicated wrapper: its extraction node and binding become the
  // wrapper's, pinned to the library's current manifest and bundle (config/business-skills.json).
  const entry = readJson("config/business-skills.json").skills.find((skill: any) => skill.skillId === EXTRACTOR[variant]);
  if (!entry) throw new Error(`document.skill_not_registered:${EXTRACTOR[variant]}`);
  const bundleDigest = `sha256:${readJson("config/skill-library/catalog.json").bundle_code_hash ?? entry.manifest.bundle_code_hash}`;
  const prepare = structuredClone(workflow.spec.nodes.find((node: any) => node.id === "acquire-documents"));
  prepare.id = "prepare-document";
  prepare.name = "Prepare selected document";
  prepare.summary = "Parse the verified original bytes into pages for this immutable document version.";
  prepare.capabilities.tools = ["document.evidence.prepare.v1"];
  prepare.config.usePredecessorInput = true;
  prepare.config.caseWrites = prepare.config.caseWrites.filter((write: any) => ["LinkEvidence", "RecordCanonicalRecords"].includes(write.commandType));
  prepare.config.evidenceCapture.trustTier = "VERIFIED_PROVIDER";
  for (const node of nodes) {
    node.config.skillPurpose = "document_review";
    node.config.skillPolicy.values.permissions = skillIds.map(id => `skill:${id}`).concat("effect:proposal");
    if (node.config.skillId === archived[1]) {
      node.id = `document-fields-${EXTRACTOR[variant].split(".").at(-1)!.replaceAll("_", "-")}`;
      node.name = EXTRACTOR[variant];
      node.config.skillId = EXTRACTOR[variant];
      node.config.libraryStep = EXTRACTOR[variant].replaceAll(".", "_");
      node.config.skillPolicy.values.permissions = skillIds.map(id => `skill:${id}`).concat("effect:proposal");
      if (variant === "adjudicated") {
        node.summary = "Extract each classified document's catalog contract through the LLM route and, under the route policy, the document model of the release in effect; adjudicate field by field and propose the results for review.";
        // The wrapper reads the selected version's DocumentVersion row (its artifact reference) for the model route.
        const selector = { id: "recDocumentVersion-document-fields-adjudicated-extract", source: "case", path: "records.DocumentVersion", purpose: "KYC_ONBOARDING", classification: "CONFIDENTIAL", required: false,
          record: { objectType: "DocumentVersion", fields: ["artifact_hash", "artifact_ref", "media_type"], minCount: 0, maxAgeSeconds: null } };
        pkg.contextSelectors.push(selector);
        node.contextSelectorIds = [...node.contextSelectorIds.map((id: string) => id.replace("contract-extract", "adjudicated-extract")), selector.id];
        pkg.contextSelectors.filter((item: any) => item.id === "recDocumentPage-document-fields-contract-extract").forEach((item: any) => { item.id = "recDocumentPage-document-fields-adjudicated-extract"; });
      }
      node.config.skillPolicy.values.permitted_providers = variant === "adjudicated"
        ? { "document.fields": ["ehf-gateway"], "document.model": ["ehf-gateway"] } : { "document.fields": ["ehf-gateway"] };
      node.config.skillPolicy.sources.permitted_providers = variant === "adjudicated"
        ? "admitted document.fields.extract.v1 and document.model.extract.v1 callback capabilities" : "admitted document.fields.extract.v1 callback capability";
      node.config.skillPolicy.unresolved = [];
      node.config.caseWrites = node.config.caseWrites.filter((write: any) => ["LinkEvidence", "RecordCanonicalRecords", "ProposeWorkItem"].includes(write.commandType));
    }
  }
  const fields = ["tenantId", "caseId", "documentId", "documentVersion", "evidenceId", "filename", "contentBase64"];
  const input = { type: "object", required: fields, additionalProperties: false, properties: Object.fromEntries(fields.map(key => [key, { type: "string", minLength: 1 }])) };
  const allNodes = [{ id: "input", kind: "input", name: "Selected immutable document" }, prepare, ...nodes, { id: "output", kind: "output", name: "Unverified extraction result", config: { usePredecessorInput: true } }];
  workflow.metadata = { name: "document-reextraction", title: "Document re-extraction", version: "1.0.0" };
  workflow.spec = { objective: "Extract catalog fields from one original document; preserve assertions for human review.", inputs: input, outputs: { type: "object" }, policies: { maxConcurrency: 1, onFailure: "stop" }, nodes: allNodes, edges: allNodes.slice(1).map((node: any, index: number) => ({ id: `document-${index}`, from: allNodes[index]!.id, to: node.id, kind: "data" })) };
  pkg.metadata = { name: "document-reextraction", version: "1.0.0", domain: "documents", objective: workflow.spec.objective, owners: ["document-operations"], riskClass: "high" };
  // Layout analysis for scans (up to about two minutes) plus the extraction skill: one 150-second LLM call and, in
  // the adjudicated variant, one provider-model analysis (up to 90 seconds).
  pkg.budgets = variant === "adjudicated"
    ? { maxDurationMs: 420000, maxCostUsd: 1, maxModelCalls: 1, maxCapabilityCalls: 10 }
    : { maxDurationMs: 300000, maxCostUsd: 1, maxModelCalls: 1, maxCapabilityCalls: 8 };
  pkg.modelProfiles = ["model.document.v1"];
  pkg.agentProfiles = [];
  // This pipeline evaluates no acceptance gates; case policy authority remains with its root plan.
  pkg.policies = [];
  pkg.evaluationRequirements = ["document-source-integrity", "document-scope-authority", "document-review-ui"];
  pkg.skillBindings = pkg.skillBindings.filter((binding: any) => archived.includes(binding.skillId));
  const extractor = pkg.skillBindings.find((binding: any) => binding.skillId === archived[1]);
  const archivedHost = extractor.candidates[0];
  const hostId = `skill.${EXTRACTOR[variant]}.v0`;
  Object.assign(extractor, { skillId: EXTRACTOR[variant], semver: entry.semver, manifestDigest: `sha256:${businessSkillManifestDigest(entry.manifest)}`, candidates: [hostId],
    dependencyCapabilities: variant === "adjudicated" ? ["document.fields.extract.v1", "document.model.extract.v1"] : ["document.fields.extract.v1"] });
  for (const binding of pkg.skillBindings) binding.bundleDigest = bundleDigest;
  const hostIds = pkg.skillBindings.flatMap((binding: any) => binding.candidates);
  const host = pkg.capabilities.find((cap: any) => cap.id === archivedHost);
  pkg.capabilities = pkg.capabilities.filter((cap: any) => hostIds.includes(cap.id));
  // The skill's deadline covers its provider calls (the gateway's skills adapter sets it from timeoutMs).
  pkg.capabilities.push({ ...host, id: hostId, adapterBindingId: `skills:${EXTRACTOR[variant]}`, timeoutMs: variant === "adjudicated" ? 270000 : 180000,
    inputSchema: { ...host.inputSchema, properties: { ...host.inputSchema.properties, input: { ...host.inputSchema.properties.input,
      properties: { parameters: (({ $schema: _s, ...rest }) => rest)(entry.manifest.input_schema) } } } },
    outputSchema: { ...host.outputSchema, properties: { ...host.outputSchema.properties, computation: { ...host.outputSchema.properties.computation,
      properties: { payload: (({ $schema: _s, ...rest }) => rest)(entry.manifest.output_schema) } } } } });
  pkg.capabilities.push({ id: "document.evidence.prepare.v1", kind: "tool", effect: "read", adapterBindingId: "evidence:prepare", inputSchema: input, outputSchema: { type: "object" }, timeoutMs: 120000, maxAttempts: 1, idempotent: true });
  if (variant === "adjudicated") pkg.capabilities.push({ id: "document.model.extract.v1", kind: "tool", effect: "read", adapterBindingId: DOCUMENT_MODEL_CONNECTOR, inputSchema: PROVIDER_SCHEMAS["document.model"]!.request, outputSchema: PROVIDER_SCHEMAS["document.model"]!.response, timeoutMs: 90000, maxAttempts: 1, idempotent: true });
  pkg.capabilities.push({ id: "document.fields.extract.v1", kind: "model", effect: "read", adapterBindingId: "openrouter:document_fields.model.document.v1", inputSchema: PROVIDER_SCHEMAS["document.fields"]!.request, outputSchema: PROVIDER_SCHEMAS["document.fields"]!.response, timeoutMs: 150000, maxAttempts: 1, idempotent: true });
  pkg.bindings = { "prepare-document": "document.evidence.prepare.v1" };
  const selectorIds = new Set(["caseId", ...nodes.flatMap((node: any) => node.contextSelectorIds)]);
  pkg.contextSelectors = pkg.contextSelectors.filter((selector: any) => selectorIds.has(selector.id));
  files.set("package.yaml", Buffer.from(stringify(pkg)));
  files.set(pkg.workflow, Buffer.from(stringify(workflow)));
  const result = compilePackage({ files }, { modelProfiles: resolve(root, "config/model-profiles.json") });
  const plan = parseHarnessPlan(result.plan);
  if (!verifyHarnessPlanDigest(plan) || documentExtractionVariant(plan) !== variant) throw new Error("document.extraction_plan_invalid");
  admitHarnessPlanV2(plan);
  return { ...result, plan };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const variant of ["adjudicated", "contract"] as const) {
    const result = buildDocumentExtractionPlan(variant);
    const path = resolve(root, DOCUMENT_PLAN_PATHS[variant]);
    if (process.argv.includes("--check")) {
      if (readFileSync(path, "utf8") !== result.document) throw new Error("document.plan_stale: run pnpm exec tsx scripts/document-extraction-plan.ts");
    } else writeFileSync(path, result.document);
    console.log(`Document extraction plan (${variant}): ${result.planDigest}`);
  }
}
