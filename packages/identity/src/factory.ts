import { LocalHeaderPrincipalResolver, OidcJwtPrincipalResolver, type PrincipalResolver } from "./principal.js";
import { identityProvider } from "./platform-config.js";
import { readJwksFile } from "./workload.js";

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`identity.config_missing:${name}`);
  return value;
}

function list(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

/**
 * Build the resolver the deployment selected.
 *
 * `IDENTITY_PROVIDER` is validated against the security profile rather than trusted on
 * its own, so a production deployment cannot be talked into header-based identity by a
 * stray environment variable, and must name its provider explicitly.
 */
export function createPrincipalResolverFromEnv(env: NodeJS.ProcessEnv = process.env): PrincipalResolver {
  const provider = identityProvider(env);
  if (provider === "local_headers") {
    return new LocalHeaderPrincipalResolver({
      tenantId: env.LOCAL_DEFAULT_TENANT_ID ?? "tenant_demo",
      roles: list(env.LOCAL_DEFAULT_ROLES ?? "Harness.Reader"),
    }, env);
  }
  if (provider === "oidc") {
    // A single-tenant deployment maps every verified principal into one platform tenant.
    // A multi-tenant deployment replaces this with a real assignment lookup; what matters
    // is that the value never comes from the request.
    const platformTenantId = requiredEnv(env, "PLATFORM_TENANT_ID");
    const tenantClaim = env.OIDC_TENANT_CLAIM?.trim();
    const tenantValue = env.OIDC_TENANT_VALUE?.trim();
    if (Boolean(tenantClaim) !== Boolean(tenantValue)) throw new Error("identity.config_missing:OIDC_TENANT_CLAIM+OIDC_TENANT_VALUE");
    const allowedClientIds = list(env.OIDC_ALLOWED_CLIENT_IDS);
    const algorithms = list(env.OIDC_ALGORITHMS);
    let roleMappings: Array<{ group: string; role: string }> | undefined;
    if (env.OIDC_GROUP_ROLE_MAPPINGS) {
      try { roleMappings = JSON.parse(env.OIDC_GROUP_ROLE_MAPPINGS); } catch { throw new Error("identity.group_mappings_invalid"); }
      if (!Array.isArray(roleMappings) || roleMappings.length > 100 || roleMappings.some(item => !item || typeof item.group !== "string" || typeof item.role !== "string")) throw new Error("identity.group_mappings_invalid");
    }
    return new OidcJwtPrincipalResolver({
      issuer: requiredEnv(env, "OIDC_ISSUER"),
      audience: requiredEnv(env, "OIDC_AUDIENCE"),
      ...(env.OIDC_JWKS_URI ? { jwksUri: env.OIDC_JWKS_URI } : {}),
      ...(env.OIDC_JWKS_FILE ? { jwks: readJwksFile(env.OIDC_JWKS_FILE) } : {}),
      resolveTenant: (claims) => !tenantClaim || claims[tenantClaim] === tenantValue ? platformTenantId : undefined,
      ...(allowedClientIds.length ? { allowedClientIds } : {}),
      ...(env.OIDC_ROLES_CLAIM ? { rolesClaim: env.OIDC_ROLES_CLAIM } : {}),
      ...(roleMappings ? { roleMappings } : {}),
      ...(algorithms.length ? { algorithms } : {}),
      ...(env.OIDC_WORKLOAD_SUBJECT_PATTERN ? { workloadSubjectPattern: new RegExp(env.OIDC_WORKLOAD_SUBJECT_PATTERN) } : {}),
    });
  }
  throw new Error(`identity.provider_unsupported:${String(provider)}`);
}
