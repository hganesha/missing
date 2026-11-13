import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlobStoreError, blobContainerFromEnv, createS3BlobContainer, retentionDecision, sha256Hex, type BlobContainer } from "./index.js";
import { createAzureBlobContainer, parseBlobListing, qualifyProtectedAzureContainer, sharedKeyAuthorization } from "./azure-blob.js";
import { qualifyProtectedBucket } from "./qualification.js";
import { createMemoryBlobContainer } from "./testing.js";

/** The behaviour every BlobContainer must have, whatever stores the bytes. */
function contract(label: string, make: () => Promise<BlobContainer | null>) {
  describe(`blob container: ${label}`, () => {
    let container: BlobContainer | null = null;
    beforeAll(async () => { container = await make(); await container?.ensure(); }, 60_000);
    const it_ = (name: string, body: (container: BlobContainer) => Promise<void>) =>
      it(name, async (context) => { if (!container) return context.skip(); await body(container); });

    it_("writes content-addressed bytes once, replays the same bytes and refuses different ones", async (container) => {
      const bytes = randomBytes(64);
      const digest = sha256Hex(bytes);
      const name = `tenants/t1/sha256/${digest}`;
      const first = await container.putImmutable(name, bytes, { contentType: "application/octet-stream", sha256: digest });
      expect(first).toMatchObject({ name, length: 64, sha256: digest });
      await expect(container.putImmutable(name, bytes, { contentType: "application/octet-stream", sha256: digest })).resolves.toMatchObject({ name, sha256: digest });
      const other = randomBytes(64);
      await expect(container.putImmutable(name, other, { contentType: "application/octet-stream", sha256: sha256Hex(other) })).rejects.toThrow("blob.content_conflict");
      await expect(container.putImmutable(`${name}-x`, other, { contentType: "application/octet-stream", sha256: digest })).rejects.toThrow("blob.digest_mismatch");
      expect((await container.get(name)).equals(bytes)).toBe(true);
      expect(await container.head(name)).toMatchObject({ exists: true, length: 64, sha256: digest });
      expect(await container.head(`${name}-missing`)).toEqual({ exists: false });
      await expect(container.get(`${name}-missing`)).rejects.toThrow("blob.not_found");
    });

    it_("lists a prefix and deletes", async (container) => {
      const bytes = randomBytes(16);
      const digest = sha256Hex(bytes);
      const prefix = `tenants/list-${randomUUID()}/`;
      await container.putImmutable(`${prefix}${digest}`, bytes, { contentType: "text/plain", sha256: digest });
      const listed: string[] = [];
      for await (const item of container.list(prefix)) listed.push(`${item.name}:${item.sha256}:${item.length}`);
      expect(listed).toEqual([`${prefix}${digest}:${digest}:16`]);
      expect(await container.delete(`${prefix}${digest}`)).toBe(true);
      expect(await container.delete(`${prefix}${digest}`)).toBe(false);
    });

    it_("reports that retention and holds were not enforced on a container without object lock", async (container) => {
      if (container.immutability !== "none") return;
      const bytes = randomBytes(8);
      const digest = sha256Hex(bytes);
      await container.putImmutable(`tenants/t1/${digest}`, bytes, { contentType: "text/plain", sha256: digest });
      expect(await container.setRetention(`tenants/t1/${digest}`, new Date(Date.now() + 86_400_000), false)).toEqual({ applied: false, state: "NOT_ENFORCED" });
      expect(await container.setLegalHold(`tenants/t1/${digest}`, true)).toEqual({ applied: false, state: "NOT_ENFORCED" });
    });
  });
}

