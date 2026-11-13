import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { clientKey, createRateLimiter, rateLimitRequests } from "./index.js";

describe("rate limiting", () => {
  it("allows max requests per window per client, then reopens", () => {
    const limiter = createRateLimiter({ max: 2, windowMs: 10_000 });
    expect([limiter.take("a", 0), limiter.take("a", 1), limiter.take("a", 2)].map((d) => d.allowed)).toEqual([true, true, false]);
    expect(limiter.take("a", 2).retryAfterSeconds).toBe(10);
    expect(limiter.take("b", 3).allowed).toBe(true);
    expect(limiter.take("a", 10_000).allowed).toBe(true);
  });
  it("refuses new clients while the table is full of live windows, and frees expired ones", () => {
    const limiter = createRateLimiter({ max: 5, windowMs: 1_000, maxClients: 2 });
    limiter.take("a", 0); limiter.take("b", 0);
    expect(limiter.take("c", 10).allowed).toBe(false);
    expect(limiter.take("a", 20).allowed).toBe(true);
    expect(limiter.take("c", 1_500).allowed).toBe(true);
    expect(limiter.size).toBe(1);
  });
  it("keys on a digest of the credential, never the credential, and falls back to the address", () => {
    const withToken = clientKey({ ip: "10.0.0.1", url: "/", headers: { authorization: "Bearer secret-token" } });
    expect(withToken).toMatch(/^c:[a-f0-9]{32}$/);
    expect(withToken).not.toContain("secret");
    expect(clientKey({ ip: "10.0.0.1", url: "/", headers: { cookie: "a=1; session=abc" } }, "session")).toMatch(/^c:/);
    expect(clientKey({ ip: "10.0.0.1", url: "/", headers: {} })).toBe("ip:10.0.0.1");
  });
  it("returns 429 with Retry-After over the limit and never limits health probes", async () => {
    const app = Fastify();
    rateLimitRequests(app, { max: 1, windowMs: 60_000 });
    app.get("/api/x", async () => ({ ok: true }));
    app.get("/health/ready", async () => ({ status: "ready" }));
    expect((await app.inject({ url: "/api/x" })).statusCode).toBe(200);
    const limited = await app.inject({ url: "/api/x" });
    expect([limited.statusCode, limited.headers["retry-after"], limited.json()]).toEqual([429, "60", { error: "request.rate_limited" }]);
    for (let i = 0; i < 3; i += 1) expect((await app.inject({ url: "/health/ready" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/api/x", headers: { authorization: "Bearer other" } })).statusCode).toBe(200);
    await app.close();
  });
});
