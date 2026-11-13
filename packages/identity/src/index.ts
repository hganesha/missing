export {
  actionsForRoles,
  HUMAN_ROLES,
  AuthorizationError,
  createAuthorizer,
  evaluate,
  type AuthorizationDecision,
  type Authorizer,
  type HumanRole,
  type PlatformAction,
  type Principal,
  type ResourceRef,
  type WorkloadRole,
} from "./authorization.js";
export { browserOidcClient } from "./browser-oidc.js";
export { supportsS256Pkce } from "./oidc-discovery.js";
export {
  OidcJwtPrincipalResolver,
  LocalHeaderPrincipalResolver,
  tryResolve,
  type OidcResolverOptions,
  type PrincipalResolver,
  type RequestLike,
} from "./principal.js";
export {
  allowsInsecureEndpoints,
  assertNoPlatformMode,
  assertPlatformInvariants,
  connectionStringHasPassword,
  databaseAuth,
  DATABASE_AUTH_MODES,
  ENVELOPE_SIGNERS,
  ENVELOPE_VERIFIERS,
  envelopeSigner,
  envelopeVerifier,
  IDENTITY_PROVIDERS,
  identityProvider,
  isProductionProfile,
  mechanism,
  MECHANISM_REQUIREMENTS,
  PLATFORM_MODE_REPLACEMENTS,
  PlatformConfigError,
  securityProfile,
  TELEMETRY_EXPORTERS,
  telemetryExporter,
  WORKLOAD_AUTH_MODES,
  workloadAuth,
  type DatabaseAuth,
  type EnvelopeSigner,
  type EnvelopeVerifier,
  type IdentityProvider,
  type MechanismSetting,
  type SecurityProfile,
  type StartupInvariantOptions,
  type TelemetryExporter,
  type WorkloadAuth,
} from "./platform-config.js";
export { createPrincipalResolverFromEnv } from "./factory.js";
export {
  createWorkloadAuthorization,
  createWorkloadResolverFromEnv,
  createWorkloadTokenProvider,
  DelegatedPrincipalResolver,
  EDGE_DELEGATE_ROLE,
  platformTenantId,
  serviceGrants,
  ServiceTokenPrincipalResolver,
  WorkloadIdentityPrincipalResolver,
  type ServiceGrantDeclaration,
  type ServiceTokenGrant,
  type WorkloadIdentityOptions,
} from "./workload.js";
export { createGuard, type Guard, type GuardOptions } from "./fastify.js";
export { createPrivateKeyJwtSigner, createPrivateKeyJwtSignerFromEnv, type PrivateKeyJwtSigner, type SignedEnvelopeKind } from "./signer.js";
export { isSupportedSecretRef, resolveSecretRef } from "./secrets.js";
export { clientCredentialsToken, type ClientCredentials } from "./oauth2.js";
export { validateIntegrationDestination, requestIntegrationDestination, isPublicDeliveryAddress } from "./integration-destination.js";

export { entraTenantFromIssuer, entraDirectorySubject } from "./entra.js";
