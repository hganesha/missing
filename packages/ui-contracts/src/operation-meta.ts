/** Metadata for one Experience API operation, generated from the OpenAPI `x-` extensions. */
export type OperationMeta = {
  readonly operationId: string;
  readonly method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE";
  /** OpenAPI path under the `/api` server, e.g. `/v1/runs/{runId}`. */
  readonly path: string;
  readonly tag: string | null;
  readonly xScreens: readonly string[];
  /** The EHF route a relay calls; `service: experience-bff` marks a BFF composition. */
  readonly xUpstream: { readonly service: string; readonly method?: string; readonly path?: string; readonly [key: string]: unknown } | null;
  /** The EHF platform action enforced upstream. */
  readonly xAction: string | null;
  readonly xPoll: { readonly intervalMs?: number; readonly [key: string]: unknown } | null;
  readonly xOwner: string | null;
  readonly xStatus: string | null;
  readonly mockOnly: boolean;
  /** Non-GET operations that require `X-CSRF-Token`. */
  readonly csrf: boolean;
  /** Reachable without a session (auth endpoints). */
  readonly public: boolean;
};
