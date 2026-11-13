import { timingSafeEqual } from "node:crypto";
import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import type { JSONWebKeySet } from "jose";
import { AuthorizationError, type Principal } from "./authorization.js";
import { isProductionProfile, workloadAuth } from "./platform-config.js";
import { OidcJwtPrincipalResolver, type PrincipalResolver, type RequestLike } from "./principal.js";

function constantTimeEquals(supplied: string, expected: string): boolean {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function unauthenticated(reasonCode: string): AuthorizationError {
  return new AuthorizationError({
    outcome: "denied", reasonCode, action: "plan.read", subjectId: "anonymous",
    actorType: "workload", tenantId: "unknown", resourceKind: "request", resourceId: null,
  });
}

/**
 * One calling service a consuming service expects, and the roles it grants that caller.
 *
 * Roles are declared by the consumer in code, never by the credential: a workload token
 * proves *which* service is calling, and the service being called decides what that
 * caller may do. `token` is the caller's development shared token; under
 * `WORKLOAD_AUTH=workload_identity` it is absent and the caller is recognised by its
 * verified workload-identity subject instead.
 */
export type ServiceTokenGrant = {
  subjectId: string;
  roles: string[];
  tenantId: string;
  token?: string;
};

export type ServiceGrantDeclaration = {
  /** Logical service name, e.g. `harness-runtime`. Mapped to a real subject by `WORKLOAD_IDENTITIES`. */
  subjectId: string;
  roles: string[];
  /** Environment variable holding the caller's development shared token. */
  tokenEnv: string;
};

/** The platform tenant every service acts in. Production must name it; development defaults it. */
export function platformTenantId(env: NodeJS.ProcessEnv = process.env): string {
  if (env.PLATFORM_TENANT_ID) return env.PLATFORM_TENANT_ID;
  if (isProductionProfile(env)) throw new Error("platform.production_requires:PLATFORM_TENANT_ID");
  return env.LOCAL_DEFAULT_TENANT_ID ?? "tenant_demo";
}

/** Turn a service's caller declarations into grants for the active workload mechanism. */
export function serviceGrants(declarations: ServiceGrantDeclaration[], env: NodeJS.ProcessEnv = process.env): ServiceTokenGrant[] {
  const tenantId = platformTenantId(env);
  return declarations.map(({ subjectId, roles, tokenEnv }) => ({
    subjectId, roles, tenantId, ...(env[tokenEnv] ? { token: env[tokenEnv] } : {}),
  }));
}

/**
 * Development workload identity: a shared bearer token per calling service.
 *
 * `WORKLOAD_AUTH=workload_identity` replaces this with a verified workload-identity
 * token; the point of keeping the same interface is that services enforce the same
 * grants either way, so the authorization code does not change when the credential does.
 */
export class ServiceTokenPrincipalResolver implements PrincipalResolver {
  readonly source = "local" as const;
  private readonly grants: Array<ServiceTokenGrant & { token: string }>;

  constructor(grants: ServiceTokenGrant[], env: NodeJS.ProcessEnv = process.env) {
    if (isProductionProfile(env)) throw new Error("platform.production_forbids:WORKLOAD_AUTH=static_token");
    this.grants = grants.filter((grant): grant is ServiceTokenGrant & { token: string } => Boolean(grant.token));
    if (!this.grants.length) throw new Error("identity.service_token_grants_missing");
    for (const grant of this.grants) {
      if (grant.token.length < 24) throw new Error(`identity.service_token_too_short:${grant.subjectId}`);
    }
  }

  async resolve(request: RequestLike): Promise<Principal> {
    const value = request.headers.authorization;
    const authorization = (Array.isArray(value) ? value[0] : value) ?? "";
    if (!authorization.startsWith("Bearer ")) throw unauthenticated("authorization.principal_unauthenticated");
    const supplied = authorization.slice(7);
    const grant = this.grants.find((candidate) => constantTimeEquals(supplied, candidate.token));
    if (!grant) throw unauthenticated("authorization.service_token_invalid");
    return { subjectId: grant.subjectId, tenantId: grant.tenantId, actorType: "workload", roles: grant.roles, source: "local" };
  }
}

export type WorkloadIdentityOptions = {
  issuer: string;
  audience: string;
  jwksUri?: string;
  jwks?: JSONWebKeySet;
  /** Logical service name -> verified token subject, e.g. `system:serviceaccount:ehf:runtime-host`. */
  identities: Record<string, string>;
  algorithms?: string[];
  fetch?: typeof fetch;
};

/**
 * Production workload identity: each service presents one short-lived token issued to it
 * by the platform it runs on -- a Kubernetes projected service-account token, a SPIFFE
 * JWT-SVID, or a client-credentials token from any OpenID Connect issuer. The token is
 * verified against the issuer's published keys, its subject is mapped to a logical
 * service name, and that service's roles come from this service's own grants.
 */
export class WorkloadIdentityPrincipalResolver implements PrincipalResolver {
  readonly source = "workload_identity" as const;
  private readonly verifier: OidcJwtPrincipalResolver;
  private readonly bySubject: Map<string, ServiceTokenGrant>;

  constructor(grants: ServiceTokenGrant[], options: WorkloadIdentityOptions) {
    this.verifier = new OidcJwtPrincipalResolver({
      issuer: options.issuer,
      audience: options.audience,
      ...(options.jwksUri ? { jwksUri: options.jwksUri } : {}),
      ...(options.jwks ? { jwks: options.jwks } : {}),
      ...(options.algorithms?.length ? { algorithms: options.algorithms } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      resolveTenant: () => "workload",
    });
    this.bySubject = new Map();
    for (const grant of grants) {
      const subject = options.identities[grant.subjectId];
      if (subject) this.bySubject.set(subject, grant);
    }
    if (!this.bySubject.size) throw new Error("identity.workload_identities_missing");
  }

  async resolve(request: RequestLike): Promise<Principal> {
    const verified = await this.verifier.resolve(request);
    const grant = this.bySubject.get(verified.subjectId);
    if (!grant) throw unauthenticated("authorization.workload_not_permitted");
    return { subjectId: grant.subjectId, tenantId: grant.tenantId, actorType: "workload", roles: grant.roles, source: "workload_identity" };
  }
}

/** Read a JWKS document from disk, e.g. `kubectl get --raw /openid/v1/jwks` mounted as a config map. */
export function readJwksFile(path: string): JSONWebKeySet {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw new Error("identity.jwks_file_invalid"); }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { keys?: unknown }).keys)) throw new Error("identity.jwks_file_invalid");
  return parsed as JSONWebKeySet;
}

