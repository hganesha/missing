import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  PutObjectLegalHoldCommand,
  PutObjectRetentionCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { isProductionProfile } from "@ehf/identity";
import { createAdlsBlobContainer, parseAdlsCredential } from "./adls.js";
export { createAdlsBlobContainer } from "./adls.js";
import { createAzureBlobContainer, type AzureBlobCredentials } from "./azure-blob.js";

export { createAzureBlobContainer, type AzureBlobCredentials, type AzureBlobStoreConfig } from "./azure-blob.js";

/**
 * Object storage for the platform's durable bytes (docs/implementation/data-stores-plan.md
 * §3.6): evidence artifacts, signed ledger segments, context packs. One container (bucket) per
 * purpose, so retention and access policies never conflict.
 *
 * Provider adapters speak S3-compatible APIs or ADLS Gen2 multi-protocol Blob APIs.
 * Writes are content-addressed and never overwrite: putImmutable with the same name and the
 * same bytes is a no-op, different bytes under an existing name are refused. Retention and
 * legal hold use S3 Object Lock; a bucket without it reports that the policy was not applied
 * rather than pretending it was.
 */

/** S3 object lock, ADLS locked container retention, or unprotected development storage. */
export type Immutability = "object_lock" | "container_policy" | "none";

export type StoredBlob = { account: string; container: string; name: string; versionId: string | null; length: number; sha256: string };

export type BlobHead = {
  exists: boolean;
  length?: number;
  sha256?: string | null;
  versionId?: string | null;
  retainUntil?: Date | null;
  retentionMode?: string | null;
  legalHold?: boolean;
};

export type ListedBlob = {
  name: string;
  length: number;
  sha256: string | null;
  retainUntil?: Date | null;
  retentionMode?: string | null;
  legalHold?: boolean;
};

export type PolicyResult = { applied: boolean; state: "APPLIED" | "LOCKED" | "NOT_ENFORCED" | "UNCHANGED" };

export interface BlobContainer {
  readonly account: string;
  readonly container: string;
  readonly immutability: Immutability;
  /** Create the bucket when it does not exist (development only; a deployment provisions its own). */
  ensure(): Promise<void>;
  putImmutable(name: string, bytes: Uint8Array, options: { contentType: string; sha256: string }): Promise<StoredBlob>;
  get(name: string): Promise<Buffer>;
  head(name: string): Promise<BlobHead>;
  /** Keep the blob until `until`. Never shortens an existing retention; `locked` cannot be undone. */
  setRetention(name: string, until: Date, locked: boolean): Promise<PolicyResult>;
  setLegalHold(name: string, hold: boolean): Promise<PolicyResult>;
  delete(name: string): Promise<boolean>;
  /** Blobs under a prefix; with object lock, also their retention and legal hold. */
  list(prefix: string): AsyncIterable<ListedBlob>;
}

/**
 * The retention to set: never earlier than the blob already has (locked retention can only be
 * extended, and an unlocked one is not shortened by this platform either), and locked once
 * locked. `change` is false when the blob already has exactly that.
 */
export function retentionDecision(current: Pick<BlobHead, "retainUntil" | "retentionMode">, until: Date, locked: boolean): { change: boolean; until: Date; mode: "Locked" | "Unlocked" } {
  const keepUntil = current.retainUntil && current.retainUntil > until ? current.retainUntil : until;
  const alreadyLocked = String(current.retentionMode ?? "").toLowerCase() === "locked";
  const mode = locked || alreadyLocked ? "Locked" : "Unlocked";
  const same = Boolean(current.retainUntil) && current.retainUntil!.getTime() === keepUntil.getTime()
    && String(current.retentionMode ?? "").toLowerCase() === mode.toLowerCase();
  return { change: !same, until: keepUntil, mode };
}

