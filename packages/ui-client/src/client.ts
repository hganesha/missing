import { OPERATIONS, type OperationId, type OperationMeta, type operations } from "@ehf/ui-contracts";
import createClient, { type Middleware } from "openapi-fetch";
import { networkError, toApiError } from "./errors.js";

type Op<K extends OperationId> = operations[K];

type ParamsOf<K extends OperationId> = Op<K> extends { parameters: infer P } ? P : never;
type PathParams<K extends OperationId> = ParamsOf<K> extends { path?: infer P } ? P : never;
type QueryParams<K extends OperationId> = ParamsOf<K> extends { query?: infer Q } ? Q : never;
type BodyOf<K extends OperationId> = Op<K> extends { requestBody?: { content: { "application/json": infer B } } } ? B : never;

type SuccessStatus = 200 | 201 | 202 | 204;
type ResponsesOf<K extends OperationId> = Op<K> extends { responses: infer R } ? R : never;
type JsonOf<R> = R extends { content: { "application/json": infer J } } ? J : undefined;
/** The JSON body of the operation's success response(s). */
export type ResultOf<K extends OperationId> = K extends 'getCasesCaseIdExportsDigestFormat' ? Blob : {
  [S in keyof ResponsesOf<K>]: S extends SuccessStatus ? JsonOf<ResponsesOf<K>[S]> : never;
}[keyof ResponsesOf<K>];

type Optional<T, Key extends string> = [T] extends [never] ? { [P in Key]?: never } : undefined extends T ? { [P in Key]?: T } : { [P in Key]: T };

export type CallArgs<K extends OperationId> =
  & Optional<PathParams<K>, "path">
  & Optional<QueryParams<K>, "query">
  & Optional<BodyOf<K>, "body">
  & {
    /** Sent as `Idempotency-Key` where the operation declares it. */
    idempotencyKey?: string;
    /** Conditional GET: when the server answers 304, `call` resolves with `notModified`. */
    ifNoneMatch?: string;
    signal?: AbortSignal;
  };

export type CallResult<K extends OperationId> =
  | { notModified: false; data: ResultOf<K>; etag: string | null; status: number; correlationId: string | null }
  | { notModified: true; data: undefined; etag: string | null; status: 304; correlationId: string | null };

export type ExperienceClient = {
  readonly [K in OperationId]: (args?: CallArgs<K>) => Promise<ResultOf<K>>;
} & {
  /** Low-level call returning status, ETag and 304 handling; used by polling. */
  call<K extends OperationId>(operationId: K, args?: CallArgs<K>): Promise<CallResult<K>>;
};

export type ClientOptions = {
  baseUrl?: string;
  /** Auth is served outside /api, including when the API uses an absolute origin. */
  authBaseUrl?: string;
  /** The current session's CSRF token; sent as `X-CSRF-Token` on every non-GET request. */
  getCsrf: () => string | null;
  fetch?: typeof fetch;
};

const META = new Map<string, OperationMeta>((OPERATIONS as readonly OperationMeta[]).map((op) => [op.operationId, op]));

/**
 * Create the client. Components never call `fetch` directly (N1); they go through this
 * client, which adds CSRF and idempotency headers, keeps correlation ids, and turns every
 * non-2xx response into an `ApiError` with its original status.
 */
export function createExperienceClient(options: ClientOptions): ExperienceClient {
  const transport = createClient<Record<string, never>>({
    baseUrl: options.baseUrl ?? "/api",
    ...(options.fetch ? { fetch: options.fetch } : {}),
    credentials: "same-origin",
  });
  const authTransport = createClient<Record<string, never>>({
    baseUrl: options.authBaseUrl ?? (options.baseUrl ?? '/api').replace(/\/api\/?$/, ''),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    credentials: 'same-origin',
  });

  const csrf: Middleware = {
    onRequest({ request }) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        const token = options.getCsrf();
        if (token) request.headers.set("X-CSRF-Token", token);
      }
      return request;
    },
  };
  transport.use(csrf);
  authTransport.use(csrf);

  async function call<K extends OperationId>(operationId: K, args: CallArgs<K> = {} as CallArgs<K>): Promise<CallResult<K>> {
    const meta = META.get(operationId);
    if (!meta) throw new Error(`ui-client: unknown operation ${operationId}`);
    const loose = args as { path?: Record<string, unknown>; query?: Record<string, unknown>; body?: unknown; idempotencyKey?: string; ifNoneMatch?: string; signal?: AbortSignal };
    const headers: Record<string, string> = { accept: "application/json" };
    if (loose.idempotencyKey) headers["Idempotency-Key"] = loose.idempotencyKey;
    if (loose.ifNoneMatch) headers["If-None-Match"] = loose.ifNoneMatch;
    let response: Response;
    let data: unknown;
    let error: unknown;
    try {
      const selectedTransport = meta.path.startsWith('/auth/') ? authTransport : transport;
      const invoke = (selectedTransport as unknown as Record<string, (path: string, init: unknown) => Promise<{ data?: unknown; error?: unknown; response: Response }>>)[meta.method];
      ({ data, error, response } = await invoke!(meta.path, {
        params: { path: loose.path, query: loose.query },
        ...(loose.body !== undefined ? { body: loose.body } : {}),
        headers,
        ...(loose.signal ? { signal: loose.signal } : {}),
        parseAs: operationId === 'postAuthLogout' ? 'text' : operationId === 'getCasesCaseIdExportsDigestFormat' ? 'blob' : 'json',
      }));
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
      throw networkError();
    }
    const correlationId = response.headers.get("x-correlation-id");
    const etag = response.headers.get("etag");
    if (response.status === 304) return { notModified: true, data: undefined, etag, status: 304, correlationId };
    if (!response.ok) {
      if(error instanceof Blob)error=await error.text();
      if(typeof error==='string') {try {error=JSON.parse(error);} catch {/* Non-JSON upstream failures use the standard message. */}}
      throw toApiError(response.status, error, correlationId ?? undefined);
    }
    return { notModified: false, data: data as ResultOf<K>, etag, status: response.status, correlationId };
  }

  return new Proxy({ call } as ExperienceClient, {
    get(target, property) {
      if (property === "call") return target.call;
      if (typeof property !== "string" || !META.has(property)) return undefined;
      return async (args?: CallArgs<OperationId>) => {
        const result = await call(property as OperationId, args);
        if (result.notModified) throw new Error(`ui-client: ${property} returned 304 without a cached body; use call() for conditional requests`);
        return result.data;
      };
    },
  });
}

export function operationMeta(operationId: string): OperationMeta | undefined {
  return META.get(operationId);
}
