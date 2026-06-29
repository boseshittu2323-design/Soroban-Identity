// Webhook registration + delivery for credential issuance / revocation
// (#252).
//
// Two pieces:
//   1. `WebhookRegistry` — store + management for registrations.
//      Pluggable backing store; `InMemoryWebhookStore` is the default.
//   2. `WebhookDispatcher` — signs payloads (HMAC-SHA256), POSTs to
//      the registered URL, retries with exponential backoff on
//      transient failures (5xx / 429 / network errors), gives up
//      after the configured attempt budget.
//
// Network IO is pluggable so tests stay offline.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SorobanIdentityError } from "../errors";

export type WebhookEvent = "credential.issued" | "credential.revoked";

export const WEBHOOK_EVENTS: ReadonlyArray<WebhookEvent> = ["credential.issued", "credential.revoked"];

export interface WebhookRegistration {
  id: string;
  url: string;
  /** Stored as-provided. Required for HMAC signing on every send. */
  secret: string;
  events: WebhookEvent[];
  createdAt: number;
}

export interface WebhookStore {
  insert(reg: WebhookRegistration): Promise<void>;
  list(): Promise<WebhookRegistration[]>;
  remove(id: string): Promise<boolean>;
  forEvent(event: WebhookEvent): Promise<WebhookRegistration[]>;
}

/**
 * In-process {@link WebhookStore} backed by a plain `Map`.
 *
 * Suitable for tests and single-process deployments. Replace with a
 * persistent store in multi-node production environments.
 */
export class InMemoryWebhookStore implements WebhookStore {
  private readonly byId = new Map<string, WebhookRegistration>();

  async insert(reg: WebhookRegistration): Promise<void> {
    if (this.byId.has(reg.id)) {
      throw new SorobanIdentityError(`webhook ${reg.id} already exists`, {
        code: "ALREADY_EXISTS",
        details: { id: reg.id },
      });
    }
    this.byId.set(reg.id, reg);
  }

  async list(): Promise<WebhookRegistration[]> {
    return Array.from(this.byId.values());
  }

  async remove(id: string): Promise<boolean> {
    return this.byId.delete(id);
  }

  async forEvent(event: WebhookEvent): Promise<WebhookRegistration[]> {
    return Array.from(this.byId.values()).filter((r) => r.events.includes(event));
  }
}

export interface RegisterWebhookInput {
  url: string;
  secret: string;
  events: WebhookEvent[];
}

export interface RegisterWebhookOptions {
  idFn?: () => string;
  now?: () => number;
}

/**
 * Register a new webhook endpoint in `store`.
 *
 * Validates the URL scheme (must be `http` or `https`), secret length (≥ 16
 * characters), and event list (must be a non-empty subset of
 * {@link WEBHOOK_EVENTS}).
 *
 * @param store   Backing store to persist the registration.
 * @param input   URL, secret, and event subscriptions for the new webhook.
 * @param options Optional ID and clock overrides (useful for tests).
 * @returns The persisted {@link WebhookRegistration}.
 * @throws {SorobanIdentityError} with code `INVALID_INPUT` when validation
 *   fails, or `ALREADY_EXISTS` on ID collision.
 *
 * @example
 * ```ts
 * const reg = await registerWebhook(store, {
 *   url: 'https://example.com/hooks',
 *   secret: 'my-secret-passphrase',
 *   events: ['credential.issued'],
 * });
 * ```
 */
export async function registerWebhook(
  store: WebhookStore,
  input: RegisterWebhookInput,
  options: RegisterWebhookOptions = {},
): Promise<WebhookRegistration> {
  if (!/^https?:\/\//u.test(input.url)) {
    throw new SorobanIdentityError("url must be http(s)", { code: "INVALID_INPUT" });
  }
  if (!input.secret || input.secret.length < 16) {
    throw new SorobanIdentityError("secret must be at least 16 characters", { code: "INVALID_INPUT" });
  }
  if (!input.events.length || !input.events.every((e) => WEBHOOK_EVENTS.includes(e))) {
    throw new SorobanIdentityError("events must be a non-empty subset of WEBHOOK_EVENTS", {
      code: "INVALID_INPUT",
      details: { allowed: WEBHOOK_EVENTS, received: input.events },
    });
  }
  const id = (options.idFn ?? (() => randomBytes(8).toString("hex")))();
  const reg: WebhookRegistration = {
    id,
    url: input.url,
    secret: input.secret,
    events: input.events,
    createdAt: (options.now ?? Date.now)(),
  };
  await store.insert(reg);
  return reg;
}

