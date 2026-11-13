import { qualifyProtectedAzureContainer } from "./azure-blob.js";
import { GetBucketVersioningCommand, GetObjectLockConfigurationCommand, S3Client } from "@aws-sdk/client-s3";
import { qualifyAdlsEvidence, type AdlsCredential } from "./adls.js";

export type ProtectedStorageInput = { provider: "adls_gen2"; endpoint: string; bucket: string; credentials: AdlsCredential }
  | { provider?: "s3"; endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: string };

export type ProtectedBucketInput =
  | { provider?: "s3"; endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: string }
  | { provider: "azure_blob"; endpoint: string; bucket: string; accountName?: string; accountKey: string };

/** Read-only deployment qualification. Never creates a bucket or changes retention. */
export async function qualifyProtectedBucket(input: ProtectedStorageInput | ProtectedBucketInput) {
  if (input.provider === "adls_gen2") return qualifyAdlsEvidence({ endpoint: input.endpoint, container: input.bucket, credentials: input.credentials });
  if (input.provider === "azure_blob") return qualifyProtectedAzureContainer(input);
  const endpoint = new URL(input.endpoint);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(input.bucket)) throw new Error("blob.qualification_input_invalid");
  const client = new S3Client({ endpoint: endpoint.toString(), region: input.region, forcePathStyle: true, credentials: { accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey } });
  try {
    const [versioning, lock] = await Promise.all([client.send(new GetBucketVersioningCommand({ Bucket: input.bucket }), { abortSignal: AbortSignal.timeout(15000) }), client.send(new GetObjectLockConfigurationCommand({ Bucket: input.bucket }), { abortSignal: AbortSignal.timeout(15000) })]);
    if (versioning.Status !== "Enabled" || lock.ObjectLockConfiguration?.ObjectLockEnabled !== "Enabled") throw new Error("blob.versioned_object_lock_required");
  } finally { client.destroy(); }
}
