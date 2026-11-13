import { createHash } from "node:crypto";
import { DOCUMENT_LAYOUT_CONTRACT, documentLayoutSchema, type DocumentLayout, type DocumentLayoutBlock } from "@ehf/contracts";
import type { AccessTokenProvider } from "./cloud-http.js";

/**
 * Azure AI Document Intelligence `prebuilt-layout` as a canonical layout (`document.layout.v1`) provider.
 *
 * This adapter runs in the platform (gateway, control plane), never in the evidence pipeline, so the
 * pipeline stays cloud-neutral and holds no provider credential. It submits one original, polls the
 * operation until it finishes, and maps Azure's `analyzeResult` to the canonical layout:
 *
 * - paragraphs (outside tables) and tables become blocks in reading order, with roles mapped to
 *   title/heading/page furniture/footnote and heading levels from Azure's section tree;
 * - a paragraph keeps its visual lines (Azure's `lines` within its spans, joined by line breaks), because
 *   Azure joins a paragraph's lines with spaces and forms rely on line boundaries between label and value;
 * - a block's box is the bounding rectangle of its first region's polygon, in the page's unit;
 * - a block's lowest word confidence and each page's handwriting are kept for review;
 * - figures are listed; their contents are not interpreted.
 *
 * Offsets are requested as Unicode code points (`stringIndexType=unicodeCodePoint`), the platform's
 * offset basis, and used only to find each block's words. The credential is sent only to the
 * configured Azure AI endpoint, and polling only follows an operation on the same origin.
 */
export const AZURE_LAYOUT_MODEL = "prebuilt-layout";
export const AZURE_LAYOUT_API_VERSION = "2024-11-30";
const AZURE_HOST = /^[a-z0-9][a-z0-9-]{1,62}\.(?:cognitiveservices\.azure\.(?:com|us|cn)|services\.ai\.azure\.(?:com|us|cn))$/;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
/** The Entra audience for Azure AI services; a bearer provider must issue tokens for it. */
export const AZURE_COGNITIVE_SERVICES_SCOPE = "https://cognitiveservices.azure.com/.default";

/** A resource key, or a bearer token for AZURE_COGNITIVE_SERVICES_SCOPE (managed identity or workload identity). */
export type AzureLayoutAuth = { kind: "api_key"; key: string } | { kind: "bearer"; token: AccessTokenProvider };
export type AzureLayoutOptions = {
  endpoint: string;
  auth: AzureLayoutAuth;
  fetch?: typeof globalThis.fetch;
  /** Overall budget for submission and polling. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

/** The resource endpoint, checked: https, an Azure AI host, no credentials, port, path, query or fragment. */
export function azureLayoutEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("adapter.document_layout_endpoint_invalid"); }
  if (url.protocol !== "https:" || !AZURE_HOST.test(url.hostname) || url.username || url.password || url.port || url.search || url.hash
    || (url.pathname !== "/" && url.pathname !== "")) throw new Error("adapter.document_layout_endpoint_invalid");
  return url.origin;
}

type Json = Record<string, any>;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function analyzeLayoutAzure(content: Uint8Array, options: AzureLayoutOptions): Promise<DocumentLayout> {
  const sha256 = createHash("sha256").update(content).digest("hex");
  return layoutFromAzure(await analyzeAzure(content, AZURE_LAYOUT_MODEL, options), sha256);
}

// A prebuilt model, or a custom or composed model id (Azure's grammar; the Document Factory names its own `ehf-…`).
const AZURE_MODEL_ID = /^(?:prebuilt-[a-z][a-zA-Z0-9.]{1,63}|[a-zA-Z0-9][a-zA-Z0-9._~-]{1,63})$/;

