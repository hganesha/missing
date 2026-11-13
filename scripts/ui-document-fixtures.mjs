#!/usr/bin/env node
// Builds the mock's case-document fixture (packages/fincrime-views/src/fixtures/documents.kyb-1042.json)
// from the document field catalog's golden examples (apps/fincrime-host/examples/documents): canonical
// records shaped as the platform stores them (DocumentVersion, DocumentPage, ExtractedAssertion with the
// ehf.document extension) and the document skills' outputs. Deterministic; synthetic data only.
//
//   node scripts/ui-document-fixtures.mjs [--check]
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomic } from './lib/write-atomic.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const out = resolve(repoRoot, "packages/fincrime-views/src/fixtures/documents.kyb-1042.json");
const examples = resolve(repoRoot, "apps/fincrime-host/examples/documents");
const SCALAR = new Set(["text", "identifier", "decimal", "percentage", "date", "datetime", "boolean", "integer"]);
const library = JSON.parse(readFileSync(resolve(repoRoot, "apps/fincrime-host/src/kyc_documents/resources/field-library.json"), "utf8"));
const fieldTypes = new Map(library.fields.map((field) => [field.name, field.value_type]));
const sha = (value) => createHash("sha256").update(value).digest("hex");

const documents = [
  { file: "shareholder_register", filename: "meridian-shareholder-register.txt" },
  { file: "passport", filename: "director-passport.txt" },
  { file: "bank_statement", filename: "operating-account-statement.txt" },
];
const records = [];
const workItems = [];
// The passport went through both extraction routes in shadow (document factory plan Phase 4): the routes agree on
// every field except the date of birth, where the model route read another date printed on the page.
const ROUTE_READINGS = { passport: { date_of_birth: "2030-05-31" } };
const adjudication = (value, other) => ({ schema_version: "1.0.0", value: {
  route_mode: "shadow", proposed_route: "llm", routes: { azure_di: "valid", llm: "valid" }, route_errors: {},
  outcome: other === undefined ? "AGREED_GROUNDED" : "CONFLICT", rule: other === undefined ? "R1" : "R6", review: other === undefined ? "standard" : "required",
  criticality: "material", comparison: other === undefined ? "equivalent" : "different", selected_route: other === undefined ? "llm" : null,
  candidates: { azure_di: { value: other ?? value, grounded: true, confidence: 0.91 }, llm: { value, grounded: true, confidence: null } },
  policy_digest: sha("ehf.default-adjudication"), route_policy_digest: sha("ehf.default-routes@0.1.0"), inputs_digest: sha(`inputs:${value}:${other ?? value}`) } });
const classifications = [];
const extractions = [];
for (const item of documents) {
  const example = JSON.parse(readFileSync(resolve(examples, `${item.file}.json`), "utf8"));
  const text = example.pages.map((page) => page.text).join("\n\n");
  const version = sha(text);
  const documentId = `doc_${version.slice(0, 24)}`;
  records.push({ object_type: "DocumentVersion", object_id: documentId, version_id: "v1", synthetic: true, data: {
    document_id: documentId, artifact_hash: version, media_type: "text/plain", artifact_ref: `kyc-evidence-pipeline:${documentId}`, page_count: example.pages.length,
    extensions: { "ehf.connector": { schema_version: "1.0.0", value: { filename: item.filename, format: "txt", page_count_basis: "decoded_pages" } } } } });
  const pageIds = new Map();
  example.pages.forEach((page, index) => {
    const objectId = `page:${documentId}:${index + 1}`;
    pageIds.set(page.page_id, objectId);
    records.push({ object_type: "DocumentPage", object_id: objectId, version_id: "v1", synthetic: true,
      data: { text: page.text, page: index + 1, document_version: version, extensions: { "ehf.connector": { schema_version: "1.0.0", value: { text_basis: "full_text", document_id: documentId } } } } });
  });
  const observations = new Map(example.result.observations.map((observation) => [observation.path, observation]));
  for (const [field, value] of Object.entries(example.result.extracted_fields)) {
    if (value === null || !SCALAR.has(fieldTypes.get(field))) continue;
    const observation = observations.get(`/extracted_fields/${field}`);
    if (!observation || observation.status !== "present") continue;
    const objectId = `extraction:${version.slice(0, 24)}:${field}`;
    const readings = ROUTE_READINGS[item.file];
    records.push({ object_type: "ExtractedAssertion", object_id: objectId, version_id: "v1", synthetic: true, data: {
      subject: "subject-meridian", field, value, document_version: version, extensions: { "ehf.document": { schema_version: "1.0.0", value: {
        path: `/extracted_fields/${field}`, document_type: example.result.document_type, contract_hash: example.result.contract_hash,
        source_digest: example.result.source_digest, epistemic_status: "EXTRACTED_ASSERTION", verification: "UNVERIFIED", review_state: "PENDING_REVIEW",
        source_spans: observation.spans.map((span) => ({ ...span, page_id: pageIds.get(span.page_id) })) } },
        ...(readings ? { "ehf.document.adjudication": adjudication(value, readings[field]) } : {}) } } });
    if (readings?.[field] !== undefined) workItems.push({ work_item_id: `work_skill_${sha(objectId).slice(0, 24)}`, work_type: "DOCUMENT_FIELD_CONFLICT", status: "OPEN",
      description: `The extraction routes disagree on ${field} in the Passport (${version.slice(0, 12)}) (CONFLICT; azure_di: '${readings[field]}'; llm: '${value}'). Check the source before the value is used.`,
      subject_ref: objectId, created_at: "2026-11-13T09:00:00.000Z" });
  }
  classifications.push({ document_version: version, document_type: example.result.document_type, basis: "title" });
  extractions.push({ document_version: version, extraction_status: "NEEDS_REVIEW" });
}
const present = new Set(classifications.map((item) => item.document_type));
const groups = [
  { id: "EVD-BUSINESS-REGISTRATION", description: "Evidence of legal existence and registration", any_of: ["certificate_of_incorporation", "company_registry_extract"] },
  { id: "EVD-BENEFICIAL-OWNERSHIP", description: "Evidence of ownership and beneficial owners", any_of: ["beneficial_ownership_declaration", "shareholder_register"] },
  { id: "EVD-DIRECTOR-IDENTITY", description: "Government identity document of a director", any_of: ["national_identity_card", "passport"] },
].map((group) => {
  const satisfiedBy = group.any_of.filter((type) => present.has(type));
  return { ...group, satisfied_by: satisfiedBy, satisfied: satisfiedBy.length > 0 };
});
const fixture = {
  caseId: "KYB-1042",
  records,
  workItems,
  outputs: {
    classifications, extractions,
    requirements: { requirements: groups, request_types: [...new Set(groups.filter((group) => !group.satisfied).flatMap((group) => group.any_of))] },
    validity: classifications.filter((item) => item.document_type === "passport").map((item) => ({ document_version: item.document_version, status: "CURRENT" })),
    conflicts: [],
  },
};
const content = `${JSON.stringify(fixture, null, 2)}\n`;
const current = existsSync(out) ? readFileSync(out, "utf8") : null;
if (current === content) process.stdout.write("document fixture is current\n");
else if (check) { process.stderr.write("document fixture is stale; run node scripts/ui-document-fixtures.mjs\n"); process.exit(1); }
else { writeFileAtomic(out, content); process.stdout.write(`wrote ${out.slice(repoRoot.length + 1)}: ${records.length} records\n`); }
