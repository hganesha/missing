import { describe, expect, it, vi } from "vitest";
import { cachedReport, checkDependency, httpHealthCheck, notConfigured, overallReadiness, platformHealthSchema } from "./platform-health.js";

const store = { id: "case-store", name: "Case store", group: "store" as const };

describe("platform health checks", () => {
  it("times a passing check and reports a failing one without its error text", async () => {
    expect(await checkDependency(store, async () => {})).toMatchObject({ ...store, status: "Ready", detail: "Responding." });
    const failed = await checkDependency(store, async () => { throw new Error("connect ECONNREFUSED 10.40.2.4:5432 password=hunter2"); });
    expect(failed).toMatchObject({ status: "Unavailable", detail: "The check failed." });
    expect(JSON.stringify(failed)).not.toMatch(/10\.40|hunter2/);
  });

  it("gives up on a check that does not answer and aborts it", async () => {
    let aborted = false;
    const hung = await checkDependency(store, (signal) => new Promise<void>(() => { signal.addEventListener("abort", () => { aborted = true; }); }), 20);
    expect(hung).toMatchObject({ status: "Unavailable", detail: "No response within 0 seconds." });
    expect(aborted).toBe(true);
  });

  it("reads another service's health endpoint", async () => {
    const answering = (status: number) => (async () => new Response("{}", { status })) as unknown as typeof fetch;
    const url = new URL("https://skill-host.internal.example/healthz");
    const signal = new AbortController().signal;
    expect(await httpHealthCheck(answering(200), url)(signal)).toEqual({ status: "Ready", detail: "Responding." });
    expect((await httpHealthCheck(answering(403), url)(signal)).status).toBe("Degraded");
    expect(await httpHealthCheck(answering(502), url)(signal)).toEqual({ status: "Unavailable", detail: "Answered with HTTP 502." });
  });

  it("derives overall readiness from the parts", () => {
    const part = (group: "service" | "store" | "runtime" | "endpoint", status: "Ready" | "Degraded" | "Unavailable" | "NotConfigured" | "Unknown") => ({ group, status });
    expect(overallReadiness([part("service", "Ready"), part("endpoint", "NotConfigured")])).toBe("Ready");
    expect(overallReadiness([part("service", "Ready"), part("endpoint", "Unavailable")])).toBe("Degraded");
    expect(overallReadiness([part("store", "Ready"), part("runtime", "Unknown")])).toBe("Degraded");
    expect(overallReadiness([part("store", "Unavailable"), part("service", "Ready")])).toBe("Unavailable");
  });

  it("reuses a report for its lifetime and forgets a failed one", async () => {
    let clock = 0;
    const reports = cachedReport<number>(1000, () => clock);
    const produce = vi.fn(async () => 1);
    await reports("tenant", produce); await reports("tenant", produce); await reports("other", produce);
    expect(produce).toHaveBeenCalledTimes(2);
    clock = 1000;
    await reports("tenant", produce);
    expect(produce).toHaveBeenCalledTimes(3);
    await expect(reports("failing", async () => { throw new Error("down"); })).rejects.toThrow("down");
    await expect(reports("failing", async () => 2)).resolves.toBe(2);
  });

  it("accepts only the documented shape", () => {
    const component = { ...notConfigured(store), reportedBy: "case-api" };
    expect(platformHealthSchema.safeParse({ generatedAt: "2026-11-09T00:00:00Z", overall: "Ready", components: [component] }).success).toBe(true);
    expect(platformHealthSchema.safeParse({ generatedAt: "now", overall: "Ready", components: [{ ...component, endpoint: "https://x" }] }).success).toBe(false);
  });
});
