import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRuntimeProviderFromEnv, HostedHttpRuntimeProvider, LocalHttpRuntimeProvider, runtimeEnvOverlay } from "./index.js";

function tokenFile(): string {
  const file = join(mkdtempSync(join(tmpdir(), "ehf-runtime-")), "token");
  writeFileSync(file, "projected-dispatcher-token");
  return file;
}

describe("runtime provider configuration", () => {
  it("builds a stable local execution profile", () => {
    const provider = new LocalHttpRuntimeProvider("http://runtime/invocations", "local-token");
    expect(provider.kind).toBe("local_http");
    expect(provider.executionProfileDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("refuses removed cloud-specific providers", () => {
    expect(() => createRuntimeProviderFromEnv({ RUNTIME_PROVIDER: "azure_foundry" })).toThrow("runtime.provider_unsupported:azure_foundry");
  });

  it("presents the dispatcher's workload identity to an explicit hosted runtime in production", async () => {
    let authorization: string | null = null;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      authorization = new Headers(init.headers).get("authorization");
      return new Response("{}", { status: 404 });
    }) as typeof globalThis.fetch;
    const provider = createRuntimeProviderFromEnv({
      SECURITY_PROFILE: "production",
      WORKLOAD_AUTH: "workload_identity",
      WORKLOAD_TOKEN_FILE: tokenFile(),
      RUNTIME_PROVIDER: "local_http",
      RUNTIME_HOSTED_ENDPOINT: "https://runtime.internal/invocations",
    }, { fetchImpl });
    expect(provider.kind).toBe("local_http");
    await provider.getStatus("INV-1");
    expect(authorization).toBe("Bearer projected-dispatcher-token");
  });

  it("requires a hosted endpoint for the self-hosted runtime in production", () => {
    expect(() => createRuntimeProviderFromEnv({
      SECURITY_PROFILE: "production", WORKLOAD_AUTH: "workload_identity", WORKLOAD_TOKEN_FILE: tokenFile(), RUNTIME_PROVIDER: "local_http",
    })).toThrow("runtime.config_missing:RUNTIME_HOSTED_ENDPOINT");
  });

  it("builds the hosted runtime over verified TLS only", () => {
    const provider = createRuntimeProviderFromEnv({
      RUNTIME_PROVIDER: "hosted_http", RUNTIME_HOST_AUTH_TOKEN: "local-runtime-token", RUNTIME_HOSTED_ENDPOINT: "https://runtime.example.test/invocations",
    });
    expect(provider).toBeInstanceOf(HostedHttpRuntimeProvider);
    expect(provider.kind).toBe("hosted_http");
    expect(() => new HostedHttpRuntimeProvider("http://runtime.example.test/invocations", "t")).toThrow("runtime.hosted_endpoint_invalid");
    expect(() => createRuntimeProviderFromEnv({ RUNTIME_PROVIDER: "hosted_http", RUNTIME_HOST_AUTH_TOKEN: "t" }))
      .toThrow("runtime.config_missing:RUNTIME_HOSTED_ENDPOINT");
  });

  it("uses the static runtime token under WORKLOAD_AUTH=static_token", () => {
    expect(() => createRuntimeProviderFromEnv({ RUNTIME_PROVIDER: "local_http" })).toThrow("runtime.config_missing:RUNTIME_HOST_AUTH_TOKEN");
    expect(createRuntimeProviderFromEnv({ RUNTIME_PROVIDER: "local_http", RUNTIME_HOST_AUTH_TOKEN: "local-runtime-token" }).kind).toBe("local_http");
  });
});

describe("administered runtime binding", () => {
  const settings = {
    provider: "hosted_http" as const,
    localEndpoint: "http://runtime-host-local:8088/invocations",
    checkpointBackend: "postgres" as const,
  };

  it("carries the binding but never a credential", () => {
    const overlay = runtimeEnvOverlay(settings);
    expect(overlay.RUNTIME_PROVIDER).toBe("hosted_http");
    // Administering the binding must not become a way to hand anyone a way in: the host
    // token and the workload identity stay in the process environment.
    expect(Object.keys(overlay)).not.toContain("RUNTIME_HOST_AUTH_TOKEN");
    expect(Object.keys(overlay)).not.toContain("WORKLOAD_TOKEN_FILE");
  });

  it("lets the plan's own target win over the administered default", () => {
    // The plan is the authority over where its nodes run. The dispatcher applies the
    // node's target after the overlay, and this is the ordering that guarantees it.
    const provider = createRuntimeProviderFromEnv({
      RUNTIME_HOST_AUTH_TOKEN: "runtime-host-token-for-tests-0001",
      ...runtimeEnvOverlay(settings),
      RUNTIME_PROVIDER: "local_http",
    });
    expect(provider.kind).toBe("local_http");
  });
});
