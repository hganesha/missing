import { createHmac } from "node:crypto";
import { clientCredentialsToken, isProductionProfile } from "@ehf/identity";
import { BlobStoreError, retentionDecision, sha256Hex, type BlobContainer, type BlobHead, type Immutability } from "./index.js";

/**
 * The same BlobContainer over the Azure Blob service REST API, for deployments whose object
 * store is an Azure storage account (which does not serve the S3 API). It calls the service
 * with `fetch`; no vendor SDK is involved.
 *
 * `object_lock` here is version-level immutability (WORM): per-blob retention maps to the
 * blob's immutability policy (Locked or Unlocked) and legal hold to the blob's legal hold.
 * The container must have version-level immutability enabled when it is provisioned.
 * Accounts with a hierarchical namespace (ADLS Gen2) serve this API too, but do not offer
 * version-level immutability, so they can only back an `immutability: none` container.
 */

/** The service version sent with every request; immutability policies need 2020-06-12 or later. */
const API_VERSION = "2023-11-03";
const REQUEST_TIMEOUT_MS = 60_000;
/** Lowercase letters, digits and single hyphens, 3 to 63 characters. */
const CONTAINER_NAME = /^(?!.*--)[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const ACCOUNT_NAME = /^[a-z0-9]{3,24}$/;

export type AzureBlobCredentials =
  /** The storage account's shared key (base64), signing each request. */
  | { accountKey: string }
  /** OAuth 2.0 client credentials against the directory's token endpoint; the token is sent as a bearer. */
  | { tokenUrl: string; clientId: string; clientSecret: string; scope?: string };

export type AzureBlobStoreConfig = {
  container: string;
  immutability: Immutability;
  /** The account's blob endpoint, e.g. https://ACCOUNT.blob.core.windows.net (an emulator's URL includes the account path). */
  endpoint: string;
  /** The storage account name; absent, the endpoint host's first label. */
  account?: string;
  credentials: AzureBlobCredentials;
  /** Test seam. */
  fetch?: typeof fetch;
};

const SIGNED_HEADERS = ["content-encoding", "content-language", "content-length", "content-md5", "content-type", "date",
  "if-modified-since", "if-match", "if-none-match", "if-unmodified-since", "range"];

/** The `Authorization` value of the Shared Key scheme for one request. Header names must be lowercase. */
export function sharedKeyAuthorization(method: string, url: URL, headers: Record<string, string>, account: string, accountKey: string): string {
  const standard = SIGNED_HEADERS.map(name => name === "content-length" && headers[name] === "0" ? "" : headers[name] ?? "");
  const custom = Object.keys(headers).filter(name => name.startsWith("x-ms-")).sort().map(name => `${name}:${headers[name]!.trim()}`);
  const query = new Map<string, string[]>();
  for (const [name, value] of url.searchParams) query.set(name.toLowerCase(), [...(query.get(name.toLowerCase()) ?? []), value]);
  const resource = [`/${account}${url.pathname}`, ...[...query.keys()].sort().map(name => `${name}:${query.get(name)!.sort().join(",")}`)];
  const stringToSign = [method.toUpperCase(), ...standard, ...custom, ...resource].join("\n");
  return `SharedKey ${account}:${createHmac("sha256", Buffer.from(accountKey, "base64")).update(stringToSign, "utf8").digest("base64")}`;
}

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function xmlText(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (match, entity: string) =>
    entity.startsWith("#x") ? String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
      : entity.startsWith("#") ? String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
        : XML_ENTITIES[entity] ?? match);
}

/** Blob names and the continuation marker of one List Blobs page. */
export function parseBlobListing(xml: string): { names: string[]; nextMarker: string | null } {
  const names = [...xml.matchAll(/<Blob>[\s\S]*?<Name>([\s\S]*?)<\/Name>/g)].map(match => xmlText(match[1]!));
  const marker = /<NextMarker>([\s\S]*?)<\/NextMarker>/.exec(xml)?.[1];
  return { names, nextMarker: marker ? xmlText(marker) : null };
}

type Client = { account: string; send(method: string, path: string, query?: Record<string, string>, headers?: Record<string, string>, body?: Uint8Array): Promise<Response> };

