import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

/** Extensions the built SPA ships; anything else is not served. */
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".png": "image/png", ".ico": "image/x-icon" };

export type WebAsset = { content: Buffer; type: string; html: boolean };

/**
 * Resolves a request path to a file of the built single-page app under `root`. Paths
 * without an extension fall back to index.html; API, auth and health paths, traversal
 * outside the root, unknown types and missing files resolve to null (a 404).
 */
export async function webAsset(root: string, requestUrl: string): Promise<WebAsset | null> {
  const base = resolve(root);
  const path = requestUrl.split("?")[0]!;
  if (/^\/(api|auth|health)(\/|$)/.test(path)) return null;
  let candidate: string;
  try { candidate = resolve(base, `.${decodeURIComponent(path)}`); } catch { return null; }
  if (candidate !== base && !candidate.startsWith(base + sep)) return null;
  const file = extname(candidate) ? candidate : resolve(base, "index.html");
  const type = TYPES[extname(file)];
  if (!type) return null;
  try { return { content: await readFile(file), type, html: extname(file) === ".html" }; } catch { return null; }
}