contract("in memory", async () => createMemoryBlobContainer({ container: "evidence-test" }));
// A real S3-compatible server (RustFS in CI): EHF_TEST_S3_ENDPOINT, with its access key pair.
contract("S3-compatible server", async () => process.env.EHF_TEST_S3_ENDPOINT ? createS3BlobContainer({
  container: `evidence-test-${randomBytes(4).toString("hex")}`, immutability: "none", endpoint: process.env.EHF_TEST_S3_ENDPOINT,
  credentials: { accessKeyId: process.env.EHF_TEST_S3_ACCESS_KEY_ID ?? "", secretAccessKey: process.env.EHF_TEST_S3_SECRET_ACCESS_KEY ?? "" },
}) : null);
// The Azure Blob API (Azurite in development): EHF_TEST_AZURE_BLOB_ENDPOINT, including the
// account path for the emulator, with EHF_TEST_AZURE_BLOB_ACCOUNT and its shared key.
contract("Azure Blob service", async () => process.env.EHF_TEST_AZURE_BLOB_ENDPOINT ? createAzureBlobContainer({
  container: `evidence-test-${randomBytes(4).toString("hex")}`, immutability: "none", endpoint: process.env.EHF_TEST_AZURE_BLOB_ENDPOINT,
  account: process.env.EHF_TEST_AZURE_BLOB_ACCOUNT ?? "devstoreaccount1",
  credentials: { accountKey: process.env.EHF_TEST_AZURE_BLOB_ACCOUNT_KEY ?? "" },
}) : null);

describe("object lock semantics", () => {
  it("never shortens retention, keeps a lock and refuses deletes while retained or held", async () => {
    let clock = new Date(Date.UTC(2030, 0, 1));
    const container = createMemoryBlobContainer({ immutability: "object_lock", now: () => clock });
    const bytes = randomBytes(8);
    const digest = sha256Hex(bytes);
    const name = `tenants/t1/${digest}`;
    await container.putImmutable(name, bytes, { contentType: "text/plain", sha256: digest });
    const until = new Date(Date.UTC(2031, 0, 1));
    expect(await container.setRetention(name, until, false)).toEqual({ applied: true, state: "APPLIED" });
    expect(await container.setRetention(name, new Date(Date.UTC(2030, 6, 1)), false)).toEqual({ applied: true, state: "UNCHANGED" });
    expect(await container.setRetention(name, until, true)).toEqual({ applied: true, state: "LOCKED" });
    await expect(container.delete(name)).rejects.toThrow("blob.delete_refused_retained");
    clock = new Date(Date.UTC(2032, 0, 1));
    await container.setLegalHold(name, true);
    await expect(container.delete(name)).rejects.toThrow("blob.delete_refused_retained");
    await container.setLegalHold(name, false);
    expect(await container.delete(name)).toBe(true);
  });
});

describe("S3 command mapping", () => {
  function recording(responses: Record<string, unknown> = {}) {
    const sent: Array<{ name: string; input: Record<string, unknown> }> = [];
    const client = {
      send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
        const name = command.constructor.name;
        sent.push({ name, input: command.input });
        const response = responses[name];
        if (response instanceof Error) throw response;
        return response ?? {};
      },
    };
    return { sent, client: client as never };
  }
  const httpError = (status: number, name = "Error") => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

  it("writes with If-None-Match and the digest as metadata, and maps lock state back", async () => {
    const bytes = randomBytes(4);
    const digest = sha256Hex(bytes);
    const { sent, client } = recording({
      PutObjectCommand: { VersionId: "v1" },
      HeadObjectCommand: { ContentLength: 4, Metadata: { sha256: digest }, ObjectLockMode: "COMPLIANCE", ObjectLockRetainUntilDate: new Date(Date.UTC(2031, 0, 1)), ObjectLockLegalHoldStatus: "ON" },
    });
    const container = createS3BlobContainer({ container: "evidence", immutability: "object_lock", endpoint: "http://minio:9000", client });
    expect(await container.putImmutable("a/b", bytes, { contentType: "text/plain", sha256: digest })).toMatchObject({ versionId: "v1", account: "minio:9000" });
    expect(sent[0]).toMatchObject({ name: "PutObjectCommand", input: { Bucket: "evidence", Key: "a/b", IfNoneMatch: "*", Metadata: { sha256: digest } } });
    expect(await container.head("a/b")).toMatchObject({ exists: true, sha256: digest, retentionMode: "locked", legalHold: true });
  });

  it("treats a precondition failure as replay or conflict by digest", async () => {
    const bytes = randomBytes(4);
    const digest = sha256Hex(bytes);
    const { client } = recording({ PutObjectCommand: httpError(412, "PreconditionFailed"), HeadObjectCommand: { ContentLength: 4, Metadata: { sha256: "0".repeat(64) } } });
    const container = createS3BlobContainer({ container: "evidence", immutability: "none", client });
    await expect(container.putImmutable("a/b", bytes, { contentType: "text/plain", sha256: digest })).rejects.toThrow("blob.content_conflict");
  });

  it("maps locked retention to COMPLIANCE, raising GOVERNANCE with the bypass, and holds to legal hold", async () => {
    const until = new Date(Date.UTC(2031, 0, 1));
    const { sent, client } = recording({ HeadObjectCommand: { ContentLength: 1, Metadata: {}, ObjectLockMode: "GOVERNANCE", ObjectLockRetainUntilDate: until } });
    const container = createS3BlobContainer({ container: "evidence", immutability: "object_lock", client });
    expect(await container.setRetention("a", until, true)).toEqual({ applied: true, state: "LOCKED" });
    expect(sent.find((item) => item.name === "PutObjectRetentionCommand")?.input).toMatchObject({ Retention: { Mode: "COMPLIANCE", RetainUntilDate: until }, BypassGovernanceRetention: true });
    await container.setLegalHold("a", true);
    expect(sent.find((item) => item.name === "PutObjectLegalHoldCommand")?.input).toMatchObject({ LegalHold: { Status: "ON" } });
  });

  it("reads a missing object as absent", async () => {
    const { client } = recording({ HeadObjectCommand: httpError(404, "NotFound"), GetObjectCommand: httpError(404, "NoSuchKey") });
    const container = createS3BlobContainer({ container: "evidence", immutability: "none", client });
    expect(await container.head("a")).toEqual({ exists: false });
    await expect(container.get("a")).rejects.toThrow("blob.not_found");
    expect(await container.delete("a")).toBe(false);
  });
});

