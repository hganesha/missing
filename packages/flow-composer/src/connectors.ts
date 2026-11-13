// @ts-nocheck -- plain data and one node builder, ported verbatim from scripts/lib/kyb-connectors.mjs.
// KYB connector acquisition stages, shared by domains/archive/kyb-deterministic (scripts/sync-kyb-package.mjs) and the
// production slice domains/kyb-screening (scripts/sync-kyb-screening-package.mjs). Each connector
// acquires one kind of data, keeps the provider output as evidence and writes the normalized
// canonical records; an outcome that established nothing writes an EVIDENCE_GAP finding instead
// (canonical-records.ts never emits an empty "clear" record).
export const wiringOutput = {
  type: "object",
  required: ["operationId", "outcome", "bankDecision", "coverage", "evidenceRefs", "warnings", "records", "recordGap"],
  properties: {
    operationId: { type: "string" },
    outcome: { type: "string", enum: ["passed", "failed", "review", "resubmit", "inconclusive", "not_checked", "not_applicable", "unknown"] },
    bankDecision: { type: "string", const: "not_evaluated" },
    coverage: { type: "object" },
    evidenceRefs: { type: "array", items: { type: "object" } },
    warnings: { type: "array", items: { type: "string" } },
    records: { type: "array", items: { type: "object" } },
    recordGap: { type: ["object", "null"] },
  },
};
export const subjectInput = { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1 }, country: { type: "string" }, registrationNumber: { type: "string" }, lei: { type: "string" } } };
export const subjectSelectors = ["name", "country", "registrationNumber", "lei"];
export const connectors = [
  { id: "acquire-registry", stage: "identity", capability: "business.registry.lookup.v1", connector: "wiring:companies-house:business.registry.lookup", records: "RegistryRecord, Entity, Party", purpose: "KYB_REGISTRY_LOOKUP", name: "Company registry lookup", input: subjectInput, output: wiringOutput, timeoutMs: 30000 },
  { id: "acquire-lei", stage: "identity", capability: "reference.identifier.lookup.v1", connector: "wiring:gleif:reference.identifier.lookup", records: "Entity", purpose: "KYB_LEI_LOOKUP", name: "LEI lookup", input: subjectInput, output: wiringOutput, timeoutMs: 30000 },
  { id: "acquire-officers", stage: "identity", capability: "business.officers.lookup.v1", connector: "wiring:companies-house:business.officers.lookup", records: "Entity, OfficerRole", purpose: "KYB_OFFICERS_LOOKUP", name: "Officers lookup", input: subjectInput, output: wiringOutput, timeoutMs: 30000 },
  { id: "acquire-ownership", stage: "identity", capability: "business.ownership.discover.v1", connector: "wiring:opencorporates:business.ownership.discover", records: "OwnershipInterest, ControlRight, Entity", purpose: "KYB_OWNERSHIP_DISCOVERY", name: "Ownership discovery", input: subjectInput, output: wiringOutput, timeoutMs: 30000 },
  { id: "acquire-documents", stage: "identity", capability: "document.evidence.package.v1", connector: "evidence:package", records: "DocumentVersion, DocumentPage, Evidence", purpose: "KYB_DOCUMENT_EVIDENCE", name: "Document evidence package", selectors: ["caseId"],
    input: { type: "object", required: ["caseId"], properties: { caseId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$" } } },
    output: { type: "object", required: ["operation", "status", "bankDecision", "data", "records", "recordGap"], properties: { operation: { type: "string" }, status: { type: "string" }, bankDecision: { type: "string", const: "not_evaluated" }, data: { type: "object" }, records: { type: "array", items: { type: "object" } }, recordGap: { type: ["object", "null"] } } },
    timeoutMs: 30000 },
  { id: "acquire-sanctions", stage: "screening", capability: "screening.sanctions.v1", connector: "opensanctions:sanctions", records: "WatchlistEntry, ScreeningHit or NegativeSearchEvidence", purpose: "KYB_SANCTIONS_SCREENING", name: "OpenSanctions sanctions screen", selectors: ["name", "country"],
    input: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1 }, country: { type: "string" } } },
    output: { type: "object", required: ["status", "provider", "screeningType", "screenedAt", "alerts", "records", "recordGap"], properties: { status: { type: "string" }, provider: { type: "string" }, screeningType: { type: "string", const: "SANCTIONS" }, screenedAt: { type: "string", format: "date-time" }, alerts: { type: "array", items: { type: "object" } }, records: { type: "array", items: { type: "object" } }, recordGap: { type: ["object", "null"] } } },
    timeoutMs: 15000 },
  { id: "acquire-pep", stage: "screening", capability: "screening.pep.v1", connector: "opensanctions:pep", records: "WatchlistEntry, ScreeningHit or NegativeSearchEvidence", purpose: "KYB_PEP_SCREENING", name: "OpenSanctions PEP screen", selectors: ["name", "country"],
    input: { type: "object", required: ["name"], properties: { name: { type: "string", minLength: 1 }, country: { type: "string" } } },
    output: { type: "object", required: ["status", "provider", "screeningType", "screenedAt", "alerts", "records", "recordGap"], properties: { status: { type: "string" }, provider: { type: "string" }, screeningType: { type: "string", const: "PEP" }, screenedAt: { type: "string", format: "date-time" }, alerts: { type: "array", items: { type: "object" } }, records: { type: "array", items: { type: "object" } }, recordGap: { type: ["object", "null"] } } },
    timeoutMs: 15000 },
  { id: "acquire-adverse-media", stage: "screening", capability: "screening.adverse_media.v1", connector: "wiring:complyadvantage:screening.adverse_media", records: "AdverseMediaEvent or NegativeSearchEvidence", purpose: "KYB_ADVERSE_MEDIA", name: "Adverse-media screen", selectors: ["name", "country"], input: subjectInput, output: wiringOutput, timeoutMs: 30000 },
];

