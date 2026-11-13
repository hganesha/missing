import { readFileSync } from 'node:fs';
import { applicationInsightsResourceId, foundryTraceQualificationSchema, secureEndpoint } from '../../packages/contracts/src/deployment.ts';

export const traceRoleId = '73c42c96-874c-492b-b04d-ab87d138a893'; // Log Analytics Reader
export const foundryAgentRoleId = '53ca6127-db72-4b80-b1b0-d745d6d5456d'; // Azure AI User
const sameId = (left, right) => typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
const days = 86_400_000;
const spanPolicy = readFileSync(new URL('../../deploy/azure/foundry-trace-span-policy.kql', import.meta.url), 'utf8').trim();

export function traceComponentInScope(scope, id) {
  return applicationInsightsResourceId.safeParse(id).success
    && !id.split('/').some(segment => segment === '.' || segment === '..')
    && id.toLowerCase().startsWith(`${scope.toLowerCase()}/providers/microsoft.insights/components/`);
}

export async function azureTraceComponent(rest, scope, id) {
  if (!traceComponentInScope(scope, id)) throw new Error('resource_type_or_scope_mismatch');
  const insights = await rest('get', `${id}?api-version=2020-02-02`);
  const workspaceId = insights.properties?.WorkspaceResourceId;
  const workspacePrefix = `${scope.toLowerCase()}/providers/microsoft.operationalinsights/workspaces/`;
  if (typeof workspaceId !== 'string' || !workspaceId.toLowerCase().startsWith(workspacePrefix)
    || !/^[a-z0-9-]{1,63}$/i.test(workspaceId.slice(workspacePrefix.length))) throw new Error('telemetry_component_incompatible');
  const workspace = await rest('get', `${workspaceId}?api-version=2023-09-01`);
  if (workspace.properties?.provisioningState !== 'Succeeded' || workspace.properties.features?.enableLogAccessUsingOnlyResourcePermissions !== true) throw new Error('telemetry_component_incompatible');
  return { insights, workspace };
}

export function foundryProof(rawProof, { binding, tenantId, identity, now = Date.now() }) {
  if (!binding?.projectEndpoint || !binding.agentName || !binding.agentVersion || !binding.applicationInsightsResourceId || !identity) return null;
  const proof = foundryTraceQualificationSchema.safeParse(rawProof);
  if (!proof.success) return null;
  const receipt = proof.data;
  const checkedAt = Date.parse(receipt.checkedAt);
  const expiresAt = Date.parse(receipt.expiresAt);
  if (checkedAt > now || expiresAt <= now || expiresAt - checkedAt > 14 * days
    || receipt.tenantId !== tenantId || receipt.projectEndpoint !== binding.projectEndpoint
    || receipt.agentName !== binding.agentName || receipt.agentVersion !== binding.agentVersion
    || !sameId(receipt.applicationInsightsResourceId, binding.applicationInsightsResourceId)
    || !sameId(receipt.queryIdentityId, identity.id) || !sameId(receipt.queryIdentityClientId, identity.properties?.clientId)) return null;
  return receipt;
}

export async function verifyFoundryPolicy(rest, scope, platformComponent, proof) {
  if (!proof || sameId(platformComponent.properties.WorkspaceResourceId, proof.workspaceResourceId)) return null;
  if (!traceComponentInScope(scope, proof.unrelatedApplicationInsightsResourceId)
    || sameId(proof.unrelatedApplicationInsightsResourceId, proof.applicationInsightsResourceId)
    || sameId(proof.unrelatedApplicationInsightsResourceId, platformComponent.id)) return null;
  const { insights, workspace } = await azureTraceComponent(rest, scope, proof.applicationInsightsResourceId);
  const transformId = workspace.properties?.defaultDataCollectionRuleResourceId ?? workspace.properties?.defaultDataCollectionRuleId;
  if (!sameId(insights.properties.WorkspaceResourceId, proof.workspaceResourceId) || !sameId(transformId, proof.workspaceTransformationResourceId)) return null;
  if (!proof.workspaceTransformationResourceId.toLowerCase().startsWith(`${scope.toLowerCase()}/providers/microsoft.insights/datacollectionrules/`)) return null;
  const components = await rest('get', `${scope}/providers/Microsoft.Insights/components?api-version=2020-02-02`);
  const sharing = components.value?.filter(item => sameId(item.properties?.WorkspaceResourceId, proof.workspaceResourceId)) ?? [];
  if (components.nextLink || sharing.length !== 1 || !sameId(sharing[0].id, proof.applicationInsightsResourceId)
    || !components.value?.some(item => sameId(item.id, proof.unrelatedApplicationInsightsResourceId))) return null;
  const transform = await rest('get', `${proof.workspaceTransformationResourceId}?api-version=2023-03-11`);
  const policyTag = 'integralflow.telemetryPolicy';
  if ([insights, workspace, transform].some(resource => resource.tags?.[policyTag] !== 'foundry-spans-v1')) return null;
  const [destination] = transform.properties?.destinations?.logAnalytics ?? [];
  if (transform.etag !== proof.workspaceTransformationEtag || transform.kind !== 'WorkspaceTransforms'
    || transform.properties?.provisioningState !== 'Succeeded'
    || transform.properties?.destinations?.logAnalytics?.length !== 1 || !sameId(destination.workspaceResourceId, proof.workspaceResourceId)) return null;
  const flows = transform.properties?.dataFlows;
  const tables = ['AppDependencies', 'AppRequests', 'AppTraces', 'AppEvents', 'AppExceptions'];
  if (!Array.isArray(flows) || flows.length !== tables.length) return null;
  for (const table of tables) {
    const [flow, duplicate] = flows.filter(item => item.streams?.length === 1 && item.streams[0] === `Microsoft-Table-${table}`);
    if (!flow || duplicate || flow.destinations?.length !== 1 || flow.destinations[0] !== destination.name) return null;
    const query = flow.transformKql?.trim();
    const spanTable = table === 'AppDependencies' || table === 'AppRequests';
    if (query !== (spanTable ? spanPolicy : 'source | where false')) return null;
  }
  const contentTable = await rest('get', `${proof.workspaceResourceId}/tables/AppGenAIContent?api-version=2026-03-01`);
  if (contentTable.properties?.protectionLevel !== 'Protected') return null;
  const endpoint = new URL(proof.projectEndpoint);
  const account = endpoint.hostname.split('.')[0];
  const accountId = `${scope}/providers/Microsoft.CognitiveServices/accounts/${account}`;
  const projectId = accountId + endpoint.pathname.replace(/^\/api/, '');
  const project = await rest('get', `${projectId}?api-version=2025-06-01`);
  if (project.properties?.provisioningState !== 'Succeeded' || project.properties?.endpoints?.['AI Foundry API']?.replace(/\/$/, '') !== proof.projectEndpoint) return null;
  const accountResource = await rest('get', `${accountId}?api-version=2025-06-01`);
  if (accountResource.properties?.customSubDomainName !== account) return null;
  const result = await rest('get', `${projectId}/connections?api-version=2025-06-01`);
  const connections = result.value?.filter(item => item.properties?.category === 'AppInsights') ?? [];
  if (result.nextLink || connections.length !== 1 || !sameId(connections[0].properties.target, proof.applicationInsightsResourceId)) return null;
  return projectId;
}

export function collectorEndpointConfigured(value) {
  return secureEndpoint.safeParse(value).success;
}