export class BlobStoreError extends Error {
  constructor(readonly code: string, readonly httpStatus = 500) {
    super(code);
    this.name = "BlobStoreError";
  }
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type S3ObjectStoreConfig = {
  /** The bucket (the container of the BlobContainer interface). */
  container: string;
  immutability: "object_lock" | "none";
  /** S3-compatible endpoint, e.g. https://minio.internal:9000; absent means the client's default. */
  endpoint?: string;
  region?: string;
  /** Path-style addressing (bucket in the path), which most self-hosted stores need. */
  forcePathStyle?: boolean;
  /**
   * Static credentials. Absent, the client's standard provider chain applies (web-identity
   * token file, the runtime's instance or workload credentials, shared files), which is how a
   * production deployment authenticates without a long-lived key.
   */
  credentials?: { accessKeyId: string; secretAccessKey: string };
  /** Test seam: a client to use instead of one built from the settings above. */
  client?: Pick<S3Client, "send">;
};

const BUCKET_NAME = /^[a-z0-9](?!.*\.\.)[a-z0-9.-]{1,61}[a-z0-9]$/;

function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
}

function notFound(error: unknown): boolean {
  const name = (error as { name?: string })?.name;
  return statusOf(error) === 404 || name === "NotFound" || name === "NoSuchKey";
}

function lockMode(mode: string | undefined | null): string | null {
  if (!mode) return null;
  return mode.toUpperCase() === "COMPLIANCE" ? "locked" : mode.toUpperCase() === "GOVERNANCE" ? "unlocked" : mode.toLowerCase();
}

export function createS3BlobContainer(config: S3ObjectStoreConfig, env: NodeJS.ProcessEnv = process.env): BlobContainer {
  if (!BUCKET_NAME.test(config.container)) throw new BlobStoreError("blob.container_name_invalid");
  let endpoint: URL | undefined;
  if (config.endpoint) {
    try { endpoint = new URL(config.endpoint); } catch { throw new BlobStoreError("blob.endpoint_invalid"); }
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new BlobStoreError("blob.endpoint_invalid");
    if (isProductionProfile(env) && endpoint.protocol !== "https:") throw new BlobStoreError("blob.endpoint_invalid");
  }
  const region = config.region ?? "us-east-1";
  const client = config.client ?? new S3Client({
    region,
    ...(endpoint ? { endpoint: endpoint.toString(), forcePathStyle: config.forcePathStyle ?? true } : {}),
    ...(config.credentials ? { credentials: config.credentials } : {}),
  });
  const bucket = config.container;
  const account = endpoint ? endpoint.host : `s3:${region}`;
  const locked = config.immutability === "object_lock";
  const key = (name: string) => {
    if (!name || name.length > 1024 || name.startsWith("/") || name.includes("..")) throw new BlobStoreError("blob.name_invalid", 400);
    return name;
  };
  const head = async (name: string): Promise<BlobHead> => {
    try {
      const properties = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key(name) }));
      return {
        exists: true,
        length: properties.ContentLength ?? 0,
        sha256: properties.Metadata?.sha256 ?? null,
        versionId: properties.VersionId ?? null,
        retainUntil: properties.ObjectLockRetainUntilDate ?? null,
        retentionMode: lockMode(properties.ObjectLockMode),
        legalHold: properties.ObjectLockLegalHoldStatus === "ON",
      };
    } catch (error) {
      if (notFound(error)) return { exists: false };
      throw error;
    }
  };
  return {
    account,
    container: bucket,
    immutability: config.immutability,
    async ensure() {
      try {
        await client.send(new CreateBucketCommand({ Bucket: bucket, ...(locked ? { ObjectLockEnabledForBucket: true } : {}) }));
      } catch (error) {
        const name = (error as { name?: string })?.name;
        if (name !== "BucketAlreadyOwnedByYou" && name !== "BucketAlreadyExists" && statusOf(error) !== 409) throw error;
      }
    },
    async putImmutable(name, bytes, options) {
      if (sha256Hex(bytes) !== options.sha256) throw new BlobStoreError("blob.digest_mismatch", 400);
      try {
        const uploaded = await client.send(new PutObjectCommand({
          Bucket: bucket, Key: key(name), Body: bytes, ContentType: options.contentType,
          Metadata: { sha256: options.sha256 }, IfNoneMatch: "*",
        }));
        return { account, container: bucket, name, versionId: uploaded.VersionId ?? null, length: bytes.length, sha256: options.sha256 };
      } catch (error) {
        const status = statusOf(error);
        if (status !== 409 && status !== 412) throw error;
        // Content addressing: the same name must hold the same bytes, or nothing is written.
        const existing = await head(name);
        if (!existing.exists || existing.sha256 !== options.sha256 || existing.length !== bytes.length) {
          throw new BlobStoreError("blob.content_conflict", 409);
        }
        return { account, container: bucket, name, versionId: existing.versionId ?? null, length: bytes.length, sha256: options.sha256 };
      }
    },
    async get(name) {
      try {
        const object = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key(name) }));
        const body = object.Body as { transformToByteArray?: () => Promise<Uint8Array> } | undefined;
        if (!body?.transformToByteArray) throw new BlobStoreError("blob.body_missing");
        return Buffer.from(await body.transformToByteArray());
      } catch (error) {
        if (notFound(error)) throw new BlobStoreError("blob.not_found", 404);
        throw error;
      }
    },
    head,
    async setRetention(name, until, lockedRetention) {
      if (!locked) return { applied: false, state: "NOT_ENFORCED" };
      const current = await head(name);
      if (!current.exists) throw new BlobStoreError("blob.not_found", 404);
      const decision = retentionDecision(current, until, lockedRetention);
      if (!decision.change) return { applied: true, state: "UNCHANGED" };
      // Locked maps to COMPLIANCE (no one can shorten or remove it), unlocked to GOVERNANCE.
      // Raising GOVERNANCE to COMPLIANCE is the one change that needs the bypass permission.
      await client.send(new PutObjectRetentionCommand({
        Bucket: bucket, Key: key(name),
        Retention: { Mode: decision.mode === "Locked" ? "COMPLIANCE" : "GOVERNANCE", RetainUntilDate: decision.until },
        ...(decision.mode === "Locked" && current.retentionMode === "unlocked" ? { BypassGovernanceRetention: true } : {}),
      }));
      return { applied: true, state: decision.mode === "Locked" ? "LOCKED" : "APPLIED" };
    },
    async setLegalHold(name, hold) {
      if (!locked) return { applied: false, state: "NOT_ENFORCED" };
      await client.send(new PutObjectLegalHoldCommand({ Bucket: bucket, Key: key(name), LegalHold: { Status: hold ? "ON" : "OFF" } }));
      return { applied: true, state: "APPLIED" };
    },
    async delete(name) {
      if (!(await head(name)).exists) return false;
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key(name) }));
      return true;
    },
    async *list(prefix) {
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ...(token ? { ContinuationToken: token } : {}) }));
        for (const item of page.Contents ?? []) {
          if (!item.Key) continue;
          // Listings carry no user metadata or lock state; each entry's head supplies both.
          const details = await head(item.Key);
          if (!details.exists) continue;
          yield {
            name: item.Key, length: details.length ?? item.Size ?? 0, sha256: details.sha256 ?? null,
            ...(locked ? { retainUntil: details.retainUntil ?? null, retentionMode: details.retentionMode ?? null, legalHold: details.legalHold ?? false } : {}),
          };
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    },
  };
}

function secretFromEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const inline = env[name];
  const file = env[`${name}_FILE`];
  if (inline && isProductionProfile(env)) throw new BlobStoreError(`blob.inline_secret_forbidden_in_production:${name}`);
  if (inline) return inline;
  if (!file) return undefined;
  try { return readFileSync(file, "utf8").trim() || undefined; } catch { throw new BlobStoreError(`blob.secret_unreadable:${name}`); }
}

/**
 * A container named by `<PREFIX>_BLOB_*` settings: `_BUCKET` (required to enable it),
 * `_PROVIDER` (s3, the default, or azure_blob), `_ENDPOINT` and `_IMMUTABILITY`
 * (object_lock|none; production requires object_lock). Returns null when the purpose has no
 * bucket configured. Secrets are mounted files (`<NAME>_FILE`); the inline form is accepted
 * outside production only.
 *
 * s3: `_REGION`, `_FORCE_PATH_STYLE`, and optionally `_ACCESS_KEY_ID` with
 * `_SECRET_ACCESS_KEY_FILE`. Without a key the client's standard credential chain applies.
 *
 * azure_blob: `_ENDPOINT` is the account's blob endpoint and `_BUCKET` the container;
 * `_ACCOUNT` names the account when the endpoint host does not. Exactly one credential:
 * `_ACCOUNT_KEY_FILE` (shared key), or OAuth client credentials (`_OAUTH_TOKEN_URL`,
 * `_OAUTH_CLIENT_ID`, `_OAUTH_CLIENT_SECRET_FILE`, optional `_OAUTH_SCOPE`).
 * ADLS Gen2 uses adls_gen2, container_policy and _AZURE_CREDENTIAL_FILE.
 */
