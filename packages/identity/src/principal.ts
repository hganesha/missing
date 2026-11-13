import { createLocalJWKSet, createRemoteJWKSet, jwtVerify, type JSONWebKeySet, type JWTPayload } from "jose";
import { AuthorizationError, evaluate, type Principal } from "./authorization.js";
import { isProductionProfile } from "./platform-config.js";
import { entraTenantFromIssuer, entraDirectorySubject } from "./entra.js";

export type RequestLike = {
  headers: Record<string, string | string[] | undefined>;
};

export interface PrincipalResolver {
  readonly source: Principal["source"];
  resolve(request: RequestLike): Promise<Principal>;
}

function header(request: RequestLike, name: string): string | undefined {
  const value = request.headers[name];
  const single = Array.isArray(value) ? value[0] : value;
  return single?.trim() || undefined;
}

function unauthenticated(reasonCode: string): AuthorizationError {
  return new AuthorizationError({
    outcome: "denied",
    reasonCode,
    action: "plan.read",
    subjectId: "anonymous",
    actorType: "unknown",
    tenantId: "unknown",
    resourceKind: "request",
    resourceId: null,
  });
}

/**
 * Development resolver: the caller asserts its own identity through headers.
 *
 * This is only safe because nothing but a developer's own machine can reach the local
 * stack. It refuses to construct under the production profile rather than relying on a deployment to
 * remember not to select it -- the previous code defaulted a missing `x-actor-id` to
 * "local-author", which in a cloud deployment is an unauthenticated author.
 */
export class LocalHeaderPrincipalResolver implements PrincipalResolver {
  readonly source = "local" as const;

  constructor(
    private readonly defaults: { tenantId: string; roles: string[] },
    env: NodeJS.ProcessEnv = process.env,
  ) {
    if (isProductionProfile(env)) throw new Error("platform.production_forbids:IDENTITY_PROVIDER=local_headers");
  }

  async resolve(request: RequestLike): Promise<Principal> {
    const subjectId = header(request, "x-actor-id");
    if (!subjectId) throw unauthenticated("authorization.principal_unauthenticated");
    const roles = header(request, "x-actor-roles")?.split(",").map((role) => role.trim()).filter(Boolean);
    return {
      subjectId,
      tenantId: header(request, "x-tenant-id") ?? this.defaults.tenantId,
      actorType: header(request, "x-actor-type") === "workload" ? "workload" : "human",
      roles: roles?.length ? roles : this.defaults.roles,
      source: "local",
    };
  }
}

export type OidcResolverOptions = {
  /** OpenID issuer the token must name, e.g. https://idp.example.com/realms/ehf */
  issuer: string;
  audience: string;
  /** JWKS endpoint. Discovered from `<issuer>/.well-known/openid-configuration` when absent. */
  jwksUri?: string;
  /** A fixed key set instead of an endpoint, e.g. a cluster's service-account keys mounted as a file. */
  jwks?: JSONWebKeySet;
  /** Maps the verified claims to the platform tenant this principal acts in. */
  resolveTenant: (claims: JWTPayload) => string | undefined;
  /** Client application IDs (`azp` or `client_id`) permitted to call this API, when restricted. */
  allowedClientIds?: string[];
  /** Claim holding the role list; a dotted path such as `realm_access.roles` is accepted. */
  rolesClaim?: string;
  roleMappings?: Array<{ group: string; role: string }>;
  /** Signature algorithms accepted. Asymmetric only. */
  algorithms?: string[];
  /** Subjects matching this pattern are services rather than people. */
  workloadSubjectPattern?: RegExp;
  fetch?: typeof fetch;
};

type KeySet = ReturnType<typeof createRemoteJWKSet> | ReturnType<typeof createLocalJWKSet>;

const ASYMMETRIC_ALGORITHMS = new Set(["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"]);

