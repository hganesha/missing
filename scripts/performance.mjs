import { randomUUID } from "node:crypto";

const base = (process.env.PERF_CONTROL_API_URL ?? "http://127.0.0.1:4100").replace(/\/$/, "");
const planDigest = process.env.PERF_PLAN_DIGEST;
if (!planDigest) throw new Error("PERF_PLAN_DIGEST is required");

const mode = process.env.PERF_MODE ?? "load";
const concurrency = integer("PERF_CONCURRENCY", 16, 1, 256);
const requests = integer("PERF_REQUESTS", 100, 1, 1_000_000);
const soakSeconds = integer("PERF_SOAK_SECONDS", 300, 1, 86_400);
const maxErrorRate = number("PERF_MAX_ERROR_RATE", 0.01, 0, 1);
const maxBackpressureRate = number("PERF_MAX_BACKPRESSURE_RATE", 0.05, 0, 1);
const maxP95Ms = number("PERF_MAX_P95_MS", 2_000, 1, 3_600_000);
const completionTimeoutMs = integer("PERF_COMPLETION_TIMEOUT_MS", 600_000, 1_000, 86_400_000);
const input = JSON.parse(process.env.PERF_RUN_INPUT ?? "{}");
const headers = {
  "content-type": "application/json",
  authorization: `Bearer ${process.env.PERF_EDGE_SERVICE_TOKEN ?? "local-edge-service-token-change-before-sharing"}`,
  "x-actor-id": process.env.PERF_ACTOR_ID ?? "performance-test",
  "x-actor-roles": process.env.PERF_ACTOR_ROLES ?? "Harness.Reader,Harness.Operator",
  "x-tenant-id": process.env.PERF_TENANT_ID ?? "tenant_demo",
};

function integer(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`${name}.invalid`);
  return value;
}

function number(name, fallback, minimum, maximum) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name}.invalid`);
  return value;
}

async function json(path, init) {
  const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...init?.headers } });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

const planResult = await json(`/v1/plans/${encodeURIComponent(planDigest)}`);
if (!planResult.response.ok) throw new Error(`plan.fetch_failed:${planResult.response.status}`);
const budgets = planResult.body.budgets;

// The same key and payload must collapse to one run even under concurrent admission.
const replayKey = `perf-replay-${randomUUID()}`;
const replays = await Promise.all(Array.from({ length: concurrency }, () => json("/v1/runs", {
  method: "POST", headers: { "idempotency-key": replayKey }, body: JSON.stringify({ planDigest, input }),
})));
const replayIds = new Set(replays.map(({ body }) => body.run?.runId).filter(Boolean));
if (replayIds.size !== 1 || replays.some(({ response }) => !response.ok)) throw new Error("idempotency.concurrent_replay_failed");

const startedAt = Date.now();
const latencies = [];
const runIds = [];
let attempted = 0;
let allocated = 0;
let failed = 0;
let backpressured = 0;
const deadline = mode === "soak" ? startedAt + soakSeconds * 1_000 : Number.POSITIVE_INFINITY;

async function submit() {
  const start = performance.now();
  const result = await json("/v1/runs", {
    method: "POST",
    headers: { "idempotency-key": `perf-${randomUUID()}` },
    body: JSON.stringify({ planDigest, input }),
  });
  latencies.push(performance.now() - start);
  attempted += 1;
  if (result.response.status === 429) backpressured += 1;
  else if (!result.response.ok || !result.body.run?.runId) failed += 1;
  else runIds.push(result.body.run.runId);
}

await Promise.all(Array.from({ length: concurrency }, async () => {
  while (mode === "soak" ? Date.now() < deadline : allocated < requests) {
    if (mode !== "soak") allocated += 1;
    await submit();
  }
}));

const terminal = new Set(["completed", "failed", "denied", "cancelled"]);
const pending = new Set(runIds);
const completed = [];
const completionDeadline = Date.now() + completionTimeoutMs;
while (pending.size && Date.now() < completionDeadline) {
  await Promise.all([...pending].slice(0, concurrency * 4).map(async (runId) => {
    const result = await json(`/v1/runs/${encodeURIComponent(runId)}`);
    if (result.response.ok && terminal.has(result.body.status)) {
      pending.delete(runId);
      completed.push(result.body);
    }
  }));
  if (pending.size) await new Promise((resolve) => setTimeout(resolve, 250));
}

for (const run of completed) {
  if (run.modelCalls > budgets.maxModelCalls) throw new Error(`quota.model_calls_exceeded:${run.runId}`);
  if (run.capabilityCalls > budgets.maxCapabilityCalls) throw new Error(`quota.capability_calls_exceeded:${run.runId}`);
  if (run.costUsd > budgets.maxCostUsd + Number.EPSILON) throw new Error(`quota.cost_exceeded:${run.runId}`);
}

latencies.sort((left, right) => left - right);
const p95 = latencies[Math.max(0, Math.ceil(latencies.length * 0.95) - 1)] ?? 0;
const errorRate = attempted ? failed / attempted : 1;
const backpressureRate = attempted ? backpressured / attempted : 1;
const summary = {
  mode, attempted, accepted: runIds.length, backpressured, backpressureRate, failed, errorRate,
  admissionP95Ms: Math.round(p95 * 100) / 100,
  terminal: completed.length, timedOut: pending.size,
  elapsedSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
};
process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

if (errorRate > maxErrorRate) throw new Error(`performance.error_rate:${errorRate}`);
if (backpressureRate > maxBackpressureRate) throw new Error(`performance.backpressure_rate:${backpressureRate}`);
if (!runIds.length) throw new Error("performance.no_runs_admitted");
if (p95 > maxP95Ms) throw new Error(`performance.p95:${p95}`);
if (pending.size) throw new Error(`performance.completion_timeout:${pending.size}`);
