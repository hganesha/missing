import {
  skillBundleLockSchema,
  skillExecutionAcceptedSchema,
  skillExecutionResponseV1Schema,
  skillHostErrorBodySchema,
  type SkillBundleLock,
  type SkillExecutionRequestV1,
  type SkillExecutionResponseV1,
} from "@ehf/contracts";
import { MAX_RESPONSE_BYTES, type AccessTokenProvider, type Fetch } from "./cloud-http.js";

/**
 * Wire client for a skill host (skill.execution.v1, docs/implementation/skill-library-integration-contract.md §4).
 *
 * Transport rules as for every cloud adapter: an AbortSignal-bounded request, redirects refused,
 * bodies capped, and failures thrown as `adapter.skills_*` codes that never carry a response
 * body or a credential. The codes are chosen so the runtime's §4.3 mapping (`skillErrorCodeFor`)
 * reads them correctly: `…_denied` → ACCESS_DENIED, `…_integrity_…` → INTEGRITY_FAILURE,
 * `…_timeout` → TIMEOUT, `…_429…` → RATE_LIMITED, `…_unavailable` → SOURCE_UNAVAILABLE,
 * `…_invalid` → INPUT_INVALID.
 */

export type SkillHostConnection = {
  baseUrl: URL;
  token: AccessTokenProvider;
  fetch: Fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

type Reply = { status: number; body: unknown };

const PREFIX = "adapter.skills";

function hostUrl(connection: SkillHostConnection, path: string): URL {
  const url = new URL(connection.baseUrl.toString());
  let base = url.pathname;
  // A loop rather than /\/+$/, which backtracks polynomially on long runs of "/".
  while (base.endsWith("/")) base = base.slice(0, -1);
  url.pathname = `${base}${path}`;
  return url;
}

async function call(connection: SkillHostConnection, method: "GET" | "POST", path: string, input: {
  body?: unknown; headers?: Record<string, string>; timeoutMs: number; signal?: AbortSignal;
}): Promise<Reply> {
  const token = await connection.token();
  const signals = [AbortSignal.timeout(Math.max(1, Math.min(Math.floor(input.timeoutMs), 600_000)))];
  if (input.signal) signals.push(input.signal);
  let response: Response;
  try {
    response = await connection.fetch(hostUrl(connection, path), {
      method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        ...(input.body === undefined ? {} : { "content-type": "application/json" }),
        ...input.headers,
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      redirect: "error",
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    if (input.signal?.aborted) throw new Error(`${PREFIX}_cancelled`);
    const name = error instanceof Error ? error.name : "";
    throw new Error(name === "TimeoutError" || name === "AbortError" ? `${PREFIX}_timeout` : `${PREFIX}_unreachable`);
  }
  if (response.status >= 300 && response.status < 400) throw new Error(`${PREFIX}_redirect_refused`);
  if (Number(response.headers.get("content-length") ?? "0") > MAX_RESPONSE_BYTES) throw new Error(`${PREFIX}_integrity_response_too_large`);
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new Error(`${PREFIX}_timeout`);
  }
  if (text.length > MAX_RESPONSE_BYTES) throw new Error(`${PREFIX}_integrity_response_too_large`);
  let body: unknown = null;
  if (text.trim()) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      if (response.ok) throw new Error(`${PREFIX}_integrity_response_not_json`);
    }
  }
  return { status: response.status, body };
}

/** §10 HTTP mapping for a refused start, status or cancel. */
export function skillHostFailure(status: number, body: unknown, operation: "start" | "status" | "bundle"): Error {
  const parsed = skillHostErrorBodySchema.safeParse(body);
  const code = parsed.success ? parsed.data.error.code : null;
  if (status === 400) return new Error(`${PREFIX}_request_invalid`);
  if (status === 401 || status === 403) return new Error(code === "ACCESS_DENIED" || !code ? `${PREFIX}_access_denied` : `${PREFIX}_denied_${code.toLowerCase()}`);
  if (status === 404) return new Error(operation === "status" ? `${PREFIX}_execution_unknown` : `${PREFIX}_skill_unknown_input_invalid`);
  if (status === 409) return new Error(code === "INPUT_INVALID" ? `${PREFIX}_idempotency_key_reused_input_invalid` : `${PREFIX}_integrity_failure_pin_refused`);
  if (status === 429) return new Error(`${PREFIX}_http_429_rate_limited`);
  if (status === 503) return new Error(`${PREFIX}_http_503_source_unavailable`);
  return new Error(`${PREFIX}_http_${status}`);
}

