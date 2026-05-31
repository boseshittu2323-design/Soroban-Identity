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

export function signPayload(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

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

export class WebhookDispatcher {
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
