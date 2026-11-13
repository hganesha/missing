import { z } from "zod";

/**
 * Connection health of what the platform depends on, as shown on the Health screen.
 *
 * Each service reports the dependencies only it can reach (`GET /v1/platform/dependencies`):
 * its stores, the runtime host, the hosts and endpoints its adapters call. The experience BFF
 * adds the services themselves and returns one list. Every status comes from a call made for
 * that report; nothing is inferred from configuration alone. Details are short and fixed:
 * they never carry a host name, a URL, a credential or an upstream error body.
 */
export const DEPENDENCY_STATUSES = ["Ready", "Degraded", "Unavailable", "NotConfigured", "Unknown"] as const;
export type DependencyStatus = typeof DEPENDENCY_STATUSES[number];
export const DEPENDENCY_GROUPS = ["service", "store", "runtime", "endpoint"] as const;
export type DependencyGroup = typeof DEPENDENCY_GROUPS[number];

export const dependencyComponentSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._:-]{0,99}$/),
  name: z.string().min(1).max(120),
  group: z.enum(DEPENDENCY_GROUPS),
  status: z.enum(DEPENDENCY_STATUSES),
  detail: z.string().max(240),
  /** How long the check took; null when nothing was called. */
  latencyMs: z.number().int().min(0).nullable(),
}).strict();
export type DependencyComponent = z.infer<typeof dependencyComponentSchema>;

export const dependencyReportSchema = z.object({ components: z.array(dependencyComponentSchema).max(100) }).strict();
export type DependencyReport = z.infer<typeof dependencyReportSchema>;

export const platformHealthSchema = z.object({
  generatedAt: z.string(),
  overall: z.enum(["Ready", "Degraded", "Unavailable"]),
  components: z.array(dependencyComponentSchema.extend({ reportedBy: z.string().max(60) }).strict()).max(300),
}).strict();
export type PlatformHealth = z.infer<typeof platformHealthSchema>;

type Described = { id: string; name: string; group: DependencyGroup };
type Outcome = { status: DependencyStatus; detail: string };

export const notConfigured = (component: Described, detail = "Not configured in this deployment."): DependencyComponent =>
  ({ ...component, status: "NotConfigured", detail, latencyMs: null });

/**
 * Run one check and time it. A check that throws or exceeds the timeout is Unavailable with a
 * fixed detail: the error may name hosts or carry upstream text, so it is not reported.
 */
export async function checkDependency(component: Described, check: (signal: AbortSignal) => Promise<Outcome | void>, timeoutMs = 5_000): Promise<DependencyComponent> {
  const started = Date.now();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      check(controller.signal),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeoutMs); }),
    ]);
    return { ...component, status: outcome?.status ?? "Ready", detail: outcome?.detail ?? "Responding.", latencyMs: Date.now() - started };
  } catch (error) {
    const timedOut = error instanceof Error && error.message === "timeout";
    return { ...component, status: "Unavailable", detail: timedOut ? `No response within ${Math.round(timeoutMs / 1000)} seconds.` : "The check failed.", latencyMs: Date.now() - started };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A health endpoint of another service: any 2xx answer is Ready. */
export function httpHealthCheck(fetcher: typeof fetch, url: URL, headers: Record<string, string> = {}) {
  return async (signal: AbortSignal): Promise<Outcome> => {
    const response = await fetcher(url, { headers, redirect: "error", signal });
    const body=await response.json().catch(()=>null) as {status?:string}|null;
    if (response.ok) return body?.status==="degraded" ? {status:"Degraded",detail:"Responding with degraded dependencies."} : { status: "Ready", detail: "Responding." };
    if (response.status === 401 || response.status === 403) return { status: "Degraded", detail: "Reachable, but the credential was refused." };
    return { status: "Unavailable", detail: `Answered with HTTP ${response.status}.` };
  };
}

/**
 * The platform's readiness from its parts. A service, store or runtime that is down makes the
 * platform Unavailable; a degraded part or an unreachable endpoint (one adapter's dependency)
 * makes it Degraded. Parts that are not configured do not count; an unknown part degrades.
 */
export function overallReadiness(components: ReadonlyArray<Pick<DependencyComponent, "group" | "status">>): PlatformHealth["overall"] {
  if (components.some(item => item.status === "Unavailable" && item.group !== "endpoint")) return "Unavailable";
  if (components.some(item => item.status === "Unavailable" || item.status === "Degraded" || item.status === "Unknown")) return "Degraded";
  return "Ready";
}

/** Reports cached briefly per key, so a polled screen with several viewers does not multiply the calls. */
export function cachedReport<T>(ttlMs: number, now: () => number = Date.now) {
  const cache = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string, produce: () => Promise<T>): Promise<T> => {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = produce();
    cache.set(key, { at: now(), value });
    value.catch(() => cache.delete(key));
    if (cache.size > 500) for (const [stale, entry] of cache) if (now() - entry.at >= ttlMs) cache.delete(stale);
    return value;
  };
}
