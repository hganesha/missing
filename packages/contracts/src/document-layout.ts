import { z } from "zod";

/**
 * Canonical layout (`document.layout.v1`): what an OCR/layout provider recognized on one original,
 * in a provider-neutral shape. A platform adapter (Azure Document Intelligence prebuilt-layout first)
 * produces it; the evidence pipeline maps it to page text and regions (apps/evidence-pipeline
 * `kyc_pipeline/layout.py`) and never contacts the provider itself.
 *
 * Coordinates are in the page's own unit (`inch`, `point` or `pixel`): `bbox` is [left, top, right,
 * bottom]. Blocks are in the provider's reading order. Nothing here is a verified fact: recognized
 * text is the provider's reading, and low confidence and handwriting are reported per block or page.
 */
export const DOCUMENT_LAYOUT_CONTRACT = "document.layout.v1";
const finite = z.number().finite();
const nonNegative = finite.min(0);
const bbox = z.tuple([nonNegative, nonNegative, nonNegative, nonNegative])
  .refine(([left, top, right, bottom]) => right > left && bottom > top, "bbox must have positive width and height");

export const documentLayoutPageSchema = z.object({
  page: z.number().int().positive(),
  width: finite.positive(),
  height: finite.positive(),
  unit: z.enum(["inch", "point", "pixel"]),
  angle: finite.optional(),
  has_text: z.boolean().optional(),
  handwritten_spans: z.number().int().min(0).optional(),
}).strict();

const blockBase = {
  page: z.number().int().positive(),
  pages: z.array(z.number().int().positive()).max(2000).optional(),
  bbox: bbox.nullable().optional(),
  min_word_confidence: finite.min(0).max(1).nullable().optional(),
  figure_id: z.string().max(64).nullable().optional(),
};

export const documentLayoutBlockSchema = z.discriminatedUnion("kind", [
  z.object({ ...blockBase, kind: z.enum(["title", "heading", "paragraph", "page_header", "page_footer", "page_number", "footnote"]),
    text: z.string().max(200_000), heading_level: z.number().int().min(1).max(6).optional() }).strict(),
  z.object({ ...blockBase, kind: z.literal("table"), table: z.object({
    rows: z.array(z.array(z.string().max(20_000)).max(1000)).max(5000),
    header_rows: z.number().int().min(0).optional(),
    merged_cells: z.number().int().min(0).optional(),
    caption: z.string().max(20_000).nullable().optional(),
  }).strict() }).strict(),
]);

export const documentLayoutSchema = z.object({
  contract: z.literal(DOCUMENT_LAYOUT_CONTRACT),
  provider: z.string().min(1).max(120),
  model: z.string().min(1).max(120),
  model_version: z.string().min(1).max(120).optional(),
  source_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  pages: z.array(documentLayoutPageSchema).min(1).max(2000),
  blocks: z.array(documentLayoutBlockSchema).max(50_000),
  figures: z.array(z.object({ id: z.string().max(64), page: z.number().int().positive().nullable() }).strict()).max(10_000).optional(),
}).strict().superRefine((layout, context) => {
  layout.pages.forEach((page, index) => {
    if (page.page !== index + 1) context.addIssue({ code: "custom", path: ["pages", index, "page"], message: "pages must be numbered 1..n in order" });
  });
  layout.blocks.forEach((block, index) => {
    if (block.page > layout.pages.length) context.addIssue({ code: "custom", path: ["blocks", index, "page"], message: "block page must name a supplied page" });
  });
});

export type DocumentLayout = z.infer<typeof documentLayoutSchema>;
export type DocumentLayoutBlock = z.infer<typeof documentLayoutBlockSchema>;
