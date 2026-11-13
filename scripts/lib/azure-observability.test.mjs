import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { azureTraceComponent, foundryProof, verifyFoundryPolicy } from './azure-observability.mjs';

const scope = '/subscriptions/11111111-1111-4111-8111-111111111111/resourceGroups/observability';
const component = `${scope}/providers/Microsoft.Insights/components/foundry`;
const unrelated = `${scope}/providers/Microsoft.Insights/components/unrelated`;
const workspaceId = `${scope}/providers/Microsoft.OperationalInsights/workspaces/foundry`;
const dcr = `${scope}/providers/Microsoft.Insights/dataCollectionRules/content-isolation`;
const identityId = `${scope}/providers/Microsoft.ManagedIdentity/userAssignedIdentities/trace-reader`;
const clientId = '11111111-1111-4111-8111-111111111112';
const accountId = `${scope}/providers/Microsoft.CognitiveServices/accounts/ehf-foundry`;
const projectId = `${accountId}/projects/demo`;
const binding = {
  projectEndpoint: 'https://ehf-foundry.services.ai.azure.com/api/projects/demo',
  agentName: 'probe', agentVersion: '1', applicationInsightsResourceId: component,
};
const proof = {
  ...binding, apiVersion: 'integralflow/foundry-trace-qualification-v1', tenantId: 'tenant-a',
  workspaceResourceId: workspaceId, workspaceTransformationResourceId: dcr, workspaceTransformationEtag: 'etag',
  queryIdentityId: identityId, queryIdentityClientId: clientId, traceId: '1'.repeat(32), responseId: 'resp_1',
  unrelatedApplicationInsightsResourceId: unrelated,
  checkedAt: '2026-11-12T10:00:00Z', expiresAt: '2026-11-13T10:00:00Z',
  contentProbePassed: true, protectedContentDenied: true, unrelatedComponentDenied: true,
};
const options = {
  binding, tenantId: proof.tenantId, identity: { id: identityId, properties: { clientId } }, now: Date.parse('2026-11-12T11:00:00Z'),
};

test('Foundry proof requires fresh and exact evidence from the bound BFF identity', () => {
  assert.deepEqual(foundryProof(proof, options), proof);
  assert.equal(foundryProof({ ...proof, protectedContentDenied: false }, options), null);
  assert.equal(foundryProof({ ...proof, queryIdentityClientId: '11111111-1111-4111-8111-111111111113' }, options), null);
  assert.equal(foundryProof({ ...proof, workspaceTransformationEtag: '' }, options), null);
  assert.equal(foundryProof(proof, { ...options, now: Date.parse(proof.expiresAt) }), null);
  assert.equal(foundryProof(proof, { ...options, tenantId: 'tenant-b' }), null);
  assert.equal(foundryProof(proof, { ...options, binding: { ...binding, agentVersion: '2' } }), null);
});

test('Foundry qualification fails closed when live protection or the connected resource drifts', async () => {
  const tags = { 'integralflow.telemetryPolicy': 'foundry-spans-v1' };
  const componentsPath = `${scope}/providers/Microsoft.Insights/components`;
  const componentResource = { id: component, tags, properties: { WorkspaceResourceId: workspaceId } };
  const spanPolicy = readFileSync(new URL('../../deploy/azure/foundry-trace-span-policy.kql', import.meta.url), 'utf8');
  const flows = ['AppDependencies', 'AppRequests', 'AppTraces', 'AppEvents', 'AppExceptions'].map(table => ({
    streams: [`Microsoft-Table-${table}`], destinations: ['foundryTraces'],
    transformKql: ['AppDependencies', 'AppRequests'].includes(table) ? spanPolicy : 'source | where false',
  }));
  const resources = new Map([
    [component, componentResource],
    [componentsPath, { value: [componentResource, { id: unrelated, properties: {} }] }],
    [workspaceId, { tags, properties: { defaultDataCollectionRuleResourceId: dcr, provisioningState: 'Succeeded', features: { enableLogAccessUsingOnlyResourcePermissions: true } } }],
    [dcr, { tags, kind: 'WorkspaceTransforms', etag: 'etag', properties: { provisioningState: 'Succeeded', destinations: { logAnalytics: [{ name: 'foundryTraces', workspaceResourceId: workspaceId }] }, dataFlows: flows } }],
    [`${workspaceId}/tables/AppGenAIContent`, { properties: { protectionLevel: 'Protected' } }],
    [accountId, { properties: { customSubDomainName: 'ehf-foundry' } }],
    [projectId, { properties: { provisioningState: 'Succeeded', endpoints: { 'AI Foundry API': binding.projectEndpoint } } }],
    [`${projectId}/connections`, { value: [{ properties: { category: 'AppInsights', target: component } }] }],
  ]);
  const rest = async (method, target) => {
    assert.equal(method, 'get');
    if (target.includes('/tables/')) assert.ok(target.endsWith('?api-version=2026-03-01'));
    return resources.get(target.split('?')[0]);
  };
  const platform = { properties: { WorkspaceResourceId: workspaceId + '-platform' } };
  assert.equal(await verifyFoundryPolicy(rest, scope, platform, proof), projectId);
  assert.equal(await verifyFoundryPolicy(rest, scope, platform, { ...proof, unrelatedApplicationInsightsResourceId: unrelated + '-absent' }), null);
  assert.equal(await verifyFoundryPolicy(rest, scope, { properties: { WorkspaceResourceId: workspaceId } }, proof), null);
  resources.get(componentsPath).value.push({ ...componentResource, id: component + '-shared' });
  assert.equal(await verifyFoundryPolicy(rest, scope, platform, proof), null);
  resources.get(componentsPath).value.pop();
  resources.get(dcr).properties.dataFlows.pop();
  assert.equal(await verifyFoundryPolicy(rest, scope, platform, proof), null);
  resources.get(dcr).properties.dataFlows.push({ streams: ['Microsoft-Table-AppExceptions'], destinations: ['foundryTraces'], transformKql: 'source | where false' });
  flows[0].transformKql += '\n| extend Target = "unexpected"';
  assert.equal(await verifyFoundryPolicy(rest, scope, platform, proof), null);
  flows[0].transformKql = spanPolicy;
  resources.get(dcr).etag = 'drift';
  assert.equal(await verifyFoundryPolicy(rest, scope, platform, proof), null);
  resources.get(dcr).etag = 'etag';
  resources.get(`${workspaceId}/tables/AppGenAIContent`).properties.protectionLevel = 'General';
  assert.equal(await verifyFoundryPolicy(rest, scope, platform, proof), null);
  await assert.rejects(azureTraceComponent(rest, scope, component.replace('/observability/', '/foreign/')), /scope_mismatch/);
});
