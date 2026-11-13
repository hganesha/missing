import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureEntraDirectoryPermission, MICROSOFT_GRAPH_APP_ID } from './entra-directory.mjs';
const applicationId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const resourceId = '33333333-3333-4333-8333-333333333333';
const appRoleId = 'df021288-bdef-4463-88db-98f22de89214';
const assignment = { principalId, resourceId, appRoleId };
function directory() {
  const unrelated = { resourceAppId: '44444444-4444-4444-8444-444444444444', resourceAccess: [{ id: 'existing-api-role', type: 'Role' }] };
  const delegated = { id: 'existing-delegated-scope', type: 'Scope' };
  const app = { requiredResourceAccess: [unrelated, { resourceAppId: MICROSOFT_GRAPH_APP_ID, resourceAccess: [delegated] }] };
  const assignments = []; const writes = [];
  const rest = async (method, path, body) => {
    if (method === 'GET' && path.startsWith('applications/')) return structuredClone(app);
    if (method === 'GET' && path.startsWith('servicePrincipals?')) return { value: [{ id: resourceId, appRoles: [{ id: appRoleId, value: 'User.Read.All', isEnabled: true, allowedMemberTypes: ['Application'] }] }] };
    if (method === 'GET' && path.endsWith('/appRoleAssignments')) return { value: [...assignments] };
    writes.push({ method, path, body });
    if (method === 'PATCH') Object.assign(app, body);
    if (method === 'POST') assignments.push(body);
    return {};
  };
  return { rest, writes, app, assignments, unrelated, delegated };
}
test('declares and consents to only User.Read.All, preserves existing API roles/scopes, and is idempotent', async () => {
  const d = directory();
  await ensureEntraDirectoryPermission({ ...d, applicationId, principalId, grant: true });
  assert.deepEqual(d.app.requiredResourceAccess, [d.unrelated, { resourceAppId: MICROSOFT_GRAPH_APP_ID, resourceAccess: [d.delegated, { id: appRoleId, type: 'Role' }] }]);
  assert.deepEqual(d.assignments, [assignment]);
  assert.equal(d.writes[1].path, `servicePrincipals/${resourceId}/appRoleAssignedTo`);
  await ensureEntraDirectoryPermission({ ...d, applicationId, principalId, grant: true });
  assert.equal(d.writes.length, 2);
});
test('existing/manual verification needs the actual consent grant and never writes', async () => {
  const d = directory();
  d.app.requiredResourceAccess[1].resourceAccess.push({ id: appRoleId, type: 'Role' });
  await assert.rejects(ensureEntraDirectoryPermission({ ...d, applicationId, principalId }), /directory_permission_required/);
  assert.equal(d.writes.length, 0);
  d.assignments.push(assignment);
  await ensureEntraDirectoryPermission({ ...d, applicationId, principalId });
  assert.equal(d.writes.length, 0);
});
test('checks paginated grants without creating a duplicate assignment', async () => {
  const d = directory(); const base = d.rest;
  d.rest = async (method, path, body) => path.endsWith('/appRoleAssignments')
    ? { value: [], '@odata.nextLink': `https://graph.microsoft.com/v1.0/servicePrincipals/${principalId}/appRoleAssignments?$skiptoken=next` }
    : path.includes('$skiptoken=') ? { value: [assignment] } : base(method, path, body);
  await ensureEntraDirectoryPermission({ ...d, applicationId, principalId, grant: true });
  assert.equal(d.writes.filter(item => item.method === 'POST').length, 0);
});
test('rejects provider pagination outside the exact grant collection', async () => {
  for (const next of ['https://untrusted.example/steal-token', 'https://graph.microsoft.com/v1.0/users']) {
    const d = directory(); const base = d.rest;
    d.rest = async (method, path, body) => path.endsWith('/appRoleAssignments') ? { value: [], '@odata.nextLink': next } : base(method, path, body);
    await assert.rejects(ensureEntraDirectoryPermission({ ...d, applicationId, principalId, grant: true }), /directory_permission_response_invalid/);
    assert.equal(d.writes.filter(item => item.method === 'POST').length, 0);
  }
});
test('consent denial stops the deployment rather than claiming directory readiness', async () => {
  const d = directory(); const base = d.rest;
  d.rest = async (method, path, body) => { if (method === 'POST') throw new Error('permission_required'); return base(method, path, body); };
  await assert.rejects(ensureEntraDirectoryPermission({ ...d, applicationId, principalId, grant: true }), /permission_required/);
  assert.equal(d.assignments.length, 0);
});
