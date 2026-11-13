import {
  validateRecordData,
  LIBRARY_CONTEXT_SCHEMA_VERSION,
} from "@ehf/library-contracts";
import { Client } from "pg";
import { resolveSecretRef } from "@ehf/identity";
import {
  contextFieldSchema,
  stableDigest,
  type ContextConnection,
  type ContextBinding,
  type ContextField,
  type CanonicalRecordInput,
} from "@ehf/contracts";
import { contextReadQuery } from "./query.js";
import { readTdsContext } from "./tds.js";
export { contextReadQuery } from "./query.js";

export type ConnectorResult = {
  rows: Record<string, unknown>[];
  fields: ContextField[];
  truncated: boolean;
  schemaFingerprint: string;
};
export type ConnectorRuntime = {
  env: NodeJS.ProcessEnv;
  fetch: typeof globalThis.fetch;
  tenantId: string;
  signal?: AbortSignal;
  checkTransport: (endpoint: URL) => Promise<void>;
  delegatedCredential?: () => Promise<string>;
};
type Target = { endpoint: string; credentialRef: string; provider: string };
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("context_source.response_invalid");
  return value as Record<string, unknown>;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new Error("context_source.response_invalid");
  return value;
};
const fail = (code: string): never => {
  throw new Error(`context_source.${code}`);
};

/** Tenant-owned drafts cannot grant egress or read arbitrary process secrets. Deployment
 * grants exact endpoint/provider/reference tuples, including private enterprise targets. */
