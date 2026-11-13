import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { documentLayoutSchema } from "@ehf/contracts";
import { analyzeLayoutAzure, azureLayoutEndpoint, layoutFromAzure } from "./document-layout-azure.js";

const ENDPOINT = "https://ehf-docs.cognitiveservices.azure.com/";
const ORIGIN = "https://ehf-docs.cognitiveservices.azure.com";
const OPERATION = `${ORIGIN}/documentintelligence/documentModels/prebuilt-layout/analyzeResults/op-1?api-version=2024-11-30`;
const SCAN = new TextEncoder().encode("synthetic scanned bill");
const SHA = createHash("sha256").update(SCAN).digest("hex");

/** A recorded-style prebuilt-layout result for a one-page synthetic bill (Azure v4 analyzeResult shape). */
const ANALYZE_RESULT = {
  apiVersion: "2024-11-30", modelId: "prebuilt-layout", stringIndexType: "unicodeCodePoint",
  content: "ENERGY BILL\nCustomer: Quinn Fictor\nBilling address: 57 Mock Lane\nItem Amount Electricity 85.10\nPage 1 of 1",
  pages: [{ pageNumber: 1, width: 8.5, height: 11, unit: "inch", angle: 0.2, spans: [{ offset: 0, length: 106 }], lines: [
    { content: "Billing address:", spans: [{ offset: 35, length: 16 }] }, { content: "57 Mock Lane", spans: [{ offset: 52, length: 12 }] },
  ], words: [
    { content: "ENERGY", confidence: 0.99, span: { offset: 0, length: 6 } },
    { content: "Quinn", confidence: 0.61, span: { offset: 22, length: 5 } },
    { content: "57", confidence: 0.97, span: { offset: 52, length: 2 } },
  ] }],
  styles: [{ isHandwritten: true, spans: [{ offset: 22, length: 12 }] }],
  sections: [{ elements: ["/paragraphs/0", "/sections/1"] }, { elements: ["/paragraphs/1", "/paragraphs/2"] }],
  paragraphs: [
    { role: "title", content: "ENERGY BILL", spans: [{ offset: 0, length: 11 }], boundingRegions: [{ pageNumber: 1, polygon: [1, 1, 3, 1, 3, 1.4, 1, 1.4] }] },
    { content: "Customer: Quinn Fictor", spans: [{ offset: 12, length: 22 }], boundingRegions: [{ pageNumber: 1, polygon: [1, 2, 4, 2, 4, 2.3, 1, 2.3] }] },
    { content: "Billing address: 57 Mock Lane", spans: [{ offset: 35, length: 29 }], boundingRegions: [{ pageNumber: 1, polygon: [1, 2.5, 5, 2.5, 5, 2.8, 1, 2.8] }] },
    { content: "Electricity", spans: [{ offset: 77, length: 11 }], boundingRegions: [{ pageNumber: 1, polygon: [1, 3.5, 2, 3.5, 2, 3.7, 1, 3.7] }] },
    { role: "pageFooter", content: "Page 1 of 1", spans: [{ offset: 95, length: 11 }], boundingRegions: [{ pageNumber: 1, polygon: [1, 10.5, 2, 10.5, 2, 10.7, 1, 10.7] }] },
  ],
  tables: [{ rowCount: 2, columnCount: 2, spans: [{ offset: 65, length: 29 }], boundingRegions: [{ pageNumber: 1, polygon: [1, 3, 6, 3, 6, 4, 1, 4] }], cells: [
    { kind: "columnHeader", rowIndex: 0, columnIndex: 0, content: "Item" }, { kind: "columnHeader", rowIndex: 0, columnIndex: 1, content: "Amount" },
    { rowIndex: 1, columnIndex: 0, content: "Electricity", rowSpan: 1, columnSpan: 2 }, { rowIndex: 1, columnIndex: 1, content: "85.10" },
  ] }],
  figures: [{ id: "1.1", boundingRegions: [{ pageNumber: 1, polygon: [6, 1, 7.5, 1, 7.5, 2, 6, 2] }], elements: [] }],
};

