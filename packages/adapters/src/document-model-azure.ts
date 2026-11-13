import { createHash } from "node:crypto";
import { DOCUMENT_MODEL_FIELDS_CONTRACT, documentModelFieldsSchema, type DocumentModelField, type DocumentModelFields } from "@ehf/contracts";
import { analyzeAzure, AZURE_LAYOUT_API_VERSION, type AzureLayoutOptions } from "./document-layout-azure.js";
// One source with the Document Factory worker (apps/fincrime-host document_factory/prebuilt.py).
import prebuiltRoutes from "./azure-prebuilt-routes.json" with { type: "json" };

/**
 * Route A: Azure Document Intelligence prebuilt extraction models as catalog field candidates.
 *
 * Only catalog types with a prebuilt model available on the resource are routed here (the field maps
 * below were written against prebuilt-idDocument and prebuilt-bankStatement.us results from a live
 * resource, API 2024-11-30; azure-prebuilt-routes.json). Each candidate carries the value in the catalog's form, the text as printed
 * and Azure's confidence; the skill library anchors it on the canonical page text. Types without a
 * prebuilt model (W-9 on this API version, company documents) use custom models, Phase 3.
 */
type Json = Record<string, any>;
type Mapping = { from: string; to: string; kind?: "string" | "date" | "decimal" };

export const AZURE_PREBUILT_ROUTES: Record<string, { model: string; fields: Mapping[]; rows?: { from: string; to: string; members: Mapping[] } }> =
  (prebuiltRoutes as { routes: Record<string, { model: string; fields: Mapping[]; rows?: { from: string; to: string; members: Mapping[] } }> }).routes;

function value(field: Json | undefined, kind: Mapping["kind"]): { value: string; content: string | null } | null {
  if (!field || typeof field !== "object") return null;
  const content = typeof field.content === "string" ? field.content : null;
  let out: unknown;
  if (kind === "date") out = typeof field.valueDate === "string" ? field.valueDate : null;
  else if (kind === "decimal") {
    // Keep the printed digits; drop only currency symbols and thousands separators.
    const printed = content?.replace(/[^\d.\-]/g, "") ?? "";
    out = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(printed) ? printed : typeof field.valueNumber === "number" ? String(field.valueNumber) : null;
  } else out = typeof field.valueString === "string" ? field.valueString : content;
  return typeof out === "string" && out.trim() ? { value: out.trim(), content } : null;
}

const pageOf = (field: Json | undefined): number | null => {
  const page = field?.boundingRegions?.[0]?.pageNumber;
  return Number.isInteger(page) && page > 0 ? page : null;
};
const confidenceOf = (field: Json | undefined): number | null =>
  typeof field?.confidence === "number" && field.confidence >= 0 && field.confidence <= 1 ? field.confidence : null;

/** Azure prebuilt `analyzeResult` → catalog field candidates for one catalog type. Pure. */
export function modelFieldsFromAzure(result: Json, documentType: string, sourceSha256: string): DocumentModelFields {
  const route = AZURE_PREBUILT_ROUTES[documentType];
  if (!route) throw new Error("adapter.document_model_route_unsupported");
  const document = Array.isArray(result.documents) ? result.documents[0] : undefined;
  const fields: Json = document?.fields ?? {};
  const candidates: DocumentModelField[] = [];
  const seen = new Set<string>();
  const add = (path: string, field: Json | undefined, mapping: Mapping, providerField: string) => {
    const read = value(field, mapping.kind);
    if (!read || seen.has(path)) return;
    seen.add(path);
    candidates.push({ path, value: read.value, content: read.content, confidence: confidenceOf(field), page: pageOf(field), transform: null, provider_field: providerField });
  };
  for (const mapping of route.fields) add(`/extracted_fields/${mapping.to}`, fields[mapping.from], mapping, mapping.from);
  const given = value(fields.FirstName, "string"), family = value(fields.LastName, "string");
  if ((documentType === "passport" || documentType === "national_identity_card") && given && family) {
    candidates.push({ path: "/extracted_fields/person_name", value: `${given.value} ${family.value}`, content: null,
      confidence: Math.min(confidenceOf(fields.FirstName) ?? 1, confidenceOf(fields.LastName) ?? 1), page: pageOf(fields.FirstName),
      transform: "join_given_family", provider_field: "FirstName+LastName" });
  }
  if (route.rows) {
    const rows: Json[] = Array.isArray(fields[route.rows.from]?.valueArray) ? fields[route.rows.from].valueArray : [];
    rows.slice(0, 200).forEach((row, index) => {
      const members: Json = row?.valueObject ?? {};
      for (const mapping of route.rows!.members) add(`/extracted_fields/${route.rows!.to}/${index}/${mapping.to}`, members[mapping.from], mapping, `${route.rows!.from}.${mapping.from}`);
      // An account row's holder and institution are the statement's.
      const holder = value(fields.AccountHolderName, "string"), bank = value(fields.BankName, "string");
      if (holder) add(`/extracted_fields/${route.rows!.to}/${index}/holder_name`, fields.AccountHolderName, { from: "AccountHolderName", to: "holder_name" }, "AccountHolderName");
      if (bank) add(`/extracted_fields/${route.rows!.to}/${index}/institution_name`, fields.BankName, { from: "BankName", to: "institution_name" }, "BankName");
    });
  }
  const output = {
    contract: DOCUMENT_MODEL_FIELDS_CONTRACT, provider: "azure_document_intelligence", model: typeof result.modelId === "string" ? result.modelId : route.model,
    model_version: typeof result.apiVersion === "string" ? result.apiVersion : AZURE_LAYOUT_API_VERSION, document_type: documentType,
    source_sha256: sourceSha256, provider_document_type: typeof document?.docType === "string" ? document.docType : null,
    provider_document_confidence: confidenceOf(document), fields: candidates,
  };
  const checked = documentModelFieldsSchema.safeParse(output);
  if (!checked.success) throw new Error("adapter.document_model_result_invalid");
  return checked.data;
}

