import { describe, expect, it } from "vitest";
import type { SkillExecutionRequestV1 } from "@ehf/contracts";
import { fetchSkillBundleLock, runSkillExecution, type SkillHostConnection } from "./skill-host.js";

type Reply = { status: number; body?: unknown };

function host(replies: (url: URL, method: string) => Reply, clock = { now: 0 }) {
  const calls: Array<{ method: string; path: string; headers: Headers }> = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push({ method: init.method ?? "GET", path: url.pathname, headers: new Headers(init.headers) });
    const reply = replies(url, init.method ?? "GET");
    return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  const connection: SkillHostConnection = {
    baseUrl: new URL("https://skills.internal/base"), token: async () => "host-token", fetch,
    now: () => clock.now, sleep: async (ms) => { clock.now += ms; },
  };
  return { connection, calls };
}

const request = { contract_version: "skill.execution.v1", execution_id: "inv-1", skill_id: "sample.evidence.check" } as SkillExecutionRequestV1;
const response = (lifecycle: string, extra: Record<string, unknown> = {}) => ({
  contract_version: "skill.execution.v1", execution_id: "inv-1", lifecycle, computation: null, error: null, trace: { subskill_executions: [] }, ...extra,
});
const completed = response("COMPLETED_EXECUTION", {
  computation: { business_status: "NEEDS_EVIDENCE", payload: {}, unresolved_items: [{ code: "CONTEXT_MISSING", subject_ref: "", explanation: "x" }], metrics: { duration_ms: 1, capability_calls: 0, model_calls: 0 } },
});

describe("skill host client", () => {
  it("starts with the idempotency key and polls a 202 to a terminal response", async () => {
    let polls = 0;
    const { connection, calls } = host((url, method) => {
      if (method === "POST") return { status: 202, body: { execution_id: "inv-1", status: "RUNNING" } };
      polls += 1;
      return { status: 200, body: polls < 3 ? response("RUNNING") : completed };
    });
    const result = await runSkillExecution(connection, { request, deadlineMs: 60_000, traceparent: "00-a-b-01" });
    expect(result.lifecycle).toBe("COMPLETED_EXECUTION");
    expect(calls[0]).toMatchObject({ method: "POST", path: "/base/v1/skills/sample.evidence.check/executions" });
    expect(calls[0]!.headers.get("idempotency-key")).toBe("inv-1");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer host-token");
    expect(calls[0]!.headers.get("traceparent")).toBe("00-a-b-01");
    expect(calls.slice(1).every((call) => call.path === "/base/v1/skills/executions/inv-1")).toBe(true);
  });

  it("reports an unknown execution as unknown, never as a result", async () => {
    const { connection } = host((_url, method) => (method === "POST" ? { status: 202, body: { execution_id: "inv-1", status: "RUNNING" } } : { status: 404 }));
    await expect(runSkillExecution(connection, { request, deadlineMs: 60_000 })).rejects.toThrow("adapter.skills_execution_unknown");
  });

  it("cancels at the deadline and on abort", async () => {
    const running = host((url, method) => (method === "POST" && !url.pathname.endsWith("/cancel")
      ? { status: 202, body: { execution_id: "inv-1", status: "RUNNING" } } : { status: 200, body: response("RUNNING") }));
    await expect(runSkillExecution(running.connection, { request, deadlineMs: 1_000 })).rejects.toThrow("adapter.skills_timeout");
    expect(running.calls.at(-1)?.path).toBe("/base/v1/skills/executions/inv-1/cancel");
    const controller = new AbortController();
    controller.abort();
    const aborted = host(() => ({ status: 200, body: completed }));
    await expect(runSkillExecution(aborted.connection, { request, deadlineMs: 60_000, signal: controller.signal })).rejects.toThrow("adapter.skills_cancelled");
  });

  it("maps refusals per §10 and refuses malformed answers", async () => {
    const cases: Array<[Reply, string]> = [
      [{ status: 400, body: { error: { code: "INPUT_INVALID" } } }, "adapter.skills_request_invalid"],
      [{ status: 401 }, "adapter.skills_access_denied"],
      [{ status: 404, body: { error: { code: "INPUT_INVALID" } } }, "adapter.skills_skill_unknown_input_invalid"],
      [{ status: 409, body: { error: { code: "INTEGRITY_FAILURE" } } }, "adapter.skills_integrity_failure_pin_refused"],
      [{ status: 409, body: { error: { code: "INPUT_INVALID" } } }, "adapter.skills_idempotency_key_reused_input_invalid"],
      [{ status: 429, body: { error: { code: "RATE_LIMITED" } } }, "adapter.skills_http_429_rate_limited"],
      [{ status: 503, body: { error: { code: "SOURCE_UNAVAILABLE" } } }, "adapter.skills_http_503_source_unavailable"],
      [{ status: 200, body: { ...completed, unexpected: true } }, "adapter.skills_integrity_response_invalid"],
      [{ status: 200, body: { ...completed, execution_id: "inv-2" } }, "adapter.skills_integrity_execution_mismatch"],
      [{ status: 302 }, "adapter.skills_redirect_refused"],
    ];
    for (const [reply, expected] of cases) {
      const { connection } = host(() => reply);
      await expect(runSkillExecution(connection, { request, deadlineMs: 60_000 }), expected).rejects.toThrow(expected);
    }
    const { connection } = host(() => ({ status: 200, body: { bundle_id: "x" } }));
    await expect(fetchSkillBundleLock(connection)).rejects.toThrow("adapter.skills_integrity_bundle_lock_invalid");
  });
});
