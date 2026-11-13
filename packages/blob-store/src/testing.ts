import { BlobStoreError, retentionDecision, sha256Hex, type BlobContainer, type BlobHead, type Immutability } from "./index.js";

type Stored = { bytes: Buffer; sha256: string | null; contentType: string; version: number; retainUntil: Date | null; retentionMode: string | null; legalHold: boolean };

/**
 * An in-memory BlobContainer with the same rules as the object store: content-addressed writes
 * that never overwrite, and under `object_lock` per-object retention that is never shortened,
 * locked retention that cannot be lifted, legal holds, and deletes refused while either holds.
 * For tests of the stores built on top of it; the S3 adapter itself is exercised against a real
 * S3-compatible server (EHF_TEST_S3_ENDPOINT), and the Azure Blob adapter against the Azure Blob
 * API (EHF_TEST_AZURE_BLOB_ENDPOINT).
 */
/**
 * What someone with raw storage access but no platform role could do: change or remove bytes
 * behind the platform's back, or leave stray objects. Tests use it to prove detection.
 */
export type OutOfBandAccess = {
  overwrite(name: string, bytes: Uint8Array | string): void;
  remove(name: string): void;
  exists(name: string): boolean;
};

export function createMemoryBlobContainer(options: { container?: string; immutability?: Immutability; account?: string; now?: () => Date } = {}): BlobContainer & { outOfBand: OutOfBandAccess } {
  const objects = new Map<string, Stored>();
  const container = options.container ?? "memory";
  const account = options.account ?? "memory";
  const immutability = options.immutability ?? "none";
  const now = options.now ?? (() => new Date());
  let version = 0;
  const key = (name: string) => {
    if (!name || name.length > 1024 || name.startsWith("/") || name.includes("..")) throw new BlobStoreError("blob.name_invalid", 400);
    return name;
  };
  const head = async (name: string): Promise<BlobHead> => {
    const stored = objects.get(key(name));
    if (!stored) return { exists: false };
    return { exists: true, length: stored.bytes.length, sha256: stored.sha256, versionId: String(stored.version),
      retainUntil: stored.retainUntil, retentionMode: stored.retentionMode, legalHold: stored.legalHold };
  };
  return {
    outOfBand: {
      overwrite(name, bytes) {
        // A raw write replaces the object, metadata included: the platform's recorded digest is
        // gone, exactly as with a plain PUT to the object store.
        objects.set(name, { bytes: Buffer.from(bytes), sha256: null, contentType: "application/octet-stream",
          retainUntil: null, retentionMode: null, legalHold: false, version: ++version });
      },
      remove(name) { objects.delete(name); },
      exists(name) { return objects.has(name); },
    },
    account,
    container,
    immutability,
    async ensure() {},
    async putImmutable(name, bytes, put) {
      if (sha256Hex(bytes) !== put.sha256) throw new BlobStoreError("blob.digest_mismatch", 400);
      const existing = objects.get(key(name));
      if (existing) {
        if (existing.sha256 !== put.sha256 || existing.bytes.length !== bytes.length) throw new BlobStoreError("blob.content_conflict", 409);
        return { account, container, name, versionId: String(existing.version), length: bytes.length, sha256: put.sha256 };
      }
      version += 1;
      objects.set(name, { bytes: Buffer.from(bytes), sha256: put.sha256, contentType: put.contentType, version, retainUntil: null, retentionMode: null, legalHold: false });
      return { account, container, name, versionId: String(version), length: bytes.length, sha256: put.sha256 };
    },
    async get(name) {
      const stored = objects.get(key(name));
      if (!stored) throw new BlobStoreError("blob.not_found", 404);
      return Buffer.from(stored.bytes);
    },
    head,
    async setRetention(name, until, locked) {
      if (immutability !== "object_lock") return { applied: false, state: "NOT_ENFORCED" };
      const stored = objects.get(key(name));
      if (!stored) throw new BlobStoreError("blob.not_found", 404);
      const decision = retentionDecision(stored, until, locked);
      if (!decision.change) return { applied: true, state: "UNCHANGED" };
      stored.retainUntil = decision.until;
      stored.retentionMode = decision.mode.toLowerCase();
      return { applied: true, state: decision.mode === "Locked" ? "LOCKED" : "APPLIED" };
    },
    async setLegalHold(name, hold) {
      if (immutability !== "object_lock") return { applied: false, state: "NOT_ENFORCED" };
      const stored = objects.get(key(name));
      if (!stored) throw new BlobStoreError("blob.not_found", 404);
      stored.legalHold = hold;
      return { applied: true, state: "APPLIED" };
    },
    async delete(name) {
      const stored = objects.get(key(name));
      if (!stored) return false;
      if (immutability === "object_lock" && (stored.legalHold || (stored.retainUntil && stored.retainUntil > now()))) {
        throw new BlobStoreError("blob.delete_refused_retained", 409);
      }
      objects.delete(name);
      return true;
    },
    async *list(prefix) {
      for (const [name, stored] of [...objects.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        if (!name.startsWith(prefix)) continue;
        yield {
          name, length: stored.bytes.length, sha256: stored.sha256,
          ...(immutability === "object_lock" ? { retainUntil: stored.retainUntil, retentionMode: stored.retentionMode, legalHold: stored.legalHold } : {}),
        };
      }
    },
  };
}
