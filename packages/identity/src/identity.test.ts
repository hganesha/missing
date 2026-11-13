import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  actionsForRoles,
  AuthorizationError,
  allowsInsecureEndpoints,
  assertPlatformInvariants,
  createWorkloadResolverFromEnv,
  databaseAuth,
  envelopeSigner,
  envelopeVerifier,
  identityProvider,
  mechanism,
  PLATFORM_MODE_REPLACEMENTS,
  securityProfile,
  ServiceTokenPrincipalResolver,
  telemetryExporter,
  workloadAuth,
  connectionStringHasPassword,
  createAuthorizer,
  createPrincipalResolverFromEnv,
  createPrivateKeyJwtSigner,
  createPrivateKeyJwtSignerFromEnv,
  createWorkloadTokenProvider,
  DelegatedPrincipalResolver,
  evaluate,
  LocalHeaderPrincipalResolver,
  OidcJwtPrincipalResolver,
  resolveSecretRef,
  serviceGrants,
  WorkloadIdentityPrincipalResolver,
  PlatformConfigError,
  type Principal,
  type PrincipalResolver,
} from "./index.js";

const author: Principal = {
  subjectId: "author@example.test", tenantId: "tenant_demo", actorType: "human",
  roles: ["Harness.Author"], source: "local",
};
const approver: Principal = { ...author, subjectId: "approver@example.test", roles: ["Harness.Approver"] };

describe("authorization", () => {
  it("denies an unauthenticated caller with a 401-shaped reason", () => {
    const decision = evaluate(null, "plan.read", { kind: "plan" });
    expect(decision.outcome).toBe("denied");
    expect(new AuthorizationError(decision).httpStatus).toBe(401);
  });

  it("keeps authoring and approval as distinct grants", () => {
    // Separation of duties only means something if Harness.Author is not a superset of
    // Harness.Approver; the self-approval check alone would be cosmetic.
    expect(actionsForRoles(["Harness.Author"]).has("draft.approve")).toBe(false);
    expect(actionsForRoles(["Harness.Approver"]).has("draft.write")).toBe(false);
    expect(evaluate(author, "draft.approve", { kind: "draft" }).reasonCode).toBe("authorization.role_missing");
    expect(evaluate(approver, "draft.approve", { kind: "draft" }).outcome).toBe("allowed");
  });

  it("separates curating training data, authorizing it, spending on training and approving a model release", () => {
    const author = actionsForRoles(["Harness.Author"]), owner = actionsForRoles(["Data.Owner"]);
    expect(author.has("dataset.curate") && !author.has("dataset.authorize") && !author.has("factory.train")).toBe(true);
    expect(owner.has("dataset.authorize") && !owner.has("dataset.curate") && !owner.has("release.approve")).toBe(true);
    expect(actionsForRoles(["Harness.Operator"]).has("factory.train")).toBe(true);
    expect(actionsForRoles(["Harness.Approver"]).has("factory.train")).toBe(false);
    expect(actionsForRoles(["Harness.Reader"]).has("dataset.read")).toBe(false);
    expect(actionsForRoles(["Factory.Worker"])).toEqual(new Set(["factory.work"]));
  });

  it("lets platform administrators maintain the deployed capability registry", () => {
    expect(actionsForRoles(["Platform.Admin"]).has("capability.register")).toBe(true);
    expect(actionsForRoles(["Platform.Admin"]).has("draft.write")).toBe(false);
  });

  it("lets case roles read the event log and human work, and keeps deciding with the reviewer", () => {
    const analyst = actionsForRoles(["Case.Analyst"]);
    const reviewer = actionsForRoles(["Case.Reviewer"]);
    for (const actions of [analyst, reviewer]) {
      expect(actions.has("event.read")).toBe(true);
      expect(actions.has("human_work.read")).toBe(true);
    }
    expect(analyst.has("human_work.claim")).toBe(false);
    expect(analyst.has("human_work.decide")).toBe(false);
    expect(reviewer.has("human_work.decide")).toBe(true);
    for (const actions of [analyst, reviewer]) {
      expect(actions.has("human_work.resolve")).toBe(false);
      expect(actions.has("draft.read")).toBe(false);
    }
  });

  it("lets a case manager oversee and assign, but never write, review, claim or decide", () => {
    const manager = actionsForRoles(["Case.Manager"]);
    for (const action of ["case.read", "event.read", "evidence.read", "human_work.read", "case.assign"] as const) expect(manager.has(action)).toBe(true);
    for (const action of ["case.write", "case.review", "evidence.write", "human_work.claim", "human_work.decide", "human_work.resolve"] as const) expect(manager.has(action)).toBe(false);
    // Assigning is the manager's alone among the case roles.
    expect(actionsForRoles(["Case.Analyst", "Case.Reviewer"]).has("case.assign")).toBe(false);
  });

  it("refuses to act outside the principal's assigned tenant", () => {
    const analyst: Principal = { ...author, roles: ["Case.Analyst"] };
    expect(evaluate(analyst, "case.write", { kind: "case", tenantId: "tenant_demo" }).outcome).toBe("allowed");
    expect(evaluate(analyst, "case.write", { kind: "case", tenantId: "tenant_other" }).reasonCode)
      .toBe("authorization.tenant_mismatch");
  });

  it("does not let a workload role stand in for a human one", () => {
    const workload: Principal = { ...author, actorType: "workload", roles: ["Control.Api.Access"] };
    expect(evaluate(workload, "draft.publish", { kind: "draft" }).outcome).toBe("denied");
  });

  it("records a bounded decision without leaking the request", () => {
    const decisions: unknown[] = [];
    const authorizer = createAuthorizer((decision) => decisions.push(decision));
    authorizer.require(approver, "draft.approve", { kind: "draft", id: "draft_1" });
    expect(decisions).toEqual([{
      outcome: "allowed", reasonCode: "authorization.role_granted", action: "draft.approve",
      subjectId: "approver@example.test", actorType: "human", tenantId: "tenant_demo",
      resourceKind: "draft", resourceId: "draft_1",
    }]);
  });
});