type Call = { url: string; init: RequestInit };
function scripted(responses: Array<() => Response>) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    return next();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}
const accepted = (location = OPERATION) => () => new Response(null, { status: 202, headers: { "operation-location": location } });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const options = (fetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) => ({ endpoint: ENDPOINT, auth: { kind: "api_key" as const, key: "test-key" }, fetch, sleep: async () => {}, ...extra });

describe("Azure layout endpoint", () => {
  it("accepts only an Azure AI resource origin", () => {
    expect(azureLayoutEndpoint(ENDPOINT)).toBe(ORIGIN);
    expect(azureLayoutEndpoint("https://ehf.services.ai.azure.com")).toBe("https://ehf.services.ai.azure.com");
    for (const bad of ["http://ehf-docs.cognitiveservices.azure.com", "https://evil.example.com", "https://ehf-docs.cognitiveservices.azure.com/path",
      "https://ehf-docs.cognitiveservices.azure.com/?x=1", "https://user:pw@ehf-docs.cognitiveservices.azure.com", "https://ehf-docs.cognitiveservices.azure.com:8443", "not a url"]) {
      expect(() => azureLayoutEndpoint(bad)).toThrow("adapter.document_layout_endpoint_invalid");
    }
  });
});

describe("Azure layout analysis", () => {
  it("submits once with code-point offsets, polls the same resource and returns the canonical layout", async () => {
    const { fetch, calls } = scripted([accepted(), json({ status: "running" }, 200, { "retry-after": "1" }), json({ status: "succeeded", analyzeResult: ANALYZE_RESULT })]);
    const waits: number[] = [];
    const layout = await analyzeLayoutAzure(SCAN, options(fetch, { sleep: async (ms: number) => { waits.push(ms); } }));
    expect(calls[0]!.url).toBe(`${ORIGIN}/documentintelligence/documentModels/prebuilt-layout:analyze?api-version=2024-11-30&stringIndexType=unicodeCodePoint`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ base64Source: Buffer.from(SCAN).toString("base64") });
    expect((calls[0]!.init.headers as Record<string, string>)["Ocp-Apim-Subscription-Key"]).toBe("test-key");
    expect(calls[0]!.init.redirect).toBe("error");
    expect(calls.slice(1).map(c => c.url)).toEqual([OPERATION, OPERATION]);
    expect(waits).toEqual([1000]);
    expect(documentLayoutSchema.parse(layout)).toEqual(layout);
    expect(layout).toMatchObject({ contract: "document.layout.v1", provider: "azure_document_intelligence", model: "prebuilt-layout", model_version: "2024-11-30", source_sha256: SHA });
    expect(layout.pages).toEqual([{ page: 1, width: 8.5, height: 11, unit: "inch", angle: 0.2, has_text: true, handwritten_spans: 1 }]);
    expect(layout.blocks.map(b => b.kind)).toEqual(["title", "paragraph", "paragraph", "table", "page_footer"]);
    expect(layout.blocks[0]).toMatchObject({ text: "ENERGY BILL", heading_level: 1, bbox: [1, 1, 3, 1.4] });
    expect(layout.blocks[1]).toMatchObject({ text: "Customer: Quinn Fictor", min_word_confidence: 0.61 });
    // A paragraph keeps the visual lines Azure reported, so a label and the value below it stay apart.
    expect(layout.blocks[2]).toMatchObject({ text: "Billing address:\n57 Mock Lane" });
    expect(layout.blocks[3]).toMatchObject({ kind: "table", table: { rows: [["Item", "Amount"], ["Electricity", "85.10"]], header_rows: 1, merged_cells: 1 } });
    expect(layout.figures).toEqual([{ id: "1.1", page: 1 }]);
  });

  it("never sends the credential to an operation on another origin", async () => {
    const { fetch, calls } = scripted([accepted("https://attacker.example.com/documentintelligence/documentModels/prebuilt-layout/analyzeResults/x")]);
    await expect(analyzeLayoutAzure(SCAN, options(fetch))).rejects.toThrow("adapter.document_layout_operation_invalid");
    expect(calls).toHaveLength(1);
  });

  it("retries throttling within bounds and reports provider failures by code only", async () => {
    const throttled = scripted([json({}, 429, { "retry-after": "2" }), accepted(), json({ status: "succeeded", analyzeResult: ANALYZE_RESULT })]);
    await expect(analyzeLayoutAzure(SCAN, options(throttled.fetch))).resolves.toMatchObject({ source_sha256: SHA });
    const down = scripted([json({}, 503), json({}, 503), json({}, 503)]);
    await expect(analyzeLayoutAzure(SCAN, options(down.fetch))).rejects.toThrow("adapter.document_layout_http_503");
    // Sustained throttling is retried longer than a server error, then reported as throttling.
    const busy = scripted(Array.from({ length: 7 }, () => json({}, 429, { "retry-after": "1" })));
    await expect(analyzeLayoutAzure(SCAN, options(busy.fetch))).rejects.toThrow("adapter.document_layout_http_429");
    expect(busy.calls).toHaveLength(7);
    let clock = 0;
    const late = scripted([json({}, 429, { "retry-after": "30" })]);
    await expect(analyzeLayoutAzure(SCAN, options(late.fetch, { timeoutMs: 10_000, now: () => clock }))).rejects.toThrow("adapter.document_layout_throttled");
    const failed = scripted([accepted(), json({ status: "failed", error: { code: "InvalidContent", message: "secret detail" } })]);
    await expect(analyzeLayoutAzure(SCAN, options(failed.fetch))).rejects.toThrow(/^adapter\.document_layout_failed:InvalidContent$/);
  });

  it("stops at its deadline", async () => {
    let clock = 0;
    const { fetch } = scripted([accepted(), json({ status: "running" }), json({ status: "running" })]);
    await expect(analyzeLayoutAzure(SCAN, options(fetch, { timeoutMs: 5000, now: () => clock, sleep: async () => { clock += 6000; } })))
      .rejects.toThrow("adapter.document_layout_timeout");
  });

  it("uses a bearer token when given one and fails closed without it", async () => {
    const { fetch, calls } = scripted([accepted(), json({ status: "succeeded", analyzeResult: ANALYZE_RESULT })]);
    await analyzeLayoutAzure(SCAN, { ...options(fetch), auth: { kind: "bearer", token: async () => "entra-token" } });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer entra-token");
    expect((calls[0]!.init.headers as Record<string, string>)["Ocp-Apim-Subscription-Key"]).toBeUndefined();
    const none = scripted([]);
    await expect(analyzeLayoutAzure(SCAN, { ...options(none.fetch), auth: { kind: "bearer", token: async () => "" } })).rejects.toThrow("adapter.document_layout_credential_unavailable");
    await expect(analyzeLayoutAzure(SCAN, { ...options(none.fetch), auth: { kind: "api_key", key: " " } })).rejects.toThrow("adapter.document_layout_credential_missing");
  });
});

describe("Azure layout mapping", () => {
  it("keeps table cell text out of paragraphs and refuses a result without pages", () => {
    const layout = layoutFromAzure(ANALYZE_RESULT, SHA);
    expect(layout.blocks.filter(b => b.kind !== "table").map(b => "text" in b ? b.text : "")).not.toContain("Electricity");
    expect(() => layoutFromAzure({ ...ANALYZE_RESULT, pages: [] }, SHA)).toThrow("adapter.document_layout_result_missing");
  });
});

describe("canonical layout contract across languages", () => {
  // The evidence pipeline's tests prepare this exact layout (apps/evidence-pipeline/tests/test_prepare.py).
  const fixture = new URL("../../../apps/evidence-pipeline/tests/fixtures/azure-layout.canonical.json", import.meta.url);
  it("matches the committed fixture the pipeline consumes", () => {
    const layout = layoutFromAzure(ANALYZE_RESULT, SHA);
    if (process.env.UPDATE_LAYOUT_FIXTURE === "1") writeFileSync(fixture, JSON.stringify(layout, null, 2) + "\n");
    expect(JSON.parse(readFileSync(fixture, "utf8"))).toEqual(layout);
  });
});

