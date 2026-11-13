import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adlsEndpoint, createAdlsBlobContainer, parseAdlsCredential, qualifyAdlsEvidence, type AdlsClients, type AdlsPolicy } from "./adls.js";
import { blobContainerFromEnv, sha256Hex } from "./index.js";

const credential = { tenantId: "11111111-1111-1111-1111-111111111111", clientId: "22222222-2222-2222-2222-222222222222", clientSecret: "private-storage-client-secret", subscriptionId: "33333333-3333-3333-3333-333333333333", resourceGroup: "test" };
const base = { endpoint: "https://testaccount.dfs.core.windows.net", container: "evidence", credentials: credential };
function fixture() {
  let bytes: Buffer | undefined;
  let metadata: Record<string, string> = {};
  const createdOn = new Date("2026-01-01T00:00:00Z");
  const policy: AdlsPolicy = { state: "Locked", immutabilityPeriodSinceCreationInDays: 30 };
  const containerProperties = { hasImmutabilityPolicy: true, hasLegalHold: false };
  const accountProperties = { isHnsEnabled: true, isNfsV3Enabled: false, isSftpEnabled: false };
  const entries: Array<{ name: string; properties: { expiresOn?: Date }; metadata?: Record<string, string> }> = [];
  const missing = () => Object.assign(new Error("missing"), { statusCode: 404 });
  const blob = {
    upload: vi.fn(async (input: Uint8Array, _length: number, options: { conditions: { ifNoneMatch: string }; metadata: Record<string, string> }) => {
      expect(options.conditions.ifNoneMatch).toBe("*");
      if (bytes) throw Object.assign(new Error("exists"), { statusCode: 412 });
      bytes = Buffer.from(input); metadata = options.metadata;
      return {};
    }),
    getProperties: vi.fn(async () => { if (!bytes) throw missing(); return { contentLength: bytes.length, metadata, createdOn }; }),
    downloadToBuffer: vi.fn(async () => { if (!bytes) throw missing(); return Buffer.from(bytes); }),
    deleteIfExists: vi.fn(async () => { const existed = Boolean(bytes); bytes = undefined; return { succeeded: existed }; }),
  };
  const clients = {
    container: { getBlockBlobClient: vi.fn(() => blob), getProperties: vi.fn(async () => containerProperties), createIfNotExists: vi.fn(async () => ({})), async *listBlobsFlat() { yield* entries; } },
    account: vi.fn(async () => accountProperties), policy: vi.fn(async () => policy),
  };
  const config = { ...base, immutability: "container_policy" as const, clients: clients as unknown as AdlsClients };
  return { config, clients, blob, policy, entries, containerProperties, accountProperties, createdOn, overwrite: (value: Buffer) => { bytes = value; } };
}

