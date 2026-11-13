import type {
  ContextBinding,
  ContextConnection,
  ContextField,
} from "@ehf/contracts";
import type { ConnectionAuthentication } from "tedious";
import type { ConnectorRuntime } from "./index.js";
import { contextReadQuery } from "./query.js";

const error = (code: string) => new Error(`context_source.${code}`);
const providerError = (cause: unknown, fallback: string) =>
  error(
    cause &&
      typeof cause === "object" &&
      "code" in cause &&
      cause.code === "ETIMEOUT"
      ? "timeout"
      : fallback,
  );
const MAX_BYTES = 2 * 1024 * 1024;
const EXACT_NUMERIC_TYPES = new Set([
  "bigint",
  "decimal",
  "numeric",
  "money",
  "smallmoney",
]);

function authentication(
  connection: ContextConnection,
  secret: string,
): ConnectionAuthentication {
  if (
    connection.provider === "fabric" ||
    connection.sqlServerAuth === "entra_token"
  )
    return {
      type: "azure-active-directory-access-token",
      options: { token: secret },
    };
  // SQL authentication is explicit. A failed login never falls back to another identity.
  if (connection.identityMode === "delegated")
    throw error("delegation_unavailable");
  try {
    const value: unknown = JSON.parse(secret);
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      !("username" in value) ||
      typeof value.username !== "string" ||
      !value.username.trim() ||
      !("password" in value) ||
      typeof value.password !== "string" ||
      !value.password
    )
      throw error("credential_invalid");
    return {
      type: "default",
      options: { userName: value.username, password: value.password },
    };
  } catch {
    throw error("credential_invalid");
  }
}

/** Shared wire transport, with distinct Fabric and SQL Server provider/auth contracts.
 * Only generated, scoped SELECTs reach TDS; credentials and provider diagnostics never
 * enter returned data. ReadOnlyIntent is a routing hint, not a database permission. */