export function connectorNode(connector) {
  return {
    id: connector.id, kind: "tool", name: connector.name,
    summary: `Acquire through ${connector.connector}; write the normalized ${connector.records} records, or an evidence gap when the check established nothing.`,
    contextSelectorIds: connector.stage === "screening" ? ["kybSubjects", "screeningEntities"] : connector.selectors ?? subjectSelectors,
    capabilities: { tools: [connector.capability] },
    config: {
      ...(connector.stage === "screening" ? { subjectAcquisition: { subjectsSelector: "kybSubjects", entitiesSelector: "screeningEntities", maxSubjects: 50 } } : {}),
      evidenceCapture: { type: `kyb_${connector.id.replaceAll("-", "_")}`, sourceType: "TOOL", trustTier: "VERIFIED_PROVIDER", instructionTrust: "UNTRUSTED_EXTERNAL" },
      caseWriteActor: "system",
      caseWritePrincipalId: "kyb-connector-normalizer",
      caseWrites: [
        { commandType: "LinkEvidence", payload: { evidenceId: "{{ evidence.evidenceId }}", purpose: connector.purpose }, payloadSchema: { type: "object", required: ["evidenceId", "purpose"] } },
        { commandType: "RecordCanonicalRecords", when: "output.records.0", payload: { records: "{{ output.records }}", evidenceRefs: ["{{ evidence.evidenceId }}"] }, payloadSchema: { type: "object", required: ["records", "evidenceRefs"] } },
        {
          commandType: "RecordScreeningFinding", when: "output.recordGap",
          payload: {
            findingId: `finding_evidence_gap_${connector.id.replaceAll("-", "_")}_{{ run.runId }}`, findingType: "EVIDENCE_GAP", classification: "REVIEW",
            confidence: { value: 1, method: "connector_outcome" }, reason: "{{ output.recordGap.reason }}", evidenceRefs: ["{{ evidence.evidenceId }}"], factRefs: [], policyRelevance: "KYB-EVIDENCE",
          },
          payloadSchema: { type: "object", required: ["findingId", "findingType", "reason", "evidenceRefs"] },
        },
      ],
    },
  };
}