describe("local header resolver", () => {
  it("rejects a request that asserts no actor instead of defaulting one", async () => {
    // The previous control API read String(headers["x-actor-id"] ?? "local-author"),
    // so an anonymous request became an authenticated author.
    const resolver = new LocalHeaderPrincipalResolver({ tenantId: "tenant_demo", roles: ["Harness.Reader"] }, {});
    await expect(resolver.resolve({ headers: {} })).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("reads actor, roles, and tenant from headers in local mode", async () => {
    const resolver = new LocalHeaderPrincipalResolver({ tenantId: "tenant_demo", roles: ["Harness.Reader"] }, {});
    const principal = await resolver.resolve({
      headers: { "x-actor-id": "analyst@example.test", "x-actor-roles": "Case.Analyst, Case.Reviewer" },
    });
    expect(principal).toEqual({
      subjectId: "analyst@example.test", tenantId: "tenant_demo", actorType: "human",
      roles: ["Case.Analyst", "Case.Reviewer"], source: "local",
    });
  });

  it("cannot be constructed or selected under the production profile", () => {
    expect(() => new LocalHeaderPrincipalResolver({ tenantId: "t", roles: [] }, { SECURITY_PROFILE: "production" }))
      .toThrow("platform.production_forbids:IDENTITY_PROVIDER=local_headers");
    expect(() => createPrincipalResolverFromEnv({ SECURITY_PROFILE: "production", IDENTITY_PROVIDER: "local_headers" }))
      .toThrow("platform.production_forbids:IDENTITY_PROVIDER=local_headers");
  });

  it("is the development default and production must name a provider", () => {
    expect(createPrincipalResolverFromEnv({})).toBeInstanceOf(LocalHeaderPrincipalResolver);
    expect(() => createPrincipalResolverFromEnv({ SECURITY_PROFILE: "production" })).toThrow("platform.production_requires:IDENTITY_PROVIDER");
    expect(() => createPrincipalResolverFromEnv({ IDENTITY_PROVIDER: "entra" })).toThrow("platform.setting_unsupported:IDENTITY_PROVIDER=entra");
  });
});

describe("edge delegation", () => {
  const edge = (roles: string[]): PrincipalResolver => ({
    source: "workload_identity",
    resolve: async () => ({ subjectId: "control-surface-edge", tenantId: "tenant_demo", actorType: "workload", roles, source: "workload_identity" }),
  });

  it("believes the actor headers only from an edge holding the delegation role", async () => {
    const resolver = new DelegatedPrincipalResolver(edge(["Edge.Delegate"]));
    await expect(resolver.resolve({ headers: { "x-actor-id": "analyst", "x-actor-roles": "Case.Analyst" } }))
      .resolves.toEqual({ subjectId: "analyst", tenantId: "tenant_demo", actorType: "human", roles: ["Case.Analyst"], source: "workload_identity" });
    await expect(new DelegatedPrincipalResolver(edge(["Case.Api.Access"])).resolve({ headers: { "x-actor-id": "analyst", "x-actor-roles": "Case.Analyst" } }))
      .rejects.toThrow(AuthorizationError);
  });

  it("refuses a tenant wider than the edge's own", async () => {
    const resolver = new DelegatedPrincipalResolver(edge(["Edge.Delegate"]));
    await expect(resolver.resolve({ headers: { "x-actor-id": "a", "x-actor-roles": "Case.Analyst", "x-tenant-id": "tenant_other" } }))
      .rejects.toThrow(AuthorizationError);
  });
});

async function issuer() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  const mint = (claims: Record<string, unknown>, options: { audience?: string; issuer?: string } = {}) => new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(options.issuer ?? "https://idp.example.test/realms/ehf")
    .setAudience(options.audience ?? "ehf-api")
    .setIssuedAt().setExpirationTime("5m").sign(privateKey);
  return { jwks: { keys: [jwk] }, mint };
}

describe("OpenID Connect resolver", () => {
  it("verifies issuer, audience and signature and reads roles from a configurable claim", async () => {
    const idp = await issuer();
    const resolver = new OidcJwtPrincipalResolver({
      issuer: "https://idp.example.test/realms/ehf", audience: "ehf-api", jwks: idp.jwks,
      rolesClaim: "realm_access.roles", resolveTenant: () => "tenant_demo",
    });
    const token = await idp.mint({ sub: "user-1", azp: "ehf-web", realm_access: { roles: ["Case.Analyst"] } });
    await expect(resolver.resolve({ headers: { authorization: `Bearer ${token}` } })).resolves.toEqual({
      subjectId: "user-1", tenantId: "tenant_demo", actorType: "human", roles: ["Case.Analyst"], source: "oidc",
    });
    const foreign = await idp.mint({ sub: "user-1" }, { audience: "other-api" });
    await expect(resolver.resolve({ headers: { authorization: `Bearer ${foreign}` } })).rejects.toThrow(AuthorizationError);
    const otherIssuer = await idp.mint({ sub: "user-1" }, { issuer: "https://evil.example.test" });
    await expect(resolver.resolve({ headers: { authorization: `Bearer ${otherIssuer}` } })).rejects.toThrow(AuthorizationError);
  });

  it("treats a client-credentials token as a workload and enforces allowed clients", async () => {
    const idp = await issuer();
    const resolver = new OidcJwtPrincipalResolver({
      issuer: "https://idp.example.test/realms/ehf", audience: "ehf-api", jwks: idp.jwks,
      allowedClientIds: ["ehf-web", "svc"], resolveTenant: () => "tenant_demo",
    });
    const service = await idp.mint({ sub: "svc", client_id: "svc" });
    await expect(resolver.resolve({ headers: { authorization: `Bearer ${service}` } })).resolves.toMatchObject({ actorType: "workload" });
    const stranger = await idp.mint({ sub: "user-1", azp: "unknown-client" });
    await expect(resolver.resolve({ headers: { authorization: `Bearer ${stranger}` } })).rejects.toThrow(AuthorizationError);
  });

  it("refuses symmetric algorithms and a plain-http issuer", () => {
    expect(() => new OidcJwtPrincipalResolver({ issuer: "https://idp.example.test", audience: "a", algorithms: ["HS256"], resolveTenant: () => "t" }))
      .toThrow("identity.oidc_algorithm_unsupported:HS256");
    expect(() => new OidcJwtPrincipalResolver({ issuer: "http://idp.example.test", audience: "a", resolveTenant: () => "t" }))
      .toThrow("identity.oidc_issuer_https_required");
  });

  it("is built from OIDC_* settings with a platform-controlled tenant", () => {
    expect(createPrincipalResolverFromEnv({ IDENTITY_PROVIDER: "oidc", OIDC_ISSUER: "https://idp.example.test", OIDC_AUDIENCE: "ehf", PLATFORM_TENANT_ID: "t" }))
      .toBeInstanceOf(OidcJwtPrincipalResolver);
    expect(() => createPrincipalResolverFromEnv({ IDENTITY_PROVIDER: "oidc", OIDC_ISSUER: "https://idp.example.test", OIDC_AUDIENCE: "ehf" }))
      .toThrow("identity.config_missing:PLATFORM_TENANT_ID");
  });
});

describe("workload identity", () => {
  const declarations = [
    { subjectId: "harness-runtime", roles: ["Capability.Invoke"], tokenEnv: "RUNTIME_SERVICE_TOKEN" },
    { subjectId: "control-surface-edge", roles: ["Edge.Delegate"], tokenEnv: "EDGE_SERVICE_TOKEN" },
  ];

  it("maps a verified projected token to the logical service and the roles this service grants it", async () => {
    const idp = await issuer();
    const grants = serviceGrants(declarations, { PLATFORM_TENANT_ID: "tenant_demo" });
    const resolver = new WorkloadIdentityPrincipalResolver(grants, {
      issuer: "https://idp.example.test/realms/ehf", audience: "ehf-internal", jwks: idp.jwks,
      identities: { "harness-runtime": "system:serviceaccount:ehf:runtime-host", "control-surface-edge": "system:serviceaccount:ehf:bff" },
    });
    const token = await idp.mint({ sub: "system:serviceaccount:ehf:runtime-host", roles: ["Platform.Admin"] }, { audience: "ehf-internal" });
    // Roles come from the grant, never from the token, so an IdP claim cannot widen them.
    await expect(resolver.resolve({ headers: { authorization: `Bearer ${token}` } })).resolves.toEqual({
      subjectId: "harness-runtime", tenantId: "tenant_demo", actorType: "workload", roles: ["Capability.Invoke"], source: "workload_identity",
    });
    const unknown = await idp.mint({ sub: "system:serviceaccount:ehf:other" }, { audience: "ehf-internal" });
    await expect(resolver.resolve({ headers: { authorization: `Bearer ${unknown}` } })).rejects.toThrow(AuthorizationError);
  });

  it("requires distinct identities and its issuer settings", () => {
    const grants = serviceGrants(declarations, {});
    const env = { WORKLOAD_AUTH: "workload_identity", WORKLOAD_IDENTITY_ISSUER: "https://k8s.example.test", WORKLOAD_IDENTITY_AUDIENCE: "ehf-internal" };
    expect(() => createWorkloadResolverFromEnv(grants, env)).toThrow("identity.config_missing:WORKLOAD_IDENTITIES");
    expect(() => createWorkloadResolverFromEnv(grants, { ...env, WORKLOAD_IDENTITIES: JSON.stringify({ "harness-runtime": "sa", "control-surface-edge": "sa" }) }))
      .toThrow("identity.workload_identities_not_distinct");
    expect(createWorkloadResolverFromEnv(grants, { ...env, WORKLOAD_IDENTITIES: JSON.stringify({ "harness-runtime": "sa-runtime" }) }))
      .toBeInstanceOf(WorkloadIdentityPrincipalResolver);
  });

  it("reads this service's single outgoing credential from the projected token file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ehf-identity-"));
    const file = join(dir, "token");
    writeFileSync(file, "projected-token\n");
    const token = createWorkloadTokenProvider({ staticTokenEnv: "RUNTIME_SERVICE_TOKEN" }, { WORKLOAD_AUTH: "workload_identity", WORKLOAD_TOKEN_FILE: file });
    await expect(token()).resolves.toBe("projected-token");
    const local = createWorkloadTokenProvider({ staticTokenEnv: "RUNTIME_SERVICE_TOKEN" }, { RUNTIME_SERVICE_TOKEN: "local-token" });
    await expect(local()).resolves.toBe("local-token");
  });

  it("needs a platform tenant in production", () => {
    expect(() => serviceGrants(declarations, { SECURITY_PROFILE: "production" })).toThrow("platform.production_requires:PLATFORM_TENANT_ID");
  });
});

