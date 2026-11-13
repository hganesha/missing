import pg from "pg";
import {
  stableDigest,
  type PostgresContextConnection as ContextSetupConnection,
  type PostgresContextResource as ContextResourceBinding,
} from "@ehf/contracts";
import { ContextSetupError } from "@ehf/contracts";
const quote = (s: string) => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(s))
    throw new ContextSetupError("context.resource_invalid");
  return `"${s}"`;
};
export function assertResourceScope(
  connection: ContextSetupConnection,
  resource: ContextResourceBinding,
) {
  const allowed = connection.resources.find(
    (r) => r.schema === resource.schema && r.table === resource.table,
  );
  if (
    !allowed ||
    !resource.columns.every((c) => allowed.columns.includes(c)) ||
    !resource.columns.includes(resource.subjectColumn) ||
    !resource.columns.includes(resource.observedAtColumn)
  )
    throw new ContextSetupError("context.resource_scope_denied", 403);
}
/** Credentials are operator-mounted, tenant-qualified references; browser input cannot select a DSN. */
export function contextSourceCredential(
  connection: ContextSetupConnection,
  tenantId: string,
  env: NodeJS.ProcessEnv,
) {
  const configured = env[connection.credentialRef];
  if (!configured)
    throw new ContextSetupError("context.credential_missing", 503);
  let secret: {
    tenantId?: string;
    generation?: string;
    connectionString?: string;
    connectorId?: string;
  };
  try {
    secret = JSON.parse(configured);
    if (
      !secret ||
      typeof secret !== "object" ||
      typeof secret.connectionString !== "string" ||
      secret.connectionString.length > 16384
    )
      throw new Error();
    const url = new URL(secret.connectionString);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname)
      throw new Error();
    if (
      [...url.searchParams.keys()].some(
        (k) => !["sslmode", "sslcert", "sslkey", "sslrootcert"].includes(k),
      )
    )
      throw new Error();
  } catch {
    throw new ContextSetupError("context.credential_invalid", 503);
  }
  if (
    secret.tenantId !== tenantId ||
    secret.generation !== connection.credentialGeneration ||
    secret.connectorId !== connection.connectorId ||
    !secret.connectionString
  )
    throw new ContextSetupError("context.credential_scope_denied", 403);
  return secret.connectionString;
}
export async function withContextPostgres<T>(
  connection: ContextSetupConnection,
  tenantId: string,
  env: NodeJS.ProcessEnv,
  operation: (c: pg.Client) => Promise<T>,
) {
  const client = new pg.Client({
    connectionString: contextSourceCredential(connection, tenantId, env),
    connectionTimeoutMillis: 3000,
    query_timeout: 5000,
    statement_timeout: 3000,
    application_name: "integralflow-context-sample",
  });
  try {
    await client.connect();
    await client.query("begin read only");
    await client.query("set local statement_timeout='3s'");
    await client.query("set local lock_timeout='1s'");
    const result = await operation(client);
    await client.query("rollback");
    return result;
  } catch (e) {
    if (e instanceof ContextSetupError) throw e;
    throw new ContextSetupError("context.source_unavailable", 503);
  } finally {
    await client.end().catch(() => undefined);
  }
}
async function schemaOnClient(
  client: pg.Client,
  resource: ContextResourceBinding,
) {
  const result = await client.query<{
    column_name: string;
    data_type: string;
    is_nullable: string;
  }>(
    "select column_name,data_type,is_nullable from information_schema.columns where table_schema=$1 and table_name=$2 order by ordinal_position",
    [resource.schema, resource.table],
  );
  const columns = result.rows.filter((c) =>
    resource.columns.includes(c.column_name),
  );
  if (columns.length !== new Set(resource.columns).size)
    throw new ContextSetupError("context.source_schema_changed", 409);
  return { columns, fingerprint: stableDigest(columns) };
}
export async function discoverContextResource(
  connection: ContextSetupConnection,
  resource: ContextResourceBinding,
  tenantId: string,
  env: NodeJS.ProcessEnv,
) {
  assertResourceScope(connection, resource);
  return withContextPostgres(connection, tenantId, env, (client) =>
    schemaOnClient(client, resource),
  );
}
export async function fetchContextSample(
  connection: ContextSetupConnection,
  resource: ContextResourceBinding,
  subjects: string[],
  tenantId: string,
  env: NodeJS.ProcessEnv,
) {
  assertResourceScope(connection, resource);
  if (!subjects.length || subjects.length > 20)
    throw new ContextSetupError("context.subject_limit");
  return withContextPostgres(connection, tenantId, env, async (client) => {
    const table = `${quote(resource.schema)}.${quote(resource.table)}`;
    // Keep discovery and read under one table lock; DDL cannot change the tested shape between them.
    await client.query(`lock table ${table} in access share mode`);
    const schema = await schemaOnClient(client, resource);
    if (schema.fingerprint !== resource.schemaFingerprint)
      throw new ContextSetupError("context.source_schema_changed", 409);
    const columns = resource.columns
      .map((name) => {
        const type = schema.columns.find(
          (c) => c.column_name === name,
        )!.data_type;
        return ["numeric", "bigint"].includes(type)
          ? `${quote(name)}::text as ${quote(name)}`
          : quote(name);
      })
      .join(",");
    // Values are bound and large individual rows never cross the wire. Decimal/bigint fields retain exact strings.
    const sql = `with sampled as materialized (select ${columns} from ${table} where ${quote(resource.subjectColumn)}::text = any($1::text[]) order by ${quote(resource.subjectColumn)},${quote(resource.observedAtColumn)} limit $2) select case when octet_length(row_to_json(sampled)::text) <= $3 then row_to_json(sampled)::text else null end as payload, octet_length(row_to_json(sampled)::text) as bytes from sampled`;
    const result = await client.query<{
      payload: string | null;
      bytes: number;
    }>(sql, [subjects, resource.maxRows + 1, 512000]);
    if (
      result.rows.some((r) => r.payload === null) ||
      result.rows.reduce((n, r) => n + Number(r.bytes), 0) > 512000
    )
      throw new ContextSetupError("context.sample_byte_limit", 413);
    const rows = result.rows.map(
      (r) => JSON.parse(r.payload!) as Record<string, unknown>,
    );
    return {
      rows: rows.slice(0, resource.maxRows),
      truncated: rows.length > resource.maxRows,
      fingerprint: schema.fingerprint,
    };
  });
}

/** A native database connection still has an approved network destination. */
export function assertContextSourceDestination(
  connection: ContextSetupConnection,
  tenantId: string,
  env: NodeJS.ProcessEnv,
  binding: { transport: string; approvedEndpoints: string[] },
) {
  const url = new URL(contextSourceCredential(connection, tenantId, env));
  if (!["postgres:", "postgresql:"].includes(url.protocol))
    throw new ContextSetupError("context.source_protocol_denied", 403);
  url.protocol = "postgresql:";
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  if (binding.transport === "local") {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      throw new ContextSetupError("context.source_destination_denied", 403);
  } else if (
    !binding.approvedEndpoints.some(
      (endpoint) => new URL(endpoint).href === url.href,
    )
  )
    throw new ContextSetupError("context.source_destination_denied", 403);
}