function createClient(config: Pick<AzureBlobStoreConfig, "endpoint" | "account" | "credentials" | "fetch">, production: boolean): Client {
  let endpoint: URL;
  try { endpoint = new URL(config.endpoint); } catch { throw new BlobStoreError("blob.endpoint_invalid"); }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new BlobStoreError("blob.endpoint_invalid");
  if (endpoint.protocol !== "https:" && (production || endpoint.protocol !== "http:")) throw new BlobStoreError("blob.endpoint_invalid");
  const account = config.account ?? endpoint.hostname.split(".")[0]!;
  if (!ACCOUNT_NAME.test(account)) throw new BlobStoreError("blob.account_invalid");
  const credentials = config.credentials;
  if ("accountKey" in credentials ? !credentials.accountKey : !credentials.tokenUrl || !credentials.clientId || !credentials.clientSecret) throw new BlobStoreError("blob.credentials_incomplete");
  const base = endpoint.toString().replace(/\/$/, "");
  const fetcher = config.fetch ?? fetch;
  return {
    account,
    async send(method, path, query = {}, headers = {}, body) {
      const url = new URL(`${base}/${path}`);
      for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value);
      const all: Record<string, string> = { ...headers, "x-ms-date": new Date().toUTCString(), "x-ms-version": API_VERSION };
      if ("accountKey" in credentials) {
        all.authorization = sharedKeyAuthorization(method, url, { ...all, "content-length": String(body?.length ?? 0) }, account, credentials.accountKey);
      } else {
        const token = await clientCredentialsToken({ tokenUrl: credentials.tokenUrl, clientId: credentials.clientId, clientSecret: credentials.clientSecret,
          scope: credentials.scope ?? "https://storage.azure.com/.default" }, { fetch: fetcher });
        all.authorization = `Bearer ${token}`;
      }
      return fetcher(url, { method, headers: all, ...(body ? { body: body as unknown as BodyInit } : {}), redirect: "error", signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    },
  };
}

/** A failed call, by the service's own error code. The response body is never kept: it can echo request details. */
async function failure(response: Response): Promise<BlobStoreError> {
  await response.arrayBuffer().catch(() => undefined);
  const code = (response.headers.get("x-ms-error-code") ?? "").replace(/[^A-Za-z0-9]/g, "").slice(0, 80);
  return new BlobStoreError(`blob.azure_request_failed:${response.status}${code ? `:${code}` : ""}`, response.status >= 500 ? 502 : 500);
}

export function createAzureBlobContainer(config: AzureBlobStoreConfig, env: NodeJS.ProcessEnv = process.env): BlobContainer {
  if (!CONTAINER_NAME.test(config.container)) throw new BlobStoreError("blob.container_name_invalid");
  const client = createClient(config, isProductionProfile(env));
  const container = config.container;
  const account = client.account;
  const locked = config.immutability === "object_lock";
  const path = (name: string) => {
    if (!name || name.length > 1024 || name.startsWith("/") || name.includes("..")) throw new BlobStoreError("blob.name_invalid", 400);
    return `${container}/${name.split("/").map(encodeURIComponent).join("/")}`;
  };
  const head = async (name: string): Promise<BlobHead> => {
    const response = await client.send("HEAD", path(name));
    if (response.status === 404) return { exists: false };
    if (!response.ok) throw await failure(response);
    const until = response.headers.get("x-ms-immutability-policy-until-date");
    return {
      exists: true,
      length: Number(response.headers.get("content-length") ?? 0),
      sha256: response.headers.get("x-ms-meta-sha256"),
      versionId: response.headers.get("x-ms-version-id"),
      retainUntil: until ? new Date(until) : null,
      retentionMode: response.headers.get("x-ms-immutability-policy-mode")?.toLowerCase() ?? null,
      legalHold: response.headers.get("x-ms-legal-hold") === "true",
    };
  };
  return {
    account,
    container,
    immutability: config.immutability,
    async ensure() {
      // Development only. Version-level immutability is set when a deployment provisions the container.
      const response = await client.send("PUT", container, { restype: "container" });
      await response.arrayBuffer().catch(() => undefined);
      if (!response.ok && response.status !== 409) throw await failure(response);
    },
    async putImmutable(name, bytes, options) {
      if (sha256Hex(bytes) !== options.sha256) throw new BlobStoreError("blob.digest_mismatch", 400);
      const response = await client.send("PUT", path(name), {}, {
        "x-ms-blob-type": "BlockBlob", "x-ms-blob-content-type": options.contentType, "x-ms-meta-sha256": options.sha256, "if-none-match": "*",
      }, bytes);
      if (response.ok) {
        await response.arrayBuffer().catch(() => undefined);
        return { account, container, name, versionId: response.headers.get("x-ms-version-id"), length: bytes.length, sha256: options.sha256 };
      }
      if (response.status !== 409 && response.status !== 412) throw await failure(response);
      await response.arrayBuffer().catch(() => undefined);
      // Content addressing: the same name must hold the same bytes, or nothing is written.
      const existing = await head(name);
      if (!existing.exists || existing.sha256 !== options.sha256 || existing.length !== bytes.length) throw new BlobStoreError("blob.content_conflict", 409);
      return { account, container, name, versionId: existing.versionId ?? null, length: bytes.length, sha256: options.sha256 };
    },
    async get(name) {
      const response = await client.send("GET", path(name));
      if (response.status === 404) { await response.arrayBuffer().catch(() => undefined); throw new BlobStoreError("blob.not_found", 404); }
      if (!response.ok) throw await failure(response);
      return Buffer.from(await response.arrayBuffer());
    },
    head,
    async setRetention(name, until, lockedRetention) {
      if (!locked) return { applied: false, state: "NOT_ENFORCED" };
      const current = await head(name);
      if (!current.exists) throw new BlobStoreError("blob.not_found", 404);
      // The service keeps whole seconds; rounding up first never shortens what was asked for.
      const decision = retentionDecision(current, new Date(Math.ceil(until.getTime() / 1000) * 1000), lockedRetention);
      if (!decision.change) return { applied: true, state: "UNCHANGED" };
      const response = await client.send("PUT", path(name), { comp: "immutabilityPolicies" }, {
        "x-ms-immutability-policy-until-date": decision.until.toUTCString(), "x-ms-immutability-policy-mode": decision.mode,
      });
      if (!response.ok) throw await failure(response);
      await response.arrayBuffer().catch(() => undefined);
      return { applied: true, state: decision.mode === "Locked" ? "LOCKED" : "APPLIED" };
    },
    async setLegalHold(name, hold) {
      if (!locked) return { applied: false, state: "NOT_ENFORCED" };
      const response = await client.send("PUT", path(name), { comp: "legalhold" }, { "x-ms-legal-hold": String(hold) });
      if (response.status === 404) { await response.arrayBuffer().catch(() => undefined); throw new BlobStoreError("blob.not_found", 404); }
      if (!response.ok) throw await failure(response);
      await response.arrayBuffer().catch(() => undefined);
      return { applied: true, state: "APPLIED" };
    },
    async delete(name) {
      const response = await client.send("DELETE", path(name));
      if (response.status === 404) { await response.arrayBuffer().catch(() => undefined); return false; }
      if (response.status === 409 && /Immutable|LegalHold/i.test(response.headers.get("x-ms-error-code") ?? "")) {
        await response.arrayBuffer().catch(() => undefined);
        throw new BlobStoreError("blob.delete_refused_retained", 409);
      }
      if (!response.ok) throw await failure(response);
      await response.arrayBuffer().catch(() => undefined);
      return true;
    },
    async *list(prefix) {
      let marker: string | null = null;
      do {
        const response = await client.send("GET", container, { restype: "container", comp: "list", prefix, ...(marker ? { marker } : {}) });
        if (!response.ok) throw await failure(response);
        const page = parseBlobListing(await response.text());
        for (const name of page.names) {
          // As with the S3 adapter, each entry's head supplies the digest and the lock state.
          const details = await head(name);
          if (!details.exists) continue;
          yield {
            name, length: details.length ?? 0, sha256: details.sha256 ?? null,
            ...(locked ? { retainUntil: details.retainUntil ?? null, retentionMode: details.retentionMode ?? null, legalHold: details.legalHold ?? false } : {}),
          };
        }
        marker = page.nextMarker;
      } while (marker);
    },
  };
}

/** Read-only deployment qualification: the container exists and enforces version-level immutability. */
export async function qualifyProtectedAzureContainer(input: { endpoint: string; bucket: string; accountName?: string; accountKey: string; fetch?: typeof fetch }): Promise<void> {
  if (!CONTAINER_NAME.test(input.bucket)) throw new Error("blob.qualification_input_invalid");
  let client: Client;
  try {
    client = createClient({ endpoint: input.endpoint, credentials: { accountKey: input.accountKey }, ...(input.accountName ? { account: input.accountName } : {}), ...(input.fetch ? { fetch: input.fetch } : {}) }, true);
  } catch { throw new Error("blob.qualification_input_invalid"); }
  const response = await client.send("HEAD", input.bucket, { restype: "container" });
  if (!response.ok) throw new Error(`blob.qualification_failed:${response.status}`);
  if (response.headers.get("x-ms-immutable-storage-with-versioning-enabled") !== "true") throw new Error("blob.versioned_object_lock_required");
}
