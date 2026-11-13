import pg, { type PoolClient } from "pg";
import { databaseAuth } from "@ehf/identity";

export function createDiscoveryDatabase(env: NodeJS.ProcessEnv = process.env): pg.Pool {
  const connectionString = env.DISCOVERY_DATABASE_URL;
  if (!connectionString) throw new Error("discovery.database_url_missing");
  const databaseName = (url: string) => decodeURIComponent(new URL(url).pathname.slice(1));
  const name = databaseName(connectionString);
  if (!name || [env.DATABASE_URL, env.CASE_DATABASE_URL, env.EXECUTION_DATABASE_URL,
    env.CONTEXT_DATABASE_URL, env.DISCOVERY_CONTROL_DATABASE_URL].some(url => url && databaseName(url) === name)) {
    throw new Error("discovery.separate_database_required");
  }
  databaseAuth(env);
  return new pg.Pool({ connectionString, max: 2, connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
}

export async function withDiscoveryTenant<T>(
  db: pg.Pool, tenantId: string, work: (client: PoolClient) => Promise<T>, readOnly = false,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query(readOnly ? "begin read only" : "begin");
    await client.query("select set_config('app.tenant_id',$1,true)", [tenantId]);
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