describe("Azure Blob request mapping", () => {
  type Sent = { method: string; url: URL; headers: Record<string, string>; body: Uint8Array | undefined };
  function recording(respond: (request: Sent) => Response | undefined) {
    const sent: Sent[] = [];
    const fetcher = (async (url: URL, init: { method: string; headers: Record<string, string>; body?: Uint8Array }) => {
      const request = { method: init.method, url: new URL(url), headers: init.headers, body: init.body };
      sent.push(request);
      return respond(request) ?? new Response(null, { status: 201 });
    }) as unknown as typeof fetch;
    return { sent, fetcher };
  }
  const key = Buffer.from("test-account-key").toString("base64");
  const azure = (fetcher: typeof fetch, immutability: "object_lock" | "none" = "object_lock") => createAzureBlobContainer({
    container: "evidence", immutability, endpoint: "https://ehfevidence.blob.core.windows.net", credentials: { accountKey: key }, fetch: fetcher });
  const error = (status: number, code: string) => new Response("<Error/>", { status, headers: { "x-ms-error-code": code } });

  it("signs the canonical request with the account key", () => {
    // The string to sign, written out: verb, eleven standard headers (a zero length is empty),
    // the x-ms headers in order, then the account-qualified path and the sorted query.
    const url = new URL("https://ehfevidence.blob.core.windows.net/evidence/a%20b?comp=legalhold");
    const headers = { "x-ms-version": "2023-11-03", "x-ms-date": "Wed, 01 Jan 2031 00:00:00 GMT", "x-ms-legal-hold": "true", "content-length": "0", "if-none-match": "*" };
    const stringToSign = ["PUT", "", "", "", "", "", "", "", "", "*", "", "",
      "x-ms-date:Wed, 01 Jan 2031 00:00:00 GMT", "x-ms-legal-hold:true", "x-ms-version:2023-11-03", "/ehfevidence/evidence/a%20b", "comp:legalhold"].join("\n");
    const expected = createHmac("sha256", Buffer.from(key, "base64")).update(stringToSign).digest("base64");
    expect(sharedKeyAuthorization("put", url, headers, "ehfevidence", key)).toBe(`SharedKey ehfevidence:${expected}`);
  });

  it("writes a block blob once with the digest as metadata, and maps lock state back", async () => {
    const bytes = randomBytes(4);
    const digest = sha256Hex(bytes);
    const { sent, fetcher } = recording((request) => request.method === "HEAD" ? new Response(null, { status: 200, headers: {
      "content-length": "4", "x-ms-meta-sha256": digest, "x-ms-version-id": "v1", "x-ms-legal-hold": "true",
      "x-ms-immutability-policy-until-date": "Wed, 01 Jan 2031 00:00:00 GMT", "x-ms-immutability-policy-mode": "Locked" } })
      : new Response(null, { status: 201, headers: { "x-ms-version-id": "v1" } }));
    const container = azure(fetcher);
    expect(await container.putImmutable("tenants/t 1/x", bytes, { contentType: "text/plain", sha256: digest })).toMatchObject({ versionId: "v1", account: "ehfevidence", container: "evidence" });
    expect(sent[0]!.url.href).toBe("https://ehfevidence.blob.core.windows.net/evidence/tenants/t%201/x");
    expect(sent[0]).toMatchObject({ method: "PUT", headers: { "x-ms-blob-type": "BlockBlob", "if-none-match": "*", "x-ms-meta-sha256": digest, "x-ms-blob-content-type": "text/plain" } });
    expect(sent[0]!.headers.authorization).toMatch(/^SharedKey ehfevidence:/);
    expect(await container.head("tenants/t 1/x")).toEqual({ exists: true, length: 4, sha256: digest, versionId: "v1",
      retainUntil: new Date(Date.UTC(2031, 0, 1)), retentionMode: "locked", legalHold: true });
  });

  it("treats an existing blob as replay or conflict by digest", async () => {
    const bytes = randomBytes(4);
    const digest = sha256Hex(bytes);
    const existing = (sha256: string) => recording((request) => request.method === "PUT" ? error(409, "BlobAlreadyExists")
      : new Response(null, { status: 200, headers: { "content-length": "4", "x-ms-meta-sha256": sha256 } })).fetcher;
    await expect(azure(existing(digest)).putImmutable("a", bytes, { contentType: "text/plain", sha256: digest })).resolves.toMatchObject({ sha256: digest });
    await expect(azure(existing("0".repeat(64))).putImmutable("a", bytes, { contentType: "text/plain", sha256: digest })).rejects.toThrow("blob.content_conflict");
  });

  it("sets retention as an immutability policy in whole seconds, and holds as legal hold", async () => {
    const { sent, fetcher } = recording((request) => request.method === "HEAD" ? new Response(null, { status: 200, headers: {
      "content-length": "1", "x-ms-immutability-policy-until-date": "Wed, 01 Jan 2031 00:00:00 GMT", "x-ms-immutability-policy-mode": "Unlocked" } }) : undefined);
    const container = azure(fetcher);
    expect(await container.setRetention("a", new Date(Date.UTC(2031, 0, 1)), false)).toEqual({ applied: true, state: "UNCHANGED" });
    expect(await container.setRetention("a", new Date(Date.UTC(2030, 0, 1)), true)).toEqual({ applied: true, state: "LOCKED" });
    expect(await container.setRetention("a", new Date(Date.UTC(2031, 0, 1, 0, 0, 0, 1)), false)).toEqual({ applied: true, state: "APPLIED" });
    const policies = sent.filter((request) => request.url.searchParams.get("comp") === "immutabilityPolicies");
    expect(policies.map((request) => [request.method, request.headers["x-ms-immutability-policy-until-date"], request.headers["x-ms-immutability-policy-mode"]])).toEqual([
      ["PUT", "Wed, 01 Jan 2031 00:00:00 GMT", "Locked"], ["PUT", "Wed, 01 Jan 2031 00:00:01 GMT", "Unlocked"]]);
    await container.setLegalHold("a", true);
    expect(sent.at(-1)).toMatchObject({ method: "PUT", headers: { "x-ms-legal-hold": "true" } });
    expect(sent.at(-1)!.url.search).toBe("?comp=legalhold");
    expect(await azure(fetcher, "none").setRetention("a", new Date(), true)).toEqual({ applied: false, state: "NOT_ENFORCED" });
  });

  it("reads a missing blob as absent, refuses deleting a retained one and reports other failures by code", async () => {
    const missing = azure(recording(() => error(404, "BlobNotFound")).fetcher);
    expect(await missing.head("a")).toEqual({ exists: false });
    await expect(missing.get("a")).rejects.toThrow("blob.not_found");
    expect(await missing.delete("a")).toBe(false);
    await expect(azure(recording(() => error(409, "BlobImmutableDueToPolicy")).fetcher).delete("a")).rejects.toThrow("blob.delete_refused_retained");
    await expect(azure(recording(() => error(403, "AuthorizationFailure")).fetcher).get("a")).rejects.toThrow("blob.azure_request_failed:403:AuthorizationFailure");
  });

  it("follows listing markers and decodes names", async () => {
    expect(parseBlobListing("<EnumerationResults><Blobs><Blob><Name>a&amp;b</Name><Properties/></Blob></Blobs><NextMarker>m1</NextMarker></EnumerationResults>")).toEqual({ names: ["a&b"], nextMarker: "m1" });
    const { sent, fetcher } = recording((request) => request.method === "HEAD" ? new Response(null, { status: 200, headers: { "content-length": "2", "x-ms-meta-sha256": "d" } })
      : new Response(request.url.searchParams.get("marker") ? "<Blobs><Blob><Name>p/2</Name></Blob></Blobs><NextMarker />" : "<Blobs><Blob><Name>p/1</Name></Blob></Blobs><NextMarker>m1</NextMarker>"));
    const names: string[] = [];
    for await (const item of azure(fetcher, "none").list("p/")) names.push(`${item.name}:${item.sha256}:${item.length}`);
    expect(names).toEqual(["p/1:d:2", "p/2:d:2"]);
    expect(sent[0]!.url.search).toBe("?restype=container&comp=list&prefix=p%2F");
  });

  it("sends an OAuth client-credentials token as a bearer", async () => {
    const { sent, fetcher } = recording((request) => request.url.host === "login.example.test"
      ? Response.json({ access_token: "token-1", token_type: "Bearer", expires_in: 3600 }) : new Response("bytes"));
    const container = createAzureBlobContainer({ container: "evidence", immutability: "none", endpoint: "https://ehfevidence.blob.core.windows.net",
      credentials: { tokenUrl: "https://login.example.test/tenant/oauth2/v2.0/token", clientId: "client", clientSecret: "secret" }, fetch: fetcher });
    expect((await container.get("a")).toString()).toBe("bytes");
    expect(sent.at(-1)!.headers.authorization).toBe("Bearer token-1");
    expect(String(sent[0]!.body)).toContain("scope=https%3A%2F%2Fstorage.azure.com%2F.default");
  });

  it("qualifies only a container with version-level immutability, without writing", async () => {
    const input = { provider: "azure_blob" as const, endpoint: "https://ehfevidence.blob.core.windows.net", bucket: "evidence", accountKey: key };
    const enabled = recording(() => new Response(null, { status: 200, headers: { "x-ms-immutable-storage-with-versioning-enabled": "true" } }));
    await expect(qualifyProtectedAzureContainer({ ...input, fetch: enabled.fetcher })).resolves.toBeUndefined();
    expect(enabled.sent.map((request) => `${request.method} ${request.url.pathname}${request.url.search}`)).toEqual(["HEAD /evidence?restype=container"]);
    await expect(qualifyProtectedAzureContainer({ ...input, fetch: recording(() => new Response(null, { status: 200 })).fetcher })).rejects.toThrow("blob.versioned_object_lock_required");
    await expect(qualifyProtectedAzureContainer({ ...input, fetch: recording(() => error(404, "ContainerNotFound")).fetcher })).rejects.toThrow("blob.qualification_failed:404");
    await expect(qualifyProtectedBucket({ ...input, endpoint: "http://ehfevidence.blob.core.windows.net" })).rejects.toThrow("blob.qualification_input_invalid");
  });
});