/** One analysis with a named Azure model (prebuilt, custom or composed), returning Azure's raw `analyzeResult` (same transport rules). */
export async function analyzeAzure(content: Uint8Array, model: string, options: AzureLayoutOptions): Promise<Json> {
  if (!AZURE_MODEL_ID.test(model)) throw new Error("adapter.document_layout_model_invalid");
  const origin = azureLayoutEndpoint(options.endpoint);
  const fetcher = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? delay;
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? 120_000);
  const headers = async (): Promise<Record<string, string>> => {
    if (options.auth.kind === "api_key") {
      if (!options.auth.key.trim()) throw new Error("adapter.document_layout_credential_missing");
      return { "Ocp-Apim-Subscription-Key": options.auth.key };
    }
    const token = await options.auth.token().catch(() => "");
    if (!token) throw new Error("adapter.document_layout_credential_unavailable");
    return { Authorization: `Bearer ${token}` };
  };
  const request = async (url: string, init: RequestInit): Promise<Response> => {
    for (let attempt = 0; ; attempt += 1) {
      if (now() > deadline) throw new Error("adapter.document_layout_timeout");
      let response: Response;
      try {
        response = await fetcher(url, { ...init, headers: { ...await headers(), ...init.headers as Record<string, string> }, redirect: "error",
          signal: AbortSignal.timeout(Math.max(1, Math.min(60_000, deadline - now()))) });
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("adapter.")) throw error;
        if (attempt < 2) { await sleep(1000); continue; }
        throw new Error("adapter.document_layout_unreachable");
      }
      // Azure throttles per resource (HTTP 429 with Retry-After); honour it for longer than a server error,
      // always within the overall deadline.
      const retries = response.status === 429 ? 6 : 2;
      if ([429, 500, 502, 503, 504].includes(response.status) && attempt < retries) {
        const wait = retryAfter(response, response.status === 429 ? 2000 : 1000);
        if (now() + wait > deadline) throw new Error(response.status === 429 ? "adapter.document_layout_throttled" : `adapter.document_layout_http_${response.status}`);
        await sleep(wait);
        continue;
      }
      return response;
    }
  };
  const submitted = await request(`${origin}/documentintelligence/documentModels/${model}:analyze?api-version=${AZURE_LAYOUT_API_VERSION}&stringIndexType=unicodeCodePoint`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base64Source: Buffer.from(content).toString("base64") }),
  });
  if (submitted.status !== 202) throw new Error(`adapter.document_layout_http_${submitted.status}`);
  const location = submitted.headers.get("operation-location") ?? "";
  let operation: URL;
  try { operation = new URL(location); } catch { throw new Error("adapter.document_layout_operation_invalid"); }
  // The credential is sent to the polling URL, so it must be an analyze result on the same resource.
  if (operation.origin !== origin || !operation.pathname.startsWith(`/documentintelligence/documentModels/${model}/analyzeResults/`)) {
    throw new Error("adapter.document_layout_operation_invalid");
  }
  for (;;) {
    const poll = await request(operation.toString(), { method: "GET" });
    if (!poll.ok) throw new Error(`adapter.document_layout_http_${poll.status}`);
    const body = await boundedJson(poll);
    if (body.status === "succeeded") {
      if (!body.analyzeResult || typeof body.analyzeResult !== "object") throw new Error("adapter.document_layout_result_missing");
      return body.analyzeResult;
    }
    if (body.status !== "notStarted" && body.status !== "running") {
      const code = typeof body.error?.code === "string" && /^[A-Za-z]{1,64}$/.test(body.error.code) ? `:${body.error.code}` : "";
      throw new Error(`adapter.document_layout_failed${code}`);
    }
    if (now() > deadline) throw new Error("adapter.document_layout_timeout");
    await sleep(retryAfter(poll, options.pollIntervalMs ?? 2000));
  }
}

function retryAfter(response: Response, fallback: number): number {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(30_000, seconds * 1000) : fallback;
}

async function boundedJson(response: Response): Promise<Json> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw new Error("adapter.document_layout_response_too_large");
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error("adapter.document_layout_response_too_large");
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value;
  } catch {
    throw new Error("adapter.document_layout_response_invalid");
  }
}

type Span = { offset: number; length: number };
const spansOf = (item: Json): Span[] => (Array.isArray(item?.spans) ? item.spans : [])
  .filter((s: Json) => Number.isInteger(s?.offset) && Number.isInteger(s?.length) && s.offset >= 0 && s.length >= 0);
const element = (ref: unknown): [string, number] | null => {
  const parts = typeof ref === "string" ? ref.replace(/^\/+|\/+$/g, "").split("/") : [];
  return parts.length === 2 && /^\d+$/.test(parts[1]!) ? [parts[0]!, Number(parts[1])] : null;
};

/** Depth of the section directly containing each paragraph (root sections are depth 0). */
function sectionDepths(sections: Json[]): Map<number, number> {
  const children = new Set(sections.flatMap(s => (s.elements ?? []).map(element).filter((e: any) => e?.[0] === "sections").map((e: any) => e[1])));
  const depths = new Map<number, number>();
  const stack: Array<[number, number]> = sections.map((_, i) => i).filter(i => !children.has(i)).map(i => [i, 0]);
  const seen = new Set<number>();
  while (stack.length) {
    const [index, depth] = stack.pop()!;
    if (seen.has(index) || index >= sections.length) continue;
    seen.add(index);
    for (const ref of sections[index]!.elements ?? []) {
      const e = element(ref);
      if (e?.[0] === "paragraphs" && !depths.has(e[1])) depths.set(e[1], depth);
      else if (e?.[0] === "sections") stack.push([e[1], depth + 1]);
    }
  }
  return depths;
}

