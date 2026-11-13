/**
 * Security profile, per-concern mechanism settings, and the startup invariants that go
 * with them.
 *
 * The platform is cloud-agnostic: the same images run on a developer laptop, on any
 * Kubernetes cluster, on Databricks or elsewhere, and no cloud is a mode of the core.
 * Every production mechanism is an open standard: OpenID Connect for people, projected
 * workload-identity tokens (Kubernetes service accounts, SPIFFE JWT-SVIDs or any OIDC
 * issuer) for services, a mounted private key for signing, and OTLP for telemetry. Two kinds of setting
 * replace the former `PLATFORM_MODE`:
 *
 * - `SECURITY_PROFILE=development|production` is the posture. Production refuses every
 *   development convenience -- a shared HMAC secret, a static service token, a
 *   password-bearing connection string, a header-trusting principal resolver, local
 *   autologin, disabled TLS verification -- because each is an authentication bypass
 *   once the service is reachable by anyone but its developer.
 * - One explicit setting per mechanism says *how* a concern is implemented: which
 *   identity provider verifies callers, how workloads obtain and verify service
 *   credentials, who signs and verifies envelopes, how the database authenticates and
 *   where telemetry goes.
 *
 * Every setting fails closed on an unknown value, and these checks run at startup so a
 * service refuses to boot rather than serving traffic half-configured.
 */

export type SecurityProfile = "development" | "production";

export class PlatformConfigError extends Error {}

/** Settings that replaced `PLATFORM_MODE`, named in its refusal so an operator knows what to set. */
export const PLATFORM_MODE_REPLACEMENTS = [
  "SECURITY_PROFILE",
  "IDENTITY_PROVIDER",
  "WORKLOAD_AUTH",
  "ENVELOPE_SIGNER",
  "ENVELOPE_VERIFIER",
  "DATABASE_AUTH",
  "TELEMETRY_EXPORTER",
] as const;

/**
 * `PLATFORM_MODE` no longer selects anything. A deployment that still sets it must not
 * boot silently in the development posture, so its presence is a startup failure.
 */
export function assertNoPlatformMode(env: NodeJS.ProcessEnv = process.env): void {
  if (env.PLATFORM_MODE !== undefined) {
    throw new PlatformConfigError(
      `platform.mode_removed: PLATFORM_MODE is no longer supported; unset it and set ${PLATFORM_MODE_REPLACEMENTS.join(", ")} instead (SECURITY_PROFILE=production plus explicit mechanism values for a deployed environment)`,
    );
  }
}

export function securityProfile(env: NodeJS.ProcessEnv = process.env): SecurityProfile {
  assertNoPlatformMode(env);
  const value = env.SECURITY_PROFILE ?? "development";
  if (value !== "development" && value !== "production") throw new PlatformConfigError(`platform.security_profile_unsupported:${value}`);
  return value;
}

export function isProductionProfile(env: NodeJS.ProcessEnv = process.env): boolean {
  return securityProfile(env) === "production";
}

type MechanismSpec<T extends string> = {
  values: readonly T[];
  /** Used when the setting is unset under the development profile. */
  developmentDefault: T;
  /** Used when unset under production; absent means production must name a value. */
  productionDefault?: T;
  /** Values production refuses, because they are development conveniences. */
  productionForbids?: readonly T[];
};

export const IDENTITY_PROVIDERS = ["local_headers", "oidc"] as const;
export const WORKLOAD_AUTH_MODES = ["static_token", "workload_identity"] as const;
export const ENVELOPE_SIGNERS = ["hmac", "private_key"] as const;
export const ENVELOPE_VERIFIERS = ["hmac", "public_key"] as const;
export const DATABASE_AUTH_MODES = ["url"] as const;
export const TELEMETRY_EXPORTERS = ["otlp"] as const;

export type IdentityProvider = typeof IDENTITY_PROVIDERS[number];
export type WorkloadAuth = typeof WORKLOAD_AUTH_MODES[number];
export type EnvelopeSigner = typeof ENVELOPE_SIGNERS[number];
export type EnvelopeVerifier = typeof ENVELOPE_VERIFIERS[number];
export type DatabaseAuth = typeof DATABASE_AUTH_MODES[number];
export type TelemetryExporter = typeof TELEMETRY_EXPORTERS[number];

