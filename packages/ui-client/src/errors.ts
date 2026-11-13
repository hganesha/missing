import type { Schemas } from "@ehf/ui-contracts";

type ApiErrorBody = Schemas["ApiError"];

/**
 * A failed Experience API call. Carries the contract's error body (reason code, message,
 * details, correlation id) plus the HTTP status. Status codes are never flattened.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly body: ApiErrorBody;
  constructor(status: number, body: ApiErrorBody) {
    super(body.message ?? body.error);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
  get reason(): string {
    return this.body.error;
  }
  get retryable(): boolean {
    return Boolean(this.body.retryable);
  }
  get correlationId(): string | undefined {
    return this.body.correlationId ?? undefined;
  }
}

/** A network failure (no response) maps to the BFF's upstream-unavailable code. */
export function networkError(correlationId?: string): ApiError {
  return new ApiError(503, {
    error: "bff.upstream_unavailable",
    message: "The service could not be reached.",
    retryable: true,
    ...(correlationId ? { correlationId } : {}),
  } as ApiErrorBody);
}

export function toApiError(status: number, body: unknown, correlationId?: string): ApiError {
  const record = body && typeof body === "object" ? (body as Partial<ApiErrorBody>) : {};
  return new ApiError(status, {
    ...record,
    error: typeof record.error === "string" ? record.error : `http.${status}`,
    message: typeof record.message === "string" ? record.message : `Request failed (HTTP ${status}).`,
    retryable: typeof record.retryable === "boolean" ? record.retryable : status >= 500 || status === 429,
    ...((record.correlationId ?? correlationId) ? { correlationId: record.correlationId ?? correlationId } : {}),
  } as ApiErrorBody);
}
