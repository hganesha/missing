/**
 * Databricks capability adapters: Mosaic AI model/agent serving endpoints, Vector Search
 * indexes and Unity Catalog functions, each reached only through the capability gateway.
 *
 * Authentication is a bearer token from an `AccessTokenProvider` the caller supplies:
 * Databricks OAuth machine-to-machine (`createDatabricksOAuthTokenProvider`), which works on
 * every cloud Databricks runs on. Tokens never appear in a result or an error.
 */
import {
  boundedCount,
  cachedTokenProvider,
  inputFields,
  joinEndpoint,
  numberOrNull,
  parseCloudEndpoint,
  queryText,
  requestJson,
  sleep as defaultSleep,
  UNTRUSTED_EXTERNAL,
  type AccessTokenProvider,
  type Fetch,
} from "./cloud-http.js";
import { parseModelOutput, promptFor } from "./model-io.js";
import type { AdapterResult } from "./index.js";

/** Databricks workspace hostnames, one per cloud Databricks is offered on. */
export const DATABRICKS_HOST_SUFFIXES = [".cloud.databricks.com", ".azuredatabricks.net", ".gcp.databricks.com"] as const;

/**
 * `databricks-serving:<endpoint>[:chat|:responses]`. The suffix names the wire protocol:
 * `chat` (default) is the OpenAI-compatible chat-completions shape every foundation-model
 * and external-model endpoint accepts; `responses` is the Mosaic AI ResponsesAgent shape
 * (`{ input: [...] }`) an agent endpoint deployed with `agents.deploy` accepts.
 */
export const DATABRICKS_SERVING_BINDING_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}(:(chat|responses))?$/;

/** A Unity Catalog three-part name: `catalog.schema.object`, lowercase identifiers only. */
export const DATABRICKS_UC_NAME_PATTERN = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/;

/** `databricks-vector:<catalog.schema.index>`. */
export const DATABRICKS_VECTOR_BINDING_PATTERN = DATABRICKS_UC_NAME_PATTERN;

/** `databricks-uc:<catalog.schema.function>`. */
export const DATABRICKS_UC_BINDING_PATTERN = DATABRICKS_UC_NAME_PATTERN;

export type DatabricksConnection = {
  host: URL;
  token: AccessTokenProvider;
  fetch: Fetch;
};

/** The workspace URL: https on a Databricks hostname; the development profile may allow http://localhost. */
export function parseDatabricksHost(value: string | undefined, options: { allowLocalHttp?: boolean } = {}): URL {
  return parseCloudEndpoint(value, {
    error: "adapter.databricks_host_invalid",
    hostSuffixes: DATABRICKS_HOST_SUFFIXES,
    allowLocalHttp: options.allowLocalHttp ?? false,
  });
}

/**
 * Databricks OAuth M2M (client credentials) for a service principal.
 * POST https://<host>/oidc/v1/token, grant_type=client_credentials, scope=all-apis, HTTP
 * Basic client authentication. Cached until 60 s before expiry.
 */
export function createDatabricksOAuthTokenProvider(options: {
  host: URL;
  clientId: string;
  clientSecret: string;
  fetch: Fetch;
  timeoutMs?: number;
  now?: () => number;
}): AccessTokenProvider {
  if (!options.clientId.trim() || !options.clientSecret.trim()) throw new Error("adapter.databricks_credential_missing");
  const now = options.now ?? Date.now;
  return cachedTokenProvider(async () => {
    const basic = Buffer.from(`${options.clientId}:${options.clientSecret}`, "utf8").toString("base64");
    const { payload } = await requestJson(options.fetch, joinEndpoint(options.host, "oidc/v1/token"), {
      method: "POST",
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
      rawBody: new URLSearchParams({ grant_type: "client_credentials", scope: "all-apis" }).toString(),
      timeoutMs: options.timeoutMs ?? 10_000,
      errorPrefix: "adapter.databricks_token",
    });
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const token = record.access_token;
    const expiresIn = typeof record.expires_in === "number" ? record.expires_in : Number(record.expires_in);
    if (typeof token !== "string" || !token || !Number.isFinite(expiresIn) || expiresIn <= 0) {
      throw new Error("adapter.databricks_token_invalid");
    }
    return { token, expiresAt: now() + expiresIn * 1000 };
  }, { now });
}

