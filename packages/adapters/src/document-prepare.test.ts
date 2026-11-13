import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { DocumentLayout } from "@ehf/contracts";
import { azureManagedIdentityToken, documentModelProviderFromEnv, layoutProviderFromEnv, prepareDocument, type LayoutProvider } from "./document-prepare.js";

const PIPELINE = { baseUrl: "http://evidence-pipeline:8080/", token: "evidence-token" };
const bytes = (text: string) => Buffer.from(text);
const sha = (text: string) => createHash("sha256").update(bytes(text)).digest("hex");
const input = (filename: string, text: string) => ({ caseId: "case-1", documentId: `doc_${sha(text).slice(0, 24)}`, documentVersion: sha(text),
  evidenceId: "ev-1", filename, contentBase64: bytes(text).toString("base64") });
const layout = (text: string): DocumentLayout => ({ contract: "document.layout.v1", provider: "azure_document_intelligence", model: "prebuilt-layout",
  model_version: "2024-11-30", source_sha256: sha(text), pages: [{ page: 1, width: 8.5, height: 11, unit: "inch" }],
  blocks: [{ kind: "paragraph", page: 1, text: "Recognized text", bbox: [1, 1, 3, 2] }] });
const prepared = (documentId: string, version: string, extra: Record<string, unknown> = {}) => ({ case_id: "case-1", status: "PREPARED",
  documents: [{ document_id: documentId, sha256: version, filename: "f", format: "pdf", page_count: 1 }],
  pages: [{ document_id: documentId, page: 1, text: "Recognized text", segments: [] }], evidence: [], ...extra });

function pipeline(responses: Array<Record<string, unknown>>) {
  const bodies: Array<Record<string, unknown>> = [];
  const fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response(JSON.stringify(responses.shift()), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, bodies };
}
const provider = (analyzed: Uint8Array[]): LayoutProvider => ({ id: "azure_document_intelligence", analyze: async (content) => { analyzed.push(content); return layout(Buffer.from(content).toString()); } });

describe("document preparation with a layout provider", () => {
  it("sends an image to the layout provider first and prepares from its canonical layout", async () => {
    const doc = input("scan.png", "image bytes");
    const { fetch, bodies } = pipeline([prepared(doc.documentId, doc.documentVersion)]);
    const analyzed: Uint8Array[] = [];
    const result = await prepareDocument({ ...PIPELINE, input: doc, fetch }, provider(analyzed));
    expect(Buffer.from(analyzed[0]!).toString()).toBe("image bytes");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.layout).toMatchObject({ contract: "document.layout.v1", source_sha256: doc.documentVersion });
    expect(result.output).toMatchObject({ layout: { provider: "azure_document_intelligence", model: "prebuilt-layout", reason: "image" } });
  });

  it("fails closed for an image when no provider is configured", async () => {
    const { fetch, bodies } = pipeline([]);
    await expect(prepareDocument({ ...PIPELINE, input: input("scan.jpg", "x"), fetch }, null)).rejects.toThrow("adapter.document_layout_not_configured");
    expect(bodies).toHaveLength(0);
  });

  it("keeps a native result unless the pipeline recommends layout", async () => {
    const doc = input("born-digital.pdf", "pdf bytes");
    const { fetch, bodies } = pipeline([prepared(doc.documentId, doc.documentVersion, { layout_recommended: false })]);
    const analyzed: Uint8Array[] = [];
    const result = await prepareDocument({ ...PIPELINE, input: doc, fetch }, provider(analyzed));
    expect(analyzed).toHaveLength(0);
    expect(bodies).toHaveLength(1);
    expect((result.output as Record<string, unknown>).layout).toBeUndefined();
  });

  it("re-prepares a text-poor PDF from layout, or flags it when no provider is bound", async () => {
    const doc = input("scan.pdf", "pdf scan");
    const first = pipeline([prepared(doc.documentId, doc.documentVersion, { layout_recommended: true }), prepared(doc.documentId, doc.documentVersion)]);
    const analyzed: Uint8Array[] = [];
    const result = await prepareDocument({ ...PIPELINE, input: doc, fetch: first.fetch }, provider(analyzed));
    expect(first.bodies.map(b => "layout" in b)).toEqual([false, true]);
    expect(result.output).toMatchObject({ layout: { reason: "native_text_insufficient" } });
    const unbound = pipeline([prepared(doc.documentId, doc.documentVersion, { layout_recommended: true })]);
    const flagged = await prepareDocument({ ...PIPELINE, input: doc, fetch: unbound.fetch }, null);
    expect(flagged.output).toMatchObject({ layout: { provider: null, recommended: true } });
  });

  it("refuses a layout that is not bound to the document's bytes", async () => {
    const doc = input("scan.png", "image bytes");
    const { fetch } = pipeline([prepared(doc.documentId, doc.documentVersion)]);
    const wrong: LayoutProvider = { id: "azure_document_intelligence", analyze: async () => layout("other bytes") };
    await expect(prepareDocument({ ...PIPELINE, input: doc, fetch }, wrong)).rejects.toThrow("adapter.evidence_pipeline_layout_invalid");
  });
});