export async function readTdsContext(
  connection: ContextConnection,
  binding: ContextBinding,
  values: Record<string, unknown>,
  runtime: ConnectorRuntime,
  secret: string,
  discover: boolean,
): Promise<{ rows: Record<string, unknown>[]; fields: ContextField[] }> {
  const url = new URL(connection.endpoint);
  if (
    url.protocol !== "tds:" ||
    url.pathname !== `/${connection.resource.database}`
  )
    throw error("database_scope_denied");
  const auth = authentication(connection, secret);
  // Reject invalid statements/parameters before opening a socket, including discovery.
  contextReadQuery(connection, binding, values);
  runtime.signal?.throwIfAborted();
  await runtime.checkTransport(url);
  runtime.signal?.throwIfAborted();
  const { Connection, Request, TYPES } = await import("tedious");
  runtime.signal?.throwIfAborted();
  const client = new Connection({
    server: url.hostname,
    authentication: auth,
    options: {
      port: Number(url.port || 1433),
      database: connection.resource.database,
      encrypt: true,
      trustServerCertificate: false,
      cryptoCredentialsDetails: {
        minVersion: "TLSv1.2",
        ...(runtime.env.CONTEXT_SOURCE_CA_PEM
          ? { ca: runtime.env.CONTEXT_SOURCE_CA_PEM }
          : {}),
      },
      readOnlyIntent: true,
      useUTC: true,
      connectTimeout: binding.timeoutMs,
      requestTimeout: binding.timeoutMs,
      rowCollectionOnRequestCompletion: false,
    },
  });
  let failActive: ((cause: Error) => void) | undefined;
  let connectionFailure: Error | undefined;
  let closing = false;
  const close = () => {
    if (!closing) {
      closing = true;
      client.close();
    }
  };
  const abort = () => {
    failActive?.(error("timeout"));
    close();
  };
  // Keep an error listener through close: late driver errors must not become unhandled
  // EventEmitter errors, or leak source diagnostics after an operation has settled.
  client.on("error", (cause) => {
    connectionFailure = providerError(cause, "connection_failed");
    failActive?.(connectionFailure);
  });
  client.on("end", () => {
    connectionFailure ??= error("connection_failed");
    failActive?.(connectionFailure);
  });
  runtime.signal?.addEventListener("abort", abort, { once: true });
  const run = (
    text: string,
    parameters: Array<{ name: string; value: unknown }>,
    limit: number,
  ) => {
    runtime.signal?.throwIfAborted();
    if (connectionFailure) throw connectionFailure;
    return new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const rows: Record<string, unknown>[] = [];
      let bytes = 2;
      let settled = false;
      const finish = (cause?: Error) => {
        if (settled) return;
        settled = true;
        if (failActive === finish) failActive = undefined;
        if (cause) reject(cause);
        else resolve(rows);
      };
      failActive = finish;
      try {
        const request = new Request(text, (cause) =>
          finish(cause ? providerError(cause, "query_failed") : undefined),
        );
        // A named parameter can appear in several predicates; bind it once.
        for (const p of new Map(parameters.map((p) => [p.name, p])).values())
          request.addParameter(
            p.name,
            typeof p.value === "number"
              ? TYPES.Float
              : typeof p.value === "boolean"
                ? TYPES.Bit
                : TYPES.NVarChar,
            p.value,
          );
        request.on("row", (columns) => {
          if (settled) return;
          try {
            const row = Object.fromEntries(
              columns.map(
                (c: { metadata: { colName: string }; value: unknown }) => [
                  c.metadata.colName,
                  c.value,
                ],
              ),
            );
            bytes += Buffer.byteLength(JSON.stringify(row)) + 1;
            if (rows.length >= limit || bytes > MAX_BYTES) {
              finish(error("response_too_large"));
              request.cancel();
              return;
            }
            rows.push(row);
          } catch {
            finish(error("response_invalid"));
            request.cancel();
          }
        });
        client.execSql(request);
      } catch {
        finish(error("query_failed"));
      }
    });
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (cause?: Error) => {
        if (settled) return;
        settled = true;
        if (failActive === finish) failActive = undefined;
        if (cause) reject(cause);
        else resolve();
      };
      failActive = finish;
      client.once("connect", (cause) =>
        finish(cause ? providerError(cause, "connection_failed") : undefined),
      );
      if (runtime.signal?.aborted) abort();
      else client.connect();
    });
    const metadata = await run(
      "SELECT COLUMN_NAME AS name,DATA_TYPE AS type,IS_NULLABLE AS nullable FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_CATALOG=@database AND TABLE_SCHEMA=@schema AND TABLE_NAME=@object ORDER BY ORDINAL_POSITION",
      Object.entries({
        database: connection.resource.database,
        schema: connection.resource.schema,
        object: connection.resource.object,
      }).map(([name, value]) => ({ name, value })),
      501,
    );
    if (!metadata.length) throw error("resource_not_found");
    if (metadata.length > 500) throw error("schema_invalid");
    const fields = metadata.map((row) => ({
      name: String(row.name),
      type: String(row.type),
      nullable: row.nullable === "YES",
    }));
    if (
      fields.some((f) => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(f.name)) ||
      new Set(fields.map((f) => f.name)).size !== fields.length
    )
      throw error("schema_invalid");
    const query = contextReadQuery(
      connection,
      binding,
      values,
      connection.provider === "sqlserver"
        ? {
            // Preserve exact values before the driver can coerce DECIMAL/MONEY to JS Number.
            exactNumericColumns: new Set(
              fields
                .filter((f) => EXACT_NUMERIC_TYPES.has(f.type.toLowerCase()))
                .map((f) => f.name),
            ),
            knownColumns: new Set(fields.map((f) => f.name)),
          }
        : {},
    );
    return {
      rows: discover
        ? []
        : await run(query.text, query.named, binding.maximumRows + 1),
      fields,
    };
  } finally {
    runtime.signal?.removeEventListener("abort", abort);
    close();
  }
}
