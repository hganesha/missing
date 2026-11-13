const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pin the directory to a tenant-specific, verified Entra issuer. */
export function entraTenantFromIssuer(issuer: string): string | null {
  const id = /^https:\/\/login\.microsoftonline\.com\/([0-9a-f-]{36})\/v2\.0$/i.exec(issuer)?.[1];
  return id && GUID.test(id) ? id.toLowerCase() : null;
}
export function entraDirectorySubject(tenantId: string, objectId: string): string {
  if (!GUID.test(tenantId) || !GUID.test(objectId)) throw new Error("identity.entra_object_invalid");
  return `entra:${tenantId.toLowerCase()}:${objectId.toLowerCase()}`;
}