describe("ADLS configuration and qualification", () => {
  it("normalizes dfs and blob endpoints without allowing credential-bearing or non-Azure URLs", () => {
    expect(adlsEndpoint(base.endpoint).blobEndpoint).toBe("https://testaccount.blob.core.windows.net");
    expect(adlsEndpoint("https://testaccount.blob.core.windows.net").accountName).toBe("testaccount");
    for (const endpoint of ["https://attacker.example", `${base.endpoint}/evidence`, `${base.endpoint}?sig=secret`, "http://testaccount.dfs.core.windows.net", "https://user:secret@testaccount.dfs.core.windows.net", "https://testaccount.dfs.core.windows.net:8443"]) expect(() => adlsEndpoint(endpoint)).toThrow("blob.adls_endpoint_invalid");
    expect(parseAdlsCredential(credential)).toEqual(credential);
    expect(() => parseAdlsCredential({ ...credential, accountKey: "unexpected" })).toThrow("blob.adls_credentials_invalid");
  });
  it("qualifies actual HNS, storage access and a locked container policy through read-only APIs", async () => {
    const f = fixture();
    expect(await qualifyAdlsEvidence(f.config)).toEqual({ retentionDays: 30, scope: "container" });
    expect(f.blob.upload).not.toHaveBeenCalled();
    expect(f.clients.container.createIfNotExists).not.toHaveBeenCalled();
  });
  it("rejects unlocked retention, append-write exemptions, non-HNS and file expiration", async () => {
    for (const change of [
      (f: ReturnType<typeof fixture>) => { f.policy.state = "Unlocked"; },
      (f: ReturnType<typeof fixture>) => { f.policy.allowProtectedAppendWritesAll = true; },
      (f: ReturnType<typeof fixture>) => { f.policy.immutabilityPeriodSinceCreationInDays = 0; },
      (f: ReturnType<typeof fixture>) => { f.containerProperties.hasImmutabilityPolicy = false; },
      (f: ReturnType<typeof fixture>) => { f.accountProperties.isHnsEnabled = false; },
      (f: ReturnType<typeof fixture>) => { f.accountProperties.isSftpEnabled = true; },
      (f: ReturnType<typeof fixture>) => { f.entries.push({ name: "expired-file", properties: { expiresOn: new Date() } }); },
    ]) { const f = fixture(); change(f); await expect(qualifyAdlsEvidence(f.config)).rejects.toThrow(/^blob\.adls_/); }
  });
  it("reads production credentials from a mounted file and refuses inline credentials", async () => {
    const directory = await mkdtemp(join(tmpdir(), "adls-env-"));
    try {
      const file = join(directory, "credential.json"); await writeFile(file, JSON.stringify(credential), { mode: 0o600 });
      const env = { SECURITY_PROFILE: "production", EVIDENCE_BLOB_PROVIDER: "adls_gen2", EVIDENCE_BLOB_ENDPOINT: base.endpoint, EVIDENCE_BLOB_BUCKET: "evidence", EVIDENCE_BLOB_AZURE_CREDENTIAL_FILE: file };
      expect(blobContainerFromEnv("EVIDENCE", env)?.immutability).toBe("container_policy");
      expect(() => blobContainerFromEnv("EVIDENCE", { ...env, EVIDENCE_BLOB_AZURE_CREDENTIAL: JSON.stringify(credential) })).toThrow("blob.inline_secret_forbidden_in_production");
      expect(() => blobContainerFromEnv("EVIDENCE", { ...env, EVIDENCE_BLOB_IMMUTABILITY: "none" })).toThrow("blob.adls_locked_container_policy_required");
      expect(() => blobContainerFromEnv("EVIDENCE", { ...env, EVIDENCE_BLOB_PROVIDER: "unknown" })).toThrow("blob.provider_invalid");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

describe("ADLS evidence semantics", () => {
  it("never overwrites, verifies idempotent retries and detects inconsistent existing content", async () => {
    const f = fixture(); const store = createAdlsBlobContainer(f.config);
    const bytes = Buffer.from("evidence"), sha256 = sha256Hex(bytes);
    const options = { contentType: "text/plain", sha256 };
    expect(await store.putImmutable("tenant/hash", bytes, options)).toMatchObject({ versionId: null, sha256, account: "testaccount.blob.core.windows.net" });
    await expect(store.putImmutable("tenant/hash", bytes, options)).resolves.toMatchObject({ sha256 });
    expect(await store.get("tenant/hash")).toEqual(bytes);
    f.overwrite(Buffer.from("tampered"));
    await expect(store.putImmutable("tenant/hash", bytes, options)).rejects.toThrow("blob.content_conflict");
    await expect(store.putImmutable("other", bytes, { ...options, sha256: "bad" })).rejects.toThrow("blob.digest_mismatch");
    await expect(store.get("../escape")).rejects.toThrow("blob.name_invalid");
  });
  it("reports only the retention already enforced by the container, without changing shared policies", async () => {
    const f = fixture(); const store = createAdlsBlobContainer(f.config);
    await store.putImmutable("a", Buffer.from("a"), { contentType: "text/plain", sha256: sha256Hex(Buffer.from("a")) });
    const until = new Date("2026-01-31T00:00:00Z");
    expect(await store.head("a")).toMatchObject({ retainUntil: until, retentionMode: "locked", legalHold: false });
    expect(await store.setRetention("a", until, true)).toEqual({ applied: true, state: "UNCHANGED" });
    expect(await store.setRetention("a", new Date("2033-01-01"), true)).toEqual({ applied: false, state: "NOT_ENFORCED" });
    f.policy.state = "Unlocked";
    await expect(store.head("a")).rejects.toThrow("blob.adls_locked_container_policy_required");
  });
  it("never lifts a shared legal hold in response to a single-file release", async () => {
    const f = fixture(); const store = createAdlsBlobContainer(f.config);
    await store.putImmutable("a", Buffer.from("a"), { contentType: "text/plain", sha256: sha256Hex(Buffer.from("a")) });
    expect(await store.setLegalHold("a", true)).toEqual({ applied: false, state: "NOT_ENFORCED" });
    f.containerProperties.hasLegalHold = true;
    expect(await store.setLegalHold("a", true)).toEqual({ applied: true, state: "UNCHANGED" });
    expect(await store.setLegalHold("a", false)).toEqual({ applied: false, state: "NOT_ENFORCED" });
    expect(f.containerProperties.hasLegalHold).toBe(true);
  });
  it("does not disguise a missing policy as a missing blob", async () => {
    const f = fixture(); const store = createAdlsBlobContainer(f.config);
    await store.putImmutable("a", Buffer.from("a"), { contentType: "text/plain", sha256: sha256Hex(Buffer.from("a")) });
    f.clients.policy.mockRejectedValue(Object.assign(new Error("policy missing"), { statusCode: 404 }));
    await expect(store.head("a")).rejects.toThrow("policy missing");
    f.blob.getProperties.mockRejectedValueOnce(Object.assign(new Error("blob missing"), { statusCode: 404 }));
    expect(await store.head("missing")).toEqual({ exists: false });
  });
});