export function blobContainerFromEnv(prefix: string, env: NodeJS.ProcessEnv = process.env): BlobContainer | null {
  const bucket = env[`${prefix}_BLOB_BUCKET`];
  if (!bucket) return null;
  const provider = env[`${prefix}_BLOB_PROVIDER`] ?? "s3";
  if (!["s3", "adls_gen2", "azure_blob"].includes(provider)) throw new BlobStoreError(`blob.provider_invalid:${prefix}`);
  if (provider === "adls_gen2") {
    const immutability = env[`${prefix}_BLOB_IMMUTABILITY`] ?? "container_policy";
    if (immutability !== "container_policy" && immutability !== "none") throw new BlobStoreError(`blob.immutability_invalid:${prefix}`);
    const credential = secretFromEnv(env, `${prefix}_BLOB_AZURE_CREDENTIAL`);
    if (!credential) throw new BlobStoreError(`blob.credentials_incomplete:${prefix}`);
    let parsed: unknown;
    try { parsed = JSON.parse(credential); } catch { throw new BlobStoreError("blob.adls_credentials_invalid"); }
    return createAdlsBlobContainer({ endpoint: env[`${prefix}_BLOB_ENDPOINT`] ?? "", container: bucket, immutability, credentials: parseAdlsCredential(parsed) }, env);
  }
  const immutability = (env[`${prefix}_BLOB_IMMUTABILITY`] ?? (isProductionProfile(env) ? "object_lock" : "none")) as Immutability;
  if (immutability !== "object_lock" && immutability !== "none") throw new BlobStoreError(`blob.immutability_invalid:${prefix}`);
  if (isProductionProfile(env) && immutability !== "object_lock") throw new BlobStoreError(`blob.immutability_required_in_production:${prefix}`);

  const endpoint = env[`${prefix}_BLOB_ENDPOINT`];
  if (provider === "azure_blob") {
    if (!endpoint) throw new BlobStoreError(`blob.endpoint_required:${prefix}`);
    const account = env[`${prefix}_BLOB_ACCOUNT`];
    const accountKey = secretFromEnv(env, `${prefix}_BLOB_ACCOUNT_KEY`);
    const tokenUrl = env[`${prefix}_BLOB_OAUTH_TOKEN_URL`];
    const clientId = env[`${prefix}_BLOB_OAUTH_CLIENT_ID`];
    const clientSecret = secretFromEnv(env, `${prefix}_BLOB_OAUTH_CLIENT_SECRET`);
    const scope = env[`${prefix}_BLOB_OAUTH_SCOPE`];
    const oauth = [tokenUrl, clientId, clientSecret].filter(Boolean).length;
    if (Boolean(accountKey) === (oauth === 3) || (oauth !== 0 && oauth !== 3)) throw new BlobStoreError(`blob.credentials_incomplete:${prefix}`);
    const credentials: AzureBlobCredentials = accountKey ? { accountKey }
      : { tokenUrl: tokenUrl!, clientId: clientId!, clientSecret: clientSecret!, ...(scope ? { scope } : {}) };
    return createAzureBlobContainer({ container: bucket, immutability, endpoint, credentials, ...(account ? { account } : {}) }, env);
  }
  if (provider !== "s3") throw new BlobStoreError(`blob.provider_invalid:${prefix}`);
  const accessKeyId = env[`${prefix}_BLOB_ACCESS_KEY_ID`];
  const secretAccessKey = secretFromEnv(env, `${prefix}_BLOB_SECRET_ACCESS_KEY`);
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) throw new BlobStoreError(`blob.credentials_incomplete:${prefix}`);
  const pathStyle = env[`${prefix}_BLOB_FORCE_PATH_STYLE`];
  const region = env[`${prefix}_BLOB_REGION`];
  return createS3BlobContainer({
    container: bucket, immutability,
    ...(endpoint ? { endpoint } : {}),
    ...(region ? { region } : {}),
    ...(pathStyle ? { forcePathStyle: pathStyle === "true" } : {}),
    ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
  }, env);
}