describe("private-key envelope signer", () => {
  it("signs with a mounted RSA key that the public key verifies", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const dir = mkdtempSync(join(tmpdir(), "ehf-signer-"));
    const file = join(dir, "key.pem");
    writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }));
    const signer = createPrivateKeyJwtSignerFromEnv("EXECUTION_ENVELOPE", { EXECUTION_ENVELOPE_PRIVATE_KEY_FILE: file, EXECUTION_ENVELOPE_KEY_ID: "envelope-2026" });
    const message = new TextEncoder().encode("header.payload");
    const signature = await signer.sign(message);
    expect(verify("sha256", message, publicKey, signature)).toBe(true);
    expect(signer.keyId).toBe("envelope-2026");
  });

  it("refuses a non-RSA or short key and missing settings", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => createPrivateKeyJwtSigner({ privateKeyPem: ec, keyId: "k" })).toThrow("identity.signing_key_rsa_required");
    expect(() => createPrivateKeyJwtSignerFromEnv("RUNTIME_GRANT", {})).toThrow("identity.private_key_signer_missing:RUNTIME_GRANT");
  });
});

describe("secret references", () => {
  it("reads env: and file: references and refuses everything else", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ehf-secrets-"));
    writeFileSync(join(dir, "hook"), "s".repeat(32));
    await expect(resolveSecretRef("env:HOOK_SECRET", { HOOK_SECRET: "e".repeat(32) })).resolves.toBe("e".repeat(32));
    await expect(resolveSecretRef(`file:${join(dir, "hook")}`, { SECRETS_DIR: dir })).resolves.toBe("s".repeat(32));
    await expect(resolveSecretRef("file:/etc/passwd", { SECRETS_DIR: dir })).rejects.toThrow("secret.ref_outside_secrets_dir");
    await expect(resolveSecretRef("https://vault.example.test/secrets/hook", {})).rejects.toThrow("secret.ref_unsupported");
    await expect(resolveSecretRef("env:SHORT", { SHORT: "abc" })).rejects.toThrow("secret.unavailable");
  });
});

