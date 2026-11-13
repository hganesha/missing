import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { BlobContainer } from "@ehf/blob-store";
import { verifyLedgerSegments, type SignedManifest } from "./ledger-segment.js";

/**
 * Offline verification of one tenant's exported ledger segments. Needs only the segment
 * files and the signer's public key: no database, no platform credential.
 *
 *   tsx packages/case-store/src/ledger-verify.ts <tenant-directory> <public-key.pem>
 *
 * Exits 0 when every segment verifies and the series is unbroken from segment 1, 1 otherwise.
 */
export async function verifyLedgerDirectory(directory: string, publicKeyPem: string) {
  const manifests = (await readdir(directory)).filter((name) => name.endsWith(".manifest.json")).sort();
  const segments = await Promise.all(manifests.map(async (name) => ({
    signed: JSON.parse(await readFile(join(directory, name), "utf8")) as SignedManifest,
    events: await readFile(join(directory, name.replace(/\.manifest\.json$/, ".ndjson"))),
  })));
  segments.sort((left, right) => left.signed.manifest.segmentNumber - right.signed.manifest.segmentNumber);
  return { segments: segments.length, ...verifyLedgerSegments(segments, publicKeyPem) };
}

/** The same verification over a tenant's segments in the ledger export container (read access only). */
export async function verifyLedgerContainer(blobs: BlobContainer, tenantId: string, publicKeyPem: string) {
  const prefix = `${encodeURIComponent(tenantId)}/`;
  const names: string[] = [];
  for await (const item of blobs.list(prefix)) if (item.name.endsWith(".manifest.json")) names.push(item.name);
  const segments = await Promise.all(names.sort().map(async (name) => ({
    signed: JSON.parse((await blobs.get(name)).toString("utf8")) as SignedManifest,
    events: await blobs.get(name.replace(/\.manifest\.json$/, ".ndjson")),
  })));
  segments.sort((left, right) => left.signed.manifest.segmentNumber - right.signed.manifest.segmentNumber);
  return { segments: segments.length, ...verifyLedgerSegments(segments, publicKeyPem) };
}

async function main(): Promise<void> {
  const [directory, keyPath] = process.argv.slice(2);
  if (!directory || !keyPath) {
    process.stderr.write("usage: ledger-verify <tenant-directory> <public-key.pem>\n");
    process.exit(2);
  }
  const result = await verifyLedgerDirectory(directory, await readFile(keyPath, "utf8")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    process.stderr.write(`no segments at ${directory}\n`);
    process.exit(1);
  });
  if (result.segments === 0) {
    process.stderr.write(`no segments at ${directory}\n`);
    process.exit(1);
  }
  if (result.valid) {
    process.stdout.write(`verified ${result.segments} segment(s), ${result.heads.size} case chain(s)\n`);
    return;
  }
  for (const error of result.errors) process.stderr.write(`${error}\n`);
  process.exit(1);
}

if (import.meta.main ?? (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) await main();