async function authorization(connection: DatabricksConnection): Promise<Record<string, string>> {
  return { authorization: `Bearer ${await connection.token()}` };
}

function textFromContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (!part || typeof part !== "object") return [];
    const record = part as Record<string, unknown>;
    return (record.type === "text" || record.type === "output_text") && typeof record.text === "string" ? [record.text] : [];
  });
  return parts.length ? parts.join("") : null;
}

export type DatabricksServingInvocation = {
  connection: DatabricksConnection;
  /** `<endpoint>[:chat|:responses]`. */
  binding: string;
  input: unknown;
  maxOutputTokens: number;
  timeoutMs: number;
};

/** POST /serving-endpoints/<endpoint>/invocations in the binding's protocol. */
export async function invokeDatabricksServing(request: DatabricksServingInvocation): Promise<AdapterResult> {
  if (!DATABRICKS_SERVING_BINDING_PATTERN.test(request.binding)) throw new Error("adapter.databricks_serving_binding_invalid");
  const [endpoint, protocol = "chat"] = request.binding.split(":") as [string, ("chat" | "responses")?];
  const prompt = promptFor(request.input);
  const body = protocol === "responses"
    ? { input: [{ role: "user", content: prompt }] }
    : { messages: [{ role: "user", content: prompt }], max_tokens: request.maxOutputTokens };
  const { payload, headers } = await requestJson(
    request.connection.fetch,
    joinEndpoint(request.connection.host, `serving-endpoints/${encodeURIComponent(endpoint)}/invocations`),
    { method: "POST", headers: await authorization(request.connection), body, timeoutMs: request.timeoutMs, errorPrefix: "adapter.databricks_serving" },
  );
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  let text: string | null = null;
  if (protocol === "responses") {
    const items = Array.isArray(record.output) ? record.output as Array<Record<string, unknown>> : [];
    const messages = items.filter((item) => item && item.type === "message" && (item.role === undefined || item.role === "assistant"));
    text = messages.length ? textFromContent(messages.at(-1)!.content) : null;
  } else {
    const choices = Array.isArray(record.choices) ? record.choices as Array<Record<string, unknown>> : [];
    const message = choices[0]?.message && typeof choices[0].message === "object" ? choices[0].message as Record<string, unknown> : {};
    text = textFromContent(message.content);
  }
  if (text === null) throw new Error("adapter.databricks_serving_response_invalid");
  const usage = record.usage && typeof record.usage === "object" ? record.usage as Record<string, unknown> : {};
  return {
    output: parseModelOutput(text),
    provider: "databricks",
    model: endpoint,
    providerRequestId: typeof record.id === "string" ? record.id : headers.get("x-request-id"),
    inputTokens: numberOrNull(usage.prompt_tokens ?? usage.input_tokens),
    outputTokens: numberOrNull(usage.completion_tokens ?? usage.output_tokens),
    costUsd: null,
  };
}

export type DatabricksVectorQuery = {
  connection: DatabricksConnection;
  /** `catalog.schema.index`. */
  indexName: string;
  input: unknown;
  /** Columns returned; the first is the match ID (the index primary key). */
  columns: string[];
  timeoutMs: number;
};