function claimAt(claims: JWTPayload, path: string): unknown {
  let value: unknown = claims;
  for (const part of path.split(".")) {
    if (!value || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/**
 * OpenID Connect resolver for any standards-compliant identity provider (Keycloak, Okta,
 * Auth0, Google, Ping, Dex, a cloud directory, ...).
 *
 * A platform in front of the app may already have validated the token, but the
 * application still enforces the claims it cares about -- the issuer, the audience it was
 * actually issued for, which client applications may call it, and the roles. A validated
 * token is not an authorization decision.
 */
export class OidcJwtPrincipalResolver implements PrincipalResolver {
  readonly source = "oidc" as const;
  private jwks: KeySet | undefined;
  private discovery: Promise<KeySet> | undefined;
  private readonly algorithms: string[];

  constructor(private readonly options: OidcResolverOptions) {
    const issuer = new URL(options.issuer);
    if (issuer.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(issuer.hostname)) throw new Error("identity.oidc_issuer_https_required");
    if (!options.audience.trim()) throw new Error("identity.oidc_audience_missing");
    this.algorithms = options.algorithms?.length ? options.algorithms : ["RS256", "PS256", "ES256"];
    for (const algorithm of this.algorithms) {
      if (!ASYMMETRIC_ALGORITHMS.has(algorithm)) throw new Error(`identity.oidc_algorithm_unsupported:${algorithm}`);
    }
    if (options.jwks) this.jwks = createLocalJWKSet(options.jwks);
    else if (options.jwksUri) this.jwks = createRemoteJWKSet(new URL(options.jwksUri));
  }

  private async keySet(): Promise<KeySet> {
    if (this.jwks) return this.jwks;
    this.discovery ??= (async () => {
      const url = new URL(".well-known/openid-configuration", this.options.issuer.endsWith("/") ? this.options.issuer : `${this.options.issuer}/`);
      const response = await (this.options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
      if (!response.ok) throw new Error(`identity.oidc_discovery_failed:${response.status}`);
      const document = await response.json() as { issuer?: unknown; jwks_uri?: unknown };
      if (document.issuer !== this.options.issuer || typeof document.jwks_uri !== "string") throw new Error("identity.oidc_discovery_invalid");
      this.jwks = createRemoteJWKSet(new URL(document.jwks_uri));
      return this.jwks;
    })().catch((error) => { this.discovery = undefined; throw error; });
    return this.discovery;
  }

  async resolve(request: RequestLike): Promise<Principal> {
    const authorization = header(request, "authorization");
    if (!authorization?.startsWith("Bearer ")) throw unauthenticated("authorization.principal_unauthenticated");
    let claims: JWTPayload;
    try {
      const verified = await jwtVerify(authorization.slice(7), await this.keySet(), {
        issuer: this.options.issuer,
        audience: this.options.audience,
        algorithms: this.algorithms,
        clockTolerance: 5,
      });
      claims = verified.payload;
    } catch {
      throw unauthenticated("authorization.token_invalid");
    }
    const clientId = typeof claims.azp === "string" ? claims.azp : typeof claims.client_id === "string" ? claims.client_id : undefined;
    if (this.options.allowedClientIds?.length && (!clientId || !this.options.allowedClientIds.includes(clientId))) {
      throw unauthenticated("authorization.client_not_permitted");
    }
    const rawRoles = claimAt(claims, this.options.rolesClaim ?? "roles");
    const asserted = Array.isArray(rawRoles) ? rawRoles.filter((role): role is string => typeof role === "string") : [];
    const roles = this.options.roleMappings ? [...new Set(this.options.roleMappings.filter(mapping => asserted.includes(mapping.group)).map(mapping => mapping.role))] : asserted;
    // Tenancy comes from an assignment the platform controls, never from a value the
    // caller supplied. A caller-provided x-tenant-id is at most a requested scope.
    const tenantId = this.options.resolveTenant(claims);
    if (!tenantId) throw unauthenticated("authorization.tenant_unassigned");
    const subjectId = typeof claims.sub === "string" && claims.sub ? claims.sub : undefined;
    if (!subjectId) throw unauthenticated("authorization.subject_missing");
    // A client-credentials token names the client as its own subject; a configured
    // pattern covers issuers that name services differently.
    const workload = (clientId !== undefined && clientId === subjectId) || Boolean(this.options.workloadSubjectPattern?.test(subjectId));
    const entraTenant = entraTenantFromIssuer(this.options.issuer);
    let directorySubjectId: string | undefined;
    if (!workload && entraTenant && claims.oid !== undefined) {
      if (typeof claims.tid !== "string" || claims.tid.toLowerCase() !== entraTenant || typeof claims.oid !== "string") throw unauthenticated("authorization.tenant_unassigned");
      try { directorySubjectId = entraDirectorySubject(entraTenant, claims.oid); }
      catch { throw unauthenticated("authorization.subject_missing"); }
    }
    return { subjectId, tenantId, actorType: workload ? "workload" : "human", roles, source: "oidc", ...(directorySubjectId ? { directorySubjectId } : {}) };
  }
}

/**
 * Resolve the principal for a request, returning null instead of throwing so a caller
 * can record a single denial decision for an unauthenticated request.
 */
export async function tryResolve(resolver: PrincipalResolver, request: RequestLike): Promise<Principal | null> {
  try {
    return await resolver.resolve(request);
  } catch (error) {
    if (error instanceof AuthorizationError) return null;
    throw error;
  }
}

export { evaluate };