function region(item: Json): { page: number | null; bbox: [number, number, number, number] | null; pages: number[] } {
  const regions: Json[] = Array.isArray(item?.boundingRegions) ? item.boundingRegions : [];
  const pages = [...new Set(regions.map(r => r.pageNumber).filter(Number.isInteger))].sort((a, b) => a - b) as number[];
  const first = regions[0];
  const polygon: number[] = Array.isArray(first?.polygon) ? first.polygon.filter((v: unknown) => typeof v === "number" && Number.isFinite(v)) : [];
  if (!first || !Number.isInteger(first.pageNumber)) return { page: null, bbox: null, pages };
  if (polygon.length < 8) return { page: first.pageNumber, bbox: null, pages };
  const xs = polygon.filter((_, i) => i % 2 === 0), ys = polygon.filter((_, i) => i % 2 === 1);
  const box: [number, number, number, number] = [Math.max(0, Math.min(...xs)), Math.max(0, Math.min(...ys)), Math.max(...xs), Math.max(...ys)];
  return { page: first.pageNumber, bbox: box[2] > box[0] && box[3] > box[1] ? box : null, pages };
}

const ROLES: Record<string, DocumentLayoutBlock["kind"]> = {
  title: "title", sectionHeading: "heading", pageHeader: "page_header", pageFooter: "page_footer", pageNumber: "page_number", footnote: "footnote",
};

