import { describe, it, expect } from "vitest";
import { TokenBucketRateLimiter, createRateLimitMiddleware } from "./rate-limit";

function captureRes() {
  const headers: Record<string, string | number> = {};
  const out: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      out.status = code;
      return res;
    },
    json(body: unknown) {
      out.body = body;
      return res;
    },
    setHeader(name: string, value: string | number) {
      headers[name] = value;
    },
  };
  return { res, out, headers };
}

describe("TokenBucketRateLimiter (#254)", () => {
  it("allows requests up to the configured limit then 429s", () => {
    let now = 1_000;
    const limiter = new TokenBucketRateLimiter({
      read: { limit: 3, windowMs: 60_000 },
      now: () => now,
    });
    const r1 = limiter.consume("k", "read");
    const r2 = limiter.consume("k", "read");
    const r3 = limiter.consume("k", "read");
    const r4 = limiter.consume("k", "read");
    expect(r1.allowed).toBe(true);
    expect(r1.limit).toBe(3);
    expect(r1.remaining).toBe(2);
    expect(r2.remaining).toBe(1);
    expect(r3.remaining).toBe(0);
    expect(r4.allowed).toBe(false);
    expect(r4.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills tokens proportional to elapsed time", () => {
    let now = 1_000;
    const limiter = new TokenBucketRateLimiter({
      read: { limit: 2, windowMs: 1000 },
      now: () => now,
    });
    limiter.consume("k", "read");
    limiter.consume("k", "read");
    expect(limiter.consume("k", "read").allowed).toBe(false);
    // Advance one full window — should be back to limit.
    now += 1000;
    const r = limiter.consume("k", "read");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(1);
  });

  it("applies separate buckets per key", () => {
    const limiter = new TokenBucketRateLimiter({
      read: { limit: 1, windowMs: 1000 },
      now: () => 1_000,
    });
    expect(limiter.consume("a", "read").allowed).toBe(true);
    expect(limiter.consume("b", "read").allowed).toBe(true);
    expect(limiter.consume("a", "read").allowed).toBe(false);
  });

  it("honours per-key overrides", () => {
    const limiter = new TokenBucketRateLimiter({
      read: { limit: 1, windowMs: 1000 },
      overrides: { vip: { read: { limit: 100, windowMs: 1000 } } },
      now: () => 1_000,
    });
    expect(limiter.consume("vip", "read").limit).toBe(100);
  });
});

describe("createRateLimitMiddleware", () => {
  it("emits X-RateLimit-* headers on every allowed response", () => {
    const middleware = createRateLimitMiddleware({
      read: { limit: 5, windowMs: 60_000 },
      now: () => 1_000,
    });
    const req: any = { method: "GET", headers: {}, ip: "1.1.1.1" };
    const { res, headers } = captureRes();
    let nextCalled = false;
    middleware(req, res, () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(headers["X-RateLimit-Limit"]).toBe(5);
    expect(headers["X-RateLimit-Remaining"]).toBe(4);
    expect(Number(headers["X-RateLimit-Reset"])).toBeGreaterThan(0);
  });

  it("emits 429 with Retry-After when exhausted", () => {
    const middleware = createRateLimitMiddleware({
      read: { limit: 1, windowMs: 60_000 },
      now: () => 1_000,
    });
    const req: any = { method: "GET", headers: {}, ip: "1.1.1.1" };
    const { res } = captureRes();
    middleware(req, res, () => {});
    const second = captureRes();
    middleware(req, second.res, () => {});
    expect(second.out.status).toBe(429);
    expect(second.headers["Retry-After"]).toBeDefined();
    expect((second.out.body as any).error.code).toBe("RATE_LIMITED");
  });

  it("classifies non-GET methods as write traffic by default", () => {
    const middleware = createRateLimitMiddleware({
      write: { limit: 1, windowMs: 60_000 },
      now: () => 1_000,
    });
    const req: any = { method: "POST", headers: {}, ip: "1.1.1.1" };
    const { res, headers } = captureRes();
    middleware(req, res, () => {});
    expect(headers["X-RateLimit-Limit"]).toBe(1);
  });

  it("uses the API key id as the bucket key when authenticated", () => {
    const middleware = createRateLimitMiddleware({
      read: { limit: 1, windowMs: 60_000 },
      now: () => 1_000,
    });
    const req: any = {
      method: "GET",
      headers: {},
      auth: { apiKey: { id: "k1", owner: "u", createdAt: 0, scopes: ["read"] } },
    };
    middleware(req, captureRes().res, () => {});
    // Second request from a different IP but same auth → same bucket → 429.
    const second = captureRes();
    middleware({ ...req, ip: "2.2.2.2" }, second.res, () => {});
    expect(second.out.status).toBe(429);
  });
});