// ── Delivery ────────────────────────────────────────────────────────

export interface FetchResponseLike {
  ok: boolean;
  status: number;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<FetchResponseLike>;

export interface DeliverOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetcher?: FetchLike;
  jitter?: () => number;
}

export interface DeliveryAttempt {
  attempt: number;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface DeliveryResult {
  ok: boolean;
  attempts: DeliveryAttempt[];
}

const HEADER_SIGNATURE = "X-SorobanIdentity-Signature";
const HEADER_EVENT = "X-SorobanIdentity-Event";
const HEADER_ID = "X-SorobanIdentity-Delivery-Id";

/**
 * Compute the HMAC-SHA256 hex signature for a webhook payload.
 *
 * @param secret Webhook secret as provided at registration.
 * @param body   JSON-serialised payload string to sign.
 * @returns 64-character lowercase hex HMAC-SHA256 signature.
 */
export function signPayload(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

/**
 * Verify a webhook payload signature using a timing-safe comparison.
 *
 * @param secret    Webhook secret used to sign the payload.
 * @param body      Raw request body string received from the sender.
 * @param signature Hex signature from the `X-SorobanIdentity-Signature` header.
 * @returns `true` if the signature is valid; `false` otherwise.
 */
export function verifySignature(secret: string, body: string, signature: string): boolean {
  if (typeof signature !== "string") return false;
  const expected = signPayload(secret, body);
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(expected, "hex");
    b = Buffer.from(signature, "hex");
  } catch {
    return false;
  }
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const defaultFetcher: FetchLike = async (url, init) => {
  const r = await fetch(url, init);
  return { ok: r.ok, status: r.status };
};

function backoffMs(attempt: number, base: number, max: number, jitter: number): number {
  const grown = Math.min(max, base * 2 ** attempt);
  return Math.floor(grown * (1 + jitter));
}

/**
 * Signs and delivers webhook payloads with exponential-backoff retry.
 *
 * Each delivery attempt POSTs a JSON body to the registered URL, signed with
 * HMAC-SHA256 under the registration secret. Transient failures (5xx, 429,
 * network errors) are retried up to `maxAttempts` times. Client errors (4xx
 * except 429) fast-fail immediately.
 *
 * @example
 * ```ts
 * const dispatcher = new WebhookDispatcher({ maxAttempts: 3 });
 * const result = await dispatcher.deliver(registration, 'credential.issued', payload);
 * if (!result.ok) console.error('delivery failed', result.attempts);
 * ```
 */
export class WebhookDispatcher {
  /**
   * @param options Retry budget, delay, sleep, fetch, and jitter overrides.
   */
  constructor(private readonly options: DeliverOptions = {}) {}

  async deliver(
    reg: WebhookRegistration,
    event: WebhookEvent,
    data: Record<string, unknown>,
    deliveryId: string = randomBytes(8).toString("hex"),
  ): Promise<DeliveryResult> {
    const maxAttempts = this.options.maxAttempts ?? 5;
    const baseDelay = this.options.baseDelayMs ?? 250;
    const maxDelay = this.options.maxDelayMs ?? 8000;
    const sleep = this.options.sleep ?? defaultSleep;
    const fetcher = this.options.fetcher ?? defaultFetcher;
    const jitter = this.options.jitter ?? (() => 0);

    const body = JSON.stringify({ event, deliveryId, data });
    const signature = signPayload(reg.secret, body);
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      [HEADER_SIGNATURE]: signature,
      [HEADER_EVENT]: event,
      [HEADER_ID]: deliveryId,
    };

    const attempts: DeliveryAttempt[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const resp = await fetcher(reg.url, { method: "POST", headers, body });
        attempts.push({ attempt, ok: resp.ok, status: resp.status });
        if (resp.ok) return { ok: true, attempts };
        // 4xx (except 429) is a misconfiguration — fast-fail.
        if (resp.status >= 400 && resp.status < 500 && resp.status !== 429) {
          return { ok: false, attempts };
        }
      } catch (err) {
        attempts.push({
          attempt,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (attempt < maxAttempts) {
        await sleep(backoffMs(attempt - 1, baseDelay, maxDelay, jitter()));
      }
    }
    return { ok: false, attempts };
  }
}

export const WEBHOOK_HEADERS = Object.freeze({
  signature: HEADER_SIGNATURE,
  event: HEADER_EVENT,
  id: HEADER_ID,
});

// ── Dead-Letter Queue (#392) ─────────────────────────────────────────────────
// After all retries are exhausted, writes a dead-letter record to disk so an
// operator can inspect and replay failed deliveries.
//
// Environment:
//   WEBHOOK_MAX_RETRIES  – max delivery attempts (default 5)
//   WEBHOOK_DLQ_PATH     – directory for DLQ records  (default ./dlq)

export interface DlqRecord {
  deliveryId: string;
  webhookId: string;
  url: string;
  event: WebhookEvent;
  payload: Record<string, unknown>;
  attempts: DeliveryAttempt[];
  failedAt: number;
}

export interface DlqWriter {
  write(record: DlqRecord): Promise<void>;
}

/** Default DLQ writer: appends one JSON record per line to `<dlqPath>/<deliveryId>.json`. */
export class FileDlqWriter implements DlqWriter {
  constructor(private readonly dlqPath: string = process.env.WEBHOOK_DLQ_PATH ?? "./dlq") {}

  async write(record: DlqRecord): Promise<void> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(this.dlqPath, { recursive: true });
    const file = `${this.dlqPath}/${record.deliveryId}.json`;
    await writeFile(file, JSON.stringify(record, null, 2), "utf8");
  }
}

/**
 * Wraps {@link WebhookDispatcher} and writes dead-letter records on exhausted retries.
 *
 * Reads `WEBHOOK_MAX_RETRIES` (default 5) and `WEBHOOK_DLQ_PATH` (default `./dlq`)
 * from the environment. Both can be overridden via constructor options.
 *
 * Backoff starts at 1 s and doubles each attempt: 1 s, 2 s, 4 s, 8 s, 16 s …
 */
export class WebhookDispatcherWithDLQ {
  private readonly dispatcher: WebhookDispatcher;
  private readonly dlqWriter: DlqWriter;

  constructor(
    options: DeliverOptions & { dlqWriter?: DlqWriter } = {},
  ) {
    const maxAttempts =
      options.maxAttempts ??
      Number(process.env.WEBHOOK_MAX_RETRIES ?? 5);
    // 1 s base with doubling => 1s, 2s, 4s, 8s, 16s  (jitter=0)
    this.dispatcher = new WebhookDispatcher({
      ...options,
      maxAttempts,
      baseDelayMs: options.baseDelayMs ?? 1000,
      maxDelayMs: options.maxDelayMs ?? 32_000,
    });
    this.dlqWriter =
      options.dlqWriter ??
      new FileDlqWriter(process.env.WEBHOOK_DLQ_PATH ?? "./dlq");
  }

  async deliver(
    reg: WebhookRegistration,
    event: WebhookEvent,
    data: Record<string, unknown>,
    deliveryId: string = randomBytes(8).toString("hex"),
  ): Promise<DeliveryResult> {
    const result = await this.dispatcher.deliver(reg, event, data, deliveryId);
    if (!result.ok) {
      const record: DlqRecord = {
        deliveryId,
        webhookId: reg.id,
        url: reg.url,
        event,
        payload: data,
        attempts: result.attempts,
        failedAt: Date.now(),
      };
      await this.dlqWriter.write(record).catch((err) =>
        console.error("[DLQ] failed to write dead-letter record", err),
      );
    }
    return result;
  }
}
