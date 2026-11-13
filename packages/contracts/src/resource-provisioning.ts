import { z } from "zod";
import type { DeploymentProfile } from "./deployment.js";

export const RESOURCE_KINDS = ["keyVault", "postgres", "managedIdentities", "evidence", "foundry", "documents", "telemetry", "oidc"] as const;
export type ResourceKind = typeof RESOURCE_KINDS[number];
export const RESOURCE_LABELS: Record<ResourceKind, string> = { keyVault: "Key Vault", postgres: "PostgreSQL", managedIdentities: "Managed identities and workload access", evidence: "ADLS evidence store", foundry: "Azure Foundry", documents: "Document Intelligence", telemetry: "Observability", oidc: "Administrator sign-in (Entra OIDC)" };
const uuid = z.string().uuid();
export const resourceConfigurationSchema = z.object({
  recipe: z.literal("azure-resources-v1"),
  resources: z.record(z.enum(RESOURCE_KINDS), z.object({ mode: z.enum(["create", "existing", "manual"]), resourceId: z.string().max(1000).default("") }).strict()),
  tenantId: z.union([uuid, z.literal("")]),
  administratorObjectId: z.union([uuid, z.literal("")]),
  retentionDays: z.number().int().min(1).max(36500),
  acknowledgeRetentionLock: z.boolean(),
  allowAzureDatabaseAccess: z.boolean(),
  monthlyLimitUsd: z.number().positive().max(1000000),
  modelVersion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  modelCapacity: z.number().int().min(1).max(1000),
}).strict();
export type ResourceConfiguration = z.infer<typeof resourceConfigurationSchema>;
export type ResourceOutput = { documentAccountId?: string | undefined; resourceId?: string | undefined; endpoint?: string | undefined; hostname?: string | undefined; clientId?: string | undefined; credentialRef?: string | undefined; container?: string | undefined; vaultUri?: string | undefined; applicationInsightsResourceId?: string | undefined };
export const RESOURCE_FAILURES = {
  directory_permission_required: "The sign-in app needs Microsoft Graph User.Read.All (Application) with administrator consent. Grant it in Entra, then retry verification. Existing/manual app permissions are not changed automatically.",
  directory_assignment_required: "Disable User assignment required on the sign-in enterprise app so imported users can sign in. The platform directory enforces their saved roles. Existing/manual apps are not changed automatically.",
  permission_required: "The executor needs Azure or Microsoft Graph permission. Follow this resource's instructions, grant the reviewed permission, then retry.",
  quota_required: "Azure model quota or regional capacity is unavailable. Adjust the model, region or requested capacity before retrying.",
  resource_ownership_mismatch: "A resource with the planned name belongs to another environment. Select it explicitly as existing or use a separate bootstrap.",
  existing_resource_id_required: "Enter the Azure resource ID (or OIDC client ID) for this existing/manual selection.",
  existing_profile_binding_required: "Fill the existing connection details and credential reference in the wizard before verifying.",
  vault_configuration_incompatible: "Use an RBAC vault with purge protection in the selected tenant.",
  evidence_configuration_incompatible: "Evidence storage requires hierarchical namespace, a locked retention policy and its credential reference.",
  locked_retention_mismatch: "The existing locked retention interval differs from this review. It cannot be shortened or unlocked.",
  runtime_token_policy_incompatible: "The runtime audience needs its own 10-minute token policy; organization-wide policies are not changed.",
  model_deployment_configuration_changed: "An existing owned model deployment differs from this review. Review it explicitly instead of silently replacing it.",
  curated_model_required: "Select a curated Foundry model for every tier in Intelligence.",
  pinned_dependency_image_required: "Bootstrap must supply a pinned dependency image for automatic creation.",
  telemetry_collector_required: "Select the bootstrap Collector or enter an approved internal OTLP endpoint for an existing Collector.",
  telemetry_component_incompatible: "Use a workspace-based Application Insights component with resource-context permissions in the selected resource group.",
  telemetry_authenticated_collector_required: "Local ingestion is disabled. Connect an operator-managed Collector with Entra-authenticated ingestion.",
  resource_type_or_scope_mismatch: "The supplied resource ID has the wrong resource type or lies outside the bootstrap group.",
  document_account_incompatible: "Use a provisioned Azure Document Intelligence account with a custom subdomain.",
  existing_resource_not_ready: "The existing Azure resource is not ready yet. Inspect it in Azure before retrying.",
  azure_operation_failed: "Azure could not finish this operation. Inspect the resource group deployment/activity log, then retry. Resources are retained.",
} as const;
export type ResourceProgress = { kind: ResourceKind; status: "queued" | "running" | "passed" | "failed" | "waiting"; message: string; updatedAt: string; code?: keyof typeof RESOURCE_FAILURES | undefined; output?: ResourceOutput | undefined };
export type ResourceRunView = { id: string; phase: "queued" | "running" | "succeeded" | "failed"; createdAt: string; updatedAt: string; leaseExpired?: boolean; resources: ResourceProgress[] };
export type ResourceSetupView = { enabled: boolean; executorSeenAt?: string | null; executor: "cloud" | "operator"; configuration: ResourceConfiguration | null; run: ResourceRunView | null; revision: number; planHash: string; vaultUri: string | null; tenantId: string | null; inventory: Partial<Record<ResourceKind, ResourceOutput>> };
export function defaultResourceConfiguration(tenantId: string, administratorObjectId: string): ResourceConfiguration {
  return { recipe: "azure-resources-v1", tenantId, administratorObjectId, resources: Object.fromEntries(RESOURCE_KINDS.map(kind => [kind, { mode: kind === "telemetry" ? "create" : "existing", resourceId: "" }])) as ResourceConfiguration["resources"], retentionDays: 1, acknowledgeRetentionLock: false, allowAzureDatabaseAccess: false, monthlyLimitUsd: 25, modelVersion: "2025-04-14", modelCapacity: 10 };
}
/** Only typed, non-secret outputs can change the saved application configuration. */
export function bindResourceOutput(profile: DeploymentProfile, kind: ResourceKind, output: ResourceOutput) {
  if (kind === "postgres" && output.hostname) profile.foundation.database = { host: output.hostname, port: 5432, credentialRef: output.credentialRef ?? profile.foundation.database.credentialRef };
  if (kind === "evidence" && output.endpoint && output.container) profile.foundation.objectStore = { provider: "adls_gen2", endpoint: output.endpoint, bucket: output.container, credentialRef: output.credentialRef ?? profile.foundation.objectStore.credentialRef };
  if (kind === "foundry" && output.endpoint) profile.intelligence = { ...profile.intelligence, provider: "azure_foundry", endpoint: output.endpoint, credentialRef: output.credentialRef ?? profile.intelligence.credentialRef, deployments: Object.fromEntries(["low", "med", "high", "xhigh"].map(tier => [tier, `${profile.environmentId}-${tier}`])) };
  if (kind === "documents" && output.documentAccountId && profile.intelligence.documentServices?.azure) {
    profile.intelligence.documentServices.azure.resourceId = output.documentAccountId;
  }
  if (kind === "documents" && output.endpoint && output.credentialRef) profile.intelligence.documentIntelligence = { endpoint: output.endpoint, credentialRef: output.credentialRef };
  if (kind === "telemetry" && output.endpoint) {
    profile.foundation.telemetryEndpoint = output.endpoint;
    if (output.applicationInsightsResourceId) {
      const previous = profile.foundation.observability;
      profile.foundation.observability = {
        ...(previous?.backend === "azure_monitor" ? previous : { backend: "azure_monitor" }),
        applicationInsightsResourceId: output.applicationInsightsResourceId,
      };
    }
  }
  if (kind === "oidc" && output.endpoint && output.clientId) profile.access = { issuer: output.endpoint, clientId: output.clientId, clientSecretRef: output.credentialRef ?? profile.access.clientSecretRef, rolesClaim: "roles", mappings: [{ group: "Platform.Admin", role: "Platform.Admin" }] };
}
