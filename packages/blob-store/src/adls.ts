import { ClientSecretCredential } from "@azure/identity";
import { StorageManagementClient } from "@azure/arm-storage";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { isProductionProfile } from "@ehf/identity";
import { BlobStoreError, sha256Hex, type BlobContainer, type BlobHead } from "./index.js";

export type AdlsCredential = { tenantId: string; clientId: string; clientSecret: string; subscriptionId: string; resourceGroup: string };
export type AdlsPolicy = { state?: string; immutabilityPeriodSinceCreationInDays?: number; allowProtectedAppendWrites?: boolean; allowProtectedAppendWritesAll?: boolean };
export type AdlsClients = {
  container: Pick<ContainerClient, "getBlockBlobClient" | "getProperties" | "createIfNotExists" | "listBlobsFlat">;
  account: () => Promise<{ isHnsEnabled?: boolean; isNfsV3Enabled?: boolean; isSftpEnabled?: boolean }>;
  policy: () => Promise<AdlsPolicy>;
};
export type AdlsStoreConfig = { endpoint: string; container: string; credentials: AdlsCredential; immutability: "container_policy" | "none"; clients?: AdlsClients };

/** Keep Azure credentials on Azure's public-cloud storage endpoints, never an arbitrary URL. */
export function adlsEndpoint(value: string): { accountName: string; blobEndpoint: string; dfsEndpoint: string } {
  let url: URL;
  try { url = new URL(value); } catch { throw new BlobStoreError("blob.adls_endpoint_invalid", 400); }
  const match = url.hostname.match(/^([a-z0-9]{3,24})\.(?:dfs|blob)\.core\.windows\.net$/);
  if (!match || url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/") throw new BlobStoreError("blob.adls_endpoint_invalid", 400);
  return { accountName: match[1]!, blobEndpoint: `https://${match[1]}.blob.core.windows.net`, dfsEndpoint: `https://${match[1]}.dfs.core.windows.net` };
}

export function parseAdlsCredential(value: unknown): AdlsCredential {
  const fields = ["tenantId", "clientId", "clientSecret", "subscriptionId", "resourceGroup"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new BlobStoreError("blob.adls_credentials_invalid");
  const input = value as Record<string, unknown>;
  if (fields.some(key => typeof input[key] !== "string" || !(input[key] as string).length || (input[key] as string).length > 65536)) throw new BlobStoreError("blob.adls_credentials_invalid");
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  if (!["tenantId", "clientId", "subscriptionId"].every(key => uuid.test(input[key] as string)) || !/^[a-zA-Z0-9_.()-]{1,90}$/.test(input.resourceGroup as string)) throw new BlobStoreError("blob.adls_credentials_invalid");
  return input as AdlsCredential;
}

function clientsFor(config: AdlsStoreConfig): AdlsClients {
  const endpoint = adlsEndpoint(config.endpoint);
  if (!/^[a-z0-9](?!.*--)[a-z0-9-]{1,61}[a-z0-9]$/.test(config.container)) throw new BlobStoreError("blob.container_name_invalid");
  if (config.clients) return config.clients;
  const input = parseAdlsCredential(config.credentials);
  const credential = new ClientSecretCredential(input.tenantId, input.clientId, input.clientSecret);
  const management = new StorageManagementClient(credential, input.subscriptionId);
  return {
    container: new BlobServiceClient(endpoint.blobEndpoint, credential).getContainerClient(config.container),
    account: () => management.storageAccounts.getProperties(input.resourceGroup, endpoint.accountName, { abortSignal: AbortSignal.timeout(15000) }),
    policy: () => management.blobContainers.getImmutabilityPolicy(input.resourceGroup, endpoint.accountName, config.container, { abortSignal: AbortSignal.timeout(15000) }),
  };
}

function protectedDays(policy: AdlsPolicy): number {
  const days = policy.immutabilityPeriodSinceCreationInDays;
  if (policy.state !== "Locked" || !Number.isInteger(days) || days! < 1 || days! > 146000 || policy.allowProtectedAppendWrites || policy.allowProtectedAppendWritesAll) throw new BlobStoreError("blob.adls_locked_container_policy_required");
  return days!;
}

/** Read-only: verifies real HNS, locked WORM and existing file expirations, without changing a policy. */
export async function qualifyAdlsEvidence(config: Omit<AdlsStoreConfig, "immutability">): Promise<{ retentionDays: number; scope: "container" }> {
  const clients = clientsFor({ ...config, immutability: "container_policy" });
  const [account, policy, properties] = await Promise.all([clients.account(), clients.policy(), clients.container.getProperties({ abortSignal: AbortSignal.timeout(15000) })]);
  if (!account.isHnsEnabled || account.isNfsV3Enabled || account.isSftpEnabled) throw new BlobStoreError("blob.adls_hns_account_required");
  const retentionDays = protectedDays(policy);
  if (!properties.hasImmutabilityPolicy) throw new BlobStoreError("blob.adls_locked_container_policy_required");
  for await (const blob of clients.container.listBlobsFlat({ abortSignal: AbortSignal.timeout(15000) })) {
    // HNS expiration predating a container policy can still delete a file under WORM.
    if (blob.properties.expiresOn) throw new BlobStoreError("blob.adls_file_expiration_forbidden");
  }
  return { retentionDays, scope: "container" };
}

const status = (error: unknown) => (error as { statusCode?: number })?.statusCode;

/** ADLS Gen2 uses Blob APIs through the hierarchical namespace (Azure multi-protocol access). */
export function createAdlsBlobContainer(config: AdlsStoreConfig, env: NodeJS.ProcessEnv = process.env): BlobContainer {
  const { blobEndpoint } = adlsEndpoint(config.endpoint);
  if (isProductionProfile(env) && config.immutability !== "container_policy") throw new BlobStoreError("blob.adls_locked_container_policy_required");
  const clients = clientsFor(config);
  const account = new URL(blobEndpoint).host;
  const key = (name: string) => {
    if (!name || name.length > 1024 || name.startsWith("/") || name.includes("..")) throw new BlobStoreError("blob.name_invalid", 400);
    return name;
  };
  const days = async () => protectedDays(await clients.policy());
  const head = async (name: string): Promise<BlobHead> => {
    let properties;
    try {
      properties = await clients.container.getBlockBlobClient(key(name)).getProperties();
    } catch (error) { if (status(error) === 404) return { exists: false }; throw error; }
    if (properties.expiresOn) throw new BlobStoreError("blob.adls_file_expiration_forbidden");
    const protectedStorage = config.immutability === "container_policy";
    if (protectedStorage && !properties.createdOn) throw new BlobStoreError("blob.adls_creation_time_required");
    const retentionDays = protectedStorage ? await days() : 0;
    const container = protectedStorage ? await clients.container.getProperties() : undefined;
    if (protectedStorage && (!container?.hasImmutabilityPolicy || typeof container.hasLegalHold !== "boolean")) throw new BlobStoreError("blob.adls_policy_state_unavailable");
    return { exists: true, length: properties.contentLength ?? 0, sha256: properties.metadata?.sha256 ?? null, versionId: null,
      retainUntil: protectedStorage ? new Date(properties.createdOn!.getTime() + retentionDays * 86400000) : null,
      retentionMode: protectedStorage ? "locked" : null, legalHold: container?.hasLegalHold ?? false };
  };
  return {
    account, container: config.container, immutability: config.immutability,
    async ensure() {
      if (isProductionProfile(env)) throw new BlobStoreError("blob.adls_provision_outside_runtime");
      await clients.container.createIfNotExists();
    },
    async putImmutable(name, bytes, options) {
      const blob = clients.container.getBlockBlobClient(key(name));
      if (sha256Hex(bytes) !== options.sha256) throw new BlobStoreError("blob.digest_mismatch", 400);
      if (config.immutability === "container_policy") await days();
      try {
        await blob.upload(bytes, bytes.length, { conditions: { ifNoneMatch: "*" }, metadata: { sha256: options.sha256 }, blobHTTPHeaders: { blobContentType: options.contentType } });
      } catch (error) {
        if (status(error) !== 409 && status(error) !== 412) throw error;
        const existing = await head(name);
        if (!existing.exists || existing.sha256 !== options.sha256 || existing.length !== bytes.length || sha256Hex(await blob.downloadToBuffer()) !== options.sha256) throw new BlobStoreError("blob.content_conflict", 409);
      }
      return { account, container: config.container, name, versionId: null, length: bytes.length, sha256: options.sha256 };
    },
    async get(name) {
      try { return await clients.container.getBlockBlobClient(key(name)).downloadToBuffer(); }
      catch (error) { if (status(error) === 404) throw new BlobStoreError("blob.not_found", 404); throw error; }
    },
    head,
    async setRetention(name, until, locked) {
      const current = await head(name);
      if (!current.exists) throw new BlobStoreError("blob.not_found", 404);
      if (!current.retainUntil || current.retainUntil < until || (locked && current.retentionMode !== "locked")) return { applied: false, state: "NOT_ENFORCED" };
      return { applied: true, state: "UNCHANGED" };
    },
    async setLegalHold(name, hold) {
      if (config.immutability === "none") return { applied: false, state: "NOT_ENFORCED" };
      const current = await head(name);
      if (!current.exists) throw new BlobStoreError("blob.not_found", 404);
      // Per-file requests never set or clear a hold that affects unrelated files.
      return current.legalHold === hold ? { applied: true, state: "UNCHANGED" } : { applied: false, state: "NOT_ENFORCED" };
    },
    async delete(name) { return (await clients.container.getBlockBlobClient(key(name)).deleteIfExists()).succeeded; },
    async *list(prefix) {
      for await (const blob of clients.container.listBlobsFlat({ prefix, includeMetadata: true })) {
        if (blob.metadata?.hdi_isfolder === "true") continue;
        const properties = await head(blob.name);
        if (properties.exists) yield { name: blob.name, length: properties.length ?? 0, sha256: properties.sha256 ?? null, retainUntil: properties.retainUntil ?? null, retentionMode: properties.retentionMode ?? null, legalHold: properties.legalHold ?? false };
      }
    },
  };
}
