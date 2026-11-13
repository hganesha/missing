import { describe, expect, it } from "vitest";
import { PLATFORM_SETTING_DEFAULTS, type RuntimeInvocationV2 } from "@ehf/contracts";
import {
  createDatabricksTokenProvider,
  createRuntimeProvider,
  DatabricksRuntimeProvider,
  isHostedRuntimeTarget,
  listRuntimeAdapters,
  parseRuntimeTarget,
  registerRuntimeAdapter,
} from "./index.js";

const settings = {
  ...PLATFORM_SETTING_DEFAULTS.runtime,
  bindings: {
    "kyc-investigator": {
      adapter: "databricks", endpoint: "https://kyc-runtime-1234.aws.databricksapps.com/invocations",
      auth: "databricks_oauth_m2m" as const, workspaceHost: "https://dbc-1234.cloud.databricks.com",
      clientIdEnv: "DATABRICKS_KYC_CLIENT_ID", clientSecretEnv: "DATABRICKS_KYC_CLIENT_SECRET",
    },
    "local-gpu": { adapter: "local_http", endpoint: "http://gpu-host:8088/invocations", auth: "platform_token" as const },
  },
};
const env = { RUNTIME_HOST_AUTH_TOKEN: "host-token", DATABRICKS_KYC_CLIENT_ID: "sp-id", DATABRICKS_KYC_CLIENT_SECRET: "sp-secret" };

describe("runtime adapter registry", () => {
  it("ships local, hosted HTTP and Databricks adapters and knows which are hosted", () => {
    expect(listRuntimeAdapters().map((adapter) => adapter.id)).toEqual(expect.arrayContaining(["local_http", "hosted_http", "databricks"]));
    expect(listRuntimeAdapters().map((adapter) => adapter.id)).not.toContain("azure_foundry");
    expect(isHostedRuntimeTarget("databricks:kyc-investigator")).toBe(true);
    expect(isHostedRuntimeTarget("hosted_http")).toBe(true);
    expect(isHostedRuntimeTarget("local_http")).toBe(false);
    expect(parseRuntimeTarget("databricks:kyc-investigator")).toEqual({ adapter: "databricks", binding: "kyc-investigator" });
    expect(() => parseRuntimeTarget("Databricks")).toThrow("runtime.target_invalid");
  });

  it("resolves named bindings and refuses unknown or mismatched ones", () => {
    expect(createRuntimeProvider("databricks:kyc-investigator", { env, settings })).toBeInstanceOf(DatabricksRuntimeProvider);
    expect(createRuntimeProvider("local_http:local-gpu", { env, settings }).kind).toBe("local_http");
    expect(() => createRuntimeProvider("databricks:missing", { env, settings })).toThrow("runtime.binding_unknown:missing");
    // A binding cannot move a node to a different kind of runtime than the plan named.
    expect(() => createRuntimeProvider("hosted_http:kyc-investigator", { env, settings })).toThrow("runtime.binding_adapter_mismatch");
    expect(() => createRuntimeProvider("bedrock:agent", { env, settings })).toThrow("runtime.adapter_unknown:bedrock");
  });

  it("uses the administered default when the plan names no target", () => {
    expect(createRuntimeProvider(undefined, { env, settings: { ...settings, provider: "local_http:local-gpu" } }).kind).toBe("local_http");
  });

  it("accepts third-party adapters through the same registry", () => {
    registerRuntimeAdapter({
      id: "test_runtime", description: "test", hosted: true,
      fromBinding: () => { throw new Error("unused"); },
      fromEnvironment: () => ({ kind: "test_runtime", executionProfileDigest: "e".repeat(64), invoke: async () => { throw new Error("x"); }, getStatus: async () => { throw new Error("x"); }, cancel: async () => {} }),
    });
    expect(createRuntimeProvider("test_runtime", { env }).kind).toBe("test_runtime");
    expect(() => registerRuntimeAdapter({ id: "test_runtime", description: "dup", hosted: false, fromBinding: () => { throw new Error(); }, fromEnvironment: () => { throw new Error(); } }))
      .toThrow("runtime.adapter_duplicate");
  });
});

describe("Databricks runtime", () => {
  it("obtains an OAuth M2M token, caches it, and never leaks the secret", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let now = 0;
    const tokens = createDatabricksTokenProvider(
      { kind: "oauth_m2m", workspaceHost: "https://dbc-1234.cloud.databricks.com", clientId: "sp-id", clientSecret: "sp-secret" },
      { now: () => now, fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ access_token: `tok-${calls.length}`, expires_in: 3600 }), { status: 200 });
      }) as typeof fetch },
    );
    expect(await tokens()).toBe("tok-1");
    expect(await tokens()).toBe("tok-1");
    now = 3_590_000;
    expect(await tokens()).toBe("tok-2");
    expect(calls[0]!.url).toBe("https://dbc-1234.cloud.databricks.com/oidc/v1/token");
    expect(String(calls[0]!.init.body)).toBe("grant_type=client_credentials&scope=all-apis");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("sp-id:sp-secret").toString("base64")}`);
    const failing = createDatabricksTokenProvider(
      { kind: "oauth_m2m", workspaceHost: "https://dbc-1234.cloud.databricks.com", clientId: "sp-id", clientSecret: "sp-secret" },
      { fetchImpl: (async () => new Response("bad secret sp-secret", { status: 401 })) as unknown as typeof fetch },
    );
    await expect(failing()).rejects.toThrow(/^runtime\.databricks_token_http_401$/);
  });

  it("refuses endpoints outside Databricks-hosted domains", () => {
    expect(() => new DatabricksRuntimeProvider("https://evil.example.com/invocations", async () => "t")).toThrow("runtime.databricks_endpoint_invalid");
    expect(() => new DatabricksRuntimeProvider("http://kyc.databricksapps.com/invocations", async () => "t")).toThrow("runtime.databricks_endpoint_invalid");
  });

  it("speaks the runtime invocation protocol with a workspace token and a pinned execution profile", async () => {
    const seen: RequestInit[] = [];
    const provider = new DatabricksRuntimeProvider("https://kyc-runtime-1234.aws.databricksapps.com/invocations", async () => "workspace-token", {
      fetchImpl: (async (_url: string, init: RequestInit) => {
        seen.push(init);
        const body = JSON.parse(String(init.body)) as { invocationId: string; runId: string };
        return new Response(JSON.stringify({ contractVersion: "runtime.result.v1", invocationId: body.invocationId, runId: body.runId,
          status: "completed", output: { ok: true }, errorCode: null, checkpointId: null, providerMetadata: {} }), { status: 200 });
      }) as typeof fetch,
    });
    const request = { invocationId: "INV-1", runId: "RUN-1", executionProfileDigest: provider.executionProfileDigest } as unknown as RuntimeInvocationV2;
    await expect(provider.invoke({ ...request, executionProfileDigest: "f".repeat(64) }, AbortSignal.timeout(1_000))).rejects.toThrow("runtime.execution_profile_mismatch");
    expect(provider.executionProfileDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(seen).toHaveLength(0);
  });
});
