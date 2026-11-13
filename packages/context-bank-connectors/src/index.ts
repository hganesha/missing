import {
  ContextSetupError,
  stableDigest,
  contextDatasetId,
  contextSourceFields,
  type ContextSetupConnection,
  type ContextResourceBinding,
  type ApiContextConnection,
  type ApiContextResource,
} from "@ehf/contracts";
import * as postgres from "@ehf/context-postgres";

export { contextDatasetId, contextSourceFields } from "@ehf/contracts";
type Fetch = typeof globalThis.fetch;
const fail = (code: string, status = 400): never => {
  throw new ContextSetupError(`context.${code}`, status);
};
const pathValue = (root: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (v, k) =>
        v && typeof v === "object" && Object.hasOwn(v, k)
          ? (v as Record<string, unknown>)[k]
          : undefined,
      root,
    );
export function assertResourceScope(
  connection: ContextSetupConnection,
  resource: ContextResourceBinding,
) {
  if (!("api" in connection) && !("api" in resource))
    return postgres.assertResourceScope(connection, resource);
  if (
    !("api" in connection) ||
    !("api" in resource) ||
    connection.api.kind !== resource.api.kind
  )
    fail("resource_scope_denied", 403);
  const c = connection as ApiContextConnection,
    r = resource as ApiContextResource;
  const allowed = c.resources.find((a) => a.datasetId === r.datasetId);
  if (
    !allowed ||
    !contextSourceFields(r).every((f) => allowed.fields.includes(f))
  )
    fail("resource_scope_denied", 403);
  if (r.api.kind === "salesforce" && !c.api.apiVersion)
    fail("api_version_required");
}
type Credential = {
  tenantId: string;
  connectorId: string;
  generation: string;
  instanceId: string;
  baseUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
};
export function contextSourceCredential(
  connection: ContextSetupConnection,
  tenantId: string,
  env: NodeJS.ProcessEnv,
): string | Credential {
  if (!("api" in connection))
    return postgres.contextSourceCredential(connection, tenantId, env);
  let secret: Credential;
  try {
    secret = JSON.parse(env[connection.credentialRef] ?? "");
  } catch {
    return fail("credential_invalid", 503);
  }
  if (
    !secret ||
    typeof secret.clientId !== "string" ||
    !secret.clientId ||
    typeof secret.clientSecret !== "string" ||
    !secret.clientSecret ||
    secret.clientSecret.length > 16384
  )
    fail("credential_invalid", 503);
  if (
    secret.tenantId !== tenantId ||
    secret.connectorId !== connection.connectorId ||
    secret.generation !== connection.credentialGeneration ||
    secret.instanceId !== connection.api.instanceId ||
    secret.baseUrl !== connection.api.baseUrl ||
    secret.tokenUrl !== connection.api.tokenUrl
  )
    fail("credential_scope_denied", 403);
  return secret;
}
export function assertContextSourceDestination(
  connection: ContextSetupConnection,
  tenantId: string,
  env: NodeJS.ProcessEnv,
  binding: { transport: string; approvedEndpoints: string[] },
) {
  if (!("api" in connection))
    return postgres.assertContextSourceDestination(
      connection,
      tenantId,
      env,
      binding,
    );
  contextSourceCredential(connection, tenantId, env);
  if (
    binding.transport !== "network" ||
    ![connection.api.baseUrl, connection.api.tokenUrl].every((url) =>
      binding.approvedEndpoints.some(
        (e) => new URL(e).href === new URL(url).href,
      ),
    )
  )
    fail("source_destination_denied", 403);
}
/** A single discovery/pull has one deadline and one aggregate byte/request budget. No durable cursors. */
class Session {
  readonly signal: AbortSignal;
  private bytes = 0;
  private calls = 0;
  private token = "";
  constructor(
    readonly c: ApiContextConnection,
    readonly secret: Credential,
    readonly fetcher: Fetch,
    signal?: AbortSignal,
  ) {
    this.signal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
      : AbortSignal.timeout(30000);
  }
  async json(
    url: string,
    init: RequestInit = {},
    exactNumbers = false,
  ): Promise<any> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (++this.calls > 40) fail("source_request_limit", 413);
      let response: Response;
      try {
        response = await this.fetcher(url, {
          ...init,
          signal: this.signal,
          redirect: "error",
        });
      } catch {
        return fail(
          this.signal.aborted ? "source_deadline" : "source_unavailable",
          503,
        );
      }
      if ((response.status === 429 || response.status === 503) && attempt < 2) {
        const delay = Math.min(
          1000,
          Math.max(
            0,
            Number(response.headers.get("retry-after") ?? "0.1") * 1000,
          ),
        );
        await response.body?.cancel();
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(new ContextSetupError("context.source_deadline", 503));
          };
          const timer = setTimeout(() => {
            this.signal.removeEventListener("abort", abort);
            resolve();
          }, delay);
          this.signal.addEventListener("abort", abort, { once: true });
          if (this.signal.aborted) abort();
        });
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        fail(
          response.status === 404
            ? "source_not_found"
            : response.status === 401 || response.status === 403
              ? "source_access_denied"
              : "source_unavailable",
          response.status === 404
            ? 404
            : response.status === 401 || response.status === 403
              ? 403
              : 503,
        );
      }
      if (!response.body) fail("source_response_invalid", 502);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let text = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          this.bytes += value.byteLength;
          if (this.bytes > 512000) fail("sample_byte_limit", 413);
          text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
      } catch (error) {
        if (error instanceof ContextSetupError) throw error;
        fail("source_unavailable", 503);
      } finally {
        await reader.cancel().catch(() => undefined);
      }
      try {
        return JSON.parse(
          text,
          (_key: string, value: unknown, context?: { source?: string }) => {
            if (exactNumbers && typeof value === "number") {
              if (!context?.source)
                fail("source_lossless_number_unavailable", 503);
              return context!.source;
            }
            return value;
          },
        );
      } catch {
        return fail("source_response_invalid", 502);
      }
    }
    return fail("source_unavailable", 503);
  }
  async authenticate() {
    const form = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.secret.clientId,
      client_secret: this.secret.clientSecret,
    });
    if (this.c.api.scope) form.set("scope", this.c.api.scope);
    const token = await this.json(this.c.api.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });
    if (
      typeof token.access_token !== "string" ||
      !token.access_token ||
      (token.instance_url &&
        new URL(token.instance_url).origin !==
          new URL(this.c.api.baseUrl).origin)
    )
      fail("source_token_scope_denied", 403);
    this.token = token.access_token;
  }
  async get(path: string, exactNumbers = true) {
    const url = new URL(path, this.c.api.baseUrl);
    if (
      url.origin !== new URL(this.c.api.baseUrl).origin ||
      url.username ||
      url.password ||
      url.hash
    )
      fail("source_destination_denied", 403);
    return this.json(
      url.href,
      {
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
        },
      },
      exactNumbers,
    );
  }
}
async function session(
  connection: ApiContextConnection,
  tenantId: string,
  env: NodeJS.ProcessEnv,
  fetcher: Fetch,
  signal?: AbortSignal,
) {
  const s = new Session(
    connection,
    contextSourceCredential(connection, tenantId, env) as Credential,
    fetcher,
    signal,
  );
  await s.authenticate();
  return s;
}
async function discover(s: Session, resource: ApiContextResource) {
  let metadata: unknown;
  if (resource.api.kind === "salesforce") {
    const described = await s.get(
      `/services/data/${s.c.api.apiVersion}/sobjects/${resource.api.object}/describe/`,
      false,
    );
    if (described.queryable !== true || !Array.isArray(described.fields))
      fail("source_schema_changed", 409);
    // Relationship paths need explicit separate resources. Never infer joins from dot-walking.
    const wanted = [
      ...new Set([
        ...Object.values(resource.api.fields),
        resource.api.subjectField,
      ]),
    ].sort();
    if (wanted.some((f) => f.includes(".")))
      fail("api_relationship_resource_required");
    metadata = wanted.map((name) => {
      const field = described.fields.find((f: any) => f.name === name);
      if (!field) fail("source_schema_changed", 409);
      return {
        column_name: name,
        data_type: field.type,
        is_nullable: field.nillable,
        referenceTo: field.referenceTo ?? [],
        picklistValues: field.picklistValues ?? [],
      };
    });
  } else {
    const schema = await s.get(resource.api.schemaPath, false);
    if (!schema || !schema.paths || typeof schema.paths !== "object")
      fail("source_schema_changed", 409);
    // Exact tenant specification is pinned; DTO field projections are validated on every read.
    const template = resource.api.path.replace("{subject}", "{id}");
    const path =
      Object.keys(schema.paths).find(
        (p) =>
          p.replace(/\{[^}]+\}/g, "{id}") === template.replace(/^\/[^/]+/, ""),
      ) ??
      Object.keys(schema.paths).find(
        (p) => p.replace(/\{[^}]+\}/g, "{id}") === template,
      );
    if (!path || !schema.paths[path]?.get)
      fail("source_operation_unavailable", 409);
    metadata = { schema, fields: resource.api.fields };
  }
  return {
    columns: resource.columns.map((column_name) => ({
      column_name,
      data_type: "api",
      is_nullable: "YES",
    })),
    fingerprint: stableDigest({ api: resource.api, metadata }),
  };
}
export async function discoverContextResource(
  connection: ContextSetupConnection,
  resource: ContextResourceBinding,
  tenantId: string,
  env: NodeJS.ProcessEnv,
  fetcher: Fetch = globalThis.fetch,
  signal?: AbortSignal,
) {
  assertResourceScope(connection, resource);
  if (!("api" in connection) && !("api" in resource))
    return postgres.discoverContextResource(
      connection,
      resource,
      tenantId,
      env,
    );
  return discover(
    await session(
      connection as ApiContextConnection,
      tenantId,
      env,
      fetcher,
      signal,
    ),
    resource as ApiContextResource,
  );
}
export async function fetchContextSample(
  connection: ContextSetupConnection,
  resource: ContextResourceBinding,
  subjects: string[],
  tenantId: string,
  env: NodeJS.ProcessEnv,
  fetcher: Fetch = globalThis.fetch,
  signal?: AbortSignal,
) {
  assertResourceScope(connection, resource);
  if (
    !subjects.length ||
    subjects.length > 20 ||
    new Set(subjects).size !== subjects.length ||
    subjects.some((s) => !s.trim() || s.length > 256)
  )
    fail("subject_limit");
  if (!("api" in connection) && !("api" in resource))
    return postgres.fetchContextSample(
      connection,
      resource,
      subjects,
      tenantId,
      env,
    );
  const c = connection as ApiContextConnection,
    r = resource as ApiContextResource;
  const s = await session(c, tenantId, env, fetcher, signal),
    schema = await discover(s, r);
  if (!r.schemaFingerprint || schema.fingerprint !== r.schemaFingerprint)
    fail("source_schema_changed", 409);
  const rows: Record<string, unknown>[] = [];
  const project = (raw: unknown) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      fail("source_response_invalid", 502);
    const row = Object.fromEntries(
      Object.entries(r.api.fields).map(([alias, path]) => [
        alias,
        pathValue(raw, path),
      ]),
    );
    if (!subjects.includes(String(row[r.subjectColumn])))
      fail("source_subject_scope_denied", 403);
    if (!Number.isFinite(Date.parse(String(row[r.observedAtColumn]))))
      fail("source_observation_missing", 409);
    rows.push(row);
    if (rows.length > r.maxRows) fail("source_row_limit", 413);
  };
  if (r.api.kind === "salesforce") {
    const escape = (value: string) =>
      value
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'")
        .replace(/\r/g, "\\r")
        .replace(/\n/g, "\\n");
    const fields = [...new Set(Object.values(r.api.fields))];
    const query = `SELECT ${fields.join(",")} FROM ${r.api.object} WHERE ${r.api.subjectField} IN (${subjects.map((v) => `'${escape(v)}'`).join(",")}) LIMIT ${r.maxRows + 1}`;
    let next: string | null =
      `/services/data/${c.api.apiVersion}/query?q=${encodeURIComponent(query)}`;
    const seen = new Set<string>();
    let total: number | null = null;
    while (next) {
      if (seen.has(next)) fail("source_pagination_invalid", 502);
      seen.add(next);
      const page: any = await s.get(next);
      if (typeof page.totalSize === "string" && /^\d+$/.test(page.totalSize))
        page.totalSize = Number(page.totalSize);
      if (
        !Array.isArray(page.records) ||
        typeof page.done !== "boolean" ||
        typeof page.totalSize !== "number"
      )
        fail("source_response_invalid", 502);
      if (
        !Number.isSafeInteger(page.totalSize) ||
        page.totalSize < 0 ||
        (total !== null && total !== page.totalSize)
      )
        fail("source_pagination_invalid", 502);
      total = page.totalSize;
      if (page.totalSize > r.maxRows) fail("source_row_limit", 413);
      page.records.forEach(project);
      next = page.done ? null : page.nextRecordsUrl;
      if (
        !page.done &&
        (typeof next !== "string" ||
          !new RegExp(
            `^/services/data/${c.api.apiVersion!.replace(".", "\\.")}\\/query/[A-Za-z0-9-]+$`,
          ).test(next))
      )
        fail("source_pagination_invalid", 502);
    }
    if (rows.length !== total) fail("source_pagination_incomplete", 409);
  } else {
    for (const key of subjects) {
      const first = r.api.path.replace("{subject}", encodeURIComponent(key));
      let next: string | null = first;
      const seen = new Set<string>();
      while (next) {
        const u = new URL(next, c.api.baseUrl);
        if (
          seen.has(u.href) ||
          u.pathname !== new URL(first, c.api.baseUrl).pathname
        )
          fail("source_pagination_invalid", 502);
        seen.add(u.href);
        const page = await s.get(u.href);
        const items = r.api.recordsPath
          ? pathValue(page, r.api.recordsPath)
          : page;
        if (Array.isArray(items) && !r.api.nextPath)
          fail("source_pagination_contract_required", 409);
        if (Array.isArray(items)) items.forEach(project);
        else project(items);
        const continuation = r.api.nextPath
          ? pathValue(page, r.api.nextPath)
          : null;
        if (
          continuation !== null &&
          continuation !== undefined &&
          typeof continuation !== "string"
        )
          fail("source_pagination_invalid", 502);
        next = continuation ? String(continuation) : null;
      }
    }
  }
  if (
    subjects.some(
      (key) => !rows.some((row) => String(row[r.subjectColumn]) === key),
    )
  )
    fail("requested_subject_missing", 409);
  return { rows, truncated: false, fingerprint: schema.fingerprint };
}
