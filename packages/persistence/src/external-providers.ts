import { externalConnectionDraftSchema, externalProviderDraftSchema, type ExternalConnectionDraft, type ExternalProviderDraft } from "@ehf/contracts";
import type { Database } from "./index.js";

type Client = Pick<Database, "query">;
export type ExternalConnectionRecord = { connection: ExternalConnectionDraft; revision: number; createdAt: string; updatedAt: string; updatedBy: string };
export type ExternalProviderRecord = { provider: ExternalProviderDraft; origin: "catalog" | "custom"; createdAt: string; createdBy: string; connections: ExternalConnectionRecord[]; activity: Array<{ action: string; connectionId: string | null; revision: number | null; actor: string; at: string }> };
export class ExternalProviderError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}
async function scoped<T>(db: Database, tenantId: string, action: (client: Client) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await action(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
type ConnectionRow = { definition: unknown; revision: number; created_at: Date; updated_at: Date; updated_by: string; provider_id: string };
const connectionRecord = (row: ConnectionRow): ExternalConnectionRecord => ({ connection: externalConnectionDraftSchema.parse(row.definition), revision: row.revision, createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(), updatedBy: row.updated_by });

export async function listExternalProviders(db: Database, tenantId: string): Promise<ExternalProviderRecord[]> {
  return scoped(db, tenantId, async client => {
    const providers = await client.query<{ definition: unknown; provider_id: string; origin: "catalog" | "custom"; created_at: Date; created_by: string }>("select * from harness_admin.external_providers where tenant_id=$1 order by provider_id", [tenantId]);
    const connections = await client.query<ConnectionRow>("select * from harness_admin.external_connection_drafts where tenant_id=$1 order by provider_id, connection_id", [tenantId]);
    const events = await client.query<{ provider_id: string; action: string; connection_id: string | null; revision: number | null; actor: string; created_at: Date }>(`select * from (
      select *, row_number() over (partition by provider_id order by event_id desc) as position
      from harness_admin.external_provider_events where tenant_id=$1
    ) recent where position <= 30 order by event_id desc`, [tenantId]);
    return providers.rows.map(row => ({ provider: externalProviderDraftSchema.parse(row.definition), origin: row.origin, createdAt: row.created_at.toISOString(), createdBy: row.created_by,
      connections: connections.rows.filter(c => c.provider_id === row.provider_id).map(connectionRecord),
      activity: events.rows.filter(e => e.provider_id === row.provider_id).map(e => ({ action: e.action, connectionId: e.connection_id, revision: e.revision, actor: e.actor, at: e.created_at.toISOString() })),
    }));
  });
}

export async function createExternalProvider(db: Database, input: { tenantId: string; actor: string; provider: ExternalProviderDraft }): Promise<void> {
  const provider = externalProviderDraftSchema.parse(input.provider);
  await scoped(db, input.tenantId, async client => {
    const result = await client.query(`insert into harness_admin.external_providers(tenant_id,provider_id,definition,origin,created_by)
      values ($1,$2,$3::jsonb,'custom',$4) on conflict do nothing returning provider_id`, [input.tenantId, provider.id, JSON.stringify(provider), input.actor]);
    if (!result.rowCount) throw new ExternalProviderError("external_provider.already_exists", 409);
    await client.query("insert into harness_admin.external_provider_events(tenant_id,provider_id,action,actor) values ($1,$2,'provider.created',$3)", [input.tenantId, provider.id, input.actor]);
  });
}

export async function saveExternalConnection(db: Database, input: { tenantId: string; actor: string; providerId: string; catalogProvider: ExternalProviderDraft | null; connection: ExternalConnectionDraft; expectedRevision: number | null }): Promise<ExternalConnectionRecord> {
  const connection = externalConnectionDraftSchema.parse(input.connection);
  return scoped(db, input.tenantId, async client => {
    const restricted = await client.query("select connector_id from harness_gateway.connector_registry where provider_id=$1 and status='quarantined' limit 1", [input.providerId]);
    if (restricted.rowCount) throw new ExternalProviderError("external_provider.quarantined", 409);
    if (input.catalogProvider) await client.query(`insert into harness_admin.external_providers(tenant_id,provider_id,definition,origin,created_by)
      values ($1,$2,$3::jsonb,'catalog',$4) on conflict do nothing`, [input.tenantId, input.providerId, JSON.stringify(input.catalogProvider), input.actor]);
    const provider = await client.query("select provider_id from harness_admin.external_providers where tenant_id=$1 and provider_id=$2 for update", [input.tenantId, input.providerId]);
    if (!provider.rowCount) throw new ExternalProviderError("external_provider.not_found", 404);
    const result = input.expectedRevision === null
      ? await client.query<ConnectionRow>(`insert into harness_admin.external_connection_drafts(tenant_id,provider_id,connection_id,definition,updated_by)
          values ($1,$2,$3,$4::jsonb,$5) on conflict do nothing returning *`, [input.tenantId, input.providerId, connection.id, JSON.stringify(connection), input.actor])
      : await client.query<ConnectionRow>(`update harness_admin.external_connection_drafts set definition=$4::jsonb, updated_by=$5, updated_at=now(), revision=revision+1
          where tenant_id=$1 and provider_id=$2 and connection_id=$3 and revision=$6 returning *`, [input.tenantId, input.providerId, connection.id, JSON.stringify(connection), input.actor, input.expectedRevision]);
    const row = result.rows[0];
    if (!row) throw new ExternalProviderError("external_provider.connection_revision_conflict", 409);
    await client.query("insert into harness_admin.external_provider_events(tenant_id,provider_id,action,connection_id,revision,actor) values ($1,$2,$3,$4,$5,$6)", [input.tenantId, input.providerId, input.expectedRevision === null ? "connection.created" : "connection.updated", connection.id, row.revision, input.actor]);
    return connectionRecord(row);
  });
}