const MECHANISMS = {
  /** How human bearer tokens are verified: development headers, or any OpenID Connect issuer. */
  IDENTITY_PROVIDER: { values: IDENTITY_PROVIDERS, developmentDefault: "local_headers", productionForbids: ["local_headers"] } satisfies MechanismSpec<IdentityProvider>,
  /**
   * How services obtain outgoing service-to-service credentials and verify incoming ones:
   * a development shared token, or one projected workload-identity token per service.
   */
  WORKLOAD_AUTH: { values: WORKLOAD_AUTH_MODES, developmentDefault: "static_token", productionForbids: ["static_token"] } satisfies MechanismSpec<WorkloadAuth>,
  /** Who signs execution envelopes, runtime grants and integration envelopes: a shared secret, or a mounted private key. */
  ENVELOPE_SIGNER: { values: ENVELOPE_SIGNERS, developmentDefault: "hmac", productionForbids: ["hmac"] } satisfies MechanismSpec<EnvelopeSigner>,
  /** How those envelopes are verified: the shared secret, or the signer's public key. */
  ENVELOPE_VERIFIER: { values: ENVELOPE_VERIFIERS, developmentDefault: "hmac", productionForbids: ["hmac"] } satisfies MechanismSpec<EnvelopeVerifier>,
  /**
   * How services authenticate to PostgreSQL: a connection URL. Production refuses a
   * password inside it, so the password comes from PGPASSFILE or the server trusts a TLS
   * client certificate (PGSSLCERT/PGSSLKEY) -- both work on any PostgreSQL.
   */
  DATABASE_AUTH: { values: DATABASE_AUTH_MODES, developmentDefault: "url", productionDefault: "url" } satisfies MechanismSpec<DatabaseAuth>,
  /** Where traces go: any OTLP collector. */
  TELEMETRY_EXPORTER: { values: TELEMETRY_EXPORTERS, developmentDefault: "otlp", productionDefault: "otlp" } satisfies MechanismSpec<TelemetryExporter>,
} as const;

export type MechanismSetting = keyof typeof MECHANISMS;
type MechanismValue<K extends MechanismSetting> = (typeof MECHANISMS)[K]["values"][number];

/**
 * Read one mechanism setting. Unknown values are refused, production refuses the
 * development conveniences, and production must name a value where no safe default
 * exists.
 */
export function mechanism<K extends MechanismSetting>(name: K, env: NodeJS.ProcessEnv = process.env): MechanismValue<K> {
  const spec = MECHANISMS[name] as MechanismSpec<string>;
  const production = isProductionProfile(env);
  const raw = env[name]?.trim();
  if (!raw) {
    const fallback = production ? spec.productionDefault : spec.developmentDefault;
    if (!fallback) throw new PlatformConfigError(`platform.production_requires:${name}`);
    return fallback as MechanismValue<K>;
  }
  if (!spec.values.includes(raw)) throw new PlatformConfigError(`platform.setting_unsupported:${name}=${raw}`);
  if (production && spec.productionForbids?.includes(raw)) throw new PlatformConfigError(`platform.production_forbids:${name}=${raw}`);
  return raw as MechanismValue<K>;
}

export const identityProvider = (env: NodeJS.ProcessEnv = process.env): IdentityProvider => mechanism("IDENTITY_PROVIDER", env);
export const workloadAuth = (env: NodeJS.ProcessEnv = process.env): WorkloadAuth => mechanism("WORKLOAD_AUTH", env);
export const envelopeSigner = (env: NodeJS.ProcessEnv = process.env): EnvelopeSigner => mechanism("ENVELOPE_SIGNER", env);
export const envelopeVerifier = (env: NodeJS.ProcessEnv = process.env): EnvelopeVerifier => mechanism("ENVELOPE_VERIFIER", env);
export const databaseAuth = (env: NodeJS.ProcessEnv = process.env): DatabaseAuth => mechanism("DATABASE_AUTH", env);
export const telemetryExporter = (env: NodeJS.ProcessEnv = process.env): TelemetryExporter => mechanism("TELEMETRY_EXPORTER", env);

/**
 * Configuration the production mechanisms need wherever they are selected. Services spread
 * this into `requiredFor` so a deployment is told at startup, not by its first request.
 */
export const MECHANISM_REQUIREMENTS = {
  "IDENTITY_PROVIDER=oidc": ["OIDC_ISSUER", "OIDC_AUDIENCE", "PLATFORM_TENANT_ID"],
  "WORKLOAD_AUTH=workload_identity": ["WORKLOAD_IDENTITY_ISSUER", "WORKLOAD_IDENTITY_AUDIENCE", "WORKLOAD_IDENTITIES", "WORKLOAD_TOKEN_FILE", "PLATFORM_TENANT_ID"],
} as const satisfies Partial<Record<`${MechanismSetting}=${string}`, readonly string[]>>;