describe("platform invariants", () => {
  it("rejects process-wide TLS verification bypass in production", () => {
    expect(() => assertPlatformInvariants({}, { SECURITY_PROFILE: "production", NODE_TLS_REJECT_UNAUTHORIZED: "0" }))
      .toThrow("platform.production_forbids:NODE_TLS_REJECT_UNAUTHORIZED");
  });
  it("passes development conveniences under the development profile", () => {
    expect(() => assertPlatformInvariants(
      { forbidden: ["EXECUTION_ENVELOPE_SECRET"], databaseUrls: ["DATABASE_URL"] },
      { EXECUTION_ENVELOPE_SECRET: "shared", DATABASE_URL: "postgresql://postgres:postgres@postgres:5432/ehf" },
    )).not.toThrow();
  });

  it("refuses to boot in production with a shared secret, a missing requirement or a weak database URL", () => {
    const attempt = () => assertPlatformInvariants(
      { forbidden: ["EXECUTION_ENVELOPE_SECRET"], databaseUrls: ["DATABASE_URL"], required: ["METERED_MONTHLY_LIMIT_USD"] },
      {
        SECURITY_PROFILE: "production",
        EXECUTION_ENVELOPE_SECRET: "shared",
        DATABASE_URL: "postgresql://app:hunter2@db.example.test:5432/ehf",
        CASE_DATABASE_URL: "postgresql://app@localhost:5432/ehf",
      },
    );
    expect(attempt).toThrow(PlatformConfigError);
    expect(attempt).toThrow("platform.production_forbids:EXECUTION_ENVELOPE_SECRET");
    expect(attempt).toThrow("platform.production_requires:METERED_MONTHLY_LIMIT_USD");
    expect(attempt).toThrow("platform.production_forbids_password_in:DATABASE_URL");
    expect(attempt).toThrow("platform.production_forbids_local_host_in:CASE_DATABASE_URL");
  });

  it.each(["LOCAL_DEFAULT_ROLES", "LOCAL_DEFAULT_TENANT_ID", "RUNTIME_LOCAL_ENDPOINT"])(
    "refuses the development convenience %s in production", (name) => {
      expect(() => assertPlatformInvariants({}, { SECURITY_PROFILE: "production", [name]: "set" })).toThrow(`platform.production_forbids:${name}`);
      expect(() => assertPlatformInvariants({}, { [name]: "set" })).not.toThrow();
    });

  it("accepts a passwordless remote database URL in production", () => {
    expect(() => assertPlatformInvariants({}, { SECURITY_PROFILE: "production", DATABASE_URL: "postgresql://app@db.example.test:5432/ehf?sslmode=verify-full" })).not.toThrow();
  });
});