const COLUMN_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** POST /api/2.0/vector-search/indexes/<name>/query with query text. Matches are untrusted data. */
export async function queryDatabricksVectorIndex(request: DatabricksVectorQuery): Promise<AdapterResult> {
  if (!DATABRICKS_VECTOR_BINDING_PATTERN.test(request.indexName)) throw new Error("adapter.databricks_vector_binding_invalid");
  if (!request.columns.length || request.columns.length > 32 || request.columns.some((column) => !COLUMN_PATTERN.test(column))) {
    throw new Error("adapter.databricks_vector_columns_invalid");
  }
  const query = queryText(request.input, "adapter.databricks_vector_query_invalid");
  const numResults = boundedCount(inputFields(request.input), ["topK", "numResults", "num_results"], 5, 1, 50);
  const { payload, headers } = await requestJson(
    request.connection.fetch,
    joinEndpoint(request.connection.host, `api/2.0/vector-search/indexes/${encodeURIComponent(request.indexName)}/query`),
    {
      method: "POST",
      headers: await authorization(request.connection),
      body: { query_text: query, num_results: numResults, columns: request.columns },
      timeoutMs: request.timeoutMs,
      errorPrefix: "adapter.databricks_vector",
    },
  );
  const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const manifest = record.manifest && typeof record.manifest === "object" ? record.manifest as Record<string, unknown> : {};
  const result = record.result && typeof record.result === "object" ? record.result as Record<string, unknown> : {};
  const names = Array.isArray(manifest.columns)
    ? (manifest.columns as Array<Record<string, unknown>>).map((column) => (typeof column?.name === "string" ? column.name : ""))
    : null;
  const rows = result.data_array === undefined ? [] : result.data_array;
  if (!names || !Array.isArray(rows) || rows.some((row) => !Array.isArray(row) || row.length !== names.length)) {
    throw new Error("adapter.databricks_vector_response_invalid");
  }
  const scoreIndex = names.lastIndexOf("score") >= 0 ? names.lastIndexOf("score") : names.length - 1;
  const idIndex = names.indexOf(request.columns[0]!);
  const matches = (rows as unknown[][]).map((row) => ({
    id: idIndex >= 0 ? row[idIndex] ?? null : null,
    score: numberOrNull(typeof row[scoreIndex] === "string" ? Number(row[scoreIndex]) : row[scoreIndex]),
    fields: Object.fromEntries(names.flatMap((name, index) => (index === scoreIndex || !name ? [] : [[name, row[index]]]))),
  }));
  return {
    output: { index: request.indexName, query, matches, instructionTrust: UNTRUSTED_EXTERNAL },
    provider: "databricks",
    model: `vector-search/${request.indexName}`,
    providerRequestId: headers.get("x-request-id"),
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };
}

export type StatementParameter = { name: string; value?: string; type: string };

/**
 * The named parameters for a UC function call. Input values are only ever bound, never
 * interpolated: the statement text is fixed by the function name and the argument count.
 */
export function ucFunctionParameters(input: unknown): StatementParameter[] {
  const fields = inputFields(input);
  const args = fields.arguments ?? fields.args ?? [];
  if (!Array.isArray(args) || args.length > 32) throw new Error("adapter.databricks_uc_arguments_invalid");
  return args.map((value, index) => {
    const name = `p${index + 1}`;
    if (value === null || value === undefined) return { name, type: "STRING" };
    if (typeof value === "string") return { name, value, type: "STRING" };
    if (typeof value === "boolean") return { name, value: String(value), type: "BOOLEAN" };
    if (typeof value === "number" && Number.isFinite(value)) {
      return { name, value: String(value), type: Number.isInteger(value) ? "BIGINT" : "DOUBLE" };
    }
    if (typeof value === "object") return { name, value: JSON.stringify(value), type: "STRING" };
    throw new Error("adapter.databricks_uc_arguments_invalid");
  });
}

/** The fixed statement for a validated function name and argument count. */
export function ucFunctionStatement(functionName: string, parameterCount: number): string {
  if (!DATABRICKS_UC_BINDING_PATTERN.test(functionName)) throw new Error("adapter.databricks_uc_binding_invalid");
  const quoted = functionName.split(".").map((part) => `\`${part}\``).join(".");
  const placeholders = Array.from({ length: parameterCount }, (_unused, index) => `:p${index + 1}`).join(", ");
  return `SELECT ${quoted}(${placeholders}) AS result`;
}

