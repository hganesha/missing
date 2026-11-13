import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { webAsset } from "./index.js";

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "web-static-"));
  await mkdir(join(root, "assets"));
  await writeFile(join(root, "index.html"), "<html></html>");
  await writeFile(join(root, "assets", "app.js"), "export {}");
  await writeFile(join(root, "notes.txt"), "private");
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe("webAsset", () => {
  it("serves assets and falls back to index.html for client routes", async () => {
    expect(await webAsset(root, "/assets/app.js")).toMatchObject({ type: "text/javascript", html: false });
    expect(await webAsset(root, "/onboarding/review?step=2")).toMatchObject({ html: true });
  });
  it("refuses reserved paths, traversal, unknown types and malformed paths", async () => {
    for (const path of ["/api/x", "/auth", "/health/ready", "/../etc/passwd.js", "/%2e%2e/secret.js", "/notes.txt", "/missing.js", "/%E0%A4%A"]) expect(await webAsset(root, path)).toBeNull();
  });
});