/** Azure `analyzeResult` → canonical layout. Pure; validated against `document.layout.v1` before it is returned. */
export function layoutFromAzure(result: Json, sourceSha256: string): DocumentLayout {
  const azurePages: Json[] = Array.isArray(result.pages) ? result.pages : [];
  const words = azurePages.flatMap(p => (Array.isArray(p.words) ? p.words : [])
    .filter((w: Json) => Number.isInteger(w?.span?.offset)).map((w: Json) => ({ offset: w.span.offset as number, confidence: typeof w.confidence === "number" ? w.confidence : 1 })))
    .sort((a, b) => a.offset - b.offset);
  const minConfidence = (spans: Span[]): number | null => {
    const values = words.filter(w => spans.some(s => s.offset <= w.offset && w.offset < s.offset + s.length)).map(w => w.confidence);
    return values.length ? Math.round(Math.min(...values) * 1000) / 1000 : null;
  };
  const lines = azurePages.flatMap(p => (Array.isArray(p.lines) ? p.lines : [])
    .filter((l: Json) => typeof l?.content === "string").map((l: Json) => ({ content: l.content as string, offset: spansOf(l)[0]?.offset ?? -1 })))
    .filter(l => l.offset >= 0).sort((a, b) => a.offset - b.offset);
  const paragraphText = (item: Json): string => {
    const spans = spansOf(item);
    const inside = lines.filter(l => spans.some(s => s.offset <= l.offset && l.offset < s.offset + s.length));
    return inside.length > 1 ? inside.map(l => l.content).join("\n") : String(item.content ?? "");
  };
  const pageSpans = azurePages.flatMap(p => spansOf(p).map(s => ({ start: s.offset, end: s.offset + s.length, page: p.pageNumber as number })));
  const pageOf = (offset: number) => pageSpans.find(s => s.start <= offset && offset < s.end)?.page ?? null;
  const handwritten = new Map<number, number>();
  for (const style of Array.isArray(result.styles) ? result.styles : []) {
    if (!style?.isHandwritten) continue;
    for (const span of spansOf(style)) {
      const page = pageOf(span.offset);
      if (page !== null) handwritten.set(page, (handwritten.get(page) ?? 0) + 1);
    }
  }
  const pages = azurePages
    .filter(p => Number.isInteger(p.pageNumber) && typeof p.width === "number" && typeof p.height === "number" && p.width > 0 && p.height > 0)
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .map(p => ({
      page: p.pageNumber as number, width: p.width as number, height: p.height as number, unit: p.unit === "inch" ? "inch" as const : "pixel" as const,
      ...(typeof p.angle === "number" && Number.isFinite(p.angle) ? { angle: p.angle } : {}),
      has_text: Array.isArray(p.words) && p.words.length > 0,
      ...(handwritten.has(p.pageNumber) ? { handwritten_spans: handwritten.get(p.pageNumber)! } : {}),
    }));
  if (!pages.length) throw new Error("adapter.document_layout_result_missing");
  const paragraphs: Json[] = Array.isArray(result.paragraphs) ? result.paragraphs : [];
  const tables: Json[] = Array.isArray(result.tables) ? result.tables : [];
  const figures: Json[] = Array.isArray(result.figures) ? result.figures : [];
  const depths = sectionDepths(Array.isArray(result.sections) ? result.sections : []);
  const tableSpans = tables.flatMap(t => spansOf(t).map(s => [s.offset, s.offset + s.length] as const));
  const inTable = (spans: Span[]) => spans.length > 0 && spans.every(s => tableSpans.some(([a, b]) => a <= s.offset && s.offset + s.length <= b));
  const figureOf = new Map<number, string>();
  figures.forEach((f, i) => (f.elements ?? []).map(element).forEach((e: any) => { if (e?.[0] === "paragraphs") figureOf.set(e[1], String(f.id ?? i)); }));
  const firstOffset = (item: Json) => Math.min(...spansOf(item).map(s => s.offset), Number.MAX_SAFE_INTEGER);
  const items = [
    ...paragraphs.map((p, i) => ({ offset: firstOffset(p), order: 1, kind: "paragraph" as const, index: i, item: p })).filter(x => !inTable(spansOf(x.item))),
    ...tables.map((t, i) => ({ offset: firstOffset(t), order: 0, kind: "table" as const, index: i, item: t })),
  ].sort((a, b) => a.offset - b.offset || a.order - b.order || a.index - b.index);
  const blocks: DocumentLayoutBlock[] = [];
  for (const { kind, index, item } of items) {
    const { page, bbox, pages: spanned } = region(item);
    if (page === null || page > pages.length) continue;
    const common = { page, ...(spanned.length > 1 ? { pages: spanned } : {}), bbox, min_word_confidence: minConfidence(spansOf(item)) };
    if (kind === "table") {
      const rowCount = Number.isInteger(item.rowCount) ? item.rowCount : 0, columnCount = Number.isInteger(item.columnCount) ? item.columnCount : 0;
      const rows: string[][] = Array.from({ length: Math.min(rowCount, 5000) }, () => Array.from({ length: Math.min(columnCount, 1000) }, () => ""));
      const headerRows = new Set<number>();
      let merged = 0;
      for (const cell of Array.isArray(item.cells) ? item.cells : []) {
        const r = cell.rowIndex ?? 0, c = cell.columnIndex ?? 0;
        if (rows[r] && c < rows[r]!.length) rows[r]![c] = String(cell.content ?? "").split(/\s+/).filter(Boolean).join(" ");
        if (cell.kind === "columnHeader") for (let k = r; k < r + (cell.rowSpan ?? 1); k += 1) headerRows.add(k);
        else if ((cell.rowSpan ?? 1) > 1 || (cell.columnSpan ?? 1) > 1) merged += 1;
      }
      const caption = typeof item.caption?.content === "string" ? item.caption.content.split(/\s+/).filter(Boolean).join(" ") : null;
      blocks.push({ ...common, kind: "table", table: { rows, header_rows: [...headerRows].filter(r => rows[r]?.some(Boolean)).length, merged_cells: merged, caption } });
      continue;
    }
    const role = ROLES[item.role as string] ?? "paragraph";
    const level = role === "title" || role === "heading" ? Math.min(6, depths.has(index) ? depths.get(index)! + 1 : role === "title" ? 1 : 2) : undefined;
    blocks.push({ ...common, kind: role as Exclude<DocumentLayoutBlock["kind"], "table">, text: paragraphText(item),
      ...(level ? { heading_level: level } : {}), ...(figureOf.has(index) ? { figure_id: figureOf.get(index)! } : {}) } as DocumentLayoutBlock);
  }
  const layout = {
    contract: DOCUMENT_LAYOUT_CONTRACT, provider: "azure_document_intelligence",
    model: typeof result.modelId === "string" ? result.modelId : AZURE_LAYOUT_MODEL,
    model_version: typeof result.apiVersion === "string" ? result.apiVersion : AZURE_LAYOUT_API_VERSION,
    source_sha256: sourceSha256, pages, blocks,
    figures: figures.map((f, i) => ({ id: String(f.id ?? i).slice(0, 64), page: region(f).page })),
  };
  const checked = documentLayoutSchema.safeParse(layout);
  if (!checked.success) throw new Error("adapter.document_layout_result_invalid");
  return checked.data;
}