export function assertContextTarget(
  connection: ContextConnection,
  runtime: Pick<ConnectorRuntime, "env" | "tenantId">,
): void {
  let targets: unknown;
  try {
    targets = JSON.parse(runtime.env.CONTEXT_SOURCE_TARGETS_JSON ?? "{}");
  } catch {
    fail("target_configuration_invalid");
  }
  const grants = object(targets)[runtime.tenantId];
  if (
    !Array.isArray(grants) ||
    !grants.some((value: unknown) => {
      if (!value || typeof value !== "object") return false;
      const target = value as Target;
      return (
        target.endpoint === connection.endpoint &&
        target.credentialRef === connection.credentialRef &&
        target.provider === connection.provider
      );
    })
  )
    fail("target_not_approved");
}
async function credential(
  connection: ContextConnection,
  runtime: ConnectorRuntime,
): Promise<string> {
  if (connection.identityMode === "delegated") {
    if (!runtime.delegatedCredential) fail("delegation_unavailable");
    return runtime.delegatedCredential!();
  }
  try {
    return await resolveSecretRef(connection.credentialRef, runtime.env, {
      minLength: 1,
    });
  } catch {
    return fail("credential_unavailable");
  }
}
async function json(
  runtime: ConnectorRuntime,
  url: URL,
  token: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  await runtime.checkTransport(url);
  const response = await runtime.fetch(url, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(runtime.signal ? { signal: runtime.signal } : {}),
  });
  if (!response.ok) {
    await response.body?.cancel();
    fail(`http_${response.status}`);
  }
  const reader = response.body?.getReader();
  if (!reader) return fail("response_invalid");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 2 * 1024 * 1024) fail("response_too_large");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return Array.isArray(parsed) ? { rows: parsed } : object(parsed);
  } catch {
    return fail("response_invalid");
  }
}
const endpoint = (connection: ContextConnection, path: string) => {
  const base = new URL(connection.endpoint);
  const url = new URL(
    `${base.pathname.replace(/\/$/, "")}${path}`,
    base.origin,
  );
  return url;
};
function result(
  rows: Record<string, unknown>[],
  fields: ContextField[],
  maximumRows: number,
): ConnectorResult {
  if (
    fields.length > 500 ||
    fields.some((f) => !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(f.name))
  )
    fail("schema_invalid");
  if (new Set(fields.map((f) => f.name)).size !== fields.length)
    fail("duplicate_columns");
  const bounded = rows.slice(0, maximumRows);
  if (Buffer.byteLength(JSON.stringify(bounded)) > 2 * 1024 * 1024)
    fail("response_too_large");
  return {
    rows: bounded,
    fields,
    truncated: rows.length > maximumRows,
    schemaFingerprint: stableDigest(
      fields.toSorted((a, b) => a.name.localeCompare(b.name)),
    ),
  };
}
function inferred(rows: Record<string, unknown>[]): ContextField[] {
  return [...new Set(rows.flatMap((row) => Object.keys(row)))]
    .sort()
    .map((name) => ({
      name,
      type: typeof rows.find((row) => row[name] !== null)?.[name],
      nullable: rows.some((row) => row[name] == null),
    }));
}
async function postgres(
  connection: ContextConnection,
  binding: ContextBinding,
  values: Record<string, unknown>,
  runtime: ConnectorRuntime,
  token: string,
  discover: boolean,
): Promise<ConnectorResult> {
  const url = new URL(connection.endpoint);
  if (url.pathname !== `/${connection.resource.database}`)
    fail("database_scope_denied");
  let auth: Record<string, unknown>;
  try {
    auth = object(JSON.parse(token));
  } catch {
    return fail("credential_invalid");
  }
  if (typeof auth.username !== "string" || typeof auth.password !== "string")
    return fail("credential_invalid");
  await runtime.checkTransport(url);
  const client = new Client({
    host: url.hostname,
    port: Number(url.port || 5432),
    database: connection.resource.database,
    user: auth.username,
    password: auth.password,
    ssl: {
      rejectUnauthorized: true,
      ...(runtime.env.CONTEXT_SOURCE_CA_PEM
        ? { ca: runtime.env.CONTEXT_SOURCE_CA_PEM }
        : {}),
    },
    connectionTimeoutMillis: binding.timeoutMs,
    statement_timeout: binding.timeoutMs,
    query_timeout: binding.timeoutMs,
    application_name: "integralflow-context",
  });
  const abort = () => {
    void client.end().catch(() => undefined);
  };
  runtime.signal?.throwIfAborted();
  runtime.signal?.addEventListener("abort", abort, { once: true });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    const metadata = await client.query<{
      name: string;
      type: string;
      nullable: boolean;
    }>(
      "SELECT column_name AS name,data_type AS type,is_nullable='YES' AS nullable FROM information_schema.columns WHERE table_catalog=$1 AND table_schema=$2 AND table_name=$3 ORDER BY ordinal_position",
      [
        connection.resource.database,
        connection.resource.schema,
        connection.resource.object,
      ],
    );
    if (!metadata.rows.length) fail("resource_not_found");
    const query = contextReadQuery(connection, binding, values);
    const rows = discover
      ? []
      : ((await client.query(query.text, query.values)).rows as Record<
          string,
          unknown
        >[]);
    return result(rows, metadata.rows, binding.maximumRows);
  } finally {
    runtime.signal?.removeEventListener("abort", abort);
    await client.end().catch(() => undefined);
  }
}
async function http(
  connection: ContextConnection,
  binding: ContextBinding,
  values: Record<string, unknown>,
  runtime: ConnectorRuntime,
  token: string,
  discover: boolean,
): Promise<ConnectorResult> {
  const provider = connection.provider;
  if (provider === "openapi") {
    if (!binding.operationPath || /\.\.|\/\//.test(binding.operationPath))
      fail("operation_invalid");
    let path = binding.operationPath;
    for (const p of binding.parameters) {
      if (typeof values[p.name] !== p.type) fail("parameter_invalid");
      path = path.replaceAll(
        `{${p.name}}`,
        encodeURIComponent(String(values[p.name])),
      );
    }
    if (
      /[{}]/.test(path) ||
      Object.keys(values).some(
        (name) => !binding.parameters.some((p) => p.name === name),
      )
    )
      fail("parameter_invalid");
    if (/\.\.|\/\//.test(connection.openapiPath)) fail("operation_invalid");
    const document = await json(
      runtime,
      endpoint(connection, connection.openapiPath),
      token,
    );
    const resolve = (value: unknown): Record<string, unknown> => {
      const schema = object(value);
      if (!schema.$ref) return schema;
      if (
        typeof schema.$ref !== "string" ||
        !schema.$ref.startsWith("#/components/schemas/")
      )
        return fail("external_schema_ref_denied");
      const resolved = object(
        object(object(document.components).schemas)[schema.$ref.slice(21)],
      );
      if (resolved.$ref) return fail("nested_schema_ref_denied");
      return resolved;
    };
    const operation = object(
      object(object(document.paths)[binding.operationPath]).get,
    );
    const readUrl = endpoint(connection, path);
    for (const parameter of binding.parameters) {
      if (binding.operationPath.includes(`{${parameter.name}}`)) continue;
      const declared = array(operation.parameters ?? [])
        .map(object)
        .find((item) => item.name === parameter.name && item.in === "query");
      if (!declared) fail("parameter_not_declared");
      readUrl.searchParams.set(parameter.name, String(values[parameter.name]));
    }
    const response = object(object(operation.responses)["200"]);
    let schema = resolve(
      object(object(response.content)["application/json"]).schema,
    );
    if (binding.responsePath)
      schema = resolve(object(schema.properties)[binding.responsePath]);
    if (schema.type !== "array") return fail("response_schema_not_array");
    const item = resolve(schema.items);
    const fields = Object.entries(object(item.properties)).map(
      ([name, value]) => {
        const field = resolve(value);
        return {
          name,
          type: String(
            Array.isArray(field.type)
              ? field.type.find((type) => type !== "null")
              : field.type,
          ),
          nullable:
            field.nullable === true ||
            (Array.isArray(field.type) && field.type.includes("null")) ||
            !Array.isArray(item.required) ||
            !item.required.includes(name),
        };
      },
    );
    if (discover) return result([], fields, binding.maximumRows);
    const payload = await json(runtime, readUrl, token);
    const rows = array(
      binding.responsePath ? payload[binding.responsePath] : payload.rows,
    ).map(object);
    for (const row of rows)
      for (const field of fields) {
        const value = row[field.name];
        if (
          value != null &&
          field.type === "integer" &&
          !Number.isInteger(value)
        )
          fail("response_schema_mismatch");
        if (value == null) {
          if (!field.nullable) fail("response_schema_mismatch");
        } else if (
          ["string", "number", "boolean"].includes(field.type) &&
          typeof value !== field.type
        )
          fail("response_schema_mismatch");
      }
    return result(rows, fields, binding.maximumRows);
  }
  if (provider === "kafka" || provider === "object_store") {
    const payload = await json(
      runtime,
      endpoint(connection, "/v1/context/read"),
      token,
      {
        provider,
        operation: discover ? "discover" : "read",
        resource: connection.resource,
        parameters: values,
        maximumRows: binding.maximumRows,
      },
    );
    const rows = array(payload.rows).map(object);
    const fields = array(payload.fields).map((value) =>
      contextFieldSchema.parse(value),
    );
    const answer = result(rows, fields, binding.maximumRows);
    answer.truncated ||= payload.truncated === true;
    return answer;
  }
  if (provider === "databricks" && discover) {
    const r = connection.resource;
    const payload = await json(
      runtime,
      endpoint(
        connection,
        `/api/2.1/unity-catalog/tables/${encodeURIComponent(`${r.catalog}.${r.schema}.${r.object}`)}`,
      ),
      token,
    );
    const fields = array(payload.columns).map((value) => {
      const f = object(value);
      return {
        name: String(f.name),
        type: String(f.type_name ?? f.type_text),
        nullable: f.nullable !== false,
      };
    });
    return result([], fields, binding.maximumRows);
  }
  const query = contextReadQuery(connection, binding, values);
  let payload: Record<string, unknown>;
  let rows: Record<string, unknown>[];
  let fields: ContextField[];
  if (provider === "databricks") {
    payload = await json(
      runtime,
      endpoint(connection, "/api/2.0/sql/statements"),
      token,
      {
        warehouse_id: connection.resource.warehouse,
        statement: query.text,
        parameters: query.named.map((p) => ({
          name: p.name,
          value: String(p.value),
        })),
        wait_timeout: "10s",
        on_wait_timeout: "CANCEL",
        disposition: "INLINE",
        format: "JSON_ARRAY",
        row_limit: binding.maximumRows + 1,
      },
    );
    if (object(payload.status).state !== "SUCCEEDED")
      return fail("query_not_complete");
    fields = array(object(object(payload.manifest).schema).columns).map(
      (value) => {
        const f = object(value);
        return {
          name: String(f.name),
          type: String(f.type_name),
          nullable: true,
        };
      },
    );
    rows = array(object(payload.result).data_array).map((row) =>
      Object.fromEntries(fields.map((f, i) => [f.name, array(row)[i]])),
    );
  } else if (provider === "snowflake") {
    payload = await json(
      runtime,
      endpoint(connection, "/api/v2/statements"),
      token,
      {
        statement: query.text,
        warehouse: connection.resource.warehouse,
        database: connection.resource.database,
        schema: connection.resource.schema,
        timeout: Math.ceil(binding.timeoutMs / 1000),
        bindings: Object.fromEntries(
          query.named.map((p, i) => [
            String(i + 1),
            {
              type:
                typeof p.value === "number"
                  ? "REAL"
                  : typeof p.value === "boolean"
                    ? "BOOLEAN"
                    : "TEXT",
              value: String(p.value),
            },
          ]),
        ),
      },
    );
    if (payload.statementStatusUrl || !payload.data)
      return fail("query_not_complete");
    fields = array(object(payload.resultSetMetaData).rowType).map((value) => {
      const f = object(value);
      return {
        name: String(f.name),
        type: String(f.type),
        nullable: f.nullable !== false,
      };
    });
    rows = array(payload.data).map((row) =>
      Object.fromEntries(fields.map((f, i) => [f.name, array(row)[i]])),
    );
  } else if (provider === "bigquery") {
    payload = await json(
      runtime,
      endpoint(
        connection,
        `/bigquery/v2/projects/${encodeURIComponent(connection.resource.project)}/queries`,
      ),
      token,
      {
        query: query.text,
        useLegacySql: false,
        timeoutMs: binding.timeoutMs,
        maxResults: binding.maximumRows + 1,
        parameterMode: "NAMED",
        queryParameters: query.named.map((p) => ({
          name: p.name,
          parameterType: {
            type:
              typeof p.value === "number"
                ? "FLOAT64"
                : typeof p.value === "boolean"
                  ? "BOOL"
                  : "STRING",
          },
          parameterValue: { value: String(p.value) },
        })),
      },
    );
    if (payload.jobComplete !== true) return fail("query_not_complete");
    fields = array(object(payload.schema).fields).map((value) => {
      const f = object(value);
      return {
        name: String(f.name),
        type: String(f.type),
        nullable: f.mode !== "REQUIRED",
      };
    });
    rows = array(payload.rows ?? []).map((row) =>
      Object.fromEntries(
        fields.map((f, i) => [f.name, object(array(object(row).f)[i]).v]),
      ),
    );
  } else return fail("provider_unsupported");
  const answer = result(discover ? [] : rows, fields, binding.maximumRows);
  if (
    payload.nextPageToken ||
    payload.pageToken ||
    Number(payload.totalRows ?? rows.length) > binding.maximumRows ||
    Number(object(payload.manifest ?? {}).total_row_count ?? rows.length) >
      binding.maximumRows
  )
    answer.truncated = true;
  return answer;
}
export async function runContextConnector(
  connection: ContextConnection,
  binding: ContextBinding,
  parameters: Record<string, unknown>,
  runtime: ConnectorRuntime,
  discover = false,
): Promise<ConnectorResult> {
  assertContextTarget(connection, runtime);
  const signal = runtime.signal
    ? AbortSignal.any([runtime.signal, AbortSignal.timeout(binding.timeoutMs)])
    : AbortSignal.timeout(binding.timeoutMs);
  const bounded = { ...runtime, signal };
  signal.throwIfAborted();
  try {
    const token = await credential(connection, bounded);
    let answer: ConnectorResult;
    if (connection.provider === "postgresql") {
      answer = await postgres(
        connection,
        binding,
        parameters,
        bounded,
        token,
        discover,
      );
    } else if (
      connection.provider === "fabric" ||
      connection.provider === "sqlserver"
    ) {
      const data = await readTdsContext(
        connection,
        binding,
        parameters,
        bounded,
        token,
        discover,
      );
      answer = result(data.rows, data.fields, binding.maximumRows);
    } else {
      answer = await http(
        connection,
        binding,
        parameters,
        bounded,
        token,
        discover,
      );
    }
    signal.throwIfAborted();
    return answer;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (
      message.startsWith("context_source.") ||
      message.startsWith("gateway.source_policy_denied:")
    )
      throw error;
    return fail(signal.aborted ? "timeout" : "provider_unavailable");
  }
}
export function normalizeContextRows(
  binding: ContextBinding,
  result: ConnectorResult,
  input: {
    connectorId: string;
    invocationId: string;
    bindingDigest: string;
    connectionDigest: string;
    tenantId: string;
    qualificationId?: string;
    now?: number;
  },
): CanonicalRecordInput[] {
  if (binding.canonicalSchemaVersion !== LIBRARY_CONTEXT_SCHEMA_VERSION)
    fail("canonical_schema_changed");
  const now = input.now ?? Date.now();
  return result.rows.map((row) => {
    const key = row[binding.keyField];
    const observed = row[binding.observedAtField];
    if (
      (typeof key !== "string" && typeof key !== "number") ||
      String(key).length > 200
    )
      return fail("record_key_missing");
    const at =
      observed instanceof Date
        ? observed.toISOString()
        : typeof observed === "string"
          ? observed
          : "";
    const timestamp = Date.parse(at);
    if (
      !Number.isFinite(timestamp) ||
      timestamp > now ||
      now - timestamp > binding.maxAgeSeconds * 1000
    )
      return fail("record_stale");
    const data: Record<string, unknown> = Object.create(null) as Record<
      string,
      unknown
    >;
    for (const mapping of binding.mapping) {
      const value = row[mapping.source];
      if (value == null && mapping.required) fail("required_field_missing");
      if (value != null)
        data[mapping.target] = transformContextValue(value, mapping.transform);
    }
    if (!validateRecordData(binding.objectType, data).valid)
      fail("canonical_data_invalid");
    // The case subject the row is about (delivery plan C1): without it no skill admits the record.
    const subject =
      binding.subjectField === undefined
        ? undefined
        : row[binding.subjectField];
    if (
      binding.subjectField !== undefined &&
      (typeof subject !== "string" || !subject || subject.length > 256)
    )
      fail("record_subject_missing");
    const version = stableDigest({
      data,
      at,
      bindingDigest: input.bindingDigest,
      connectionDigest: input.connectionDigest,
      invocationId: input.invocationId,
    });
    return {
      schema_version: LIBRARY_CONTEXT_SCHEMA_VERSION,
      object_type: binding.objectType,
      object_id:
        `${binding.id}:${String(key)}`.length <= 256
          ? `${binding.id}:${String(key)}`
          : `${binding.id}:${stableDigest(key)}`,
      version_id: version,
      data,
      ...(typeof subject === "string" ? { subject_ids: [subject] } : {}),
      ...(binding.purposes?.length ? { purposes: [...binding.purposes] } : {}),
      observed_at: at,
      source_refs: [
        {
          tenant_id: input.tenantId,
          object_type: "GatewayInvocation",
          object_id: input.invocationId,
          version_id: result.schemaFingerprint,
        },
      ],
      provenance: {
        method: "connector_normalizer",
        normalizer: "context-source@1",
        connector_id: input.connectorId,
        capability_id: "context.source.read.v1",
        invocation_id: input.invocationId,
        provider_check_id: input.qualificationId ?? result.schemaFingerprint,
        manifest_digest: input.bindingDigest,
      },
      classification: "CONFIDENTIAL",
      synthetic: false,
    };
  });
}

function transformContextValue(
  value: unknown,
  transform: ContextBinding["mapping"][number]["transform"],
): unknown {
  try {
    if (transform === "identity")
      return JSON.parse(JSON.stringify(value)) as unknown;
    if (transform === "json")
      return typeof value === "string"
        ? (JSON.parse(value) as unknown)
        : (JSON.parse(JSON.stringify(value)) as unknown);
    if (typeof value !== "string") return fail("mapping_transform_invalid");
    if (transform === "trim") return value.trim();
    if (transform === "lowercase") return value.toLowerCase();
    if (transform === "uppercase") return value.toUpperCase();
    if (
      transform === "decimal" &&
      /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value.trim())
    )
      return value.trim();
    if (
      transform === "timestamp" &&
      /(?:Z|[+-][0-9]{2}:[0-9]{2})$/.test(value) &&
      Number.isFinite(Date.parse(value))
    )
      return new Date(value).toISOString();
    return fail("mapping_transform_invalid");
  } catch {
    return fail("mapping_transform_invalid");
  }
}