function parseIdentities(env: NodeJS.ProcessEnv): Record<string, string> {
  const raw = env.WORKLOAD_IDENTITIES;
  if (!raw) throw new Error("identity.config_missing:WORKLOAD_IDENTITIES");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("identity.workload_identities_invalid"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.values(parsed).some((value) => typeof value !== "string" || !value)) throw new Error("identity.workload_identities_invalid");
  const subjects = Object.values(parsed as Record<string, string>);
  // Two services sharing one subject would be one identity wearing two names.
  if (new Set(subjects).size !== subjects.length) throw new Error("identity.workload_identities_not_distinct");
  return parsed as Record<string, string>;
}

/**
 * Resolve the workload identity of a calling service.
 *
 * Grants are declared by the consuming service, so each one states which callers it
 * expects rather than sharing one platform-wide credential.
 */
export function createWorkloadResolverFromEnv(
  grants: ServiceTokenGrant[],
  env: NodeJS.ProcessEnv = process.env,
): PrincipalResolver {
  if (workloadAuth(env) === "static_token") return new ServiceTokenPrincipalResolver(grants, env);
  const algorithms = (env.WORKLOAD_IDENTITY_ALGORITHMS ?? "").split(",").map((value) => value.trim()).filter(Boolean);
  const issuer = env.WORKLOAD_IDENTITY_ISSUER;
  const audience = env.WORKLOAD_IDENTITY_AUDIENCE;
  if (!issuer) throw new Error("identity.config_missing:WORKLOAD_IDENTITY_ISSUER");
  if (!audience) throw new Error("identity.config_missing:WORKLOAD_IDENTITY_AUDIENCE");
  return new WorkloadIdentityPrincipalResolver(grants, {
    issuer, audience, identities: parseIdentities(env),
    ...(env.WORKLOAD_IDENTITY_JWKS_URI ? { jwksUri: env.WORKLOAD_IDENTITY_JWKS_URI } : {}),
    ...(env.WORKLOAD_IDENTITY_JWKS_FILE ? { jwks: readJwksFile(env.WORKLOAD_IDENTITY_JWKS_FILE) } : {}),
    ...(algorithms.length ? { algorithms } : {}),
  });
}