describe("security profile and mechanism settings", () => {
  it("defaults to development and refuses an unknown profile", () => {
    expect(securityProfile({})).toBe("development");
    expect(securityProfile({ SECURITY_PROFILE: "production" })).toBe("production");
    expect(() => securityProfile({ SECURITY_PROFILE: "prod" })).toThrow("platform.security_profile_unsupported:prod");
  });

  it.each(["local", "azure", ""])("refuses to start with the removed PLATFORM_MODE=%j and names its replacements", (value) => {
    const attempt = () => assertPlatformInvariants({}, { PLATFORM_MODE: value });
    expect(attempt).toThrow("platform.mode_removed");
    for (const name of PLATFORM_MODE_REPLACEMENTS) expect(attempt).toThrow(name);
    expect(() => securityProfile({ PLATFORM_MODE: value, SECURITY_PROFILE: "production" })).toThrow("platform.mode_removed");
  });

  it.each([
    ["IDENTITY_PROVIDER", "local_headers", "oidc"],
    ["WORKLOAD_AUTH", "static_token", "workload_identity"],
    ["ENVELOPE_SIGNER", "hmac", "private_key"],
    ["ENVELOPE_VERIFIER", "hmac", "public_key"],
  ] as const)("%s: development defaults to %s, production refuses it and requires an explicit value", (name, development, production) => {
    expect(mechanism(name, {})).toBe(development);
    expect(mechanism(name, { [name]: production })).toBe(production);
    expect(mechanism(name, { SECURITY_PROFILE: "production", [name]: production })).toBe(production);
    expect(() => mechanism(name, { SECURITY_PROFILE: "production" })).toThrow(`platform.production_requires:${name}`);
    expect(() => mechanism(name, { SECURITY_PROFILE: "production", [name]: development })).toThrow(`platform.production_forbids:${name}=${development}`);
    expect(() => mechanism(name, { [name]: "something_else" })).toThrow(`platform.setting_unsupported:${name}=something_else`);
  });

  it.each([
    ["DATABASE_AUTH", "url", "azure_ad"],
    ["TELEMETRY_EXPORTER", "otlp", "azure_monitor"],
  ] as const)("%s is %s in every profile and refuses the removed cloud-specific value %s", (name, fallback, removed) => {
    expect(mechanism(name, {})).toBe(fallback);
    expect(mechanism(name, { SECURITY_PROFILE: "production" })).toBe(fallback);
    expect(() => mechanism(name, { SECURITY_PROFILE: "production", [name]: removed })).toThrow(`platform.setting_unsupported:${name}=${removed}`);
    expect(() => mechanism(name, { [name]: "bogus" })).toThrow(`platform.setting_unsupported:${name}=bogus`);
  });

  it.each([
    ["IDENTITY_PROVIDER", "entra"], ["WORKLOAD_AUTH", "azure_managed_identity"], ["ENVELOPE_SIGNER", "azure_key_vault"],
  ] as const)("refuses the removed cloud-specific value %s=%s", (name, removed) => {
    expect(() => mechanism(name, { [name]: removed })).toThrow(`platform.setting_unsupported:${name}=${removed}`);
  });

  it("selects each mechanism through its accessor", () => {
    const env = { IDENTITY_PROVIDER: "oidc", WORKLOAD_AUTH: "workload_identity", ENVELOPE_SIGNER: "private_key", ENVELOPE_VERIFIER: "public_key", DATABASE_AUTH: "url", TELEMETRY_EXPORTER: "otlp" };
    expect([identityProvider(env), workloadAuth(env), envelopeSigner(env), envelopeVerifier(env), databaseAuth(env), telemetryExporter(env)])
      .toEqual(["oidc", "workload_identity", "private_key", "public_key", "url", "otlp"]);
  });

  it("validates the mechanisms a service declares at startup, with their required configuration", () => {
    const options = {
      mechanisms: ["ENVELOPE_SIGNER", "ENVELOPE_VERIFIER"] as const,
      requiredFor: { "ENVELOPE_SIGNER=private_key": ["EXECUTION_ENVELOPE_PRIVATE_KEY_FILE"] },
    };
    expect(() => assertPlatformInvariants({ ...options, mechanisms: [...options.mechanisms] }, {})).not.toThrow();
    expect(() => assertPlatformInvariants({ ...options, mechanisms: [...options.mechanisms] }, { SECURITY_PROFILE: "production" }))
      .toThrow("platform.production_requires:ENVELOPE_SIGNER");
    expect(() => assertPlatformInvariants({ ...options, mechanisms: [...options.mechanisms] }, { ENVELOPE_SIGNER: "private_key", ENVELOPE_VERIFIER: "public_key" }))
      .toThrow("platform.mechanism_requires:ENVELOPE_SIGNER=private_key:EXECUTION_ENVELOPE_PRIVATE_KEY_FILE");
    expect(() => assertPlatformInvariants({ ...options, mechanisms: [...options.mechanisms] }, { ENVELOPE_SIGNER: "private_key", ENVELOPE_VERIFIER: "hmac", EXECUTION_ENVELOPE_PRIVATE_KEY_FILE: "/run/secrets/envelope.pem" }))
      .toThrow("platform.envelope_mechanisms_inconsistent");
  });

  it("refuses static workload tokens in production and needs issuer settings for workload identity", () => {
    expect(() => new ServiceTokenPrincipalResolver([{ token: "x".repeat(32), subjectId: "s", roles: [], tenantId: "t" }], { SECURITY_PROFILE: "production" }))
      .toThrow("platform.production_forbids:WORKLOAD_AUTH=static_token");
    expect(createWorkloadResolverFromEnv([{ token: "x".repeat(32), subjectId: "s", roles: [], tenantId: "t" }], {})).toBeInstanceOf(ServiceTokenPrincipalResolver);
    expect(() => createWorkloadResolverFromEnv([], { WORKLOAD_AUTH: "workload_identity" })).toThrow("identity.config_missing:WORKLOAD_IDENTITY_ISSUER");
  });

  it("allows insecure endpoints only while developing", () => {
    expect(allowsInsecureEndpoints({})).toBe(true);
    expect(allowsInsecureEndpoints({ SECURITY_PROFILE: "production" })).toBe(false);
  });

  it("detects passwords in both URL and keyword connection strings", () => {
    expect(connectionStringHasPassword("postgresql://app:secret@host:5432/db")).toBe(true);
    expect(connectionStringHasPassword("host=db.example.test;Password=secret")).toBe(true);
    expect(connectionStringHasPassword("postgresql://app@host:5432/db")).toBe(false);
  });
});
