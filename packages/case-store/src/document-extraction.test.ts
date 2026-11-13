import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { documentExtractionVariant, isDocumentExtractionPlan, parseHarnessPlan } from "@ehf/contracts";
import { assertDocumentCommands } from "./document-extraction.js";
const plan = parseHarnessPlan(JSON.parse(readFileSync(new URL("../../../artifacts/document-extraction.plan.json", import.meta.url), "utf8")));
const contractPlan = parseHarnessPlan(JSON.parse(readFileSync(new URL("../../../artifacts/document-extraction-contract.plan.json", import.meta.url), "utf8")));
const scope = { documentId: "doc_selected", documentVersion: "a".repeat(64), evidenceId: "ev_original", planDigest: plan.planDigest, requestKey: "intent" };
it("admits only the bounded document pipeline, including its exact provider and write authority", () => {
  expect(isDocumentExtractionPlan(plan)).toBe(true);
  const disposition = structuredClone(plan); disposition.graph.nodes[1]!.config.caseWrites = [{ commandType: "FinalizeDisposition" }];
  const provider = structuredClone(plan); provider.capabilities.find(cap => cap.kind === "model")!.adapterBindingId = "openrouter:arbitrary-model";
  const context = structuredClone(plan); context.contextSelectors[0]!.path = "$";
  const budget = structuredClone(plan); budget.budgets.maxModelCalls = 20;
  expect([disposition, provider, context, budget].map(isDocumentExtractionPlan)).toEqual([false, false, false, false]);
});
it("admits the adjudicated pipeline and the contract pipeline kept for rollback, each with only its own routes", () => {
  expect([documentExtractionVariant(plan), documentExtractionVariant(contractPlan)]).toEqual(["adjudicated", "contract"]);
  // The model route reads only through the document-model connector, and only in the adjudicated variant.
  const rebound = structuredClone(plan); rebound.capabilities.find(cap => cap.id === "document.model.extract.v1")!.adapterBindingId = "evidence:pages";
  const smuggled = structuredClone(contractPlan); smuggled.capabilities.push(structuredClone(plan.capabilities.find(cap => cap.id === "document.model.extract.v1")!));
  const versions = structuredClone(contractPlan); versions.contextSelectors.push({ ...versions.contextSelectors[0]!, id: "versions", path: "records.DocumentVersion" });
  const slow = structuredClone(contractPlan); slow.budgets.maxDurationMs = 420000;
  expect([rebound, smuggled, versions, slow].map(isDocumentExtractionPlan)).toEqual([false, false, false, false]);
});
it("cannot promote a fact, overwrite a different source, or dispatch another skill through a review work item", () => {
  expect(() => assertDocumentCommands(scope, [{ commandType: "AcceptClaimAsFact", payload: {} }])).toThrow("document.command_not_permitted");
  expect(() => assertDocumentCommands(scope, [{ commandType: "RecordCanonicalRecords", payload: { records: [{ object_type: "ExtractedAssertion", data: { document_version: "b".repeat(64) } }] } }])).toThrow("document.record_outside_scope");
  expect(() => assertDocumentCommands(scope, [{ commandType: "ProposeWorkItem", payload: { workType: "skill_execution", requiredCapability: "skill.decision.disposition.record" } }])).toThrow("document.work_item_outside_scope");
  expect(() => assertDocumentCommands(scope, [{ commandType: "ProposeWorkItem", payload: { workType: "DOCUMENT_FIELD_REVIEW", description: "Compare this value with the original." } }])).not.toThrow();
  const conflict = { workType: "DOCUMENT_FIELD_CONFLICT", description: "The extraction routes disagree." };
  expect(() => assertDocumentCommands(scope, [{ commandType: "ProposeWorkItem", payload: { ...conflict, subjectRef: `extraction:${"a".repeat(24)}:document_number` } }])).not.toThrow();
  // A conflict names an assertion of the selected version; no other work item names anything.
  expect(() => assertDocumentCommands(scope, [{ commandType: "ProposeWorkItem", payload: conflict }])).toThrow("document.work_item_outside_scope");
  expect(() => assertDocumentCommands(scope, [{ commandType: "ProposeWorkItem", payload: { ...conflict, subjectRef: `extraction:${"b".repeat(24)}:document_number` } }])).toThrow("document.work_item_outside_scope");
  expect(() => assertDocumentCommands(scope, [{ commandType: "ProposeWorkItem", payload: { workType: "DOCUMENT_FIELD_REVIEW", description: "x", subjectRef: "case:other" } }])).toThrow("document.work_item_outside_scope");
});