/** A connection string that carries its own password can never be a token-authenticated one. */
export function connectionStringHasPassword(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.password);
  } catch {
    return /(^|[;\s])password=/i.test(value);
  }
}

/** Database URL settings any service may read; production constrains every one that is set. */
const DATABASE_URL_SETTINGS = ["DATABASE_URL", "CASE_DATABASE_URL", "CONTEXT_DATABASE_URL", "DATABASE_BOOTSTRAP_URL", "EXECUTION_DATABASE_URL"];

/**
 * Development conveniences production refuses whichever service reads them: local
 * autologin and default-tenant shortcuts, and the development runtime host endpoint
 * (production names RUNTIME_HOSTED_ENDPOINT).
 */
const PRODUCTION_FORBIDDEN = [
  "LOCAL_DEFAULT_TENANT_ID",
  "LOCAL_DEFAULT_ROLES",
  "RUNTIME_LOCAL_ENDPOINT",
];

export type StartupInvariantOptions = {
  /** Environment variables (usually shared secrets) that must be absent in production. */
  forbidden?: string[];
  /** Environment variables that must be present in production. */
  required?: string[];
  /** Additional database URL settings this service reads (the common ones are always checked). */
  databaseUrls?: string[];
  /** Mechanism settings this service uses; each is validated for the active profile at startup. */
  mechanisms?: MechanismSetting[];
  /**
   * Configuration a selected mechanism needs, in every profile, keyed `NAME=value`:
   * `{ "ENVELOPE_SIGNER=private_key": ["EXECUTION_ENVELOPE_PRIVATE_KEY_FILE"] }`.
   */
  requiredFor?: Partial<Record<`${MechanismSetting}=${string}`, readonly string[]>>;
};

/**
 * Assert the invariants for the active security profile. Every profile refuses
 * `PLATFORM_MODE` and unknown mechanism values; production additionally refuses the
 * development conveniences.
 */
export function assertPlatformInvariants(
  options: StartupInvariantOptions = {},
  env: NodeJS.ProcessEnv = process.env,
): void {
  const production = isProductionProfile(env);
  const failures: string[] = [];
  const selected = new Map<string, string>();
  for (const name of new Set([...(options.mechanisms ?? []), ...Object.keys(options.requiredFor ?? {}).map((key) => key.split("=")[0] as MechanismSetting)])) {
    try { selected.set(name, mechanism(name, env)); } catch (error) { failures.push(error instanceof Error ? error.message : String(error)); }
  }
  // A shared-secret signer can only be verified with the shared secret, and a key-pair
  // signer only with its public key. A mismatch would mint envelopes nothing accepts.
  const signer = selected.get("ENVELOPE_SIGNER");
  const verifier = selected.get("ENVELOPE_VERIFIER");
  if (signer && verifier && (signer === "hmac") !== (verifier === "hmac")) {
    failures.push(`platform.envelope_mechanisms_inconsistent:ENVELOPE_SIGNER=${signer},ENVELOPE_VERIFIER=${verifier}`);
  }
  for (const [key, names] of Object.entries(options.requiredFor ?? {})) {
    const [name, value] = key.split("=");
    if (selected.get(name!) !== value) continue;
    for (const required of names ?? []) {
      if (!env[required]) failures.push(`platform.mechanism_requires:${key}:${required}`);
    }
  }
  if (production) {
    if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0") failures.push("platform.production_forbids:NODE_TLS_REJECT_UNAUTHORIZED");
    for (const name of [...PRODUCTION_FORBIDDEN, ...(options.forbidden ?? [])]) {
      if (env[name]) failures.push(`platform.production_forbids:${name}`);
    }
    for (const name of options.required ?? []) {
      if (!env[name]) failures.push(`platform.production_requires:${name}`);
    }
    for (const name of new Set([...DATABASE_URL_SETTINGS, ...(options.databaseUrls ?? [])])) {
      const value = env[name];
      if (!value) continue;
      if (connectionStringHasPassword(value)) failures.push(`platform.production_forbids_password_in:${name}`);
      if (/@(localhost|127\.0\.0\.1|\[::1\]|postgres)[:/]/.test(value) || /^postgres(?:ql)?:\/\/(localhost|127\.0\.0\.1|postgres)[:/]/.test(value)) {
        failures.push(`platform.production_forbids_local_host_in:${name}`);
      }
    }
  }
  if (failures.length) throw new PlatformConfigError(failures.join("; "));
}

/**
 * Whether a plain-http or loopback endpoint is acceptable. Development allows it so a
 * local stack can run without certificates; production requires https.
 */
export function allowsInsecureEndpoints(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isProductionProfile(env);
}