/** Route A for one original: the catalog type's prebuilt model, mapped to field candidates. */
export async function extractModelFieldsAzure(content: Uint8Array, documentType: string, options: AzureLayoutOptions): Promise<DocumentModelFields> {
  const route = AZURE_PREBUILT_ROUTES[documentType];
  if (!route) throw new Error("adapter.document_model_route_unsupported");
  const sha256 = createHash("sha256").update(content).digest("hex");
  return modelFieldsFromAzure(await analyzeAzure(content, route.model, options), documentType, sha256);
}

/**
 * A Factory-trained (custom or composed) model's `analyzeResult` → catalog field candidates. The Factory labels
 * fields with catalog names (`field`, `field__member`, `rows/<i>/<column>`; apps/fincrime-host document_factory
 * azure_training.label_name), so each maps straight back to a catalog pointer. The library rejects any pointer
 * that is not a leaf of the type's contract, so this mapping need not know the catalog. Pure.
 */
export function modelFieldsFromCustom(result: Json, documentType: string, sourceSha256: string, modelId: string): DocumentModelFields {
  const document = Array.isArray(result.documents) ? result.documents[0] : undefined;
  const fields: Json = document?.fields ?? {};
  const pointer = (label: string) => "/extracted_fields/" + label.split("/").map(part => part.replace(/__/g, "/")).join("/").replace(/\/value$/, "");
  const candidates: DocumentModelField[] = [];
  const add = (label: string, field: Json) => {
    const read = value(field, undefined);
    if (read) candidates.push({ path: pointer(label), value: read.value, content: read.content, confidence: confidenceOf(field), page: pageOf(field), transform: null, provider_field: label });
  };
  for (const [key, field] of Object.entries(fields)) {
    if (!/^[a-z][a-z0-9_]*$/.test(key) || !field || typeof field !== "object") continue;
    if (field.type === "array" && Array.isArray(field.valueArray)) {
      field.valueArray.slice(0, 200).forEach((row: Json, index: number) => {
        for (const [column, cell] of Object.entries(row?.valueObject ?? {})) {
          if (/^[a-z][a-z0-9_]*$/.test(column) && cell && typeof cell === "object") add(`${key}/${index}/${column}`, cell as Json);
        }
      });
    } else add(key, field);
  }
  const output = {
    contract: DOCUMENT_MODEL_FIELDS_CONTRACT, provider: "azure_document_intelligence", model: typeof result.modelId === "string" ? result.modelId : modelId,
    model_version: typeof result.apiVersion === "string" ? result.apiVersion : AZURE_LAYOUT_API_VERSION, document_type: documentType,
    source_sha256: sourceSha256, provider_document_type: typeof document?.docType === "string" ? document.docType : null,
    provider_document_confidence: confidenceOf(document), fields: candidates,
  };
  const checked = documentModelFieldsSchema.safeParse(output);
  if (!checked.success) throw new Error("adapter.document_model_result_invalid");
  return checked.data;
}

/** Route A on a Factory release's model for one original: a custom or composed model, or a released prebuilt one. */
export async function extractReleasedModelFieldsAzure(content: Uint8Array, documentType: string, released: { route: "custom" | "prebuilt"; providerModelId: string }, options: AzureLayoutOptions): Promise<DocumentModelFields> {
  const sha256 = createHash("sha256").update(content).digest("hex");
  if (released.route === "prebuilt") {
    if (!AZURE_PREBUILT_ROUTES[documentType]) throw new Error("adapter.document_model_route_unsupported");
    return modelFieldsFromAzure(await analyzeAzure(content, released.providerModelId, options), documentType, sha256);
  }
  return modelFieldsFromCustom(await analyzeAzure(content, released.providerModelId, options), documentType, sha256, released.providerModelId);
}
