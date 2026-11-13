// The library's twelve provider capabilities: nine canonical, plus document.fields, document.model and
// document.ocr for the EHF document wrapper skills (schemas vendored by scripts/sync-library-contracts.mjs).
import document_entities_request from "./vendor/providers/document.entities.request.schema.json" with { type: "json" };
import document_entities_response from "./vendor/providers/document.entities.response.schema.json" with { type: "json" };
import document_fields_request from "./vendor/providers/document.fields.request.schema.json" with { type: "json" };
import document_fields_response from "./vendor/providers/document.fields.response.schema.json" with { type: "json" };
import document_model_request from "./vendor/providers/document.model.request.schema.json" with { type: "json" };
import document_model_response from "./vendor/providers/document.model.response.schema.json" with { type: "json" };
import document_ocr_request from "./vendor/providers/document.ocr.request.schema.json" with { type: "json" };
import document_ocr_response from "./vendor/providers/document.ocr.response.schema.json" with { type: "json" };
import document_forensics_request from "./vendor/providers/document.forensics.request.schema.json" with { type: "json" };
import document_forensics_response from "./vendor/providers/document.forensics.response.schema.json" with { type: "json" };
import document_translate_request from "./vendor/providers/document.translate.request.schema.json" with { type: "json" };
import document_translate_response from "./vendor/providers/document.translate.response.schema.json" with { type: "json" };
import fraud_account_takeover_request from "./vendor/providers/fraud.account_takeover.request.schema.json" with { type: "json" };
import fraud_account_takeover_response from "./vendor/providers/fraud.account_takeover.response.schema.json" with { type: "json" };
import fraud_deepfake_request from "./vendor/providers/fraud.deepfake.request.schema.json" with { type: "json" };
import fraud_deepfake_response from "./vendor/providers/fraud.deepfake.response.schema.json" with { type: "json" };
import fraud_document_tamper_request from "./vendor/providers/fraud.document_tamper.request.schema.json" with { type: "json" };
import fraud_document_tamper_response from "./vendor/providers/fraud.document_tamper.response.schema.json" with { type: "json" };
import fraud_identity_theft_request from "./vendor/providers/fraud.identity_theft.request.schema.json" with { type: "json" };
import fraud_identity_theft_response from "./vendor/providers/fraud.identity_theft.response.schema.json" with { type: "json" };
import fraud_liveness_request from "./vendor/providers/fraud.liveness.request.schema.json" with { type: "json" };
import fraud_liveness_response from "./vendor/providers/fraud.liveness.response.schema.json" with { type: "json" };
import fraud_synthetic_identity_request from "./vendor/providers/fraud.synthetic_identity.request.schema.json" with { type: "json" };
import fraud_synthetic_identity_response from "./vendor/providers/fraud.synthetic_identity.response.schema.json" with { type: "json" };

type JsonSchema = Record<string, unknown>;

/**
 * CR-8: the library's provider capability names and the platform capability each maps to
 * (`<namespace>.<subject>[.<action>].v<major>`, docs/implementation/capability-naming.md). The
 * library validates the request before dispatch and the response before use against
 * `PROVIDER_SCHEMAS`; the platform connector must produce exactly that response shape.
 */
export type LibraryCapability = {
  /** The library's capability name (`Provider.invoke(capability, …)`). */
  library: string;
  /** Platform capability id served through the gateway. */
  capabilityId: string;
  kind: "model" | "provider";
  /** The library skill that depends on it. */
  skillId: string;
};

export const LIBRARY_CAPABILITIES: readonly LibraryCapability[] = Object.freeze([
  { library: "document.entities", capabilityId: "document.entities.extract.v1", kind: "model", skillId: "document.entities.extract" },
  { library: "document.fields", capabilityId: "document.fields.extract.v1", kind: "model", skillId: "document.fields.contract_extract" },
  { library: "document.forensics", capabilityId: "document.forensics.assess.v1", kind: "provider", skillId: "document.authenticity.assess" },
  { library: "document.model", capabilityId: "document.model.extract.v1", kind: "provider", skillId: "document.fields.adjudicated_extract" },
  { library: "document.ocr", capabilityId: "document.ocr.extract.v1", kind: "provider", skillId: "document.parse.artifact" },
  { library: "document.translate", capabilityId: "document.translate.v1", kind: "model", skillId: "document.translation.normalize" },
  { library: "fraud.account_takeover", capabilityId: "fraud.account_takeover.v1", kind: "provider", skillId: "fraud.account_takeover.detect" },
  { library: "fraud.deepfake", capabilityId: "fraud.media.deepfake.v1", kind: "provider", skillId: "fraud.deepfake.detect" },
  { library: "fraud.document_tamper", capabilityId: "fraud.document.tamper.v1", kind: "provider", skillId: "fraud.document.tamper.detect" },
  { library: "fraud.identity_theft", capabilityId: "fraud.identity.theft.v1", kind: "provider", skillId: "fraud.identity.theft.assess" },
  { library: "fraud.liveness", capabilityId: "identity.biometric.verify.v1", kind: "provider", skillId: "fraud.liveness.verify" },
  { library: "fraud.synthetic_identity", capabilityId: "fraud.identity.synthetic.v1", kind: "provider", skillId: "fraud.identity.synthetic.detect" },
]);

export const PROVIDER_SCHEMAS: Readonly<Record<string, { request: JsonSchema; response: JsonSchema }>> = Object.freeze({
  "document.entities": { request: document_entities_request as JsonSchema, response: document_entities_response as JsonSchema },
  "document.fields": { request: document_fields_request as JsonSchema, response: document_fields_response as JsonSchema },
  "document.forensics": { request: document_forensics_request as JsonSchema, response: document_forensics_response as JsonSchema },
  "document.model": { request: document_model_request as JsonSchema, response: document_model_response as JsonSchema },
  "document.ocr": { request: document_ocr_request as JsonSchema, response: document_ocr_response as JsonSchema },
  "document.translate": { request: document_translate_request as JsonSchema, response: document_translate_response as JsonSchema },
  "fraud.account_takeover": { request: fraud_account_takeover_request as JsonSchema, response: fraud_account_takeover_response as JsonSchema },
  "fraud.deepfake": { request: fraud_deepfake_request as JsonSchema, response: fraud_deepfake_response as JsonSchema },
  "fraud.document_tamper": { request: fraud_document_tamper_request as JsonSchema, response: fraud_document_tamper_response as JsonSchema },
  "fraud.identity_theft": { request: fraud_identity_theft_request as JsonSchema, response: fraud_identity_theft_response as JsonSchema },
  "fraud.liveness": { request: fraud_liveness_request as JsonSchema, response: fraud_liveness_response as JsonSchema },
  "fraud.synthetic_identity": { request: fraud_synthetic_identity_request as JsonSchema, response: fraud_synthetic_identity_response as JsonSchema },
});