describe("layout provider configuration", () => {
  const azure = { DOCUMENT_LAYOUT_PROVIDER: "azure_document_intelligence", AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://ehf-docs.cognitiveservices.azure.com" };
  it("is off by default and needs explicit consent to send documents to a remote provider", () => {
    expect(layoutProviderFromEnv({})).toBeNull();
    expect(layoutProviderFromEnv(azure)).toBeNull();
    expect(layoutProviderFromEnv({ ...azure, DOCUMENT_LAYOUT_REMOTE_ALLOWED: "true" })?.id).toBe("azure_document_intelligence");
  });
  it("refuses an unknown provider, a bad endpoint or a missing key", () => {
    expect(() => layoutProviderFromEnv({ DOCUMENT_LAYOUT_PROVIDER: "other" })).toThrow("adapter.document_layout_provider_unsupported");
    expect(() => layoutProviderFromEnv({ ...azure, DOCUMENT_LAYOUT_REMOTE_ALLOWED: "true", AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://example.com" })).toThrow("adapter.document_layout_endpoint_invalid");
    expect(() => layoutProviderFromEnv({ ...azure, DOCUMENT_LAYOUT_REMOTE_ALLOWED: "true", AZURE_DOCUMENT_INTELLIGENCE_AUTH: "key" })).toThrow("adapter.document_layout_credential_missing");
    expect(layoutProviderFromEnv({ ...azure, DOCUMENT_LAYOUT_REMOTE_ALLOWED: "true", AZURE_DOCUMENT_INTELLIGENCE_AUTH: "key", AZURE_DOCUMENT_INTELLIGENCE_KEY: "k" })).not.toBeNull();
  });
});

describe("extraction model provider configuration (Route A)", () => {
  const azure = { DOCUMENT_MODEL_PROVIDER: "azure_document_intelligence", AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT: "https://ehf-docs.cognitiveservices.azure.com",
    AZURE_DOCUMENT_INTELLIGENCE_AUTH: "key", AZURE_DOCUMENT_INTELLIGENCE_KEY: "k" };
  it("is off by default and needs its own consent; the layout consent does not cover it", () => {
    expect(documentModelProviderFromEnv({})).toBeNull();
    expect(documentModelProviderFromEnv({ ...azure, DOCUMENT_LAYOUT_REMOTE_ALLOWED: "true" })).toBeNull();
    expect(() => documentModelProviderFromEnv({ DOCUMENT_MODEL_PROVIDER: "other" })).toThrow("adapter.document_model_provider_unsupported");
  });
  it("supports only the types with a prebuilt route and sends the original to that type's model", async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(String(url));
      if (String(url).includes(":analyze")) return new Response(null, { status: 202, headers: { "operation-location": "https://ehf-docs.cognitiveservices.azure.com/documentintelligence/documentModels/prebuilt-idDocument/analyzeResults/1" } });
      return new Response(JSON.stringify({ status: "succeeded", analyzeResult: { apiVersion: "2024-11-30", modelId: "prebuilt-idDocument", documents: [{ docType: "idDocument.passport", confidence: 0.9,
        fields: { DocumentNumber: { type: "string", content: "P123", valueString: "P123", confidence: 0.8, boundingRegions: [{ pageNumber: 1 }] } } }] } }), { status: 200 });
    }) as typeof globalThis.fetch;
    const provider = documentModelProviderFromEnv({ ...azure, DOCUMENT_MODEL_REMOTE_ALLOWED: "true" }, fetch)!;
    expect(provider.supports("passport") && provider.supports("bank_statement")).toBe(true);
    expect(provider.supports("certificate_of_incorporation") || provider.supports("toString")).toBe(false);
    const out = await provider.extract(new Uint8Array([1, 2, 3]), "passport");
    expect(urls[0]).toContain("/documentModels/prebuilt-idDocument:analyze");
    expect(out.fields).toEqual([expect.objectContaining({ path: "/extracted_fields/document_number", value: "P123", confidence: 0.8 })]);
  });
});

describe("Azure managed identity token", () => {
  it("uses the Container Apps identity endpoint with its header, and caches the token", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string> });
      return new Response(JSON.stringify({ access_token: "mi-token", expires_on: String(Math.floor(Date.now() / 1000) + 3600) }), { status: 200 });
    }) as unknown as typeof globalThis.fetch;
    const token = azureManagedIdentityToken({ IDENTITY_ENDPOINT: "http://localhost:42356/msi/token", IDENTITY_HEADER: "secret-header", AZURE_CLIENT_ID: "client-1" }, fetch, "https://cognitiveservices.azure.com/.default");
    expect(await token()).toBe("mi-token");
    expect(await token()).toBe("mi-token");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://localhost:42356/msi/token?resource=https%3A%2F%2Fcognitiveservices.azure.com&client_id=client-1&api-version=2019-08-01");
    expect(calls[0]!.headers["X-IDENTITY-HEADER"]).toBe("secret-header");
  });
  it("falls back to the instance metadata service and fails closed on a bad answer", async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => { urls.push(url); return new Response("{}", { status: 200 }); }) as unknown as typeof globalThis.fetch;
    await expect(azureManagedIdentityToken({}, fetch, "https://cognitiveservices.azure.com/.default")()).rejects.toThrow("adapter.managed_identity_response_invalid");
    expect(urls[0]).toMatch(/^http:\/\/169\.254\.169\.254\/metadata\/identity\/oauth2\/token\?resource=/);
  });
});
