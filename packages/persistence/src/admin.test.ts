import { describe, expect, it } from "vitest";
import { stableDigest } from "@ehf/contracts";
import {
  AdminConfigError,
  resolveModelProfile,
  resolvePlatformSettings,
  saveModelProfileRevision,
  upsertProvider,
} from "./admin.js";
import type { Database } from "./index.js";

type Reply = { rowCount?: number; rows: unknown[] };

/**
 * A database that answers by matching the SQL it is handed.
 *
 * Ordering-based fakes break whenever a function grows a lookup, which hides the
 * behaviour the test is actually about; matching on the statement keeps each case
 * describing one decision.
 */
function fakeDatabase(handlers: Array<[RegExp, (params: unknown[]) => Reply]>) {
  const statements: string[] = [];
  const query = async (text: unknown, params: unknown[] = []) => {
    const sql = String(text).replace(/\s+/g, " ").trim();
    statements.push(sql);
    for (const [pattern, reply] of handlers) {
      if (pattern.test(sql)) {
        const result = reply(params);
        return { rowCount: result.rowCount ?? result.rows.length, rows: result.rows };
      }
    }
    return { rowCount: 0, rows: [] };
  };
  const db = {
    query,
    connect: async () => ({ query, release: () => {} }),
  } as unknown as Database;
  return { db, statements };
}

const activeProfile = {
  id: "model.standard.v1", provider: "openrouter", model: "openai/gpt-5.6-terra",
  maxOutputTokens: 2400, timeoutMs: 45_000, maxConcurrency: 4,
};
const pinnedProfile = { ...activeProfile, model: "openai/gpt-5.6-terra-legacy" };

describe("model profile resolution", () => {
  it("resolves the revision a plan pinned rather than the current one", async () => {
    // The regression this guards: a plan records the digest of the profile it was
    // compiled against, and nothing used to check it. Editing a profile would then have
    // silently changed what an in-flight run invoked.
    const pinnedDigest = stableDigest(pinnedProfile);
    const { db } = fakeDatabase([
      [/definition_digest=\$3/, () => ({
        rows: [{ definition: pinnedProfile, definition_digest: pinnedDigest, revision: 1 }],
      })],
      [/status='active'/, () => ({
        rows: [{ definition: activeProfile, definition_digest: stableDigest(activeProfile), revision: 2 }],
      })],
    ]);
    const resolved = await resolveModelProfile(db, {
      tenantId: "tenant_demo", profileId: activeProfile.id, expectedDigest: pinnedDigest,
    });
    expect(resolved?.pinned).toBe(true);
    expect(resolved?.revision).toBe(1);
    expect(resolved?.profile.model).toBe("openai/gpt-5.6-terra-legacy");
  });

  it("falls back to the active revision when the pinned digest is unknown", async () => {
    // Plans compiled before the profiles were persisted carry a digest this store has
    // never seen. They still have to run.
    const { db } = fakeDatabase([
      [/definition_digest=\$3/, () => ({ rows: [] })],
      [/status='active'/, () => ({
        rows: [{ definition: activeProfile, definition_digest: stableDigest(activeProfile), revision: 2 }],
      })],
    ]);
    const resolved = await resolveModelProfile(db, {
      tenantId: "tenant_demo", profileId: activeProfile.id, expectedDigest: "f".repeat(64),
    });
    expect(resolved?.pinned).toBe(false);
    expect(resolved?.revision).toBe(2);
  });

  it("returns nothing when the profile is not administered at all", async () => {
    const { db } = fakeDatabase([]);
    await expect(resolveModelProfile(db, { tenantId: "tenant_demo", profileId: "model.absent.v1" }))
      .resolves.toBeNull();
  });
});

