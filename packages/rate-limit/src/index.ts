import { createHash } from "node:crypto";

/**
 * Fixed-window, per-client request limiting for the platform's HTTP edges.
 *
 * The client is the caller's credential, not its address: behind a platform ingress every
 * request arrives from the proxy, so an IP key would put all users in one bucket. The key
 * is a digest of the session cookie or bearer token when one is present (never the value
 * itself), and the socket address otherwise. State is per replica and bounded; when the
 * table is full of live windows, new clients are refused rather than evicting active ones.
 */
export type RateLimitOptions = {
  /** Requests allowed per client per window. */
  max: number;
  windowMs: number;
  /** Upper bound on tracked clients per replica. */
  maxClients?: number;
};

export type RateLimitDecision = { allowed: boolean; retryAfterSeconds: number };

export function createRateLimiter(options: RateLimitOptions) {
  const { max, windowMs } = options;
  const maxClients = options.maxClients ?? 10_000;
  if (!Number.isInteger(max) || max < 1 || !Number.isInteger(windowMs) || windowMs < 1_000 || !Number.isInteger(maxClients) || maxClients < 1) throw new Error("rate_limit.options_invalid");
  const windows = new Map<string, { count: number; resetAt: number }>();
  let nextSweep = 0;
  return {
    take(key: string, now = Date.now()): RateLimitDecision {
      if (now >= nextSweep || windows.size >= maxClients) {
        for (const [client, window] of windows) if (window.resetAt <= now) windows.delete(client);
        nextSweep = now + windowMs;
      }
      let window = windows.get(key);
      if (!window || window.resetAt <= now) {
        if (!window && windows.size >= maxClients) return { allowed: false, retryAfterSeconds: Math.ceil(windowMs / 1000) };
        window = { count: 0, resetAt: now + windowMs };
        windows.set(key, window);
      }
      window.count += 1;
      return { allowed: window.count <= max, retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)) };
    },
    get size() { return windows.size; },
  };
}

type Request = { ip: string; url: string; headers: Record<string, string | string[] | undefined> };
type Reply = { code(status: number): Reply; header(name: string, value: string): Reply; send(body: unknown): unknown };
type HookTarget = { addHook(name: "onRequest", hook: (request: Request, reply: Reply) => Promise<unknown>): unknown };

/** The client key: a digest of the session cookie or bearer credential, else the socket address. */
export function clientKey(request: Request, sessionCookie?: string): string {
  const authorization = request.headers.authorization;
  const bearer = typeof authorization === "string" && authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const cookie = sessionCookie ? String(request.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith(`${sessionCookie}=`))?.slice(sessionCookie.length + 1) ?? "" : "";
  const credential = bearer || cookie;
  return credential ? `c:${createHash("sha256").update(credential).digest("hex").slice(0, 32)}` : `ip:${request.ip}`;
}

/**
 * Rate-limits every request to a Fastify app (an onRequest hook), except paths a platform
 * probe calls. Over the limit the client gets 429 with Retry-After.
 */
export function rateLimitRequests(app: HookTarget, options: RateLimitOptions & { sessionCookie?: string; exempt?: RegExp; error?: string }) {
  const limiter = createRateLimiter(options);
  const exempt = options.exempt ?? /^\/(health(\/|z?$)|healthz$)/;
  app.addHook("onRequest", async (request, reply) => {
    if (exempt.test(request.url.split("?")[0]!)) return;
    const decision = limiter.take(clientKey(request, options.sessionCookie));
    if (!decision.allowed) return reply.code(429).header("retry-after", String(decision.retryAfterSeconds)).send({ error: options.error ?? "request.rate_limited" });
  });
  return limiter;
}