/** How long a projected token read from disk is reused before the file is read again. */
const TOKEN_FILE_REFRESH_MS = 30_000;

/**
 * This service's outgoing credential, the same one for every service it calls.
 *
 * Under `static_token` it is the development token named by `staticTokenEnv`. Under
 * `workload_identity` it is the token the platform projects into `WORKLOAD_TOKEN_FILE`;
 * the platform rotates the file, so it is re-read rather than cached for the process
 * lifetime.
 */
export function createWorkloadTokenProvider(
  input: { staticTokenEnv: string },
  env: NodeJS.ProcessEnv = process.env,
): () => Promise<string> {
  if (workloadAuth(env) === "static_token") {
    return async () => {
      const token = env[input.staticTokenEnv];
      if (!token) throw new Error(`identity.service_token_missing:${input.staticTokenEnv}`);
      return token;
    };
  }
  const path = env.WORKLOAD_TOKEN_FILE;
  if (!path) throw new Error("identity.config_missing:WORKLOAD_TOKEN_FILE");
  let cached: { token: string; readAt: number; mtimeMs: number } | undefined;
  return async () => {
    const now = Date.now();
    if (cached && now - cached.readAt < TOKEN_FILE_REFRESH_MS) return cached.token;
    // One descriptor for the change check and the read: a rotated token is never paired
    // with the previous file's timestamp.
    const fd = openSync(path, "r");
    try {
      const mtimeMs = fstatSync(fd).mtimeMs;
      if (cached && cached.mtimeMs === mtimeMs) {
        cached.readAt = now;
        return cached.token;
      }
      const token = readFileSync(fd, "utf8").trim();
      if (!token) throw new Error("identity.workload_token_empty");
      cached = { token, readAt: now, mtimeMs };
      return token;
    } finally { closeSync(fd); }
  };
}

/** `Bearer <token>` for this service's outgoing calls. */
export function createWorkloadAuthorization(
  input: { staticTokenEnv: string },
  env: NodeJS.ProcessEnv = process.env,
): () => Promise<string> {
  const token = createWorkloadTokenProvider(input, env);
  return async () => `Bearer ${await token()}`;
}

/** Role a caller must hold before its asserted end-user context is believed. */
export const EDGE_DELEGATE_ROLE = "Edge.Delegate";

function headerValue(request: RequestLike, name: string): string | undefined {
  const value = request.headers[name];
  const single = Array.isArray(value) ? value[0] : value;
  return single?.trim() || undefined;
}

/**
 * Identity for requests that arrive through the UI backend-for-frontend.
 *
 * The edge is the only component that has seen the interactive sign-in, so it has to
 * pass the end-user context onwards. That context is believed only when the request also
 * proves it came from the edge and the edge holds the delegation role -- so the actor
 * and tenant headers carry no authority on their own. The edge is expected to strip
 * inbound copies before setting its own.
 */
export class DelegatedPrincipalResolver implements PrincipalResolver {
  readonly source: Principal["source"];

  constructor(private readonly edge: PrincipalResolver) {
    this.source = edge.source;
  }

  async resolve(request: RequestLike): Promise<Principal> {
    const edgePrincipal = await this.edge.resolve(request);
    if (edgePrincipal.actorType !== "workload" || !edgePrincipal.roles.includes(EDGE_DELEGATE_ROLE)) throw unauthenticated("authorization.delegation_not_permitted");
    const subjectId = headerValue(request, "x-actor-id");
    if (!subjectId) throw unauthenticated("authorization.delegated_actor_missing");
    const roles = headerValue(request, "x-actor-roles")?.split(",").map((role) => role.trim()).filter(Boolean) ?? [];
    if (!roles.length) throw unauthenticated("authorization.delegated_roles_missing");
    // The edge may narrow the tenant it acts in, never widen it beyond its own assignment.
    const requestedTenant = headerValue(request, "x-tenant-id");
    if (requestedTenant && requestedTenant !== edgePrincipal.tenantId) throw unauthenticated("authorization.delegated_tenant_mismatch");
    const directorySubjectId = headerValue(request, "x-actor-directory-subject-id");
    if (directorySubjectId && !/^entra:[0-9a-f-]{36}:[0-9a-f-]{36}$/.test(directorySubjectId)) throw unauthenticated("authorization.delegated_actor_invalid");
    return { subjectId, tenantId: edgePrincipal.tenantId, actorType: "human", roles, source: edgePrincipal.source, ...(directorySubjectId ? { directorySubjectId } : {}) };
  }
}