export type DatabricksUcInvocation = {
  connection: DatabricksConnection;
  /** `catalog.schema.function`. */
  functionName: string;
  input: unknown;
  warehouseId: string;
  /** Upper bound on the whole call, including polling. */
  timeoutMs: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

const TERMINAL_FAILURE = new Set(["FAILED", "CANCELED", "CLOSED"]);

/**
 * Execute a Unity Catalog function through the SQL Statement Execution API and return its
 * rows. Polls until SUCCEEDED or a failure state, never past `timeoutMs`; a statement still
 * running at the deadline is cancelled (best effort) and the call fails.
 */
export async function invokeDatabricksUcFunction(request: DatabricksUcInvocation): Promise<AdapterResult> {
  if (!/^[A-Za-z0-9]{1,64}$/.test(request.warehouseId)) throw new Error("adapter.databricks_warehouse_invalid");
  const parameters = ucFunctionParameters(request.input);
  const statement = ucFunctionStatement(request.functionName, parameters.length);
  const now = request.now ?? Date.now;
  const sleep = request.sleep ?? defaultSleep;
  const deadline = now() + request.timeoutMs;
  const remaining = () => deadline - now();
  const waitSeconds = Math.floor(request.timeoutMs / 1000) - 2;
  const errorPrefix = "adapter.databricks_uc";
  const { payload: submitted, headers } = await requestJson(request.connection.fetch, joinEndpoint(request.connection.host, "api/2.0/sql/statements"), {
    method: "POST",
    headers: await authorization(request.connection),
    body: {
      warehouse_id: request.warehouseId,
      statement,
      parameters,
      wait_timeout: waitSeconds >= 5 ? `${Math.min(50, waitSeconds)}s` : "0s",
      on_wait_timeout: "CONTINUE",
      disposition: "INLINE",
      format: "JSON_ARRAY",
      row_limit: 1000,
    },
    timeoutMs: request.timeoutMs,
    errorPrefix,
  });
  let current = submitted && typeof submitted === "object" ? submitted as Record<string, unknown> : {};
  const statementId = current.statement_id;
  if (typeof statementId !== "string" || !/^[A-Za-z0-9-]{1,128}$/.test(statementId)) throw new Error(`${errorPrefix}_response_invalid`);
  const state = () => {
    const status = current.status && typeof current.status === "object" ? current.status as Record<string, unknown> : {};
    return { state: typeof status.state === "string" ? status.state : "", error: status.error as Record<string, unknown> | undefined };
  };
  const statementUrl = joinEndpoint(request.connection.host, `api/2.0/sql/statements/${encodeURIComponent(statementId)}`);
  while (state().state !== "SUCCEEDED") {
    const { state: name, error } = state();
    if (TERMINAL_FAILURE.has(name)) {
      const code = typeof error?.error_code === "string" && /^[A-Z_]{1,64}$/.test(error.error_code) ? `_${error.error_code.toLowerCase()}` : "";
      throw new Error(`${errorPrefix}_failed${code}`);
    }
    if (name !== "PENDING" && name !== "RUNNING") throw new Error(`${errorPrefix}_response_invalid`);
    const interval = request.pollIntervalMs ?? 500;
    if (remaining() <= interval) {
      await requestJson(request.connection.fetch, joinEndpoint(request.connection.host, `api/2.0/sql/statements/${encodeURIComponent(statementId)}/cancel`), {
        method: "POST", headers: await authorization(request.connection), timeoutMs: 5_000, errorPrefix,
      }).catch(() => undefined);
      throw new Error(`${errorPrefix}_timeout`);
    }
    await sleep(interval);
    const polled = await requestJson(request.connection.fetch, statementUrl, {
      method: "GET", headers: await authorization(request.connection), timeoutMs: Math.max(1, remaining()), errorPrefix,
    });
    current = polled.payload && typeof polled.payload === "object" ? polled.payload as Record<string, unknown> : {};
  }
  const manifest = current.manifest && typeof current.manifest === "object" ? current.manifest as Record<string, unknown> : {};
  const schema = manifest.schema && typeof manifest.schema === "object" ? manifest.schema as Record<string, unknown> : {};
  const columns = Array.isArray(schema.columns)
    ? (schema.columns as Array<Record<string, unknown>>).map((column) => (typeof column?.name === "string" ? column.name : ""))
    : [];
  const result = current.result && typeof current.result === "object" ? current.result as Record<string, unknown> : {};
  const data = result.data_array === undefined ? [] : result.data_array;
  if (!Array.isArray(data) || data.some((row) => !Array.isArray(row) || row.length !== columns.length)) {
    throw new Error(`${errorPrefix}_response_invalid`);
  }
  const rows = (data as unknown[][]).map((row) => Object.fromEntries(columns.map((name, index) => [name, row[index] ?? null])));
  return {
    output: {
      function: request.functionName,
      statementId,
      columns,
      rows,
      rowCount: rows.length,
      truncated: manifest.truncated === true || (typeof manifest.total_chunk_count === "number" && manifest.total_chunk_count > 1),
    },
    provider: "databricks",
    model: `uc-function/${request.functionName}`,
    providerRequestId: statementId ?? headers.get("x-request-id"),
    inputTokens: null,
    outputTokens: null,
    costUsd: null,
  };
}