describe("retention decisions", () => {
  const day = 86_400_000;
  const until = new Date(Date.UTC(2033, 0, 1));
  it("sets a first retention, extends a shorter one and never shortens a longer one", () => {
    expect(retentionDecision({ retainUntil: null, retentionMode: null }, until, false)).toEqual({ change: true, until, mode: "Unlocked" });
    expect(retentionDecision({ retainUntil: new Date(until.getTime() - day), retentionMode: "unlocked" }, until, false)).toMatchObject({ change: true, until });
    const later = new Date(until.getTime() + day);
    expect(retentionDecision({ retainUntil: later, retentionMode: "unlocked" }, until, false)).toEqual({ change: false, until: later, mode: "Unlocked" });
  });
  it("locks on request and stays locked", () => {
    expect(retentionDecision({ retainUntil: until, retentionMode: "unlocked" }, until, true)).toEqual({ change: true, until, mode: "Locked" });
    expect(retentionDecision({ retainUntil: until, retentionMode: "locked" }, until, false)).toEqual({ change: false, until, mode: "Locked" });
  });
});

describe("configuration", () => {
  it("requires object lock, https and no inline secret in production", () => {
    const production = { SECURITY_PROFILE: "production", EVIDENCE_BLOB_BUCKET: "evidence", EVIDENCE_BLOB_ENDPOINT: "https://objects.example.test" };
    expect(() => blobContainerFromEnv("EVIDENCE", { ...production, EVIDENCE_BLOB_IMMUTABILITY: "none" })).toThrow("blob.immutability_required_in_production:EVIDENCE");
    expect(() => blobContainerFromEnv("EVIDENCE", { ...production, EVIDENCE_BLOB_ENDPOINT: "http://objects.example.test" })).toThrow("blob.endpoint_invalid");
    expect(() => blobContainerFromEnv("EVIDENCE", { ...production, EVIDENCE_BLOB_ACCESS_KEY_ID: "k", EVIDENCE_BLOB_SECRET_ACCESS_KEY: "s" }))
      .toThrow("blob.inline_secret_forbidden_in_production:EVIDENCE_BLOB_SECRET_ACCESS_KEY");
    expect(blobContainerFromEnv("EVIDENCE", production)?.immutability).toBe("object_lock");
    expect(() => blobContainerFromEnv("EVIDENCE", { EVIDENCE_BLOB_BUCKET: "evidence", EVIDENCE_BLOB_ACCESS_KEY_ID: "k" })).toThrow(BlobStoreError);
    expect(() => blobContainerFromEnv("EVIDENCE", { EVIDENCE_BLOB_BUCKET: "evidence", EVIDENCE_BLOB_IMMUTABILITY: "version_level" })).toThrow("blob.immutability_invalid:EVIDENCE");
    expect(blobContainerFromEnv("EVIDENCE", {})).toBeNull();
  });

  it("selects the Azure Blob provider with exactly one credential", () => {
    const azure = { EVIDENCE_BLOB_PROVIDER: "azure_blob", EVIDENCE_BLOB_BUCKET: "evidence", EVIDENCE_BLOB_ENDPOINT: "https://ehfevidence.blob.core.windows.net" };
    expect(blobContainerFromEnv("EVIDENCE", { ...azure, EVIDENCE_BLOB_ACCOUNT_KEY: "a2V5" })).toMatchObject({ account: "ehfevidence", container: "evidence", immutability: "none" });
    expect(blobContainerFromEnv("EVIDENCE", { ...azure, EVIDENCE_BLOB_ACCOUNT: "other", EVIDENCE_BLOB_OAUTH_TOKEN_URL: "https://login.example.test/token",
      EVIDENCE_BLOB_OAUTH_CLIENT_ID: "client", EVIDENCE_BLOB_OAUTH_CLIENT_SECRET: "secret" })?.account).toBe("other");
    expect(() => blobContainerFromEnv("EVIDENCE", azure)).toThrow("blob.credentials_incomplete:EVIDENCE");
    expect(() => blobContainerFromEnv("EVIDENCE", { ...azure, EVIDENCE_BLOB_ACCOUNT_KEY: "a2V5", EVIDENCE_BLOB_OAUTH_TOKEN_URL: "https://login.example.test/token",
      EVIDENCE_BLOB_OAUTH_CLIENT_ID: "client", EVIDENCE_BLOB_OAUTH_CLIENT_SECRET: "secret" })).toThrow("blob.credentials_incomplete:EVIDENCE");
    expect(() => blobContainerFromEnv("EVIDENCE", { ...azure, EVIDENCE_BLOB_OAUTH_CLIENT_ID: "client" })).toThrow("blob.credentials_incomplete:EVIDENCE");
    expect(() => blobContainerFromEnv("EVIDENCE", { ...azure, EVIDENCE_BLOB_ENDPOINT: "" , EVIDENCE_BLOB_ACCOUNT_KEY: "a2V5" })).toThrow("blob.endpoint_required:EVIDENCE");
    expect(() => blobContainerFromEnv("EVIDENCE", { ...azure, SECURITY_PROFILE: "production", EVIDENCE_BLOB_ACCOUNT_KEY: "a2V5" }))
      .toThrow("blob.inline_secret_forbidden_in_production:EVIDENCE_BLOB_ACCOUNT_KEY");
    expect(() => blobContainerFromEnv("EVIDENCE", { EVIDENCE_BLOB_BUCKET: "evidence", EVIDENCE_BLOB_PROVIDER: "gcs" })).toThrow("blob.provider_invalid:EVIDENCE");
  });
});
