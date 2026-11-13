import { pathToFileURL } from "node:url";
import { isProductionProfile } from "@ehf/identity";
import { blobContainerFromEnv } from "./index.js";

/**
 * Create the buckets a development stack is configured for (a local S3-compatible server
 * such as MinIO). A deployment provisions its buckets, with object lock, itself; this step
 * never runs under the production profile.
 */
export const BLOB_PURPOSES = ["EVIDENCE", "LEDGER_EXPORT", "CONTEXT_PACK"] as const;

export async function main(): Promise<void> {
  if (isProductionProfile()) return;
  for (const purpose of BLOB_PURPOSES) {
    if (!process.env[`${purpose}_BLOB_BUCKET`]) continue;
    const container = blobContainerFromEnv(purpose);
    if (!container) continue;
    await container.ensure();
    process.stdout.write(`object store bucket ready: ${purpose.toLowerCase()} -> ${container.container}\n`);
  }
}

if (import.meta.main ?? (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) await main();
