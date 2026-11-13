import { keepPreviousData, useQuery, type QueryKey } from "@tanstack/react-query";
import type { OperationId } from "@ehf/ui-contracts";
import { useEffect, useRef, useState } from "react";
import { operationMeta, type CallArgs, type ExperienceClient, type ResultOf } from "./client.js";
import { ApiError } from "./errors.js";

/**
 * Region states for any data-bearing area (BUILD-SPEC v2 §9.1). Buttons track their own
 * committing/confirmed states.
 */
export type RegionState =
  | "idle" | "loading" | "ready" | "stale" | "conflict" | "offline" | "degraded" | "retryable_failure" | "terminal_failure";

export type Polled<T> = {
  data: T | undefined;
  state: RegionState;
  error: ApiError | null;
  /** When the last good payload arrived (epoch ms), or null. */
  updatedAt: number | null;
  isRefreshing: boolean;
  intervalMs: number | null;
  refresh: () => void;
};

const MAX_BACKOFF_MS = 60_000;

export function queryKeyFor<K extends OperationId>(operationId: K, args?: CallArgs<K>): QueryKey {
  const { signal: _signal, ifNoneMatch: _etag, ...rest } = (args ?? {}) as Record<string, unknown>;
  return [operationId, rest];
}

export function regionStateOf(input: { hasData: boolean; isPending: boolean; isFetching: boolean; error: unknown }): RegionState {
  const { hasData, isPending, isFetching, error } = input;
  if (error instanceof ApiError) {
    if (hasData) return "stale";
    if (error.reason === "bff.upstream_unavailable") return "offline";
    if (error.status === 409) return "conflict";
    if (error.status === 502 || error.status === 503) return "degraded";
    return error.retryable ? "retryable_failure" : "terminal_failure";
  }
  if (error) return hasData ? "stale" : "retryable_failure";
  if (hasData) return "ready";
  if (isPending && isFetching) return "loading";
  return "idle";
}

/**
 * Poll a GET operation at its contract interval (`x-poll`). Pauses while the tab is hidden,
 * sends `If-None-Match` and treats 304 as fresh, backs off ×2 up to 60 s on failure, and
 * never clears the last good data when a poll fails (§4.3).
 */
export function usePolled<K extends OperationId>(
  client: ExperienceClient,
  operationId: K,
  args?: CallArgs<K>,
  options: { enabled?: boolean; pollWhile?: (data: ResultOf<K> | undefined) => boolean } = {},
): Polled<ResultOf<K>> {
  const meta = operationMeta(operationId);
  const baseInterval = (meta?.xPoll?.intervalMs as number | undefined) ?? null;
  const etag = useRef<string | null>(null);
  const last = useRef<ResultOf<K> | undefined>(undefined);
  const [failures, setFailures] = useState(0);

  const query = useQuery<ResultOf<K>, ApiError>({
    queryKey: queryKeyFor(operationId, args),
    enabled: options.enabled ?? true,
    queryFn: async ({ signal }) => {
      const result = await client.call(operationId, { ...(args ?? {}), signal, ...(etag.current && last.current !== undefined ? { ifNoneMatch: etag.current } : {}) } as CallArgs<K>);
      if (result.notModified) return last.current as ResultOf<K>;
      etag.current = result.etag;
      last.current = result.data;
      return result.data;
    },
    refetchInterval: ({ state }) => baseInterval === null || options.pollWhile?.(state.data) === false
      ? false
      : Math.min(baseInterval * 2 ** failures, MAX_BACKOFF_MS),
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
    retry: false,
  });

  useEffect(() => {
    if (query.isError) setFailures((count) => count + 1);
    else if (query.isSuccess) setFailures(0);
  }, [query.isError, query.isSuccess, query.dataUpdatedAt, query.errorUpdatedAt]);

  return {
    data: query.data,
    state: regionStateOf({ hasData: query.data !== undefined, isPending: query.isPending, isFetching: query.isFetching, error: query.error }),
    error: query.error ?? null,
    updatedAt: query.dataUpdatedAt || null,
    isRefreshing: query.isFetching && query.data !== undefined,
    intervalMs: baseInterval,
    refresh: () => void query.refetch(),
  };
}