describe("model profile revisions", () => {
  const provider = {
    id: "openrouter", kind: "openrouter", displayName: "OpenRouter", baseUrl: null,
    credentialRef: "OPENROUTER_API_KEY", siteUrl: null, appName: null, status: "active",
  };

  it("refuses a profile bound to a provider that does not exist", async () => {
    const { db, statements } = fakeDatabase([
      [/from harness_admin.providers/, () => ({ rows: [] })],
    ]);
    await expect(saveModelProfileRevision(db, {
      tenantId: "tenant_demo", actor: { subjectId: "admin@test", roles: ["Platform.Admin"] },
      profile: activeProfile,
    })).rejects.toThrow("admin.provider_unknown:openrouter");
    // Rejected before anything is written, so a dangling binding is never persisted.
    expect(statements.some((sql) => sql.startsWith("insert"))).toBe(false);
  });

  it("refuses a profile bound to a disabled provider", async () => {
    const { db } = fakeDatabase([
      [/from harness_admin.providers/, () => ({ rows: [{ definition: { ...provider, status: "disabled" } }] })],
    ]);
    await expect(saveModelProfileRevision(db, {
      tenantId: "tenant_demo", actor: { subjectId: "admin@test", roles: ["Platform.Admin"] },
      profile: activeProfile,
    })).rejects.toBeInstanceOf(AdminConfigError);
  });

  it("supersedes the previous revision instead of rewriting it", async () => {
    const { db, statements } = fakeDatabase([
      [/from harness_admin.providers/, () => ({ rows: [{ definition: provider }] })],
      [/status='active' for update/, () => ({
        rows: [{ definition: pinnedProfile, definition_digest: stableDigest(pinnedProfile), revision: 1 }],
      })],
      [/max\(revision\)/, () => ({ rows: [{ next: 2 }] })],
      [/insert into harness_admin.model_profile_revisions/, () => ({ rows: [{ created_at: new Date() }] })],
    ]);
    const saved = await saveModelProfileRevision(db, {
      tenantId: "tenant_demo", actor: { subjectId: "admin@test", roles: ["Platform.Admin"] },
      profile: activeProfile,
    });
    expect(saved.revision).toBe(2);
    expect(saved.created).toBe(false);
    expect(statements.some((sql) => /update harness_admin.model_profile_revisions set status='superseded'/.test(sql))).toBe(true);
    expect(statements.some((sql) => sql.startsWith("insert into harness_admin.change_log"))).toBe(true);
  });

  it("does not mint a revision when the saved document is unchanged", async () => {
    // The digest is the identity of a revision. A revision per click would detach the
    // history from what actually changed, and pin plans to digests that mean nothing new.
    const { db, statements } = fakeDatabase([
      [/from harness_admin.providers/, () => ({ rows: [{ definition: provider }] })],
      [/status='active' for update/, () => ({
        rows: [{ definition: activeProfile, definition_digest: stableDigest(activeProfile), revision: 3 }],
      })],
    ]);
    const saved = await saveModelProfileRevision(db, {
      tenantId: "tenant_demo", actor: { subjectId: "admin@test", roles: ["Platform.Admin"] },
      profile: activeProfile,
    });
    expect(saved.revision).toBe(3);
    expect(statements.some((sql) => sql.startsWith("insert into harness_admin.model_profile_revisions"))).toBe(false);
  });
});

describe("provider bindings", () => {
  it("accepts only an environment variable name as the credential reference", async () => {
    const { db } = fakeDatabase([
      [/insert into harness_admin.providers/, () => ({ rows: [{ created_at: new Date(), updated_at: new Date() }] })],
    ]);
    // A pasted credential must not be storable: the control plane holds no provider
    // secret, and a field that accepts one would silently make it hold one.
    await expect(upsertProvider(db, {
      tenantId: "tenant_demo", actor: { subjectId: "admin@test", roles: ["Platform.Admin"] },
      provider: {
        id: "openrouter", kind: "openrouter", displayName: "OpenRouter", baseUrl: null,
        credentialRef: "sk-or-v1-abcdef0123456789", siteUrl: null, appName: null, status: "active",
      },
    })).rejects.toThrow();
  });

  it("stores a repointed endpoint without touching any plan", async () => {
    const { db, statements } = fakeDatabase([
      [/insert into harness_admin.providers/, () => ({ rows: [{ created_at: new Date(), updated_at: new Date() }] })],
    ]);
    const saved = await upsertProvider(db, {
      tenantId: "tenant_demo", actor: { subjectId: "admin@test", roles: ["Platform.Admin"] },
      provider: {
        id: "openrouter", kind: "openai_compatible", displayName: "Self-hosted gateway",
        baseUrl: "https://models.internal.test/v1", credentialRef: "INTERNAL_MODEL_KEY",
        siteUrl: null, appName: null, status: "active",
      },
      reason: "failover",
    });
    expect(saved.provider.baseUrl).toBe("https://models.internal.test/v1");
    expect(statements.some((sql) => /harness_control.plans|harness_admin.model_profile_revisions/.test(sql))).toBe(false);
  });
});

