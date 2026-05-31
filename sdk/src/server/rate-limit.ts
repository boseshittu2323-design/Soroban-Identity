// Token-bucket rate limiter middleware (#254).
//
// Keyed by API key id (when authenticated) or remote IP. Returns the
// standard `X-RateLimit-*` headers on every response and emits
// `429 Too Many Requests` + `Retry-After` when exhausted. Per-route
// limits configurable via constructor; defaults match the issue:
//   - 60 reads/minute
//   - 20 writes/minute

import { SorobanIdentityError } from "../errors";
import type { AuthContext } from "./api-keys";

export type RateClass = "read" | "write";

export interface RateLimitConfig {
  /** Tokens replenished per `windowMs`. */
  limit: number;
  /** Window length in ms. */
  windowMs: number;
}

export interface RateLimitOptions {
  read?: Partial<RateLimitConfig>;
  write?: Partial<RateLimitConfig>;
  /** Per-key overrides — keyed by `apiKeyId` or `ip:<address>`. */
  overrides?: Record<string, Partial<Record<RateClass, RateLimitConfig>>>;
  now?: () => number;
  /** How to derive the bucket key from the request. Defaults to
   *  `req.auth?.apiKey.id` falling back to `ip:<req.ip>`. */
  keyFn?: (req: RequestLike) => string;
}

export const RATE_LIMIT_DEFAULTS: Record<RateClass, RateLimitConfig> = {
  read: { limit: 60, windowMs: 60_000 },
  write: { limit: 20, windowMs: 60_000 },
};

interface Bucket {
  tokens: number;
  lastRefillAt: number;
  config: RateLimitConfig;
}

export class TokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private readonly overrides: NonNullable<RateLimitOptions["overrides"]>;
  private readonly readConfig: RateLimitConfig;
  private readonly writeConfig: RateLimitConfig;

  constructor(options: RateLimitOptions = {}) {
    this.now = options.now ?? Date.now;
    this.overrides = options.overrides ?? {};
    this.readConfig = { ...RATE_LIMIT_DEFAULTS.read, ...options.read };
    this.writeConfig = { ...RATE_LIMIT_DEFAULTS.write, ...options.write };
  }

  /** Returns the post-consume state. `allowed === false` means the
   *  caller should reject with 429 and propagate the headers. */
  consume(
    key: string,
    rateClass: RateClass,
  ): { allowed: boolean; limit: number; remaining: number; resetAt: number; retryAfterMs: number } {
    const config = this.resolveConfig(key, rateClass);
    const now = this.now();
    const bucket = this.buckets.get(key) ?? {
      tokens: config.limit,
      lastRefillAt: now,
      config,
    };
    // Refill — fractional tokens added based on elapsed window slice.
    const elapsed = Math.max(0, now - bucket.lastRefillAt);
    if (elapsed > 0) {
      const refill = (elapsed / config.windowMs) * config.limit;
      bucket.tokens = Math.min(config.limit, bucket.tokens + refill);
      bucket.lastRefillAt = now;
      bucket.config = config;
    }
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    this.buckets.set(key, bucket);
    const remaining = Math.max(0, Math.floor(bucket.tokens));
    // Reset is at the next full window boundary based on last refill.
    const resetAt = Math.ceil((bucket.lastRefillAt + config.windowMs) / 1000);
    const retryAfterMs = allowed ? 0 : Math.max(1, Math.ceil(config.windowMs / config.limit));
    return { allowed, limit: config.limit, remaining, resetAt, retryAfterMs };
  }

  private resolveConfig(key: string, rateClass: RateClass): RateLimitConfig {
    const override = this.overrides[key]?.[rateClass];
    if (override) return override;
    return rateClass === "read" ? this.readConfig : this.writeConfig;
  }
}

type RequestLike = {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  auth?: AuthContext;
};
type ResLike = {
  status(code: number): ResLike;
  json(body: unknown): ResLike;
  setHeader(name: string, value: string | number): void;
};
type NextLike = (err?: unknown) => void;

export interface RateLimitMiddlewareOptions extends RateLimitOptions {
  /** Classify the request as read or write. Default: GET/HEAD/OPTIONS → read. */
  classify?: (req: RequestLike, method: string) => RateClass;
  rateLimiter?: TokenBucketRateLimiter;
}

function defaultKey(req: RequestLike): string {
  return req.auth?.apiKey.id ?? `ip:${req.ip ?? "unknown"}`;
}

function defaultClassify(_req: RequestLike, method: string): RateClass {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD" || m === "OPTIONS" ? "read" : "write";
}

export function createRateLimitMiddleware(options: RateLimitMiddlewareOptions = {}) {
  const limiter = options.rateLimiter ?? new TokenBucketRateLimiter(options);
  const keyFn = options.keyFn ?? defaultKey;
  const classifyFn = options.classify ?? defaultClassify;
  return function rateLimit(
    req: RequestLike & { method?: string },
    res: ResLike,
    next: NextLike,
  ): void {
    const key = keyFn(req);
    const rateClass = classifyFn(req, req.method ?? "GET");
    const result = limiter.consume(key, rateClass);
    res.setHeader("X-RateLimit-Limit", result.limit);
    res.setHeader("X-RateLimit-Remaining", result.remaining);
    res.setHeader("X-RateLimit-Reset", result.resetAt);
    if (!result.allowed) {
      const retryAfterSeconds = Math.ceil(result.retryAfterMs / 1000);
      res.setHeader("Retry-After", retryAfterSeconds);
      const err = new SorobanIdentityError("rate limit exceeded", {
        code: "RATE_LIMITED",
        details: { limit: result.limit, resetAt: result.resetAt, retryAfterMs: result.retryAfterMs },
      });
      res.status(429).json({ error: err.toEnvelope() });
      return;
    }
    next();
  };
}
