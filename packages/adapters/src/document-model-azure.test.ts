import { describe, expect, it } from "vitest";
import { documentModelFieldsSchema } from "@ehf/contracts";
import { analyzeAzure } from "./document-layout-azure.js";
import { extractModelFieldsAzure, modelFieldsFromAzure, modelFieldsFromCustom } from "./document-model-azure.js";

const SHA = "a".repeat(64);
const field = (type: string, content: string, confidence: number, extra: Record<string, unknown> = {}) =>
  ({ type, content, confidence, boundingRegions: [{ pageNumber: 1, polygon: [1, 1, 2, 1, 2, 2, 1, 2] }], ...extra });

/** Shaped like prebuilt-idDocument results from a live resource (API 2024-11-30) on synthetic renderings. */
const ID_RESULT = { apiVersion: "2024-11-30", modelId: "prebuilt-idDocument", documents: [{ docType: "idDocument.nationalIdentityCard", confidence: 1, fields: {
  DocumentNumber: field("string", "SYN6194049", 0.8, { valueString: "SYN6194049" }),
  FirstName: field("string", "Alex", 0.676, { valueString: "Alex" }),
  LastName: field("string", "Alex Example\nExample", 0.402, { valueString: "Alex Example Example" }),
  DateOfBirth: field("date", "1951-05-29", 0.783, { valueDate: "1951-05-29" }),
  DateOfExpiration: field("date", "2034-12-02", 0.664, { valueDate: "2034-12-02" }),
} }] };
const BANK_RESULT = { apiVersion: "2024-11-30", modelId: "prebuilt-bankStatement.us", documents: [{ docType: "bankStatement.us", confidence: 1, fields: {
  StatementStartDate: field("date", "2026-09-01", 0.417, { valueDate: "2026-09-01" }),
  StatementEndDate: field("date", "2026-09-30", 0.463, { valueDate: "2026-09-30" }),
  Accounts: { type: "array", valueArray: [{ type: "object", valueObject: {
    AccountNumber: field("string", "SYN-29720131", 0.738, { valueString: "SYN-29720131" }),
    BeginningBalance: field("number", "£8,042.22", 0.74, { valueNumber: 8042.22 }),
    EndingBalance: field("number", "389.75", 0.739, { valueNumber: 389.75 }),
  } }] },
} }] };

describe("Azure prebuilt field candidates", () => {
  it("maps an identity card to catalog leaves, keeping the printed text and Azure's confidence", () => {
    const out = modelFieldsFromAzure(ID_RESULT, "national_identity_card", SHA);
    expect(documentModelFieldsSchema.parse(out)).toEqual(out);
    expect(out).toMatchObject({ contract: "document.model_fields.v1", provider_document_type: "idDocument.nationalIdentityCard", source_sha256: SHA });
    const byPath = Object.fromEntries(out.fields.map(f => [f.path, f]));
    expect(byPath["/extracted_fields/identity_number"]).toMatchObject({ value: "SYN6194049", confidence: 0.8, provider_field: "DocumentNumber", page: 1 });
    expect(byPath["/extracted_fields/family_name"]).toMatchObject({ value: "Alex Example Example", content: "Alex Example\nExample", confidence: 0.402 });
    expect(byPath["/extracted_fields/person_name"]).toMatchObject({ value: "Alex Alex Example Example", transform: "join_given_family", content: null });
    expect(byPath["/extracted_fields/document_number"]).toBeUndefined();
  });

  it("puts a passport's number in document_number", () => {
    const byPath = Object.fromEntries(modelFieldsFromAzure(ID_RESULT, "passport", SHA).fields.map(f => [f.path, f]));
    expect(byPath["/extracted_fields/document_number"]?.value).toBe("SYN6194049");
  });

  it("maps bank statement accounts to rows and keeps printed digits for balances", () => {
    const out = modelFieldsFromAzure(BANK_RESULT, "bank_statement", SHA);
    const byPath = Object.fromEntries(out.fields.map(f => [f.path, f]));
    expect(byPath["/extracted_fields/accounts/0/account_identifier"]?.value).toBe("SYN-29720131");
    expect(byPath["/extracted_fields/accounts/0/opening_balance"]?.value).toBe("8042.22");
    expect(byPath["/extracted_fields/period_end"]?.value).toBe("2026-09-30");
  });

  it("refuses a type with no prebuilt route and an invalid model id", async () => {
    expect(() => modelFieldsFromAzure(ID_RESULT, "w9", SHA)).toThrow("adapter.document_model_route_unsupported");
    await expect(extractModelFieldsAzure(new Uint8Array([1]), "certificate_of_incorporation", { endpoint: "https://x.cognitiveservices.azure.com", auth: { kind: "api_key", key: "k" } }))
      .rejects.toThrow("adapter.document_model_route_unsupported");
    await expect(analyzeAzure(new Uint8Array([1]), "prebuilt-../../x", { endpoint: "https://x.cognitiveservices.azure.com", auth: { kind: "api_key", key: "k" } }))
      .rejects.toThrow("adapter.document_layout_model_invalid");
  });
});

describe("modelFieldsFromCustom", () => {
  it("maps Factory labels back to catalog pointers and drops what is not a label", () => {
    const result = { modelId: "ehf-release-1", apiVersion: "2024-11-30", documents: [{ docType: "ehf-w9", confidence: 0.9, fields: {
      person_name: { type: "string", valueString: "Ana Ruiz", content: "Ana Ruiz", confidence: 0.98, boundingRegions: [{ pageNumber: 1 }] },
      registered_address__line1: { type: "string", content: "1 Main St", confidence: 0.9 },
      accounts: { type: "array", valueArray: [{ type: "object", valueObject: { account_number: { type: "string", valueString: "123", confidence: 0.8 } } }] },
      "Not A Label": { type: "string", valueString: "x" },
      tax_id: { type: "string" },
    } }] };
    const out = modelFieldsFromCustom(result, "w9", "a".repeat(64), "ehf-release-1");
    expect(out.model).toBe("ehf-release-1");
    expect(out.fields.map(f => [f.path, f.value, f.provider_field])).toEqual([
      ["/extracted_fields/person_name", "Ana Ruiz", "person_name"],
      ["/extracted_fields/registered_address/line1", "1 Main St", "registered_address__line1"],
      ["/extracted_fields/accounts/0/account_number", "123", "accounts/0/account_number"],
    ]);
  });
});
