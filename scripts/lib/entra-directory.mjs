export const MICROSOFT_GRAPH_APP_ID = '00000003-0000-0000-c000-000000000000';
const GRAPH = 'https://graph.microsoft.com/v1.0/';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Configure only User.Read.All on the human sign-in app, preserving other permissions.
 * rest accepts Graph-relative paths and returns parsed JSON. Verification never writes.
 */
export async function ensureEntraDirectoryPermission({ rest, applicationId, principalId, grant = false }) {
  if (!GUID.test(applicationId) || !GUID.test(principalId)) throw new Error('directory_application_invalid');
  const app = await rest('GET', `applications/${applicationId}?$select=requiredResourceAccess`);
  const graph = await rest('GET', `servicePrincipals?$filter=${encodeURIComponent(`appId eq '${MICROSOFT_GRAPH_APP_ID}'`)}&$select=id,appRoles`);
  const resource = graph.value?.length === 1 ? graph.value[0] : undefined;
  const role = resource?.appRoles?.find(item => item.value === 'User.Read.All' && item.isEnabled && item.allowedMemberTypes?.includes('Application'));
  if (!GUID.test(resource?.id ?? '') || !GUID.test(role?.id ?? '')) throw new Error('directory_permission_unavailable');
  const existing = app.requiredResourceAccess ?? [];
  const declared = existing.some(item => item.resourceAppId === MICROSOFT_GRAPH_APP_ID && item.resourceAccess.some(access => access.id === role.id && access.type === 'Role'));
  if (!declared && grant) {
    const requiredResourceAccess = existing.some(item => item.resourceAppId === MICROSOFT_GRAPH_APP_ID)
      ? existing.map(item => item.resourceAppId === MICROSOFT_GRAPH_APP_ID ? { ...item, resourceAccess: [...item.resourceAccess, { id: role.id, type: 'Role' }] } : item)
      : [...existing, { resourceAppId: MICROSOFT_GRAPH_APP_ID, resourceAccess: [{ id: role.id, type: 'Role' }] }];
    await rest('PATCH', `applications/${applicationId}`, { requiredResourceAccess });
  }
  let path = `servicePrincipals/${principalId}/appRoleAssignments`;
  const visited = new Set();
  let consented = false;
  while (path) {
    if (visited.has(path) || visited.size >= 100) throw new Error('directory_permission_response_invalid');
    visited.add(path);
    const result = await rest('GET', path);
    if (!Array.isArray(result.value)) throw new Error('directory_permission_response_invalid');
    if (result.value.some(item => item.principalId === principalId && item.resourceId === resource.id && item.appRoleId === role.id)) { consented = true; break; }
    const next = result['@odata.nextLink'];
    if (!next) break;
    // Never send operator credentials to a URL supplied outside this exact collection.
    const url = new URL(next);
    if (url.origin !== 'https://graph.microsoft.com' || url.pathname !== `/v1.0/servicePrincipals/${principalId}/appRoleAssignments` || url.username || url.password || url.hash) throw new Error('directory_permission_response_invalid');
    path = url.href.slice(GRAPH.length);
  }
  if (!consented && grant) await rest('POST', `servicePrincipals/${resource.id}/appRoleAssignedTo`, { principalId, resourceId: resource.id, appRoleId: role.id });
  if (!grant && (!declared || !consented)) throw new Error('directory_permission_required');
}
