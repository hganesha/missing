// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { createExperienceClient } from "./client.js";
import { ApiError } from "./errors.js";
import { regionStateOf, usePolled } from "./react.js";

describe("regionStateOf", () => {
  const error = (status: number, reason: string, retryable = false) => new ApiError(status, { error: reason, message: reason, retryable } as never);
  it.each([
    [{ hasData: true, isPending: false, isFetching: false, error: null }, "ready"],
    [{ hasData: false, isPending: true, isFetching: true, error: null }, "loading"],
    [{ hasData: true, isPending: false, isFetching: false, error: error(503, "bff.upstream_unavailable", true) }, "stale"],
    [{ hasData: false, isPending: false, isFetching: false, error: error(503, "bff.upstream_unavailable", true) }, "offline"],
    [{ hasData: false, isPending: false, isFetching: false, error: error(502, "bff.upstream_failed", true) }, "degraded"],
    [{ hasData: false, isPending: false, isFetching: false, error: error(409, "authoring.revision_conflict_or_published") }, "conflict"],
    [{ hasData: false, isPending: false, isFetching: false, error: error(403, "authorization.role_missing") }, "terminal_failure"],
  ] as const)("%j → %s", (input, state) => {
    expect(regionStateOf(input)).toBe(state);
  });
});

describe("usePolled", () => {
  function setup(responses: Array<() => Response>) {
    const calls: Headers[] = [];
    const fetch = (async (input: Request) => {
      calls.push(input.headers);
      return (responses.shift() ?? responses.at(-1) ?? (() => new Response(null, { status: 500 })))();
    }) as unknown as typeof globalThis.fetch;
    const client = createExperienceClient({ baseUrl: "http://ui.test/api", getCsrf: () => null, fetch });
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    return { client, wrapper, calls };
  }
  const session = { subject: { displayName: "R. Okafor" } };
  const ok = () => new Response(JSON.stringify(session), { status: 200, headers: { "content-type": "application/json", etag: '"v1"' } });

  it("keeps the last good data and marks the region stale when a refresh fails", async () => {
    const { client, wrapper } = setup([ok, () => new Response(JSON.stringify({ error: "bff.upstream_unavailable", retryable: true }), { status: 503, headers: { "content-type": "application/json" } })]);
    const { result } = renderHook(() => usePolled(client, "getSession"), { wrapper });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.state).toBe("stale"));
    expect(result.current.data).toEqual(session);
    expect(result.current.error?.reason).toBe("bff.upstream_unavailable");
  });

  it("sends If-None-Match and treats 304 as fresh", async () => {
    const { client, wrapper, calls } = setup([ok, () => new Response(null, { status: 304, headers: { etag: '"v1"' } })]);
    const { result } = renderHook(() => usePolled(client, "getSession"), { wrapper });
    await waitFor(() => expect(result.current.state).toBe("ready"));
    act(() => result.current.refresh());
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]!.get("if-none-match")).toBe('"v1"');
    await waitFor(() => expect(result.current.isRefreshing).toBe(false));
    expect(result.current.state).toBe("ready");
    expect(result.current.data).toEqual(session);
  });

  it("reads the poll interval from the contract", () => {
    const { client, wrapper } = setup([ok]);
    const { result } = renderHook(() => usePolled(client, "getSystem"), { wrapper });
    expect(result.current.intervalMs).toBe(15_000);
  });
});