describe("platform settings resolution", () => {
  it("prefers a stored section over the environment and the built-in default", async () => {
    const { db } = fakeDatabase([
      [/from harness_admin.platform_settings/, () => ({
        rows: [{ section: "envelope", value: { ttlSeconds: 300 }, updated_at: new Date(), updated_by: "admin@test" }],
      })],
    ]);
    const sections = await resolvePlatformSettings(db, "tenant_demo", { EXECUTION_ENVELOPE_TTL_SECONDS: "90" });
    const envelope = sections.find((section) => section.section === "envelope");
    expect(envelope?.source).toBe("store");
    expect(envelope?.value).toEqual({ ttlSeconds: 300 });
  });

  it("falls back to the environment the process was started with", async () => {
    const { db } = fakeDatabase([]);
    const sections = await resolvePlatformSettings(db, "tenant_demo", { EXECUTION_ENVELOPE_TTL_SECONDS: "90" });
    const envelope = sections.find((section) => section.section === "envelope");
    expect(envelope?.source).toBe("environment");
    expect(envelope?.value).toEqual({ ttlSeconds: 90 });
  });

  it("reproduces today's literals when nothing is stored or configured", async () => {
    // An empty admin store must not change how a deployment behaves.
    const { db } = fakeDatabase([]);
    const sections = await resolvePlatformSettings(db, "tenant_demo", {});
    expect(sections.find((section) => section.section === "envelope")?.value).toEqual({ ttlSeconds: 60 });
    expect(sections.find((section) => section.section === "dispatcher")?.value).toEqual({
      pollIntervalMs: 750, leaseSeconds: 60, concurrency: 1, retryBaseMs: 2_000, retryMaxMs: 60_000,
    });
    expect(sections.find((section) => section.section === "database")?.value).toEqual({
      poolMax: 12, connectTimeoutMs: 5_000, idleTimeoutMs: 30_000,
    });
    expect(sections.find((section) => section.section === "runtime")?.value).toEqual({
      provider: "local_http",
      localEndpoint: "http://runtime-host-local:8088/invocations",
      checkpointBackend: "postgres",
      bindings: {},
    });
    expect(sections.every((section) => section.source === "default")).toBe(true);
  });

  it("reads named runtime bindings from RUNTIME_BINDINGS_JSON and ignores invalid JSON", async () => {
    const binding = { adapter: "databricks", endpoint: "https://kyc.aws.databricksapps.com/invocations", auth: "databricks_oauth_m2m",
      workspaceHost: "https://dbc-1.cloud.databricks.com", clientIdEnv: "DATABRICKS_KYC_CLIENT_ID", clientSecretEnv: "DATABRICKS_KYC_CLIENT_SECRET" };
    const { db } = fakeDatabase([]);
    const sections = await resolvePlatformSettings(db, "tenant_demo", { RUNTIME_PROVIDER: "databricks:kyc", RUNTIME_BINDINGS_JSON: JSON.stringify({ kyc: binding }) });
    const runtime = sections.find((section) => section.section === "runtime")?.value as { provider: string; bindings: Record<string, unknown> };
    expect(runtime.provider).toBe("databricks:kyc");
    expect(runtime.bindings).toEqual({ kyc: binding });
    const invalid = await resolvePlatformSettings(db, "tenant_demo", { RUNTIME_PROVIDER: "local_http", RUNTIME_BINDINGS_JSON: "{not json" });
    expect((invalid.find((section) => section.section === "runtime")?.value as { bindings: unknown }).bindings).toEqual({});
  });

  it("builds a section from the environment it was started with", async () => {
    // The environment fallback is driven by the field catalogue rather than a second
    // hand-written mapping, so a field added to the catalogue cannot quietly lose its override.
    const { db } = fakeDatabase([]);
    const sections = await resolvePlatformSettings(db, "tenant_demo", {
      RUNTIME_PROVIDER: "hosted_http",
      RUNTIME_LOCAL_ENDPOINT: "http://runtime-host-local:9999/invocations",
    });
    const runtime = sections.find((section) => section.section === "runtime");
    expect(runtime?.source).toBe("environment");
    expect(runtime?.value).toEqual({
      provider: "hosted_http",
      localEndpoint: "http://runtime-host-local:9999/invocations",
      checkpointBackend: "postgres",
      bindings: {},
    });
  });

  it("coerces a boolean override rather than treating any string as true", async () => {
    const { db } = fakeDatabase([]);
    const sections = await resolvePlatformSettings(db, "tenant_demo", { CASE_EVIDENCE_REQUIRE_SCAN: "false" });
    const evidence = sections.find((section) => section.section === "evidence");
    expect(evidence?.source).toBe("environment");
    expect(evidence?.value).toEqual({ maxBytes: 1_048_576, requireScan: false });
  });

  it("ignores an environment value the schema rejects rather than starting degraded", async () => {
    const { db } = fakeDatabase([]);
    const sections = await resolvePlatformSettings(db, "tenant_demo", { EXECUTION_ENVELOPE_TTL_SECONDS: "9999999" });
    const envelope = sections.find((section) => section.section === "envelope");
    expect(envelope?.source).toBe("default");
  });
});