/** `GET /v1/bundle`, validated as a bundle lock. */
export async function fetchSkillBundleLock(connection: SkillHostConnection, timeoutMs = 10_000): Promise<SkillBundleLock> {
  const reply = await call(connection, "GET", "/v1/bundle", { timeoutMs });
  if (reply.status !== 200) throw skillHostFailure(reply.status, reply.body, "bundle");
  const parsed = skillBundleLockSchema.safeParse(reply.body);
  if (!parsed.success) throw new Error(`${PREFIX}_integrity_bundle_lock_invalid`);
  return parsed.data;
}

function parseResponse(body: unknown, executionId: string): SkillExecutionResponseV1 {
  const parsed = skillExecutionResponseV1Schema.safeParse(body);
  if (!parsed.success) throw new Error(`${PREFIX}_integrity_response_invalid`);
  if (parsed.data.execution_id !== executionId) throw new Error(`${PREFIX}_integrity_execution_mismatch`);
  return parsed.data;
}

export async function getSkillExecution(connection: SkillHostConnection, executionId: string, timeoutMs: number, signal?: AbortSignal): Promise<SkillExecutionResponseV1> {
  const reply = await call(connection, "GET", `/v1/skills/executions/${encodeURIComponent(executionId)}`, { timeoutMs, ...(signal ? { signal } : {}) });
  // 404 is "unknown": never read as a result, never a reason to re-run blindly.
  if (reply.status !== 200) throw skillHostFailure(reply.status, reply.body, "status");
  return parseResponse(reply.body, executionId);
}

/** Best effort; the final state is reported through status. Never throws. */
export async function cancelSkillExecution(connection: SkillHostConnection, executionId: string, reason: string): Promise<void> {
  await call(connection, "POST", `/v1/skills/executions/${encodeURIComponent(executionId)}/cancel`, { body: { reason }, timeoutMs: 5_000 }).catch(() => undefined);
}

export type SkillExecutionCall = {
  request: SkillExecutionRequestV1;
  /** Absolute deadline (epoch ms) for the whole call, polling included. */
  deadlineMs: number;
  traceparent?: string;
  signal?: AbortSignal;
};

/**
 * `POST /v1/skills/{skill_id}/executions` with `Idempotency-Key` = execution id, then (on 202)
 * poll status until a terminal lifecycle or the deadline. At the deadline or on abort the
 * execution is cancelled (best effort) and the call fails; it never returns a guessed result.
 */
export async function runSkillExecution(connection: SkillHostConnection, input: SkillExecutionCall): Promise<SkillExecutionResponseV1> {
  const now = connection.now ?? Date.now;
  const sleep = connection.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const { request } = input;
  const remaining = () => input.deadlineMs - now();
  const abandon = async (code: string): Promise<never> => {
    await cancelSkillExecution(connection, request.execution_id, code);
    throw new Error(code);
  };
  if (input.signal?.aborted) throw new Error(`${PREFIX}_cancelled`);
  let reply: Reply;
  try {
    reply = await call(connection, "POST", `/v1/skills/${encodeURIComponent(request.skill_id)}/executions`, {
      body: request,
      headers: { "idempotency-key": request.execution_id, ...(input.traceparent ? { traceparent: input.traceparent } : {}) },
      timeoutMs: remaining(),
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    // The host may have accepted the execution before the transport failed: cancel it.
    if (message === `${PREFIX}_timeout` || message === `${PREFIX}_cancelled`) return abandon(message);
    throw error;
  }
  let response: SkillExecutionResponseV1;
  if (reply.status === 200) {
    response = parseResponse(reply.body, request.execution_id);
  } else if (reply.status === 202) {
    const accepted = skillExecutionAcceptedSchema.safeParse(reply.body);
    if (!accepted.success || accepted.data.execution_id !== request.execution_id) throw new Error(`${PREFIX}_integrity_response_invalid`);
    response = { contract_version: request.contract_version, execution_id: request.execution_id, lifecycle: "RUNNING", computation: null, error: null, trace: { subskill_executions: [] } };
  } else {
    throw skillHostFailure(reply.status, reply.body, "start");
  }
  let delay = 200;
  while (response.lifecycle === "RUNNING") {
    if (input.signal?.aborted) return abandon(`${PREFIX}_cancelled`);
    if (remaining() <= 0) return abandon(`${PREFIX}_timeout`);
    await sleep(Math.min(delay, Math.max(1, remaining())));
    delay = Math.min(2_000, Math.ceil(delay * 1.5));
    if (input.signal?.aborted) return abandon(`${PREFIX}_cancelled`);
    if (remaining() <= 0) return abandon(`${PREFIX}_timeout`);
    try {
      response = await getSkillExecution(connection, request.execution_id, remaining(), input.signal);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === `${PREFIX}_timeout` || message === `${PREFIX}_cancelled`) return abandon(message);
      throw error;
    }
  }
  return response;
}
